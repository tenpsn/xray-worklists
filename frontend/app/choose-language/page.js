'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

function ChooseLanguageForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') || '/';

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // บันทึกภาษาที่เลือกลง mwl.lang + mwl.uiLangConfirmed แล้วพาไปหน้าที่ต้องการต่อ
  // ไม่สนใจผลตรวจสอบฐานข้อมูล (dbError) เพราะ backend เซฟค่านี้ลงไฟล์เสร็จก่อนจะไปทดสอบต่อฐานข้อมูลเสมอ
  async function choose(lang) {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`${API_URL}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mwl: { lang, uiLangConfirmed: true } }),
      });
      await res.json();
      router.push(`/${lang}${next}`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="choose-language-page">
      <h1>เลือกภาษา / Choose Language</h1>
      <p>เลือกได้ครั้งนี้ครั้งเดียว เปลี่ยนทีหลังได้ในหน้าตั้งค่าระบบ<br />Choose once — you can change it later in System Settings.</p>
      {error && <div className="status status-error">{error}</div>}
      <div className="choose-language-buttons">
        <button disabled={saving} onClick={() => choose('th')}>ไทย</button>
        <button disabled={saving} onClick={() => choose('en')}>English</button>
      </div>
    </div>
  );
}

export default function ChooseLanguagePage() {
  return (
    <Suspense fallback={null}>
      <ChooseLanguageForm />
    </Suspense>
  );
}
