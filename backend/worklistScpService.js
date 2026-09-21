// รับ C-FIND ของ Modality Worklist จากเครื่อง Modality โดยตรง (ไม่ผ่าน Orthanc)
// ใช้แก้ปัญหาเครื่องบางรุ่นที่ตั้งค่า filter/AE Title เองไม่ได้ - ยิง query แบบ "ขอทั้งหมด" เสมอ
// เลยต้องแยกด้วย "พอร์ตที่เครื่องต่อเข้ามา" แทน: 1 modality = 1 พอร์ต ในโปรเซสเดียวกัน ไม่ต้องรัน Orthanc หลาย instance
// อ่านไฟล์ .wl ตัวเดียวกับที่ dicomService.js สร้างให้ Orthanc อยู่แล้ว (ไฟล์ DICOM P10 จริงจาก dump2dcm) ไม่ต้องสร้างไฟล์ซ้ำ
//
// หมายเหตุ: เคยลองเพิ่มตัวเลือก encoding (UTF8/TIS620) ต่อพอร์ตด้วย แต่ dcmjs-dimse (library ที่ใช้ตรงนี้)
// ไม่รองรับ SpecificCharacterSet เลย - อ่านไฟล์ TIS620 เข้ามาแล้วตอบกลับเป็น UTF-8 เสมอไม่ว่าไฟล์ต้นทางจะเป็นอะไร
// เลยตัดออก เหลือแค่ modality+ภาษา (encoding ยังเลือกได้แค่ระดับ global ผ่าน Orthanc ที่พอร์ต 4242 เท่านั้น)

const fs = require('fs');
const path = require('path');
const dcmjsDimse = require('dcmjs-dimse');
const dicomService = require('./dicomService');

const { Server, Scp, Dataset } = dcmjsDimse;
const { CFindResponse, CEchoResponse } = dcmjsDimse.responses;
const { Status, PresentationContextResult, TransferSyntax, SopClass } = dcmjsDimse.constants;

// port -> { modality, lang, server } ของ SCP ที่กำลังรันอยู่ตอนนี้ (คีย์ด้วย port เพราะ modality เดียวเปิดได้หลายพอร์ต ต่างกันที่ภาษา)
let runningServers = {};

// ดึงค่า Modality ออกจาก ScheduledProcedureStepSequence
// เหมือนที่ Mppsservice.js ดึง AccessionNumber ออกจาก ScheduledStepAttributesSequence (nested sequence เดียวกัน)
function extractModality(dataset) {
  try {
    const seq = dataset.getElement('ScheduledProcedureStepSequence');
    const item = Array.isArray(seq) ? seq[0] : seq;
    return item && item.Modality ? String(item.Modality).toUpperCase() : '';
  } catch (err) {
    return '';
  }
}

function loadDataset(filePath) {
  return new Promise((resolve) => {
    Dataset.fromFile(filePath, (error, dataset) => {
      if (error || !dataset) {
        console.warn(`[Worklist SCP] ---> อ่านไฟล์ .wl ไม่สำเร็จ ข้ามไฟล์นี้: ${filePath}`, error && error.message);
        return resolve(null);
      }
      resolve(dataset);
    });
  });
}

// เฉพาะเคสที่ Modality ตรงกับพอร์ตนี้เท่านั้น - ไม่กรองฟิลด์อื่นเพิ่ม (เหมือน Orthanc ตอน DicomAlwaysAllowFindWorklist=true)
// lang ว่าง = ใช้โฟลเดอร์หลัก (พฤติกรรมเดิม ก่อนรองรับแยกภาษา) / lang 'th'/'en' = ใช้ไฟล์คู่ภาษาจาก getLangVariantDir()
async function findMatchingDatasets(modalityCode, lang) {
  const dir = lang ? dicomService.getLangVariantDir() : dicomService.getWorklistDir();
  const suffix = lang ? `.${lang}.wl` : '.wl';

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(suffix));
  } catch (err) {
    console.warn(`[Worklist SCP] ---> อ่านโฟลเดอร์ worklist ไม่สำเร็จ: ${dir}`, err.message);
    return [];
  }

  const datasets = await Promise.all(files.map((f) => loadDataset(path.join(dir, f))));
  return datasets.filter((d) => d && extractModality(d) === modalityCode);
}

// สร้าง Scp class ที่ผูกกับ modality+ภาษาเดียว (ตามพอร์ตที่เครื่องนี้เปิดฟัง)
function createWorklistScpClass(modalityCode, lang) {
  return class WorklistScp extends Scp {
    constructor(socket, opts) {
      super(socket, opts);
    }

    // ยอมรับ Association จากทุกเครื่อง Modality ที่ขอเชื่อมต่อมา ไม่เช็ค AE Title (เหมือน MppsScp)
    associationRequested(association) {
      const contexts = association.getPresentationContexts();
      contexts.forEach((c) => {
        const context = association.getPresentationContext(c.id);
        const abstractSyntax = context.getAbstractSyntaxUid();

        if (
          abstractSyntax === SopClass.Verification ||
          abstractSyntax === SopClass.ModalityWorklistInformationModelFind
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

    cFindRequest(request, callback) {
      findMatchingDatasets(modalityCode, lang)
        .then((datasets) => {
          const responses = datasets.map((dataset) => {
            const response = CFindResponse.fromRequest(request);
            response.setDataset(dataset);
            response.setStatus(Status.Pending);
            return response;
          });

          // ปิดท้ายด้วย Success (ไม่มี dataset) บอกเครื่องว่าส่งครบแล้ว
          const finalResponse = CFindResponse.fromRequest(request);
          finalResponse.setStatus(Status.Success);
          responses.push(finalResponse);

          callback(responses);
        })
        .catch((err) => {
          console.error(`[Worklist SCP] ---> ผิดพลาดตอนค้นหา worklist (${modalityCode}${lang ? '/' + lang : ''}):`, err);
          const errorResponse = CFindResponse.fromRequest(request);
          errorResponse.setStatus(Status.ProcessingFailure);
          callback([errorResponse]);
        });
    }

    associationReleaseRequested() {
      this.sendAssociationReleaseResponse();
    }
  };
}

function stopServer(port) {
  const entry = runningServers[port];
  if (entry && entry.server) {
    try {
      entry.server.close();
    } catch (err) {
      /* เพิกเฉย */
    }
  }
  delete runningServers[port];
}

// ใช้ตอน apply settings ใหม่ หรือตอนปิดโปรแกรม
function stopAllWorklistScpServers() {
  Object.keys(runningServers).forEach(stopServer);
}

function startOneServer(modalityCode, lang, port) {
  const ScpClass = createWorklistScpClass(modalityCode, lang);
  const server = new Server(ScpClass);
  const label = `${modalityCode}${lang ? '/' + lang : ''}`;

  return new Promise((resolve) => {
    let settled = false;

    server.on('networkError', (e) => {
      const code = e && e.code;
      const message = code === 'EADDRINUSE'
        ? `พอร์ต ${port} (${label}) ถูกใช้งานอยู่แล้ว ไม่สามารถรับ worklist ของ ${label} ได้`
        : `Network error พอร์ต ${port} (${label}): ${(e && e.message) || e}`;
      console.error(`[Worklist SCP] ---> ${message}`);
      if (!settled) {
        settled = true;
        resolve({ modality: modalityCode, lang, port, error: message });
      }
    });

    server.on('listening', () => {
      runningServers[port] = { modality: modalityCode, lang, server };
      console.log(`[Worklist SCP] ---> เริ่ม Worklist SCP สำหรับ ${label} ที่พอร์ต ---> ${port}`);
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });

    server.listen(Number(port));
  });
}

// เรียกทุกครั้งที่ apply settings - หยุด SCP เดิมทั้งหมดแล้วเริ่มใหม่ตาม modalityPorts ล่าสุด
// (เหมือน startMppsServer ที่ stop แล้ว start ใหม่ทุกครั้ง ไม่ diff เพราะ config ส่วนนี้แก้ไม่บ่อย)
// คืนค่า array ของ { modality, lang, port, error } เฉพาะพอร์ตที่เริ่มไม่สำเร็จ ให้ผู้เรียกเอาไปแจ้งเตือนต่อ
async function applyModalityPorts(modalityPortEntries) {
  stopAllWorklistScpServers();

  const entries = (modalityPortEntries || []).filter((e) => e && e.port && String(e.port).trim() !== '');
  if (entries.length === 0) return [];

  const results = await Promise.all(
    entries.map(({ modality, lang, port }) => startOneServer(modality, lang, port))
  );
  return results.filter(Boolean);
}

module.exports = {
  applyModalityPorts,
  stopAllWorklistScpServers,
};
