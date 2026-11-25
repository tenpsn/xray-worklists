// เตือนเมื่อ token ของ DoctorEase ใกล้หมดอายุหรือหมดอายุแล้ว
// ถ้าเปิดต่ออายุอัตโนมัติ จะเตือนเฉพาะตอนที่ระบบขอ token ใหม่ไม่สำเร็จ

import { useEffect, useState } from 'react';

const WARN_BEFORE_DAYS = 30;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function parseDate(value) {
  const date = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(date) {
  return date.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
}

// คืนข้อความเตือนตามภาษา ถ้ายังไม่ถึงเวลาเตือนจะได้ค่าว่าง
export function getTokenExpiryWarning(fullDict, his) {
  if (!his || his.hisSystem !== 'doctorease') return '';
  const texts = fullDict.tokenExpiry;

  if (his.autoRenewToken) {
    const failedAt = his.tokenRenewFailedAt && parseDate(his.tokenRenewFailedAt);
    return failedAt ? texts.autoRenewFailed(formatDateTime(failedAt)) : '';
  }

  if (!his.tokenExpiresAt) return '';
  const expiresAt = parseDate(his.tokenExpiresAt);
  if (!expiresAt) return '';

  const msLeft = expiresAt.getTime() - Date.now();
  if (msLeft <= 0) return texts.expired(his.tokenExpiresAt);

  // เหลือไม่ถึงวันให้บอกเป็นชั่วโมง นาที และวินาที
  if (msLeft < DAY_MS) {
    const hours = Math.floor(msLeft / HOUR_MS);
    const minutes = Math.floor((msLeft % HOUR_MS) / MINUTE_MS);
    const seconds = Math.floor((msLeft % MINUTE_MS) / 1000);
    return texts.expiringSoonTime(hours, minutes, seconds, his.tokenExpiresAt);
  }

  // นับเป็นจำนวนวันตามปฏิทิน ไม่สนเวลาในวัน
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expireDay = new Date(expiresAt);
  expireDay.setHours(0, 0, 0, 0);
  const daysLeft = Math.round((expireDay.getTime() - today.getTime()) / DAY_MS);
  if (daysLeft <= WARN_BEFORE_DAYS) return texts.expiringSoon(daysLeft, his.tokenExpiresAt);
  return '';
}

// คำนวณคำเตือนใหม่ทุกวินาที ให้เวลาที่เหลือนับถอยหลังบนหน้าเว็บ
// นับเฉพาะตอนที่ไม่ได้ต่ออายุอัตโนมัติ หน้าเว็บจะได้ไม่ทำงานหนักเกินไป
export function useTokenExpiryWarning(fullDict, his) {
  const [, setTick] = useState(0);
  const needsCountdown = Boolean(his && his.hisSystem === 'doctorease' && !his.autoRenewToken && his.tokenExpiresAt);
  useEffect(() => {
    if (!needsCountdown) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [needsCountdown]);
  return getTokenExpiryWarning(fullDict, his);
}
