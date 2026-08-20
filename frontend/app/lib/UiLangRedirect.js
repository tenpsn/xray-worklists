'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function UiLangRedirect({ target }) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    async function run() {
      let confirmed = false;
      let lang = 'en';
      try {
        const res = await fetch('/api/settings', { cache: 'no-store' });
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
