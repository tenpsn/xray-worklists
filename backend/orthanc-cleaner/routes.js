const express = require('express');
const orthancService = require('./orthancService');

const router = express.Router();

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

router.post('/delete', async (req, res) => {
  const { orthancUrl, username, password, items } = req.body;
  if (!orthancUrl || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'ไม่มีรายการให้ลบ' });
  }
  try {
    const results = await orthancService.deleteStudies(orthancUrl, username, password, items);
    const failed = results.filter((r) => !r.success);
    res.json({ success: failed.length === 0, results });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'เกิดข้อผิดพลาดที่ไม่คาดคิด' });
  }
});

module.exports = router;
