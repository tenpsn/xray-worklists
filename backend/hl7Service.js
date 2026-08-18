// แปลงวันเวลาแบบ hl7 (TS) เช่น 20260723120000 หรือ 20260723 ให้เป็น Date object
// คืนค่า null ถ้าแปลงไม่ได้/ไม่มีข้อมูล เพื่อให้ผู้เรียกไป fallback เป็นเวลาปัจจุบันแทน
function parsehl7DateTime(ts) {
  const digits = String(ts || '').replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;

  const year = digits.substring(0, 4);
  const month = digits.substring(4, 6);
  const day = digits.substring(6, 8);
  const hour = digits.substring(8, 10) || '00';
  const min = digits.substring(10, 12) || '00';
  const sec = digits.substring(12, 14) || '00';

  const d = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`);
  return isNaN(d.getTime()) ? null : d;
}

// ฟังก์ชันแกะข้อความ hl7 เป็น Object สำหรับสร้าง Worklist
function parsehl7ToWorklistItem(hl7Data) {
  // segment คั่นด้วย \r ตาม spec แต่บาง HIS ส่งมาเป็น \r\n จริง แยกให้ครอบคลุมทั้งสองแบบ
  const segments = hl7Data.split(/\r\n|\r|\n/);
  let msh = [], pid = [], obr = [], orc = [];

  segments.forEach(segment => {
    if (segment.startsWith('MSH')) msh = segment.split('|');
    if (segment.startsWith('PID')) pid = segment.split('|');
    if (segment.startsWith('ORC')) orc = segment.split('|');
    if (segment.startsWith('OBR')) obr = segment.split('|');
  });

  // ORC.1 Order Control: NW = order ใหม่, CA = ขอยกเลิก order
  const orderControl = (orc[1] || 'NW').toUpperCase();

  if (!pid.length || (!obr.length && !orc.length)) {
    throw new Error('ข้อความ hl7 ไม่สมบูรณ์ (ขาด PID, ORC หรือ OBR)');
  }

  // แกะข้อมูลคนไข้ (PID)
  const patientId = (pid[3] || '').split('^')[0]; // HN
  const cid = pid[4] || '';
  const patientNameParts = (pid[5] || '').split('^'); // นามสกุล^ชื่อ^กลาง^คำนำหน้าท้าย^คำนำหน้า
  const lname = patientNameParts[0] || '';
  const fname = patientNameParts[1] || '';
  const pname = patientNameParts[4] || patientNameParts[3] || ''; // คำนำหน้า
  const dob = pid[7] || ''; // YYYYMMDD
  const hl7Sex = pid[8] || 'O';
  const sex = hl7Sex === 'M' ? '1' : hl7Sex === 'F' ? '2' : 'O';

  // แกะข้อมูลรายการออเดอร์ (OBR / ORC)
  const accessionNumber = (obr[3] || orc[2] || '').split('^')[0] || `XN${Date.now()}`;
  const procedureInfo = (obr[4] || '').split('^');
  const procedureCode = procedureInfo[0] || ''; // รหัส X-ray
  const procedureDesc = procedureInfo[1] || procedureCode; // ชื่อ X-ray
  // component แรกเป็นรหัสหมอ (ID) ตัดทิ้ง เหลือแต่ชื่อให้เหมือน mode อื่น
  const doctorParts = (obr[16] || orc[12] || '').split('^');
  const doctorName = (doctorParts.slice(1).join(' ') || doctorParts[0] || '').trim();
  // OBR.24 บางไซต์ส่งเป็น "code^text" ไม่ใช่ DICOM code เดี่ยว เชื่อไม่ได้ ปล่อยว่างให้ dicomService fallback เป็น CR เหมือน hosxp/softcon
  const modality = '';
  // OBR.18 แผนก บางไซต์ส่งแค่รหัส บางไซต์ส่ง "รหัส^ชื่อแผนก" เอาชื่อถ้ามี ไม่มีก็ใช้รหัสแทน
  const deptInfo = (obr[18] || '').split('^');
  const department = deptInfo[1] || deptInfo[0] || '';

  // ดึงวันเวลาที่สั่งตรวจจริงจาก OBR-6 (Requested Date/Time) ไม่ใช้ OBR-7
  // ถ้าไม่มี/แปลงไม่ได้ ค่อย fallback เป็นเวลาปัจจุบัน ณ ตอนรับข้อความ
  const requestedDateTime = parsehl7DateTime(obr[6]) || new Date();

  // จัดโครงสร้างให้ตรงกับที่ dicomService ต้องการ (record.lang จะถูกผู้เรียกเขียนทับตาม lang ที่ผู้ใช้เลือกอีกที)
  return {
    xn: accessionNumber,
    hn: patientId,
    cid: cid,
    pname: pname,
    fname: fname,
    lname: lname,
    birthday: dob,
    sex: sex,
    StudyDate: requestedDateTime,
    StudyTime: requestedDateTime.toTimeString().split(' ')[0],
    Modality: modality,
    Doctor: doctorName,
    xraylist: procedureDesc,
    xray_items_code: procedureCode,
    department_name: department,
    lang: 'en',
    orderControl: orderControl
  };
}

module.exports = {
  parsehl7ToWorklistItem,
};
