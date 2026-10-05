'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { getDictionary } from '../../lib/i18n';
import {
  useImagehubSession,
  exchangeImagehubCode,
  ImagehubSessionBar,
  ImagehubLoginButton,
} from '../../lib/imagehubSession';
import DicomUpload from './DicomUpload';

const REFRESH_MS = 10000;

const STATUS_STYLE = {
  pending: { background: '#f3f4f6', color: '#374151' },
  sending: { background: '#dbeafe', color: '#1d4ed8' },
  failed: { background: '#fee2e2', color: '#b91c1c' },
  success: { background: '#dcfce7', color: '#15803d' },
  skipped: { background: '#fef9c3', color: '#854d0e' },
  gaveup: { background: '#7f1d1d', color: 'white' },
  off: { background: 'white', color: '#9ca3af', border: '1px solid #e5e7eb' },
};

function formatTime(ms, lang) {
  if (!ms) return '-';
  return new Date(ms).toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB', { dateStyle: 'short', timeStyle: 'medium' });
}

// สถานะปกติแสดงเป็นตัวหนังสือธรรมดา ใช้สีแดงเฉพาะตอนมีปัญหา
const PLAIN_STATUS = { margin: '0 0 6px', fontSize: '14px', color: '#374151' };

function secondsUntil(ms) {
  return Math.max(0, Math.round((ms - Date.now()) / 1000));
}

export default function ImageQueuePage() {
  const { lang: rawLang } = useParams();
  const lang = rawLang === 'th' ? 'th' : 'en';
  const dict = getDictionary(lang).imageQueue;
  const nav = getDictionary(lang).nav;

  const router = useRouter();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const session = useImagehubSession();
  const { setToken } = session;
  // สถานะกำลังแลก code จาก MOPH และข้อความเมื่อแลกไม่สำเร็จ
  const [exchanging, setExchanging] = useState(false);
  const [loginError, setLoginError] = useState('');
  const codeHandled = useRef(false);

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch('/api/image-queue');
      const json = await res.json();
      if (json.success) {
        setData(json);
        setLoadError('');
        // ImageHub อาจไม่รับ token ระหว่างส่ง จึงอัปเดตสถานะ Login ทุกรอบรีเฟรช
        setToken(json.imagehub.token);
      }
    } catch (err) {
      setLoadError(dict.loadFailed + err.message);
    }
  }, [dict.loadFailed, setToken]);

  useEffect(() => {
    fetchQueue();
    const timer = setInterval(fetchQueue, REFRESH_MS);
    return () => clearInterval(timer);
  }, [fetchQueue]);

  // MOPH ส่ง code กลับมา แลกเป็น token แล้วลบ code ออกจากที่อยู่เว็บ
  // code ใช้ได้ครั้งเดียว จึงต้องแลกแค่รอบเดียว
  useEffect(() => {
    if (codeHandled.current) return;
    codeHandled.current = true;
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code) return;
    router.replace(window.location.pathname);
    setExchanging(true);
    exchangeImagehubCode(code)
      .then((result) => {
        if (result.ok) setToken(result.token);
        else setLoginError(result.message);
      })
      .catch((err) => setLoginError(err.message))
      .finally(() => {
        setExchanging(false);
        fetchQueue();
      });
  }, [router, setToken, fetchQueue]);

  function renderPacsStatus() {
    const f = data.pacs;
    if (!f.enabled) return null; // ปิดอยู่ไม่ต้องแสดง ตัวเลขด้านล่างยังบอกจำนวนภาพที่รอ
    if (!f.configured) return <p className="status-error">{dict.forwardNotConfigured}</p>;
    if (f.pausedUntil) return <p className="status-error">{dict.forwardPaused(secondsUntil(f.pausedUntil), f.lastError)}</p>;
    return null; // แสดงข้อความเฉพาะตอนมีปัญหา
  }

  function renderImagehubStatus() {
    const f = data.imagehub;
    if (!f.enabled) return null;
    if (!f.configured) return <p className="status-error">{dict.imagehubNotConfigured}</p>;
    if (!f.token.valid) return <p className="status-error">{dict.imagehubNoToken(f.token.invalidatedReason)}</p>;
    return (
      <>
        {f.pausedUntil && <p className="status-error">{dict.imagehubPaused(secondsUntil(f.pausedUntil), f.lastError)}</p>}
        {f.hisSystem !== 'hosxp' && <p className="subtitle">{dict.imagehubNoCidHis}</p>}
      </>
    );
  }

  function renderCounts(counts, keys) {
    return (
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '6px' }}>
        {keys.map(([labelKey, statusKey]) => (
          <div
            key={labelKey}
            style={{ border: '1px solid #e5e7eb', borderRadius: '6px', padding: '6px 12px', minWidth: '100px', ...(STATUS_STYLE[statusKey] || {}) }}
          >
            <div style={{ fontSize: '12px' }}>{dict[labelKey]}</div>
            <div style={{ fontSize: '18px', fontWeight: 600 }}>{statusKey ? counts[statusKey] : data.counts.total}</div>
          </div>
        ))}
      </div>
    );
  }

  // เตือนเมื่อมีภาพรอส่งนานเกิน 1 ชั่วโมง
  function renderWarnings() {
    const w = data.warnings;
    if (!w) return null;
    const lines = [];
    if (w.stuck.pacs.count > 0) lines.push(dict.warnStuck('PACS', w.stuck.pacs.count, formatTime(w.stuck.pacs.oldestAt, lang)));
    if (w.stuck.imagehub.count > 0) lines.push(dict.warnStuck('ImageHub', w.stuck.imagehub.count, formatTime(w.stuck.imagehub.oldestAt, lang)));
    if (lines.length === 0) return null;
    return (
      <div className="settings-card" style={{ borderLeft: '4px solid #b45309', background: '#fffbeb' }}>
        {lines.map((line) => <p key={line} style={{ margin: '4px 0', color: '#92400e', fontSize: '13px' }}>{line}</p>)}
      </div>
    );
  }

  async function postAction(url, uid) {
    try {
      await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid }) });
    } finally {
      fetchQueue();
    }
  }

  function renderTargetCell(target, isImagehub) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span style={{ alignSelf: 'flex-start', padding: '2px 8px', borderRadius: '999px', fontSize: '12px', ...STATUS_STYLE[target.status] }}>
          {dict.statusLabels[target.status] || target.status}
        </span>
        {target.attempts > 0 && target.status !== 'success' && (
          <span style={{ fontSize: '11px', color: '#6b7280' }}>
            {dict.attemptsSuffix(target.attempts)}
            {target.status === 'failed' && target.nextAttemptAt ? ` · ${dict.nextRetryPrefix}${formatTime(target.nextAttemptAt, lang)}` : ''}
          </span>
        )}
        {isImagehub && target.cid && (
          <span style={{ fontSize: '11px', color: '#6b7280' }}>
            {target.cidSource === 'his' ? dict.cidFromHis : dict.cidFromHn} · {target.scanType}
          </span>
        )}
        {target.lastError && (
          <span style={{ fontSize: '11px', color: target.status === 'skipped' ? '#854d0e' : '#b91c1c', maxWidth: '280px' }}>{target.lastError}</span>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <h1>{dict.title}</h1>
        <div className="header-actions">
          <ImagehubSessionBar session={session} dict={dict} />
          {!exchanging && session.token && (
            <ImagehubLoginButton session={session} dict={dict} redirectUri={data ? data.imagehub.redirectUri : ''} />
          )}
          <Link className="settings-link" href={`/${lang}/image-queue/settings`}>{dict.settingsButton}</Link>
          <Link className="settings-link" href={`/${lang}`}>{nav.selectSystem}</Link>
        </div>
      </div>
      <p className="subtitle">{dict.subtitle}</p>
      {loadError && <p className="status-error">{loadError}</p>}
      {exchanging && <p className="status-info">{dict.loginExchanging}</p>}
      {loginError && <p className="status-error">{dict.loginFailedTitle}: {loginError}</p>}

      {data && (
        <>
          {renderWarnings()}

          <div className="settings-card">
            <h3>{dict.receiverTitle}</h3>
            {data.receiver.running
              ? <p style={PLAIN_STATUS}>{data.receiver.queueDir} · {dict.countsTotal} {data.counts.total}</p>
              : null}
          </div>

          <div className="settings-card">
            <h3>{dict.forwardTitle}</h3>
            {renderPacsStatus()}
            {renderCounts(data.counts.pacs, [['countsPending', 'pending'], ['countsFailed', 'failed'], ['countsSuccess', 'success'], ['countsOff', 'off']])}
          </div>

          <div className="settings-card">
            <h3>{dict.imagehubTitle}</h3>
            {renderImagehubStatus()}
            {renderCounts(data.counts.imagehub, [['countsPending', 'pending'], ['countsFailed', 'failed'], ['countsSuccess', 'success'], ['countsSkipped', 'skipped'], ['countsOff', 'off']])}
          </div>

          <DicomUpload
            dict={dict}
            pacsEnabled={data.pacs.enabled}
            imagehubEnabled={data.imagehub.enabled}
            onUploaded={fetchQueue}
          />

          <div className="settings-card">
            {data.items.length === 0 ? (
              <p className="subtitle">{dict.emptyQueue}</p>
            ) : (
              <>
                {data.counts.total > data.items.length && <p className="subtitle">{dict.showingLimit(data.items.length)}</p>}
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{dict.table.receivedAt}</th>
                        <th>{dict.table.from}</th>
                        <th>{dict.table.hn}</th>
                        <th>{dict.table.name}</th>
                        <th>{dict.table.accession}</th>
                        <th>{dict.table.modality}</th>
                        <th>{dict.table.pacs}</th>
                        <th>{dict.table.imagehub}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((item) => (
                        <tr key={item.uid} title={item.uid}>
                          <td>
                            {formatTime(item.receivedAt, lang)}
                            {item.completedAt && (
                              <div style={{ fontSize: '11px', color: '#6b7280' }}>
                                {dict.autoDeletePrefix}{formatTime(item.completedAt + data.warnings.retentionMs, lang)}
                              </div>
                            )}
                          </td>
                          <td>{item.callingAet || '-'}</td>
                          <td>{item.patientId || '-'}</td>
                          <td>{item.patientName ? item.patientName.replace(/\^/g, ' ') : '-'}</td>
                          <td>{item.accessionNumber || '-'}</td>
                          <td>{item.modality || '-'}{item.bodyPartExamined ? ` · ${item.bodyPartExamined}` : ''}</td>
                          <td>{renderTargetCell(item.pacs, false)}</td>
                          <td>{renderTargetCell(item.imagehub, true)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          {data.failedItems.length > 0 && (
            <div className="settings-card" style={{ borderLeft: '4px solid #7f1d1d' }}>
              <h3>{dict.failedTitle} ({data.counts.failed})</h3>
              <p className="field-note" style={{ marginTop: 0, marginBottom: '10px' }}>{dict.failedNote}</p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{dict.table.receivedAt}</th>
                      <th>{dict.table.hn}</th>
                      <th>{dict.table.name}</th>
                      <th>{dict.table.modality}</th>
                      <th>{dict.table.pacs}</th>
                      <th>{dict.table.imagehub}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.failedItems.map((item) => (
                      <tr key={item.uid} title={item.uid}>
                        <td>
                          {formatTime(item.receivedAt, lang)}
                          {item.movedToFailedAt && (
                            <div style={{ fontSize: '11px', color: '#6b7280' }}>{dict.failedMovedPrefix}{formatTime(item.movedToFailedAt, lang)}</div>
                          )}
                        </td>
                        <td>{item.patientId || '-'}</td>
                        <td>{item.patientName ? item.patientName.replace(/\^/g, ' ') : '-'}</td>
                        <td>{item.modality || '-'}{item.bodyPartExamined ? ` · ${item.bodyPartExamined}` : ''}</td>
                        <td>{renderTargetCell(item.pacs, false)}</td>
                        <td>{renderTargetCell(item.imagehub, true)}</td>
                        <td>
                          <button type="button" onClick={() => postAction('/api/image-queue/failed/restore', item.uid)}>{dict.restoreButton}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
