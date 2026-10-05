'use client';

// อัปโหลดไฟล์ DICOM เองจากหน้าเว็บ เข้าคิวเดียวกับภาพจากเครื่องเอกซเรย์
// บอกก่อนอัปโหลดว่า PACS หรือ ImageHub เปิดอยู่ เพราะไฟล์จะถูกส่งต่อทันที

import { useRef, useState } from 'react';

export default function DicomUpload({ dict, pacsEnabled, imagehubEnabled, onUploaded }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState(null); // จำนวนที่เสร็จและทั้งหมด
  const [results, setResults] = useState([]); // ผลของแต่ละไฟล์

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0 || progress) return;
    const nextResults = [];
    setResults([]);
    for (let i = 0; i < files.length; i += 1) {
      setProgress({ done: i, total: files.length });
      const file = files[i];
      try {
        const res = await fetch('/api/image-queue/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
        const json = await res.json();
        nextResults.push(json.success
          ? { name: file.name, ok: true, text: dict.uploadOkLine(json.patientId, json.modality) }
          : { name: file.name, ok: false, text: json.message || `HTTP ${res.status}` });
      } catch (err) {
        nextResults.push({ name: file.name, ok: false, text: err.message });
      }
      setResults([...nextResults]);
    }
    setProgress(null);
    if (inputRef.current) inputRef.current.value = '';
    if (onUploaded) onUploaded();
  }

  const targetsOn = [pacsEnabled ? 'PACS' : '', imagehubEnabled ? 'ImageHub' : ''].filter(Boolean);
  const okCount = results.filter((r) => r.ok).length;

  return (
    <div className="settings-card">
      <h3>{dict.uploadTitle}</h3>
      <p className="field-note" style={{ marginTop: 0, marginBottom: '6px' }}>{dict.uploadNote}</p>
      <p style={{ fontSize: '13px', margin: '0 0 10px', color: targetsOn.length ? '#b45309' : '#6b7280', fontWeight: targetsOn.length ? 600 : 400 }}>
        {targetsOn.length ? dict.uploadWillSend(targetsOn.join(', ')) : dict.uploadNoSend}
      </p>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); uploadFiles(e.dataTransfer.files); }}
        style={{
          border: `2px dashed ${dragOver ? '#2563eb' : '#cbd5e1'}`,
          background: dragOver ? '#eff6ff' : '#f9fafb',
          borderRadius: '8px',
          padding: '24px 16px',
          textAlign: 'center',
          color: '#475569',
          fontSize: '14px',
        }}
      >
        {progress ? (
          <span>{dict.uploadProgress(progress.done + 1, progress.total)}</span>
        ) : (
          <>
            <div style={{ marginBottom: '8px' }}>{dict.uploadDrop}</div>
            <div style={{ fontSize: '12px', marginBottom: '8px' }}>{dict.uploadOr}</div>
            <button type="button" onClick={() => inputRef.current && inputRef.current.click()}>{dict.uploadChoose}</button>
          </>
        )}
        {/* ไฟล์ DICOM มักไม่มีนามสกุล จึงไม่จำกัดชนิดไฟล์ ให้ backend ตรวจเอง */}
        <input ref={inputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => uploadFiles(e.target.files)} />
      </div>

      {results.length > 0 && (
        <div style={{ marginTop: '10px', fontSize: '13px' }}>
          {!progress && <div style={{ fontWeight: 600, marginBottom: '4px' }}>{dict.uploadDone(okCount, results.length - okCount)}</div>}
          {results.map((r, idx) => (
            <div key={`${r.name}-${idx}`} style={{ color: r.ok ? '#15803d' : '#b91c1c' }}>
              {r.ok ? '✓' : '✗'} {r.name}: {r.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
