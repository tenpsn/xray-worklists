const fs = require('fs');
const path = require('path');

// ไฟล์เก็บการตั้งค่า HIS และ MWL
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// ค่าเริ่มต้น ดึงมาจาก .env เผื่อยังไม่เคยตั้งค่าผ่านหน้าเว็บ
const DEFAULT_SETTINGS = {
  his: {
    // ค่าเริ่มต้น
    hisSystem: process.env.HIS_SYSTEM || '', 
    dbType: process.env.DB_TYPE || '', 
    host: process.env.PGHOST || '',
    port: process.env.PGPORT || '',
    database: process.env.PGDATABASE || '',
    username: process.env.PGUSER || '',
    password: process.env.PGPASSWORD || '',
    encoding: process.env.DB_ENCODING || '',
  },
  mwl: {
    usehl7: process.env.USE_hl7 === 'true' || false,
    hl7Port:process.env.hl7_PORT || '',
    lang: process.env.MWL_LANG === 'th' ? 'th' : 'en',
    aet: process.env.MWL_AET || '',
    port: process.env.MWL_PORT || '',
    mppsPort: process.env.MPPS_PORT || '', // พอร์ตแยกสำหรับรับ MPPS (N-CREATE/N-SET) จากเครื่อง Modality
    worklistDir: process.env.WORKLIST_DIR || '', // โฟลเดอร์เก็บไฟล์ .wl ที่ Orthanc หรือเครื่อง Modality จะมาอ่าน default คือ backend/worklists
    autoGenerate: {
      enabled: process.env.AUTO_GENERATE !== 'false', 
      intervalSec: Number(process.env.AUTO_GENERATE_INTERVAL_SEC) || 10,
      dateback: Number(process.env.AUTO_GENERATE_DATEBACK) || 1,
      include: process.env.AUTO_GENERATE_INCLUDE || '',
      exclude: process.env.AUTO_GENERATE_EXCLUDE || '',
      confirm: process.env.AUTO_GENERATE_CONFIRM === 'true' || false,
    },
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
    console.warn('[Settings] ---> ไม่สามารถอ่านไฟล์ settings.json ได้ ใช้ค่าเริ่มต้นแทน:', err.message);
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
  console.log('[Settings] ---> บันทึกการตั้งค่าใหม่เรียบร้อยแล้ว');
  return merged;
}

module.exports = { 
  loadSettings, 
  saveSettings 
};