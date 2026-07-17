'use client';

import { useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

const DEFAULT_FORM = {
  his: {
    dbType: 'postgres',
    host: '',
    port: '5432',
    database: '',
    username: '',
    password: '',
    encoding: 'UTF8',
  },
  mwl: {
    aet: '',
    port: '7000',
  },
};

export default function SettingsPage() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [status, setStatus] = useState('กำลังโหลดการตั้งค่า...');
  const [statusType, setStatusType] = useState('info'); // 'info' | 'success' | 'error'
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function loadSettings() {
      try {
        const res = await fetch(`${API_URL}/api/settings`);
        const json = await res.json();
        if (json.success) {
          setForm({
            his: { ...DEFAULT_FORM.his, ...json.settings.his },
            mwl: { ...DEFAULT_FORM.mwl, ...json.settings.mwl },
          });
          setStatus('โหลดการตั้งค่าปัจจุบันเรียบร้อย');
          setStatusType('info');
        } else {
          setStatus('โหลดการตั้งค่าไม่สำเร็จ');
          setStatusType('error');
        }
      } catch (err) {
        setStatus('เชื่อมต่อ server ไม่ได้: ' + err.message);
        setStatusType('error');
      }
    }
    loadSettings();
  }, []);

  function updateHis(field, value) {
    setForm((prev) => ({ ...prev, his: { ...prev.his, [field]: value } }));
  }

  function updateMwl(field, value) {
    setForm((prev) => ({ ...prev, mwl: { ...prev.mwl, [field]: value } }));
  }

  async function handleSave() {
    setSaving(true);
    setStatus('กำลังบันทึกและทดสอบการเชื่อมต่อ...');
    setStatusType('info');
    try {
      const res = await fetch(`${API_URL}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      setStatus(json.message);
      setStatusType(json.success ? 'success' : 'error');
    } catch (err) {
      setStatus('เชื่อมต่อ server ไม่ได้: ' + err.message);
      setStatusType('error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1>ตั้งค่าระบบ (HIS &amp; MWL)</h1>
      <div className={`status status-${statusType}`}>{status}</div>

      <div className="settings-card">
        <h2>HIS (HOSXP) — Database</h2>
        <div className="settings-grid">
          <label>
            Database Type
            <select
              value={form.his.dbType}
              onChange={(e) => updateHis('dbType', e.target.value)}
            >
              <option value="mysql">MySQL</option>
              <option value="postgres">Postgres</option>
            </select>
          </label>

          <label>
            IP Address
            <input
              type="text"
              placeholder="เช่น 192.168.x.x"
              value={form.his.host}
              onChange={(e) => updateHis('host', e.target.value)}
            />
          </label>

          <label>
            Port
            <input
              type="text"
              placeholder="เช่น 5432 หรือ 3306"
              value={form.his.port}
              onChange={(e) => updateHis('port', e.target.value)}
            />
          </label>

          <label>
            Database name
            <input
              type="text"
              placeholder="ชื่อฐานข้อมูล"
              value={form.his.database}
              onChange={(e) => updateHis('database', e.target.value)}
            />
          </label>

          <label>
            Username
            <input
              type="text"
              value={form.his.username}
              onChange={(e) => updateHis('username', e.target.value)}
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={form.his.password}
              onChange={(e) => updateHis('password', e.target.value)}
            />
          </label>

          <label>
            Encoding
            <select
              value={form.his.encoding}
              onChange={(e) => updateHis('encoding', e.target.value)}
            >
              <option value="UTF8">UTF8</option>
              <option value="TIS620">TIS620</option>
              <option value="WIN874">Windows-874</option>
            </select>
          </label>
        </div>
      </div>

      <div className="settings-card">
        <h2>MWL — DICOM Modality Worklist</h2>
        <div className="settings-grid">
          <label>
            AET
            <input
              type="text"
              placeholder="เช่น UNEQWL"
              value={form.mwl.aet}
              onChange={(e) => updateMwl('aet', e.target.value)}
            />
          </label>

          <label>
            Port
            <input
              type="text"
              placeholder="เช่น 7000"
              value={form.mwl.port}
              onChange={(e) => updateMwl('port', e.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="settings-actions">
        <button onClick={handleSave} disabled={saving}>
          {saving ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า'}
        </button>
        <a className="back-link" href="/">← กลับหน้ารายงาน</a>
      </div>
    </>
  );
}