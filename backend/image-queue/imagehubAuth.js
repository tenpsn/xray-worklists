// เข้าสู่ระบบ MOPH เพื่อขอ token สำหรับอัปโหลดขึ้น ImageHub
// secret และ token อยู่ฝั่ง server เท่านั้น ไม่ส่งไปหน้าเว็บ

const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, 'imagehub-token.json');
const REQUEST_TIMEOUT_MS = 30000;
const SESSION_MAX_MS = 24 * 60 * 60 * 1000; // ล็อกอินแล้วใช้ได้ 24 ชั่วโมง แล้วต้องล็อกอินใหม่

let tokenCache = null;

function loadToken() {
  if (tokenCache) return tokenCache;
  try {
    tokenCache = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (err) {
    tokenCache = { token: '', expires: '', username: '' };
  }
  return tokenCache;
}

function saveToken(data) {
  tokenCache = data;
  const tmpPath = `${TOKEN_FILE}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
  fs.renameSync(tmpPath, TOKEN_FILE);
}

// ไม่รู้วันหมดอายุให้ถือว่าหมดอายุแล้ว
function isExpired() {
  const { expires } = loadToken();
  if (!expires) return true;
  const at = new Date(expires);
  return Number.isNaN(at.getTime()) || at < new Date();
}

function hasValidToken() {
  return Boolean(loadToken().token) && !isExpired();
}

function getToken() {
  return loadToken().token;
}

// ImageHub ปฏิเสธ token แม้ยังไม่หมดอายุ ให้ทิ้งแล้วรอล็อกอินใหม่
function invalidateToken(reason) {
  const current = loadToken();
  saveToken({ ...current, token: '', invalidatedReason: reason || '' });
}

function logout() {
  saveToken({ token: '', expires: '', username: '' });
}

// สถานะสำหรับหน้าเว็บ ไม่มีตัว token
function getTokenStatus() {
  const { token, expires, username, invalidatedReason } = loadToken();
  return {
    valid: hasValidToken(),
    hasToken: Boolean(token),
    expires: expires || null,
    username: username || '',
    invalidatedReason: invalidatedReason || '',
  };
}

function getLoginUrl(cfg, redirectUri) {
  if (!cfg.mophUrl || !cfg.clientId) {
    throw new Error('ยังไม่ได้ตั้งค่า MOPH URL / Client ID');
  }
  const params = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, response_type: 'code' });
  return `${cfg.mophUrl.replace(/\/+$/, '')}/oauth/redirect?${params.toString()}`;
}

async function postJson(url, body, label) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`${label}: เชื่อมต่อไม่ได้ (${err.message})`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (err) { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    // log แค่คำตอบ ห้าม log ข้อมูลที่ส่งไปเพราะมี secret
    console.error(`[ImageHub Auth] ---> ${label} ตอบ HTTP ${res.status}:`, data);
    throw new Error(`${label}: ตอบ HTTP ${res.status}`);
  }
  return data;
}

// แลก code เป็น token ของ Health ID แล้วแลกต่อเป็น token ของ ImageHub แล้วเก็บไว้
async function exchangeCode(cfg, code, redirectUri) {
  if (!cfg.healthUrl || !cfg.providerUrl) throw new Error('ยังไม่ได้ตั้งค่า Health ID URL / Provider ID URL');
  if (!cfg.clientId || !cfg.secretKey) throw new Error('ยังไม่ได้ตั้งค่า Client ID / Secret Key (Health ID)');
  if (!cfg.clientId2 || !cfg.secretKey2) throw new Error('ยังไม่ได้ตั้งค่า Client ID / Secret Key (Provider ID)');

  const health = await postJson(cfg.healthUrl, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.secretKey,
  }, 'Health ID');
  // API นี้อาจแจ้งล้มเหลวมาในเนื้อหา แม้สถานะ HTTP จะสำเร็จ
  if (health.status !== 'success' || !health.data || !health.data.access_token) {
    throw new Error(`Health ID ไม่รับ code นี้ (status: ${health.status || '-'}) ลองกดเข้าสู่ระบบใหม่`);
  }

  const provider = await postJson(cfg.providerUrl, {
    token_by: 'Health ID',
    client_id: cfg.clientId2,
    secret_key: cfg.secretKey2,
    token: health.data.access_token,
  }, 'Provider ID');
  if (Number(provider.status) !== 200 || !provider.data || !provider.data.access_token) {
    throw new Error(`Provider ID ไม่ออก token ให้ (status: ${provider.status || '-'})`);
  }

  const p = provider.data;
  // ใช้ได้ไม่เกิน 24 ชั่วโมงนับจากล็อกอิน ถ้า Provider ID ให้หมดอายุเร็วกว่าก็ใช้ค่านั้น
  const sessionEnd = Date.now() + SESSION_MAX_MS;
  const mophEnd = new Date(p.expiration_date).getTime();
  const expires = new Date(Number.isNaN(mophEnd) ? sessionEnd : Math.min(mophEnd, sessionEnd)).toISOString();
  saveToken({ token: p.access_token, expires, username: p.username || '' });
  console.log(`[ImageHub Auth] ---> ได้ token ของ ${p.username || 'ไม่ทราบชื่อ'} หมดอายุ ${expires}`);
  return getTokenStatus();
}

module.exports = {
  getLoginUrl,
  exchangeCode,
  logout,
  hasValidToken,
  getToken,
  invalidateToken,
  getTokenStatus,
};
