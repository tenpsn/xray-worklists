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
    lang: process.env.MWL_LANG === 'th' ? 'th' : 'en',
    // ยังไม่เคยเลือกภาษาของหน้าเว็บผ่านหน้าแรกเลย - ใช้แยกจาก lang เพราะ lang มีค่า default อยู่แล้วเสมอ แยกไม่ออกว่า "ยังไม่เลือก" กับ "เลือกอังกฤษแล้ว"
    uiLangConfirmed: false,
    aet: process.env.MWL_AET || 'ORTHANC',
    port: process.env.MWL_PORT || '4242',
    mppsPort: process.env.MPPS_PORT || '7001', // พอร์ตแยกสำหรับรับ MPPS (N-CREATE/N-SET) จากเครื่อง Modality
    // charset ที่ประกาศ/เข้ารหัสในไฟล์ .wl: 'UTF8' = ISO_IR 192 (ค่าเริ่มต้น), 'TIS620' = ISO_IR 166
    // เครื่อง Modality บางรุ่นไม่รองรับ UTF-8 เต็มรูปแบบ ทำให้ตัวอักษรไทยในชื่อแพทย์/รายการตรวจเพี้ยน ต้องเปลี่ยนมาใช้ TIS620 แทน
    dicomCharset: process.env.MWL_DICOM_CHARSET === 'TIS620' ? 'TIS620' : 'UTF8',
    // true (ค่าเริ่มต้น) = แสดงคอลัมน์ "คำนำหน้า" (นาย/นาง/พญ. ฯลฯ) ในตาราง worklist, false = ซ่อน
    showNamePrefix: true,
    // true (ค่าเริ่มต้น) = DicomAlwaysAllowFind/FindWorklist เปิดหมด ไม่ต้องลงทะเบียนเครื่อง Modality ก็ query ได้
    // false = ปิดหมด ต้องลงทะเบียนเครื่อง Modality ทีละแถวใน modalities ด้านล่างเท่านั้นถึงจะ query ได้
    modalityAlwaysAllow: true,
    modalities: [], // [{ aet, ip, port }] รายการเครื่อง Modality ที่ลงทะเบียนไว้ (ลงทะเบียนใน DicomModalities), เพิ่มได้หลายแถว
    // รายการรหัส Modality ที่เลือกได้ในหน้าเว็บ (ทั้งหัวข้อจัดกลุ่ม Modality และพอร์ต Worklist แยกตามประเภทเครื่อง)
    // แก้ไข/เพิ่มได้จากหน้า Settings เอง ไม่ต้องแก้โค้ด - ค่าเริ่มต้นคือ 7 ตัวที่ระบบรองรับมาแต่ต้น
    modalityTypes: ['CR', 'US', 'CT', 'MR', 'MG', 'IO', 'ECG'],
    // groupId: modality แก้ทับค่าเดา built-in ตอนที่ รพ.นี้ตั้งเลข group ใน HIS ไม่ตรงกับที่โค้ดเดาไว้
    modalityGroupOverride: {},
    // [{ modality, lang, charset, port }] เช่น [{modality:'CR', lang:'th', charset:'TIS620', port:'4243'}]
    // เปิด Worklist SCP แยกพอร์ตต่อ modality+ภาษา+encoding (worklistScpService.js) ใช้กับเครื่อง Modality ที่ตั้งค่า filter/AE Title เองไม่ได้
    // charset: 'UTF8' (ISO_IR 192) | 'TIS620' (ISO_IR 166) - เลือกได้อิสระต่อพอร์ต ไม่ผูกกับ dicomCharset ตัว global ด้านบน
    // lang ว่าง = ไม่กรองภาษา (พฤติกรรมเดิมก่อนรองรับภาษา) ไม่ระบุแถว = ไม่เปิดพอร์ตนั้น (ค่าเริ่มต้นว่างทั้งหมด ไม่กระทบระบบเดิม)
    modalityPorts: [],
    worklistDir: process.env.WORKLIST_DIR || '', // โฟลเดอร์เก็บไฟล์ .wl ที่ Orthanc หรือเครื่อง Modality จะมาอ่าน default คือ backend/worklists
    autoGenerate: {
      intervalSec: Number(process.env.AUTO_GENERATE_INTERVAL_SEC) || 10,
      dateback: Number(process.env.AUTO_GENERATE_DATEBACK) || 1,
      include: process.env.AUTO_GENERATE_INCLUDE || '',
      exclude: process.env.AUTO_GENERATE_EXCLUDE || '',
      confirm: process.env.AUTO_GENERATE_CONFIRM === 'true' || false,
      confirmLogic: process.env.AUTO_GENERATE_CONFIRM_LOGIC || 'both',
    },
  },
};

// รองรับไฟล์ settings.json เก่าที่ยังเก็บ modalityAet/modalityIp เดี่ยว (ก่อนรองรับหลายแถว)
// แปลงเป็น modalities: [{ aet, ip, port }] แถวเดียว และปิด modalityAlwaysAllow เพราะของเดิมลงทะเบียนไว้แบบเจาะจงอยู่แล้ว
function migrateLegacyModality(savedMwl) {
  if (!savedMwl || savedMwl.modalities || (!savedMwl.modalityAet && !savedMwl.modalityIp)) {
    return savedMwl;
  }
  const { modalityAet, modalityIp, ...rest } = savedMwl;
  return {
    ...rest,
    modalityAlwaysAllow: false,
    modalities: [{ aet: modalityAet || '', ip: modalityIp || '', port: 104 }],
  };
}

// รองรับ modalityPorts รูปแบบเก่า { [modalityCode]: port } (ก่อนรองรับแยกตามภาษา)
// แปลงเป็น [{ modality, lang: '', charset, port }] แถวละ modality - lang ว่าง = ไม่กรองภาษา เหมือนพฤติกรรมเดิม
// และเติม charset ให้แถวเก่าที่ยังไม่มี (ก่อนรองรับเลือก encoding ต่อพอร์ต) - ใช้ dicomCharset ตัว global เดิมเป็นค่าเริ่มต้น
// ให้พฤติกรรมเหมือนก่อนอัพเดท (ตอนนั้นทุกพอร์ตใช้ encoding เดียวกับ global อยู่แล้ว)
function migrateLegacyModalityPorts(savedMwl) {
  if (!savedMwl || !savedMwl.modalityPorts) return savedMwl;
  const fallbackCharset = savedMwl.dicomCharset === 'TIS620' ? 'TIS620' : 'UTF8';

  if (!Array.isArray(savedMwl.modalityPorts)) {
    return {
      ...savedMwl,
      modalityPorts: Object.entries(savedMwl.modalityPorts).map(([modality, port]) => ({
        modality, lang: '', charset: fallbackCharset, port,
      })),
    };
  }

  const hasMissingCharset = savedMwl.modalityPorts.some((e) => !e.charset);
  if (!hasMissingCharset) return savedMwl;

  return {
    ...savedMwl,
    modalityPorts: savedMwl.modalityPorts.map((e) => ({ ...e, charset: e.charset || fallbackCharset })),
  };
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return {
        his: { ...DEFAULT_SETTINGS.his, ...(saved.his || {}) },
        mwl: { ...DEFAULT_SETTINGS.mwl, ...migrateLegacyModalityPorts(migrateLegacyModality(saved.mwl || {})) },
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