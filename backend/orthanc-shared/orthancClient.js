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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const JOB_POLL_INTERVAL_MS = 1000;

// จำนวน instance (รูป) ของ Study หนึ่ง หรือ null ถ้าหาไม่ได้
async function getInstanceCount(orthancUrl, authHeader, studyId) {
  try {
    const res = await orthancFetch(orthancUrl, authHeader, `/studies/${encodeURIComponent(studyId)}/instances`);
    if (!res.ok) return null;
    const instances = await res.json().catch(() => null);
    return Array.isArray(instances) ? instances.length : null;
  } catch (err) {
    return null;
  }
}

// เช็คไม่ใช่แค่ว่ามี Study นี้อยู่ที่ปลายทางไหม แต่เช็คว่าจำนวน instance (รูป) เท่ากับต้นทาง
// หรือเปล่า - เคสที่ส่งไปได้บางส่วน (ไม่ครบ) จะดูเหมือน "มีอยู่แล้ว" ถ้าเช็คแค่การมีอยู่เฉยๆ.
// จับคู่ด้วย Accession Number เป็นหลัก แต่ fallback ไปใช้ StudyInstanceUID แทนใน 2 กรณี:
//   1. เคสนี้ไม่มี Accession Number เลย (เช็คด้วยวิธีนั้นไม่ได้แน่ๆ)
//   2. ค้นด้วย Accession Number แล้วเจอที่ปลายทาง "มากกว่า 1 เคส" (XN ซ้ำกัน - เดาไม่ได้ว่าอันไหน
//      ถูก ถ้าเชื่อตัวแรกเฉยๆ อาจไปเทียบกับเคสอื่นที่ไม่ใช่ตัวที่เพิ่งส่งจริง)
// StudyInstanceUID ไม่มีวันเปลี่ยนระหว่างส่งและไม่มีทางซ้ำกับเคสอื่นตามมาตรฐาน DICOM เลย จึงใช้
// แทนได้แม่นยำกว่าเสมอเมื่อ Accession Number เชื่อไม่ได้.
// คืนค่า null ถ้าเช็คเองไม่สำเร็จ (เช่น ต่อปลายทางไม่ติด) มิเช่นนั้นคืนหนึ่งใน:
//   { complete: true }
//   { complete: false, found: false }                             - ไม่เจอที่ปลายทางเลย
//   { complete: false, found: true, actualCount, expectedCount }   - เจอแต่ไม่ครบ
async function checkStudyCompleteOnDestination(sourceUrl, sourceAuthHeader, sourceStudyId, destRestUrl, destAuthHeader, accessionNumber) {
  const expectedCount = await getInstanceCount(sourceUrl, sourceAuthHeader, sourceStudyId);
  if (expectedCount === null) return null;

  async function findByStudyInstanceUid() {
    const sourceStudyRes = await orthancFetch(sourceUrl, sourceAuthHeader, `/studies/${encodeURIComponent(sourceStudyId)}`);
    if (!sourceStudyRes.ok) return null;
    const sourceStudy = await sourceStudyRes.json().catch(() => null);
    const studyInstanceUid = sourceStudy && sourceStudy.MainDicomTags && sourceStudy.MainDicomTags.StudyInstanceUID;
    if (!studyInstanceUid) return null;

    const res = await orthancFetch(destRestUrl, destAuthHeader, '/tools/find', {
      method: 'POST',
      body: JSON.stringify({ Level: 'Study', Query: { StudyInstanceUID: studyInstanceUid } }),
    });
    if (!res.ok) return null;
    const matches = await res.json().catch(() => null);
    return Array.isArray(matches) ? matches : null;
  }

  try {
    let matches = null;

    if (accessionNumber) {
      const res = await orthancFetch(destRestUrl, destAuthHeader, '/tools/find', {
        method: 'POST',
        body: JSON.stringify({ Level: 'Study', Query: { AccessionNumber: accessionNumber } }),
      });
      if (!res.ok) return null;
      matches = await res.json().catch(() => null);
      if (!Array.isArray(matches)) return null;

      if (matches.length > 1) {
        matches = await findByStudyInstanceUid();
        if (!Array.isArray(matches)) return null;
      }
    } else {
      matches = await findByStudyInstanceUid();
      if (!Array.isArray(matches)) return null;
    }

    if (matches.length === 0) return { complete: false, found: false };

    const actualCount = await getInstanceCount(destRestUrl, destAuthHeader, matches[0]);
    if (actualCount === null) return null;
    if (actualCount >= expectedCount) return { complete: true, actualCount, expectedCount };
    return { complete: false, found: true, actualCount, expectedCount };
  } catch (err) {
    return null;
  }
}

// แปลงผลจาก checkStudyCompleteOnDestination เป็นข้อความสั้นๆ ต่อท้าย
function formatDestinationCheckSuffix(result) {
  if (!result) return ' - เช็คปลายทางไม่ได้';
  if (result.complete) return ` - เช็คแล้วครบ ${result.actualCount}/${result.expectedCount} รูปที่ปลายทาง`;
  if (result.found === false) return ' - ปลายทางไม่มีเคสนี้เลย';
  return ` - ปลายทางมีแค่ ${result.actualCount} จาก ${result.expectedCount} รูป`;
}

// เรียก checkFn (เช็คปลายทาง) ซ้ำได้สูงสุด maxAttempts ครั้ง แต่ "เฉพาะตอนเช็คเองไม่สำเร็จ" (null
// - เช่น ปลายทางต่อไม่ติดชั่วคราว) เท่านั้น ถ้าเช็คได้คำตอบจริงแล้ว (ไม่ว่าจะครบหรือไม่ครบ) จะเชื่อ
// ทันทีไม่ลองซ้ำ กันไม่ให้ปัญหาเชื่อมต่อชั่วคราวตอนเช็คกลายเป็น "ไม่สำเร็จ" ทั้งที่ส่งไปครบแล้ว
async function checkDestinationWithRetry(checkFn, maxAttempts = 3, retryDelayMs = 1000) {
  let result = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = await checkFn().catch(() => null);
    if (result !== null) return result;
    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }
  return null;
}

// verifyIfEvicted (ถ้ามี) คือ async () => ผลจาก checkStudyCompleteOnDestination ใช้ตอน job
// หลุดหายจาก job history ของ Orthanc (ดูด้านล่าง) - ไม่มี timeout ในนี้ รอจนกว่า Orthanc จะตอบ
// Success/Failure จริงๆ (DICOM timeout ของ Orthanc เองเป็นตัวจำกัดเวลาแทน)
async function waitForJobCompletion(orthancUrl, authHeader, jobId, verifyIfEvicted) {
  for (;;) {
    let jobInfo = null;
    let notFound = false;
    try {
      const res = await orthancFetch(orthancUrl, authHeader, `/jobs/${encodeURIComponent(jobId)}`);
      if (res.ok) {
        jobInfo = await res.json();
      } else if (res.status === 404) {
        notFound = true;
      }
    } catch (err) {
      // เชื่อมต่อสะดุดชั่วคราวตอน poll - ถือว่ายังทำงานอยู่ แล้วลองใหม่
    }

    if (notFound) {
      // Orthanc จะ evict เฉพาะ job ที่เสร็จแล้วออกจาก history (จำกัดจำนวนไว้) - job ที่ยังทำงานอยู่
      // จะไม่หายไปแบบนี้เด็ดขาด ดังนั้นถ้า job นี้หายไป แปลว่ามันเสร็จไปแล้วจริงๆ แค่หลุดจาก history
      // เพราะมี job อื่นเสร็จตามมาเยอะพอ - ถามตรงๆ กับ Orthanc ไม่ได้อีกแล้ว ณ จุดนี้
      if (verifyIfEvicted) {
        const result = await checkDestinationWithRetry(verifyIfEvicted);
        if (result && result.complete) {
          return { verifiedOnDestination: true, actualCount: result.actualCount, expectedCount: result.expectedCount };
        }
        if (result && result.complete === false) {
          throw new Error(`หลุดการติดตาม job และ${formatDestinationCheckSuffix(result)} กรุณาลองส่งใหม่`);
        }
        // result === null: เช็คเองก็ไม่สำเร็จ - ถือเหมือนไม่ได้ตั้ง verifyIfEvicted ไว้เลย
      }
      return { assumedSuccessJobEvicted: true };
    }

    if (jobInfo) {
      if (jobInfo.State === 'Success') {
        const content = jobInfo.Content || {};
        if (typeof content.FailedInstancesCount === 'number' && content.FailedInstancesCount > 0) {
          const suffix = verifyIfEvicted ? formatDestinationCheckSuffix(await checkDestinationWithRetry(verifyIfEvicted)) : '';
          throw new Error(`ส่งไม่ครบ (${content.FailedInstancesCount} instance ล้มเหลว)${suffix}`);
        }
        return content;
      }
      if (jobInfo.State === 'Failure') {
        const suffix = verifyIfEvicted ? formatDestinationCheckSuffix(await checkDestinationWithRetry(verifyIfEvicted)) : '';
        throw new Error(`${jobInfo.ErrorDescription || 'ส่งไป PACS ปลายทางไม่สำเร็จ'}${suffix}`);
      }
      if (jobInfo.State === 'Cancelled' || jobInfo.State === 'Paused') {
        const suffix = verifyIfEvicted ? formatDestinationCheckSuffix(await checkDestinationWithRetry(verifyIfEvicted)) : '';
        throw new Error(`Job ถูก${jobInfo.State === 'Cancelled' ? 'ยกเลิก' : 'พัก'}ที่ Orthanc ต้นทาง${suffix}`);
      }
      // State เป็น Pending/Running - รอต่อ
    }

    await sleep(JOB_POLL_INTERVAL_MS);
  }
}

// สั่ง Orthanc ต้นทางส่ง Study ไปยัง PACS ปลายทางด้วย DICOM C-STORE
// ส่งแบบ async (Synchronous:false) - POST แค่สร้าง job แล้วคืนทันที ไม่ค้าง HTTP connection รอ
// จนกว่าจะส่งเสร็จ (กัน 504 จาก reverse proxy ตอน Study ใหญ่/เครือข่ายช้า) แล้วค่อย poll
// /jobs/{id} ต่อเอง. verifyIfEvicted (ถ้ามี) ใช้ตอน job หลุดหายจาก history ก่อนเห็นผลจริง
async function storeResourcesToModality(orthancUrl, authHeader, name, resourceIds, verifyIfEvicted) {
  const res = await orthancFetch(orthancUrl, authHeader, `/modalities/${encodeURIComponent(name)}/store`, {
    method: 'POST',
    body: JSON.stringify({
      Resources: resourceIds,
      Synchronous: false,
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
  const job = await res.json().catch(() => ({}));
  if (!job.ID) {
    throw new Error('Orthanc ไม่คืนค่า job ID สำหรับคำสั่งส่งแบบ async');
  }
  return waitForJobCompletion(orthancUrl, authHeader, job.ID, verifyIfEvicted);
}

module.exports = {
  buildAuthHeader,
  normalizeOrthancUrl,
  toDicomDate,
  orthancFetch,
  deleteStudyById,
  ensureModalityRegistered,
  storeResourcesToModality,
  checkStudyCompleteOnDestination,
  checkDestinationWithRetry,
  formatDestinationCheckSuffix,
  getInstanceCount,
};
