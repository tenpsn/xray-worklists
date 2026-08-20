'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

// ใช้แทนที่ redirect() แบบ server-side เดิม เพราะ NEXT_PUBLIC_API_URL (เช่น http://localhost:4000)
// ใช้งานได้ถูกต้องแค่จากฝั่ง browser เท่านั้น - ถ้า fetch จากใน container frontend เอง (server component)
// "localhost:4000" จะหมายถึง container ของ frontend เอง ไม่ใช่ backend เลยต้องเช็คจากฝั่ง client แทน
export default function UiLangRedirect({ target }) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    async function run() {
      let confirmed = false;
      let lang = 'en';
      try {
        const res = await fetch(`${API_URL}/api/settings`, { cache: 'no-store' });
        const json = await res.json();
        if (json.success) {
          confirmed = json.settings?.mwl?.uiLangConfirmed === true;
          lang = json.settings?.mwl?.lang === 'th' ? 'th' : 'en';
        }
      } catch (err) {
        // เชื่อมต่อ backend ไม่ได้ - ปล่อยให้ default เป็นอังกฤษไปก่อน ไม่บล็อกผู้ใช้ไว้เฉยๆ
      }

      if (cancelled) return;
      if (!confirmed) {
        router.replace(`/choose-language?next=${encodeURIComponent(target)}`);
      } else {
        router.replace(`/${lang}${target}`);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [router, target]);

  return null;
}
