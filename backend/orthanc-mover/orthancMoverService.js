const {
  buildAuthHeader,
  normalizeOrthancUrl,
  toDicomDate,
  ensureModalityRegistered,
  storeResourcesToModality,
  checkStudyCompleteOnDestination,
  checkDestinationWithRetry,
  formatDestinationCheckSuffix,
} = require('../orthanc-shared/orthancClient');
const { findStudies } = require('../orthanc-cleaner/orthancService');
const moverState = require('./moverState');

// ชื่อ modality ที่จะลงทะเบียนบน Orthanc ต้นทางแทน PACS ปลายทางที่ผู้ใช้กรอกมา
// ต้องใช้ "-" ไม่ใช่ "_" เพราะ Orthanc รุ่นเก่า (เช่น 1.5.8) validate ชื่อ modality/peer
// ให้เป็นแค่ตัวอักษร/ตัวเลข/ขีดกลางเท่านั้น (รุ่นใหม่รับ "_" ได้ แต่รุ่นเก่าจะขึ้น 400 Bad Request)
const DEST_MODALITY_NAME = 'MOVER-DEST';

const STORE_MAX_ATTEMPTS = 3;
const STORE_RETRY_DELAY_MS = 1000;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_DEST_REST_PORT = 8042;
// เชื่อมต่อสะดุดชั่วคราว (ไม่ใช่ Orthanc/ปลายทางตอบปฏิเสธ) - ลองใหม่ได้
const RETRYABLE_ERROR_PATTERN = /fetch failed|ECONNREFUSED|ETIMEDOUT/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ทุกวันที่ (YYYY-MM-DD) ตั้งแต่ fromIso ถึง toIso รวมปลายทั้งสองข้าง ใช้ UTC ล้วนกันพลาดเรื่อง DST
function enumerateDates(fromIso, toIso) {
  const dates = [];
  const start = new Date(`${fromIso}T00:00:00Z`);
  const end = new Date(`${toIso}T00:00:00Z`);
  for (let d = start; d <= end; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

async function buildJob({
  orthancUrl,
  username,
  password,
  from,
  to,
  destAet,
  destHost,
  destPort,
  destRestUrl,
  destRestUsername,
  destRestPassword,
  concurrency,
}) {
  // ไม่ค้นหาที่นี่แล้ว - ค้นหาทีละวันข้างใน runMoveJob() เอง (พร้อม retry ต่อวัน) เพื่อไม่ให้
  // request POST /start ต้องรอค้นหาทั้งช่วงให้เสร็จก่อนถึงจะตอบกลับ (ช่วงกว้างๆ เสี่ยง proxy timeout
  // เหมือนที่เคยเจอตอนส่งแบบ synchronous)
  const totalDates = enumerateDates(from, to).length;

  // ถ้าไม่ได้กรอก REST URL ของปลายทางมา เดาจากพอร์ตมาตรฐานของ Orthanc (8042) ให้เอง เพื่อให้
  // ยังเช็คผลจริงที่ปลายทางได้โดยไม่ต้องกรอกเพิ่ม
  const resolvedDestRestUrl = normalizeOrthancUrl(destRestUrl || `http://${destHost}:${DEFAULT_DEST_REST_PORT}`);

  return {
    status: 'running',
    source: { orthancUrl: normalizeOrthancUrl(orthancUrl), username, password },
    destination: {
      name: DEST_MODALITY_NAME,
      aet: destAet,
      host: destHost,
      port: Number(destPort),
      restUrl: resolvedDestRestUrl,
      restUsername: destRestUsername || '',
      restPassword: destRestPassword || '',
    },
    concurrency: Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY),
    from,
    to,
    plan: [],
    currentDate: null,
    totals: {
      totalStudies: 0,
      doneStudies: 0,
      totalDates,
      doneDates: 0,
    },
    errors: [],
    searchFailures: [],
    stopRequested: false,
    paused: false,
    error: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
  };
}

// กันรันซ้อนกันในกรณีที่ resumeIfNeeded() กับ POST /start ถูกเรียกไล่เลี่ยกัน
let running = false;

async function runMoveJob() {
  if (running) return;
  running = true;

  try {
    const state = moverState.getState();
    if (!state || state.status !== 'running') return;

    const authHeader = buildAuthHeader(state.source.username, state.source.password);
    const orthancUrl = state.source.orthancUrl;
    const { name, aet, host, port, restUrl, restUsername, restPassword } = state.destination;
    const destRestAuthHeader = buildAuthHeader(restUsername, restPassword);
    const concurrency = Math.max(1, Number(state.concurrency) || DEFAULT_CONCURRENCY);

    try {
      await ensureModalityRegistered(orthancUrl, authHeader, name, aet, host, port);
    } catch (err) {
      state.status = 'error';
      state.error = err.message;
      state.finishedAt = Date.now();
      moverState.saveState();
      return;
    }

    // ส่งเคสหนึ่งให้เสร็จ (พร้อม retry และเช็คผลจริงที่ปลายทาง) แล้วอัปเดต state ให้ - เรียกจาก
    // worker หลายตัวพร้อมกันได้ (ดูข้างล่าง) เพราะ Node เป็น single-threaded อยู่แล้ว ไม่มี race
    // จริงๆ แค่สลับ await กัน
    async function processStudy(study, dateEntry) {
      const verifyIfEvicted = () =>
        checkStudyCompleteOnDestination(orthancUrl, authHeader, study.id, restUrl, destRestAuthHeader, study.accessionNumber);

      let lastErr;
      let storeResult;
      for (let attempt = 1; attempt <= STORE_MAX_ATTEMPTS; attempt += 1) {
        try {
          storeResult = await storeResourcesToModality(orthancUrl, authHeader, name, [study.id], verifyIfEvicted);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (!RETRYABLE_ERROR_PATTERN.test(err.message) || attempt === STORE_MAX_ATTEMPTS) break;
          await sleep(STORE_RETRY_DELAY_MS);
        }
      }

      if (lastErr) {
        const message = lastErr.message === 'fetch failed' ? 'เชื่อมต่อ Orthanc ไม่ได้' : lastErr.message;
        study.status = 'error';
        study.message = message;
        state.errors.push({
          date: dateEntry.date,
          studyId: study.id,
          patientName: study.patientName,
          patientId: study.patientId,
          accessionNumber: study.accessionNumber,
          message,
        });
      } else {
        // Orthanc ไม่ throw ไม่ได้แปลว่าเสร็จจริง - เช็คปลายทางจริงเสมอ (ใช้ผลจาก eviction path
        // ซ้ำถ้ามีอยู่แล้ว แทนที่จะเช็คสองรอบ) แล้วเชื่อปลายทางมากกว่า Orthanc ถ้าขัดแย้งกัน
        const verify = storeResult && storeResult.verifiedOnDestination
          ? { complete: true, actualCount: storeResult.actualCount, expectedCount: storeResult.expectedCount }
          : await checkDestinationWithRetry(verifyIfEvicted);

        if (!verify || verify.complete === false) {
          const message = `Orthanc รายงานว่าส่งสำเร็จ แต่${formatDestinationCheckSuffix(verify)}`;
          study.status = 'error';
          study.message = message;
          state.errors.push({
            date: dateEntry.date,
            studyId: study.id,
            patientName: study.patientName,
            patientId: study.patientId,
            accessionNumber: study.accessionNumber,
            message,
          });
        } else {
          // ส่งสำเร็จและเช็คแล้วครบจริง - เป็นการคัดลอก ไม่ลบต้นทาง เก็บผลเทียบจำนวนรูปไว้ให้ดูด้วย
          study.status = 'success';
          study.message = formatDestinationCheckSuffix(verify).replace(/^ - /, '');
        }
      }

      state.totals.doneStudies += 1;
      state.updatedAt = Date.now();
      moverState.saveState();
    }

    const dates = enumerateDates(state.from, state.to);

    for (const day of dates) {
      if (state.stopRequested) break;

      const dicomDay = toDicomDate(day);
      state.currentDate = dicomDay;
      moverState.saveState();

      // ค้นหาทีละวันแทนช่วงเดียวทั้งหมด - เจอวันไหนส่งวันนั้นก่อน ค่อยไปค้นหาวันถัดไป (เหมือน
      // movestudy.js) กันช่วงกว้างๆ ค้นหาทีเดียวช้าเกินไป. ถ้าวันนี้เคยค้นหาไปแล้ว (resume หลัง
      // backend restart) ใช้ผลเดิมใน state.plan เลย ไม่ค้นซ้ำ
      let dateEntry = state.plan.find((d) => d.date === dicomDay);

      if (!dateEntry) {
        let dayStudies = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= STORE_MAX_ATTEMPTS; attempt += 1) {
          try {
            dayStudies = await findStudies(orthancUrl, state.source.username, state.source.password, day, day);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            await sleep(STORE_RETRY_DELAY_MS);
          }
        }

        if (lastErr) {
          state.searchFailures.push({ date: dicomDay, message: lastErr.message });
          state.updatedAt = Date.now();
          moverState.saveState();
          continue;
        }

        dateEntry = {
          date: dicomDay,
          studies: dayStudies.map((s) => ({ ...s, status: 'pending', message: null })),
        };
        state.plan.push(dateEntry);
        state.totals.totalStudies += dateEntry.studies.length;
        state.updatedAt = Date.now();
        moverState.saveState();
      }

      // ข้ามวันที่ทำครบทุกรายการไปแล้ว (resume หลัง restart) หรือวันที่ค้นหาแล้วไม่เจอเคส
      const pendingStudies = dateEntry.studies.filter((s) => s.status === 'pending');
      if (pendingStudies.length > 0) {
        // worker pool จำกัดจำนวนพร้อมกัน (concurrency) - แต่ละ worker ดึงเคสถัดไปจาก
        // pendingStudies ทันทีที่ว่าง เคสที่ช้า/ค้างจะไม่บล็อกเคสอื่นในวันเดียวกัน
        let nextIndex = 0;
        async function worker() {
          while (nextIndex < pendingStudies.length) {
            while (state.paused && !state.stopRequested) {
              await sleep(200);
            }
            if (state.stopRequested) break;
            if (nextIndex >= pendingStudies.length) break;
            const study = pendingStudies[nextIndex];
            nextIndex += 1;
            await processStudy(study, dateEntry);
          }
        }

        await Promise.all(Array.from({ length: concurrency }, () => worker()));
      }

      // คำนวณใหม่จาก plan ทั้งหมดแทนการนับสะสม กัน resume หลัง restart นับซ้ำ
      state.totals.doneDates = state.plan.filter((d) => d.studies.every((s) => s.status !== 'pending')).length;
      state.updatedAt = Date.now();
      moverState.saveState();
    }

    state.status = state.stopRequested ? 'stopped' : 'done';
    state.currentDate = null;
    state.finishedAt = Date.now();
    moverState.saveState();
  } finally {
    running = false;
  }
}

// เรียกตอน backend เริ่มทำงาน - ถ้าสถานะที่บันทึกไว้ค้างอยู่ที่ "running" แปลว่า process
// เพิ่งตาย/restart กลางงาน ให้ทำต่อจากจุดเดิมทันทีโดยไม่ต้องรอใครมากดเริ่มใหม่
function resumeIfNeeded() {
  const state = moverState.getState();
  if (state && state.status === 'running') {
    console.log('[OrthancMover] ---> พบงานย้ายข้อมูลที่ค้างอยู่ กำลังทำงานต่อจากจุดเดิม');
    runMoveJob().catch((err) => {
      console.error('[OrthancMover] ---> เกิดข้อผิดพลาดขณะทำงานต่อ:', err.message);
    });
  }
}

module.exports = {
  buildJob,
  runMoveJob,
  resumeIfNeeded,
  DEST_MODALITY_NAME,
  enumerateDates,
  STORE_MAX_ATTEMPTS,
  STORE_RETRY_DELAY_MS,
};
