'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { getDictionary } from '../lib/i18n';

export default function HomePage() {
  const { lang: rawLang } = useParams();
  const lang = rawLang === 'th' ? 'th' : 'en';
  const dict = getDictionary(lang).home;

  return (
    <div className="menu-page">
      <h1>{dict.title}</h1>
      <div className="menu-grid">
        <Link className="menu-card" href={`/${lang}/worklists`}>
          <div className="menu-icon">🩻</div>
          <h2>{dict.worklistCardTitle}</h2>
          <p>{dict.worklistCardDesc}</p>
        </Link>
        <Link className="menu-card" href={`/${lang}/orthanc-cleaner`}>
          <div className="menu-icon">🗑️</div>
          <h2>{dict.cleanerCardTitle}</h2>
          <p>{dict.cleanerCardDesc}</p>
        </Link>
      </div>
    </div>
  );
}
