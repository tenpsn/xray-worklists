// โค้ดเชื่อมต่อ Orthanc REST API ที่ใช้ร่วมกันระหว่าง orthanc-cleaner และ orthanc-mover

function buildAuthHeader(username, password) {
  if (!username && !password) return null;
  const token = Buffer.from(`${username || ''}:${password || ''}`).toString('base64');
  return `Basic ${token}`;
}

function normalizeOrthancUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// แปลง YYYY-MM-DD (จาก <input type=date>) เป็น YYYYMMDD ตามฟอร์แมตของ DICOM
function toDicomDate(isoDate) {
  return String(isoDate || '').replace(/-/g, '');
}

async function orthancFetch(orthancUrl, authHeader, pathname, options = {}) {
  const res = await fetch(`${orthancUrl}${pathname}`, {
    ...options,
    headers: {
      ...(authHeader ? { Authorization: authHeader } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  return res;
}

async function deleteStudyById(orthancUrl, authHeader, id) {
  const res = await orthancFetch(orthancUrl, authHeader, `/studies/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ลบไม่สำเร็จ (${res.status}): ${text || res.statusText}`);
  }
}

// ลงทะเบียน/อัปเดต PACS ปลายทางเป็น DICOM modality บน Orthanc ต้นทางแบบ live ผ่าน REST
// ไม่แก้ orthanc.json และไม่ต้อง restart container (คนละกลไกกับ DicomModalities ที่ orthancSync.js
// จัดการให้เครื่อง X-ray เข้ามา query worklist ได้ - อันนั้นคือ whitelist ฝั่งขาเข้า ส่วนนี้คือปลายทางฝั่งขาออก)
async function ensureModalityRegistered(orthancUrl, authHeader, name, aet, host, port) {
  const res = await orthancFetch(orthancUrl, authHeader, `/modalities/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({
      AET: aet,
      Host: host,
      Port: Number(port),
      Manufacturer: 'Generic',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ลงทะเบียน PACS ปลายทางไม่สำเร็จ (${res.status}): ${text || res.statusText}`);
  }
}

// สั่ง Orthanc ต้นทางส่ง Study ไปยัง PACS ปลายทางด้วย DICOM C-STORE (Synchronous รอผลกลับทันที)
async function storeResourcesToModality(orthancUrl, authHeader, name, resourceIds) {
  const res = await orthancFetch(orthancUrl, authHeader, `/modalities/${encodeURIComponent(name)}/store`, {
    method: 'POST',
    body: JSON.stringify({
      Resources: resourceIds,
      Synchronous: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Orthanc ตอบ error กลับมาเป็น JSON pretty-print ยาวๆ - ดึงแค่ "Details"/"Message" ที่อ่านง่าย
    // ออกมาแทน ถ้า parse ไม่ได้ (ไม่ใช่ JSON) ก็ fallback ไปใช้ text ดิบ
    let reason = text || res.statusText;
    try {
      const parsed = JSON.parse(text);
      reason = parsed.Details || parsed.Message || reason;
    } catch (err) {
      // ไม่ใช่ JSON - ใช้ text ดิบตามเดิม
    }
    throw new Error(`ส่งไป PACS ปลายทางไม่สำเร็จ (${res.status}): ${reason}`);
  }
  const result = await res.json().catch(() => ({}));
  // Orthanc คืน FailedInstancesCount เป็น 0 เมื่อส่งครบทุก instance สำเร็จ
  if (result && typeof result.FailedInstancesCount === 'number' && result.FailedInstancesCount > 0) {
    throw new Error(`ส่งไม่ครบ (${result.FailedInstancesCount} instance ล้มเหลว)`);
  }
  return result;
}

module.exports = {
  buildAuthHeader,
  normalizeOrthancUrl,
  toDicomDate,
  orthancFetch,
  deleteStudyById,
  ensureModalityRegistered,
  storeResourcesToModality,
};
