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

async function deleteStudies(orthancUrl, username, password, items) {
  const normalizedUrl = normalizeOrthancUrl(orthancUrl);
  const authHeader = buildAuthHeader(username, password);

  const results = [];
  for (const item of items) {
    try {
      await deleteStudyById(normalizedUrl, authHeader, item.id);
      results.push({ id: item.id, success: true });
    } catch (err) {
      const message = err.message === 'fetch failed'
        ? 'เชื่อมต่อ Orthanc ไม่ได้'
        : err.message;
      results.push({ id: item.id, success: false, message });
    }
  }
  return results;
}

module.exports = { findStudies, deleteStudies };
