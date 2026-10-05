// API ของหน้าคิวส่งภาพ รับค่าการตั้งค่าและฟังก์ชันที่ใช้ร่วมกับหน้าตั้งค่าหลักเข้ามา
const express = require('express');
const imageStoreService = require('./imageStoreService');
const pacsForwardService = require('./pacsForwardService');
const imagehubService = require('./imagehubService');
const imagehubAuth = require('./imagehubAuth');
const imageQueue = require('./imageQueue');
const imageCleanup = require('./imageCleanup');

function createImageQueueRoutes(deps) {
  const { getSettings, saveSettings, applyImageSettings, maskSecrets, reconcileSecrets, toDisplayPath } = deps;
  const router = express.Router();

  // รายการภาพในคิวพร้อมสถานะ PACS และ ImageHub ของแต่ละไฟล์
  router.get('/', (req, res) => {
    const receiver = imageStoreService.getStatus();
    const pacs = pacsForwardService.getForwardingStatus();
    const imagehub = imagehubService.getForwardingStatus();
    const settings = getSettings();
    res.json({
      success: true,
      receiver: { ...receiver, queueDir: toDisplayPath(receiver.queueDir) },
      pacs,
      imagehub: { ...imagehub, redirectUri: (settings.imagehub && settings.imagehub.redirectUri) || '' },
      warnings: imageCleanup.getWarnings(),
      ...imageQueue.buildOverview({ pacs: pacs.sending, imagehub: imagehub.sending }),
    });
  });

  // อัปโหลดไฟล์ DICOM เองจากหน้าเว็บทีละไฟล์
  // ไฟล์เข้าคิวเดียวกับภาพจากเครื่องเอกซเรย์ แล้วส่งต่อตามปลายทางที่เปิดไว้
  router.post('/upload', async (req, res) => {
    const result = await imageStoreService.acceptUpload(req);
    if (!result.ok) return res.status(400).json({ success: false, message: result.message });
    res.json({ success: true, uid: result.uid, patientId: result.patientId, modality: result.modality });
  });

  // ส่งใหม่จากโฟลเดอร์ failed และเริ่มนับครั้งที่ล้มเหลวใหม่
  router.post('/failed/restore', (req, res) => {
    const uid = String((req.body && req.body.uid) || '');
    try {
      if (!imageQueue.restoreFromFailed(uid)) return res.status(404).json({ success: false, message: 'ไม่พบภาพนี้ในโฟลเดอร์ failed' });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
    console.log(`[Image Queue] ---> ย้ายภาพ ${uid} จากโฟลเดอร์ failed กลับเข้าคิวเพื่อส่งใหม่`);
    pacsForwardService.kick();
    imagehubService.kick();
    res.json({ success: true });
  });

  // สถานะการรับภาพและจำนวนไฟล์ในคิว
  router.get('/receiver', (req, res) => {
    const status = imageStoreService.getStatus();
    res.json({ success: true, ...status, queueDir: toDisplayPath(status.queueDir) });
  });

  // บันทึกการตั้งค่ารับภาพและส่งต่อ PACS กับ ImageHub เฉพาะส่วนนี้
  // secret ถูกปิดบังก่อนส่งไปหน้าเว็บ ถ้าได้ค่าปิดบังกลับมาจะคงค่าเดิมไว้
  function settingsResponse() {
    const settings = getSettings();
    return {
      imageStore: settings.imageStore,
      pacs: settings.pacs,
      imagehub: maskSecrets(settings.imagehub),
    };
  }

  router.get('/settings', (req, res) => {
    res.json({ success: true, ...settingsResponse() });
  });

  router.post('/settings', async (req, res) => {
    try {
      const { imageStore, pacs, imagehub } = req.body || {};
      const reconciledImagehub = imagehub ? reconcileSecrets(imagehub, getSettings().imagehub) : undefined;
      const settings = saveSettings({ imageStore, pacs, imagehub: reconciledImagehub });
      const warnings = await applyImageSettings(settings);
      res.json({ success: true, ...settingsResponse(), warningText: warnings.join(' | ') });
    } catch (err) {
      console.error('[Image Queue] ---> บันทึกการตั้งค่าไม่สำเร็จ:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ทดสอบเชื่อมต่อ PACS โดยไม่ส่งภาพ ใช้ค่าในฟอร์มได้เลยไม่ต้องบันทึกก่อน
  router.post('/pacs-echo', async (req, res) => {
    const { aet, host, port } = req.body || {};
    const settings = getSettings();
    const callingAet = (settings.imageStore && settings.imageStore.aet) || 'XRAYWL_STORE';
    const result = await pacsForwardService.echo({ aet: String(aet || '').trim(), host: String(host || '').trim(), port: String(port || '').trim(), callingAet });
    res.json({ success: result.ok, message: result.message });
  });

  // เข้าสู่ระบบ MOPH เพื่อขอ token ImageHub หน้าเว็บส่งแค่ code มา secret อยู่ฝั่งนี้เท่านั้น
  router.post('/imagehub/login-url', (req, res) => {
    try {
      const redirectUri = String((req.body && req.body.redirectUri) || '').trim();
      if (!redirectUri) return res.status(400).json({ success: false, message: 'ไม่มี redirect_uri' });
      res.json({ success: true, url: imagehubAuth.getLoginUrl(getSettings().imagehub || {}, redirectUri) });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  router.post('/imagehub/exchange', async (req, res) => {
    const { code, redirectUri } = req.body || {};
    if (!code || !redirectUri) return res.status(400).json({ success: false, message: 'ต้องมี code และ redirect_uri' });
    try {
      const token = await imagehubAuth.exchangeCode(getSettings().imagehub || {}, String(code), String(redirectUri));
      imagehubService.onTokenRenewed();
      res.json({ success: true, token });
    } catch (err) {
      console.error('[ImageHub Auth] ---> เข้าสู่ระบบไม่สำเร็จ:', err.message);
      res.status(502).json({ success: false, message: err.message });
    }
  });

  // สถานะ token สำหรับแสดงในหน้าเว็บ ไม่ส่งตัว token ออกไป
  router.get('/imagehub/token', (req, res) => {
    res.json({ success: true, token: imagehubAuth.getTokenStatus() });
  });

  router.post('/imagehub/logout', (req, res) => {
    imagehubAuth.logout();
    res.json({ success: true, token: imagehubAuth.getTokenStatus() });
  });

  return router;
}

module.exports = { createImageQueueRoutes };
