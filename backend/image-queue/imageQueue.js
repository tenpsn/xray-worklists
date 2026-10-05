// คิวภาพบนดิสก์ ใช้ร่วมกันทั้งฝั่งรับภาพ ฝั่งส่งต่อ และตัวลบไฟล์
// ภาพแต่ละไฟล์มีไฟล์สถานะคู่กัน แยกสถานะ PACS กับ ImageHub ไม่กระทบกัน

const fs = require('fs');
const path = require('path');

// ค่าเริ่มต้นเก็บคิวไว้ในโฟลเดอร์ของโมดูลนี้
const DEFAULT_STORAGE_DIR = __dirname;

let storageDir = DEFAULT_STORAGE_DIR;

function setStorageDir(dir) {
  storageDir = dir && String(dir).trim() ? String(dir).trim() : DEFAULT_STORAGE_DIR;
}

function getQueueDir() {
  return path.join(storageDir, 'queue');
}

function getTmpDir() {
  return path.join(storageDir, 'tmp');
}

function getFailedDir() {
  return path.join(storageDir, 'failed');
}

function ensureDirs() {
  fs.mkdirSync(getQueueDir(), { recursive: true });
  fs.mkdirSync(getTmpDir(), { recursive: true });
  fs.mkdirSync(getFailedDir(), { recursive: true });
}

function dicomPath(uid) {
  return path.join(getQueueDir(), `${uid}.dcm`);
}

function statusPath(uid) {
  return path.join(getQueueDir(), `${uid}.json`);
}

// ปลายทางที่ภาพแต่ละไฟล์ต้องส่งไป แต่ละปลายทางมีสถานะของตัวเอง
const TARGETS = ['pacs', 'imagehub'];

// สถานะมี รอส่ง ส่งแล้ว ล้มเหลว ไม่ต้องส่ง เลิกลอง และปิดอยู่
// ปลายทางที่ปิดอยู่ตอนรับภาพจะไม่ส่งย้อนหลังแม้เปิดทีหลัง
function newTargetStatus(status = 'pending') {
  return { status, attempts: 0, fileFailures: 0, lastAttemptAt: null, nextAttemptAt: 0, lastError: '', sentAt: null };
}

// ล้มเหลวเฉพาะภาพนี้ติดกันครบจำนวนนี้ให้เลิกลองและย้ายไปโฟลเดอร์ failed
// ไม่นับตอนปลายทางล่มทั้งระบบ เพราะภาพไม่ได้ผิด
const MAX_FILE_FAILURES = 3;

// คำนวณสถานะใหม่หลังส่งภาพนี้ไม่สำเร็จหนึ่งครั้ง ใช้ทั้ง PACS และ ImageHub
function afterFileFailure(status, at, message, retryInMs) {
  const attempts = (status.attempts || 0) + 1;
  const fileFailures = (status.fileFailures || 0) + 1;
  const gaveUp = fileFailures >= MAX_FILE_FAILURES;
  return {
    ...status,
    status: gaveUp ? 'gaveup' : 'failed',
    attempts,
    fileFailures,
    lastAttemptAt: at,
    nextAttemptAt: gaveUp ? 0 : at + retryInMs(attempts),
    lastError: message,
  };
}

function withDefaultTargets(record) {
  const result = { ...record };
  TARGETS.forEach((key) => {
    if (!result[key] || !result[key].status) result[key] = newTargetStatus();
  });
  return result;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function readStatus(uid) {
  return readJson(statusPath(uid));
}

function writeJsonAtomic(finalPath, record) {
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(record), 'utf8');
  fs.renameSync(tmpPath, finalPath);
}

function writeStatus(uid, record) {
  writeJsonAtomic(statusPath(uid), record);
}

// ภาพเดิมถูกส่งมาซ้ำ ลบสถานะเก่าก่อนเขียนทับ
// ถ้าโปรแกรมดับตรงนี้ ภาพจะถูกถือเป็นรอส่ง ไม่ค้างสถานะส่งแล้วของภาพเก่า
function removeStatus(uid) {
  try { fs.unlinkSync(statusPath(uid)); } catch (err) { /* ไม่มีอยู่แล้ว */ }
}

function listUidsIn(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.dcm'))
      .map((f) => f.slice(0, -4));
  } catch (err) {
    return [];
  }
}

function listUids() {
  return listUidsIn(getQueueDir());
}

function fallbackRecord(filePath, uid) {
  let receivedAt = Date.now();
  try { receivedAt = fs.statSync(filePath).mtimeMs; } catch (err) { /* ใช้เวลาปัจจุบัน */ }
  return { sopInstanceUid: uid, receivedAt };
}

// อ่านสถานะทุกภาพในคิว ภาพที่ไม่มีสถานะของปลายทางใดถือว่ารอส่ง
function listRecords() {
  return listUids().map((uid) => ({ uid, ...withDefaultTargets(readStatus(uid) || fallbackRecord(dicomPath(uid), uid)) }));
}

function listFailedRecords() {
  const dir = getFailedDir();
  return listUidsIn(dir).map((uid) => ({
    uid,
    ...withDefaultTargets(readJson(path.join(dir, `${uid}.json`)) || fallbackRecord(path.join(dir, `${uid}.dcm`), uid)),
  }));
}

// อ่าน แก้ และเขียนแบบทำทีเดียวจบ ผู้เขียนหลายฝั่งจึงไม่ทับผลกัน
// ถ้ามีภาพเดิมถูกส่งเข้ามาใหม่ระหว่างนั้น จะไม่เขียนผลของภาพเก่าทับ
function updateRecord(uid, receivedAtWhenPicked, mutate) {
  if (!fs.existsSync(dicomPath(uid))) return false; // ภาพถูกลบหรือย้ายไปแล้ว ไม่ต้องสร้างไฟล์สถานะ
  const current = readStatus(uid);
  if (current && current.receivedAt !== receivedAtWhenPicked) return false;
  const record = withDefaultTargets(current || { ...fallbackRecord(dicomPath(uid), uid), receivedAt: receivedAtWhenPicked });
  writeStatus(uid, mutate(record));
  return true;
}

// อัปเดตสถานะของปลายทางเดียว ไม่แตะปลายทางอื่น
function updateTarget(uid, receivedAtWhenPicked, key, mutate) {
  return updateRecord(uid, receivedAtWhenPicked, (record) => ({ ...record, [key]: mutate({ ...record[key] }) }));
}

// ย้ายภาพไปโฟลเดอร์ failed โดยย้ายไฟล์สถานะก่อน ถ้าดับกลางทางภาพจะไม่หาย
function moveToFailed(uid) {
  fs.mkdirSync(getFailedDir(), { recursive: true });
  const status = readStatus(uid);
  if (status) writeJsonAtomic(path.join(getFailedDir(), `${uid}.json`), { ...status, movedToFailedAt: Date.now() });
  fs.renameSync(dicomPath(uid), path.join(getFailedDir(), `${uid}.dcm`));
  removeStatus(uid);
}

// กดส่งใหม่จากโฟลเดอร์ failed ย้ายกลับเข้าคิวและเริ่มนับครั้งที่ล้มเหลวใหม่
function restoreFromFailed(uid) {
  const failedDicom = path.join(getFailedDir(), `${uid}.dcm`);
  const failedStatus = path.join(getFailedDir(), `${uid}.json`);
  if (!fs.existsSync(failedDicom)) return false;
  fs.mkdirSync(getQueueDir(), { recursive: true });
  const { movedToFailedAt, completedAt, ...status } = withDefaultTargets(readJson(failedStatus) || fallbackRecord(failedDicom, uid));
  TARGETS.forEach((key) => {
    if (status[key].status === 'gaveup' || status[key].status === 'failed') {
      status[key] = { ...status[key], status: 'pending', fileFailures: 0, nextAttemptAt: 0 };
    }
  });
  writeStatus(uid, status);
  fs.renameSync(failedDicom, dicomPath(uid));
  try { fs.unlinkSync(failedStatus); } catch (err) { /* ไม่มีอยู่แล้ว */ }
  return true;
}

// ลบภาพที่ส่งครบและเก็บไว้ครบกำหนดแล้ว ลบภาพก่อนไฟล์สถานะ
function deleteImage(uid) {
  fs.unlinkSync(dicomPath(uid));
  removeStatus(uid);
}

const OVERVIEW_ITEM_LIMIT = 300;

function toOverviewItem(r, sendingUids = {}) {
  const item = {
    uid: r.uid,
    receivedAt: r.receivedAt || null,
    completedAt: r.completedAt || null,
    movedToFailedAt: r.movedToFailedAt || null,
    callingAet: r.callingAet || '',
    patientId: r.patientId || '',
    patientName: r.patientName || '',
    accessionNumber: r.accessionNumber || '',
    modality: r.modality || '',
    bodyPartExamined: r.bodyPartExamined || '',
    studyDate: r.studyDate || '',
    size: r.size || null,
  };
  TARGETS.forEach((key) => {
    const { response, ...status } = r[key];
    item[key] = { ...status, status: r.uid === sendingUids[key] ? 'sending' : status.status };
  });
  return item;
}

// ข้อมูลสำหรับหน้าคิวส่งภาพ จำนวนตามสถานะ ภาพล่าสุด และภาพในโฟลเดอร์ failed
function buildOverview(sendingUids = {}) {
  const records = listRecords();
  const failedRecords = listFailedRecords();
  const counts = { total: records.length, failed: failedRecords.length };
  TARGETS.forEach((key) => {
    counts[key] = { pending: 0, failed: 0, success: 0, skipped: 0, gaveup: 0, off: 0 };
    records.forEach((r) => {
      if (counts[key][r[key].status] !== undefined) counts[key][r[key].status] += 1;
    });
  });
  const newestFirst = (a, b) => (b.receivedAt || 0) - (a.receivedAt || 0);
  return {
    counts,
    items: records.sort(newestFirst).slice(0, OVERVIEW_ITEM_LIMIT).map((r) => toOverviewItem(r, sendingUids)),
    failedItems: failedRecords.sort(newestFirst).slice(0, OVERVIEW_ITEM_LIMIT).map((r) => toOverviewItem(r)),
    itemLimit: OVERVIEW_ITEM_LIMIT,
  };
}

module.exports = {
  buildOverview,
  DEFAULT_STORAGE_DIR,
  setStorageDir,
  getQueueDir,
  getTmpDir,
  getFailedDir,
  ensureDirs,
  dicomPath,
  statusPath,
  TARGETS,
  MAX_FILE_FAILURES,
  newTargetStatus,
  afterFileFailure,
  readStatus,
  writeStatus,
  removeStatus,
  listUids,
  listRecords,
  listFailedRecords,
  updateRecord,
  updateTarget,
  moveToFailed,
  restoreFromFailed,
  deleteImage,
};
