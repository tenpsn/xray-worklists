// mppsService.js
// รับ MPPS (Modality Performed Procedure Step) จากเครื่อง Modality โดยตรง
// ใช้ dcmjs-dimse (pure JavaScript DICOM networking) จึงไม่ต้องพึ่งโปรแกรม DCMTK
// เช่น ppsscpfs.exe เลย (ต่างจาก MWL ที่ยังใช้ dump2dcm.exe ของ DCMTK อยู่)
// ในระบบนี้ใช้แค่เพื่อ "รับรู้สถานะ" แล้วลบไฟล์ worklist ทิ้งเท่านั้น ไม่ได้ใช้ตัดสินใจทางการแพทย์ใดๆ

const path = require('path');
const fs = require('fs');
const util = require('util'); // เพิ่ม util สำหรับจัดรูปแบบข้อความ log
const dcmjsDimse = require('dcmjs-dimse');

// =========================================================================
// ส่วนที่เพิ่มใหม่: จัดการตั้งค่าให้ Log ของ DICOM Library ไปเขียนลงไฟล์ทั้งหมด
// =========================================================================
const logFilePath = path.join(__dirname, 'dicom-network.log');
// สร้าง Stream เพื่อเขียนไฟล์แบบต่อท้าย (Append)
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

if (dcmjsDimse.log) {
  // ส่ง INFO, WARN, ERROR ลงไฟล์ทั้งหมด โดยไม่แสดงออกทาง Console
  dcmjsDimse.log.info = (...args) => {
    logStream.write(`${new Date().toISOString()} -- INFO -- ${util.format(...args)}\n`);
  };
  dcmjsDimse.log.warn = (...args) => {
    logStream.write(`${new Date().toISOString()} -- WARN -- ${util.format(...args)}\n`);
  };
  dcmjsDimse.log.error = (...args) => {
    logStream.write(`${new Date().toISOString()} -- ERROR -- ${util.format(...args)}\n`);
  };
}
// =========================================================================

const { Server, Scp } = dcmjsDimse;
const { NCreateResponse, NSetResponse, CEchoResponse } = dcmjsDimse.responses;
const { Status, PresentationContextResult, TransferSyntax, SopClass } = dcmjsDimse.constants;

// ไฟล์เก็บ mapping ระหว่าง MPPS SOP Instance UID (ที่ได้รับตอน N-CREATE) กับ Accession Number (XN)
// จำเป็นเพราะตอน N-SET (ตรวจเสร็จ/ยกเลิก) เครื่อง Modality มักไม่ส่ง Accession Number มาซ้ำอีก
// ต้องอ้างอิงจาก SOP Instance UID เดิมที่ผูกไว้ตอน N-CREATE เท่านั้น
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
function startMppsServer(port, onStatusChange) {
  stopMppsServer();
  onStatusChangeCallback = onStatusChange;

  try {
    const MppsScpClass = createMppsScpClass();
    server = new Server(MppsScpClass);
    server.on('networkError', (e) => {
      console.warn('[MPPS] ---> Network error:', (e && e.message) || e);
    });
    server.listen(Number(port));
    console.log(`[MPPS] ---> เริ่ม MPPS SCP server ที่พอร์ต ---> ${port}`);
  } catch (err) {
    console.error('[MPPS] ---> เริ่ม MPPS server ไม่สำเร็จ:', err.message);
  }
}

module.exports = { startMppsServer, stopMppsServer };