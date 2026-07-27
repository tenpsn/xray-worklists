require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dicomService = require('./dicomService');
const settingsService = require('./settingsService');
const db = require('./db');
const Mppsservice = require('./Mppsservice');
const hl7Service = require('./hl7Service');

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

// โหลดการตั้งค่า (HIS MWL) 
let currentSettings = settingsService.loadSettings();

// เช็คว่ามีการตั้งค่า Host และ Database แล้วหรือยังก่อนจะเชื่อมต่อ
let dbReadyPromise = Promise.resolve();
if (currentSettings.his && currentSettings.his.host && currentSettings.his.database) {
  dbReadyPromise = db.initPool(currentSettings).catch(err => {
    console.error('[DB] ---> สตาร์ทเซิร์ฟเวอร์เชื่อมต่อ DB ไม่สำเร็จ:', err.message);
  });
} else {
  console.log('[Server] ---> ยังไม่ได้ตั้งค่าฐานข้อมูล รอการตั้งค่าจากหน้าเว็บ');
}

// เพิ่มตัวแปรเช็คสถานะ hl7
let ishl7Enabled = currentSettings.mwl.usehl7 === true;

// ตั้งค่าโฟลเดอร์เก็บไฟล์ worklist ตามค่าที่บันทึกไว้ ถ้าไม่ได้ตั้ง จะใช้ backend/worklists
try {
  dicomService.setWorklistDir(currentSettings.mwl.worklistDir);
} catch (err) {
  console.error('[Server] ---> ตั้งค่าโฟลเดอร์ worklists ไม่สำเร็จ ใช้โฟลเดอร์เดิมต่อไป:', err.message);
}

// เพิ่มตัวแปรสำหรับจดจำ XN ที่ถ่ายเสร็จแล้ว
const mppsCompletedXNs = new Set();

// เมื่อเครื่อง Modality ส่งสถานะ MPPS กลับมา (ตรวจเสร็จ/ยกเลิก) ให้ลบไฟล์ worklist (.wl) ทิ้ง
function handleMppsStatusChange(accessionNumber, status) {
  if (status === 'COMPLETED' || status === 'DISCONTINUED') {
    dicomService.deleteWorklistFile(accessionNumber);

    // บันทึก XN ที่เสร็จแล้วลง Set เพื่อให้ระบบจำไว้
    mppsCompletedXNs.add(accessionNumber);
    console.log(`[MPPS] ---> ลบไฟล์ worklist ของ XN: ${accessionNumber} เนื่องจากสถานะเป็น "${status}"`);
  }
}

try {
  Mppsservice.startMppsServer(currentSettings.mwl.mppsPort || 7001, handleMppsStatusChange);
} catch (err) {
  console.error('[Server] ---> เริ่ม MPPS server ไม่สำเร็จตอนสตาร์ท ปิดโปรแกรม:', err.message);
  process.exit(1);
}

function managehl7Service(settings) {
  ishl7Enabled = settings.mwl.usehl7 === true; // อัปเดตสถานะตรงนี้
  
  if (ishl7Enabled) {
    const hl7Port = settings.mwl.hl7Port;
    hl7Service.starthl7Server(hl7Port);
    console.log('[Server] ---> เปิดใช้งาน HL7 ปิดการดึงข้อมูลจาก DB');
  } else {
    hl7Service.stophl7Server();
    console.log('[Server] ---> ปิดใช้งาน HL7 ดึงข้อมูลจาก DB');
  }
}

managehl7Service(currentSettings);

process.on('uncaughtException', (err) => {
  console.error('[Server] ---> Uncaught Exception ปิดโปรแกรมเพื่อความปลอดภัย ให้ PM2 restart:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] ---> Unhandled Rejection ปิดโปรแกรมเพื่อความปลอดภัย ให้ PM2 restart:', reason);
  process.exit(1);
});
process.on('SIGINT', () => {
  Mppsservice.stopMppsServer();
  process.exit(0);
});
process.on('SIGTERM', () => {
  Mppsservice.stopMppsServer();
  process.exit(0);
});

// dbType (postgres/mysql/mssql) เลือก "ภาษา SQL" ที่ถูกต้องของแต่ละฐานข้อมูล
// - hosxp   -> ต่อได้เฉพาะ mysql/postgres (HOSxP ไม่รองรับ MSSQL)
// - softcon -> ต่อได้ทั้ง mysql/postgres/mssql
function buildXrayReportQuery(dateback, include, exclude, confirm, existingXNs = [], xns_NN = [], xns_YN = [], xns_NY = [], dbType = 'postgres', hisSystem = 'softcon') {
  if (hisSystem === 'hosxp') {
    return buildHosxpQuery(dateback, include, exclude, confirm, existingXNs, xns_NN, xns_YN, xns_NY, dbType);
  }
  return buildSoftconQuery(dateback, include, exclude, existingXNs, dbType);
}

// SoftCon - schema แบบ RadRequestHeader/RadRequest/Patient/Person/Visit
function buildSoftconQuery(dateback, include, exclude, existingXNs, dbType) {
  const params = [];
  let paramIndex = 1;
  const safeDateback = Number.isFinite(Number(dateback)) ? Number(dateback) : 0;

  // ส่วนที่ต่างกันตามฐานข้อมูลแต่ละตัว (วันที่/เวลา/แปลงชนิดข้อมูล)
  let dateWindow, birthdayExpr, studyDateExpr, studyTimeExpr, genderCastType;
  
  if (dbType === 'mysql') {
    dateWindow = `DATEDIFF(CURDATE(), rrh.IssueDT) BETWEEN 0 AND $${paramIndex}`;
    birthdayExpr = `DATE_FORMAT(p.BirthDT, '%Y-%m-%d')`;
    studyDateExpr = `DATE_FORMAT(rrh.IssueDT, '%Y-%m-%d')`;
    studyTimeExpr = `DATE_FORMAT(rrh.IssueDT, '%H:%i:%s')`;
    genderCastType = 'CHAR';
  } else if (dbType === 'mssql') {
    dateWindow = `DATEDIFF(day, rrh.IssueDT, GETDATE()) BETWEEN 0 AND $${paramIndex}`;
    birthdayExpr = `CONVERT(varchar(10), p.BirthDT, 23)`;
    studyDateExpr = `CONVERT(varchar(10), rrh.IssueDT, 23)`;
    studyTimeExpr = `CONVERT(varchar(8), rrh.IssueDT, 108)`;
    genderCastType = 'VARCHAR';
  } else {
    // postgres
    dateWindow = `(CURRENT_DATE - rrh.IssueDT::date) BETWEEN 0 AND $${paramIndex}`;
    birthdayExpr = `TO_CHAR(p.BirthDT, 'YYYY-MM-DD')`;
    studyDateExpr = `TO_CHAR(rrh.IssueDT, 'YYYY-MM-DD')`;
    studyTimeExpr = `TO_CHAR(rrh.IssueDT, 'HH24:MI:SS')`;
    genderCastType = 'VARCHAR';
  }

  let sql = `
    SELECT 
      v.VN as xn, 
      pt.Code as hn, 
      rrh.Code as cid, 
      tt.ShortName as pname,
      p.FirstName as fname, 
      p.LastName as lname,
      ${birthdayExpr} as birthday, 
      CASE 
        WHEN p.GenderKey = -1 THEN '1' 
        WHEN p.GenderKey = -2 THEN '2' 
        ELSE CAST(p.GenderKey AS ${genderCastType})
      END as sex,
      rr.ItemName as xraylist, 
      ${studyDateExpr} as "StudyDate", 
      ${studyTimeExpr} as "StudyTime",
      '' as xray_items_group,
      'N' as confirm, 
      'N' as confirm_read_film,
      LTRIM(CONCAT(tdoc.ShortName, ' ', pd.FirstName, ' ', pd.LastName)) as Doctor,
      rr.ItemKey as xray_items_code, 
      '' as Modality,
      '' as stuid, 
      rr.IssueServiceUnitKey as department_name
    FROM RadRequestHeader rrh
    INNER JOIN RadRequest rr ON rrh.RadRequestHeaderKey = rr.RadRequestHeaderKey
    INNER JOIN Patient pt ON rrh.PatientKey = pt.PatientKey
    INNER JOIN Person p ON pt.PatientKey = p.PersonKey
    LEFT JOIN Title tt ON p.TitleKey = tt.TitleKey
    INNER JOIN Visit v ON v.VisitKey = rrh.VisitKey
    LEFT JOIN Employee doc ON rrh.IssueDoctorKey = doc.EmployeeKey
    LEFT JOIN Person pd ON doc.EmployeeKey = pd.PersonKey
    LEFT JOIN Title tdoc ON pd.TitleKey = tdoc.TitleKey
    WHERE ${dateWindow}
      AND rrh.IsDone = 0
  `;
  params.push(safeDateback);
  paramIndex++;

  if (include && include.trim() !== '') {
    sql += ` AND rr.ItemName LIKE $${paramIndex}`;
    params.push(`%${include}%`);
    paramIndex++;
  }

  if (exclude && exclude.trim() !== '') {
    sql += ` AND rr.ItemName NOT LIKE $${paramIndex}`;
    params.push(`%${exclude}%`);
    paramIndex++;
  }

  if (existingXNs && existingXNs.length > 0) {
    const existingPlaceholders = existingXNs.map((_, i) => `$${paramIndex + i}`).join(', ');
    let filterSql = `v.VN NOT IN (${existingPlaceholders})`;
    params.push(...existingXNs);
    paramIndex += existingXNs.length;
    sql += ` AND (${filterSql})`;
  }

  sql += ` ORDER BY rrh.Code DESC`;
  return { sql, params };
}

// HOSxP - schema แบบ xray_report/patient/xray_items/doctor/xray_head
function buildHosxpQuery(dateback, include, exclude, confirm, existingXNs, xns_NN, xns_YN, xns_NY, dbType) {
  const params = [];
  let paramIndex = 1;
  const safeDateback = Number.isFinite(Number(dateback)) ? Number(dateback) : 0;

  let dateFilter;
  if (dbType === 'mysql') {
    dateFilter = `a.request_date BETWEEN DATE_SUB(CURDATE(), INTERVAL $${paramIndex} DAY) AND CURDATE()`;
  } else if (dbType === 'mssql') {
    dateFilter = `a.request_date BETWEEN DATEADD(day, -$${paramIndex}, CAST(GETDATE() AS DATE)) AND CAST(GETDATE() AS DATE)`;
  } else {
    // postgres (ค่าเริ่มต้น)
    dateFilter = `a.request_date BETWEEN current_date - $${paramIndex}::integer AND current_date`;
  }

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

// ตรวจสอบอัตโนมัติว่าฐานข้อมูลที่กรอกไว้ เป็นระบบ HIS ไหน
// โดยเช็คตาราง xray_report (HOSxP) หรือ RadRequestHeader (SoftCon) อยู่จริงในฐานข้อมูล
app.post('/api/settings/detect-his-system', async (req, res) => {
  try {
    const hisInput = reconcileSecrets(req.body.his || {}, currentSettings.his);
    const { existsHosxp, existsSoftcon } = await db.detectHisSystem(hisInput);

    let detected = null;
    let message;
    if (existsSoftcon && !existsHosxp) {
      detected = 'softcon';
      message = 'ตรวจพบว่าฐานข้อมูลนี้เป็นระบบ SoftCon';
    } else if (existsHosxp && !existsSoftcon) {
      detected = 'hosxp';
      message = 'ตรวจพบว่าฐานข้อมูลนี้เป็นระบบ HOSxP';
    } else if (existsHosxp && existsSoftcon) {
      message = 'พบตารางของทั้ง HOSxP และ SoftCon ในฐานข้อมูลเดียวกัน กรุณาเลือกระบบด้วยตนเอง';
    } else {
      message = 'ไม่พบตารางของ HOSxP หรือ SoftCon ในฐานข้อมูลนี้ กรุณาตรวจสอบชื่อฐานข้อมูล/สิทธิ์ผู้ใช้งานอีกครั้ง';
    }

    res.json({ success: true, detected, existsHosxp, existsSoftcon, message });
  } catch (err) {
    console.error('[Settings] ---> ตรวจสอบระบบ HIS ไม่สำเร็จ:', err.message);
    res.json({
      success: false,
      message: `ตรวจสอบไม่สำเร็จ: ${db.friendlyErrorMessage(err)}`,
      error: err.message,
    });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { his, mwl } = req.body;
    const reconciledHis = reconcileSecrets(his, currentSettings.his);
    const reconciledMwl = reconcileSecrets(mwl, currentSettings.mwl);

    currentSettings = settingsService.saveSettings({ his: reconciledHis, mwl: reconciledMwl });

    managehl7Service(currentSettings);

    let dbConnectError = null;
    try {
      await db.initPool(currentSettings);
    } catch (initErr) {
      console.error('[Settings] ---> เชื่อมต่อฐานข้อมูลด้วยค่าใหม่ไม่สำเร็จ:', initErr.message);
      dbConnectError = initErr;
    }

    // ตั้งค่าใหม่แล้ว รีสตาร์ท background loop สร้างไฟล์ .wl ให้ใช้ค่าล่าสุดทันที (interval/dbType/hisSystem/filter ที่เปลี่ยน)
    startAutoWorklistLoop();

    // สลับไปใช้โฟลเดอร์ worklist ใหม่ตามที่ตั้งค่า
    let worklistDirWarning = '';
    try {
      dicomService.setWorklistDir(currentSettings.mwl.worklistDir);
    } catch (dirErr) {
      console.error('[Settings] ---> ตั้งค่าโฟลเดอร์ worklists ไม่สำเร็จ:', dirErr);
      worklistDirWarning = ` (คำเตือน: ตั้งค่าโฟลเดอร์ worklists ไม่สำเร็จ - ${dirErr.message} ระบบจะใช้โฟลเดอร์เดิมต่อไป: ${dicomService.getWorklistDir()})`;
    }

    // เริ่ม MPPS server ใหม่ด้วย port ล่าสุด — ถ้าเริ่มไม่สำเร็จ จะแจ้งเตือน
    try {
      Mppsservice.startMppsServer(currentSettings.mwl.mppsPort || 7001, handleMppsStatusChange);
    } catch (mppsErr) {
      console.error('[Settings] ---> เริ่ม MPPS server ที่พอร์ตใหม่ไม่สำเร็จ:', mppsErr.message);
      worklistDirWarning += ` (คำเตือน: เริ่ม MPPS server ที่พอร์ตใหม่ไม่สำเร็จ - ${mppsErr.message} ระบบจะยังไม่รับสถานะ MPPS จากเครื่อง Modality จนกว่าจะแก้ port ให้ถูกต้อง)`;
    }

    // ทดสอบว่าต่อฐานข้อมูลได้จริงหรือไม่ หลังบันทึกค่าใหม่
    if (!dbConnectError) {
      try {
        await db.query('SELECT 1');
      } catch (testErr) {
        console.error('[Settings] ---> เชื่อมต่อฐานข้อมูลไม่สำเร็จหลังบันทึกค่าใหม่:', testErr);
        dbConnectError = testErr;
      }
    }

    if (!dbConnectError) {
      res.json({
        success: true,
        settings: maskSecrets(currentSettings),
        worklistDirActive: dicomService.getWorklistDir(),
        message: `บันทึกการตั้งค่าเรียบร้อย และเชื่อมต่อฐานข้อมูลสำเร็จ${worklistDirWarning}`,
      });
    } else {
      const friendlyMessage = db.friendlyErrorMessage(dbConnectError);
      res.json({
        success: false,
        settings: maskSecrets(currentSettings),
        worklistDirActive: dicomService.getWorklistDir(),
        message: `บันทึกการตั้งค่าแล้ว แต่เชื่อมต่อฐานข้อมูลไม่สำเร็จ: ${friendlyMessage}${worklistDirWarning}`,
        error: dbConnectError.message,
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
    console.warn('[Worklist] ---> รอบก่อนหน้ายังสร้างไฟล์ไม่เสร็จ ข้ามรอบนี้ไปก่อน');
    return;
  }
  isGeneratingWorklists = true;

  try {
    // 1. กรองเอาเฉพาะข้อมูลที่ไม่ซ้ำกัน ใช้ xn เป็นตัวตรวจสอบ 
    const uniqueRecords = [];
    const seenXn = new Set();
    
    for (const record of records) {
      if (!seenXn.has(record.xn)) {
        seenXn.add(record.xn);
        uniqueRecords.push(record);
      }
    }

    // 2. ใช้ uniqueRecords ในการสร้างไฟล์
    for (let i = 0; i < uniqueRecords.length; i += WORKLIST_CONCURRENCY) {
      const batch = uniqueRecords.slice(i, i + WORKLIST_CONCURRENCY);
      await Promise.all(batch.map(async (record) => {
        try {
          record.lang = displayLang;

          // แปลง / เป็น - เพื่อเช็คความจำให้ตรงกับฝั่ง MPPS ที่ตอบกลับมา
          const safeXn = String(record.xn).replace(/[\\/:]/g, '-');

          // ถ้าสถานะเป็น Y, Y ให้ลบไฟล์ทิ้ง
          if (record.confirm === 'Y' && record.confirm_read_film === 'Y') {
            dicomService.deleteWorklistFile(record.xn);

            // เคลียร์ความจำทิ้งด้วย เพราะกระบวนการจบสมบูรณ์ใน DB แล้ว
            mppsCompletedXNs.delete(safeXn); 
            mppsCompletedXNs.delete(record.xn);

         } else if (mppsCompletedXNs.has(safeXn) || mppsCompletedXNs.has(record.xn)) {
            // ถ้าเครื่อง X-ray แจ้ง COMPLETED มาแล้ว ให้ "ข้าม" การสร้างไฟล์
            // (ไฟล์จะไม่ถูกสร้างใหม่แม้ใน HOSxP/SoftCon จะยังเป็นสถานะ 'N' ก็ตาม)
            
          } else {
            // ถ้าหมอยังไม่ยืนยัน และเครื่อง X-ray ยังไม่ได้ถ่าย ถึงจะยอมสร้างไฟล์
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

// สร้างไฟล์ .wl อัตโนมัติ
let autoGenIntervalHandle = null;
let isAutoGenRunning = false;

async function runAutoWorklistCycle() {
  if (isAutoGenRunning) return; // กันรอบซ้อน
  if (ishl7Enabled) return; // โหมด HL7 ไม่ต้องดึงข้อมูลจาก DB

  // ถ้ายัังไม่ได้ตั้งค่าฐานข้อมูลให้หยุดทำงาน
  const hisConfig = currentSettings.his || {};
  if (!hisConfig.hisSystem || !hisConfig.host || !hisConfig.database) {
    return;
  }

  const cfg = currentSettings.mwl.autoGenerate || {};
  if (cfg.enabled === false) return;

  isAutoGenRunning = true;
  try {
    const { sql, params } = buildXrayReportQuery(
      cfg.dateback ?? 1,
      cfg.include || '',
      cfg.exclude || '',
      cfg.confirm === true,
      [], [], [], [], // ดึงข้อมูลทั้งหมดในช่วงวันเพื่อให้ไฟล์ .wl ตรงกับ DB เสมอไม่ว่าใครจะเปิดหน้าเว็บอยู่หรือไม่
      currentSettings.his.dbType,
      currentSettings.his.hisSystem
    );
    const result = await db.query(sql, params);
    const records = result.rows;
    if (records.length > 0) {
      await processWorklistFiles(records, currentSettings.mwl.lang);
    }
  } catch (err) {
    console.error('[Worklist Auto] ---> เกิดข้อผิดพลาดขณะสร้างไฟล์ worklist อัตโนมัติ:', err.message);
  } finally {
    isAutoGenRunning = false;
  }
}

function startAutoWorklistLoop() {
  if (autoGenIntervalHandle) {
    clearInterval(autoGenIntervalHandle);
    autoGenIntervalHandle = null;
  }
  const cfg = currentSettings.mwl.autoGenerate || {};
  if (cfg.enabled === false) {
    console.log('[Worklist Auto] ---> ปิดการสร้างไฟล์ .wl อัตโนมัติ');
    return;
  }
  const intervalMs = (cfg.intervalSec || 10) * 1000;
  autoGenIntervalHandle = setInterval(runAutoWorklistCycle, intervalMs);
  console.log(`[Worklist Auto] ---> เริ่มสร้างไฟล์ .wl อัตโนมัติทุก ${intervalMs / 1000} วินาที`);
  runAutoWorklistCycle();
}

app.post('/api/xray-report', async (req, res) => {
  if (isProcessingXrayReport) {
    return res.status(429).json({ success: false, message: 'กำลังประมวลผลรอบก่อนหน้าอยู่ กรุณาลองใหม่อีกครั้ง' });
  }

  const hisConfig = currentSettings.his || {};
  if (!hisConfig.hisSystem || !hisConfig.host || !hisConfig.database) {
    return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล กรุณาไปที่เมนูตั้งค่าระบบ' });
  }

  isProcessingXrayReport = true;
  try {
    const { dateback = 1, include, exclude, confirm, lang, existingXNs, xns_NN, xns_YN, xns_NY } = req.body;
    const confirmFlag = confirm === true || confirm === 'true' || confirm === '1';
    const displayLang = lang === 'en' ? 'en' : 'th';

    const { sql, params } = buildXrayReportQuery(
      dateback, include, exclude, confirmFlag,
      existingXNs, xns_NN, xns_YN, xns_NY,
      currentSettings.his.dbType,
      currentSettings.his.hisSystem
    );

    const result = await db.query(sql, params);
    const records = result.rows;

    records.forEach((record) => {
      record.lang = displayLang;
    });

    res.json({ success: true, count: result.rowCount, data: records });

    if (records.length > 0 && !ishl7Enabled) {
      processWorklistFiles(records, displayLang).catch((err) => {
        console.error('[Worklist] ---> เกิดข้อผิดพลาดขณะสร้างไฟล์ worklist แบบ background:', err);
      });
    } else if (ishl7Enabled && records.length > 0) {
      console.log('[Worklist] ---> เปิด HL7 ข้ามการสร้างไฟล์ Worklist จาก DB');
    }

  } catch (err) {
    console.error('Query error:', err);
    const friendlyMessage = db.friendlyErrorMessage(err);
    res.status(500).json({ success: false, message: friendlyMessage });
  } finally {
    isProcessingXrayReport = false;
  }
});

// เช็คว่า path ที่ให้มาเป็นของไดรฟ์ Windows หรือไม่ เช่น "D:\" หรือ "D:"
function isWindowsDriveRoot(p) {
  return /^[a-zA-Z]:[\\/]?$/.test(p);
}

// หาไดรฟ์ทั้งหมดที่มีอยู่จริงบนเครื่อง Windows (A: - Z:)
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
      // ข้ามไดรฟ์นี้ไป
    }
  }
  return drives;
}

// ถ้าไม่ส่งหรือส่งค่าว่าง จะคืนรายชื่อไดรฟ์ทั้งหมดให้เลือกก่อน
app.get('/api/fs/browse', (req, res) => {
  const platform = os.platform();
  let targetPath = (req.query.path || '').toString().trim();

  try {
    if (!targetPath) {
      if (platform === 'win32') {
        return res.json({ success: true, path: '', parent: null, isRoot: true, folders: listWindowsDrives() });
      }
      targetPath = '/'; // Linux/Mac ไม่มีแนวคิดไดรฟ์ ให้เริ่มที่ root
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
          return false;
        }
      })
      .map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'th'));

    // ทำปุ่ม "ย้อนกลับ"
    let parent;
    if (platform === 'win32' && isWindowsDriveRoot(resolved)) {
      parent = ''; // ย้อนกลับ = กลับไปหน้าเลือกไดรฟ์
    } else {
      const up = path.dirname(resolved);
      parent = up === resolved ? null : up;
    }

    res.json({ success: true, path: resolved, parent, isRoot: false, folders });
  } catch (err) {
    res.status(400).json({ success: false, message: 'เปิดโฟลเดอร์นี้ไม่ได้: ' + err.message });
  }
});

// สร้างโฟลเดอร์ย่อยใหม่
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

// รอให้พยายามต่อ DB รอบแรกเสร็จก่อนแล้วค่อยเปิดพอร์ตรับ request
let httpServer;
dbReadyPromise.finally(() => {
  httpServer = app.listen(PORT, () => {
    console.log(`[Server] ---> Backend API กำลังทำงานที่ ---> http://localhost:${PORT}`);
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Server] ---> Port ${PORT} ถูกใช้งานอยู่แล้ว`);
    } else {
      console.error('[Server] ---> เปิด server ไม่สำเร็จ:', err);
    }
    process.exit(1);
  });

  // เริ่มสร้างไฟล์ .wl อัตโนมัติ
  startAutoWorklistLoop();
});