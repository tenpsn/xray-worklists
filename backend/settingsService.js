const fs = require('fs');
const path = require('path');

// ไฟล์เก็บการตั้งค่า HIS (ฐานข้อมูล) และ MWL (DICOM Worklist)
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// ค่าเริ่มต้น ดึงมาจาก .env เผื่อยังไม่เคยตั้งค่าผ่านหน้าเว็บมาก่อน
const DEFAULT_SETTINGS = {
  his: {
    dbType: process.env.DB_TYPE || 'postgres',      // 'postgres' หรือ 'mysql'
    host: process.env.PGHOST || '',
    port: process.env.PGPORT || '5432',
    database: process.env.PGDATABASE || '',
    username: process.env.PGUSER || '',
    password: process.env.PGPASSWORD || '',
    encoding: process.env.DB_ENCODING || 'UTF8',    // 'UTF8' | 'TIS620' | 'WIN874'
  },
  mwl: {
    aet: process.env.MWL_AET || 'ORTHANC',
    port: process.env.MWL_PORT || '7000',
  },
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return {
        his: { ...DEFAULT_SETTINGS.his, ...(saved.his || {}) },
        mwl: { ...DEFAULT_SETTINGS.mwl, ...(saved.mwl || {}) },
      };
    }
  } catch (err) {
    console.warn('[Settings] ---> ไม่สามารถอ่านไฟล์ settings.json ได้ ใช้ค่า default:', err.message);
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(newSettings) {
  const current = loadSettings();
  const merged = {
    his: { ...current.his, ...(newSettings.his || {}) },
    mwl: { ...current.mwl, ...(newSettings.mwl || {}) },
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  console.log('[Settings] ---> บันทึกการตั้งค่าใหม่เรียบร้อย');
  return merged;
}

module.exports = { loadSettings, saveSettings };