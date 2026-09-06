const {
  buildAuthHeader,
  normalizeOrthancUrl,
  ensureModalityRegistered,
  storeResourcesToModality,
} = require('../orthanc-shared/orthancClient');
const { findStudies } = require('../orthanc-cleaner/orthancService');
const moverState = require('./moverState');

// ชื่อ modality ที่จะลงทะเบียนบน Orthanc ต้นทางแทน PACS ปลายทางที่ผู้ใช้กรอกมา
// ต้องใช้ "-" ไม่ใช่ "_" เพราะ Orthanc รุ่นเก่า (เช่น 1.5.8) validate ชื่อ modality/peer
// ให้เป็นแค่ตัวอักษร/ตัวเลข/ขีดกลางเท่านั้น (รุ่นใหม่รับ "_" ได้ แต่รุ่นเก่าจะขึ้น 400 Bad Request)
const DEST_MODALITY_NAME = 'MOVER-DEST';

const STORE_MAX_ATTEMPTS = 3;
const STORE_RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// จัดกลุ่ม Study ตามวันที่ศึกษา เรียงวันที่จากน้อยไปมาก ให้ worker ทำทีละวันตามลำดับ
function groupStudiesByDate(studies) {
  const byDate = new Map();
  for (const s of studies) {
    const date = s.studyDate || 'UNKNOWN';
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({ ...s, status: 'pending', message: null });
  }
  return Array.from(byDate.keys())
    .sort()
    .map((date) => ({ date, studies: byDate.get(date) }));
}

async function buildJob({ orthancUrl, username, password, from, to, destAet, destHost, destPort }) {
  const studies = await findStudies(orthancUrl, username, password, from, to);
  const plan = groupStudiesByDate(studies);

  return {
    status: 'running',
    source: { orthancUrl: normalizeOrthancUrl(orthancUrl), username, password },
    destination: { name: DEST_MODALITY_NAME, aet: destAet, host: destHost, port: Number(destPort) },
    from,
    to,
    plan,
    currentDate: null,
    totals: {
      totalStudies: studies.length,
      doneStudies: 0,
      totalDates: plan.length,
      doneDates: 0,
    },
    errors: [],
    stopRequested: false,
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
    const { name, aet, host, port } = state.destination;

    try {
      await ensureModalityRegistered(orthancUrl, authHeader, name, aet, host, port);
    } catch (err) {
      state.status = 'error';
      state.error = err.message;
      state.finishedAt = Date.now();
      moverState.saveState();
      return;
    }

    for (const dateEntry of state.plan) {
      if (state.stopRequested) break;

      // ข้ามวันที่ทำครบทุกรายการไปแล้ว (resume หลัง restart)
      const hasPending = dateEntry.studies.some((s) => s.status === 'pending');
      if (!hasPending) continue;

      state.currentDate = dateEntry.date;
      moverState.saveState();

      for (const study of dateEntry.studies) {
        if (state.stopRequested) break;
        if (study.status !== 'pending') continue;

        let lastErr;
        for (let attempt = 1; attempt <= STORE_MAX_ATTEMPTS; attempt += 1) {
          try {
            await storeResourcesToModality(orthancUrl, authHeader, name, [study.id]);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            // "fetch failed" คือหลุดการเชื่อมต่อชั่วคราว (ไม่ใช่ Orthanc/ปลายทางตอบปฏิเสธ) ลองใหม่ได้
            if (err.message !== 'fetch failed' || attempt === STORE_MAX_ATTEMPTS) break;
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
          // ส่งสำเร็จ - เป็นการคัดลอก ไม่ลบต้นทาง
          study.status = 'success';
        }

        state.totals.doneStudies += 1;
        state.updatedAt = Date.now();
        moverState.saveState();
      }

      state.totals.doneDates += 1;
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

module.exports = { buildJob, runMoveJob, resumeIfNeeded, DEST_MODALITY_NAME };
