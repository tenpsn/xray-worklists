// ดึงรายชื่อคนไข้ที่มีนัดวันนี้จาก DoctorEase ผ่าน API
// ใช้แทนการต่อฐานข้อมูล HIS ตรง

const REQUEST_TIMEOUT_MS = 10000;
const ACCESSION_MAX_LENGTH = 16;

// เก็บ XN ที่ได้จากรอบก่อน ไว้หาว่านัดไหนหายไปจากรายการ
let previousXns = new Set();

function createApiError(errorCode, message) {
  const err = new Error(message || errorCode);
  err.errorCode = errorCode;
  return err;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

async function callApi(url, options) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err.name === 'TimeoutError') throw createApiError('DE_TIMEOUT');
    throw createApiError('DE_UNREACHABLE', err.message);
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (err) {
    return {};
  }
}

// แปลงรหัส HTTP ที่ตอบกลับมาเป็นรหัส error ที่หน้าเว็บแปลเป็นข้อความได้
function errorCodeFromStatus(status, isRegister) {
  if (status === 401) return isRegister ? 'DE_BAD_CREDENTIALS' : 'DE_TOKEN_INVALID';
  if (status === 403) return 'DE_IP_NOT_ALLOWED';
  if (status === 422) return 'DE_BAD_REQUEST';
  if (status === 429) return 'DE_RATE_LIMIT';
  return 'DE_SERVER_ERROR';
}

// ขอ token ใหม่ ถ้าเคยขอด้วยบัญชีและ IP เดิม token เก่าจะใช้ไม่ได้ทันที
async function registerToken({ apiBaseUrl, email, password, serverIp, expireDays, name }) {
  const baseUrl = normalizeBaseUrl(apiBaseUrl);
  if (!baseUrl) throw createApiError('DE_NOT_CONFIGURED');

  const body = { email, password, server_ip: serverIp, name: name || 'xray-worklists' };
  if (expireDays) body.expire_days = Number(expireDays);

  const response = await callApi(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await readJson(response);

  if (response.status !== 201 || !json.token) {
    throw createApiError(errorCodeFromStatus(response.status, true), json.message);
  }
  return { token: json.token, serverIp: json.server_ip, expiresAt: json.expires_at };
}

// สร้าง XN จากวันที่ เวลานัด และ HN เพราะ API ไม่มีรหัสนัดมาให้
// Accession Number ยาวได้ไม่เกิน 16 ตัว ถ้า HN ยาวเกินจะตัดเหลือแค่ตัวท้าย
function buildXn(row) {
  const day = String(row.service_date || '').slice(8, 10);
  const time = String(row.service_time || '').replace(/:/g, '').slice(0, 4);
  const prefix = `${day}${time}`;
  const hn = String(row.HN || '').trim();
  return `${prefix}${hn.slice(-(ACCESSION_MAX_LENGTH - prefix.length))}`;
}

function mapRowToRecord(row) {
  return {
    xn: buildXn(row),
    // ใช้เลขบัตรประชาชนหรือพาสปอร์ตเป็น HN
    hn: String(row.ID_Card || row.HN || '').trim(),
    cid: row.ID_Card || '',
    fname: row.Firstname || '',
    lname: row.Lastname || '',
    birthday: row.Birthday || '',
    StudyDate: row.service_date || '',
    StudyTime: row.service_time || '',
    // เครื่องที่ ICOH เป็นเครื่อง X-ray ฟัน
    Modality: 'IO',
    branch_code: row.branch_code || '',
    confirm: 'N',
    confirm_read_film: 'N',
  };
}

async function fetchTodayRecords(his) {
  const baseUrl = normalizeBaseUrl(his.apiBaseUrl);
  if (!baseUrl || !his.apiToken) throw createApiError('DE_NOT_CONFIGURED');

  const query = his.branchCode ? `?branch_code=${encodeURIComponent(his.branchCode)}` : '';
  const response = await callApi(`${baseUrl}/api/patients/today${query}`, {
    headers: { Authorization: `Bearer ${his.apiToken}`, Accept: 'application/json' },
  });
  const json = await readJson(response);

  if (response.status !== 200 || !Array.isArray(json.data)) {
    throw createApiError(errorCodeFromStatus(response.status, false), json.message);
  }
  return json.data
    .filter((row) => row && row.HN)
    .map(mapRowToRecord);
}

// คืนรายการ XN ที่รอบก่อนมีแต่รอบนี้ไม่มีแล้ว เช่นนัดถูกยกเลิกหรือเลื่อนเวลา
function takeRemovedXns(records) {
  const currentXns = new Set(records.map((r) => r.xn));
  const removed = [...previousXns].filter((xn) => !currentXns.has(xn));
  previousXns = currentXns;
  return removed;
}

function resetTracking() {
  previousXns = new Set();
}

function isConfigured(his) {
  return Boolean(normalizeBaseUrl(his && his.apiBaseUrl) && his.apiToken);
}

module.exports = {
  registerToken,
  fetchTodayRecords,
  takeRemovedXns,
  resetTracking,
  isConfigured,
  buildXn,
};
