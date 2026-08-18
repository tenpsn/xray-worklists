const express = require('express');
const crypto = require('crypto');
const orthancService = require('./orthancService');

const router = express.Router();

// เก็บ job ลบเคสไว้ใน memory (พอสำหรับ backend instance เดียว, job หายเมื่อ restart)
const deleteJobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of deleteJobs) {
    if (job.done && now - job.createdAt > JOB_TTL_MS) deleteJobs.delete(id);
  }
}

router.post('/find', async (req, res) => {
  const { orthancUrl, username, password, from, to } = req.body;
  if (!orthancUrl || !from || !to) {
    return res.status(400).json({ success: false, message: 'กรุณากรอก Orthanc URL, วันที่เริ่ม และวันที่สิ้นสุดให้ครบ' });
  }
  try {
    const studies = await orthancService.findStudies(orthancUrl, username, password, from, to);
    res.json({ success: true, studies });
  } catch (err) {
    const message = err.message === 'fetch failed'
      ? 'เชื่อมต่อ Orthanc ไม่ได้ กรุณาตรวจสอบ Orthanc URL และเครือข่าย'
      : err.message;
    res.status(502).json({ success: false, message });
  }
});

router.post('/delete/start', (req, res) => {
  const { orthancUrl, username, password, items } = req.body;
  if (!orthancUrl || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'ไม่มีรายการให้ลบ' });
  }

  cleanupOldJobs();

  const jobId = crypto.randomUUID();
  const job = { total: items.length, processed: 0, results: [], done: false, createdAt: Date.now() };
  deleteJobs.set(jobId, job);

  orthancService.runDeleteJob(job, orthancUrl, username, password, items).catch((err) => {
    job.done = true;
    job.error = err.message || 'เกิดข้อผิดพลาดที่ไม่คาดคิด';
  });

  res.json({ success: true, jobId, total: job.total });
});

router.get('/delete/status/:jobId', (req, res) => {
  const job = deleteJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, message: 'ไม่พบ job ลบเคสนี้' });
  }
  res.json({
    success: true,
    total: job.total,
    processed: job.processed,
    done: job.done,
    error: job.error || null,
    results: job.done ? job.results : [],
  });
});

module.exports = router;
