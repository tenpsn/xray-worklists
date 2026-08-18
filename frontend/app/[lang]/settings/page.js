'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getDictionary } from '../../lib/i18n';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

const DEFAULT_FORM = {
  his: {
    hisSystem: '', // 'hosxp' | 'softcon' | 'hl7'
    dbType: '',
    host: '',
    port: '',
    database: '',
    username: '',
    password: '',
    encoding: 'UTF8', // 'UTF8' | 'TIS620' | 'WIN874'
  },
  mwl: {
    lang: '', // ภาษาเริ่มต้นสำหรับออเดอร์ที่รับผ่าน hl7
    aet: '', // AET ของ Worklist Server เช่น Orthanc
    port: '', // พอร์ตสำหรับรับ C-FIND จากเครื่อง Modality
    mppsPort: '7001', // พอร์ตแยกสำหรับรับ MPPS N-CREATE/N-SET จากเครื่อง Modality
    worklistDir: '', // โฟลเดอร์เก็บไฟล์ .wl — เว้นว่าง = ใช้ backend/worklists
    autoGenerate: {
      intervalSec: 10, // รอบเวลาดึงข้อมูลมาสร้างไฟล์ คุมทั้ง 3 แบบ HIS (HOSxP/SoftCon/HL7)
    },
  },
};

export default function SettingsPage() {
  const { lang: rawLang } = useParams();
  const lang = rawLang === 'th' ? 'th' : 'en';
  const dict = getDictionary(lang).settings;
  const nav = getDictionary(lang).nav;

  const [form, setForm] = useState(DEFAULT_FORM);
  const [status, setStatus] = useState(dict.statusLoading);
  const [statusType, setStatusType] = useState('info');
  const [saving, setSaving] = useState(false);
  const [worklistDirActive, setWorklistDirActive] = useState('');
  const [detecting, setDetecting] = useState(false);

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
          setStatus(dict.statusLoaded);
          setStatusType('info');
        } else {
          setStatus(dict.statusLoadFailed);
          setStatusType('error');
        }
      } catch (err) {
        setStatus(dict.connectErrorPrefix + err.message);
        setStatusType('error');
      }
    }
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateHis(field, value) {
    setForm((prev) => ({ ...prev, his: { ...prev.his, [field]: value } }));
  }

  function updateHisSystem(system) {
    setForm((prev) => ({
      ...prev,
      his: {
        ...prev.his,
        hisSystem: system,
        dbType: (system === 'hosxp' && prev.his.dbType === 'mssql') ? 'mysql' : prev.his.dbType,
      },
    }));
  }

  function updateMwl(field, value) {
    setForm((prev) => ({ ...prev, mwl: { ...prev.mwl, [field]: value } }));
  }

  function updateAutoGenerate(field, value) {
    setForm((prev) => ({
      ...prev,
      mwl: { ...prev.mwl, autoGenerate: { ...prev.mwl.autoGenerate, [field]: value } },
    }));
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
        setPickerError(json.message || dict.browseFailedError);
      }
    } catch (err) {
      setPickerError(dict.connectErrorPrefix + err.message);
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
        setPickerError(json.message || dict.createFolderFailedError);
      }
    } catch (err) {
      setPickerError(dict.connectErrorPrefix + err.message);
    }
  }

  async function handleDetectSystem() {
    setDetecting(true);
    setStatus(dict.detectingStatus);
    setStatusType('info');
    try {
      const res = await fetch(`${API_URL}/api/settings/detect-his-system`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ his: form.his }),
      });
      const json = await res.json();
      if (json.success && json.detected) {
        updateHisSystem(json.detected);
      }
      setStatus(json.message);
      setStatusType(json.success && json.detected ? 'success' : 'error');
    } catch (err) {
      setStatus(dict.connectErrorPrefix + err.message);
      setStatusType('error');
    } finally {
      setDetecting(false);
    }
  }

  async function handleSave() {

    if (!form.his.hisSystem || !form.his.dbType) {
      setStatus(dict.selectHisAndDbError);
      setStatusType('error');
      return;
    }

    setSaving(true);
    setStatus(dict.savingStatus);
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
      setStatus(dict.connectErrorPrefix + err.message);
      setStatusType('error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1>{dict.title}</h1>
      <div className={`status status-${statusType}`}>{status}</div>

      <div className="settings-card">
        <h2>{dict.hisSectionTitle}</h2>
        <div className="settings-grid">
          <label>
            {dict.hisSystemLabel}
            <select
              value={form.his.hisSystem}
              onChange={(e) => updateHisSystem(e.target.value)}
            >
              <option value="" disabled>{dict.selectHisPlaceholder}</option>
              <option value="hosxp">HOSxP</option>
              <option value="softcon">SoftCon</option>
              <option value="hl7">HL7</option>
            </select>
          </label>

          <label>
            {dict.databaseLabel}
            <select
              value={form.his.dbType}
              onChange={(e) => updateHis('dbType', e.target.value)}
            >
              <option value="" disabled>{dict.selectDbPlaceholder}</option>
              <option value="mysql">MySQL</option>
              <option value="postgres">PostgresSQL</option>
              {form.his.hisSystem === 'softcon' && <option value="mssql">MSSQL</option>}
            </select>
          </label>

          <label>
            {dict.ipLabel}
            <input
              type="text"
              placeholder={dict.ipPlaceholder}
              value={form.his.host}
              onChange={(e) => updateHis('host', e.target.value)}
            />
          </label>

          <label>
            {dict.portLabel}
            <input
              type="text"
              placeholder={dict.portPlaceholder}
              value={form.his.port}
              onChange={(e) => updateHis('port', e.target.value)}
            />
          </label>

          <label>
            {dict.dbNameLabel}
            <input
              type="text"
              placeholder="Database"
              value={form.his.database}
              onChange={(e) => updateHis('database', e.target.value)}
            />
          </label>

          <label>
            {dict.usernameLabel}
            <input
              type="text"
              placeholder="Username"
              value={form.his.username}
              onChange={(e) => updateHis('username', e.target.value)}
            />
          </label>

          <label>
            {dict.passwordLabel}
            <input
              type="password"
              placeholder="Password"
              value={form.his.password}
              onChange={(e) => updateHis('password', e.target.value)}
            />
          </label>

          <label>
            {dict.encodingLabel}
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
        <h2>{dict.mwlSectionTitle}</h2>
        <div className="settings-grid">
          <label>
            {dict.aetLabel}
            <input
              type="text"
              placeholder={dict.aetPlaceholder}
              value={form.mwl.aet}
              onChange={(e) => updateMwl('aet', e.target.value)}
            />
          </label>

          <label>
            {dict.mwlPortLabel}
            <input
              type="text"
              placeholder={dict.mwlPortPlaceholder}
              value={form.mwl.port}
              onChange={(e) => updateMwl('port', e.target.value)}
            />
          </label>

          <label>
            {dict.mppsPortLabel}
            <input
              type="text"
              placeholder={dict.mppsPortPlaceholder}
              value={form.mwl.mppsPort}
              onChange={(e) => updateMwl('mppsPort', e.target.value)}
            />
          </label>

          <label style={{ gridColumn: '1 / -1' }}>
            {dict.worklistDirLabel}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <input
                type="text"
                readOnly
                placeholder={dict.worklistDirPlaceholder}
                value={form.mwl.worklistDir}
                onClick={openPicker}
                style={{ flex: 1, minWidth: '200px', cursor: 'pointer', background: '#f9fafb' }}
              />
              <button type="button" onClick={openPicker}>{dict.chooseFolderButton}</button>
              {form.mwl.worklistDir && (
                <button type="button" onClick={() => updateMwl('worklistDir', '')}>
                  {dict.useDefaultButton}
                </button>
              )}
            </div>
            {worklistDirActive && (
              <div style={{ fontSize: '12px', color: '#666', marginTop: '6px' }}>
                {dict.activeFolderPrefix}<code>{worklistDirActive}</code>
              </div>
            )}
          </label>

          <label>
            {dict.intervalLabel}
            <input
              type="number"
              min="1"
              placeholder={dict.intervalPlaceholder}
              value={form.mwl.autoGenerate.intervalSec}
              onChange={(e) => updateAutoGenerate('intervalSec', Number(e.target.value) || 1)}
            />
          </label>
        </div>
      </div>

      <div className="settings-actions">
        <button onClick={handleSave} disabled={saving}>
          {saving ? dict.savingButton : dict.saveButton}
        </button>
        <a className="back-link" href={`/${lang}/worklists`}>{nav.backToReport}</a>
      </div>

      {pickerOpen && (
        <div className="modal-overlay" onClick={() => setPickerOpen(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{dict.modal.title}</h3>
              <button type="button" className="modal-close" onClick={() => setPickerOpen(false)}>✕</button>
            </div>

            <div className="modal-path">
              {pickerIsRoot ? dict.modal.selectDriveLabel : (pickerPath || '/')}
            </div>

            <div className="modal-body">
              {pickerLoading && <div className="modal-empty">{dict.modal.loadingLabel}</div>}

              {!pickerLoading && pickerError && (
                <div className="modal-empty" style={{ color: '#b91c1c' }}>{pickerError}</div>
              )}

              {!pickerLoading && !pickerError && (
                <>
                  {pickerParent !== null && pickerParent !== undefined && (
                    <div className="folder-item" onClick={() => browseTo(pickerParent)}>
                      <span className="folder-icon">📁</span> {dict.modal.upLabel}
                    </div>
                  )}
                  {pickerFolders.length === 0 && (
                    <div className="modal-empty">{dict.modal.noSubfolders}</div>
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
                  placeholder={dict.modal.newFolderPlaceholder}
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                />
                <button type="button" onClick={handleCreateFolder}>{dict.modal.createFolderButton}</button>
              </div>
            )}

            <div className="modal-footer">
              <button type="button" onClick={() => setPickerOpen(false)}>{dict.modal.cancelButton}</button>
              <button
                type="button"
                onClick={selectCurrentFolder}
                disabled={pickerIsRoot}
                style={pickerIsRoot ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
              >
                {dict.modal.useThisFolderButton}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
