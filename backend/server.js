require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dicomService = require('./dicomService');
const orthancSync = require('./orthancSync');
const settingsService = require('./settingsService');
const db = require('./db');
const Mppsservice = require('./Mppsservice');
const hl7Service = require('./hl7Service');
const orthancCleanerRoutes = require('./orthanc-cleaner/routes');
const iconv = require('iconv-lite');

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

app.use(express.json({ limit: '20mb' }));

// โหลดการตั้งค่า (HIS MWL)
let currentSettings = settingsService.loadSettings();

// เมื่อเครื่อง Modality ส่งสถานะ MPPS กลับมา (ตรวจเสร็จ/ยกเลิก) ให้ลบไฟล์ worklist (.wl) ทิ้ง
// ใช้ store เดียวกับปุ่ม "ยืนยันอ่านฟิล์ม" ในหน้าเว็บ (ถือว่าจบงานเหมือนกัน) เพื่อให้ทนต่อการ restart backend ได้ - ต่างจาก Set เดิมที่อยู่แค่ในหน่วยความจำ
function handleMppsStatusChange(accessionNumber, status) {
  if (status === 'COMPLETED' || status === 'DISCONTINUED') {
    dicomService.markLocallyConfirmed(accessionNumber);
    console.log(`[MPPS] ---> ลบไฟล์ worklist ของ XN: ${accessionNumber} เนื่องจากสถานะเป็น "${status}"`);

    // HL7 mode: ยืนยันว่าฉายรังสีเสร็จแล้วกลับเข้าตาราง xray_result ตาม spec (ORC.1=SC)
    if (status === 'COMPLETED' && currentSettings.his.hisSystem === 'hl7' && accessionNumber) {
      const hl7Text = hl7Service.buildStatusChangedMessage(accessionNumber);
      insertXrayResult(accessionNumber, 'ORM^O01', hl7Text);
    }
  }
}

// เพิ่ม port MPPS ใหม่เข้า "ports:" ของ service backend + BACKEND_PUBLISHED_MPPS_PORTS ใน docker-compose.yml
// ทำแบบ "เพิ่มต่อท้าย" ไม่ลบของเดิม (7000/7001 ยังอยู่เหมือนเดิม) ปลอดภัยกว่าการแทนที่ค่าเดียวแบบ DICOM port
// เพราะพอร์ต MPPS มีได้หลายค่าให้เลือกอยู่แล้ว - อ่าน/เขียนจากไฟล์จริงเสมอ กันเพิ่มซ้ำถ้ายังไม่ได้ docker compose up -d
function ensureBackendMppsPortPublished(desiredPort) {
  const composePath = orthancSync.getDockerComposeHostPath();
  if (!composePath) {
    console.warn('[Server] ---> หา docker-compose.yml ไม่เจอ (PROJECT_HOST_PATH ไม่ถูกต้อง) ต้องเพิ่ม port MPPS ใน docker-compose.yml เอง');
    return false;
  }

  let text;
  try {
    text = fs.readFileSync(composePath, 'utf8');
  } catch (err) {
    console.error('[Server] ---> อ่าน docker-compose.yml ไม่สำเร็จ:', err.message);
    return false;
  }

  const lines = text.split('\n');
  const backendStart = lines.findIndex((l) => /^\s{2}backend:\s*$/.test(l));
  if (backendStart === -1) {
    console.warn('[Server] ---> หา service "backend:" ใน docker-compose.yml ไม่เจอ ต้องเพิ่ม port MPPS เอง');
    return false;
  }
  let backendEnd = lines.length;
  for (let i = backendStart + 1; i < lines.length; i++) {
    if (/^\s{2}\S.*:\s*$/.test(lines[i])) { backendEnd = i; break; }
  }

  let envLineIdx = -1;
  let currentPorts = [];
  for (let i = backendStart; i < backendEnd; i++) {
    const m = lines[i].match(/BACKEND_PUBLISHED_MPPS_PORTS=([0-9,]+)/);
    if (m) { envLineIdx = i; currentPorts = m[1].split(',').filter(Boolean); break; }
  }

  if (currentPorts.includes(String(desiredPort))) {
    return false; // publish ไว้แล้ว (อาจแค่ยังไม่ได้ docker compose up -d) ไม่ต้องแก้ซ้ำ
  }

  if (envLineIdx !== -1) {
    const newList = [...currentPorts, String(desiredPort)].join(',');
    lines[envLineIdx] = lines[envLineIdx].replace(/BACKEND_PUBLISHED_MPPS_PORTS=[0-9,]+/, `BACKEND_PUBLISHED_MPPS_PORTS=${newList}`);
  } else {
    console.warn('[Server] ---> หา BACKEND_PUBLISHED_MPPS_PORTS ใน docker-compose.yml ไม่เจอ ต้องเพิ่มเอง');
  }

  let portsStart = -1;
  for (let i = backendStart; i < backendEnd; i++) {
    if (/^\s{4}ports:\s*$/.test(lines[i])) { portsStart = i; break; }
  }
  if (portsStart === -1) {
    console.warn('[Server] ---> หา "ports:" ของ service backend ใน docker-compose.yml ไม่เจอ ต้องเพิ่ม port MPPS เอง');
  } else {
    let lastPortLine = portsStart;
    for (let i = portsStart + 1; i < backendEnd; i++) {
      if (/^\s{6}-\s*"\d+:\d+"\s*$/.test(lines[i])) {
        lastPortLine = i;
      } else {
        break;
      }
    }
    lines.splice(lastPortLine + 1, 0, `      - "${desiredPort}:${desiredPort}"`);
  }

  try {
    fs.writeFileSync(composePath, lines.join('\n'), 'utf8');
    console.log(`[Server] ---> เพิ่ม port MPPS ${desiredPort} เข้า docker-compose.yml แล้ว (service backend)`);
    return true;
  } catch (err) {
    console.error('[Server] ---> เขียน docker-compose.yml ไม่สำเร็จ:', err.message);
    return false;
  }
}

async function applySettings(settings, options = {}) {
  const { exitOnMppsFailure = false, restartAutoGenLoop = true } = options;
  const warnings = [];
  let dbError = null;
  let dbSkipped = false;

  // 1. โฟลเดอร์เก็บไฟล์ worklist
  try {
    dicomService.setWorklistDir(settings.mwl.worklistDir);
  } catch (err) {
    console.error('[Settings] ---> ตั้งค่าโฟลเดอร์ worklists ไม่สำเร็จ:', err);
    warnings.push(`ตั้งค่าโฟลเดอร์ worklists ไม่สำเร็จ - ${err.message} ระบบจะใช้โฟลเดอร์เดิมต่อไป: ${toDisplayPath(dicomService.getWorklistDir())}`);
  }

  // 1b. บอก Orthanc container ให้ใช้โฟลเดอร์ / AE Title / DICOM port เดียวกับที่ตั้งไว้ที่นี่
  // แล้ว restart ให้เองอัตโนมัติถ้ามีค่าไหนเปลี่ยน
  try {
    await orthancSync.syncOrthancWorklistPath(
      dicomService.getWorklistDir(),
      settings.mwl.aet,
      settings.mwl.port,
      settings.mwl.modalityAlwaysAllow,
      settings.mwl.modalities
    );
  } catch (err) {
    console.error('[Settings] ---> sync โฟลเดอร์ worklists ไปยัง Orthanc ไม่สำเร็จ:', err.message);
    warnings.push(`sync โฟลเดอร์ worklists ไปยัง Orthanc ไม่สำเร็จ - ${err.message} เครื่อง X-ray อาจยังไม่เห็นรายการล่าสุด`);
  }

  // 2. MPPS server
  if (settings.mwl.mppsPort) {
    const publishedMppsPorts = (process.env.BACKEND_PUBLISHED_MPPS_PORTS || '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (publishedMppsPorts.length > 0 && !publishedMppsPorts.includes(String(settings.mwl.mppsPort))) {
      ensureBackendMppsPortPublished(settings.mwl.mppsPort);
      console.warn(
        `[Server] ---> เพิ่ม port MPPS ${settings.mwl.mppsPort} เข้า docker-compose.yml ให้แล้ว ` +
        'แต่ยังไม่มีผลจริงจนกว่าจะรัน "docker compose up -d" เอง (restart container เฉยๆ ไม่พอ เพราะ port ผูกไว้ตอน create)'
      );
    }
    try {
      await Mppsservice.startMppsServer(settings.mwl.mppsPort, handleMppsStatusChange);
    } catch (err) {
      if (exitOnMppsFailure) {
        console.error('[Server] ---> เริ่ม MPPS server ไม่สำเร็จตอนสตาร์ท ปิดโปรแกรม:', err.message);
        process.exit(1);
      }
      console.error('[Settings] ---> เริ่ม MPPS server ที่พอร์ตใหม่ไม่สำเร็จ:', err.message);
      warnings.push(`เริ่ม MPPS server ที่พอร์ตใหม่ไม่สำเร็จ - ${err.message} ระบบจะยังไม่รับสถานะ MPPS จากเครื่อง Modality จนกว่าจะแก้ port ให้ถูกต้อง`);
    }
  } else {
    Mppsservice.stopMppsServer();
    console.log('[Server] ---> ยังไม่ได้ตั้งค่า MPPS Port รอการตั้งค่าจากหน้าเว็บ');
  }

  // 3. เชื่อมต่อฐานข้อมูล HIS
  const hisConfig = settings.his || {};
  if (hisConfig.host && hisConfig.database) {
    try {
      await db.initPool(settings);
    } catch (err) {
      console.error('[Settings] ---> เชื่อมต่อฐานข้อมูลด้วยค่าใหม่ไม่สำเร็จ:', err.message);
      dbError = err;
    }

    // ทดสอบว่าต่อฐานข้อมูลได้จริงหรือไม่
    if (!dbError) {
      try {
        await db.query('SELECT 1');
      } catch (err) {
        console.error('[Settings] ---> ทดสอบเชื่อมต่อฐานข้อมูลไม่สำเร็จ:', err);
        dbError = err;
      }
    }
  } else {
    dbSkipped = true;
    console.log('[Server] ---> ยังไม่ได้ตั้งค่าฐานข้อมูล รอการตั้งค่าจากหน้าเว็บ');
  }

  // 4. รีสตาร์ท background loop สร้างไฟล์ .wl อัตโนมัติ
  if (restartAutoGenLoop) {
    startAutoWorklistLoop();
  }

  return { dbError, dbSkipped, warnings };
}

let dbReadyPromise = applySettings(currentSettings, {
  exitOnMppsFailure: true,
  restartAutoGenLoop: false,
}).catch((err) => {
  console.error('[Server] ---> เริ่มต้นระบบไม่สำเร็จ:', err);
});

process.on('uncaughtException', (err) => {
  console.error('[Server] ---> Uncaught Exception ปิดโปรแกรมเพื่อความปลอดภัย ให้ Docker restart:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] ---> Unhandled Rejection ปิดโปรแกรมเพื่อความปลอดภัย ให้ Docker restart:', reason);
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

// สร้างเงื่อนไข LIKE / NOT LIKE
function buildLikeClause(state, column, value, negate = false) {
  if (!value || value.trim() === '') return null;
  const clause = `${column} ${negate ? 'NOT LIKE' : 'LIKE'} $${state.paramIndex}`;
  state.params.push(`%${value}%`);
  state.paramIndex++;
  return clause;
}

// สร้างเงื่อนไข IN / NOT IN
function buildInClause(state, column, values, negate = false) {
  if (!values || values.length === 0) return null;
  const placeholders = values.map((_, i) => `$${state.paramIndex + i}`).join(', ');
  state.params.push(...values);
  state.paramIndex += values.length;
  return `${column} ${negate ? 'NOT IN' : 'IN'} (${placeholders})`;
}

// dbType (postgres/mysql/mssql) เลือก "ภาษา SQL" ที่ถูกต้องของแต่ละฐานข้อมูล
// - hosxp   -> ต่อได้เฉพาะ mysql/postgres (HOSxP ไม่รองรับ MSSQL)
// - softcon -> ต่อได้ทั้ง mysql/postgres/mssql
function buildXrayReportQuery(dateback, include, exclude, confirm, existingXNs = [], xns_NN = [], xns_YN = [], xns_NY = [], dbType = 'postgres', hisSystem = 'softcon') {
  if (hisSystem === 'hosxp') {
    return buildHosxpQuery(dateback, include, exclude, confirm, existingXNs, xns_NN, xns_YN, xns_NY, dbType);
  }
  if (hisSystem === 'hl7') {
    return buildHl7Query(dateback, dbType);
  }
  return buildSoftconQuery(dateback, include, exclude, confirm, existingXNs, dbType, xns_NN, xns_YN, xns_NY);
}

// HL7 - อ่านคิว order จากตาราง xray_request ที่ระบบ Gateway ฝั่ง HIS เขียนไว้
// จำกัดช่วงวันตาม dateback เหมือน hosxp/softcon กันดึง backlog สะสมทั้งหมดย้อนหลังไม่จำกัด
function buildHl7Query(dateback, dbType) {
  const safeDateback = Number.isFinite(Number(dateback)) ? Number(dateback) : 1;

  let dateFilter;
  if (dbType === 'mysql') {
    dateFilter = `xray_request_datetime >= DATE_SUB(CURDATE(), INTERVAL $1 DAY)`;
  } else if (dbType === 'mssql') {
    dateFilter = `xray_request_datetime >= DATEADD(day, -$1, CAST(GETDATE() AS DATE))`;
  } else {
    dateFilter = `xray_request_datetime >= current_date - $1::integer`;
  }

  return {
    sql: `SELECT xray_request_id, xray_request_xn, xray_request_data FROM xray_request WHERE xray_request_receive = 'N' AND ${dateFilter} ORDER BY xray_request_id ASC`,
    params: [safeDateback],
  };
}

// blob เก็บ HL7 message เป็น binary ดิบ ต้อง decode ตาม encoding จริงของฐานข้อมูล (มักเป็น TIS620 ไม่ใช่ UTF-8)
function decodeHl7Blob(buffer, encoding) {
  const enc = (encoding || '').toUpperCase();
  if (enc === 'TIS620') return iconv.decode(buffer, 'tis620');
  if (enc === 'WIN874' || enc === 'WINDOWS-874') return iconv.decode(buffer, 'windows-874');
  return buffer.toString('utf8');
}

// แปลง row ดิบจากตาราง xray_request (blob เก็บ HL7 message) ให้เป็น record shape เดียวกับที่หน้าเว็บใช้แสดงผล
function mapHl7RowsToRecords(rows, encoding) {
  const records = [];
  for (const row of rows) {
    try {
      const item = hl7Service.parsehl7ToWorklistItem(decodeHl7Blob(row.xray_request_data, encoding));
      if (row.xray_request_xn) item.xn = row.xray_request_xn;
      item.confirm = 'N';
      item.confirm_read_film = 'N';
      item.xrayRequestId = row.xray_request_id; // เก็บไว้ไปยืนยัน xray_request_receive='Y' หลัง process เสร็จ
      records.push(item);
    } catch (err) {
      console.error(`[HL7] ---> แปลงข้อมูล xray_request id ${row.xray_request_id} ไม่สำเร็จ:`, err.message);
    }
  }
  return records;
}

// dbType (mysql/mssql/postgres) เลือกฟังก์ชันวันเวลา "ตอนนี้" ที่ถูกต้องของแต่ละฐานข้อมูล
function nowSqlExpr(dbType) {
  if (dbType === 'mysql') return 'NOW()';
  if (dbType === 'mssql') return 'GETDATE()';
  return 'CURRENT_TIMESTAMP';
}

// ยืนยันกลับตาราง xray_request ว่า PACS อ่านและประมวลผล order นี้แล้ว ตาม spec (1.1 X-Ray Request)
async function markXrayRequestReceived(id) {
  if (!id) return;
  try {
    await db.query(
      `UPDATE xray_request SET xray_request_receive = 'Y', xray_request_receive_datetime = ${nowSqlExpr(currentSettings.his.dbType)} WHERE xray_request_id = $1`,
      [id]
    );
  } catch (err) {
    console.error(`[HL7] ---> ยืนยัน xray_request_id ${id} เป็น received ไม่สำเร็จ:`, err.message);
  }
}

// เขียนกลับตาราง xray_result ตาม spec (1.2 X-Ray Result) ให้ HIS มาอ่านสถานะ/ผลจาก PACS
async function insertXrayResult(xn, msgType, hl7Text) {
  try {
    await db.query(
      `INSERT INTO xray_result (xray_result_xn, xray_result_msg_type, xray_result_data, xray_result_datetime, xray_result_receive) VALUES ($1, $2, $3, ${nowSqlExpr(currentSettings.his.dbType)}, 'N')`,
      [xn, msgType, hl7Text]
    );
  } catch (err) {
    console.error(`[HL7] ---> เขียนผลยืนยันสถานะ XN ${xn} เข้า xray_result ไม่สำเร็จ:`, err.message);
  }
}

// ทั้ง HOSxP และ SoftCon มีตาราง lookup แยกประเภทรายการอยู่แล้วในฐานข้อมูลเอง ไม่ต้องให้ผู้ใช้มาจับคู่เอง
// hl7 ไม่ได้อยู่ใน spec HL7 มาตรฐาน (สเปกไม่มีตาราง group ให้) แต่ Gateway บางยี่ห้อ (เช่น BMS PACs Gateway) แถม table เดียวกับ HOSxP มาให้ด้วย
const MODALITY_GROUP_CATALOG_QUERY = {
  hosxp: 'SELECT xray_items_group AS id, name FROM xray_items_group ORDER BY xray_items_group',
  softcon: 'SELECT RadItemCategoryKey AS id, Name AS name FROM RadItemCategory ORDER BY RadItemCategoryKey',
  hl7: 'SELECT xray_items_group AS id, name FROM xray_items_group ORDER BY xray_items_group',
};

// HL7 message มีแค่ xray_items_code (OBR-4.1) ไม่มี group ติดมาด้วยเหมือน query ของ HOSxP/SoftCon โดยตรง
// ต้อง join code -> group เองก่อน ผ่านตาราง xray_items ของ Gateway (มี column xray_items_group อยู่แล้ว)
const ITEM_GROUP_BY_CODE_QUERY = {
  hl7: 'SELECT xray_items_code AS code, xray_items_group AS group_id FROM xray_items',
};

const MODALITY_NAME_MATCH = {
  CR: ['X-RAY', 'XRAY', 'X RAY', 'PLAIN FILM'],
  US: ['ULTRASOUND', 'U/S'],
  CT: ['CT', 'CT SCAN', 'COMPUTED TOMOGRAPHY'],
  MR: ['MRI', 'MR', 'MAGNETIC RESONANCE', 'MAGNETIC RESONANCE IMAGING'],
  MG: ['MAMMOGRAM', 'MAMMOGRAPHY'],
  IO: ['INTRAORAL', 'INTRA-ORAL', 'INTRA ORAL', 'DENTAL X-RAY'],
  ECG: ['EKG', 'ECG', 'ELECTROCARDIOGRAM'],
};

// modality จากชื่อ group แบบตรงเท่านั้น ไม่เจอที่ตรงกัน = คืนค่าว่าง
function guessModalityFromName(name) {
  const normalized = String(name || '').trim().toUpperCase().replace(/\s+/g, ' ');
  for (const [modality, labels] of Object.entries(MODALITY_NAME_MATCH)) {
    if (labels.includes(normalized)) return modality;
  }
  return '';
}

function resolveModalityForGroup(hisSystem, groupId, groupName) {
  const override = (currentSettings.mwl.modalityGroupOverride || {})[hisSystem] || {};
  const overridden = override[String(groupId)];
  if (overridden) return overridden;
  return guessModalityFromName(groupName);
}

// ไม่มีตาราง group ให้เลย (Gateway ยี่ห้อนี้ไม่มี table แบบ HOSxP/SoftCon) ปล่อย Modality ว่างไว้ ให้ dicomService fallback เป็น CR ตามเดิม
async function applyModalityMapping(records) {
  const hisSystem = currentSettings.his.hisSystem;
  const catalogQuery = MODALITY_GROUP_CATALOG_QUERY[hisSystem];
  if (!catalogQuery) return records;

  // HL7: ต้อง join xray_items_code -> xray_items_group เองก่อน (query ของ HOSxP/SoftCon คืน group มาให้พร้อมอยู่แล้ว ไม่ต้องทำขั้นนี้)
  const itemGroupQuery = ITEM_GROUP_BY_CODE_QUERY[hisSystem];
  if (itemGroupQuery) {
    const itemGroupResult = await db.query(itemGroupQuery);
    const groupByCode = {};
    itemGroupResult.rows.forEach((r) => { groupByCode[String(r.code)] = r.group_id; });
    records.forEach((record) => {
      record.xray_items_group = groupByCode[String(record.xray_items_code)];
    });
  }

  const catalogResult = await db.query(catalogQuery);
  const nameById = {};
  catalogResult.rows.forEach((r) => { nameById[String(r.id)] = r.name; });

  records.forEach((record) => {
    const resolved = resolveModalityForGroup(hisSystem, record.xray_items_group, nameById[String(record.xray_items_group)]);
    if (resolved) record.Modality = resolved;
  });
  return records;
}

// SoftCon - schema แบบ RadRequestHeader/RadRequest/Patient/Person/Visit
function buildSoftconQuery(dateback, include, exclude, confirm, existingXNs, dbType, xns_NN = [], xns_YN = [], xns_NY = []) {
  const state = { params: [], paramIndex: 1 };
  const safeDateback = Number.isFinite(Number(dateback)) ? Number(dateback) : 0;

  // ส่วนที่ต่างกันตามฐานข้อมูลแต่ละตัว (วันที่/เวลา/แปลงชนิดข้อมูล)
  let dateWindow, birthdayExpr, studyDateExpr, studyTimeExpr, genderCastType;

  if (dbType === 'mysql') {
    dateWindow = `DATEDIFF(CURDATE(), rrh.IssueDT) BETWEEN 0 AND $${state.paramIndex}`;
    birthdayExpr = `DATE_FORMAT(p.BirthDT, '%Y-%m-%d')`;
    studyDateExpr = `DATE_FORMAT(rrh.IssueDT, '%Y-%m-%d')`;
    studyTimeExpr = `DATE_FORMAT(rrh.IssueDT, '%H:%i:%s')`;
    genderCastType = 'CHAR';
  } else if (dbType === 'mssql') {
    dateWindow = `DATEDIFF(day, rrh.IssueDT, GETDATE()) BETWEEN 0 AND $${state.paramIndex}`;
    birthdayExpr = `CONVERT(varchar(10), p.BirthDT, 23)`;
    studyDateExpr = `CONVERT(varchar(10), rrh.IssueDT, 23)`;
    studyTimeExpr = `CONVERT(varchar(8), rrh.IssueDT, 108)`;
    genderCastType = 'VARCHAR';
  } else {
    // postgres
    dateWindow = `(CURRENT_DATE - rrh.IssueDT::date) BETWEEN 0 AND $${state.paramIndex}`;
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
      ric.RadItemCategoryKey as xray_items_group,
      -- SoftCon มี flag เดียว (IsDone) ไม่แยก 2 ขั้นแบบ HOSxP เลยใช้ค่าเดียวกันแทนทั้งคู่
      CASE WHEN rrh.IsDone = 1 THEN 'Y' ELSE 'N' END as confirm,
      CASE WHEN rrh.IsDone = 1 THEN 'Y' ELSE 'N' END as confirm_read_film,
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
    -- RadItem/RadItemCategory คือตาราง lookup ของ SoftCon เอง บอกว่ารายการนี้เป็น CT SCAN/MRI/ULTRASOUND/X-RAY/MAMMOGRAM ฯลฯ (เทียบเท่า xray_items_group ของ HOSxP)
    LEFT JOIN RadItem ri ON rr.ItemKey = ri.ItemKey
    LEFT JOIN RadItemCategory ric ON ri.RadItemCategoryKey = ric.RadItemCategoryKey
    WHERE ${dateWindow}
  `;
  state.params.push(safeDateback);
  state.paramIndex++;

  const includeClause = buildLikeClause(state, 'rr.ItemName', include);
  if (includeClause) sql += ` AND ${includeClause}`;

  const excludeClause = buildLikeClause(state, 'rr.ItemName', exclude, true);
  if (excludeClause) sql += ` AND ${excludeClause}`;

  if (confirm) {
    sql += ` AND rrh.IsDone = 0`;
  }

  if (existingXNs && existingXNs.length > 0) {
    // เอา XN ที่มีอยู่แล้วตัดออกไปก่อนเป็นพื้นฐาน
    let filterSql = buildInClause(state, 'v.VN', existingXNs, true);

    // SoftCon มี flag เดียว (IsDone) ไม่แยก 2 ขั้น เลยใช้เงื่อนไขเดียวกันครอบคลุมทั้ง 3 กรณี NN/YN/NY
    const nnClause = buildInClause(state, 'v.VN', xns_NN);
    if (nnClause) filterSql += ` OR (${nnClause} AND rrh.IsDone = 1)`;

    const ynClause = buildInClause(state, 'v.VN', xns_YN);
    if (ynClause) filterSql += ` OR (${ynClause} AND rrh.IsDone = 1)`;

    const nyClause = buildInClause(state, 'v.VN', xns_NY);
    if (nyClause) filterSql += ` OR (${nyClause} AND rrh.IsDone = 1)`;

    sql += ` AND (${filterSql})`;
  }

  sql += ` ORDER BY rrh.Code DESC`;
  return { sql, params: state.params };
}

// HOSxP - schema แบบ xray_report/patient/xray_items/doctor/xray_head
function buildHosxpQuery(dateback, include, exclude, confirm, existingXNs, xns_NN, xns_YN, xns_NY, dbType) {
  const state = { params: [], paramIndex: 1 };
  const safeDateback = Number.isFinite(Number(dateback)) ? Number(dateback) : 0;

  let dateFilter;
  if (dbType === 'mysql') {
    dateFilter = `a.request_date BETWEEN DATE_SUB(CURDATE(), INTERVAL $${state.paramIndex} DAY) AND CURDATE()`;
  } else if (dbType === 'mssql') {
    dateFilter = `a.request_date BETWEEN DATEADD(day, -$${state.paramIndex}, CAST(GETDATE() AS DATE)) AND CAST(GETDATE() AS DATE)`;
  } else {
    // postgres (ค่าเริ่มต้น)
    dateFilter = `a.request_date BETWEEN current_date - $${state.paramIndex}::integer AND current_date`;
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

  state.params.push(safeDateback);
  state.paramIndex++;

  const includeClause = buildLikeClause(state, 'c.xray_items_name', include);
  if (includeClause) sql += ` AND ${includeClause}`;

  const excludeClause = buildLikeClause(state, 'c.xray_items_name', exclude, true);
  if (excludeClause) sql += ` AND ${excludeClause}`;

  if (confirm) {
    sql += ` AND a.confirm = 'N'`;
  }

  if (existingXNs && existingXNs.length > 0) {
    // เอา XN ที่มีอยู่แล้วตัดออกไปก่อนเป็นพื้นฐาน
    let filterSql = buildInClause(state, 'a.xn', existingXNs, true);

    // ถ้าหน้าบ้านมีสถานะ N,N -> จะดึงข้อมูลกลับมาก็ต่อเมื่อ DB เปลี่ยนตัวใดตัวหนึ่งเป็น Y แล้ว
    const nnClause = buildInClause(state, 'a.xn', xns_NN);
    if (nnClause) {
      filterSql += ` OR (${nnClause} AND (COALESCE(a.confirm, 'N') = 'Y' OR COALESCE(a.confirm_read_film, 'N') = 'Y'))`;
    }

    // ถ้าหน้าบ้านมีสถานะ Y,N -> จะดึงข้อมูลกลับมาก็ต่อเมื่อ DB เปลี่ยน confirm_read_film เป็น Y แล้ว
    const ynClause = buildInClause(state, 'a.xn', xns_YN);
    if (ynClause) {
      filterSql += ` OR (${ynClause} AND COALESCE(a.confirm_read_film, 'N') = 'Y')`;
    }

    // ถ้าหน้าบ้านมีสถานะ N,Y -> จะดึงข้อมูลกลับมาก็ต่อเมื่อ DB เปลี่ยน confirm เป็น Y แล้ว
    const nyClause = buildInClause(state, 'a.xn', xns_NY);
    if (nyClause) {
      filterSql += ` OR (${nyClause} AND COALESCE(a.confirm, 'N') = 'Y')`;
    }

    sql += ` AND (${filterSql})`;
  }

  sql += ` ORDER BY a.request_date DESC, a.request_time DESC`;

  return { sql, params: state.params };
}

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'disconnected', ...db.friendlyErrorCode(err) });
  }
});

app.use('/api/orthanc', orthancCleanerRoutes);

app.get('/api/settings', (req, res) => {
  res.json({
    success: true,
    settings: maskSecrets(currentSettings),
    worklistDirActive: toDisplayPath(dicomService.getWorklistDir()), // path จริงที่ใช้งานอยู่ตอนนี้ (เผื่อฟิลด์ว่างไว้แล้วใช้ค่า default)
  });
});

// ดึงรายชื่อ group/category จริงจากฐานข้อมูล HIS ที่ต่ออยู่ (เช่น "1 - X-Ray", "10 - CT SCAN")
// พร้อม modality ที่ระบบจะใช้จริงตอนนี้ ให้หน้า settings เอาไปโชว์ให้แก้ทับได้
app.get('/api/settings/modality-groups', async (req, res) => {
  const hisConfig = currentSettings.his || {};
  if (!hisConfig.hisSystem || !hisConfig.host || !hisConfig.database) {
    return res.status(400).json({ success: false, errorCode: 'DB_NOT_CONFIGURED' });
  }
  const catalogQuery = MODALITY_GROUP_CATALOG_QUERY[hisConfig.hisSystem];
  if (!catalogQuery) {
    return res.json({ success: true, groups: [] });
  }
  try {
    const result = await db.query(catalogQuery);
    const groups = result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      modality: resolveModalityForGroup(hisConfig.hisSystem, r.id, r.name),
    }));
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ success: false, ...db.friendlyErrorCode(err) });
  }
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
        // '' = ตั้งใจลบค่าจริง ต่างจาก placeholder ('••••••••'/undefined) ที่ให้คงค่าเดิม
        result[key] = (val === '••••••••' || val === undefined) ? existingVal : val;
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
      ...db.friendlyErrorCode(err),
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

    const { dbError, dbSkipped, warnings } = await applySettings(currentSettings, {
      exitOnMppsFailure: false,
      restartAutoGenLoop: true,
    });

    const warningText = warnings.length > 0 ? ` (คำเตือน: ${warnings.join(' | ')})` : '';

    if (dbSkipped) {
      return res.json({
        success: true,
        settings: maskSecrets(currentSettings),
        worklistDirActive: toDisplayPath(dicomService.getWorklistDir()),
        message: `บันทึกการตั้งค่าเรียบร้อย กรอกข้อมูลฐานข้อมูลไม่ครบ ไม่ได้ทดสอบเชื่อมต่อ${warningText}`,
      });
    }

    if (!dbError) {
      return res.json({
        success: true,
        settings: maskSecrets(currentSettings),
        worklistDirActive: toDisplayPath(dicomService.getWorklistDir()),
        message: `บันทึกการตั้งค่าเรียบร้อย และเชื่อมต่อฐานข้อมูลสำเร็จ${warningText}`,
      });
    }

    return res.json({
      success: false,
      settings: maskSecrets(currentSettings),
      worklistDirActive: toDisplayPath(dicomService.getWorklistDir()),
      savedButDbFailed: true,
      warningText,
      ...db.friendlyErrorCode(dbError),
      error: dbError.message,
    });
  } catch (err) {
    console.error('[Settings] ---> บันทึกไม่สำเร็จ:', err);
    res.status(500).json({ success: false, message: 'บันทึกการตั้งค่าไม่สำเร็จ', error: err.message });
  }
});

let isProcessingXrayReport = false;

let isGeneratingWorklists = false;

// จำนวนไฟล์สร้างพร้อมกัน ปรับเพิ่มได้ถ้าเครื่องแรงพอ
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

          // ใช้ sanitizer เดียวกับที่ dicomService สร้างชื่อไฟล์จริง ให้ตรงกับ MPPS ที่ตอบกลับมา
          const safeXn = dicomService.sanitizeFileName(record.xn);

          if (record.orderControl === 'CA') {
            // ยกเลิก order จาก HL7 (ORC.1 = CA)
            dicomService.deleteWorklistFile(record.xn);

          } else if (
            record.confirm_read_film === 'Y' ||
            dicomService.isLocallyConfirmed(record.xn) ||
            dicomService.isLocallyConfirmed(safeXn)
          ) {
            // ถือว่าจบงานแล้ว - จาก HIS โดยตรง (confirm_read_film='Y') หรือจบในเครื่องนี้เอง
            // (กดยืนยันอ่านฟิล์มจากหน้าเว็บ หรือเครื่อง X-ray ส่ง MPPS แจ้ง COMPLETED/DISCONTINUED มา) โดยไม่ต้องรอ HIS อัปเดต
            dicomService.deleteWorklistFile(record.xn);

          } else if (record.confirm_read_film === 'N') {
            // ยังไม่ยืนยันอ่านฟิล์ม (และไม่ได้จบงานในเครื่องนี้) ให้สร้างไฟล์ worklist
            await dicomService.generateWorklistFile(record);
          }

          // HL7 mode: ยืนยันกลับ DB ว่า order นี้ประมวลผลแล้ว (ไม่ว่าจะสร้าง/ลบ/ยกเลิกไฟล์ worklist) ตาม spec
          if (record.xrayRequestId) {
            await markXrayRequestReceived(record.xrayRequestId);
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

  // ถ้ายังไม่ได้ตั้งค่าฐานข้อมูลให้หยุดทำงาน
  const hisConfig = currentSettings.his || {};
  if (!hisConfig.hisSystem || !hisConfig.host || !hisConfig.database) {
    return;
  }

  const cfg = currentSettings.mwl.autoGenerate || {};

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
    const records = currentSettings.his.hisSystem === 'hl7'
      ? mapHl7RowsToRecords(result.rows, currentSettings.his.encoding)
      : result.rows;
    await applyModalityMapping(records);
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
  const intervalMs = (cfg.intervalSec || 10) * 1000;
  autoGenIntervalHandle = setInterval(runAutoWorklistCycle, intervalMs);
  console.log(`[Worklist Auto] ---> เริ่มสร้างไฟล์ .wl อัตโนมัติทุก ${intervalMs / 1000} วินาที`);
  runAutoWorklistCycle();
}

app.post('/api/xray-report', async (req, res) => {
  const displayLang = req.body?.lang === 'th' ? 'th' : 'en';

  if (isProcessingXrayReport) {
    return res.status(429).json({ success: false, errorCode: 'BUSY' });
  }

  const hisConfig = currentSettings.his || {};
  if (!hisConfig.hisSystem || !hisConfig.host || !hisConfig.database) {
    return res.status(400).json({ success: false, errorCode: 'DB_NOT_CONFIGURED' });
  }

  isProcessingXrayReport = true;
  try {
    const { dateback = 1, include, exclude, confirm, existingXNs, xns_NN, xns_YN, xns_NY } = req.body;
    const confirmFlag = confirm === true || confirm === 'true' || confirm === '1';

    const { sql, params } = buildXrayReportQuery(
      dateback, include, exclude, confirmFlag,
      existingXNs, xns_NN, xns_YN, xns_NY,
      currentSettings.his.dbType,
      currentSettings.his.hisSystem
    );

    const result = await db.query(sql, params);
    const records = currentSettings.his.hisSystem === 'hl7'
      ? mapHl7RowsToRecords(result.rows, currentSettings.his.encoding)
      : result.rows;
    await applyModalityMapping(records);

    records.forEach((record) => {
      record.lang = displayLang;
      if (record.confirm_read_film !== 'Y' && dicomService.isLocallyConfirmed(record.xn)) {
        record.confirm_read_film = 'Y';
      }
    });

    res.json({ success: true, count: records.length, data: records });

    if (records.length > 0) {
      processWorklistFiles(records, displayLang).catch((err) => {
        console.error('[Worklist] ---> เกิดข้อผิดพลาดขณะสร้างไฟล์ worklist แบบ background:', err);
      });
    }

  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ success: false, ...db.friendlyErrorCode(err) });
  } finally {
    isProcessingXrayReport = false;
  }
});

// ปุ่ม "ยืนยันอ่านฟิล์ม" จากหน้าเว็บ - จำไว้ในเครื่องนี้เท่านั้น (ไม่เขียนกลับ HIS ของโรงพยาบาล) แล้วลบไฟล์ .wl ทิ้งทันที
app.post('/api/xray-report/confirm-read-film', (req, res) => {
  const { xn } = req.body || {};
  if (!xn) {
    return res.status(400).json({ success: false, errorCode: 'XN_REQUIRED' });
  }
  dicomService.markLocallyConfirmed(String(xn));
  res.json({ success: true });
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

// ตอนรันใน Docker (Linux) จะเห็นแค่ไดรฟ์ host ที่ mount เข้ามาผ่าน docker-compose.yml เท่านั้น
// (ต่างจาก win32 ที่เห็นได้ทุกไดรฟ์แบบสด ๆ รวม USB ที่เสียบทีหลัง)
// - host เป็น Windows (docker-compose.windows.yml): mount ทีละไดรฟ์ C:\ D:\
// - host เป็น Linux (docker-compose.yml): mount root filesystem "/" ทั้งก้อนอันเดียว
// มีแค่ mount ที่ docker-compose ไฟล์ที่ใช้จริงประกาศไว้เท่านั้นที่จะ exist ข้างใน container ที่เหลือ filter ทิ้งไปเอง
const HOST_DRIVE_MOUNTS = [
  { name: 'C:', path: '/mnt/hostC' },
  { name: 'D:', path: '/mnt/hostD' },
  { name: '/', path: '/mnt/hostRoot' },
];

function listMountedHostDrives() {
  return HOST_DRIVE_MOUNTS.filter((m) => {
    try {
      return fs.existsSync(m.path);
    } catch (err) {
      return false;
    }
  });
}

function isHostDriveMountRoot(p) {
  return listMountedHostDrives().some((m) => path.resolve(m.path) === p);
}

// path ข้างในเครื่องที่รันจริง (__dirname เช่น /app ตอนอยู่ใน Docker) เอาไว้แปลงกลับเป็น "backend/..."
// ให้อ่านง่ายขึ้นตอนแสดงผล เพราะ path จริงในคอนเทนเนอร์ไม่มีความหมายอะไรกับคนอ่านนอก Docker
const APP_ROOT = path.resolve(__dirname);

// แปลง path จริง (ข้างในคอนเทนเนอร์/เครื่องที่รัน) ให้เป็น path แบบที่คนดูจากฝั่ง host จะคุ้นตา
// ใช้ mapping ที่เรากำหนดเองเท่านั้น (docker-compose.yml + __dirname) จึงมั่นใจได้ว่าถูกต้องจริง ไม่ใช่การเดา
function toDisplayPath(p) {
  if (!p) return p;
  const resolved = path.resolve(p);

  for (const m of listMountedHostDrives()) {
    const mountRoot = path.resolve(m.path);
    if (resolved === mountRoot || resolved.startsWith(mountRoot + path.sep)) {
      const rest = resolved.slice(mountRoot.length);
      // mount ไดรฟ์ Windows (ชื่อ "C:") แสดงผลแบบ Windows path, mount root ของ Linux (ชื่อ "/") คือ path จริงอยู่แล้ว
      if (/^[A-Za-z]:$/.test(m.name)) {
        return `${m.name}${rest.replace(/\//g, '\\') || '\\'}`;
      }
      return rest || '/';
    }
  }

  if (resolved === APP_ROOT || resolved.startsWith(APP_ROOT + path.sep)) {
    const rest = resolved.slice(APP_ROOT.length).replace(/\\/g, '/');
    return `backend${rest}`;
  }

  return resolved;
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
      const hostDrives = listMountedHostDrives();
      if (hostDrives.length > 0) {
        return res.json({ success: true, path: '', parent: null, isRoot: true, folders: hostDrives });
      }
      targetPath = '/'; // ไม่มีไดรฟ์ host mount เข้ามาเลย ให้เริ่มที่ root ของ container แทน
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
    } else if (platform !== 'win32' && isHostDriveMountRoot(resolved)) {
      parent = ''; // ย้อนกลับ = กลับไปหน้าเลือกไดรฟ์ host ที่ mount ไว้
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

  startAutoWorklistLoop();
});