'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { getDictionary } from '../../../lib/i18n';

const DEFAULT_FORM = {
  imageStore: {
    enabled: false, // รับภาพจากเครื่องเอกซเรย์เก็บลงโฟลเดอร์คิว
    aet: '', // AE Title ที่เครื่องต้องเรียกเข้ามา ถ้าว่างจะไม่ตรวจ
    port: '',
  },
  pacs: {
    enabled: false, // ส่งภาพจากคิวเข้า PACS ถ้าปิดภาพจะรอในคิว
    aet: '',
    host: '',
    port: '',
  },
  imagehub: {
    enabled: false, // ส่งภาพจากคิวขึ้น MOPH ImageHub ถ้าปิดภาพจะรอในคิว
    hoscode: '', // รหัสสถานพยาบาล
    modalities: [],
    clientId: '',
    secretKey: '', // backend ส่งมาเป็นค่าปิดบัง ถ้าส่งค่านี้กลับไปจะคงค่าเดิม
    clientId2: '',
    secretKey2: '',
  },
};

export default function ImageQueueSettingsPage() {
  const { lang: rawLang } = useParams();
  const lang = rawLang === 'th' ? 'th' : 'en';
  const fullDict = getDictionary(lang);
  const dict = fullDict.settings;
  const queueDict = fullDict.imageQueue;

  const [form, setForm] = useState(DEFAULT_FORM);
  const [status, setStatus] = useState({ text: dict.statusLoading, type: 'info' });
  const [saving, setSaving] = useState(false);
  const [imageStoreStatus, setImageStoreStatus] = useState(null);
  const [pacsEchoing, setPacsEchoing] = useState(false);
  const [pacsEchoResult, setPacsEchoResult] = useState(null);
  // เก็บข้อความช่อง Modality แยกไว้ เพื่อให้พิมพ์จุลภาคและช่องว่างได้ระหว่างพิมพ์
  const [modalitiesText, setModalitiesText] = useState('');

  // Secret Key จริงไม่ถูกส่งมาที่หน้าเว็บ ช่องกรอกจึงว่างไว้
  // แล้วแสดงแค่ว่ามีค่าบันทึกไว้แล้ว
  const [savedSecrets, setSavedSecrets] = useState({ secretKey: false, secretKey2: false });

  function applyLoadedSettings(json) {
    const imagehub = { ...DEFAULT_FORM.imagehub, ...json.imagehub };
    setSavedSecrets({ secretKey: Boolean(imagehub.secretKey), secretKey2: Boolean(imagehub.secretKey2) });
    setForm({
      imageStore: { ...DEFAULT_FORM.imageStore, ...json.imageStore },
      pacs: { ...DEFAULT_FORM.pacs, ...json.pacs },
      imagehub: { ...imagehub, secretKey: '', secretKey2: '' },
    });
    setModalitiesText((json.imagehub?.modalities || []).join(', '));
  }

  function updateImagehub(field, value) {
    setForm((prev) => ({ ...prev, imagehub: { ...prev.imagehub, [field]: value } }));
  }

  async function loadImageStoreStatus() {
    try {
      const res = await fetch('/api/image-queue/receiver');
      const json = await res.json();
      setImageStoreStatus(json.success ? json : null);
    } catch (err) {
      setImageStoreStatus(null);
    }
  }

  useEffect(() => {
    async function loadSettings() {
      try {
        const res = await fetch('/api/image-queue/settings');
        const json = await res.json();
        if (json.success) {
          applyLoadedSettings(json);
          setStatus({ text: dict.statusLoaded, type: 'info' });
        } else {
          setStatus({ text: dict.statusLoadFailed, type: 'error' });
        }
      } catch (err) {
        setStatus({ text: dict.connectErrorPrefix + err.message, type: 'error' });
      }
    }
    loadSettings();
    loadImageStoreStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateImageStore(field, value) {
    setForm((prev) => ({ ...prev, imageStore: { ...prev.imageStore, [field]: value } }));
  }

  function updatePacs(field, value) {
    setForm((prev) => ({ ...prev, pacs: { ...prev.pacs, [field]: value } }));
  }

  // ทดสอบเชื่อมต่อ PACS ด้วยค่าที่กรอกอยู่ ไม่ต้องบันทึกก่อน และไม่ส่งภาพ
  async function handlePacsEcho() {
    setPacsEchoing(true);
    setPacsEchoResult(null);
    try {
      const res = await fetch('/api/image-queue/pacs-echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aet: form.pacs.aet, host: form.pacs.host, port: form.pacs.port }),
      });
      const json = await res.json();
      setPacsEchoResult({ ok: json.success, message: json.message });
    } catch (err) {
      setPacsEchoResult({ ok: false, message: dict.connectErrorPrefix + err.message });
    } finally {
      setPacsEchoing(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setStatus({ text: dict.savingStatus, type: 'info' });
    try {
      const payload = {
        imageStore: {
          ...form.imageStore,
          aet: String(form.imageStore.aet || '').trim(),
          port: String(form.imageStore.port || '').trim(),
        },
        pacs: {
          ...form.pacs,
          aet: String(form.pacs.aet || '').trim(),
          host: String(form.pacs.host || '').trim(),
          port: String(form.pacs.port || '').trim(),
        },
        // ส่งเฉพาะช่องที่มีในหน้านี้ ที่อยู่ระบบ MOPH และ ImageHub backend คงค่าไว้เอง
        imagehub: {
          enabled: form.imagehub.enabled,
          hoscode: String(form.imagehub.hoscode || '').trim(),
          modalities: modalitiesText.split(',').map((m) => m.trim().toUpperCase()).filter(Boolean),
          clientId: String(form.imagehub.clientId || '').trim(),
          // ช่องว่างจะไม่ถูกส่ง backend จึงคงค่าเดิมไว้
          secretKey: form.imagehub.secretKey || undefined,
          clientId2: String(form.imagehub.clientId2 || '').trim(),
          secretKey2: form.imagehub.secretKey2 || undefined,
        },
      };
      const res = await fetch('/api/image-queue/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.success) {
        applyLoadedSettings(json);
        const warning = json.warningText ? ` (${queueDict.warningPrefix}${json.warningText})` : '';
        setStatus({ text: queueDict.savedText + warning, type: json.warningText ? 'error' : 'success' });
      } else {
        setStatus({ text: queueDict.saveFailedPrefix + (json.message || ''), type: 'error' });
      }
      await loadImageStoreStatus();
    } catch (err) {
      setStatus({ text: dict.connectErrorPrefix + err.message, type: 'error' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1>{queueDict.settingsTitle}</h1>
      <div className={`status status-${status.type}`}>{status.text}</div>

      <div className="settings-card">
        <h2>{dict.imageStoreSectionTitle}</h2>
        <div className="toggle-box">
          <label className="toggle-row">
            <input
              type="checkbox"
              className="toggle-switch"
              checked={form.imageStore.enabled}
              onChange={(e) => updateImageStore('enabled', e.target.checked)}
            />
            <span>{dict.imageStoreEnabledLabel}</span>
          </label>
          <p className="field-note" style={{ margin: '6px 0 0' }}>{dict.imageStoreEnabledNote}</p>
        </div>

        <div className="settings-grid settings-grid-compact" style={{ marginTop: '14px' }}>
          <label>
            {dict.imageStoreAetLabel}
            <input
              type="text"
              placeholder={dict.imageStoreAetPlaceholder}
              value={form.imageStore.aet}
              onChange={(e) => updateImageStore('aet', e.target.value)}
            />
          </label>

          <label>
            {dict.imageStorePortLabel}
            <input
              type="text"
              placeholder={dict.imageStorePortPlaceholder}
              value={form.imageStore.port}
              onChange={(e) => updateImageStore('port', e.target.value)}
            />
          </label>
        </div>
        {imageStoreStatus && (
          <div style={{ fontSize: '12px', color: '#666', marginTop: '6px' }}>
            {dict.imageStoreStatusPrefix}
            {imageStoreStatus.running ? `${dict.imageStoreRunning} (port ${imageStoreStatus.port})` : dict.imageStoreStopped}
            {' · '}
            {dict.imageStoreQueuedPrefix}{imageStoreStatus.queuedFiles}
            {' · '}
            <code>{imageStoreStatus.queueDir}</code>
          </div>
        )}
      </div>

      <div className="settings-card">
        <h2>{dict.pacsSectionTitle}</h2>
        <div className="toggle-box">
          <label className="toggle-row">
            <input
              type="checkbox"
              className="toggle-switch"
              checked={form.pacs.enabled}
              onChange={(e) => updatePacs('enabled', e.target.checked)}
            />
            <span>{dict.pacsEnabledLabel}</span>
          </label>
          <p className="field-note" style={{ margin: '6px 0 0' }}>{dict.pacsEnabledNote}</p>
        </div>

        <div className="settings-grid settings-grid-compact" style={{ marginTop: '14px' }}>
          <label>
            {dict.pacsAetLabel}
            <input
              type="text"
              placeholder={dict.pacsAetPlaceholder}
              value={form.pacs.aet}
              onChange={(e) => updatePacs('aet', e.target.value)}
            />
          </label>

          <label>
            {dict.pacsHostLabel}
            <input
              type="text"
              placeholder={dict.pacsHostPlaceholder}
              value={form.pacs.host}
              onChange={(e) => updatePacs('host', e.target.value)}
            />
          </label>

          <label>
            {dict.pacsPortLabel}
            <input
              type="text"
              placeholder={dict.pacsPortPlaceholder}
              value={form.pacs.port}
              onChange={(e) => updatePacs('port', e.target.value)}
            />
          </label>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' }}>
          <button type="button" onClick={handlePacsEcho} disabled={pacsEchoing}>
            {pacsEchoing ? dict.pacsEchoTesting : dict.pacsEchoButton}
          </button>
          {pacsEchoResult && (
            <span style={{ fontSize: '13px', color: pacsEchoResult.ok ? '#15803d' : '#b91c1c' }}>{pacsEchoResult.message}</span>
          )}
        </div>
      </div>

      <div className="settings-card">
        <h2>{queueDict.imagehubSectionTitle}</h2>

        <div className="toggle-box">
          <label className="toggle-row">
            <input
              type="checkbox"
              className="toggle-switch"
              checked={form.imagehub.enabled}
              onChange={(e) => updateImagehub('enabled', e.target.checked)}
            />
            <span>{queueDict.imagehubEnabledLabel}</span>
          </label>
          <p className="field-note" style={{ margin: '6px 0 0' }}>{queueDict.imagehubEnabledNote}</p>
        </div>

        <div className="stacked-fields">
          <label>
            {queueDict.imagehubClientIdLabel} *
            <input type="text" autoComplete="off" value={form.imagehub.clientId} onChange={(e) => updateImagehub('clientId', e.target.value)} />
          </label>
          <label>
            {queueDict.imagehubSecretKeyLabel}
            <input type="password" autoComplete="new-password" value={form.imagehub.secretKey} onChange={(e) => updateImagehub('secretKey', e.target.value)} />
            {savedSecrets.secretKey && <span className="field-hint">{queueDict.secretSavedHint}</span>}
          </label>
          <label>
            {queueDict.imagehubClientId2Label} *
            <input type="text" autoComplete="off" value={form.imagehub.clientId2} onChange={(e) => updateImagehub('clientId2', e.target.value)} />
          </label>
          <label>
            {queueDict.imagehubSecretKey2Label}
            <input type="password" autoComplete="new-password" value={form.imagehub.secretKey2} onChange={(e) => updateImagehub('secretKey2', e.target.value)} />
            {savedSecrets.secretKey2 && <span className="field-hint">{queueDict.secretSavedHint}</span>}
          </label>
          <label>
            {queueDict.imagehubHoscodeLabel}
            <input type="text" value={form.imagehub.hoscode} onChange={(e) => updateImagehub('hoscode', e.target.value)} />
          </label>
          <label>
            {queueDict.imagehubModalitiesLabel}
            <input
              type="text"
              placeholder={queueDict.imagehubModalitiesPlaceholder}
              value={modalitiesText}
              onChange={(e) => setModalitiesText(e.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="settings-actions">
        <button onClick={handleSave} disabled={saving}>
          {saving ? dict.savingButton : dict.saveButton}
        </button>
        <Link className="back-link" href={`/${lang}/image-queue`}>{queueDict.backToQueue}</Link>
      </div>
    </>
  );
}
