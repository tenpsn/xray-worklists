'use client';

import { Fragment, useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { getDictionary } from '../../lib/i18n';

export default function OrthancMoverPage() {
  const { lang: rawLang } = useParams();
  const lang = rawLang === 'th' ? 'th' : 'en';
  const dict = getDictionary(lang).mover;
  const nav = getDictionary(lang).nav;

  const [orthancUrl, setOrthancUrl] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [destAet, setDestAet] = useState('');
  const [destHost, setDestHost] = useState('');
  const [destPort, setDestPort] = useState('');
  const [destRestUrl, setDestRestUrl] = useState('');
  const [destRestUsername, setDestRestUsername] = useState('');
  const [destRestPassword, setDestRestPassword] = useState('');
  const [concurrency, setConcurrency] = useState('');

  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [startStatus, setStartStatus] = useState({ text: '', type: 'info' });
  const [jobState, setJobState] = useState(null);
  const [expandedDate, setExpandedDate] = useState(null);

  const pollRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/orthanc-mover/status');
      const data = await res.json();
      if (data.success) setJobState(data.state);
    } catch (err) {
      // เงียบไว้ - จะลองใหม่รอบถัดไปที่ poll
    }
  }, []);

  // โหลดสถานะล่าสุดทันทีที่เปิดหน้า ไม่ว่าใครจะเป็นคนกดเริ่มงานไว้ก็ตาม
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (jobState && jobState.status === 'running') {
      pollRef.current = setInterval(fetchStatus, 2000);
      return () => clearInterval(pollRef.current);
    }
  }, [jobState?.status, fetchStatus]);

  async function handleStart() {
    if (!orthancUrl || !fromDate || !toDate || !destAet || !destHost || !destPort) {
      setStartStatus({ text: dict.missingFieldsError, type: 'error' });
      return;
    }
    setStarting(true);
    setStartStatus({ text: '', type: 'info' });
    setExpandedDate(null);
    try {
      const res = await fetch('/api/orthanc-mover/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orthancUrl,
          username,
          password,
          from: fromDate,
          to: toDate,
          destAet,
          destHost,
          destPort,
          destRestUrl,
          destRestUsername,
          destRestPassword,
          concurrency,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setStartStatus({ text: data.message || dict.startFailedError, type: 'error' });
        return;
      }
      setJobState(data.state);
    } catch (err) {
      setStartStatus({ text: dict.connectErrorPrefix + err.message, type: 'error' });
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    setStopping(true);
    try {
      await fetch('/api/orthanc-mover/stop', { method: 'POST' });
      await fetchStatus();
    } finally {
      setStopping(false);
    }
  }

  async function handlePause() {
    setPausing(true);
    try {
      await fetch('/api/orthanc-mover/pause', { method: 'POST' });
      await fetchStatus();
    } finally {
      setPausing(false);
    }
  }

  async function handleResume() {
    setResuming(true);
    try {
      await fetch('/api/orthanc-mover/resume', { method: 'POST' });
      await fetchStatus();
    } finally {
      setResuming(false);
    }
  }

  const isRunning = jobState && jobState.status === 'running';
  const isPaused = isRunning && jobState.paused;

  function currentDateProgress() {
    if (!jobState || !jobState.currentDate || !Array.isArray(jobState.plan)) return null;
    const entry = jobState.plan.find((d) => d.date === jobState.currentDate);
    if (!entry) return null;
    const done = entry.studies.filter((s) => s.status !== 'pending').length;
    return { date: jobState.currentDate, done, total: entry.studies.length };
  }

  const dateProgress = currentDateProgress();

  function dailyBreakdown() {
    if (!jobState || !Array.isArray(jobState.plan)) return [];
    return jobState.plan.map((d) => ({
      date: d.date,
      total: d.studies.length,
      success: d.studies.filter((s) => s.status === 'success').length,
      failed: d.studies.filter((s) => s.status === 'error').length,
    }));
  }

  function overallCounts() {
    return dailyBreakdown().reduce(
      (acc, d) => ({ success: acc.success + d.success, failed: acc.failed + d.failed }),
      { success: 0, failed: 0 }
    );
  }

  function renderStatusLine() {
    if (!jobState || jobState.status === 'idle') {
      return <p className="status-info">{dict.statusIdleText}</p>;
    }
    if (jobState.status === 'running') {
      return (
        <p className="status-info">
          {jobState.paused ? `${dict.statusPausedPrefix} ` : ''}
          {dateProgress
            ? dict.statusRunningText(dateProgress.date, dateProgress.done, dateProgress.total)
            : dict.statusRunningText('-', 0, 0)}
        </p>
      );
    }
    if (jobState.status === 'done') {
      const { success, failed } = overallCounts();
      return (
        <p className="status-success">
          {dict.statusDoneText(jobState.totals.doneStudies, jobState.totals.totalStudies, success, failed)}
        </p>
      );
    }
    if (jobState.status === 'stopped') {
      const { success, failed } = overallCounts();
      return (
        <p className="status-error">
          {dict.statusStoppedText(jobState.totals.doneStudies, jobState.totals.totalStudies, success, failed)}
        </p>
      );
    }
    if (jobState.status === 'error') {
      return <p className="status-error">{dict.statusErrorText(jobState.error)}</p>;
    }
    return null;
  }

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

        <h3>{dict.destinationTitle}</h3>
        <div className="settings-grid">
          <label>
            {dict.destAetLabel}
            <input type="text" value={destAet} onChange={(e) => setDestAet(e.target.value)} />
          </label>
          <label>
            {dict.destHostLabel}
            <input type="text" value={destHost} onChange={(e) => setDestHost(e.target.value)} />
          </label>
          <label>
            {dict.destPortLabel}
            <input type="number" value={destPort} onChange={(e) => setDestPort(e.target.value)} />
          </label>
          <label>
            {dict.destRestUrlLabel}
            <input
              type="text"
              placeholder={`http://${destHost || 'host'}:8042`}
              value={destRestUrl}
              onChange={(e) => setDestRestUrl(e.target.value)}
            />
          </label>
          <label>
            {dict.destRestUsernameLabel}
            <input type="text" autoComplete="off" value={destRestUsername} onChange={(e) => setDestRestUsername(e.target.value)} />
          </label>
          <label>
            {dict.destRestPasswordLabel}
            <input type="password" autoComplete="off" value={destRestPassword} onChange={(e) => setDestRestPassword(e.target.value)} />
          </label>
          <label>
            {dict.concurrencyLabel}
            <input type="number" min="1" placeholder="6" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
          </label>
        </div>

        <div className="settings-actions">
          <button onClick={handleStart} disabled={starting || isRunning}>
            {starting ? dict.startingButton : dict.startButton}
          </button>
          {isRunning && !isPaused && (
            <button onClick={handlePause} disabled={pausing}>
              {pausing ? dict.pausingButton : dict.pauseButton}
            </button>
          )}
          {isPaused && (
            <button onClick={handleResume} disabled={resuming}>
              {resuming ? dict.resumingButton : dict.resumeButton}
            </button>
          )}
          {isRunning && (
            <button className="btn-danger" onClick={handleStop} disabled={stopping}>
              {stopping ? dict.stoppingButton : dict.stopButton}
            </button>
          )}
        </div>
        {startStatus.text && <p className={`status-${startStatus.type}`}>{startStatus.text}</p>}
      </div>

      {jobState && jobState.status !== 'idle' && (
        <div className="settings-card">
          {renderStatusLine()}
          {jobState.totals && (
            <p className="subtitle">
              {dict.overallProgressText(
                jobState.totals.doneDates,
                jobState.totals.totalDates,
                jobState.totals.doneStudies,
                jobState.totals.totalStudies
              )}
            </p>
          )}
          {Array.isArray(jobState.searchFailures) && jobState.searchFailures.length > 0 && (
            <p className="status-error">
              {dict.searchFailuresText(jobState.searchFailures.length)}{' '}
              {jobState.searchFailures.map((f) => f.date).join(', ')}
            </p>
          )}

          {dailyBreakdown().length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{dict.dailyBreakdownTable.date}</th>
                    <th>{dict.dailyBreakdownTable.total}</th>
                    <th>{dict.dailyBreakdownTable.success}</th>
                    <th>{dict.dailyBreakdownTable.failed}</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyBreakdown().map((d) => {
                    const isExpanded = expandedDate === d.date;
                    const planEntry = jobState.plan.find((p) => p.date === d.date);
                    return (
                      <Fragment key={d.date}>
                        <tr
                          onClick={() => setExpandedDate(isExpanded ? null : d.date)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td>{isExpanded ? '▾ ' : '▸ '}{d.date}</td>
                          <td>{d.total}</td>
                          <td>{d.success}</td>
                          <td>{d.failed}</td>
                        </tr>
                        {isExpanded && planEntry && (
                          <tr key={`${d.date}-detail`}>
                            <td colSpan={4}>
                              <table>
                                <thead>
                                  <tr>
                                    <th>{dict.expandTable.status}</th>
                                    <th>XN</th>
                                    <th>HN</th>
                                    <th>{dict.expandTable.reason}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {planEntry.studies.map((s) => (
                                    <tr
                                      key={s.id}
                                      style={s.status === 'error' ? { background: '#fee2e2', color: '#b91c1c' } : undefined}
                                    >
                                      <td>{dict.statusLabels[s.status] || s.status}</td>
                                      <td>{s.accessionNumber || '-'}</td>
                                      <td>{s.patientId || '-'}</td>
                                      <td>{s.message || '-'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {Array.isArray(jobState.errors) && jobState.errors.length > 0 && (
            <>
              <h3>{dict.failedCasesTitle}</h3>
              <ul className="failed-cases-list">
                {jobState.errors.map((e, idx) => (
                  <li key={`${e.studyId}-${idx}`} className="status-error">
                    {dict.failedCasesLine(e.date, e.patientId || '-', e.accessionNumber || '-', e.message)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </>
  );
}
