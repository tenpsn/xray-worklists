// ส่งภาพจากคิวขึ้น MOPH ImageHub สถานะแยกจาก PACS ฝั่งใดล้มเหลวไม่กระทบอีกฝั่ง
// token หมดอายุหรือ ImageHub ล่ม จะหยุดทั้งคิวรอไว้ ภาพไม่หาย

const fs = require('fs');
const path = require('path');
const db = require('../db');
const imageQueue = require('./imageQueue');
const imagehubAuth = require('./imagehubAuth');

const SWEEP_INTERVAL_MS = 5000;
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 30 * 60 * 1000;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000; // ภาพใหญ่ส่งช้า แต่ต้องมีเวลาจำกัดไม่ให้คิวค้าง
const HIS_LOOKUP_TIMEOUT_MS = 10000;
const CID_CACHE_MS = 10 * 60 * 1000; // หนึ่งเคสมีหลายภาพ HN เดียวกัน ไม่ต้องค้นซ้ำทุกภาพ

let config = { enabled: false, imagehubUrl: '', hoscode: '', modalities: [] };
let hisSystem = '';
let sweepTimer = null;
let sweeping = false;
let kickPending = false;
let retryAllNow = false;
const cidCache = new Map();

const health = {
  pausedUntil: 0,
  consecutiveFailures: 0,
  lastError: '',
  lastSuccessAt: null,
  currentUid: null,
};

function isConfigured(cfg = config) {
  return Boolean(cfg.imagehubUrl && cfg.hoscode);
}

function backoffMs(failures) {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
}

// แปลง Modality และส่วนของร่างกายเป็นค่าที่ ImageHub ต้องการ

const VALID_SCAN_TYPES = new Set([
  'chest', 'pa_upright', 'supine', 'lateral_decubitus', 'lateral_view', 'nipple_marker',
  'abdomen', 'abdomen_upright', 'abdomen_supine', 'bone', 'finger', 'hand', 'wrist',
  'forearm', 'elbow', 'arm', 'shoulder', 'clavicle', 'toe', 'foot', 'ankle', 'leg',
  'knee', 'thigh', 'hip', 'pelvis', 'skull_and_orbits', 'nasal_bone', 'sinus', 'spine',
  'neck_soft_tissue', 'lordotic_view', 'ap_upright', 'abdomen_kub', 'bone_tmj', 'brain',
  'vascular', 'mri_brain', 'ct_spinal_cord', 'mri_spinal_cord', 'aorta', 'appendix',
  'adrenal_gland', 'whole_abdomen', 'upper_abdomen', 'lower_abdomen', 'tm_join', 'neck',
  'ctv_lower', 'mri_chest', 'mri_liver', 'mri_brachail_plexus', 'ct_kub', 'mammogram',
  'oct', 'fundus_photo',
]);

function mapModalityToType(modality) {
  if (!modality) return 'xray';
  const mod = modality.toUpperCase().trim();
  if (mod === 'MR' || mod === 'CT') return 'ct_scan';
  if (mod === 'MG') return 'mammogram';
  if (mod === 'OP' || mod === 'OCT') return 'ophthalmic_photo';
  return 'xray';
}

function mapBodyToScanType(body, type) {
  if (!body) return 'chest';
  const normalized = body.toLowerCase().trim().replace(/[\s_-]+/g, '_');

  if (VALID_SCAN_TYPES.has(normalized)) return normalized;

  if (['thorax', 'lung', 'heart', 'ribs', 'thoracic'].includes(normalized)) return 'chest';
  if (normalized === 'breast') return type === 'mammogram' ? 'mammogram' : 'chest';
  if (['head', 'skull', 'orbit', 'face', 'facial', 'jaw', 'mastoid'].includes(normalized)) {
    return type === 'ct_scan' ? 'brain' : 'skull_and_orbits';
  }
  if (['c_spine', 'cspine', 't_spine', 'tspine', 'l_spine', 'lspine', 's_spine', 'sspine', 'coccyx', 'vertebrae', 'spinal', 'cervical'].includes(normalized)) {
    return 'spine';
  }
  if (['lower_limb', 'tibia', 'fibula', 'heel', 'knee_leg', 'ankle_foot'].includes(normalized)) return 'leg';
  if (['upper_limb', 'humerus', 'radius', 'ulna', 'shoulder_arm'].includes(normalized)) return 'arm';
  if (normalized === 'femur') return 'thigh';
  if (['stomach', 'liver', 'gallbladder', 'pancreas', 'spleen', 'kidney'].includes(normalized)) return 'abdomen';
  if (normalized === 'pelvic' || normalized === 'bladder') return 'pelvis';

  if (normalized.includes('pa_upright')) return 'pa_upright';
  if (normalized.includes('supine')) return normalized.includes('abdomen') ? 'abdomen_supine' : 'supine';
  if (normalized.includes('decubitus')) return 'lateral_decubitus';
  if (normalized.includes('lateral')) return 'lateral_view';
  if (normalized.includes('nipple')) return 'nipple_marker';
  if (normalized.includes('lordotic')) return 'lordotic_view';
  if (normalized.includes('ap_upright')) return 'ap_upright';
  if (normalized.includes('kub')) return type === 'ct_scan' ? 'ct_kub' : 'abdomen_kub';
  if (normalized.includes('tmj') || normalized.includes('tm_joint') || normalized.includes('tm_join')) {
    return type === 'ct_scan' ? 'tm_join' : 'bone_tmj';
  }
  if (normalized.includes('nasal')) return 'nasal_bone';
  if (normalized.includes('sinus')) return 'sinus';
  if (normalized.includes('neck')) {
    return normalized.includes('soft_tissue') || normalized.includes('softtissue') ? 'neck_soft_tissue' : 'neck';
  }
  if (normalized.includes('vascular')) return 'vascular';
  if (normalized.includes('mri_brain')) return 'mri_brain';
  if (normalized.includes('spinal_cord')) return normalized.includes('mri') ? 'mri_spinal_cord' : 'ct_spinal_cord';
  if (normalized.includes('aorta')) return 'aorta';
  if (normalized.includes('appendix')) return 'appendix';
  if (normalized.includes('adrenal')) return 'adrenal_gland';
  if (normalized.includes('whole_abdomen')) return 'whole_abdomen';
  if (normalized.includes('upper_abdomen')) return 'upper_abdomen';
  if (normalized.includes('lower_abdomen')) return 'lower_abdomen';
  if (normalized.includes('mri_chest')) return 'mri_chest';
  if (normalized.includes('mri_liver')) return 'mri_liver';
  if (normalized.includes('brachial') || normalized.includes('brachail')) return 'mri_brachail_plexus';
  if (normalized.includes('oct')) return 'oct';
  if (normalized.includes('fundus')) return 'fundus_photo';

  return normalized;
}

function buildUploadParams(modality, bodyPart) {
  const type = mapModalityToType(modality);
  const scanType = mapBodyToScanType(bodyPart, type);
  let dimension = '2D';
  if (type === 'ct_scan' || type === 'mammogram') dimension = '3D';
  else if (type === 'ophthalmic_photo' && scanType === 'oct') dimension = '3D';
  return { type, scanType, dimension };
}

// หาเลข CID จาก HN ในฐานข้อมูล HIS

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} ใช้เวลานานเกิน ${ms / 1000} วินาที`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function cleanCid(value) {
  return value && String(value).trim() ? String(value).trim() : '';
}

// ติดต่อ HIS ไม่ได้ให้รอแล้วลองใหม่ ไม่ส่ง HN แทน เพราะภาพจะขึ้นระบบด้วยเลขผิด
// ส่ง HN แทนเฉพาะเมื่อ HIS ตอบแล้วว่าไม่พบผู้ป่วยหรือไม่มี CID
async function resolveCid(hn) {
  const patientId = String(hn || '').trim();
  if (!patientId) return { ok: false, permanent: true, message: 'ภาพไม่มี Patient ID (HN) ส่งขึ้น ImageHub ไม่ได้' };

  // ค้น CID ได้เฉพาะ HOSxP ระบบ HIS แบบอื่นส่ง HN แทน
  if (hisSystem !== 'hosxp') return { ok: true, cid: patientId, source: 'hn' };

  const cached = cidCache.get(patientId);
  if (cached && Date.now() - cached.at < CID_CACHE_MS) return { ok: true, cid: cached.cid, source: cached.source };

  let result;
  try {
    let rows = (await withTimeout(db.query('SELECT cid FROM patient WHERE hn = $1', [patientId]), HIS_LOOKUP_TIMEOUT_MS, 'ค้นหา CID')).rows;
    if (rows.length === 0) {
      // บาง รพ เก็บ HN แบบเติมศูนย์ข้างหน้า ยอมรับเฉพาะเมื่อเจอคนเดียว
      // ห้ามเดาเอาแถวแรก เพราะอาจไปเจอผู้ป่วยคนอื่น
      rows = (await withTimeout(db.query('SELECT cid FROM patient WHERE hn LIKE $1', [`%${patientId}`]), HIS_LOOKUP_TIMEOUT_MS, 'ค้นหา CID')).rows;
      if (rows.length > 1) rows = [];
    }
    const cid = rows.length === 1 ? cleanCid(rows[0].cid) : '';
    result = cid ? { ok: true, cid, source: 'his' } : { ok: true, cid: patientId, source: 'hn' };
  } catch (err) {
    return { ok: false, message: `ค้นหา CID จากฐานข้อมูล HIS ไม่สำเร็จ (จะลองใหม่): ${err.message}` };
  }
  cidCache.set(patientId, { ...result, at: Date.now() });
  return result;
}

// อัปโหลด

// อัปโหลดหนึ่งภาพ แยกบอกว่าปัญหาอยู่ที่ token หรือ ImageHub หรือเฉพาะภาพนี้
async function uploadFile(filePath, cfg, token, params) {
  const url = `${cfg.imagehubUrl.replace(/\/+$/, '')}/ct/v1/import/dicom?provider_hcode=${encodeURIComponent(cfg.hoscode)}`;
  const form = new FormData();
  // อ่านไฟล์ตอนส่งจริง ไม่โหลดภาพทั้งไฟล์ไว้ใน RAM
  const blob = await fs.openAsBlob(filePath, { type: 'application/octet-stream' });
  form.append('files', blob, path.basename(filePath));
  form.append('type', params.type);
  form.append('scan_type', params.scanType);
  form.append('dimension', params.dimension);
  form.append('file_type', 'dcm');
  form.append('cid', params.cid);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `ImageHub ไม่ตอบภายใน ${UPLOAD_TIMEOUT_MS / 1000} วินาที` : `เชื่อมต่อ ImageHub ไม่ได้: ${(err.cause && err.cause.message) || err.message}`;
    return { ok: false, scope: 'service', message: reason };
  }

  const text = (await res.text()).slice(0, 500);
  if (res.ok) return { ok: true, response: text };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, scope: 'token', message: `ImageHub ไม่รับ token (HTTP ${res.status}) ต้องเข้าสู่ระบบ MOPH ใหม่` };
  }
  if (res.status >= 500 || res.status === 429) {
    return { ok: false, scope: 'service', message: `ImageHub ตอบ HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: false, scope: 'file', message: `ImageHub ไม่รับภาพนี้ (HTTP ${res.status}): ${text.slice(0, 200)}` };
}

// คิว

function isModalityAllowed(modality) {
  const allowed = (config.modalities || []).map((m) => String(m).trim().toUpperCase()).filter(Boolean);
  if (allowed.length === 0) return true; // ไม่ได้ระบุตัวกรองให้ส่งทั้งหมด
  return allowed.includes(String(modality || '').trim().toUpperCase());
}

function updateStatus(uid, receivedAt, mutate) {
  try {
    imageQueue.updateTarget(uid, receivedAt, 'imagehub', mutate);
  } catch (err) {
    console.error(`[ImageHub] ---> บันทึกสถานะของ ${uid} ไม่สำเร็จ: ${err.message}`);
  }
}

function pauseAll(message, now) {
  health.consecutiveFailures += 1;
  const wait = backoffMs(health.consecutiveFailures);
  health.pausedUntil = now + wait;
  health.lastError = message;
  return wait;
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
    console.error('[ImageHub] ---> เกิดข้อผิดพลาดระหว่างส่งคิว:', err);
  } finally {
    sweeping = false;
    health.currentUid = null;
  }
}

async function sweepOnce() {
  if (!config.enabled || !isConfigured()) return;
  // ไม่มี token ก็ไม่แตะคิวเลย ภาพรออยู่ครบ หน้าคิวจะเตือนให้เข้าสู่ระบบ MOPH
  if (!imagehubAuth.hasValidToken()) return;
  if (Date.now() < health.pausedUntil) return;

  const ignoreBackoff = retryAllNow;
  retryAllNow = false;
  const now = Date.now();
  const records = imageQueue.listRecords();

  // ภาพที่ Modality ไม่อยู่ในตัวกรองไม่ต้องส่ง ภาพที่ตัวกรองเปิดให้แล้วกลับมารอส่ง
  records.forEach((r) => {
    const allowed = isModalityAllowed(r.modality);
    if (!allowed && (r.imagehub.status === 'pending' || r.imagehub.status === 'failed')) {
      updateStatus(r.uid, r.receivedAt, (s) => ({ ...s, status: 'skipped', nextAttemptAt: 0, lastError: `Modality ${r.modality || '(ไม่ระบุ)'} ไม่อยู่ในรายการที่ส่งขึ้น ImageHub` }));
      r.imagehub.status = 'skipped';
    } else if (allowed && r.imagehub.status === 'skipped') {
      updateStatus(r.uid, r.receivedAt, (s) => ({ ...s, status: 'pending', lastError: '' }));
      r.imagehub.status = 'pending';
    }
  });

  const due = records
    .filter((r) => (r.imagehub.status === 'pending' || r.imagehub.status === 'failed')
      && (ignoreBackoff || (r.imagehub.nextAttemptAt || 0) <= now))
    .sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0));

  for (const record of due) {
    if (!config.enabled || !isConfigured() || !imagehubAuth.hasValidToken()) return;
    const cfg = { ...config };
    const filePath = imageQueue.dicomPath(record.uid);
    if (!fs.existsSync(filePath)) continue;
    health.currentUid = record.uid;
    const attemptAt = Date.now();

    const cidResult = await resolveCid(record.patientId);
    if (!cidResult.ok) {
      if (cidResult.permanent) {
        // ไม่มี HN ในภาพ ลองใหม่ก็ไม่ต่าง นับเป็นล้มเหลวเฉพาะภาพ
        updateStatus(record.uid, record.receivedAt, (s) => imageQueue.afterFileFailure(s, attemptAt, cidResult.message, () => RETRY_MAX_MS));
        continue;
      }
      // HIS ล่มกระทบทุกภาพ หยุดทั้งคิว ไม่ส่ง HN แทน CID
      const wait = pauseAll(cidResult.message, attemptAt);
      console.warn(`[ImageHub] ---> ${cidResult.message} - หยุดส่งทั้งคิว ${Math.round(wait / 1000)} วินาที`);
      return;
    }

    const params = { ...buildUploadParams(record.modality, record.bodyPartExamined), cid: cidResult.cid };
    const result = await uploadFile(filePath, cfg, imagehubAuth.getToken(), params);
    const doneAt = Date.now();
    const sent = { cid: params.cid, cidSource: cidResult.source, type: params.type, scanType: params.scanType, dimension: params.dimension };

    if (result.ok) {
      updateStatus(record.uid, record.receivedAt, (s) => ({
        ...s, ...sent, status: 'success', attempts: (s.attempts || 0) + 1, fileFailures: 0, lastAttemptAt: doneAt, sentAt: doneAt, nextAttemptAt: 0, lastError: '', response: result.response,
      }));
      health.consecutiveFailures = 0;
      health.pausedUntil = 0;
      health.lastError = '';
      health.lastSuccessAt = doneAt;
      console.log(`[ImageHub] ---> ส่งขึ้น ImageHub สำเร็จ: ${record.uid} (HN ${record.patientId}, ${cidResult.source === 'his' ? 'CID จาก HIS' : 'ส่ง HN แทน CID'}, ${params.type}/${params.scanType})`);
      continue;
    }

    // ปัญหาเฉพาะภาพนับครั้งที่ล้มเหลว ส่วน token หรือ ImageHub ล่มไม่นับ เพราะภาพไม่ได้ผิด
    let gaveUp = false;
    updateStatus(record.uid, record.receivedAt, (s) => {
      if (result.scope === 'file') {
        const next = imageQueue.afterFileFailure({ ...s, ...sent }, doneAt, result.message, backoffMs);
        gaveUp = next.status === 'gaveup';
        return next;
      }
      return { ...s, ...sent, status: 'failed', attempts: (s.attempts || 0) + 1, lastAttemptAt: doneAt, nextAttemptAt: 0, lastError: result.message };
    });

    if (result.scope === 'token') {
      imagehubAuth.invalidateToken(result.message);
      health.lastError = result.message;
      console.warn(`[ImageHub] ---> ${result.message} - หยุดส่งจนกว่าจะเข้าสู่ระบบ MOPH ใหม่ (ภาพยังอยู่ในคิว)`);
      return;
    }
    if (result.scope === 'service') {
      const wait = pauseAll(result.message, doneAt);
      console.warn(`[ImageHub] ---> ${result.message} - หยุดส่งทั้งคิว ${Math.round(wait / 1000)} วินาที (ภาพยังอยู่ในคิว)`);
      return;
    }
    console.warn(`[ImageHub] ---> ส่งภาพ ${record.uid} ไม่สำเร็จ: ${result.message} ${gaveUp ? `(ล้มเหลว ${imageQueue.MAX_FILE_FAILURES} ครั้งติดกัน เลิกลอง - จะย้ายไปโฟลเดอร์ failed)` : '(จะลองใหม่ภายหลัง)'}`);
  }
}

function kick() {
  setImmediate(() => { sweep(); });
}

// เรียกทุกครั้งที่บันทึกการตั้งค่า ใช้ HIS เดิมของระบบนี้หา CID
function applyImagehubSettings(imagehubCfg, his) {
  const cfg = imagehubCfg || {};
  config = {
    enabled: Boolean(cfg.enabled),
    imagehubUrl: String(cfg.imagehubUrl || '').trim(),
    hoscode: String(cfg.hoscode || '').trim(),
    modalities: Array.isArray(cfg.modalities) ? cfg.modalities : [],
  };
  hisSystem = (his && his.hisSystem) || '';
  cidCache.clear();
  health.pausedUntil = 0;
  health.consecutiveFailures = 0;
  health.lastError = '';
  retryAllNow = true;

  if (!sweepTimer) sweepTimer = setInterval(() => { sweep(); }, SWEEP_INTERVAL_MS);
  if (config.enabled && isConfigured()) {
    console.log(`[ImageHub] ---> เปิดส่งขึ้น ImageHub ${config.imagehubUrl} (hcode ${config.hoscode}, Modality: ${config.modalities.join(', ') || 'ทั้งหมด'})`);
    kick();
  } else {
    console.log('[ImageHub] ---> ปิดการส่งขึ้น ImageHub ไว้ ภาพที่เข้ามาระหว่างนี้จะไม่ถูกส่งขึ้น ImageHub (สถานะ "ไม่ได้ส่ง (ปิดอยู่)")');
  }
}

// เข้าสู่ระบบ MOPH ใหม่แล้ว ลองส่งภาพที่ค้างทันที
function onTokenRenewed() {
  health.pausedUntil = 0;
  health.consecutiveFailures = 0;
  health.lastError = '';
  retryAllNow = true;
  kick();
}

function stop() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

function getForwardingStatus() {
  return {
    enabled: config.enabled,
    configured: isConfigured(),
    imagehubUrl: config.imagehubUrl,
    hoscode: config.hoscode,
    modalities: config.modalities,
    hisSystem,
    token: imagehubAuth.getTokenStatus(),
    pausedUntil: health.pausedUntil > Date.now() ? health.pausedUntil : null,
    lastError: health.lastError,
    lastSuccessAt: health.lastSuccessAt,
    sending: health.currentUid,
  };
}

module.exports = {
  applyImagehubSettings,
  onTokenRenewed,
  kick,
  stop,
  getForwardingStatus,
  // ใช้ในการทดสอบ
  buildUploadParams,
  resolveCid,
};
