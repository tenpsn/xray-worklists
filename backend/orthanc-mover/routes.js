const express = require('express');
const { buildJob, runMoveJob } = require('./orthancMoverService');
const moverState = require('./moverState');

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
    return res.status(409).json({ success: false, message: 'มีงานย้ายข้อมูลกำลังทำงานอยู่ กรุณารอให้เสร็จก่อน' });
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
      moverState.saveSummary();
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

module.exports = router;
