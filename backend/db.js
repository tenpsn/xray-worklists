// รองรับทั้ง Postgres และ MySQL
// โดยเลือกใช้ตัวไหนตามค่า settings.his.dbType ที่ตั้งจากหน้าเว็บ (Settings)

let pool = null;
let currentType = null;

// แปลง encoding ที่เลือกในหน้าเว็บ ให้เป็นชื่อ charset ที่ MySQL เข้าใจ
function mapEncodingToMysqlCharset(encoding) {
  switch ((encoding || '').toUpperCase()) {
    case 'UTF8':
      return 'utf8mb4';
    case 'TIS620':
      return 'tis620';
    case 'WIN874':
    case 'WINDOWS-874':
      // MySQL ไม่มี charset windows-874 ตรงๆ ใกล้เคียงที่สุดคือ tis620
      // ถ้าฐานข้อมูลจริงเก็บเป็น cp874 อาจต้องปรับ driver/แปลงข้อมูลเพิ่มเติม
      return 'tis620';
    default:
      return 'utf8mb4';
  }
}

// แปลง encoding ให้เป็นชื่อที่ Postgres เข้าใจ
function mapEncodingToPgClientEncoding(encoding) {
  const allowed = ['UTF8', 'TIS620', 'WIN874'];
  const value = (encoding || 'UTF8').toUpperCase();
  return allowed.includes(value) ? value : 'UTF8';
}

// (สร้าง/สร้างใหม่) connection pool ตามการตั้งค่าปัจจุบัน
function initPool(settings) {
  const his = settings.his || {};

  // ปิด pool เก่าก่อน (ถ้ามี) เพื่อไม่ให้ connection ค้าง
  if (pool && typeof pool.end === 'function') {
    pool.end().catch((err) => {
      console.warn('[DB] ---> ปิด pool เดิมไม่สำเร็จ (ไม่ร้ายแรง):', err.message);
    });
  }

  if (his.dbType === 'mysql') {
    const mysql = require('mysql2/promise');
    pool = mysql.createPool({
      host: his.host,
      port: Number(his.port) || 3306,
      database: his.database,
      user: his.username,
      password: his.password,
      charset: mapEncodingToMysqlCharset(his.encoding),
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 5000, // ต่อไม่ติดภายใน 5 วิ ให้ error เลย ไม่ค้างรอ
    });
    currentType = 'mysql';
    console.log(`[DB] ---> เชื่อมต่อ MySQL: ${his.host}:${his.port}/${his.database}`);
  } else {
    const { Pool } = require('pg');
    const clientEncoding = mapEncodingToPgClientEncoding(his.encoding);
    pool = new Pool({
      host: his.host,
      port: Number(his.port) || 5432,
      database: his.database,
      user: his.username,
      password: his.password,
      connectionTimeoutMillis: 5000, // ต่อไม่ติดภายใน 5 วิ ให้ error เลย ไม่ค้างรอ
    });
    // ตั้งค่า client_encoding ทุกครั้งที่มีการเปิด connection ใหม่ใน pool
    pool.on('connect', (client) => {
      client.query(`SET client_encoding TO '${clientEncoding}'`).catch((err) => {
        console.warn('[DB] ---> ตั้งค่า client_encoding ไม่สำเร็จ:', err.message);
      });
    });
    currentType = 'postgres';
    console.log(`[DB] ---> เชื่อมต่อ Postgres: ${his.host}:${his.port}/${his.database}`);
  }

  return pool;
}

// รันคำสั่ง SQL โดยสำหรับ MySQL จะแปลง placeholder จาก $1,$2,... เป็น ? ให้อัตโนมัติ
async function query(sql, params = []) {
  if (!pool) {
    throw new Error('ยังไม่ได้เชื่อมต่อฐานข้อมูล (pool is not initialized)');
  }

  if (currentType === 'mysql') {
    const mysqlSql = sql.replace(/\$\d+/g, '?');
    const [rows] = await pool.query(mysqlSql, params);
    return { rows, rowCount: Array.isArray(rows) ? rows.length : 0 };
  }

  // postgres (ค่าเริ่มต้น)
  return pool.query(sql, params);
}

function getType() {
  return currentType;
}

// แปลง error
function friendlyErrorMessage(err) {
  const code = err.code;

  switch (code) {
    case 'ENOTFOUND':
      return `ไม่เจอ Hostname "${err.hostname || ''}" กรุณาตรวจสอบ IP Address`;
    case 'ECONNREFUSED':
      return 'เชื่อมต่อฐานข้อมูลไม่ติด กรุณาตรวจสอบ Port';
    case 'ETIMEDOUT':
    case 'ETIMEOUT':
      return 'หมดเวลาเชื่อมต่อฐานข้อมูล กรุณาตรวจสอบ IP Address / Port หรือไฟร์วอลล์';

    // Postgres
    case '28P01':
      return 'Username หรือ Password ไม่ถูกต้อง (Postgres)';
    case '28000':
      return 'ไม่พบ Username นี้ หรือไม่มีสิทธิ์เข้าถึง (Postgres)';
    case '3D000':
      return 'ไม่พบฐานข้อมูลชื่อนี้ กรุณาตรวจสอบชื่อ Database (Postgres)';

    // MySQL
    case 'ER_ACCESS_DENIED_ERROR':
      return 'Username หรือ Password ไม่ถูกต้อง (MySQL)';
    case 'ER_BAD_DB_ERROR':
      return 'ไม่พบฐานข้อมูลชื่อนี้ กรุณาตรวจสอบชื่อ Database (MySQL)';
    case 'ER_DBACCESS_DENIED_ERROR':
      return 'Username นี้ไม่มีสิทธิ์เข้าถึงฐานข้อมูลนี้ (MySQL)';

    default:
      return err.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อฐานข้อมูล';
  }
}

module.exports = { 
  initPool, 
  query, 
  getType, 
  friendlyErrorMessage 
};