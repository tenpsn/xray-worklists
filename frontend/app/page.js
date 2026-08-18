export const metadata = {
  title: 'เลือกระบบ',
};

export default function HomePage() {
  return (
    <div className="menu-page">
      <h1>เลือกระบบที่ต้องการใช้งาน</h1>
      <div className="menu-grid">
        <a className="menu-card" href="/worklists">
          <div className="menu-icon">🩻</div>
          <h2>รายงานผล X-ray</h2>
          <p>รายชื่อคนไข้ที่ส่งตรวจและส่งข้อมูลไปเครื่อง Modality</p>
        </a>
        <a className="menu-card" href="/orthanc-cleaner">
          <div className="menu-icon">🗑️</div>
          <h2>Case Cleaner</h2>
          <p>ค้นหาและลบเคส (Study) ใน Orthanc ตามช่วงวันที่ตรวจ</p>
        </a>
      </div>
    </div>
  );
}
