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

async function findStudies(orthancUrl, username, password, fromDate, toDate) {
  const normalizedUrl = normalizeOrthancUrl(orthancUrl);
  const authHeader = buildAuthHeader(username, password);

  const res = await orthancFetch(normalizedUrl, authHeader, '/tools/find', {
    method: 'POST',
    body: JSON.stringify({
      Level: 'Study',
      Query: {
        StudyDate: `${toDicomDate(fromDate)}-${toDicomDate(toDate)}`,
      },
      Expand: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Orthanc ตอบกลับผิดพลาด (${res.status}): ${text || res.statusText}`);
  }

  const studies = await res.json();

  return studies.map((s) => {
    const tags = s.MainDicomTags || {};
    const patientTags = s.PatientMainDicomTags || {};
    return {
      id: s.ID,
      patientName: patientTags.PatientName || '',
      patientId: patientTags.PatientID || '',
      accessionNumber: tags.AccessionNumber || '',
      studyDate: tags.StudyDate || '',
      studyDescription: tags.StudyDescription || '',
    };
  });
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

const DELETE_MAX_ATTEMPTS = 3;
const DELETE_RETRY_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// รันลบทีละตัวเบื้องหลัง พร้อมอัปเดต job ให้ endpoint สถานะ poll อ่านได้ระหว่างทาง
async function runDeleteJob(job, orthancUrl, username, password, items) {
  const normalizedUrl = normalizeOrthancUrl(orthancUrl);
  const authHeader = buildAuthHeader(username, password);

  for (const item of items) {
    let lastErr;
    for (let attempt = 1; attempt <= DELETE_MAX_ATTEMPTS; attempt += 1) {
      try {
        await deleteStudyById(normalizedUrl, authHeader, item.id);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        // "fetch failed" คือหลุดการเชื่อมต่อชั่วคราว (ไม่ใช่ Orthanc ตอบปฏิเสธ) ลองใหม่ได้
        if (err.message !== 'fetch failed' || attempt === DELETE_MAX_ATTEMPTS) break;
        await sleep(DELETE_RETRY_DELAY_MS);
      }
    }

    if (lastErr) {
      const message = lastErr.message === 'fetch failed'
        ? 'เชื่อมต่อ Orthanc ไม่ได้'
        : lastErr.message;
      job.results.push({ id: item.id, success: false, message });
    } else {
      job.results.push({ id: item.id, success: true });
    }
    job.processed += 1;
  }
  job.done = true;
}

module.exports = { findStudies, runDeleteJob };
