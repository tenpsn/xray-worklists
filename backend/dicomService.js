const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const romanizeModule = require('@dehoist/romanize-thai');
const romanize = typeof romanizeModule === 'function' ? romanizeModule : romanizeModule.default;

// คำนำหน้าของแพทย์/ผู้ป่วยที่ไม่ต้องแปลงเป็นอังกฤษ
const PREFIX_PATTERN = /^(ว่าที่\s*)?(พญ|นพ|ทพ|ทพญ|นางสาว|นาง|นาย|ดร|ผศ|รศ|ศ|น\.ส|(?:[ก-ฮ]+\.\s*)+(?:หญิง)?)\.?\s*/;

// แปลงข้อความไทยเป็นอังกฤษถ้าแปลงไม่ได้ให้คืนค่าเดิม
function safeRomanize(text) {
  if (!text) return '';
  try {
    return romanize(String(text));
  } catch (err) {
    console.warn('[DICOM Service] ---> แปลงอังกฤษไม่สำเร็จ ใช้ข้อความเดิมแทน:', err.message);
    return String(text);
  }
}

function sanitizeFileName(accessionNumber) {
  return String(accessionNumber).replace(/[\\/:_]/g, '-');
}

// สำหรับชื่อแพทย์ที่มีคำนำหน้าติดอยู่ในสตริงเดียวกัน เช่น พญ.พิมพ์ชนก
// -> ตัดคำนำหน้าออกก่อน ไม่ให้ถูกแปลงเป็นอังกฤษไปด้วย แล้วต่อกลับด้วยภาษาไทยเหมือนเดิม
function romanizeDoctorName(text) {
  const str = String(text || '');
  const match = str.match(PREFIX_PATTERN);
  if (!match) return safeRomanize(str);

  const prefix = match[0].trim();
  const rest = str.slice(match[0].length);
  const romanizedRest = safeRomanize(rest);
  return romanizedRest ? `${prefix} ${romanizedRest}`.trim() : prefix;
}

// สร้าง StudyInstanceUID ที่ปลอดภัยและถูกต้องตามมาตรฐาน DICOM
function generateStudyInstanceUID() {
  const uuid = crypto.randomUUID(); // เช่น '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
  const hex = uuid.replace(/-/g, ''); // 32 ตัวอักษร hex = 128 บิต
  const decimal = BigInt('0x' + hex).toString(10);
  return `2.25.${decimal}`;
}

// ค่าเริ่มต้น ถ้าไม่ได้ตั้งค่าโฟลเดอร์ worklists จะอยู่ใน backend
const DEFAULT_WORKLIST_DIR = path.join(__dirname, 'worklists');

// เปลี่ยน worklists ได้จากหน้าเว็บ
let WORKLIST_DIR = DEFAULT_WORKLIST_DIR;
let STATE_FILE = path.join(WORKLIST_DIR, '.worklist-state.json');

let worklistState = {};

// อายุไฟล์ .wl 
const WORKLIST_RETENTION_DAYS = 2;

// เก็บวันที่ (YYYY-MM-DD) ของครั้งล่าสุดที่รัน cleanup
let lastWorklistCleanupDateKey = null;

// StudyInstanceUID ต้องคงที่ตลอดอายุของ 1 accession number
// จึงต้องเก็บไว้ใน state แล้วใช้ตัวเดิมซ้ำ ถ้ายังไม่เคยมีให้สุ่มสร้างใหม่ครั้งเดียว
function getOrCreateStudyInstanceUID(accessionNumber) {
  const existingEntry = worklistState[accessionNumber];
  if (existingEntry && typeof existingEntry === 'object' && existingEntry.studyInstanceUID) {
    return existingEntry.studyInstanceUID;
  }
  return generateStudyInstanceUID();
}

// ฟังก์ชันตรวจสอบ hash ของข้อมูลล่าสุดที่สร้างไฟล์ว่าข้อมูลเปลี่ยนไปจากตอนสร้างไฟล์ครั้งล่าสุดหรือไม่ ถ้าไม่เปลี่ยนจะข้าม
function getPreviousHash(accessionNumber) {
  const entry = worklistState[accessionNumber];
  if (entry && typeof entry === 'object') return entry.hash;
  return entry;
}

function ensureDirExists(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[DICOM Service] ---> สร้างโฟลเดอร์ worklists: ${dir}`);
  }
}

// โหลด state จากไฟล์ .worklist-state.json ของโฟลเดอร์ปัจจุบัน (ถ้ามี)
function loadStateFromDisk() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      worklistState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } else {
      worklistState = {};
    }
  } catch (err) {
    console.warn('[DICOM Service] ---> ไม่สามารถอ่าน state file ได้:', err.message);
    worklistState = {};
  }
}

// บันทึก state ลงไฟล์
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(worklistState), 'utf8');
  } catch (err) {
    console.warn('[DICOM Service] ---> ไม่สามารถบันทึก state file ได้:', err.message);
  }
}

// เปลี่ยนโฟลเดอร์เก็บไฟล์ worklist ตามค่าที่ตั้งไว้จากหน้า Settings
// - ถ้าไม่ได้ระบุกลับไปใช้ค่า default backend/worklists
// - ถ้าระบุมาใช้ path นั้น รองรับทั้ง path แบบสัมพัทธ์และแบบเต็ม backslash/forward slash
// - โยน error ออกไปถ้าสร้าง/เข้าถึงโฟลเดอร์นั้นไม่ได้ ให้ผู้เรียก server.js เป็นคนจัดการแจ้งเตือนผู้ใช้
function setWorklistDir(dirPath) {
  const trimmed = (dirPath || '').trim();
  const resolved = trimmed !== '' ? path.resolve(trimmed) : DEFAULT_WORKLIST_DIR;

  if (resolved === WORKLIST_DIR) {
    return WORKLIST_DIR;
  }

  ensureDirExists(resolved); // ถ้า path ผิด/ไม่มีสิทธิ์เขียน จะโยน error ออกไป

  WORKLIST_DIR = resolved;
  STATE_FILE = path.join(WORKLIST_DIR, '.worklist-state.json');
  loadStateFromDisk();
  console.log(`[DICOM Service] ---> ใช้งานโฟลเดอร์ worklists ที่: ${WORKLIST_DIR}`);
  return WORKLIST_DIR;
}

function getWorklistDir() {
  return WORKLIST_DIR;
}

// สร้าง hash จากข้อมูลที่มีผลต่อเนื้อหาไฟล์ worklist เพื่อใช้เทียบว่าข้อมูลเปลี่ยนไปหรือยัง
function computeItemHash(item) {
  const relevant = {
    hn: item.hn,
    fname: item.fname,
    lname: item.lname,
    birthday: item.birthday,
    sex: item.sex,
    StudyDate: item.StudyDate,
    StudyTime: item.StudyTime,
    Modality: item.Modality,
    Doctor: item.Doctor,
    xraylist: item.xraylist,
    xray_items_code: item.xray_items_code,
    lang: item.lang === 'en' ? 'en' : 'th',
  };
  return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}

// แปลงวันที่เป็น DICOM YYYYMMDD รับได้ทั้ง Date/ISO string จาก DB และสตริงดิบจาก HL7 (PID-7)
// new Date() พังกับสตริงไม่มีตัวคั่นแบบ '19900101' เลยดึงตัวเลขตรงๆ ก่อน
function formatDicomDate(dateStr) {
  if (!dateStr) return '';

  if (typeof dateStr === 'string') {
    const digits = dateStr.replace(/[^0-9]/g, '');
    if (digits.length >= 8) return digits.substring(0, 8);
  }

  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = ('0' + (d.getMonth() + 1)).slice(-2);
  const day = ('0' + d.getDate()).slice(-2);

  return `${year}${month}${day}`;
}

// แปลงเวลาจาก DB ให้เป็น Format DICOM (HHMMSS)
function formatDicomTime(timeStr) {
  if (!timeStr) return '';
  return timeStr.replace(/:/g, '').substring(0, 6);
}

// ลบไฟล์ .dump
function safeDeleteDumpFile(filePath, attempt = 1) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code === 'EBUSY' && attempt < 3) {
      // ลองใหม่อีกครั้งหลังหน่วงเวลา
      console.warn(`[DICOM Service] ---> ไฟล์ ${filePath} ถูกล็อกอยู่ (EBUSY) กำลังลองลบใหม่ครั้งที่ ${attempt + 1}...`);
      setTimeout(() => safeDeleteDumpFile(filePath, attempt + 1), 200 * attempt);
    } else if (err.code !== 'ENOENT') {
      console.warn(`[DICOM Service] ---> ไม่สามารถลบไฟล์ .dump ได้ (${err.code}): ${filePath}`);
    }
  }
}

// ลบไฟล์ .wl
function cleanupStaleWorklists() {
  try {
    const files = fs.readdirSync(WORKLIST_DIR).filter((f) => f.endsWith('.wl'));
    const now = Date.now();
    const maxAgeMs = WORKLIST_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let deletedCount = 0;

    const fileNameToXn = {};
    Object.keys(worklistState).forEach((xn) => {
      fileNameToXn[`${sanitizeFileName(xn)}.wl`] = xn;
    });

    let changed = false;
    files.forEach((file) => {
      const filePath = path.join(WORKLIST_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > maxAgeMs) {
          if (deletedCount === 0) {
            console.log(`[DICOM Service] ---> [Cleanup] เริ่มดำเนินการลบไฟล์ worklist เกิน ${WORKLIST_RETENTION_DAYS} วัน`);
          }
          fs.unlinkSync(filePath);
          console.log(`[DICOM Service] ---> ลบไฟล์ worklist อายุเกิน ${WORKLIST_RETENTION_DAYS} วัน: ${file}`);

          const xn = fileNameToXn[file];
          if (xn && worklistState[xn] !== undefined) {
            delete worklistState[xn];
            changed = true;
          }
          deletedCount += 1;
        }
      } catch (err) {
        console.warn(`[DICOM Service] ---> ตรวจสอบ/ลบไฟล์ ${file} ไม่สำเร็จ :`, err.message);
      }
    });

    if (changed) saveState();
    if (deletedCount > 0) {
      console.log(`[DICOM Service] ---> [Cleanup] ดำเนินการเสร็จสิ้น พบไฟล์ทั้งหมด ${files.length} ไฟล์ ลบไป ${deletedCount} ไฟล์`);
    }
  } catch (err) {
    console.warn('[DICOM Service] ---> รัน cleanup ไฟล์ worklist ค้างไม่สำเร็จ:', err.message);
  }
}

function ensureWorklistCleanupForToday() {
  const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (lastWorklistCleanupDateKey === todayKey) return;

  lastWorklistCleanupDateKey = todayKey;
  cleanupStaleWorklists();
}

// สร้างไฟล์ Worklist (.dump และ .wl) สำหรับ Orthanc
async function generateWorklistFile(item) {
  ensureWorklistCleanupForToday(); // เช็คว่าเปลี่ยนวันปฏิทินหรือยัง ถ้าเปลี่ยนแล้วรัน cleanup ไฟล์ .wl ค้างไปด้วย
  return new Promise((resolve, reject) => {
    try {
      const rawXn = item.xn || `XN${Date.now()}`;
      const accessionNumber = sanitizeFileName(rawXn);
      const safeFileName = accessionNumber;

      const rawPatientId = item.hn || 'UNKNOWN';
      const patientId = sanitizeFileName(rawPatientId);
      const useEnglish = item.lang === 'en';

      // ถ้าเลือกภาษาอังกฤษ ให้แปลงชื่อ-นามสกุลผู้ป่วยเป็นอังกฤษ / ชื่อแพทย์ คงคำนำหน้าไทยไว้
      const firstName = useEnglish ? safeRomanize(item.fname) : (item.fname || '');
      const lastName = useEnglish ? safeRomanize(item.lname) : (item.lname || '');
      const doctorName = useEnglish ? romanizeDoctorName(item.Doctor) : (item.Doctor || '');

      // แปลงชื่อ-นามสกุลให้อยู่ในรูปแบบ DICOM (Lastname^Firstname)
      const patientName = `${lastName}^${firstName}`;

      // รหัสรายการ (xray_items_code) ใช้ทั้งใน RequestedProcedureID และ ScheduledProtocolCodeSequence>CodeValue
      const procedureCode = item.xray_items_code || '';

      // StudyInstanceUID ต้องคงที่ตลอดอายุของรายการนี้ ไม่สุ่มใหม่ทุกครั้งที่อัพเดทไฟล์
      // เก็บลง state ทันที ไม่รอผล dump2dcm เผื่อรอบนี้ล้มเหลว รอบหน้าจะได้ใช้ตัวเดิมซ้ำ
      const studyInstanceUID = getOrCreateStudyInstanceUID(accessionNumber);
      if (!worklistState[accessionNumber] || worklistState[accessionNumber].studyInstanceUID !== studyInstanceUID) {
        worklistState[accessionNumber] = { ...(worklistState[accessionNumber] || {}), studyInstanceUID };
        saveState();
      }

      // ใช้ safeFileName เพื่อระบุชื่อไฟล์ในการตรวจสอบและสร้างไฟล์
      const wlFileNameCheck = `${safeFileName}.wl`;
      const wlFilePathCheck = path.join(WORKLIST_DIR, wlFileNameCheck);

      // เทียบ hash ของข้อมูลกับครั้งล่าสุดที่สร้างไฟล์ ถ้าไม่เปลี่ยนและไฟล์ .wl ยังอยู่ครบไม่ต้องสร้างซ้ำ
      const currentHash = computeItemHash(item);
      const previousHash = getPreviousHash(accessionNumber);
      if (previousHash === currentHash && fs.existsSync(wlFilePathCheck)) {
        // console.log(`[DICOM Service] ---> ข้ามไฟล์ เพราะไม่มีการเปลี่ยนแปลง: ${wlFilePathCheck}`);
        return resolve({ success: true, file: wlFilePathCheck, skipped: true });
      }

      const studyDate = formatDicomDate(item.StudyDate);
      const studyTime = formatDicomTime(item.StudyTime);
      const dob = formatDicomDate(item.birthday);
      const sex = item.sex === '1' ? 'M' : item.sex === '2' ? 'F' : 'O';

      // ตัวอย่างข้อมูล รูปแบบไฟล์ .dump
      const dumpContent = `
(0008,0005) CS [ISO_IR 192] # Specific Character Set (บอกว่าเป็น UTF-8)
(0008,0050) SH [${accessionNumber}] # Accession Number
(0010,0010) PN [${patientName}] # Patient Name
(0010,0020) LO [${patientId}] # Patient ID
(0010,0030) DA [${dob}] # Patient Birth Date
(0010,0040) CS [${sex}] # Patient Sex
(0020,000D) UI [${studyInstanceUID}] # Study Instance UID
(0032,1060) LO [${item.xraylist || ''}] # Requested Procedure Description
(0040,1001) SH [${procedureCode}] # Requested Procedure ID
(0040,0100) SQ
  (FFFE,E000) na
    (0040,0001) AE [ORTHANC] # Scheduled Station AE Title
    (0040,0002) DA [${studyDate}] # Scheduled Procedure Step Start Date
    (0040,0003) TM [${studyTime}] # Scheduled Procedure Step Start Time
    (0008,0060) CS [${item.Modality || 'CR'}] # Modality
    (0040,0006) PN [${doctorName}] # Scheduled Performing Physician's Name
    (0008,1030) LO [${item.xraylist || ''}]
    (0040,0007) LO [${item.xraylist || ''}]
    (0040,0008) SQ
      (FFFE,E000) na
        (0008,0100) SH [${procedureCode}] # Scheduled Protocol Code Value
      (FFFE,E00D) na
    (FFFE,E0DD) na
  (FFFE,E00D) na
(FFFE,E0DD) na
      `.trim();

      // ใช้ safeFileName ในการสร้างไฟล์
      const dumpFileName = `${safeFileName}.dump`;
      const wlFileName = `${safeFileName}.wl`;

      const dumpFilePath = path.join(WORKLIST_DIR, dumpFileName);
      const wlFilePath = path.join(WORKLIST_DIR, wlFileName);

      // 1. เขียนไฟล์ .dump
      fs.writeFileSync(dumpFilePath, dumpContent, 'utf8');

      // 2. ใช้คำสั่ง dump2dcm เพื่อแปลง .dump เป็น .wl
      // Windows: ใช้ dump2dcm.exe ที่แถมมากับโปรเจกต์ / Linux (Docker): ใช้ dcmtk ที่ลงผ่าน apt แทน
      const dcmtkPath = process.platform === 'win32'
        ? path.join(__dirname, 'dcmtk', 'bin', 'dump2dcm.exe')
        : 'dump2dcm';
      execFile(dcmtkPath, [dumpFilePath, wlFilePath], (error, stdout, stderr) => {
        try {
          if (error) {
            console.error(`[DICOM Service] ---> ไม่สามารถแปลงไฟล์ .wl ได้ (ยังไม่มีไฟล์ worklist ให้เครื่อง Modality): ${error.message}`);
            // ต้อง reject ให้ผู้เรียกรู้ว่ายังไม่เสร็จจริง ไม่งั้นจะถูกนับว่าสำเร็จทั้งที่ไม่มีไฟล์ .wl
            return reject(new Error(`แปลงไฟล์ .wl ไม่สำเร็จ: ${error.message}`));
          }

          // ลบไฟล์ .dump ทิ้งเมื่อสร้าง .wl สำเร็จ
          safeDeleteDumpFile(dumpFilePath);

          // บันทึก hash ไว้เทียบรอบหน้า (StudyInstanceUID เก็บไปแล้วตั้งแต่ก่อนเรียก dump2dcm ด้านบน)
          worklistState[accessionNumber] = { ...worklistState[accessionNumber], hash: currentHash, studyInstanceUID };
          saveState();

          console.log(`[DICOM Service] ---> สร้าง/อัพเดทไฟล์ Worklist สำเร็จ: ${wlFilePath}`);
          resolve({ success: true, file: wlFilePath });
        } catch (cbErr) {
          console.error('[DICOM Service] ---> Error inside exec callback:', cbErr);
          resolve({ success: true, file: dumpFilePath, message: 'Completed with warning' });
        }
      });

    } catch (err) {
      console.error('[DICOM Service] ---> Error generating worklist:', err);
      reject(err);
    }
  });
}

// ฟังก์ชันลบไฟล์ .wl
function deleteWorklistFile(xn) {
  const safeFileName = sanitizeFileName(xn);
  const wlFilePath = path.join(WORKLIST_DIR, `${safeFileName}.wl`);
  if (fs.existsSync(wlFilePath)) {
    try {
      fs.unlinkSync(wlFilePath);
      console.log(`[DICOM Service] ---> ลบไฟล์สำเร็จ: ${safeFileName}.wl`);
    } catch (err) {
      console.error(`[DICOM Service] ---> ลบไฟล์ไม่สำเร็จ: ${safeFileName}.wl`, err);
    }
  }

  // ล้าง state ทิ้งด้วย โดยลบทั้งรูปแบบที่มี / และ - เพื่อความชัวร์
  let stateChanged = false;
  if (worklistState[xn] !== undefined) {
    delete worklistState[xn];
    stateChanged = true;
  }
  if (worklistState[safeFileName] !== undefined) {
    delete worklistState[safeFileName];
    stateChanged = true;
  }

  if (stateChanged) {
    saveState();
  }
}

// เตรียมโฟลเดอร์ default ไว้ตั้งแต่ตอนโหลดโมดูล เผื่อยังไม่มีการเรียก setWorklistDir
ensureDirExists(WORKLIST_DIR);
loadStateFromDisk();
ensureWorklistCleanupForToday();

module.exports = {
  generateWorklistFile,
  deleteWorklistFile,
  cleanupStaleWorklists,
  setWorklistDir,
  getWorklistDir,
  sanitizeFileName
};