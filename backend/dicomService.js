const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const romanizeModule = require('@dehoist/romanize-thai');
const romanize = typeof romanizeModule === 'function' ? romanizeModule : romanizeModule.default;

// คำนำหน้าของแพทย์/ผู้ป่วยที่ไม่ต้องแปลงเป็นอังกฤษ
const PREFIX_PATTERN = /^(พญ|นพ|นางสาว|นาง|นาย|ดร|ผศ|รศ|ศ|น\.ส)\.?\s*/;

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

// StudyInstanceUID ต้องคงที่ตลอดอายุของ 1 accession number
// จึงต้องเก็บไว้ใน state แล้วใช้ตัวเดิมซ้ำ ถ้ายังไม่เคยมีให้สุ่มสร้างใหม่ครั้งเดียว
function getOrCreateStudyInstanceUID(accessionNumber) {
  const existingEntry = worklistState[accessionNumber];
  if (existingEntry && typeof existingEntry === 'object' && existingEntry.studyInstanceUID) {
    return existingEntry.studyInstanceUID;
  }
  return generateStudyInstanceUID();
}

// ฟังก์ชันตรวจสอบ hash ของข้อมูลล่าสุดที่สร้างไฟล์ว่าข้อมูลเปลี่ยนไปจากตอนสร้างไฟล์ครั้งล่าสุดหรือไม่ ถ้าไม่เปลี่ยน จะได้ข้ามไป
function getPreviousHash(accessionNumber) {
  const entry = worklistState[accessionNumber];
  if (entry && typeof entry === 'object') return entry.hash;
  return entry;
}
// ค่าเริ่มต้น (ถ้าไม่ได้ตั้งค่าอื่นไว้ผ่านหน้า Settings) — โฟลเดอร์ worklists ในตัว backend เอง
const DEFAULT_WORKLIST_DIR = path.join(__dirname, 'worklists');

// โฟลเดอร์ worklists ปัจจุบัน (เปลี่ยนได้ที่ runtime ผ่าน setWorklistDir เมื่อผู้ใช้ตั้งค่าใหม่จากหน้าเว็บ
// เช่น บางโรงพยาบาลต้องการให้โฟลเดอร์นี้อยู่นอก backend เช่นแชร์ไดรฟ์ร่วมกับเครื่อง Orthanc)
let WORKLIST_DIR = DEFAULT_WORKLIST_DIR;
let STATE_FILE = path.join(WORKLIST_DIR, '.worklist-state.json');

// เก็บ state (hash + StudyInstanceUID ของแต่ละ XN) ไว้ใน memory ตลอดอายุของโปรเซส
let worklistState = {};

// ตรวจสอบว่ามีโฟลเดอร์อยู่หรือยัง ถ้ายังไม่มีให้สร้างขึ้นมา (โยน error ออกไปถ้าสร้างไม่ได้ เช่น path ผิด/ไม่มีสิทธิ์)
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
    console.warn('[DICOM Service] ---> ไม่สามารถอ่าน state file ได้ เริ่มต้นใหม่:', err.message);
    worklistState = {};
  }
}

// เตรียมโฟลเดอร์ default ไว้ตั้งแต่ตอนโหลดโมดูล (เผื่อยังไม่มีการเรียก setWorklistDir เลย)
ensureDirExists(WORKLIST_DIR);
loadStateFromDisk();

// เปลี่ยนโฟลเดอร์เก็บไฟล์ worklist ตามค่าที่ตั้งไว้จากหน้า Settings
// - ถ้า dirPath ว่างเปล่า/ไม่ได้ระบุ -> กลับไปใช้ค่า default (backend/worklists)
// - ถ้าระบุ path มา -> ใช้ path นั้น (รองรับทั้ง path แบบสัมพัทธ์และแบบเต็ม, backslash/forward slash)
// - โยน error ออกไปถ้าสร้าง/เข้าถึงโฟลเดอร์นั้นไม่ได้ ให้ผู้เรียก (server.js) เป็นคนจัดการแจ้งเตือนผู้ใช้
function setWorklistDir(dirPath) {
  const trimmed = (dirPath || '').trim();
  const resolved = trimmed !== '' ? path.resolve(trimmed) : DEFAULT_WORKLIST_DIR;

  if (resolved === WORKLIST_DIR) {
    return WORKLIST_DIR; // ไม่มีอะไรเปลี่ยน ไม่ต้องทำอะไรต่อ
  }

  ensureDirExists(resolved); // ถ้า path ผิด/ไม่มีสิทธิ์เขียน จะโยน error ออกไปตรงนี้

  WORKLIST_DIR = resolved;
  STATE_FILE = path.join(WORKLIST_DIR, '.worklist-state.json');
  loadStateFromDisk();
  console.log(`[DICOM Service] ---> ใช้งานโฟลเดอร์ worklists ที่: ${WORKLIST_DIR}`);
  return WORKLIST_DIR;
}

function getWorklistDir() {
  return WORKLIST_DIR;
}

// บันทึก state ลงไฟล์
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(worklistState), 'utf8');
  } catch (err) {
    console.warn('[DICOM Service] ---> ไม่สามารถบันทึก state file ได้:', err.message);
  }
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
    lang: item.lang === 'en' ? 'en' : 'th',
  };
  return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}

// แปลงวันที่จาก DB ให้เป็น Format DICOM (YYYYMMDD)
function formatDicomDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
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

// สร้างไฟล์ Worklist (.dump และ .wl) สำหรับ Orthanc
// @param {Object} item - ข้อมูลผู้ป่วย 1 รายการ (แถวข้อมูลจาก DB)
async function generateWorklistFile(item) {
  return new Promise((resolve, reject) => {
    try {
      const accessionNumber = item.xn || `XN${Date.now()}`;
      const patientId = item.hn || 'UNKNOWN';
      const useEnglish = item.lang === 'en';

      // ถ้าเลือกภาษาอังกฤษ ให้แปลงชื่อ-นามสกุลผู้ป่วยเป็นอังกฤษ / ชื่อแพทย์ คงคำนำหน้าไทยไว้
      const firstName = useEnglish ? safeRomanize(item.fname) : (item.fname || '');
      const lastName = useEnglish ? safeRomanize(item.lname) : (item.lname || '');
      const doctorName = useEnglish ? romanizeDoctorName(item.Doctor) : (item.Doctor || '');

      // แปลงชื่อ-นามสกุลให้อยู่ในรูปแบบ DICOM (Lastname^Firstname)
      const patientName = `${lastName}^${firstName}`;

      // รหัสรายการ (xray_items_code) ใช้ทั้งใน RequestedProcedureID และ ScheduledProtocolCodeSequence>CodeValue
      const procedureCode = item.xray_items_code || '';

      // StudyInstanceUID ต้องคงที่ตลอดอายุของรายการนี้ (ไม่สุ่มใหม่ทุกครั้งที่อัพเดทไฟล์)
      const studyInstanceUID = getOrCreateStudyInstanceUID(accessionNumber);

      const wlFileNameCheck = `${accessionNumber}.wl`;
      const wlFilePathCheck = path.join(WORKLIST_DIR, wlFileNameCheck);

      // เทียบ hash ของข้อมูลกับครั้งล่าสุดที่สร้างไฟล์ ถ้าไม่เปลี่ยนและไฟล์ .wl ยังอยู่ครบ -> ข้าม ไม่ต้องสร้างซ้ำ
      const currentHash = computeItemHash(item);
      const previousHash = getPreviousHash(accessionNumber);
      if (previousHash === currentHash && fs.existsSync(wlFilePathCheck)) {
        console.log(`[DICOM Service] ---> ข้ามไฟล์ (ไม่มีการเปลี่ยนแปลง): ${wlFilePathCheck}`);
        return resolve({ success: true, file: wlFilePathCheck, skipped: true });
      }

      const studyDate = formatDicomDate(item.StudyDate);
      const studyTime = formatDicomTime(item.StudyTime);
      const dob = formatDicomDate(item.birthday);
      const sex = item.sex === '1' ? 'M' : item.sex === '2' ? 'F' : 'O';
      
      // ตัวอย่างข้อมูล DICOM Tags พื้นฐานสำหรับ Modality Worklist (รูปแบบไฟล์ .dump)
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

      const dumpFileName = `${accessionNumber}.dump`;
      const wlFileName = `${accessionNumber}.wl`;
      
      const dumpFilePath = path.join(WORKLIST_DIR, dumpFileName);
      const wlFilePath = path.join(WORKLIST_DIR, wlFileName);

      // 1. เขียนไฟล์ .dump
      fs.writeFileSync(dumpFilePath, dumpContent, 'utf8');

      // 2. ใช้คำสั่ง dump2dcm เพื่อแปลง .dump เป็น .wl
      const dcmtkPath = path.join(__dirname, 'dcmtk', 'bin', 'dump2dcm.exe');
      const command = `"${dcmtkPath}" "${dumpFilePath}" "${wlFilePath}"`;
      
      exec(command, (error, stdout, stderr) => {
        try {
          if (error) {
            console.warn(`[DICOM Service] ---> Warning: ไม่สามารถแปลงไฟล์ .wl ได้: ${error.message}`);
            // แปลงไม่สำเร็จ ไม่ถือว่าอัพเดทสมบูรณ์ -> ไม่บันทึก hash ไว้ เพื่อให้รอบถัดไปลองใหม่อีกครั้ง
            return resolve({ success: true, file: dumpFilePath, message: 'Created .dump only' });
          }

          // ลบไฟล์ .dump ทิ้งเมื่อสร้าง .wl สำเร็จ
          safeDeleteDumpFile(dumpFilePath);

          // บันทึก hash + StudyInstanceUID ของข้อมูลชุดนี้ไว้ ครั้งหน้าถ้าข้อมูลไม่เปลี่ยนจะได้ข้ามได้
          // และใช้ StudyInstanceUID เดิมซ้ำ ไม่สุ่มใหม่ทุกครั้ง
          worklistState[accessionNumber] = { hash: currentHash, studyInstanceUID };
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
  const wlFilePath = path.join(WORKLIST_DIR, `${xn}.wl`);
  if (fs.existsSync(wlFilePath)) {
    try {
      fs.unlinkSync(wlFilePath);
      console.log(`[DICOM Service] ---> ลบไฟล์สำเร็จ: ${xn}.wl`);
    } catch (err) {
      console.error(`[DICOM Service] ---> ลบไฟล์ไม่สำเร็จ: ${xn}.wl`, err);
    }
  }
  // ล้าง state ทิ้งด้วย เผื่อ XN นี้กลับมาใหม่ในอนาคต
  if (worklistState[xn] !== undefined) {
    delete worklistState[xn];
    saveState();
  }
}

module.exports = {
  generateWorklistFile,
  deleteWorklistFile,
  setWorklistDir,
  getWorklistDir
};