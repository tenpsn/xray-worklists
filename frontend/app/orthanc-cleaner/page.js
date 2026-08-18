'use client';

import { useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

export default function OrthancCleanerPage() {
  const [orthancUrl, setOrthancUrl] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [studies, setStudies] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [searching, setSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState({ text: '', type: 'info' });
  const [deleteStatus, setDeleteStatus] = useState({ text: '', type: 'info' });

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [backup, setBackup] = useState(true);
  const [deleting, setDeleting] = useState(false);

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll(checked) {
    setSelectedIds(checked ? new Set(studies.map((s) => s.id)) : new Set());
  }

  async function handleSearch() {
    if (!orthancUrl || !fromDate || !toDate) {
      setSearchStatus({ text: 'กรุณากรอก Orthanc URL, วันที่เริ่มต้น และวันที่สิ้นสุดให้ครบ', type: 'error' });
      return;
    }

    setSearching(true);
    setSearchStatus({ text: 'กำลังค้นหา...', type: 'info' });

    try {
      const res = await fetch(`${API_URL}/api/orthanc/find`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orthancUrl, username, password, from: fromDate, to: toDate }),
      });
      const data = await res.json();
      if (!data.success) {
        setSearchStatus({ text: data.message || 'ค้นหาไม่สำเร็จ', type: 'error' });
        setStudies([]);
        setSelectedIds(new Set());
        return;
      }
      setStudies(data.studies);
      setSelectedIds(new Set());
      setSearchStatus({ text: `พบ ${data.studies.length} เคส`, type: 'success' });
    } catch (err) {
      setSearchStatus({ text: 'เชื่อมต่อ Orthanc ไม่ได้: ' + err.message, type: 'error' });
    } finally {
      setSearching(false);
    }
  }

  function openConfirm() {
    if (selectedIds.size === 0) return;
    setConfirmText('');
    setBackup(true);
    setConfirmOpen(true);
  }

  async function handleConfirmDelete() {
    const items = studies.filter((s) => selectedIds.has(s.id));
    setConfirmOpen(false);
    setDeleting(true);
    setDeleteStatus({
      text: backup ? `กำลังสำรองข้อมูลและลบ ${items.length} เคส...` : `กำลังลบ ${items.length} เคส...`,
      type: 'info',
    });

    try {
      const res = await fetch(`${API_URL}/api/orthanc/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orthancUrl, username, password, items, backup }),
      });
      const data = await res.json();
      const results = data.results || [];
      const succeeded = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      const deletedIds = new Set(succeeded.map((s) => s.id));
      setStudies((prev) => prev.filter((s) => !deletedIds.has(s.id)));
      setSelectedIds(new Set());
      setSearchStatus({ text: '', type: 'info' });

      const backupNote = backup ? ` (สำรองไฟล์ไว้ ${succeeded.length} ไฟล์)` : '';
      if (failed.length === 0) {
        setDeleteStatus({ text: `ลบสำเร็จทั้งหมด ${items.length} เคส${backupNote}`, type: 'success' });
      } else {
        setDeleteStatus({
          text: `ลบสำเร็จ ${succeeded.length} เคส${backupNote}, ล้มเหลว ${failed.length} เคส: ${failed.map((f) => f.message).join(', ')}`,
          type: 'error',
        });
      }
    } catch (err) {
      setDeleteStatus({ text: 'เชื่อมต่อไม่ได้ระหว่างลบ: ' + err.message, type: 'error' });
    } finally {
      setDeleting(false);
    }
  }

  const allSelected = studies.length > 0 && selectedIds.size === studies.length;

  return (
    <>
      <div className="page-header">
        <h1>Orthanc Case Cleaner</h1>
        <div className="header-actions">
          <a className="settings-link" href="/">เลือกระบบ</a>
        </div>
      </div>
      <p className="subtitle">ค้นหาและลบเคส (Study) ใน Orthanc ตามช่วงวันที่ตรวจ (Study Date)</p>

      <div className="settings-card">
        <div className="settings-grid">
          <label>
            Orthanc URL
            <input
              type="text"
              placeholder="http://localhost:8042"
              value={orthancUrl}
              onChange={(e) => setOrthancUrl(e.target.value)}
            />
          </label>
          <label>
            วันที่เริ่มต้น
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </label>
          <label>
            วันที่สิ้นสุด
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </label>
          <label>
            Username (ถ้ามี)
            <input type="text" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>
            Password (ถ้ามี)
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        </div>
        <div className="settings-actions">
          <button onClick={handleSearch} disabled={searching}>
            {searching ? 'กำลังค้นหา...' : 'ค้นหารายการ'}
          </button>
        </div>
        {searchStatus.text && <p className={`status-${searchStatus.type}`}>{searchStatus.text}</p>}
      </div>

      {studies.length > 0 && (
        <div className="settings-card">
          <div className="toolbar">
            <div>พบ <span className="badge">{studies.length}</span> เคส</div>
            <label className="checkbox-inline">
              <input type="checkbox" checked={allSelected} onChange={(e) => toggleSelectAll(e.target.checked)} />
              เลือกทั้งหมด
            </label>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>ชื่อผู้ป่วย</th>
                  <th>HN / Patient ID</th>
                  <th>Accession No.</th>
                  <th>วันที่ตรวจ</th>
                  <th>รายการตรวจ</th>
                </tr>
              </thead>
              <tbody>
                {studies.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(s.id)}
                        onChange={() => toggleSelected(s.id)}
                      />
                    </td>
                    <td>{s.patientName || '-'}</td>
                    <td>{s.patientId || '-'}</td>
                    <td>{s.accessionNumber || '-'}</td>
                    <td>{s.studyDate || '-'}</td>
                    <td>{s.studyDescription || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="settings-actions">
            <button className="btn-danger" onClick={openConfirm} disabled={selectedIds.size === 0 || deleting}>
              ลบรายการที่เลือก ({selectedIds.size})
            </button>
          </div>
          {deleteStatus.text && <p className={`status-${deleteStatus.type}`}>{deleteStatus.text}</p>}
        </div>
      )}

      {confirmOpen && (
        <div className="modal-overlay" onClick={() => setConfirmOpen(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>ยืนยันการลบ</h3>
              <button className="modal-close" onClick={() => setConfirmOpen(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ padding: '16px' }}>
              <p>
                กำลังจะลบ <strong>{selectedIds.size}</strong> เคสออกจาก Orthanc ถาวร <strong>กู้คืนไม่ได้</strong>
              </p>
              <label className="checkbox-inline" style={{ margin: '14px 0' }}>
                <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} />
                สำรองข้อมูลเป็น ZIP ไว้ที่เครื่อง backend ก่อนลบ
              </label>
              <p>พิมพ์ <code>delete</code> เพื่อยืนยัน:</p>
              <input
                type="text"
                placeholder="พิมพ์ว่า delete"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
              />
            </div>
            <div className="modal-footer">
              <button onClick={() => setConfirmOpen(false)}>ยกเลิก</button>
              <button
                className="btn-danger"
                disabled={confirmText.trim().toLowerCase() !== 'delete'}
                onClick={handleConfirmDelete}
              >
                ยืนยันลบ
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
