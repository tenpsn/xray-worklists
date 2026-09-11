const express = require('express');
const { findStudies } = require('../orthanc-cleaner/orthancService');
const {
  buildJob,
  runMoveJob,
  enumerateDates,
  STORE_MAX_ATTEMPTS,
  STORE_RETRY_DELAY_MS,
} = require('./orthancMoverService');
const moverState = require('./moverState');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const router = express.Router();

// ห้ามส่ง password ของ Orthanc ต้นทาง/ปลายทางกลับไปให้ frontend
function sanitizeStateForClient(state) {
  if (!state) return state;
  const { source, destination, ...rest } = state;
  return {
    ...rest,
    source: source ? { orthancUrl: source.orthancUrl, username: source.username } : undefined,
    destination: destination
      ? {
          name: destination.name,
          aet: destination.aet,
          host: destination.host,
          port: destination.port,
          restUrl: destination.restUrl,
          restUsername: destination.restUsername,
        }
      : undefined,
  };
}

router.post('/preview', async (req, res) => {
  const { orthancUrl, username, password, from, to } = req.body;
  if (!orthancUrl || !from || !to) {
    return res.status(400).json({ success: false, message: 'กรุณากรอก Orthanc URL, วันที่เริ่ม และวันที่สิ้นสุดให้ครบ' });
  }

  // ค้นหาทีละวันแทนช่วงเดียวทั้งหมด (พร้อม retry ต่อวัน) เหมือนตอน "Start moving" จริง - ช่วง
  // กว้างๆ ค้นหาทีเดียวเสี่ยง proxy timeout ระหว่างทางไป Orthanc ต้นทาง (เช่น nginx หน้า Orthanc
  // จริง) ถ้าบางวันค้นหาไม่สำเร็จแม้ retry แล้ว ข้ามวันนั้นไปแทนที่จะทำให้ preview ทั้งหมดพัง
  const dates = enumerateDates(from, to);
  const countByDate = {};
  const searchFailures = [];
  let total = 0;

  for (const day of dates) {
    let dayStudies = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= STORE_MAX_ATTEMPTS; attempt += 1) {
      try {
        dayStudies = await findStudies(orthancUrl, username, password, day, day);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await sleep(STORE_RETRY_DELAY_MS);
      }
    }

    if (lastErr) {
      const message = lastErr.message === 'fetch failed' ? 'เชื่อมต่อ Orthanc ไม่ได้' : lastErr.message;
      searchFailures.push({ date: day, message });
      continue;
    }

    if (dayStudies.length > 0) {
      const dicomDay = dayStudies[0].studyDate || day.replace(/-/g, '');
      countByDate[dicomDay] = (countByDate[dicomDay] || 0) + dayStudies.length;
      total += dayStudies.length;
    }
  }

  if (total === 0 && searchFailures.length === dates.length) {
    // ค้นหาไม่สำเร็จเลยสักวันเดียว (ไม่ใช่แค่ไม่เจอเคส) - นี่ถือเป็นปัญหาเชื่อมต่อจริง แจ้ง error
    return res.status(502).json({
      success: false,
      message: searchFailures[0]?.message || 'เชื่อมต่อ Orthanc ไม่ได้ กรุณาตรวจสอบ Orthanc URL และเครือข่าย',
    });
  }

  const days = Object.keys(countByDate)
    .sort()
    .map((date) => ({ date, count: countByDate[date] }));
  res.json({ success: true, total, days, searchFailures });
});

router.post('/start', async (req, res) => {
  const {
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
  } = req.body;
  if (!orthancUrl || !from || !to || !destAet || !destHost || !destPort) {
    return res.status(400).json({
      success: false,
      message: 'กรุณากรอก Orthanc URL, ช่วงวันที่ และ AE Title/Host/Port ของ PACS ปลายทางให้ครบ',
    });
  }

  const current = moverState.getState();
  if (current && current.status === 'running') {
    return res.status(409).json({ success: false, message: 'มีงานย้ายข้อมูลกำลังทำงานอยู่ กรุณารอให้เสร็จหรือกดหยุดก่อน' });
  }

  try {
    const job = await buildJob({
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
    });
    moverState.setState(job);

    runMoveJob().catch((err) => {
      console.error('[OrthancMover] ---> เกิดข้อผิดพลาดขณะรันงาน:', err.message);
      const state = moverState.getState();
      state.status = 'error';
      state.error = err.message;
      state.finishedAt = Date.now();
      moverState.saveState();
    });

    res.json({ success: true, state: sanitizeStateForClient(job) });
  } catch (err) {
    const message = err.message === 'fetch failed'
      ? 'เชื่อมต่อ Orthanc ไม่ได้ กรุณาตรวจสอบ Orthanc URL และเครือข่าย'
      : err.message;
    res.status(502).json({ success: false, message });
  }
});

router.get('/status', (req, res) => {
  res.json({ success: true, state: sanitizeStateForClient(moverState.getState()) });
});

router.post('/stop', (req, res) => {
  const state = moverState.getState();
  if (!state || state.status !== 'running') {
    return res.status(400).json({ success: false, message: 'ไม่มีงานที่กำลังทำงานอยู่' });
  }
  state.stopRequested = true;
  moverState.saveState();
  res.json({ success: true });
});

router.post('/pause', (req, res) => {
  const state = moverState.getState();
  if (!state || state.status !== 'running') {
    return res.status(400).json({ success: false, message: 'ไม่มีงานที่กำลังทำงานอยู่' });
  }
  state.paused = true;
  moverState.saveState();
  res.json({ success: true });
});

router.post('/resume', (req, res) => {
  const state = moverState.getState();
  if (!state || state.status !== 'running') {
    return res.status(400).json({ success: false, message: 'ไม่มีงานที่กำลังทำงานอยู่' });
  }
  state.paused = false;
  moverState.saveState();
  res.json({ success: true });
});

module.exports = router;
