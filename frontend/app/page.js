'use client';

import { useEffect, useRef, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

export default function Page() {
  const [dateback, setDateback] = useState(1);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('กำลังโหลดข้อมูล...');

  // ใช้ Map เพื่อเก็บ XN พร้อมสถานะล่าสุด เช่น { "123": { confirm: "N", confirm_read_film: "N" } }
  const loadedXNsMap = useRef(new Map());
  const intervalRef = useRef(null);

  async function loadData(isManual = false) {
    if (isManual) {
      setRows([]);
      loadedXNsMap.current.clear();
      setStatus('กำลังโหลดข้อมูล...');
    }

    // จัดกลุ่ม XN ตามสถานะปัจจุบันที่หน้าบ้านมีอยู่
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

    const requestBody = {
      dateback: dateback || 1,
      include,
      exclude,
      confirm,
      existingXNs,
      xns_NN,
      xns_YN,
      xns_NY
    };

    try {
      const res = await fetch(`${API_URL}/api/xray-report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const json = await res.json();

      if (!json.success) {
        setStatus('เกิดข้อผิดพลาด: ' + json.message);
        return;
      }

      const newRows = [];
      const updatedRowsMap = new Map(); // เอาไว้เก็บข้อมูลเก่าที่มีการอัปเดตสถานะ
      let newCount = 0;
      let updateCount = 0;

      for (const row of json.data) {
        const currentStatus = {
          confirm: row.confirm ?? 'N',
          confirm_read_film: row.confirm_read_film ?? 'N'
        };

        if (loadedXNsMap.current.has(row.xn)) {
          // ถ้าเป็น XN เดิมที่เคยมีแล้ว (แปลว่ามันมีการอัปเดตสถานะมาจาก Backend)
          updatedRowsMap.set(row.xn, row);
          updateCount++;
        } else {
          // ถ้าเป็น XN ใหม่แกะกล่อง
          newRows.push(row);
          newCount++;
        }

        // บันทึก/อัปเดต สถานะล่าสุดลง Map เสมอ
        loadedXNsMap.current.set(row.xn, currentStatus);
      }

      // นำข้อมูลลง State
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
            return [...newRows, ...nextRows]; // ออโต้ 10 วิ ดันไว้บนสุด
          }
        });
      }

      setStatus(
        `แสดงข้อมูลรวม ${loadedXNsMap.current.size} รายการ (พบใหม่: ${newCount} | อัปเดต: ${updateCount})`
      );
    } catch (err) {
      setStatus('เชื่อมต่อ server ไม่ได้: ' + err.message);
    }
  }

  // ป้องกัน stale closure สำหรับตัวแปร state ที่ใช้ใน setInterval
  // สร้างตัวแปรอ้างอิงให้ setInterval เรียกใช้ loadData ตัวล่าสุดเสมอ
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
      <h1>รายงานผล X-ray</h1>

      <div className="filters">
        <label>
          ย้อนหลัง (วัน)
          <input
            type="number"
            min="0"
            placeholder="เช่น 1"
            value={dateback}
            onChange={(e) => setDateback(e.target.value)}
          />
        </label>
        <label>
          คำที่ต้องมี (include)
          <input
            type="text"
            placeholder="เช่น chest"
            value={include}
            onChange={(e) => setInclude(e.target.value)}
          />
        </label>
        <label>
          คำที่ไม่ต้องมี (exclude)
          <input
            type="text"
            placeholder="เช่น old"
            value={exclude}
            onChange={(e) => setExclude(e.target.value)}
          />
        </label>
        <label className="checkbox-group">
          เฉพาะที่ยังไม่ยืนยัน (confirm = N)
          <input
            type="checkbox"
            checked={confirm}
            onChange={(e) => setConfirm(e.target.checked)}
          />
        </label>
        <button onClick={() => loadData(true)}>ค้นหา</button>
      </div>

      <div className="status">{status}</div>

      <div className="table-wrap">
        <table id="dataTable">
          <thead>
            <tr>
              <th>XN</th>
              <th>HN</th>
              <th>CID</th>
              <th>คำนำหน้า</th>
              <th>ชื่อ</th>
              <th>สกุล</th>
              <th>วันเกิด</th>
              <th>เพศ</th>
              <th>รายการ X-ray</th>
              <th>วันที่ตรวจ</th>
              <th>เวลา</th>
              <th>กลุ่ม</th>
              <th>ยืนยันผล</th>
              <th>ยืนยันอ่านฟิล์ม</th>
              <th>แพทย์</th>
              <th>รหัสรายการ</th>
              <th>แผนก</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.xn}>
                <td>{row.xn ?? ''}</td>
                <td>{row.hn ?? ''}</td>
                <td>{row.cid ?? ''}</td>
                <td>{row.pname ?? ''}</td>
                <td>{row.fname ?? ''}</td>
                <td>{row.lname ?? ''}</td>
                <td>{row.birthday ?? ''}</td>
                <td>{row.sex ?? ''}</td>
                <td>{row.xraylist ?? ''}</td>
                <td>{row.StudyDate ?? ''}</td>
                <td>{row.StudyTime ?? ''}</td>
                <td>{row.xray_items_group ?? ''}</td>
                <td>{row.confirm ?? ''}</td>
                <td>{row.confirm_read_film ?? ''}</td>
                <td>{row.Doctor ?? ''}</td>
                <td>{row.xray_items_code ?? ''}</td>
                <td>{row.department_name ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}