// ลบภาพที่ส่งครบทุกปลายทางแล้วเมื่อครบ 2 วัน และย้ายภาพที่เลิกลองไปโฟลเดอร์ failed
// ย้ายเมื่อปลายทางอื่นส่งเสร็จแล้ว ฝั่งที่ยังส่งได้จะไม่เสียโอกาส

const imageQueue = require('./imageQueue');
const pacsForwardService = require('./pacsForwardService');
const imagehubService = require('./imagehubService');

const RETENTION_MS = 2 * 24 * 60 * 60 * 1000; // เก็บภาพที่ส่งครบแล้วไว้ 2 วันก่อนลบ
const CLEANUP_INTERVAL_MS = 60 * 1000;
const STUCK_MS = 60 * 60 * 1000; // มีภาพรอส่งเกิน 1 ชั่วโมงให้เตือน

let cleanupTimer = null;

function enabledTargets() {
  return {
    pacs: pacsForwardService.getForwardingStatus().enabled,
    imagehub: imagehubService.getForwardingStatus().enabled,
  };
}

// ผลคือ จบแล้ว เลิกลองแล้ว หรือยังต้องส่ง
function targetState(status, enabled) {
  if (status === 'success' || status === 'skipped' || status === 'off') return 'done';
  if (status === 'gaveup') return 'gaveup';
  if (!enabled) return 'done'; // ปลายทางที่ปิดอยู่ไม่ต้องรอ
  return 'waiting';
}

function runCleanup() {
  const enabled = enabledTargets();
  const now = Date.now();
  let deleted = 0;
  let moved = 0;

  imageQueue.listRecords().forEach((record) => {
    // ปลายทางที่ปิดอยู่ ภาพที่ยังไม่ได้ส่งเปลี่ยนเป็นไม่ต้องส่ง
    // เปิดปลายทางกลับมาก็ไม่ส่งย้อนหลัง
    imageQueue.TARGETS.forEach((key) => {
      if (enabled[key] || (record[key].status !== 'pending' && record[key].status !== 'failed')) return;
      try {
        imageQueue.updateTarget(record.uid, record.receivedAt, key, (s) => ({ ...s, status: 'off', nextAttemptAt: 0 }));
        record[key] = { ...record[key], status: 'off' };
      } catch (err) {
        console.error(`[Image Cleanup] ---> เปลี่ยนสถานะ ${record.uid} (${key}) ไม่สำเร็จ: ${err.message}`);
      }
    });
    const states = imageQueue.TARGETS.map((key) => targetState(record[key].status, enabled[key]));
    try {
      if (states.includes('waiting')) {
        // ยังส่งไม่ครบ ยกเลิกการนับเวลารอลบ
        if (record.completedAt) {
          imageQueue.updateRecord(record.uid, record.receivedAt, ({ completedAt, ...rest }) => rest);
        }
        return;
      }
      if (states.includes('gaveup')) {
        imageQueue.moveToFailed(record.uid);
        moved += 1;
        console.warn(`[Image Cleanup] ---> ย้ายภาพ ${record.uid}${record.patientId ? ` (HN ${record.patientId})` : ''} ไปโฟลเดอร์ failed (ส่งไม่สำเร็จจนเลิกลอง)`);
        return;
      }
      if (!record.completedAt) {
        imageQueue.updateRecord(record.uid, record.receivedAt, (r) => ({ ...r, completedAt: now }));
        return;
      }
      if (now - record.completedAt >= RETENTION_MS) {
        imageQueue.deleteImage(record.uid);
        deleted += 1;
      }
    } catch (err) {
      console.error(`[Image Cleanup] ---> จัดการภาพ ${record.uid} ไม่สำเร็จ: ${err.message}`);
    }
  });

  if (deleted > 0) console.log(`[Image Cleanup] ---> ลบภาพที่ส่งครบแล้วเกิน 2 วัน ${deleted} ภาพ`);
  return { deleted, moved };
}

// เตือนในหน้าคิวเมื่อมีภาพรอส่งนานเกินกำหนด
function getWarnings() {
  const enabled = enabledTargets();
  const now = Date.now();
  const stuck = { pacs: { count: 0, oldestAt: null }, imagehub: { count: 0, oldestAt: null } };
  imageQueue.listRecords().forEach((record) => {
    imageQueue.TARGETS.forEach((key) => {
      if (targetState(record[key].status, enabled[key]) !== 'waiting') return;
      if (now - (record.receivedAt || now) < STUCK_MS) return;
      stuck[key].count += 1;
      if (!stuck[key].oldestAt || record.receivedAt < stuck[key].oldestAt) stuck[key].oldestAt = record.receivedAt;
    });
  });
  return { stuck, retentionMs: RETENTION_MS, stuckMs: STUCK_MS };
}

function start() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  runCleanup();
}

function stop() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
}

module.exports = {
  start,
  stop,
  runCleanup,
  getWarnings,
  RETENTION_MS,
};
