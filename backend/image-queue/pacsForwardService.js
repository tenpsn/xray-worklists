// ส่งภาพจากคิวเข้า PACS ทีละไฟล์ ส่งไม่สำเร็จก็ลองใหม่โดยรอนานขึ้นเรื่อยๆ
// ส่ง byte ดิบจากไฟล์ตรงๆ ชื่อภาษาไทยไม่เพี้ยน และภาพบีบอัดไม่ต้องถอดรหัส

const fs = require('fs');
const dcmjsDimse = require('dcmjs-dimse');
const dicomRaw = require('./dicomRaw');
const imageQueue = require('./imageQueue');

const { Client, Dataset } = dcmjsDimse;
const { CStoreRequest, CEchoRequest } = dcmjsDimse.requests;
const { PresentationContext } = dcmjsDimse.association;

const SWEEP_INTERVAL_MS = 5000;
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 30 * 60 * 1000;
// กันคิวค้างตลอดไปถ้าการเชื่อมต่อไม่ยอมปิด
const SEND_HARD_TIMEOUT_MS = 10 * 60 * 1000;

// สถานะตอบกลับที่ถือว่าเก็บสำเร็จ รวมถึงแบบเตือนด้วย
const STORE_OK_STATUSES = new Set([0x0000, 0xb000, 0xb006, 0xb007]);

const CONNECT_OPTIONS = { connectTimeout: 10000, associationTimeout: 30000, pduTimeout: 60000 };

let config = { enabled: false, aet: '', host: '', port: '', callingAet: '' };
let sweepTimer = null;
let sweeping = false;
let kickPending = false;
let retryAllNow = false;

// สถานะของ PACS ทั้งตัว ไว้แสดงในหน้าคิว
const health = {
  pausedUntil: 0,
  consecutiveFailures: 0,
  lastError: '',
  lastSuccessAt: null,
  currentUid: null,
};

function isConfigured(cfg = config) {
  return Boolean(cfg.aet && cfg.host && cfg.port);
}

// ตัดส่วนนำหน้าของข้อความ error ออกให้อ่านง่ายในหน้าเว็บ
function networkErrorText(err) {
  return String((err && err.message) || err).replace(/^.*?->\s*/, '');
}

// แปลงเหตุผลที่ PACS ปฏิเสธการเชื่อมต่อ เป็นข้อความบอกว่าต้องแก้อะไร
function rejectText(reject) {
  const reason = reject && reject.reason;
  if (reason === 3) return 'PACS ไม่รู้จัก AE Title ของระบบนี้ - ต้องลงทะเบียน AE Title ของระบบนี้ไว้ที่ PACS ก่อน';
  if (reason === 7) return 'AE Title ของ PACS ไม่ถูกต้อง - ตรวจช่อง "AE Title ของ PACS"';
  return `PACS ปฏิเสธการเชื่อมต่อ (reason ${reason}) ตรวจ AE Title ของ PACS และ AE Title ของระบบนี้ว่าลงทะเบียนไว้ที่ PACS แล้ว`;
}

function backoffMs(failures) {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
}

// ส่งภาพหนึ่งไฟล์ แยกบอกว่าปัญหาอยู่ที่ PACS ทั้งตัว หรือเฉพาะภาพนี้
function sendFile(filePath, cfg) {
  return new Promise((resolve) => {
    let meta;
    let datasetBuffer;
    try {
      ({ meta, datasetBuffer } = dicomRaw.parseP10(fs.readFileSync(filePath)));
    } catch (err) {
      resolve({ ok: false, scope: 'file', message: `อ่านไฟล์ภาพไม่สำเร็จ: ${err.message}` });
      return;
    }

    // ข้อมูลภาพจำลองที่ส่ง byte ดิบจากไฟล์ขึ้นสายตรงๆ
    const raw = { transferSyntaxUid: meta.transferSyntaxUid, bytes: datasetBuffer };
    const rawDataset = {
      getTransferSyntaxUid: () => raw.transferSyntaxUid,
      getDenaturalizedDataset: () => raw.bytes,
    };

    // ตั้ง UID เอง ไม่ให้ไลบรารีอ่านไฟล์เพราะชื่อภาษาไทยจะเพี้ยน
    const request = new CStoreRequest(new Dataset());
    request.setAffectedSopClassUid(meta.sopClassUid);
    request.setAffectedSopInstanceUid(meta.sopInstanceUid);
    request.setDataset(rawDataset);

    let settled = false;
    let responseStatus = null;
    let associationAccepted = false;
    let fileProblem = '';
    let pacsProblem = '';

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolve(result);
    };
    const hardTimer = setTimeout(() => {
      finish({ ok: false, scope: 'pacs', message: 'ส่งนานเกินกำหนด ไม่ได้รับคำตอบจาก PACS' });
    }, SEND_HARD_TIMEOUT_MS);

    const client = new Client();
    client.addRequest(request);
    // เสนอรูปแบบที่ตรงกับไฟล์แยกไว้อีกชุด
    // เพราะถ้า PACS เลือกรูปแบบที่ไม่ตรงกับไฟล์ บางกรณีจะแปลงไม่ได้
    if (meta.transferSyntaxUid === dicomRaw.TS_IMPLICIT_LE || meta.transferSyntaxUid === dicomRaw.TS_EXPLICIT_LE) {
      client.addAdditionalPresentationContext(new PresentationContext(0, meta.sopClassUid, meta.transferSyntaxUid), true);
    }

    // ก่อนเริ่มส่ง ดูว่า PACS รับรูปแบบไหน ถ้าไม่ตรงกับไฟล์ให้แปลงส่วนหัวเอง
    // ภาพบีบอัดที่ PACS ไม่รับจะส่งไม่ได้ เพราะไม่ถอดรหัสภาพ
    client.on('associationAccepted', (association) => {
      associationAccepted = true;
      const context = association.getAcceptedPresentationContextFromRequest(request);
      if (!context) {
        fileProblem = `PACS ไม่รับภาพประเภทนี้ (SOP Class ${meta.sopClassUid})`;
        return;
      }
      const acceptedTs = context.getAcceptedTransferSyntaxUid();
      if (acceptedTs === raw.transferSyntaxUid) return;

      if (raw.transferSyntaxUid === dicomRaw.TS_EXPLICIT_LE && acceptedTs === dicomRaw.TS_IMPLICIT_LE) {
        try {
          raw.bytes = dicomRaw.explicitToImplicit(raw.bytes);
          raw.transferSyntaxUid = dicomRaw.TS_IMPLICIT_LE;
        } catch (err) {
          fileProblem = `แปลงภาพเป็น Implicit VR ให้ PACS ไม่สำเร็จ: ${err.message}`;
        }
        return;
      }
      fileProblem = `PACS ไม่รับ transfer syntax ของภาพนี้ (${raw.transferSyntaxUid}) ต้องการ ${acceptedTs}`;
    });

    request.on('response', (response) => {
      responseStatus = response.getStatus();
    });

    client.on('associationRejected', (reject) => {
      pacsProblem = rejectText(reject);
    });

    client.on('networkError', (err) => {
      pacsProblem = `เชื่อมต่อ PACS ไม่ได้: ${networkErrorText(err)}`;
    });

    client.on('closed', () => {
      if (responseStatus !== null) {
        if (STORE_OK_STATUSES.has(responseStatus)) {
          finish({ ok: true });
        } else {
          finish({ ok: false, scope: 'file', message: `PACS ตอบสถานะล้มเหลว 0x${responseStatus.toString(16).padStart(4, '0')}` });
        }
        return;
      }
      if (fileProblem) {
        finish({ ok: false, scope: 'file', message: fileProblem });
        return;
      }
      if (pacsProblem) {
        finish({ ok: false, scope: 'pacs', message: pacsProblem });
        return;
      }
      finish({
        ok: false,
        scope: 'pacs',
        message: associationAccepted ? 'PACS ปิดการเชื่อมต่อก่อนตอบผลการรับภาพ' : 'การเชื่อมต่อ PACS ถูกปิดโดยไม่มีคำตอบ',
      });
    });

    try {
      client.send(cfg.host, Number(cfg.port), cfg.callingAet, cfg.aet, CONNECT_OPTIONS);
    } catch (err) {
      finish({ ok: false, scope: 'pacs', message: `เริ่มเชื่อมต่อ PACS ไม่สำเร็จ: ${err.message}` });
    }
  });
}

// ทดสอบการเชื่อมต่อ PACS โดยไม่ส่งภาพ ใช้กับปุ่มในหน้าตั้งค่า
function echo(cfg) {
  return new Promise((resolve) => {
    if (!isConfigured(cfg)) {
      resolve({ ok: false, message: 'กรอก AE Title / Host / Port ของ PACS ให้ครบก่อน' });
      return;
    }
    let status = null;
    let problem = '';
    const request = new CEchoRequest();
    request.on('response', (response) => { status = response.getStatus(); });
    const client = new Client();
    client.addRequest(request);
    client.on('associationRejected', (reject) => {
      problem = rejectText(reject);
    });
    client.on('networkError', (err) => { problem = `เชื่อมต่อไม่ได้: ${networkErrorText(err)}`; });
    client.on('closed', () => {
      if (status === 0x0000) resolve({ ok: true, message: 'เชื่อมต่อ PACS สำเร็จ (C-ECHO)' });
      else resolve({ ok: false, message: problem || (status !== null ? `PACS ตอบสถานะ 0x${status.toString(16)}` : 'ไม่ได้รับคำตอบจาก PACS') });
    });
    try {
      client.send(cfg.host, Number(cfg.port), cfg.callingAet, cfg.aet, CONNECT_OPTIONS);
    } catch (err) {
      resolve({ ok: false, message: `เริ่มเชื่อมต่อไม่สำเร็จ: ${err.message}` });
    }
  });
}

// อัปเดตเฉพาะสถานะ PACS ของไฟล์ ไม่ยุ่งกับสถานะ ImageHub
function updatePacsStatus(uid, receivedAtWhenPicked, mutate) {
  try {
    imageQueue.updateTarget(uid, receivedAtWhenPicked, 'pacs', mutate);
  } catch (err) {
    console.error(`[PACS Forward] ---> บันทึกสถานะของ ${uid} ไม่สำเร็จ: ${err.message}`);
  }
}

async function sweep() {
  if (sweeping) {
    kickPending = true;
    return;
  }
  sweeping = true;
  try {
    do {
      kickPending = false;
      await sweepOnce();
    } while (kickPending);
  } catch (err) {
    console.error('[PACS Forward] ---> เกิดข้อผิดพลาดระหว่างส่งคิว:', err);
  } finally {
    sweeping = false;
    health.currentUid = null;
  }
}

async function sweepOnce() {
  if (!config.enabled || !isConfigured()) return;
  if (Date.now() < health.pausedUntil) return;

  const ignoreBackoff = retryAllNow;
  retryAllNow = false;
  const now = Date.now();
  const due = imageQueue.listRecords()
    .filter((r) => (r.pacs.status === 'pending' || r.pacs.status === 'failed') && (ignoreBackoff || (r.pacs.nextAttemptAt || 0) <= now))
    .sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0));

  for (const record of due) {
    // ถ้าปิดการส่งหรือเปลี่ยนค่าระหว่างรอบ ให้หยุดทันที
    if (!config.enabled || !isConfigured()) return;
    const cfg = { ...config };
    const filePath = imageQueue.dicomPath(record.uid);
    if (!fs.existsSync(filePath)) continue;

    health.currentUid = record.uid;
    const result = await sendFile(filePath, cfg);
    const attemptAt = Date.now();

    if (result.ok) {
      updatePacsStatus(record.uid, record.receivedAt, (p) => ({
        ...p, status: 'success', attempts: (p.attempts || 0) + 1, fileFailures: 0, lastAttemptAt: attemptAt, sentAt: attemptAt, nextAttemptAt: 0, lastError: '',
      }));
      health.consecutiveFailures = 0;
      health.pausedUntil = 0;
      health.lastError = '';
      health.lastSuccessAt = attemptAt;
      console.log(`[PACS Forward] ---> ส่งเข้า PACS ${cfg.aet} สำเร็จ: ${record.uid}${record.patientId ? ` (HN ${record.patientId})` : ''}`);
      continue;
    }

    if (result.scope === 'pacs') {
      // PACS ล่มหรือต่อไม่ติด หยุดทั้งคิวแล้วลองใหม่ทีเดียว
      // ไม่ไล่ส่งทุกไฟล์ให้ล้มเหลวพร้อมกัน ภาพรอในคิวจน PACS กลับมา
      health.consecutiveFailures += 1;
      const wait = backoffMs(health.consecutiveFailures);
      health.pausedUntil = attemptAt + wait;
      health.lastError = result.message;
      updatePacsStatus(record.uid, record.receivedAt, (p) => ({
        ...p, status: 'failed', attempts: (p.attempts || 0) + 1, lastAttemptAt: attemptAt, nextAttemptAt: 0, lastError: result.message,
      }));
      console.warn(`[PACS Forward] ---> ${result.message} - หยุดส่งทั้งคิว ${Math.round(wait / 1000)} วินาทีแล้วลองใหม่ (ภาพยังอยู่ในคิว)`);
      return;
    }

    // ปัญหาเฉพาะภาพนี้ รอเฉพาะไฟล์นี้แล้วส่งไฟล์ถัดไปต่อ
    let gaveUp = false;
    updatePacsStatus(record.uid, record.receivedAt, (p) => {
      const next = imageQueue.afterFileFailure(p, attemptAt, result.message, backoffMs);
      gaveUp = next.status === 'gaveup';
      return next;
    });
    console.warn(`[PACS Forward] ---> ส่งภาพ ${record.uid} ไม่สำเร็จ: ${result.message} ${gaveUp ? `(ล้มเหลว ${imageQueue.MAX_FILE_FAILURES} ครั้งติดกัน เลิกลอง - จะย้ายไปโฟลเดอร์ failed)` : '(จะลองใหม่ภายหลัง)'}`);
  }
}

// มีภาพใหม่เข้าคิว ส่งต่อทันที
function kick() {
  setImmediate(() => { sweep(); });
}

// เรียกทุกครั้งที่บันทึกการตั้งค่า
function applyPacsSettings(pacsCfg, callingAet) {
  const cfg = pacsCfg || {};
  config = {
    enabled: Boolean(cfg.enabled),
    aet: String(cfg.aet || '').trim(),
    host: String(cfg.host || '').trim(),
    port: String(cfg.port || '').trim(),
    callingAet: String(callingAet || '').trim() || 'XRAYWL_STORE',
  };
  // ตั้งค่าใหม่แล้วลองส่งทันที ไม่ต้องรอรอบเดิมที่อาจนานถึง 30 นาที
  health.pausedUntil = 0;
  health.consecutiveFailures = 0;
  health.lastError = '';
  retryAllNow = true;

  if (!sweepTimer) {
    sweepTimer = setInterval(() => { sweep(); }, SWEEP_INTERVAL_MS);
  }
  if (config.enabled && isConfigured()) {
    console.log(`[PACS Forward] ---> เปิดส่งต่อภาพเข้า PACS ${config.aet}@${config.host}:${config.port} (AE Title ระบบนี้: ${config.callingAet})`);
    kick();
  } else {
    console.log('[PACS Forward] ---> ปิดการส่งต่อภาพเข้า PACS ไว้ ภาพที่เข้ามาระหว่างนี้จะไม่ถูกส่งเข้า PACS (สถานะ "ไม่ได้ส่ง (ปิดอยู่)")');
  }
}

function stop() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

// สถานะของ PACS ทั้งตัว สำหรับหน้าคิวส่งภาพ
function getForwardingStatus() {
  return {
    enabled: config.enabled,
    configured: isConfigured(),
    aet: config.aet,
    host: config.host,
    port: config.port,
    pausedUntil: health.pausedUntil > Date.now() ? health.pausedUntil : null,
    consecutiveFailures: health.consecutiveFailures,
    lastError: health.lastError,
    lastSuccessAt: health.lastSuccessAt,
    sending: health.currentUid,
  };
}

module.exports = {
  applyPacsSettings,
  kick,
  stop,
  echo,
  getForwardingStatus,
  sendFile,
};
