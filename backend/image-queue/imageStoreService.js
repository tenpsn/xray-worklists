// รับภาพจากเครื่องเอกซเรย์แล้วเขียนลงคิวบนดิสก์ เขียนลงโฟลเดอร์ชั่วคราวก่อนแล้วค่อยย้ายเข้าคิว
// เขียน byte ดิบตามที่รับมาไม่แปลงผ่านไลบรารี ชื่อภาษาไทยจึงไม่เพี้ยน

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');
const dcmjsDimse = require('dcmjs-dimse');

const { Server, Scp, Dataset } = dcmjsDimse;
const { CStoreResponse, CEchoResponse } = dcmjsDimse.responses;
const { Status, PresentationContextResult, SopClass, RejectResult, RejectSource, RejectReason } = dcmjsDimse.constants;

const dicomRaw = require('./dicomRaw');
const imageQueue = require('./imageQueue');
const pacsForwardService = require('./pacsForwardService');
const imagehubService = require('./imagehubService');

// รับเฉพาะภาพประเภท Storage มาตรฐาน
const STORAGE_SOP_CLASS_PREFIX = '1.2.840.10008.5.1.4.1.1.';

// ชื่อโปรแกรมที่เขียนไฟล์ ใส่ไว้ในส่วนหัวตามมาตรฐาน DICOM
const IMPLEMENTATION_CLASS_UID = '1.2.826.0.1.3680043.10.1490.1';
const IMPLEMENTATION_VERSION_NAME = 'XRAYWL_IMGSTORE';

let runningServer = null;
let runningPort = null;

// เรียกเมื่อมีภาพใหม่เข้าคิว ให้ฝั่งส่งต่อส่งทันที
let onImageQueued = () => {};
function setOnImageQueued(fn) {
  onImageQueued = typeof fn === 'function' ? fn : () => {};
}

// สร้างส่วน meta ของไฟล์ DICOM เอง เข้ารหัสแบบ Explicit VR Little Endian เสมอ

// ค่าที่ความยาวเป็นเลขคี่ต้องเติมให้เป็นเลขคู่
function padValue(str, vr) {
  const buf = Buffer.from(str || '', 'ascii');
  if (buf.length % 2 === 0) return buf;
  return Buffer.concat([buf, Buffer.from(vr === 'UI' ? [0x00] : [0x20])]);
}

function shortElement(element, vr, value) {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0002, 0);
  header.writeUInt16LE(element, 2);
  header.write(vr, 4, 'ascii');
  header.writeUInt16LE(value.length, 6);
  return Buffer.concat([header, value]);
}

function buildFileMetaHeader({ sopClassUid, sopInstanceUid, transferSyntaxUid, sourceAet }) {
  // ค่านี้ใช้ส่วนหัวแบบยาว
  const versionElement = Buffer.alloc(14);
  versionElement.writeUInt16LE(0x0002, 0);
  versionElement.writeUInt16LE(0x0001, 2);
  versionElement.write('OB', 4, 'ascii');
  versionElement.writeUInt32LE(2, 8);
  versionElement[12] = 0x00;
  versionElement[13] = 0x01;

  const elements = Buffer.concat([
    versionElement,
    shortElement(0x0002, 'UI', padValue(sopClassUid, 'UI')),
    shortElement(0x0003, 'UI', padValue(sopInstanceUid, 'UI')),
    shortElement(0x0010, 'UI', padValue(transferSyntaxUid, 'UI')),
    shortElement(0x0012, 'UI', padValue(IMPLEMENTATION_CLASS_UID, 'UI')),
    shortElement(0x0013, 'SH', padValue(IMPLEMENTATION_VERSION_NAME, 'SH')),
    ...(sourceAet ? [shortElement(0x0016, 'AE', padValue(sourceAet, 'AE'))] : []),
  ]);

  const groupLength = Buffer.alloc(12);
  groupLength.writeUInt16LE(0x0002, 0);
  groupLength.writeUInt16LE(0x0000, 2);
  groupLength.write('UL', 4, 'ascii');
  groupLength.writeUInt16LE(4, 6);
  groupLength.writeUInt32LE(elements.length, 8);

  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM', 'ascii'), groupLength, elements]);
}

// เขียนข้อมูลลงไฟล์ชั่วคราวทีละก้อนแบบรอให้เสร็จ เพื่อจับ error เองได้ถ้าดิสก์เต็ม
// และไฟล์ปิดแน่นอนก่อนย้าย เพราะ Windows ย้ายไฟล์ที่ยังเปิดอยู่ไม่ได้
class PartFileWritable extends Writable {
  constructor(tmpPath, metaHeader) {
    super();
    this.tmpPath = tmpPath;
    this.error = null;
    this.fd = null;
    try {
      this.fd = fs.openSync(tmpPath, 'w');
      fs.writeSync(this.fd, metaHeader);
    } catch (err) {
      this.fail(err);
    }
  }

  fail(err) {
    if (!this.error) this.error = err;
    this.closeFd();
  }

  closeFd() {
    if (this.fd === null) return;
    try { fs.closeSync(this.fd); } catch (e) { /* เพิกเฉย */ }
    this.fd = null;
  }

  _write(chunk, encoding, callback) {
    if (!this.error) {
      try {
        fs.writeSync(this.fd, chunk);
      } catch (err) {
        this.fail(err);
      }
    }
    callback(); // ไม่ส่ง error ต่อ เพราะไม่มีใครรอรับ โปรแกรมจะล่ม
  }

  _final(callback) {
    if (!this.error) {
      try {
        fs.fsyncSync(this.fd); // ให้แน่ใจว่าอยู่บนดิสก์จริงก่อนตอบสำเร็จกลับเครื่องเอกซเรย์
      } catch (err) {
        this.fail(err);
      }
    }
    this.closeFd();
    callback();
  }

  // ใช้ตอนการเชื่อมต่อขาดกลางทาง ปิดไฟล์และลบไฟล์ชั่วคราวทิ้ง
  abandon() {
    this.closeFd();
    try { fs.unlinkSync(this.tmpPath); } catch (e) { /* เพิกเฉย */ }
  }
}

// UID มีได้แค่ตัวเลขกับจุด กันชื่อไฟล์แปลกที่อาจเขียนออกนอกโฟลเดอร์
function safeUid(uid) {
  const cleaned = String(uid || '').replace(/[^0-9.]/g, '');
  return cleaned || `unknown-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

// อ่านข้อมูลผู้ป่วยจากส่วนต้นไฟล์ไว้แสดงในหน้าคิว ไม่ต้องโหลดทั้งไฟล์
const INFO_READ_BYTES = 256 * 1024;

// อ่านส่วนหัวและข้อมูลผู้ป่วย ถ้าไม่ใช่ไฟล์ DICOM จะโยน error
function readHeaderFromFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(INFO_READ_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, INFO_READ_BYTES, 0);
    const { meta, datasetBuffer } = dicomRaw.parseP10(buffer.slice(0, bytesRead));
    let info = {};
    try { info = dicomRaw.extractInfo(datasetBuffer, meta.transferSyntaxUid); } catch (err) { /* อ่านข้อมูลผู้ป่วยไม่ได้ก็แค่แสดงว่าง */ }
    return { meta, info };
  } finally {
    fs.closeSync(fd);
  }
}

// ย้ายไฟล์ที่เขียนครบแล้วเข้าคิวพร้อมสถานะรอส่ง ใช้ทั้งตอนรับจากเครื่องและตอนอัปโหลดเอง
function moveIntoQueue(tmpPath, meta) {
  const uid = safeUid(meta.sopInstanceUid);
  const finalPath = imageQueue.dicomPath(uid);
  let info = {};
  try { info = readHeaderFromFile(tmpPath).info; } catch (err) { /* อ่านข้อมูลผู้ป่วยไม่ได้ก็แค่แสดงว่าง */ }
  // ถ้าโฟลเดอร์คิวหายไปให้สร้างใหม่ ไม่ปฏิเสธภาพ
  fs.mkdirSync(imageQueue.getQueueDir(), { recursive: true });
  // ภาพเดิมส่งซ้ำจะเขียนทับไฟล์เดิม และต้องส่งต่อใหม่
  imageQueue.removeStatus(uid);
  fs.renameSync(tmpPath, finalPath);

  // เขียนสถานะไม่สำเร็จไม่เป็นไร ภาพที่ไม่มีสถานะถือว่ารอส่งอยู่แล้ว
  try {
    imageQueue.writeStatus(uid, {
      sopInstanceUid: meta.sopInstanceUid,
      sopClassUid: meta.sopClassUid,
      transferSyntaxUid: meta.transferSyntaxUid,
      callingAet: meta.callingAet,
      receivedAt: Date.now(),
      size: fs.statSync(finalPath).size,
      ...info,
      // ปลายทางที่ปิดอยู่ตอนรับภาพจะไม่ถูกส่ง แม้เปิดทีหลังก็ไม่ส่งย้อนหลัง
      pacs: imageQueue.newTargetStatus(pacsForwardService.getForwardingStatus().enabled ? 'pending' : 'off'),
      imagehub: imageQueue.newTargetStatus(imagehubService.getForwardingStatus().enabled ? 'pending' : 'off'),
    });
  } catch (err) {
    console.warn(`[Image Store] ---> เขียนไฟล์สถานะของ ${uid} ไม่สำเร็จ (ภาพยังอยู่ในคิวและจะถูกส่งตามปกติ): ${err.message}`);
  }
  return { uid, finalPath };
}

function finalizeStoredFile(writable) {
  if (writable.error) {
    writable.abandon();
    return { ok: false, error: writable.error };
  }
  try {
    const { finalPath } = moveIntoQueue(writable.tmpPath, {
      sopInstanceUid: writable.sopInstanceUid,
      sopClassUid: writable.sopClassUid,
      transferSyntaxUid: writable.transferSyntaxUid,
      callingAet: writable.callingAet,
    });
    return { ok: true, finalPath };
  } catch (err) {
    writable.abandon();
    return { ok: false, error: err };
  }
}

// ชื่อเครื่องต้นทางของภาพที่อัปโหลดเองจากหน้าเว็บ
const UPLOAD_SOURCE = 'UPLOAD';

// อัปโหลดเองจากหน้าเว็บ เขียนลงโฟลเดอร์ชั่วคราวก่อน ตรวจว่าเป็น DICOM แล้วค่อยย้ายเข้าคิว
// ไฟล์มีส่วนหัวครบอยู่แล้ว จึงเก็บตามต้นฉบับทุก byte
function acceptUpload(readable) {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(imageQueue.getTmpDir(), { recursive: true });
    } catch (err) {
      resolve({ ok: false, message: `สร้างโฟลเดอร์ tmp ไม่สำเร็จ: ${err.message}` });
      return;
    }
    const tmpPath = path.join(imageQueue.getTmpDir(), `upload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.part`);
    const out = fs.createWriteStream(tmpPath);
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      out.destroy();
      try { fs.unlinkSync(tmpPath); } catch (e) { /* ไม่มีไฟล์ */ }
      resolve({ ok: false, message });
    };
    readable.on('error', (err) => fail(`รับไฟล์ไม่ครบ: ${err.message}`));
    // ผู้ใช้ปิดหน้าเว็บหรือเน็ตหลุดก่อนส่งครบ
    readable.on('close', () => { if (readable.complete === false) fail('การอัปโหลดถูกยกเลิกกลางทาง'); });
    out.on('error', (err) => fail(`เขียนไฟล์ไม่สำเร็จ: ${err.message}`));
    out.on('close', () => {
      if (settled) return;
      let header;
      try {
        header = readHeaderFromFile(tmpPath);
      } catch (err) {
        fail('ไม่ใช่ไฟล์ DICOM (ต้องเป็นไฟล์ DICOM แบบ P10 ที่มีส่วนหัว DICM)');
        return;
      }
      if (!header.meta.sopInstanceUid) {
        fail('ไฟล์ DICOM ไม่มี SOP Instance UID');
        return;
      }
      try {
        const { uid } = moveIntoQueue(tmpPath, { ...header.meta, callingAet: UPLOAD_SOURCE });
        settled = true;
        console.log(`[Image Store] ---> รับภาพจากการอัปโหลดเอง เก็บลงคิวแล้ว: ${uid}.dcm`);
        onImageQueued();
        resolve({ ok: true, uid, patientId: header.info.patientId || '', modality: header.info.modality || '' });
      } catch (err) {
        fail(`ย้ายไฟล์เข้าคิวไม่สำเร็จ: ${err.message}`);
      }
    });
    readable.pipe(out);
  });
}

function createImageStoreScpClass(config) {
  const expectedAet = String(config.aet || '').trim();

  return class ImageStoreScp extends Scp {
    constructor(socket, opts) {
      super(socket, opts);
      this.activeStoreStream = null;
      this.callingAet = '';
      // การเชื่อมต่อขาดกลางทาง ลบไฟล์ชั่วคราวที่ค้างอยู่
      this.on('close', () => {
        if (this.activeStoreStream) {
          this.activeStoreStream.abandon();
          this.activeStoreStream = null;
        }
      });
    }

    associationRequested(association) {
      const callingAet = String(association.getCallingAeTitle() || '').trim();
      const calledAet = String(association.getCalledAeTitle() || '').trim();
      this.callingAet = callingAet;

      if (expectedAet && calledAet !== expectedAet) {
        console.warn(`[Image Store] ---> ปฏิเสธการเชื่อมต่อจาก ${callingAet}: เรียก AE Title "${calledAet}" ไม่ตรงกับที่ตั้งไว้ "${expectedAet}"`);
        this.sendAssociationReject(RejectResult.Permanent, RejectSource.ServiceUser, RejectReason.CalledAeNotRecognized);
        return;
      }

      const contexts = association.getPresentationContexts();
      contexts.forEach((c) => {
        const context = association.getPresentationContext(c.id);
        const abstractSyntax = context.getAbstractSyntaxUid();
        const transferSyntaxes = context.getTransferSyntaxUids();

        if (abstractSyntax === SopClass.Verification || abstractSyntax.startsWith(STORAGE_SOP_CLASS_PREFIX)) {
          // เก็บ byte ดิบโดยไม่ถอดรหัส จึงรับได้ทุกรูปแบบ เลือกแบบแรกที่เครื่องเสนอ
          // ภาพบีบอัดยังบีบอัดเหมือนต้นฉบับ ไม่เสียคุณภาพ
          if (transferSyntaxes.length > 0) {
            context.setResult(PresentationContextResult.Accept, transferSyntaxes[0]);
          } else {
            context.setResult(PresentationContextResult.RejectTransferSyntaxesNotSupported);
          }
        } else {
          context.setResult(PresentationContextResult.RejectAbstractSyntaxNotSupported);
        }
      });
      this.sendAssociationAccept();
    }

    cEchoRequest(request, callback) {
      const response = CEchoResponse.fromRequest(request);
      response.setStatus(Status.Success);
      callback(response);
    }

    // เมื่อข้อมูลภาพเริ่มเข้ามา ให้เขียนลงไฟล์ชั่วคราวแทนการเก็บใน RAM
    createStoreWritableStream(acceptedPresentationContext, request) {
      const sopInstanceUid = request.getAffectedSopInstanceUid();
      const tmpPath = path.join(imageQueue.getTmpDir(), `${safeUid(sopInstanceUid)}.${crypto.randomBytes(4).toString('hex')}.part`);
      const metaHeader = buildFileMetaHeader({
        sopClassUid: request.getAffectedSopClassUid(),
        sopInstanceUid,
        transferSyntaxUid: acceptedPresentationContext.getAcceptedTransferSyntaxUid(),
        sourceAet: this.callingAet,
      });
      const writable = new PartFileWritable(tmpPath, metaHeader);
      writable.sopInstanceUid = sopInstanceUid;
      writable.sopClassUid = request.getAffectedSopClassUid();
      writable.transferSyntaxUid = acceptedPresentationContext.getAcceptedTransferSyntaxUid();
      writable.callingAet = this.callingAet;
      this.activeStoreStream = writable;
      return writable;
    }

    // เมื่อรับครบแล้ว รอไฟล์ปิดและย้ายเข้าคิวก่อน แล้วค่อยตัดสินว่าจะตอบสำเร็จหรือไม่
    createDatasetFromStoreWritableStream(writable, acceptedPresentationContext, callback) {
      const done = () => {
        this.activeStoreStream = null;
        const dataset = new Dataset();
        dataset.storeResult = finalizeStoredFile(writable);
        callback(dataset);
      };
      if (writable.writableFinished) done();
      else writable.once('finish', done);
    }

    cStoreRequest(request, callback) {
      const response = CStoreResponse.fromRequest(request);
      const dataset = request.getDataset();
      const result = dataset && dataset.storeResult;

      if (result && result.ok) {
        console.log(`[Image Store] ---> รับภาพจาก ${this.callingAet || '-'} เก็บลงคิวแล้ว: ${path.basename(result.finalPath)}`);
        response.setStatus(Status.Success);
        onImageQueued();
      } else {
        const message = result && result.error ? result.error.message : 'ไม่ได้รับ dataset';
        console.error(`[Image Store] ---> เก็บภาพจาก ${this.callingAet || '-'} ลงดิสก์ไม่สำเร็จ (${request.getAffectedSopInstanceUid()}): ${message}`);
        // ตอบล้มเหลวให้เครื่องเอกซเรย์รู้ว่ายังไม่ได้เก็บ เครื่องจะได้ส่งซ้ำ ไม่ใช่ภาพหายเงียบ
        response.setStatus(Status.ProcessingFailure);
      }
      callback(response);
    }

    associationReleaseRequested() {
      this.sendAssociationReleaseResponse();
    }
  };
}

// ไฟล์ชั่วคราวที่ค้างจากรอบก่อนเป็นภาพที่ยังไม่เคยตอบสำเร็จ ลบได้ปลอดภัย
// เพราะเครื่องเอกซเรย์จะส่งซ้ำเอง
function cleanupTmpDir() {
  try {
    fs.readdirSync(imageQueue.getTmpDir())
      .filter((f) => f.endsWith('.part'))
      .forEach((f) => {
        try { fs.unlinkSync(path.join(imageQueue.getTmpDir(), f)); } catch (e) { /* เพิกเฉย */ }
      });
  } catch (err) {
    /* โฟลเดอร์ยังไม่มี */
  }
}

function stopImageStoreServer() {
  if (runningServer) {
    try {
      runningServer.close();
    } catch (err) {
      /* เพิกเฉย */
    }
  }
  runningServer = null;
  runningPort = null;
}

// เรียกทุกครั้งที่บันทึกการตั้งค่า หยุดของเดิมแล้วเริ่มใหม่ คืนข้อความ error ถ้าเริ่มไม่สำเร็จ
async function applyImageStoreSettings(config) {
  stopImageStoreServer();

  const cfg = config || {};
  // ตั้งโฟลเดอร์คิวเสมอแม้ปิดรับภาพ เพราะฝั่งส่งต่อยังต้องส่งภาพที่ค้างให้หมด
  imageQueue.setStorageDir(cfg.storageDir);

  if (!cfg.enabled || !cfg.port || String(cfg.port).trim() === '') {
    console.log('[Image Store] ---> ปิดการรับภาพ (C-STORE) ไว้ หรือยังไม่ได้ตั้งพอร์ต');
    return null;
  }

  try {
    imageQueue.ensureDirs();
  } catch (err) {
    const message = `สร้างโฟลเดอร์คิวภาพ ${imageQueue.getQueueDir()} ไม่สำเร็จ: ${err.message}`;
    console.error(`[Image Store] ---> ${message}`);
    return message;
  }
  cleanupTmpDir();

  const port = Number(cfg.port);
  const server = new Server(createImageStoreScpClass(cfg));

  return new Promise((resolve) => {
    let settled = false;

    server.on('networkError', (e) => {
      const code = e && e.code;
      const message = code === 'EADDRINUSE'
        ? `พอร์ต ${port} ถูกใช้งานอยู่แล้ว ไม่สามารถรับภาพได้`
        : `Network error พอร์ต ${port}: ${(e && e.message) || e}`;
      console.error(`[Image Store] ---> ${message}`);
      if (!settled) {
        settled = true;
        resolve(message);
      }
    });

    server.on('listening', () => {
      runningServer = server;
      runningPort = port;
      console.log(`[Image Store] ---> เริ่มรับภาพ (C-STORE) AE Title "${cfg.aet || '(ไม่ตรวจ)'}" ที่พอร์ต ---> ${port} เก็บที่ ${imageQueue.getQueueDir()}`);
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });

    server.listen(port);
  });
}

// สถานะคร่าวของฝั่งรับภาพ
function getStatus() {
  let queuedFiles = 0;
  try {
    queuedFiles = imageQueue.listUids().length;
  } catch (err) {
    /* โฟลเดอร์ยังไม่มี */
  }
  return {
    running: Boolean(runningServer),
    port: runningPort,
    queueDir: imageQueue.getQueueDir(),
    queuedFiles,
  };
}

module.exports = {
  applyImageStoreSettings,
  stopImageStoreServer,
  getStatus,
  setOnImageQueued,
  acceptUpload,
};
