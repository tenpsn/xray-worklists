// รับ MPPS จากเครื่อง Modality โดยตรง
// ใช้ dcmjs-dimse ใช้แค่เพื่อ "รับรู้สถานะ" แล้วลบไฟล์ worklist ทิ้ง

const path = require('path');
const fs = require('fs');
const util = require('util'); // เพิ่ม util สำหรับจัดรูปแบบข้อความ log
const dcmjsDimse = require('dcmjs-dimse');

// เก็บไว้ในโฟลเดอร์ logs/ แยกต่างหาก หมุนไฟล์ตาม "วัน" เก็บย้อนหลังตาม LOG_RETENTION_DAYS วัน เกินนี้ลบทิ้งอัตโนมัติ
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_PREFIX = 'dicom-network';
const LOG_RETENTION_DAYS = 7; // เก็บ log ย้อนหลัง 7 วัน 
const LOG_FILE_PATTERN = new RegExp(`^${LOG_PREFIX}-\\d{4}-\\d{2}-\\d{2}\\.log$`);

// ตรวจสอบว่ามีโฟลเดอร์ logs หรือยัง ถ้ายังไม่มีให้สร้างขึ้นมา
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  console.log(`[MPPS] ---> สร้างโฟลเดอร์ logs: ${LOG_DIR}`);
}

function getLogFilePathForDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `${LOG_PREFIX}-${y}-${m}-${d}.log`);
}

// ลบไฟล์ log ที่เก่าเกิน LOG_RETENTION_DAYS วันทิ้'
function cleanupOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    files.forEach((file) => {
      const match = file.match(LOG_FILE_PATTERN);
      if (!match) return;

      const fileDateStr = file.slice(LOG_PREFIX.length + 1, LOG_PREFIX.length + 11); // 'YYYY-MM-DD'
      const fileDate = new Date(fileDateStr);
      if (isNaN(fileDate.getTime())) return;

      const ageDays = Math.floor((today - fileDate) / (24 * 60 * 60 * 1000));
      if (ageDays > LOG_RETENTION_DAYS) {
        try {
          fs.unlinkSync(path.join(LOG_DIR, file));
          console.log(`[MPPS] ---> ลบไฟล์ log อายุเกิน ${LOG_RETENTION_DAYS} วัน: ${file}`);
        } catch (err) {
          // ข้ามไฟล์นี้ไป ไม่ทำให้ cleanup ไฟล์อื่นพังตาม
        }
      }
    });
  } catch (err) {
    console.warn('[MPPS] ---> ลบไฟล์ log อายุเกิน 7 วันไม่สำเร็จ:', err.message);
  }
}

let currentLogDateKey = null;
let logStream = null;

// เช็คว่าวันเปลี่ยนไปหรือยัง ถ้าเปลี่ยนวัน (หรือยังไม่เคยเปิด) ให้ปิด stream เดิมแล้วเปิดไฟล์ของวันใหม่
// พร้อมรัน cleanup ไฟล์เก่าไปด้วยทุกครั้งที่ขึ้นวันใหม่
function ensureLogStreamForToday() {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10); // 'YYYY-MM-DD'

  if (currentLogDateKey === dateKey && logStream) return;

  if (logStream) {
    logStream.end();
  }

  currentLogDateKey = dateKey;
  logStream = fs.createWriteStream(getLogFilePathForDate(now), { flags: 'a' });

  cleanupOldLogs();
}

// เปิด stream ทันทีตอนโหลดโมดูล (เผื่อยังไม่มี log เขียนเข้ามาเลยในวันนั้น ก็ยังมีการ cleanup เกิดขึ้น)
ensureLogStreamForToday();

// เขียน log 1 บรรทัด พร้อมเช็คว่าต้องขึ้นไฟล์วันใหม่หรือยังก่อนทุกครั้ง
function writeLog(level, ...args) {
  ensureLogStreamForToday();
  logStream.write(`${new Date().toISOString()} -- ${level} -- ${util.format(...args)}\n`);
}

if (dcmjsDimse.log) {
  // ส่ง INFO, WARN, ERROR ลงไฟล์
  dcmjsDimse.log.info = (...args) => writeLog('INFO', ...args);
  dcmjsDimse.log.warn = (...args) => writeLog('WARN', ...args);
  dcmjsDimse.log.error = (...args) => writeLog('ERROR', ...args);
}
// =========================================================================

const { Server, Scp } = dcmjsDimse;
const { NCreateResponse, NSetResponse, CEchoResponse } = dcmjsDimse.responses;
const { Status, PresentationContextResult, TransferSyntax, SopClass } = dcmjsDimse.constants;
const STATE_FILE = path.join(__dirname, 'mpps-state.json');

let mppsMap = {};
try {
  if (fs.existsSync(STATE_FILE)) {
    mppsMap = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
} catch (err) {
  console.warn('[MPPS] ---> อ่าน mpps-state.json ไม่สำเร็จ เริ่มต้นใหม่:', err.message);
  mppsMap = {};
}

function saveMppsMap() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(mppsMap), 'utf8');
  } catch (err) {
    console.warn('[MPPS] ---> บันทึก mpps-state.json ไม่สำเร็จ:', err.message);
  }
}

// ดึง Accession Number ออกจาก ScheduledStepAttributesSequence (มีเฉพาะตอน N-CREATE เท่านั้น)
function extractAccessionNumber(dataset) {
  try {
    const seq = dataset.getElement('ScheduledStepAttributesSequence');
    const item = Array.isArray(seq) ? seq[0] : seq;
    return item && item.AccessionNumber ? String(item.AccessionNumber) : '';
  } catch (err) {
    return '';
  }
}

let onStatusChangeCallback = null; // (accessionNumber, status) => void
let server = null;

function createMppsScpClass() {
  return class MppsScp extends Scp {
    constructor(socket, opts) {
      super(socket, opts);
    }

    // ยอมรับ Association จากทุกเครื่อง Modality ที่ขอเชื่อมต่อมา (ไม่เช็ค AE Title เพื่อความง่าย)
    associationRequested(association) {
      const contexts = association.getPresentationContexts();
      contexts.forEach((c) => {
        const context = association.getPresentationContext(c.id);
        const abstractSyntax = context.getAbstractSyntaxUid();

        if (
          abstractSyntax === SopClass.Verification ||
          abstractSyntax === SopClass.ModalityPerformedProcedureStep
        ) {
          const transferSyntaxes = context.getTransferSyntaxUids();
          transferSyntaxes.forEach((ts) => {
            if (
              ts === TransferSyntax.ImplicitVRLittleEndian ||
              ts === TransferSyntax.ExplicitVRLittleEndian
            ) {
              context.setResult(PresentationContextResult.Accept, ts);
            } else {
              context.setResult(PresentationContextResult.RejectTransferSyntaxesNotSupported);
            }
          });
        } else {
          context.setResult(PresentationContextResult.RejectAbstractSyntaxNotSupported);
        }
      });
      this.sendAssociationAccept();
    }

    // รองรับ C-ECHO เผื่อเครื่อง Modality ทดสอบการเชื่อมต่อก่อน
    cEchoRequest(request, callback) {
      const response = CEchoResponse.fromRequest(request);
      response.setStatus(Status.Success);
      callback(response);
    }

    // N-CREATE = เริ่มตรวจ (สถานะ "IN PROGRESS")
    nCreateRequest(request, callback) {
      try {
        const dataset = request.getDataset();
        const sopInstanceUid = request.getAffectedSopInstanceUid();
        const accessionNumber = extractAccessionNumber(dataset);

        if (sopInstanceUid && accessionNumber) {
          mppsMap[sopInstanceUid] = accessionNumber;
          saveMppsMap();
        }

        console.log(`[MPPS] ---> ได้รับ N-CREATE (เริ่มตรวจ) สำหรับ XN: ${accessionNumber || '(ไม่ทราบ Accession Number)'}`);

        if (onStatusChangeCallback && accessionNumber) {
          onStatusChangeCallback(accessionNumber, 'IN PROGRESS');
        }

        const response = NCreateResponse.fromRequest(request);
        response.setStatus(Status.Success);
        callback(response);
      } catch (err) {
        console.error('[MPPS] ---> ผิดพลาดตอนรับ N-CREATE:', err);
        const response = NCreateResponse.fromRequest(request);
        response.setStatus(Status.ProcessingFailure);
        callback(response);
      }
    }

    // N-SET = อัพเดทสถานะ (ระหว่างตรวจ / ตรวจเสร็จ "COMPLETED" / ยกเลิก "DISCONTINUED")
    nSetRequest(request, callback) {
      try {
        const dataset = request.getDataset();
        const sopInstanceUid = request.getRequestedSopInstanceUid();

        // N-SET มักไม่ส่ง Accession Number มาซ้ำ ต้องอ้างอิงจาก mapping ที่บันทึกไว้ตอน N-CREATE
        let accessionNumber = extractAccessionNumber(dataset);
        if (!accessionNumber && sopInstanceUid && mppsMap[sopInstanceUid]) {
          accessionNumber = mppsMap[sopInstanceUid];
        }

        const rawStatus = dataset.getElement('PerformedProcedureStepStatus') || '';
        const status = String(rawStatus).toUpperCase();

        console.log(`[MPPS] ---> ได้รับ N-SET สถานะ "${status}" สำหรับ XN: ${accessionNumber || '(ไม่ทราบ Accession Number)'}`);

        if (onStatusChangeCallback && accessionNumber && status) {
          onStatusChangeCallback(accessionNumber, status);
        }

        // จบงานแล้ว (เสร็จ/ยกเลิก) ไม่ต้องเก็บ mapping นี้ต่อ
        if (sopInstanceUid && (status === 'COMPLETED' || status === 'DISCONTINUED')) {
          delete mppsMap[sopInstanceUid];
          saveMppsMap();
        }

        const response = NSetResponse.fromRequest(request);
        response.setStatus(Status.Success);
        callback(response);
      } catch (err) {
        console.error('[MPPS] ---> ผิดพลาดตอนรับ N-SET:', err);
        const response = NSetResponse.fromRequest(request);
        response.setStatus(Status.ProcessingFailure);
        callback(response);
      }
    }

    associationReleaseRequested() {
      this.sendAssociationReleaseResponse();
    }
  };
}

// หยุด MPPS server (ใช้ตอน restart ด้วยพอร์ตใหม่ หรือตอนปิดโปรแกรม)
function stopMppsServer() {
  if (server) {
    try {
      server.close();
    } catch (err) {
      /* เพิกเฉย */
    }
    server = null;
  }
}

// เริ่ม (หรือ restart) MPPS SCP server ที่พอร์ตที่กำหนด
// onStatusChange(accessionNumber, status) จะถูกเรียกทุกครั้งที่ได้รับสถานะใหม่จากเครื่อง Modality
// status ที่เป็นไปได้: 'IN PROGRESS' | 'COMPLETED' | 'DISCONTINUED'
//
// หมายเหตุ: ฟังก์ชันนี้ไม่ครอบ try/catch ไว้เอง (ต่างจากเดิม) — ถ้า listen() ไม่สำเร็จแบบทันที
// (เช่น port ผิดรูปแบบ) จะโยน error ออกไปให้ผู้เรียก (server.js) เป็นคนตัดสินใจว่าจะถือเป็นเรื่องร้ายแรง
// ต้องปิดโปรแกรมหรือไม่ (ตอนสตาร์ทเครื่อง = ร้ายแรง / ตอนเปลี่ยนค่าจากหน้าเว็บ = แค่แจ้งเตือน ไม่ปิดทั้งระบบ)
function startMppsServer(port, onStatusChange) {
  stopMppsServer();
  onStatusChangeCallback = onStatusChange;

  const MppsScpClass = createMppsScpClass();
  server = new Server(MppsScpClass);

  server.on('networkError', (e) => {
    const code = e && e.code;
    if (code === 'EADDRINUSE') {
      // เคสนี้มักเกิดแบบ asynchronous (มาทีหลังตอน listen() คืนค่าไปแล้ว) จึง throw กลับไปที่ผู้เรียกไม่ได้
      // เลย log ให้ชัดเจนที่สุดแทน เพื่อให้เห็นสาเหตุง่ายๆ ใน PM2 logs
      console.error(`[MPPS] ---> พอร์ต ${port} ถูกใช้งานอยู่แล้ว ไม่สามารถรับ MPPS จากเครื่อง Modality ได้ กรุณาตรวจสอบว่ามีโปรแกรมอื่น หรือ backend อีก instance ใช้พอร์ตนี้อยู่ก่อนแล้วหรือไม่`);
    } else {
      console.warn('[MPPS] ---> Network error:', (e && e.message) || e);
    }
  });

  server.listen(Number(port));
  console.log(`[MPPS] ---> เริ่ม MPPS SCP server ที่พอร์ต ---> ${port}`);
}

module.exports = { startMppsServer, stopMppsServer };