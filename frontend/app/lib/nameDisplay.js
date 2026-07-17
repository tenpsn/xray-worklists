import romanize from '@dehoist/romanize-thai';

// ตัดข้อความให้เหลือ 17 ตัวอักษร แล้วต่อท้ายด้วย "..." (รวมเป็น 20 ตัวอักษร) ถ้ายาวเกิน
const MAX_LEN = 17;

export function truncateName(text) {
  if (!text) return '';
  const str = String(text);
  return str.length > MAX_LEN ? str.slice(0, MAX_LEN) + '...' : str;
}

// คำนำหน้า (นาย/นาง/นพ/พญ ฯลฯ) ไม่ต้องแปลงเป็นคาราโอเกะ ให้แสดงเป็นภาษาไทยเสมอ ไม่ว่าจะเลือกภาษาอะไร
export function formatPrefixField(thaiText) {
  return truncateName(thaiText);
}

// ชื่อ / นามสกุล
// lang === 'th' -> โชว์ภาษาไทยเดิม (ตัดตามกฎ 17+...)
// lang === 'en' -> โชว์เฉพาะคาราโอเกะ (ภาษาอังกฤษ) เท่านั้น ไม่ต่อท้ายภาษาไทยแล้ว (ตัดตามกฎ 17+...)
export function formatNameField(thaiText, lang) {
  if (lang !== 'en') return truncateName(thaiText);

  let englishRaw = '';
  try {
    englishRaw = thaiText ? romanize(String(thaiText)) : '';
  } catch (err) {
    // ถ้าแปลงไม่ได้ (เช่น เจอตัวอักษรที่ไลบรารีไม่รู้จัก) ให้ปล่อยว่างไว้ ไม่ทำให้หน้าเว็บพัง
    englishRaw = '';
  }

  return truncateName(englishRaw);
}

// ชื่อแพทย์ในข้อมูลจริงมักเก็บ "คำนำหน้า+ชื่อ" รวมกันเป็นสตริงเดียว เช่น พญ.พิมพ์
// จึงต้องแยกคำนำหน้าออกก่อน ไม่ให้ถูกแปลงเป็นคาราโอเกะไปด้วย
const DOCTOR_PREFIX_PATTERN = /^(พญ|นพ|นางสาว|นาง|นาย|ดร|ผศ|รศ|ศ|น\.ส)\.?\s*/;

function splitDoctorPrefix(text) {
  const str = String(text || '');
  const match = str.match(DOCTOR_PREFIX_PATTERN);
  if (!match) return { prefix: '', rest: str };
  return { prefix: match[0].trim(), rest: str.slice(match[0].length) };
}

// ชื่อแพทย์
// lang === 'th' -> โชว์ภาษาไทยเดิมทั้งหมด (ตัดตามกฎ 17+...)
// lang === 'en' -> คำนำหน้ายังเป็นภาษาไทย ส่วนชื่อ-นามสกุลแปลงเป็นคาราโอเกะ (ตัดรวมกันตามกฎ 17+...)
export function formatDoctorField(thaiText, lang) {
  if (lang !== 'en') return truncateName(thaiText);

  const { prefix, rest } = splitDoctorPrefix(thaiText);

  let englishRaw = '';
  try {
    englishRaw = rest ? romanize(rest) : '';
  } catch (err) {
    englishRaw = '';
  }

  const combined = prefix ? `${prefix} ${englishRaw}`.trim() : englishRaw;
  return truncateName(combined);
}