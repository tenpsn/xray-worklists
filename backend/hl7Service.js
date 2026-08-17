const net = require('net');
const dicomService = require('./dicomService');
const xrayQueueDb = require('./xrayQueueDb');

let getDisplayLang = () => 'en';

// ตัวอักษรพิเศษสำหรับ MLLP Protocol (มาตรฐานการส่ง hl7 ผ่าน TCP)
const VT = String.fromCharCode(0x0b); // Start block
const FS = String.fromCharCode(0x1c); // End block
const CR = String.fromCharCode(0x0d); // Carriage return

// ฟังก์ชันสร้างข้อความตอบกลับ (ACK)
function generateACK(mshSegment, ackCode = 'AA', message = 'Message accepted') {
  const msh = mshSegment.split('|');
  const sendingApp = msh[2] || '';
  const sendingFac = msh[3] || '';
  const recvApp = msh[4] || '';
  const recvFac = msh[5] || '';
  const msgControlID = msh[9] || '';
  const datetime = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  // สลับผู้ส่ง-ผู้รับ และสร้าง MSA segment
  const ackMSH = `MSH|^~\\&|${recvApp}|${recvFac}|${sendingApp}|${sendingFac}|${datetime}||ACK|${msgControlID}|P|2.3`;
  const ackMSA = `MSA|${ackCode}|${msgControlID}|${message}`;
  
  return `${VT}${ackMSH}\r${ackMSA}\r${FS}${CR}`;
}

// แปลงวันเวลาแบบ hl7 (TS) เช่น 20260723120000 หรือ 20260723 ให้เป็น Date object
// คืนค่า null ถ้าแปลงไม่ได้/ไม่มีข้อมูล เพื่อให้ผู้เรียกไป fallback เป็นเวลาปัจจุบันแทน
function parsehl7DateTime(ts) {
  const digits = String(ts || '').replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;

  const year = digits.substring(0, 4);
  const month = digits.substring(4, 6);
  const day = digits.substring(6, 8);
  const hour = digits.substring(8, 10) || '00';
  const min = digits.substring(10, 12) || '00';
  const sec = digits.substring(12, 14) || '00';

  const d = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`);
  return isNaN(d.getTime()) ? null : d;
}

// ฟังก์ชันแกะข้อความ hl7 เป็น Object สำหรับสร้าง Worklist
function parsehl7ToWorklistItem(hl7Data) {
  const segments = hl7Data.split('\r');
  let msh = [], pid = [], obr = [], orc = [];

  segments.forEach(segment => {
    if (segment.startsWith('MSH')) msh = segment.split('|');
    if (segment.startsWith('PID')) pid = segment.split('|');
    if (segment.startsWith('ORC')) orc = segment.split('|');
    if (segment.startsWith('OBR')) obr = segment.split('|');
  });

  if (!pid.length || (!obr.length && !orc.length)) {
    throw new Error('ข้อความ hl7 ไม่สมบูรณ์ (ขาด PID, ORC หรือ OBR)');
  }

  // ใช้ mwl.lang ที่ตั้งไว้ในหน้า Settings เป็นค่าเริ่มต้นของภาษาแสดงผล
  // (โหมด hl7 ไม่มี request จากหน้าเว็บมากำหนด lang ต่อครั้งเหมือนโหมดดึงจาก DB ปกติ)
  const displayLang = getDisplayLang() === 'en' ? 'en' : 'th';

  // แกะข้อมูลคนไข้ (PID)
  const patientId = (pid[3] || '').split('^')[0]; // HN
  const patientNameParts = (pid[5] || '').split('^'); // นามสกุล^ชื่อ
  const lname = patientNameParts[0] || '';
  const fname = patientNameParts[1] || '';
  const dob = pid[7] || ''; // YYYYMMDD
  const hl7Sex = pid[8] || 'O'; 
  const sex = hl7Sex === 'M' ? '1' : hl7Sex === 'F' ? '2' : 'O';

  // แกะข้อมูลรายการออเดอร์ (OBR / ORC)
  const accessionNumber = (obr[3] || orc[2] || '').split('^')[0] || `XN${Date.now()}`;
  const procedureInfo = (obr[4] || '').split('^'); 
  const procedureCode = procedureInfo[0] || ''; // รหัส X-ray
  const procedureDesc = procedureInfo[1] || procedureCode; // ชื่อ X-ray
  const doctorName = (obr[16] || orc[12] || '').replace(/\^/g, ' ').trim();
  const modality = (obr[24] || 'CR');

  // ดึงวันเวลาที่สั่งตรวจจริงจาก OBR-7 (Observation Date/Time) หรือ OBR-6 (Requested Date/Time)
  // ถ้าไม่มี/แปลงไม่ได้ ค่อย fallback เป็นเวลาปัจจุบัน ณ ตอนรับข้อความ
  const requestedDateTime = parsehl7DateTime(obr[7]) || parsehl7DateTime(obr[6]) || new Date();

  // จัดโครงสร้างให้ตรงกับที่ dicomService ต้องการ
  return {
    xn: accessionNumber,
    hn: patientId,
    fname: fname,
    lname: lname,
    birthday: dob,
    sex: sex,
    StudyDate: requestedDateTime,
    StudyTime: requestedDateTime.toTimeString().split(' ')[0],
    Modality: modality,
    Doctor: doctorName,
    xraylist: procedureDesc,
    xray_items_code: procedureCode,
    lang: displayLang
  };
}

let server = null;
let workerTimer = null;

// ดึงงานค้าง (receive = 'N') จากคิว มาสร้างไฟล์ worklist ทีละรายการ
async function processPendingRequests() {
  const pending = xrayQueueDb.getPendingRequests();
  for (const row of pending) {
    try {
      const worklistItem = parsehl7ToWorklistItem(row.xray_request_data);
      await dicomService.generateWorklistFile(worklistItem);
      xrayQueueDb.markReceived(row.xray_request_id);
      console.log(`[HL7 Service] ---> สร้างไฟล์ Worklist จากคิวสำเร็จ XN: ${worklistItem.xn}`);
    } catch (error) {
      // ปล่อย receive ไว้เป็น 'N' รอ worker รอบถัดไปมาลองใหม่
      console.error(`[HL7 Service] ---> ประมวลผลคิว id ${row.xray_request_id} ไม่สำเร็จ:`, error.message);
    }
  }
}

function startWorklistWorker(intervalMs = 2000) {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    processPendingRequests().catch((err) => console.error('[HL7 Service] ---> Worker Error:', err.message));
  }, intervalMs);
}

function stopWorklistWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

function starthl7Server(port = 2575, getLang) {
  if (server) {
    server.close();
  }

  if (typeof getLang === 'function') {
    getDisplayLang = getLang;
  }

  // รับข้อความ hl7 1 ก้อน (ไม่รวม VT/FS/CR ที่ครอบอยู่) แล้วตอบ ACK/NAK กลับไปที่ socket
  // ตัวจริง (สร้างไฟล์ worklist) แยกไปทำใน worker เพื่อให้ตอบ HIS ได้เร็ว ไม่ต้องรอ dcmtk
  async function handlehl7Message(hl7Message, socket) {
    const mshSegment = hl7Message.split('\r')[0];
    const msgType = (mshSegment.split('|')[8] || '');
    try {
      // 1. ตรวจโครงสร้างข้อความก่อน (ต้องมี PID + ORC/OBR) เพื่อ reject ข้อความที่ parse ไม่ได้ตั้งแต่ตรงนี้
      const worklistItem = parsehl7ToWorklistItem(hl7Message);

      // 2. บันทึกข้อความดิบลงคิว (xray_request, receive='N') รอ worker มาสร้างไฟล์ worklist ต่อ
      xrayQueueDb.insertRequest(worklistItem.xn, msgType, hl7Message);
      console.log(`[HL7 Service] ---> รับ Order เข้าคิวสำเร็จ XN: ${worklistItem.xn}`);

      // 3. ตอบกลับ HIS ว่ารับสำเร็จ (ACK)
      const ackMsg = generateACK(mshSegment, 'AA', 'Success');
      socket.write(ackMsg);

    } catch (error) {
      console.error('[HL7 Service] ---> Error Processing HL7:', error.message);
      // ตอบกลับ HIS ว่าเกิดข้อผิดพลาด (AE = Application Error)
      const nakMsg = generateACK(mshSegment, 'AE', error.message);
      socket.write(nakMsg);
    }
  }

  server = net.createServer((socket) => {
    let buffer = '';
    let processing = Promise.resolve(); // ต่อคิวประมวลผลทีละข้อความ

    socket.on('data', (data) => {
      buffer += data.toString();

      let fsIndex;
      while ((fsIndex = buffer.indexOf(FS + CR)) !== -1) {
        const vtIndex = buffer.indexOf(VT);

        if (vtIndex === -1 || vtIndex > fsIndex) {
          buffer = buffer.substring(fsIndex + 2);
          continue;
        }

        const hl7Message = buffer.substring(vtIndex + 1, fsIndex);
        buffer = buffer.substring(fsIndex + 2);

        // ต่อคิวประมวลผลทีละข้อความตามลำดับที่รับเข้ามา
        processing = processing.then(() => handlehl7Message(hl7Message, socket));
      }
    });

    socket.on('error', (err) => console.error('[HL7 Service] Socket Error:', err.message));
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[HL7 Service] ---> พอร์ต ${port} ถูกใช้งานอยู่แล้ว`);
    } else {
      console.error('[HL7 Service] ---> Server Error:', err.message);
    }
  });

  server.listen(port, () => {
    console.log(`[HL7 Service] ---> เริ่ม MLLP Listener รอรับข้อมูล HL7 ที่พอร์ต ---> ${port}`);
  });

  startWorklistWorker();
}

function stophl7Server() {
  stopWorklistWorker();
  if (server) {
    server.close();
    console.log('[HL7 Service] ---> ปิดการเชื่อมต่อ HL7');
    server = null;
  }
}

module.exports = { 
  starthl7Server, 
  stophl7Server 
};