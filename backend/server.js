require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dicomService = require('./dicomService');
const settingsService = require('./settingsService');
const db = require('./db');
const mppsService = require('./mppsService');

const app = express();
const PORT = process.env.PORT;
const CORS_ORIGIN = process.env.CORS_ORIGIN;

// ห้ามส่งค่าจริงกลับไปให้ frontend
const SECRET_FIELD_REGEX = /(password|passwd|pwd|secret)/i;

// เพื่อป้องกันรหัสผ่านฐานข้อมูล
function maskSecrets(value) {
  if (Array.isArray(value)) {
    return value.map((item) => maskSecrets(item));
  }
  if (value && typeof value === 'object') {
    const masked = {};
    for (const [key, val] of Object.entries(value)) {
      if (SECRET_FIELD_REGEX.test(key)) {
        masked[key] = val ? '••••••••' : '';
      } else {
        masked[key] = maskSecrets(val);
      }
    }
    return masked;
  }
  return value;
}

// อนุญาตให้ frontend (คนละ port/โดเมน) เรียกเข้ามาได้
app.use(cors({ origin: CORS_ORIGIN }));

// รับข้อมูลแบบ JSON
app.use(express.json());

// โหลดการตั้งค่า (HIS DB + MWL) แล้วเปิด connection pool ตั้งแต่ตอนสตาร์ทเซิร์ฟเวอร์
let currentSettings = settingsService.loadSettings();
db.initPool(currentSettings);

// ตั้งค่าโฟลเดอร์เก็บไฟล์ worklist ตามค่าที่บันทึกไว้ (ถ้าไม่ได้ตั้งไว้ จะใช้ backend/worklists เป็นค่า default)
try {
  dicomService.setWorklistDir(currentSettings.mwl.worklistDir);
} catch (err) {
  console.error('[Server] ---> ตั้งค่าโฟลเดอร์ worklists ไม่สำเร็จ ใช้โฟลเดอร์เดิมต่อไป:', err.message);
}

// เมื่อเครื่อง Modality ส่งสถานะ MPPS กลับมา (ตรวจเสร็จ/ยกเลิก) ให้ลบไฟล์ worklist (.wl) ทิ้ง
// เพื่อไม่ให้เครื่องดึงรายการเดิมไปทำซ้ำอีก (ไม่ได้ไปแก้สถานะใน HIS DB ให้ ยังต้องยืนยันผลที่ HIS ตามปกติ)
function handleMppsStatusChange(accessionNumber, status) {
  if (status === 'COMPLETED' || status === 'DISCONTINUED') {
    dicomService.deleteWorklistFile(accessionNumber);
    console.log(`[MPPS] ---> ลบไฟล์ worklist ของ XN: ${accessionNumber} เนื่องจากสถานะเป็น "${status}"`);
  }
}

// เริ่ม MPPS server ตอนสตาร์ท — ถ้าเริ่มไม่สำเร็จ (เช่น port ถูกใช้งานอยู่แล้วจากอีก process ที่รันซ้อนอยู่)
// ให้ปิดโปรแกรมไปเลยแทนที่จะปล่อยให้รันต่อในสภาพที่ MPPS ใช้งานไม่ได้โดยไม่รู้ตัว
// (PM2 ตั้ง autorestart: true ไว้แล้ว จะลองสตาร์ทให้ใหม่เอง)
try {
  mppsService.startMppsServer(currentSettings.mwl.mppsPort || 7001, handleMppsStatusChange);
} catch (err) {
  console.error('[Server] ---> เริ่ม MPPS server ไม่สำเร็จตอนสตาร์ท ปิดโปรแกรม:', err.message);
  process.exit(1);
}

// หลัง uncaught exception/unhandled rejection เกิดขึ้น ไม่ควรปล่อยให้ process ทำงานต่อ
// เพราะ state ภายใน (DB pool, DICOM listener ฯลฯ) อาจเพี้ยนไปแล้วโดยไม่รู้ตัว (ตามคำแนะนำของ Node.js เอง)
// ให้ log ไว้ให้ชัดเจนแล้ว exit(1) ปล่อยให้ PM2 (autorestart: true) เริ่ม process ใหม่แบบสะอาดแทน
process.on('uncaughtException', (err) => {
  console.error('[Server] ---> Uncaught Exception (ปิดโปรแกรมเพื่อความปลอดภัย ให้ PM2 restart ใหม่):', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] ---> Unhandled Rejection (ปิดโปรแกรมเพื่อความปลอดภัย ให้ PM2 restart ใหม่):', reason);
  process.exit(1);
});
process.on('SIGINT', () => {
  mppsService.stopMppsServer();
  process.exit(0);
});
process.on('SIGTERM', () => {
  mppsService.stopMppsServer();
  process.exit(0);
});

// เพิ่ม parameter รับอาร์เรย์แต่ละสถานะเข้ามา + dbType (postgres/mysql) เพื่อสลับ syntax วันที่ให้ถูกต้อง
function buildXrayReportQuery(dateback, include, exclude, confirm, existingXNs = [], xns_NN = [], xns_YN = [], xns_NY = [], dbType = 'postgres') {
  const params = [];
  let paramIndex = 1;

  const safeDateback = Number.isFinite(Number(dateback)) ? Number(dateback) : 0;

  // เงื่อนไขช่วงวันที่ ต่างกันระหว่าง Postgres กับ MySQL
  const dateFilter = dbType === 'mysql'
    ? `a.request_date BETWEEN DATE_SUB(CURDATE(), INTERVAL $${paramIndex} DAY) AND CURDATE()`
    : `a.request_date BETWEEN current_date - $${paramIndex}::integer AND current_date`;

  let sql = `
    SELECT 
      a.xn, b.hn, b.cid, b.pname, b.fname, b.lname, b.birthday, b.sex,
      c.xray_items_name AS xraylist, a.request_date AS "StudyDate",
      a.request_time AS "StudyTime", c.xray_items_group, a.confirm, a.confirm_read_film,
      d.name AS "Doctor", a.xray_items_code, '' AS "Modality",
      '' AS stuid, h.department_name
    FROM xray_report a
      INNER JOIN patient b ON a.hn = b.hn
      LEFT JOIN xray_items c ON a.xray_items_code = c.xray_items_code
      INNER JOIN doctor d ON a.request_doctor = d.code
      LEFT JOIN xray_head h ON a.vn = h.vn
    WHERE ${dateFilter}
  `;

  params.push(safeDateback);
  paramIndex++;

  if (include && include.trim() !== '') {
    sql += ` AND c.xray_items_name LIKE $${paramIndex}`;
    params.push(`%${include}%`);
    paramIndex++;
  }

  if (exclude && exclude.trim() !== '') {
    sql += ` AND c.xray_items_name NOT LIKE $${paramIndex}`;
    params.push(`%${exclude}%`);
    paramIndex++;
  }

  if (confirm) {
    sql += ` AND a.confirm = 'N'`;
  }

  // --- ส่วนที่แก้ไข: กรองแบบเจาะจงการเปลี่ยนสถานะ ---
  if (existingXNs && existingXNs.length > 0) {
    // เอา XN ที่มีอยู่แล้วตัดออกไปก่อนเป็นพื้นฐาน
    const existingPlaceholders = existingXNs.map((_, i) => `$${paramIndex + i}`).join(', ');
    let filterSql = `a.xn NOT IN (${existingPlaceholders})`;
    params.push(...existingXNs);
    paramIndex += existingXNs.length;

    // ถ้าหน้าบ้านมีสถานะ N,N -> จะดึงข้อมูลกลับมาก็ต่อเมื่อ DB เปลี่ยนตัวใดตัวหนึ่งเป็น Y แล้ว
    if (xns_NN && xns_NN.length > 0) {
      const nnPlaceholders = xns_NN.map((_, i) => `$${paramIndex + i}`).join(', ');
      filterSql += ` OR (a.xn IN (${nnPlaceholders}) AND (COALESCE(a.confirm, 'N') = 'Y' OR COALESCE(a.confirm_read_film, 'N') = 'Y'))`;
      params.push(...xns_NN);
      paramIndex += xns_NN.length;
    }
    
    // ถ้าหน้าบ้านมีสถานะ Y,N -> จะดึงข้อมูลกลับมาก็ต่อเมื่อ DB เปลี่ยน confirm_read_film เป็น Y แล้ว
    if (xns_YN && xns_YN.length > 0) {
      const ynPlaceholders = xns_YN.map((_, i) => `$${paramIndex + i}`).join(', ');
      filterSql += ` OR (a.xn IN (${ynPlaceholders}) AND COALESCE(a.confirm_read_film, 'N') = 'Y')`;
      params.push(...xns_YN);
      paramIndex += xns_YN.length;
    }

    // ถ้าหน้าบ้านมีสถานะ N,Y -> จะดึงข้อมูลกลับมาก็ต่อเมื่อ DB เปลี่ยน confirm เป็น Y แล้ว
    if (xns_NY && xns_NY.length > 0) {
      const nyPlaceholders = xns_NY.map((_, i) => `$${paramIndex + i}`).join(', ');
      filterSql += ` OR (a.xn IN (${nyPlaceholders}) AND COALESCE(a.confirm, 'N') = 'Y')`;
      params.push(...xns_NY);
      paramIndex += xns_NY.length;
    }

    sql += ` AND (${filterSql})`;
  }

  sql += ` ORDER BY a.request_date DESC, a.request_time DESC`;

  return { sql, params };
}

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'disconnected', error: db.friendlyErrorMessage(err) });
  }
});

app.get('/api/settings', (req, res) => {
  res.json({
    success: true,
    settings: maskSecrets(currentSettings),
    worklistDirActive: dicomService.getWorklistDir(), // path จริงที่ใช้งานอยู่ตอนนี้ (เผื่อฟิลด์ว่างไว้แล้วใช้ค่า default)
  });
});

function reconcileSecrets(incoming, existing) {
  if (Array.isArray(incoming)) {
    return incoming.map((item, i) => reconcileSecrets(item, existing ? existing[i] : undefined));
  }
  if (incoming && typeof incoming === 'object') {
    const result = {};
    for (const [key, val] of Object.entries(incoming)) {
      const existingVal = existing ? existing[key] : undefined;
      if (SECRET_FIELD_REGEX.test(key)) {
        result[key] = (val === '' || val === '••••••••' || val === undefined) ? existingVal : val;
      } else {
        result[key] = reconcileSecrets(val, existingVal);
      }
    }
    return result;
  }
  return incoming;
}

app.post('/api/settings', async (req, res) => {
  try {
    const { his, mwl } = req.body;
    const reconciledHis = reconcileSecrets(his, currentSettings.his);
    const reconciledMwl = reconcileSecrets(mwl, currentSettings.mwl);

    currentSettings = settingsService.saveSettings({ his: reconciledHis, mwl: reconciledMwl });
    db.initPool(currentSettings);

    // สลับไปใช้โฟลเดอร์ worklist ใหม่ตามที่ตั้งค่ามา (ถ้าตั้งไม่สำเร็จ เช่น path ผิด/ไม่มีสิทธิ์ ให้แจ้งเตือนแต่ไม่ทำให้บันทึกค่าอื่นล้มเหลวไปด้วย)
    let worklistDirWarning = '';
    try {
      dicomService.setWorklistDir(currentSettings.mwl.worklistDir);
    } catch (dirErr) {
      console.error('[Settings] ---> ตั้งค่าโฟลเดอร์ worklists ไม่สำเร็จ:', dirErr);
      worklistDirWarning = ` (คำเตือน: ตั้งค่าโฟลเดอร์ worklists ไม่สำเร็จ - ${dirErr.message} ระบบจะใช้โฟลเดอร์เดิมต่อไป: ${dicomService.getWorklistDir()})`;
    }

    // เริ่ม MPPS server ใหม่ด้วย port ล่าสุด — ถ้าเริ่มไม่สำเร็จ (เช่น port ชนกับโปรแกรมอื่น) แค่แจ้งเตือน
    // ไม่ทำให้การบันทึกค่าอื่นๆ (DB, worklist dir) ล้มเหลวไปด้วย และไม่ปิดทั้งเซิร์ฟเวอร์ทิ้ง
    try {
      mppsService.startMppsServer(currentSettings.mwl.mppsPort || 7001, handleMppsStatusChange);
    } catch (mppsErr) {
      console.error('[Settings] ---> เริ่ม MPPS server ที่พอร์ตใหม่ไม่สำเร็จ:', mppsErr.message);
      worklistDirWarning += ` (คำเตือน: เริ่ม MPPS server ที่พอร์ตใหม่ไม่สำเร็จ - ${mppsErr.message} ระบบจะยังไม่รับสถานะ MPPS จากเครื่อง Modality จนกว่าจะแก้ port ให้ถูกต้อง)`;
    }

    // ทดสอบว่าต่อฐานข้อมูลได้จริงหรือไม่ หลังบันทึกค่าใหม่
    try {
      await db.query('SELECT 1');
      res.json({
        success: true,
        settings: maskSecrets(currentSettings),
        worklistDirActive: dicomService.getWorklistDir(),
        message: `บันทึกการตั้งค่าเรียบร้อย และเชื่อมต่อฐานข้อมูลสำเร็จ${worklistDirWarning}`,
      });
    } catch (dbErr) {
      console.error('[Settings] ---> เชื่อมต่อฐานข้อมูลไม่สำเร็จหลังบันทึกค่าใหม่:', dbErr);
      const friendlyMessage = db.friendlyErrorMessage(dbErr);
      res.json({
        success: false,
        settings: maskSecrets(currentSettings),
        worklistDirActive: dicomService.getWorklistDir(),
        message: `บันทึกการตั้งค่าแล้ว แต่เชื่อมต่อฐานข้อมูลไม่สำเร็จ: ${friendlyMessage}${worklistDirWarning}`,
        error: dbErr.message,
      });
    }
  } catch (err) {
    console.error('[Settings] ---> บันทึกไม่สำเร็จ:', err);
    res.status(500).json({ success: false, message: 'บันทึกการตั้งค่าไม่สำเร็จ', error: err.message });
  }
});

let isProcessingXrayReport = false;

let isGeneratingWorklists = false;

// จำนวนไฟล์ worklist ที่ยอมให้สร้าง/แปลง พร้อมกัน ปรับตัวเลขนี้ได้ตามสเปคเครื่อง เพิ่มเป็น 10-15 ก็ได้เพื่อให้เร็วขึ้น
const WORKLIST_CONCURRENCY = 5;

async function processWorklistFiles(records, displayLang) {
  if (isGeneratingWorklists) {
    console.warn('[Worklist] ---> รอบก่อนหน้ายังสร้างไฟล์ไม่เสร็จ ข้ามรอบนี้ไปก่อน (รอบถัดไปจะจับข้อมูลที่เปลี่ยนแปลงเองอยู่แล้ว)');
    return;
  }
  isGeneratingWorklists = true;

  try {
    for (let i = 0; i < records.length; i += WORKLIST_CONCURRENCY) {
      const batch = records.slice(i, i + WORKLIST_CONCURRENCY);
      await Promise.all(batch.map(async (record) => {
        try {

          record.lang = displayLang;

          // ถ้าสถานะเป็น Y, Y ให้ลบไฟล์ทิ้ง
          if (record.confirm === 'Y' && record.confirm_read_film === 'Y') {
            dicomService.deleteWorklistFile(record.xn);
          } else {
            // ถ้ายังไม่เป็น Y, Y ถึงจะสร้างไฟล์
            await dicomService.generateWorklistFile(record);
          }
        } catch (err) {
          console.error(`[DICOM Error] ---> ผิดพลาดในการสร้างไฟล์ XN: ${record.xn}`, err);
        }
      }));
    }
  } finally {
    isGeneratingWorklists = false;
  }
}

app.post('/api/xray-report', async (req, res) => {
  if (isProcessingXrayReport) {
    return res.status(429).json({ success: false, message: ' ---> กำลังประมวลผลรอบก่อนหน้าอยู่ กรุณาลองใหม่อีกครั้ง' });
  }
  isProcessingXrayReport = true;
  try {
    // ดึงตัวแปรใหม่ที่ส่งมาจาก Frontend มารับใน req.body
    const { dateback = 1, include, exclude, confirm, lang, existingXNs, xns_NN, xns_YN, xns_NY } = req.body;
    const confirmFlag = confirm === true || confirm === 'true' || confirm === '1';
    const displayLang = lang === 'en' ? 'en' : 'th';

    // ส่งค่าทั้งหมดเข้าไปในฟังก์ชันสร้าง SQL (พร้อม dbType ปัจจุบัน)
    const { sql, params } = buildXrayReportQuery(
      dateback, include, exclude, confirmFlag,
      existingXNs, xns_NN, xns_YN, xns_NY,
      currentSettings.his.dbType
    );

    const result = await db.query(sql, params);
    const records = result.rows;

    records.forEach((record) => {
      record.lang = displayLang;
    });

    res.json({ success: true, count: result.rowCount, data: records });

    if (records.length > 0) {
      processWorklistFiles(records, displayLang).catch((err) => {
        console.error('[Worklist] ---> เกิดข้อผิดพลาดขณะสร้างไฟล์ worklist แบบ background:', err);
      });
    }
  } catch (err) {
    console.error('Query error:', err);
    const friendlyMessage = db.friendlyErrorMessage(err);
    res.status(500).json({ success: false, message: friendlyMessage });
  } finally {
    isProcessingXrayReport = false;
  }
});

// เช็คว่า path ที่ให้มาเป็น "ราก" ของไดรฟ์ Windows หรือไม่ เช่น "D:\" หรือ "D:"
function isWindowsDriveRoot(p) {
  return /^[a-zA-Z]:[\\/]?$/.test(p);
}

// หาไดรฟ์ทั้งหมดที่มีอยู่จริงบนเครื่อง Windows (A: - Z:) โดยเช็คว่าเข้าถึงได้จริงหรือไม่
function listWindowsDrives() {
  const drives = [];
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i);
    const root = `${letter}:\\`;
    try {
      if (fs.existsSync(root)) {
        drives.push({ name: `${letter}:`, path: root });
      }
    } catch (err) {
      // ข้ามไดรฟ์นี้ไป (เช่น ไดรฟ์ CD-ROM ที่ไม่มีแผ่น)
    }
  }
  return drives;
}

// ถ้าไม่ส่ง path หรือส่งค่าว่าง จะคืนรายชื่อไดรฟ์ทั้งหมดให้เลือกก่อน
app.get('/api/fs/browse', (req, res) => {
  const platform = os.platform();
  let targetPath = (req.query.path || '').toString().trim();

  try {
    if (!targetPath) {
      if (platform === 'win32') {
        return res.json({ success: true, path: '', parent: null, isRoot: true, folders: listWindowsDrives() });
      }
      targetPath = '/'; // Linux/Mac ไม่มีแนวคิดไดรฟ์ ให้เริ่มที่ root เลย
    }

    const resolved = path.resolve(targetPath);

    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch (err) {
      return res.status(400).json({ success: false, message: 'ไม่พบโฟลเดอร์นี้: ' + err.message });
    }

    if (!stat.isDirectory()) {
      return res.status(400).json({ success: false, message: 'path ที่ระบุไม่ใช่โฟลเดอร์' });
    }

    let entries = [];
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch (err) {
      return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เข้าถึงโฟลเดอร์นี้: ' + err.message });
    }

    const folders = entries
      .filter((entry) => {
        try {
          return entry.isDirectory();
        } catch (err) {
          return false; // ข้าม entry ที่ stat ไม่ได้ (เช่น junction เสีย)
        }
      })
      .map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'th'));

    // หา parent ของ path ปัจจุบัน เพื่อทำปุ่ม "ย้อนกลับ"
    let parent;
    if (platform === 'win32' && isWindowsDriveRoot(resolved)) {
      parent = ''; // อยู่ที่รากไดรฟ์แล้ว ย้อนกลับ = กลับไปหน้าเลือกไดรฟ์
    } else {
      const up = path.dirname(resolved);
      parent = up === resolved ? null : up; // ถึง root ของระบบไฟล์แล้ว (เช่น "/" บน Linux) ไม่มี parent ต่อ
    }

    res.json({ success: true, path: resolved, parent, isRoot: false, folders });
  } catch (err) {
    res.status(400).json({ success: false, message: 'เปิดโฟลเดอร์นี้ไม่ได้: ' + err.message });
  }
});

// POST /api/fs/mkdir { parentPath, name } -> สร้างโฟลเดอร์ย่อยใหม่ในตำแหน่งที่กำลังดูอยู่
app.post('/api/fs/mkdir', (req, res) => {
  try {
    const { parentPath, name } = req.body;
    const safeName = (name || '').trim();

    if (!parentPath || !safeName) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุตำแหน่งและชื่อโฟลเดอร์' });
    }
    // กันชื่อโฟลเดอร์ที่มีอักขระอันตราย ไม่ให้หลุดออกนอกโฟลเดอร์ปัจจุบันได้
    if (safeName.includes('/') || safeName.includes('\\') || safeName.includes('..')) {
      return res.status(400).json({ success: false, message: 'ชื่อโฟลเดอร์ไม่ถูกต้อง (ห้ามมี / \\ หรือ ..)' });
    }

    const newPath = path.join(parentPath, safeName);
    fs.mkdirSync(newPath, { recursive: false });
    res.json({ success: true, path: newPath });
  } catch (err) {
    res.status(400).json({ success: false, message: 'สร้างโฟลเดอร์ไม่สำเร็จ: ' + err.message });
  }
});

const httpServer = app.listen(PORT, () => {
  console.log(`Backend API กำลังทำงานที่ ---> http://localhost:${PORT}`);
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] ---> Port ${PORT} ถูกใช้งานอยู่แล้วอาจมีอีก process รันซ้อนอยู่`);
  } else {
    console.error('[Server] ---> เปิด server หลักไม่สำเร็จ:', err);
  }
  process.exit(1);
});