'use client';

// Login MOPH เพื่อส่งภาพขึ้น ImageHub พร้อมนับถอยหลัง session และปุ่ม Logoff
// secret และ token อยู่ที่ backend เท่านั้น หน้าเว็บรู้แค่สถานะ เวลาหมดอายุ และชื่อผู้ใช้

import { useCallback, useEffect, useState } from 'react';

const REDIRECT_STORAGE_KEY = 'imagehubRedirectUri';

export async function fetchImagehubToken() {
  const res = await fetch('/api/image-queue/imagehub/token', { cache: 'no-store' });
  const json = await res.json();
  return json.success ? json.token : null;
}

// ไปหน้า Login ของ MOPH ถ้าไม่ระบุที่อยู่กลับ จะกลับมาที่หน้าแรกของเว็บ
// ถ้าเริ่มไม่ได้ เช่น ยังไม่ตั้ง Client ID จะคืนข้อความผิดพลาด
export async function startImagehubLogin(redirectUriOverride) {
  const redirectUri = String(redirectUriOverride || '').trim() || window.location.origin;
  const res = await fetch('/api/image-queue/imagehub/login-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirectUri }),
  });
  const json = await res.json();
  if (!json.success) return json.message || 'login-url failed';
  // ตอนแลก code ต้องใช้ที่อยู่กลับตัวเดียวกับตอนขอ code
  try { sessionStorage.setItem(REDIRECT_STORAGE_KEY, redirectUri); } catch (err) { /* ไม่มีที่เก็บก็ใช้หน้าแรกของเว็บ */ }
  window.location.href = json.url;
  return null;
}

// แลก code ที่ MOPH ส่งกลับมาเป็น token ที่ backend
export async function exchangeImagehubCode(code) {
  let redirectUri = window.location.origin;
  try { redirectUri = sessionStorage.getItem(REDIRECT_STORAGE_KEY) || redirectUri; } catch (err) { /* ใช้หน้าแรกของเว็บ */ }
  const res = await fetch('/api/image-queue/imagehub/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirectUri }),
  });
  const json = await res.json();
  if (json.success) {
    try { sessionStorage.removeItem(REDIRECT_STORAGE_KEY); } catch (err) { /* ไม่เป็นไร */ }
    return { ok: true, token: json.token };
  }
  return { ok: false, message: json.message || '' };
}

export async function logoutImagehub() {
  const res = await fetch('/api/image-queue/imagehub/logout', { method: 'POST' });
  const json = await res.json();
  return json.token || null;
}

// แสดงเวลาที่เหลือ โดยไม่แสดงวันหรือชั่วโมงที่เป็นศูนย์ข้างหน้า
// เช่น 4 นาที 30 วินาที
export function formatTimeLeft(expires, dict) {
  const diff = Date.parse(expires) - Date.now();
  if (!(diff > 0)) return dict.sessionExpired;
  const totalSec = Math.floor(diff / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  const parts = [];
  if (days > 0) parts.push(dict.sessionDays(days));
  if (days > 0 || hours > 0) parts.push(dict.sessionHours(days > 0 ? pad(hours) : hours));
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (parts.length > 0 || minutes > 0) parts.push(dict.sessionMinutes(parts.length > 0 ? pad(minutes) : minutes));
  parts.push(dict.sessionSeconds(parts.length > 0 ? pad(totalSec % 60) : totalSec % 60));
  return parts.join(' ');
}

const SESSION_WARN_MS = 60 * 60 * 1000; // เหลือไม่ถึง 1 ชั่วโมง แสดงเวลาเป็นสีแดง

// สถานะ token และนับถอยหลังทุกวินาที หมดเวลาแล้วถือว่าต้อง Login ใหม่ทันที
export function useImagehubSession() {
  const [token, setToken] = useState(null);
  const [, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setToken(await fetchImagehubToken());
    } catch (err) {
      setToken(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  const loggedIn = Boolean(token && token.valid && Date.parse(token.expires) > Date.now());
  return { token, loggedIn, refresh, setToken };
}

// แถบแสดงเวลาที่ session จะหมดอายุ พร้อมปุ่ม Logoff
export function ImagehubSessionBar({ session, dict }) {
  const [busy, setBusy] = useState(false);
  if (!session.loggedIn) return null;
  const nearExpiry = Date.parse(session.token.expires) - Date.now() < SESSION_WARN_MS;
  async function handleLogoff() {
    setBusy(true);
    try {
      session.setToken(await logoutImagehub());
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '13px', color: '#6b7280' }}>
      {session.token.username && (
        <span style={{ padding: '2px 10px', borderRadius: '999px', background: '#eef2ff', color: '#3730a3', fontWeight: 500 }}>
          {dict.sessionUserPrefix} {session.token.username}
        </span>
      )}
      <span>
        {dict.sessionExpiresIn}{' '}
        <span style={{ color: nearExpiry ? '#b91c1c' : '#111827', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {formatTimeLeft(session.token.expires, dict)}
        </span>
      </span>
      <button type="button" className="settings-link" onClick={handleLogoff} disabled={busy}>{dict.logoffButton}</button>
    </div>
  );
}

// ปุ่ม Login ImageHub แสดงเฉพาะตอนยังไม่ได้ Login
// เหตุผลที่ต้อง Login ใหม่จะแสดงตอนชี้เมาส์ที่ปุ่ม
export function ImagehubLoginButton({ session, dict, redirectUri, disabled }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (session.loggedIn) return null;

  async function handleLogin() {
    setBusy(true);
    setError('');
    try {
      const message = await startImagehubLogin(redirectUri);
      if (message) setError(message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const reason = session.token && session.token.invalidatedReason;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
      <button type="button" className="settings-link" onClick={handleLogin} disabled={busy || disabled} title={reason || ''}>
        {dict.loginButton}
      </button>
      {error && <span style={{ fontSize: '12px', color: '#b91c1c' }}>{error}</span>}
    </span>
  );
}
