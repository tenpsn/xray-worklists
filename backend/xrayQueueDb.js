const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// เก็บคิวข้อความ HL7 แยกจาก DB ของ HIS โรงพยาบาล ไม่ไปแก้ schema ฝั่งนั้น
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'xray_queue.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_FILE);

// โครงตารางตาม PACs HL7 Interfacing Specification (หัวข้อ Message HL7 > Database > X-Ray Request)
db.exec(`
  CREATE TABLE IF NOT EXISTS xray_request (
    xray_request_id INTEGER PRIMARY KEY AUTOINCREMENT,
    xray_request_xn TEXT,
    xray_request_msg_type TEXT,
    xray_request_data TEXT NOT NULL,
    xray_request_datetime TEXT NOT NULL,
    xray_request_receive TEXT NOT NULL DEFAULT 'N',
    xray_request_receive_datetime TEXT
  )
`);

// บันทึกข้อความ hl7 ดิบที่รับเข้ามาลงคิว (receive = 'N' รอ worker มาประมวลผล)
function insertRequest(xn, msgType, rawData) {
  const stmt = db.prepare(`
    INSERT INTO xray_request (xray_request_xn, xray_request_msg_type, xray_request_data, xray_request_datetime)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(xn || '', msgType || '', rawData, new Date().toISOString());
  return result.lastInsertRowid;
}

// ดึงรายการที่ยังไม่ถูกประมวลผล (receive = 'N') เรียงตามลำดับที่รับเข้ามา
function getPendingRequests() {
  return db.prepare(`
    SELECT * FROM xray_request WHERE xray_request_receive = 'N' ORDER BY xray_request_id ASC
  `).all();
}

// mark ว่าประมวลผล (สร้างไฟล์ worklist) สำเร็จแล้ว
function markReceived(id) {
  db.prepare(`
    UPDATE xray_request SET xray_request_receive = 'Y', xray_request_receive_datetime = ?
    WHERE xray_request_id = ?
  `).run(new Date().toISOString(), id);
}

module.exports = { insertRequest, getPendingRequests, markReceived };
