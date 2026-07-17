const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const romanizeModule = require('@dehoist/romanize-thai');
const romanize = typeof romanizeModule === 'function' ? romanizeModule : romanizeModule.default;

// คำนำหน้าของแพทย์/ผู้ป่วยที่ไม่ต้องแปลงเป็นคาราโอเกะ (เก็บไว้เป็นภาษาไทยเสมอ)
const PREFIX_PATTERN = /^(พญ|นพ|นางสาว|นาง|นาย|ดร|ผศ|รศ|ศ|น\.ส)\.?\s*/;

// แปลงข้อความไทยเป็นคาราโอเกะ (ภาษาอังกฤษ) แบบปลอดภัย ถ้าแปลงไม่ได้ให้คืนค่าเดิม ไม่ทำให้ระบบล่ม
function safeRomanize(text) {
  if (!text) return '';
  try {
    return romanize(String(text));
  } catch (err) {
    console.warn('[DICOM Service] ---> แปลงคาราโอเกะไม่สำเร็จ ใช้ข้อความเดิมแทน:', err.message);
    return String(text);
  }
}

// สำหรับชื่อแพทย์ที่มีคำนำหน้าติดอยู่ในสตริงเดียวกัน เช่น "พญ.พิมพ์ชนก คำเพชร"
// -> ตัดคำนำหน้าออกก่อน ไม่ให้ถูกแปลงเป็นคาราโอเกะไปด้วย แล้วต่อกลับด้วยภาษาไทยเหมือนเดิม
function romanizeDoctorName(text) {
  const str = String(text || '');
  const match = str.match(PREFIX_PATTERN);
  if (!match) return safeRomanize(str);

  const prefix = match[0].trim();
  const rest = str.slice(match[0].length);
  const romanizedRest = safeRomanize(rest);
  return romanizedRest ? `${prefix} ${romanizedRest}`.trim() : prefix;
}

// กำหนด Path ของโฟลเดอร์ worklists ภายในโฟลเดอร์ backend
const WORKLIST_DIR = path.join(__dirname, 'worklists');

// ไฟล์เก็บ state (hash ของข้อมูลล่าสุดที่สร้างไฟล์ไปแล้ว ต่อ 1 accession number)
// ใช้เทียบว่าข้อมูลเปลี่ยนไปจากตอนสร้างไฟล์ครั้งล่าสุดหรือไม่ ถ้าไม่เปลี่ยน จะได้ข้ามไป
const STATE_FILE = path.join(WORKLIST_DIR, '.worklist-state.json');

// ตรวจสอบว่ามีโฟลเดอร์ worklists หรือยัง ถ้ายังไม่มีให้สร้างขึ้นมา
if (!fs.existsSync(WORKLIST_DIR)) {
  fs.mkdirSync(WORKLIST_DIR, { recursive: true });
  console.log(`[DICOM Service] ---> สร้างโฟลเดอร์ worklists: ${WORKLIST_DIR}`);
}

// โหลด state เดิมจากไฟล์ (ถ้ามี) เก็บไว้ใน memory ตลอดอายุของโปรเซส
let worklistState = {};
try {
  if (fs.existsSync(STATE_FILE)) {
    worklistState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
} catch (err) {
  console.warn('[DICOM Service] ---> ไม่สามารถอ่าน state file ได้ เริ่มต้นใหม่:', err.message);
  worklistState = {};
}

// บันทึก state ลงไฟล์ (เขียนทับทั้งไฟล์ทุกครั้ง เพราะไฟล์เล็กมาก ไม่กระทบ performance)
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
  // สร้าง Date object จาก string โดยไม่สนใจ Timezone ของ Server
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

// ลบไฟล์ .dump อย่างปลอดภัย ไม่ทำให้โปรเซสล่มแม้ไฟล์จะถูกล็อกอยู่ชั่วขณะ (EBUSY บน Windows)
function safeDeleteDumpFile(filePath, attempt = 1) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code === 'EBUSY' && attempt < 3) {
      // ลองใหม่อีกครั้งหลังหน่วงเวลา
      console.warn(`[DICOM Service] ---> ไฟล์ ${filePath} ถูกล็อกอยู่ (EBUSY) กำลังลองลบใหม่ครั้งที่ ${attempt + 1}...`);
      setTimeout(() => safeDeleteDumpFile(filePath, attempt + 1), 200 * attempt);
    } else if (err.code !== 'ENOENT') {
      // ENOENT (ไฟล์ไม่มีอยู่แล้ว) ไม่ต้องเตือน กรณีอื่นแค่ log ไว้ ไม่ throw ต่อ
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

      // ถ้าเลือกภาษาอังกฤษ ให้แปลงชื่อ-นามสกุลผู้ป่วยเป็นคาราโอเกะ / ชื่อแพทย์ (คงคำนำหน้าไทยไว้)
      const firstName = useEnglish ? safeRomanize(item.fname) : (item.fname || '');
      const lastName = useEnglish ? safeRomanize(item.lname) : (item.lname || '');
      const doctorName = useEnglish ? romanizeDoctorName(item.Doctor) : (item.Doctor || '');

      // แปลงชื่อ-นามสกุลให้อยู่ในรูปแบบ DICOM (Lastname^Firstname)
      const patientName = `${lastName}^${firstName}`;

      const wlFileNameCheck = `${accessionNumber}.wl`;
      const wlFilePathCheck = path.join(WORKLIST_DIR, wlFileNameCheck);

      // เทียบ hash ของข้อมูลกับครั้งล่าสุดที่สร้างไฟล์ ถ้าไม่เปลี่ยนและไฟล์ .wl ยังอยู่ครบ -> ข้าม ไม่ต้องสร้างซ้ำ
      const currentHash = computeItemHash(item);
      const previousHash = worklistState[accessionNumber];
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
(0032,1060) LO [${item.xraylist || ''}] # Requested Procedure Description
(0040,0100) SQ
  (FFFE,E000) na
    (0040,0001) AE [ORTHANC] # Scheduled Station AE Title
    (0040,0002) DA [${studyDate}] # Scheduled Procedure Step Start Date
    (0040,0003) TM [${studyTime}] # Scheduled Procedure Step Start Time
    (0008,0060) CS [${item.Modality || 'CR'}] # Modality
    (0040,0006) PN [${doctorName}] # Scheduled Performing Physician's Name
    (0008,1030) LO [${item.xraylist || ''}]
    (0040,0007) LO [${item.xraylist || ''}]
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

          // บันทึก hash ของข้อมูลชุดนี้ไว้ ครั้งหน้าถ้าข้อมูลไม่เปลี่ยนจะได้ข้ามได้
          worklistState[accessionNumber] = currentHash;
          saveState();

          console.log(`[DICOM Service] ---> สร้าง/อัพเดทไฟล์ Worklist สำเร็จ: ${wlFilePath}`);
          resolve({ success: true, file: wlFilePath });
        } catch (cbErr) {
          // กันสุดท้ายจริงๆ: ไม่ว่าจะเกิดอะไรใน callback นี้ ก็ไม่ปล่อยให้หลุดออกไปทำให้ process ตาย
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
      console.log(`[DICOM Service] ---> ลบไฟล์สำเร็จ (Y,Y): ${xn}.wl`);
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
  deleteWorklistFile
};