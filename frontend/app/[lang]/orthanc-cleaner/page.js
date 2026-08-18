'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { getDictionary } from '../../lib/i18n';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

export default function OrthancCleanerPage() {
  const { lang: rawLang } = useParams();
  const lang = rawLang === 'th' ? 'th' : 'en';
  const dict = getDictionary(lang).cleaner;
  const nav = getDictionary(lang).nav;

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
      setSearchStatus({ text: dict.missingFieldsError, type: 'error' });
      return;
    }

    setSearching(true);
    setSearchStatus({ text: dict.searchingStatus, type: 'info' });

    try {
      const res = await fetch(`${API_URL}/api/orthanc/find`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orthancUrl, username, password, from: fromDate, to: toDate }),
      });
      const data = await res.json();
      if (!data.success) {
        setSearchStatus({ text: data.message || dict.searchFailedError, type: 'error' });
        setStudies([]);
        setSelectedIds(new Set());
        return;
      }
      setStudies(data.studies);
      setSelectedIds(new Set());
      setSearchStatus({ text: dict.foundCasesText(data.studies.length), type: 'success' });
    } catch (err) {
      setSearchStatus({ text: dict.connectErrorPrefix + err.message, type: 'error' });
    } finally {
      setSearching(false);
    }
  }

  function openConfirm() {
    if (selectedIds.size === 0) return;
    setConfirmText('');
    setConfirmOpen(true);
  }

  async function pollDeleteJob(jobId, total) {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const res = await fetch(`${API_URL}/api/orthanc/delete/status/${jobId}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.message || dict.deleteConnectionError);

      setDeleteStatus({ text: dict.deletingProgressText(data.processed, total), type: 'info' });

      if (data.done) {
        if (data.error) throw new Error(data.error);
        return data.results;
      }
    }
  }

  async function handleConfirmDelete() {
    const items = studies.filter((s) => selectedIds.has(s.id));
    setConfirmOpen(false);
    setDeleting(true);
    setDeleteStatus({ text: dict.deletingText(items.length), type: 'info' });

    try {
      const startRes = await fetch(`${API_URL}/api/orthanc/delete/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orthancUrl, username, password, items: items.map((s) => ({ id: s.id })) }),
      });
      const startData = await startRes.json();
      if (!startData.success) throw new Error(startData.message || dict.deleteConnectionError);

      const results = await pollDeleteJob(startData.jobId, startData.total);
      const succeeded = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      const deletedIds = new Set(succeeded.map((s) => s.id));
      setStudies((prev) => prev.filter((s) => !deletedIds.has(s.id)));
      setSelectedIds(new Set());
      setSearchStatus({ text: '', type: 'info' });

      if (failed.length === 0) {
        setDeleteStatus({ text: dict.deleteAllSuccessText(items.length), type: 'success' });
      } else {
        setDeleteStatus({
          text: dict.partialSuccessText(succeeded.length, failed.length, failed.map((f) => f.message).join(', ')),
          type: 'error',
        });
      }
    } catch (err) {
      setDeleteStatus({ text: dict.deleteConnectionError + err.message, type: 'error' });
    } finally {
      setDeleting(false);
    }
  }

  const allSelected = studies.length > 0 && selectedIds.size === studies.length;

  return (
    <>
      <div className="page-header">
        <h1>{dict.title}</h1>
        <div className="header-actions">
          <Link className="settings-link" href={`/${lang}`}>{nav.selectSystem}</Link>
        </div>
      </div>
      <p className="subtitle">{dict.subtitle}</p>

      <div className="settings-card">
        <div className="settings-grid">
          <label>
            {dict.orthancUrlLabel}
            <input
              type="text"
              placeholder="http://host.docker.internal:8042"
              value={orthancUrl}
              onChange={(e) => setOrthancUrl(e.target.value)}
            />
          </label>
          <label>
            {dict.startDateLabel}
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </label>
          <label>
            {dict.endDateLabel}
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </label>
          <label>
            {dict.usernameLabel}
            <input type="text" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>
            {dict.passwordLabel}
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        </div>
        <div className="settings-actions">
          <button onClick={handleSearch} disabled={searching}>
            {searching ? dict.searchingButton : dict.searchButton}
          </button>
        </div>
        {searchStatus.text && <p className={`status-${searchStatus.type}`}>{searchStatus.text}</p>}
      </div>

      {studies.length > 0 && (
        <div className="settings-card">
          <div className="toolbar">
            <div>{dict.foundCasesText(studies.length)}</div>
            <label className="checkbox-inline">
              <input type="checkbox" checked={allSelected} onChange={(e) => toggleSelectAll(e.target.checked)} />
              {dict.selectAllLabel}
            </label>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>{dict.table.patientName}</th>
                  <th>{dict.table.patientId}</th>
                  <th>{dict.table.accessionNumber}</th>
                  <th>{dict.table.studyDate}</th>
                  <th>{dict.table.studyDescription}</th>
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
              {dict.deleteSelectedButton(selectedIds.size)}
            </button>
          </div>
          {deleteStatus.text && <p className={`status-${deleteStatus.type}`}>{deleteStatus.text}</p>}
        </div>
      )}

      {confirmOpen && (
        <div className="modal-overlay" onClick={() => setConfirmOpen(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{dict.confirmTitle}</h3>
              <button className="modal-close" onClick={() => setConfirmOpen(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ padding: '16px' }}>
              <p>{dict.confirmBodyText(selectedIds.size)}</p>
              <p>{dict.typeDeleteLabel}</p>
              <input
                type="text"
                placeholder={dict.typeDeletePlaceholder}
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
              />
            </div>
            <div className="modal-footer">
              <button onClick={() => setConfirmOpen(false)}>{dict.cancelButton}</button>
              <button
                className="btn-danger"
                disabled={confirmText.trim().toLowerCase() !== 'delete'}
                onClick={handleConfirmDelete}
              >
                {dict.confirmDeleteButton}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
