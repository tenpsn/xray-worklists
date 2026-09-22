// รับ C-FIND ของ Modality Worklist จากเครื่อง Modality โดยตรง (ไม่ผ่าน Orthanc)
// ใช้แก้ปัญหาเครื่องบางรุ่นที่ตั้งค่า filter/AE Title เองไม่ได้ - ยิง query แบบ "ขอทั้งหมด" เสมอ
// เลยต้องแยกด้วย "พอร์ตที่เครื่องต่อเข้ามา" แทน: 1 modality = 1 พอร์ต ในโปรเซสเดียวกัน ไม่ต้องรัน Orthanc หลาย instance
// อ่านไฟล์ .wl ตัวเดียวกับที่ dicomService.js สร้างให้ Orthanc อยู่แล้ว (ไฟล์ DICOM P10 จริงจาก dump2dcm) ไม่ต้องสร้างไฟล์ซ้ำ
//
// หมายเหตุเรื่อง charset: dcmjs (library ที่ dcmjs-dimse ใช้ข้างในสำหรับ parse/serialize dataset) มี bug 2 จุด
// ที่ทำให้ตอบกลับเป็น UTF-8 (ISO_IR 192) เสมอไม่ว่าไฟล์ต้นทางจะเป็น charset อะไร:
//   1. ตอนอ่านไฟล์ (naturalizeDataset) บังคับ label SpecificCharacterSet เป็น ISO_IR 192 เสมอ ไม่ว่าไฟล์จะประกาศอะไรไว้
//   2. ตอนเขียนไฟล์ตอบกลับ hard-code ตัวเข้ารหัสเป็น TextEncoder("utf-8") ตรงๆ ไม่มีช่องให้เปลี่ยน
// วิธีแก้: ตอนตอบ C-FIND ไม่ใช้ dcmjs แปลง dataset เลย อ่าน byte ดิบจากไฟล์ .wl (ที่ dump2dcm เขียนไว้ถูกต้องอยู่แล้ว
// ทั้ง byte และ charset ที่ประกาศ) ตัดเฉพาะ meta header (preamble+DICM+group 0002) ออก แล้วยัด byte ส่วน dataset
// ที่เหลือใส่ response ตรงๆ ผ่าน object จำลองที่มีแค่ method ที่ dcmjs-dimse เรียกใช้ตอนเขียนขึ้นสาย
// (ดู buildRawDatasetResponse) - ใช้ dcmjs ผ่าน Dataset.fromFile ต่อแค่ตอน "หา modality เพื่อกรองไฟล์" เท่านั้น
// (ปลอดภัย เพราะ field Modality เป็น ASCII ล้วน ไม่มีปัญหา charset)

const fs = require('fs');
const path = require('path');
const dcmjsDimse = require('dcmjs-dimse');
const dicomService = require('./dicomService');

const { Server, Scp, Dataset } = dcmjsDimse;
const { CFindResponse, CEchoResponse } = dcmjsDimse.responses;
const { Status, PresentationContextResult, TransferSyntax, SopClass } = dcmjsDimse.constants;

// ตัด meta header (128-byte preamble + "DICM" + group 0002 elements) ของไฟล์ DICOM P10 ออก
// เหลือแค่ byte ของ dataset จริง (เริ่มจาก (0008,0005) SpecificCharacterSet เป็นต้นไป) - ไม่แตะ/แปลง byte เลย
// รักษา charset เดิมของไฟล์ไว้ 100% เพราะไม่ผ่าน dcmjs (ต่างจาก Dataset.fromFile ที่ parse แล้ว charset จะเพี้ยน)
function stripMetaHeader(buffer) {
  const DICM_OFFSET = 128;
  if (buffer.length < DICM_OFFSET + 4 || buffer.toString('ascii', DICM_OFFSET, DICM_OFFSET + 4) !== 'DICM') {
    throw new Error('ไม่ใช่ไฟล์ DICOM P10 ที่ถูกต้อง (ไม่พบ DICM magic ที่ offset 128)');
  }

  // (0002,0000) FileMetaInformationGroupLength เป็น VR แบบ UL เสมอ (short form: tag 4 + VR 2 + length 2 + value 4)
  // meta group เข้ารหัสแบบ Explicit VR Little Endian เสมอตามมาตรฐาน DICOM ไม่ว่า dataset จริงจะเป็น TS อะไร
  const groupLengthElementStart = DICM_OFFSET + 4;
  const groupTag = buffer.readUInt16LE(groupLengthElementStart);
  const elementTag = buffer.readUInt16LE(groupLengthElementStart + 2);
  const vr = buffer.toString('ascii', groupLengthElementStart + 4, groupLengthElementStart + 6);
  if (groupTag !== 0x0002 || elementTag !== 0x0000 || vr !== 'UL') {
    throw new Error('ไม่พบ FileMetaInformationGroupLength (0002,0000) ที่จุดเริ่มต้น meta group');
  }
  const groupLengthValue = buffer.readUInt32LE(groupLengthElementStart + 8);
  const metaElementsStart = groupLengthElementStart + 12; // หลัง element (0002,0000) เอง
  const datasetStart = metaElementsStart + groupLengthValue;

  return buffer.slice(datasetStart);
}

// VR ที่ใช้ header แบบยาว (tag 4 + VR 2 + reserved 2 + length 4) ตาม DICOM PS3.5 - นอกนั้นใช้ header สั้น (tag 4 + VR 2 + length 2)
const LONG_FORM_EXPLICIT_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);

// แปลง content ข้างใน 1 sequence (ชุดของ Item) จาก Explicit VR เป็น Implicit VR
// ตัว Item wrapper เอง (tag+length 8 byte) เหมือนกันทั้ง Implicit/Explicit ไม่ต้องแก้ แต่ element ข้างในแต่ละ Item
// เป็น Explicit VR อยู่ ต้องแปลงซ้ำแบบเดียวกับระดับบนสุด (เรียก convertExplicitElementsToImplicit ซ้ำ)
// หมายเหตุ: รองรับเฉพาะ sequence/item แบบ definite-length (ไม่มี delimitation item) ตรงกับที่ dump2dcm สร้างให้จริง
function convertExplicitSequenceItemsToImplicit(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    const itemTag = buffer.slice(offset, offset + 4); // (FFFE,E000)
    const itemLength = buffer.readUInt32LE(offset + 4);
    const itemContent = buffer.slice(offset + 8, offset + 8 + itemLength);
    offset += 8 + itemLength;

    const convertedContent = convertExplicitElementsToImplicit(itemContent);
    const header = Buffer.alloc(8);
    itemTag.copy(header, 0);
    header.writeUInt32LE(convertedContent.length, 4);
    chunks.push(header, convertedContent);
  }
  return Buffer.concat(chunks);
}

// แปลงชุด element ระดับหนึ่ง (ทั้ง dataset ระดับบนสุด หรือข้างใน 1 item ของ sequence) จาก Explicit VR LE เป็น Implicit VR LE
// byte ของ "ค่า" (value) แต่ละ element ไม่ถูกแตะ/แปลงเลย - แค่เปลี่ยน header ให้ไม่มี VR + length เป็น 4 byte เสมอ
// (ตาม format ของ Implicit VR) รักษา charset/เนื้อหาเดิมไว้ 100% ไม่ผ่าน dcmjs หรือ string encode/decode ใดๆ ทั้งสิ้น
function convertExplicitElementsToImplicit(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = buffer.slice(offset, offset + 4);
    const vr = buffer.toString('ascii', offset + 4, offset + 6);
    let length;
    let valueStart;
    if (LONG_FORM_EXPLICIT_VRS.has(vr)) {
      length = buffer.readUInt32LE(offset + 8);
      valueStart = offset + 12;
    } else {
      length = buffer.readUInt16LE(offset + 6);
      valueStart = offset + 8;
    }
    const rawValue = buffer.slice(valueStart, valueStart + length);
    offset = valueStart + length;

    const convertedValue = vr === 'SQ' ? convertExplicitSequenceItemsToImplicit(rawValue) : rawValue;

    const header = Buffer.alloc(8);
    tag.copy(header, 0);
    header.writeUInt32LE(convertedValue.length, 4);
    chunks.push(header, convertedValue);
  }
  return Buffer.concat(chunks);
}

// สร้าง object จำลอง Dataset ของ dcmjs-dimse สำหรับใช้เป็น response โดยเฉพาะ - มีแค่ method ที่โค้ดเขียน PDU
// ของ dcmjs-dimse เรียกใช้จริง (getDenaturalizedDataset) คืน byte ดิบจากไฟล์ตรงๆ ไม่ผ่านการ decode/encode ของ dcmjs เลย
//
// negotiatedTransferSyntaxUid: transfer syntax ที่ negotiate ได้จริงตอน associationRequested (ดู createWorklistScpClass)
// ไฟล์บนดิสก์เป็น Explicit VR Little Endian เสมอ (dump2dcm เขียนแบบนี้เสมอ) ถ้า negotiate ได้เป็น Implicit VR Little Endian
// แทน ต้องแปลง byte จริงๆ ก่อนส่ง (ไม่ใช่แค่เปลี่ยน label) ไม่งั้นเครื่องปลายทางจะ parse ผิด (คนละ format กันจริง)
// ที่ต้องทำแบบนี้เพราะ dcmjs-dimse เอง "แปลงให้อัตโนมัติ" เฉพาะตอน dataset เป็น class Dataset จริงเท่านั้น (เรียก getElements()
// ซึ่ง object จำลองของเราไม่มี) ถ้าปล่อยให้ dcmjs-dimse พยายามแปลงเองจะ error (ยืนยันจาก log จริงตอน DROC ต่อเข้ามา)
function buildRawDatasetResponse(filePath, negotiatedTransferSyntaxUid) {
  const raw = fs.readFileSync(filePath);
  let datasetBuffer = stripMetaHeader(raw);
  let transferSyntaxUid = TransferSyntax.ExplicitVRLittleEndian;

  if (negotiatedTransferSyntaxUid === TransferSyntax.ImplicitVRLittleEndian) {
    datasetBuffer = convertExplicitElementsToImplicit(datasetBuffer);
    transferSyntaxUid = TransferSyntax.ImplicitVRLittleEndian;
  }

  return {
    getDenaturalizedDataset: () => datasetBuffer,
    getTransferSyntaxUid: () => transferSyntaxUid,
  };
}

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
// lang ว่าง = ใช้โฟลเดอร์หลัก (พฤติกรรมเดิม ก่อนรองรับแยกภาษา) / lang 'th'/'en' = ใช้ไฟล์คู่ภาษา+encoding จาก getLangVariantDir()
// คืน { filePath, dataset } เก็บ filePath ไว้ด้วย เพราะตอนตอบกลับจริงต้องอ่าน byte ดิบจากไฟล์เดิมอีกรอบ (buildRawDatasetResponse)
// ไม่ใช้ dataset ที่ parse ผ่าน dcmjs ตัวนี้ตรงๆ (ใช้แค่หา modality กรองไฟล์ - ปลอดภัยเพราะเป็น field ASCII)
async function findMatchingDatasets(modalityCode, lang, charset) {
  const dir = lang ? dicomService.getLangVariantDir() : dicomService.getWorklistDir();
  const suffix = lang ? `.${lang}.${charset === 'TIS620' ? 'tis620' : 'utf8'}.wl` : '.wl';

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(suffix));
  } catch (err) {
    console.warn(`[Worklist SCP] ---> อ่านโฟลเดอร์ worklist ไม่สำเร็จ: ${dir}`, err.message);
    return [];
  }

  const entries = await Promise.all(files.map(async (f) => {
    const filePath = path.join(dir, f);
    const dataset = await loadDataset(filePath);
    return { filePath, dataset };
  }));
  return entries.filter((e) => e.dataset && extractModality(e.dataset) === modalityCode);
}

// สร้าง Scp class ที่ผูกกับ modality+ภาษา+encoding เดียว (ตามพอร์ตที่เครื่องนี้เปิดฟัง)
function createWorklistScpClass(modalityCode, lang, charset) {
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
          // ไฟล์บนดิสก์เป็น Explicit VR Little Endian เสมอ - เลือกอันนี้ก่อนถ้าเครื่องเสนอมาด้วย จะได้ไม่ต้องแปลง byte เลย
          // (ถ้าเลือก Implicit ต้องแปลง byte จริงก่อนส่ง ดู convertExplicitElementsToImplicit/buildRawDatasetResponse)
          const hasExplicit = transferSyntaxes.includes(TransferSyntax.ExplicitVRLittleEndian);
          const chosenTs = hasExplicit
            ? TransferSyntax.ExplicitVRLittleEndian
            : transferSyntaxes.includes(TransferSyntax.ImplicitVRLittleEndian)
              ? TransferSyntax.ImplicitVRLittleEndian
              : null;

          if (chosenTs) {
            context.setResult(PresentationContextResult.Accept, chosenTs);
          } else {
            context.setResult(PresentationContextResult.RejectTransferSyntaxesNotSupported);
          }

          if (abstractSyntax === SopClass.ModalityWorklistInformationModelFind) {
            this.acceptedFindTransferSyntaxUid = chosenTs;
          }
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
      findMatchingDatasets(modalityCode, lang, charset)
        .then((entries) => {
          const responses = entries.map(({ filePath }) => {
            const response = CFindResponse.fromRequest(request);
            // ใช้ byte ดิบจากไฟล์ตรงๆ (ไม่ผ่าน dcmjs) กัน charset เพี้ยนเป็น UTF-8 เสมอ - ดู comment หัวไฟล์
            response.setDataset(buildRawDatasetResponse(filePath, this.acceptedFindTransferSyntaxUid));
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

function startOneServer(modalityCode, lang, charset, port) {
  const ScpClass = createWorklistScpClass(modalityCode, lang, charset);
  const server = new Server(ScpClass);
  const label = `${modalityCode}${lang ? '/' + lang : ''}${lang ? '/' + charset : ''}`;

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
        resolve({ modality: modalityCode, lang, charset, port, error: message });
      }
    });

    server.on('listening', () => {
      runningServers[port] = { modality: modalityCode, lang, charset, server };
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
// คืนค่า array ของ { modality, lang, charset, port, error } เฉพาะพอร์ตที่เริ่มไม่สำเร็จ ให้ผู้เรียกเอาไปแจ้งเตือนต่อ
async function applyModalityPorts(modalityPortEntries) {
  stopAllWorklistScpServers();

  const entries = (modalityPortEntries || []).filter((e) => e && e.port && String(e.port).trim() !== '');
  if (entries.length === 0) return [];

  const results = await Promise.all(
    entries.map(({ modality, lang, charset, port }) => startOneServer(modality, lang, charset === 'TIS620' ? 'TIS620' : 'UTF8', port))
  );
  return results.filter(Boolean);
}

module.exports = {
  applyModalityPorts,
  stopAllWorklistScpServers,
};
