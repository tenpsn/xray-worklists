'use client';

import { useEffect, useState } from 'react';
import UiLangRedirect from './lib/UiLangRedirect';

export default function RootRedirect() {
  const [target, setTarget] = useState(null);

  // MOPH ส่ง code กลับมาที่หน้าแรก ส่งต่อไปหน้าคิวส่งภาพเพื่อแลกเป็น token
  useEffect(() => {
    const search = window.location.search;
    setTarget(new URLSearchParams(search).get('code') ? `/image-queue${search}` : '/');
  }, []);

  if (!target) return null;
  return <UiLangRedirect target={target} />;
}
