import romanize from '@dehoist/romanize-thai';

// ตัดข้อความให้เหลือ 17 ตัวอักษร แล้วต่อท้ายด้วย ... รวมเป็น 20 ตัวอักษร
const MAX_LEN = 17;

export function truncateName(text) {
  if (!text) return '';
  const str = String(text);
  return str.length > MAX_LEN ? str.slice(0, MAX_LEN) + '...' : str;
}

// คำนำหน้าที่มีคำแปลอังกฤษ
const ENGLISH_PREFIX_MAP = {
  'พญ': 'Dr.',
  'นพ': 'Dr.',
  'ทพ': 'Dr.',
  'ทพญ': 'Dr.',
  'ดร': 'Dr.',
  'ผศ': 'Asst. Prof.',
  'รศ': 'Assoc. Prof.',
  'ศ': 'Prof.',
  'พว': 'RN',
  'นาย': 'Mr.',
  'นาง': 'Mrs.',
  'นางสาว': 'Ms.',
  'นส': 'Ms.',
};

// คำนำหน้าอื่นที่ไม่มี ไม่ต้องใส่คำนำหน้า
function toEnglishPrefix(rawPrefix) {
  const normalized = String(rawPrefix || '').replace(/ว่าที่/g, '').replace(/[.\s]/g, '');
  return ENGLISH_PREFIX_MAP[normalized] || '';
}

export function formatPrefixField(thaiText, lang) {
  if (lang !== 'en') return truncateName(thaiText);
  return truncateName(toEnglishPrefix(thaiText));
}

// ชื่อ / นามสกุล
// lang === 'th' -> โชว์ภาษาไทย
// lang === 'en' -> โชว์เฉพาะภาษาอังกฤษ
export function formatNameField(thaiText, lang) {
  if (lang !== 'en') return truncateName(thaiText);

  let englishRaw = '';
  try {
    englishRaw = thaiText ? romanize(String(thaiText)) : '';
  } catch (err) {
    // เจอตัวอักษรที่ไลบรารีไม่รู้จักให้ปล่อยว่างไว้
    englishRaw = '';
  }

  return truncateName(englishRaw);
}

// ชื่อแพทย์ในข้อมูลจริงมักเก็บ "คำนำหน้า+ชื่อ" รวมกันเป็นสตริงเดียว เช่น พญ.พิมพ์
// จึงต้องแยกคำนำหน้าออกก่อน ไม่ให้ถูกแปลงเป็นภาษาอังกฤษไปด้วย
const DOCTOR_PREFIX_PATTERN = /^(ว่าที่\s*)?(พญ|นพ|ทพ|ทพญ|นางสาว|นาง|นาย|ดร|ผศ|รศ|ศ|น\.ส|(?:[ก-ฮ]+\.\s*)+(?:หญิง)?)\.?\s*/;

function splitDoctorPrefix(text) {
  const str = String(text || '');
  const match = str.match(DOCTOR_PREFIX_PATTERN);
  if (!match) return { prefix: '', rest: str };
  return { prefix: match[0].trim(), rest: str.slice(match[0].length) };
}

// ชื่อแพทย์
// lang === 'th' -> โชว์ภาษาไทย
// lang === 'en' -> คำนำหน้าแปลเป็นอังกฤษถ้ามี mapping ส่วนชื่อ-นามสกุลแปลงเป็นภาษาอังกฤษ
export function formatDoctorField(thaiText, lang) {
  if (lang !== 'en') return truncateName(thaiText);

  const { prefix, rest } = splitDoctorPrefix(thaiText);

  let englishRaw = '';
  try {
    englishRaw = rest ? romanize(rest) : '';
  } catch (err) {
    englishRaw = '';
  }

  const englishPrefix = prefix ? toEnglishPrefix(prefix) : '';
  const combined = [englishPrefix, englishRaw].filter(Boolean).join(' ').trim();
  return truncateName(combined);
}