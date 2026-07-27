// รองรับ Postgres, MySQL และ MS SQL Server
// โดยเลือกใช้ตัวไหนตามค่า settings.his.dbType ที่ตั้งจากหน้าเว็บ

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

// (สร้าง/สร้างใหม่) connection ตามการตั้งค่าปัจจุบัน
async function initPool(settings) {
  const his = settings.his || {};

  // pg/mysql2 ใช้ .end() ส่วน mssql (ConnectionPool ของแพ็กเกจ mssql) ใช้ .close()
  if (pool) {
    if (typeof pool.end === 'function') {
      pool.end().catch((err) => {
        console.warn('[DB] ---> ปิด pool เดิมไม่สำเร็จ:', err.message);
      });
    } else if (typeof pool.close === 'function') {
      pool.close().catch((err) => {
        console.warn('[DB] ---> ปิด mssql pool เดิมไม่สำเร็จ:', err.message);
      });
    }
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
  } else if (his.dbType === 'mssql') {
    const sql = require('mssql');
    const config = {
      user: his.username,
      password: his.password,
      server: his.host,
      port: Number(his.port) || 1433,
      database: his.database,
      options: {
        encrypt: false, 
        trustServerCertificate: true, 
        enableArithAbort: true,
        connectTimeout: 5000
      },
    };
    
    const poolObj = new sql.ConnectionPool(config);
    poolObj.on('error', (err) => {
      console.warn('[DB] ---> MS SQL pool error:', err.message);
    });
    pool = await poolObj.connect();
    currentType = 'mssql';
    console.log(`[DB] ---> เชื่อมต่อ MS SQL Server: ${his.host}:${his.port}/${his.database}`);
    
  } else {
    // pg เป็น default 
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
    // ตั้งค่า client_encoding ทุกครั้งที่มีการเปิด connection ใหม่
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

// รันคำสั่ง SQL 
async function query(sql, params = []) {
  if (!pool) {
    throw new Error('ยังไม่ได้เชื่อมต่อฐานข้อมูล');
  }

  if (currentType === 'mssql') {
    const request = pool.request();

    if (params && params.length > 0) {
      params.forEach((param, index) => {
        request.input(`p${index + 1}`, param);
      });
    }

    const mssqlString = sql.replace(/\$(\d+)/g, (_match, n) => `@p${n}`);

    const result = await request.query(mssqlString);
    const rows = result.recordset || [];
    const rowCount = (Array.isArray(result.rowsAffected) && result.rowsAffected[0]) || rows.length;
    return { rows, rowCount };

  } else if (currentType === 'mysql') {
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
      return 'หมดเวลาเชื่อมต่อฐานข้อมูล กรุณาตรวจสอบ IP Address / Port';

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
      
    // MSSQL
    case 'ELOGIN':
      return 'Username หรือ Password ไม่ถูกต้อง (MS SQL)';
    case 'ESOCKET':
      return 'ไม่สามารถเชื่อมต่อฐานข้อมูลได้ (โปรดตรวจสอบ IP Address/Port)';

    default:
      return err.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อฐานข้อมูล';
  }
}


async function detectHisSystem(his) {
  const dbType = his.dbType || 'postgres';

  if (dbType === 'mysql') {
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({
      host: his.host,
      port: Number(his.port) || 3306,
      database: his.database,
      user: his.username,
      password: his.password,
      charset: mapEncodingToMysqlCharset(his.encoding),
      connectTimeout: 5000,
    });
    try {
      const [rows] = await conn.query(
        `SELECT
          (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'xray_report') AS existsHosxp,
          (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'RadRequestHeader') AS existsSoftcon`
      );
      return { existsHosxp: rows[0].existsHosxp > 0, existsSoftcon: rows[0].existsSoftcon > 0 };
    } finally {
      await conn.end().catch(() => {});
    }
  }

  if (dbType === 'mssql') {
    const sql = require('mssql');
    const config = {
      user: his.username,
      password: his.password,
      server: his.host,
      port: Number(his.port) || 1433,
      database: his.database,
      options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true, connectTimeout: 5000 },
    };
    const poolObj = new sql.ConnectionPool(config);
    const conn = await poolObj.connect();
    try {
      const result = await conn.request().query(
        `SELECT
          (SELECT COUNT(*) FROM sys.tables WHERE name = 'xray_report') AS existsHosxp,
          (SELECT COUNT(*) FROM sys.tables WHERE name = 'RadRequestHeader') AS existsSoftcon`
      );
      const row = result.recordset[0];
      return { existsHosxp: row.existsHosxp > 0, existsSoftcon: row.existsSoftcon > 0 };
    } finally {
      await conn.close().catch(() => {});
    }
  }

  // postgres (ค่าเริ่มต้น)
  const { Client } = require('pg');
  const client = new Client({
    host: his.host,
    port: Number(his.port) || 5432,
    database: his.database,
    user: his.username,
    password: his.password,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT
        (to_regclass('xray_report') IS NOT NULL) AS "existsHosxp",
        (to_regclass('"RadRequestHeader"') IS NOT NULL) AS "existsSoftcon"`
    );
    return result.rows[0];
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = { 
  initPool, 
  query, 
  getType, 
  friendlyErrorMessage,
  detectHisSystem,
};