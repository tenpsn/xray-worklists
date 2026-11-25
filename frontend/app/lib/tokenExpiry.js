// เตือนเมื่อ token ของ DoctorEase ใกล้หมดอายุหรือหมดอายุแล้ว
// คู่มือ DoctorEase ให้ขอ token ใหม่ก่อนหมดอายุ

const WARN_BEFORE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// คืนข้อความเตือนตามภาษา ถ้ายังไม่ถึงเวลาเตือนจะได้ค่าว่าง
export function getTokenExpiryWarning(fullDict, his) {
  if (!his || his.hisSystem !== 'doctorease' || !his.tokenExpiresAt) return '';

  const expiresAt = new Date(String(his.tokenExpiresAt).replace(' ', 'T'));
  if (Number.isNaN(expiresAt.getTime())) return '';

  const texts = fullDict.tokenExpiry;
  if (expiresAt.getTime() <= Date.now()) return texts.expired(his.tokenExpiresAt);

  // นับเป็นจำนวนวันตามปฏิทิน ไม่สนเวลาในวัน
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expireDay = new Date(expiresAt);
  expireDay.setHours(0, 0, 0, 0);
  const daysLeft = Math.round((expireDay.getTime() - today.getTime()) / DAY_MS);
  if (daysLeft <= WARN_BEFORE_DAYS) return texts.expiringSoon(daysLeft, his.tokenExpiresAt);
  return '';
}
