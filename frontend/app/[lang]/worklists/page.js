'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { formatNameField, formatPrefixField, formatDoctorField } from '../../lib/nameDisplay';
import { getDictionary, formatDbError } from '../../lib/i18n';

export default function Page() {
  const { lang: rawLang } = useParams();
  const lang = rawLang === 'th' ? 'th' : 'en';
  const fullDict = getDictionary(lang);
  const dict = fullDict.worklists;
  const nav = fullDict.nav;

  // อ่านค่า filter ที่บันทึกไว้จาก sessionStorage เพราะสลับภาษาแล้วหน้านี้ remount ใหม่ ค่าจากหน้าเว็บก่อนหน้าจะหายถ้าไม่เก็บไว้
  // ใช้ sessionStorage ไม่ใช่ localStorage เพื่อให้เปิด tab/session ใหม่แล้วเริ่มที่ค่า default เสมอ
  function loadSavedFilters() {
    if (typeof window === 'undefined') return { dateback: 1, include: '', exclude: '', confirm: true };
    try {
      const saved = JSON.parse(window.sessionStorage.getItem('worklistFilters'));
      return {
        dateback: Number(saved?.dateback) > 0 ? Number(saved.dateback) : 1,
        include: saved?.include || '',
        exclude: saved?.exclude || '',
        confirm: saved?.confirm !== false,
      };
    } catch {
      return { dateback: 1, include: '', exclude: '', confirm: true };
    }
  }

  const savedFilters = loadSavedFilters();
  const [dateback, setDateback] = useState(savedFilters.dateback);
  const [include, setInclude] = useState(savedFilters.include);
  const [exclude, setExclude] = useState(savedFilters.exclude);
  const [confirm, setConfirm] = useState(savedFilters.confirm);
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState(dict.statusLoading);

  // เก็บค่าที่ใช้ค้นหาจริงล่าสุด (ตอนกดปุ่มค้นหา)
  const appliedFilters = useRef(savedFilters);

  // ใช้ Map เพื่อเก็บ XN พร้อมสถานะล่าสุด เช่น { "123": { confirm: "N", confirm_read_film: "N" } }
  const loadedXNsMap = useRef(new Map());
  const intervalRef = useRef(null);

  const isLoadingRef = useRef(false);

  // จำ XN ที่กดปุ่ม "ยืนยันอ่านฟิล์ม" ไปแล้วในหน้านี้ (แค่ระหว่าง session นี้ - ไม่ได้เขียนกลับ HIS
  // ดังนั้นถ้าค้นหาใหม่ค่า confirm_read_film ที่ได้จาก HIS จะยังเป็น N เหมือนเดิม แต่ไฟล์ .wl จะไม่ถูกสร้างซ้ำแล้วเพราะ backend จำไว้)
  const [filmConfirmedXNs, setFilmConfirmedXNs] = useState(new Set());
  const [confirmingXn, setConfirmingXn] = useState(null);
  const [showNamePrefix, setShowNamePrefix] = useState(true);

  useEffect(() => {
    fetch(`/api/settings`)
      .then((res) => res.json())
      .then((json) => {
        if (json.success) setShowNamePrefix(json.settings.mwl.showNamePrefix !== false);
      })
      .catch(() => {});
  }, []);

  async function confirmReadFilm(xn) {
    setConfirmingXn(xn);
    try {
      const res = await fetch(`/api/xray-report/confirm-read-film`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xn }),
      });
      const json = await res.json();
      if (json.success) {
        setFilmConfirmedXNs((prev) => new Set(prev).add(xn));
      } else {
        setStatus(dict.statusErrorPrefix + dict.confirmFilmError);
      }
    } catch (err) {
      setStatus(dict.statusConnectErrorPrefix + err.message);
    } finally {
      setConfirmingXn(null);
    }
  }

  async function loadData(isManual = false) {
    if (isLoadingRef.current) {
      // กันไม่ให้ยิง request ซ้อน
      if (isManual) {
        setStatus(dict.statusBusy);
      }
      return;
    }
    isLoadingRef.current = true;

    try {
      if (isManual) {
        setRows([]);
        loadedXNsMap.current.clear();
        setStatus(dict.statusLoading);

        // อัปเดตค่าที่ใช้ค้นหาจริง เฉพาะตอนกดค้นหาเอง
        appliedFilters.current = { dateback, include, exclude, confirm };
      }

      // จัดกลุ่ม XN
      const existingXNs = [];
      const xns_NN = [];
      const xns_YN = [];
      const xns_NY = [];

      loadedXNsMap.current.forEach((statusObj, xn) => {
        existingXNs.push(xn);
        const c = statusObj.confirm;
        const crf = statusObj.confirm_read_film;

        if (c === 'N' && crf === 'N') xns_NN.push(xn);
        else if (c === 'Y' && crf === 'N') xns_YN.push(xn);
        else if (c === 'N' && crf === 'Y') xns_NY.push(xn);
      });

      // ใช้ค่าจาก appliedFilters.current แทน state ของ input ที่อาจกำลังพิมพ์ค้างอยู่
      const requestBody = {
        dateback: appliedFilters.current.dateback || 1,
        include: appliedFilters.current.include,
        exclude: appliedFilters.current.exclude,
        confirm: appliedFilters.current.confirm,
        lang,
        existingXNs,
        xns_NN,
        xns_YN,
        xns_NY
      };

      const res = await fetch(`/api/xray-report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const json = await res.json();

      if (!json.success) {
        if (json.errorCode === 'BUSY') {
          setStatus(dict.statusBusy);
        } else if (json.errorCode === 'DB_NOT_CONFIGURED') {
          setStatus(dict.statusErrorPrefix + dict.errorDbNotConfigured);
        } else if (json.errorCode) {
          setStatus(dict.statusErrorPrefix + formatDbError(fullDict, json.errorCode, json.errorParams));
        } else {
          setStatus(dict.statusErrorPrefix + json.message);
        }
        return;
      }

      const newRows = [];
      const updatedRowsMap = new Map(); // เก็บข้อมูลเก่าที่มีการอัปเดตสถานะ
      let newCount = 0;
      let updateCount = 0;

      for (const row of json.data) {
        const currentStatus = {
          confirm: row.confirm ?? 'N',
          confirm_read_film: row.confirm_read_film ?? 'N'
        };

        if (loadedXNsMap.current.has(row.xn)) {
          // ถ้าเป็น XN เดิมที่เคยมีแล้ว แปลว่ามันมีการอัปเดตสถานะมาจาก backend
          updatedRowsMap.set(row.xn, row);
          updateCount++;
        } else {
          // ถ้าเป็น XN ใหม่
          newRows.push(row);
          newCount++;
        }

        // บันทึก/อัปเดต สถานะล่าสุดลง Map เสมอ
        loadedXNsMap.current.set(row.xn, currentStatus);
      }

      if (newRows.length > 0 || updatedRowsMap.size > 0) {
        setRows((prev) => {
          // 1. อัปเดตข้อมูลเก่าก่อน ถ้ามีตัวไหนตรงกับ updatedRowsMap ให้ใช้ข้อมูลใหม่
          let nextRows = prev.map((existingRow) => {
            if (updatedRowsMap.has(existingRow.xn)) {
              return updatedRowsMap.get(existingRow.xn);
            }
            return existingRow;
          });

          // 2. เอาข้อมูลใหม่มาต่อ
          if (isManual) {
            return [...nextRows, ...newRows];
          } else {
            return [...newRows, ...nextRows]; // ออโต้ 10 วิ ไว้บนสุด
          }
        });
      }

      setStatus(
        dict.statusSummary({ total: loadedXNsMap.current.size, newCount, updateCount })
      );
    } catch (err) {
      setStatus(dict.statusConnectErrorPrefix + err.message);
    } finally {
      isLoadingRef.current = false;
    }
  }

  // เซฟค่าที่พิมพ์ไว้ตลอด แม้ยังไม่กด Search กันหายตอนสลับภาษา (หน้านี้ remount ใหม่ทุกครั้งที่เปลี่ยน lang)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('worklistFilters', JSON.stringify({ dateback, include, exclude, confirm }));
  }, [dateback, include, exclude, confirm]);

  const loadDataRef = useRef(loadData);
  useEffect(() => {
    loadDataRef.current = loadData;
  }, [loadData]);

  useEffect(() => {
    loadDataRef.current(true); // โหลดครั้งแรก

    if (!intervalRef.current) {
      intervalRef.current = setInterval(() => {
        loadDataRef.current(false);
      }, 10000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  return (
    <>
      <div className="page-header">
        <h1>{dict.pageTitle}</h1>
        <div className="header-actions">
          <Link className="settings-link" href={`/${lang}`}>{nav.selectSystem}</Link>
          <Link className="settings-link" href={`/${lang}/settings`}>{nav.settingsLink}</Link>
        </div>
      </div>

      <div className="filters">
        <label>
          {dict.datebackLabel}
          <input
            type="number"
            min="0"
            placeholder={dict.datebackPlaceholder}
            value={dateback}
            onChange={(e) => setDateback(e.target.value)}
          />
        </label>
        <label>
          {dict.includeLabel}
          <input
            type="text"
            placeholder={dict.includePlaceholder}
            value={include}
            onChange={(e) => setInclude(e.target.value)}
          />
        </label>
        <label>
          {dict.excludeLabel}
          <input
            type="text"
            placeholder={dict.excludePlaceholder}
            value={exclude}
            onChange={(e) => setExclude(e.target.value)}
          />
        </label>
        <label className="checkbox-group">
          {dict.confirmLabel}
          <input
            type="checkbox"
            checked={confirm}
            onChange={(e) => setConfirm(e.target.checked)}
          />
        </label>
        <button onClick={() => loadData(true)}>{dict.searchButton}</button>
      </div>

      <div className="status">{status}</div>

      <div className="table-wrap">
        <table id="dataTable">
          <thead>
            <tr>
              <th>XN</th>
              <th>HN</th>
              <th>CID</th>
              {showNamePrefix && <th>{dict.table.prefix}</th>}
              <th>{dict.table.firstName}</th>
              <th>{dict.table.lastName}</th>
              <th>{dict.table.birthday}</th>
              <th>{dict.table.sex}</th>
              <th>{dict.table.xrayList}</th>
              <th>{dict.table.studyDate}</th>
              <th>{dict.table.studyTime}</th>
              <th>{dict.table.group}</th>
              <th>{dict.table.modality}</th>
              <th>{dict.table.confirmResult}</th>
              <th>{dict.table.confirmFilm}</th>
              <th>{dict.table.doctor}</th>
              <th>{dict.table.itemCode}</th>
              <th>{dict.table.department}</th>
              <th>{dict.table.action}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isFilmConfirmed = row.confirm_read_film === 'Y' || filmConfirmedXNs.has(row.xn);
              return (
              <tr key={row.xn}>
                <td>{row.xn ?? ''}</td>
                <td>{row.hn ?? ''}</td>
                <td>{row.cid ?? ''}</td>
                {showNamePrefix && <td>{formatPrefixField(row.pname)}</td>}
                <td>{formatNameField(row.fname, lang)}</td>
                <td>{formatNameField(row.lname, lang)}</td>
                <td>{row.birthday ?? ''}</td>
                <td>{row.sex ?? ''}</td>
                <td>{row.xraylist ?? ''}</td>
                <td>{row.StudyDate ?? ''}</td>
                <td>{row.StudyTime ?? ''}</td>
                <td>{row.xray_items_group ?? ''}</td>
                <td>{row.Modality ?? ''}</td>
                <td>{row.confirm ?? ''}</td>
                <td>{isFilmConfirmed ? 'Y' : (row.confirm_read_film ?? '')}</td>
                <td>{formatDoctorField(row.Doctor, lang)}</td>
                <td>{row.xray_items_code ?? ''}</td>
                <td>{row.department_name ?? ''}</td>
                <td>
                  {isFilmConfirmed ? (
                    dict.confirmFilmDone
                  ) : (
                    <button
                      onClick={() => confirmReadFilm(row.xn)}
                      disabled={confirmingXn === row.xn}
                    >
                      {dict.confirmFilmButton}
                    </button>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
