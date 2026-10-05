'use client';

import { useEffect, useState } from 'react';
import UiLangRedirect from '../lib/UiLangRedirect';

// ใช้เมื่อตั้งที่อยู่กลับของ MOPH มาที่หน้านี้แทนหน้าแรก
// ส่งต่อ code ไปหน้าคิวส่งภาพ
export default function ImagehubCallbackPage() {
  const [search, setSearch] = useState(null);

  useEffect(() => {
    setSearch(window.location.search);
  }, []);

  if (search === null) return null;
  return <UiLangRedirect target={`/image-queue${search}`} />;
}
