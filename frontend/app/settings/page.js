'use client';

import { useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

const DEFAULT_FORM = {
  his: {
    dbType: '',
    host: '',
    port: '',
    database: '',
    username: '',
    password: '',
    encoding: 'UTF8', // 'UTF8' | 'TIS620' | 'WIN874'
  },
  mwl: {
    aet: 'ORTHANC', // AET ของ Worklist Server (เช่น Orthanc, DCM4CHEE, หรือ Modality)
    port: '7000', // พอร์ตสำหรับรับ C-FIND จากเครื่อง Modality
    mppsPort: '7001', // พอร์ตแยกสำหรับรับ MPPS (N-CREATE/N-SET) จากเครื่อง Modality
    worklistDir: '', // โฟลเดอร์เก็บไฟล์ .wl — เว้นว่าง = ใช้ backend/worklists (ค่าเริ่มต้น)
  },
};

export default function SettingsPage() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [status, setStatus] = useState('กำลังโหลดการตั้งค่า...');
  const [statusType, setStatusType] = useState('info'); // 'info' | 'success' | 'error'
  const [saving, setSaving] = useState(false);
  const [worklistDirActive, setWorklistDirActive] = useState(''); // path จริงที่ backend ใช้งานอยู่ตอนนี้

  // state สำหรับหน้าต่างเลือกโฟลเดอร์ worklists
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState('');
  const [pickerPath, setPickerPath] = useState('');
  const [pickerParent, setPickerParent] = useState(null);
  const [pickerIsRoot, setPickerIsRoot] = useState(false);
  const [pickerFolders, setPickerFolders] = useState([]);
  const [newFolderName, setNewFolderName] = useState('');

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
          setWorklistDirActive(json.worklistDirActive || '');
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

  // เปิดหน้าต่างเลือกโฟลเดอร์ โดยเริ่มดูจาก path ที่กรอกไว้อยู่แล้ว (ถ้ามี)
  async function openPicker() {
    setPickerOpen(true);
    setPickerError('');
    setNewFolderName('');
    await browseTo(form.mwl.worklistDir || '');
  }

  // เดินเข้าไปดูโฟลเดอร์ p (หรือรายชื่อไดรฟ์ ถ้า p ว่างเปล่า)
  async function browseTo(p) {
    setPickerLoading(true);
    setPickerError('');
    try {
      const res = await fetch(`${API_URL}/api/fs/browse?path=${encodeURIComponent(p)}`);
      const json = await res.json();
      if (json.success) {
        setPickerPath(json.path);
        setPickerParent(json.parent);
        setPickerIsRoot(json.isRoot);
        setPickerFolders(json.folders);
      } else {
        setPickerError(json.message || 'เปิดโฟลเดอร์นี้ไม่สำเร็จ');
      }
    } catch (err) {
      setPickerError('เชื่อมต่อ server ไม่ได้: ' + err.message);
    } finally {
      setPickerLoading(false);
    }
  }

  // ยืนยันเลือกโฟลเดอร์ที่กำลังดูอยู่ ใส่ค่ากลับเข้าฟอร์ม แล้วปิดหน้าต่าง
  function selectCurrentFolder() {
    updateMwl('worklistDir', pickerPath);
    setPickerOpen(false);
  }

  // สร้างโฟลเดอร์ย่อยใหม่ในตำแหน่งที่กำลังดูอยู่ แล้วรีเฟรชรายการ
  async function handleCreateFolder() {
    if (!newFolderName.trim()) return;
    try {
      const res = await fetch(`${API_URL}/api/fs/mkdir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPath: pickerPath, name: newFolderName.trim() }),
      });
      const json = await res.json();
      if (json.success) {
        setNewFolderName('');
        await browseTo(pickerPath);
      } else {
        setPickerError(json.message || 'สร้างโฟลเดอร์ไม่สำเร็จ');
      }
    } catch (err) {
      setPickerError('เชื่อมต่อ server ไม่ได้: ' + err.message);
    }
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
      setWorklistDirActive(json.worklistDirActive || '');
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
              <option value="mssql">MS SQL Server</option>
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

          <label>
            MPPS Port
            <input
              type="text"
              placeholder="เช่น 7001"
              value={form.mwl.mppsPort}
              onChange={(e) => updateMwl('mppsPort', e.target.value)}
            />
          </label>

          <label style={{ gridColumn: '1 / -1' }}>
            โฟลเดอร์เก็บไฟล์ Worklist (.wl)
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <input
                type="text"
                readOnly
                placeholder="ค่าเริ่มต้น (backend/worklists) — กดปุ่มด้านขวาเพื่อเลือก"
                value={form.mwl.worklistDir}
                onClick={openPicker}
                style={{ flex: 1, minWidth: '200px', cursor: 'pointer', background: '#f9fafb' }}
              />
              <button type="button" onClick={openPicker}>เลือกโฟลเดอร์...</button>
              {form.mwl.worklistDir && (
                <button type="button" onClick={() => updateMwl('worklistDir', '')}>
                  ใช้ค่าเริ่มต้น
                </button>
              )}
            </div>
          </label>
        </div>

        <p style={{ fontSize: '12px', color: '#666', marginTop: '8px' }}>
          {worklistDirActive && (<>โฟลเดอร์ที่ใช้งานอยู่จริงตอนนี้: <code>{worklistDirActive}</code></>)}
        </p>
      </div>

      <div className="settings-actions">
        <button onClick={handleSave} disabled={saving}>
          {saving ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า'}
        </button>
        <a className="back-link" href="/">← กลับหน้ารายงาน</a>
      </div>

      {pickerOpen && (
        <div className="modal-overlay" onClick={() => setPickerOpen(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>เลือกโฟลเดอร์เก็บไฟล์ Worklist</h3>
              <button type="button" className="modal-close" onClick={() => setPickerOpen(false)}>✕</button>
            </div>

            <div className="modal-path">
              {pickerIsRoot ? 'เลือกไดรฟ์' : (pickerPath || '/')}
            </div>

            <div className="modal-body">
              {pickerLoading && <div className="modal-empty">กำลังโหลด...</div>}

              {!pickerLoading && pickerError && (
                <div className="modal-empty" style={{ color: '#b91c1c' }}>{pickerError}</div>
              )}

              {!pickerLoading && !pickerError && (
                <>
                  {pickerParent !== null && pickerParent !== undefined && (
                    <div className="folder-item" onClick={() => browseTo(pickerParent)}>
                      <span className="folder-icon">📁</span> .. (ย้อนกลับ)
                    </div>
                  )}
                  {pickerFolders.length === 0 && (
                    <div className="modal-empty">ไม่มีโฟลเดอร์ย่อยในนี้</div>
                  )}
                  {pickerFolders.map((f) => (
                    <div key={f.path} className="folder-item" onClick={() => browseTo(f.path)}>
                      <span className="folder-icon">📁</span> {f.name}
                    </div>
                  ))}
                </>
              )}
            </div>

            {!pickerIsRoot && !pickerLoading && !pickerError && (
              <div className="new-folder-row">
                <input
                  type="text"
                  placeholder="ชื่อโฟลเดอร์ใหม่"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                />
                <button type="button" onClick={handleCreateFolder}>+ สร้างโฟลเดอร์</button>
              </div>
            )}

            <div className="modal-footer">
              <button type="button" onClick={() => setPickerOpen(false)}>ยกเลิก</button>
              <button
                type="button"
                onClick={selectCurrentFolder}
                disabled={pickerIsRoot}
                style={pickerIsRoot ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
              >
                ใช้โฟลเดอร์นี้
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}