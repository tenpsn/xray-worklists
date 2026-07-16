require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const dicomService = require('./dicomService');
const app = express();
const PORT = process.env.PORT;
const CORS_ORIGIN = process.env.CORS_ORIGIN;

// อนุญาตให้ frontend (คนละ port/โดเมน) เรียกเข้ามาได้
app.use(cors({ origin: CORS_ORIGIN }));

// รับข้อมูลแบบ JSON
app.use(express.json());

const dbConfig = {
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
};

const pool = new Pool(dbConfig);

// เพิ่ม parameter รับอาร์เรย์แต่ละสถานะเข้ามา
function buildXrayReportQuery(dateback, include, exclude, confirm, existingXNs = [], xns_NN = [], xns_YN = [], xns_NY = []) {
  const params = [];
  let paramIndex = 1;

  const safeDateback = Number.isFinite(Number(dateback)) ? Number(dateback) : 0;

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
    WHERE a.request_date BETWEEN current_date - $${paramIndex}::integer AND current_date
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

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/xray-report', async (req, res) => {
  try {
    // ดึงตัวแปรใหม่ที่ส่งมาจาก Frontend มารับใน req.body
    const { dateback = 1, include, exclude, confirm, existingXNs, xns_NN, xns_YN, xns_NY } = req.body;
    const confirmFlag = confirm === true || confirm === 'true' || confirm === '1';

    // ส่งค่าทั้งหมดเข้าไปในฟังก์ชันสร้าง SQL
    const { sql, params } = buildXrayReportQuery(dateback, include, exclude, confirmFlag, existingXNs, xns_NN, xns_YN, xns_NY);

    const result = await pool.query(sql, params);
    
    const records = result.rows;
    if (records.length > 0) {
      for (const record of records) {
      try {
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
      }
    }
    res.json({ success: true, count: result.rowCount, data: records });
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูล', error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend API กำลังทำงานที่ ---> http://localhost:${PORT}`);
});