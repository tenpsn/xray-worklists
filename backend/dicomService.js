const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// กำหนด Path ของโฟลเดอร์ worklists ภายในโฟลเดอร์ backend
const WORKLIST_DIR = path.join(__dirname, 'worklists');

// ตรวจสอบว่ามีโฟลเดอร์ worklists หรือยัง ถ้ายังไม่มีให้สร้างขึ้นมา
if (!fs.existsSync(WORKLIST_DIR)) {
  fs.mkdirSync(WORKLIST_DIR, { recursive: true });
  console.log(`[DICOM Service] ---> Created worklists directory at: ${WORKLIST_DIR}`);
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

// สร้างไฟล์ Worklist (.dump และ .wl) สำหรับ Orthanc
// @param {Object} item - ข้อมูลผู้ป่วย 1 รายการ (แถวข้อมูลจาก DB)
async function generateWorklistFile(item) {
  return new Promise((resolve, reject) => {
    try {
      const accessionNumber = item.xn || `XN${Date.now()}`;
      const patientId = item.hn || 'UNKNOWN';
      // แปลงชื่อ-นามสกุลให้อยู่ในรูปแบบ DICOM (Lastname^Firstname)
      const patientName = `${item.lname || ''}^${item.fname || ''}`;
      
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
    (0040,0006) PN [${item.Doctor || ''}] # Scheduled Performing Physician's Name
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
        if (error) {
          console.warn(`[DICOM Service] ---> Warning: ไม่สามารถแปลงไฟล์ .wl ได้: ${error.message}`);
          return resolve({ success: true, file: dumpFilePath, message: 'Created .dump only' });
        }
        
        // ลบไฟล์ .dump ทิ้งเมื่อสร้าง .wl สำเร็จ
        fs.unlinkSync(dumpFilePath); 
        
        console.log(`[DICOM Service] ---> สร้างไฟล์ Worklist สำเร็จ: ${wlFilePath}`);
        resolve({ success: true, file: wlFilePath });
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
}

module.exports = {
  generateWorklistFile,
  deleteWorklistFile
};