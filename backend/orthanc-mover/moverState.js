// เก็บสถานะ job ย้าย Study ลง disk เพื่อให้ backend restart กลางงานแล้วทำต่อจากจุดเดิมได้ (ดู
// resumeIfNeeded ใน orthancMoverService.js) - แยกเป็น 2 ส่วน:
//   1. ไฟล์สรุป (mover-state.json) - ทุกอย่างยกเว้นรายชื่อเคส เล็กและคงที่ เขียนทับได้ถี่ๆ สบายๆ
//   2. ไฟล์รายวันแบบ append-only (mover-plan/{date}.jsonl) - บรรทัดแรกคือรายชื่อเคสเริ่มต้น
//      ทั้งหมดของวันนั้น (สถานะ pending) บรรทัดถัดๆ ไปคือ "เคสนี้ตอนนี้สถานะอะไร" ทีละบรรทัด
//      ต่อท้ายไปเรื่อยๆ ไม่ใช่เขียนทับทั้งไฟล์เหมือนเดิม - เร็วเท่าไฟล์ log ของ movestudy.js (CLI)
//      เพราะแค่ต่อท้าย ไม่ต้องอ่าน/เขียนเนื้อหาเดิมใหม่ทุกครั้งที่มี 1 เคสเสร็จ
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'mover-state.json');
const PLAN_DIR = path.join(__dirname, 'mover-plan');

// ล้างผลงานที่จบไปแล้ว (done/stopped/error) กลับเป็น idle อัตโนมัติ หลังจบงานไป 1 ชั่วโมง
// กันหน้าเว็บค้างโชว์ผลงานเก่าตลอดไปโดยไม่มีใครมากดเริ่มงานใหม่
const AUTO_CLEAR_MS = 60 * 60 * 1000;
const FINISHED_STATUSES = ['done', 'stopped', 'error'];

function ensurePlanDir() {
  try {
    fs.mkdirSync(PLAN_DIR, { recursive: true });
  } catch (err) {
    // เดี๋ยวพังตอนเขียนไฟล์จริงแทน ไม่ต้องทำอะไรตรงนี้
  }
}

function planFilePath(date) {
  return path.join(PLAN_DIR, `${date}.jsonl`);
}

// ลบไฟล์รายวันเก่าทั้งหมดทิ้ง - เรียกตอนเริ่มงานใหม่ (ล้างของงานก่อนหน้า) หรือตอน auto-clear
function clearPlanFiles() {
  try {
    for (const f of fs.readdirSync(PLAN_DIR)) {
      try {
        fs.unlinkSync(path.join(PLAN_DIR, f));
      } catch (err) {
        // ไฟล์นี้ลบไม่ได้ก็ข้ามไป ไม่ให้กระทบไฟล์อื่น
      }
    }
  } catch (err) {
    // ยังไม่มีโฟลเดอร์ - ไม่เป็นไร
  }
}

// อ่านไฟล์ .jsonl ของวันหนึ่ง (บรรทัดแรก = รายชื่อเคสเริ่มต้นทั้งหมด, บรรทัดถัดๆ ไป = อัปเดต
// สถานะทีละเคสตามลำดับที่เกิดขึ้นจริง) แล้วเล่นซ้ำเอาค่าล่าสุดของแต่ละเคส ประกอบกลับเป็น
// { date, studies } ก้อนเดียวเหมือนตอนยังเก็บเป็น JSON ไฟล์เดียว
function loadDayFile(filePath, dateFromFileName) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return null;

  const first = JSON.parse(lines[0]);
  const studies = first.studies;
  const byId = new Map(studies.map((s) => [s.id, s]));

  for (let i = 1; i < lines.length; i += 1) {
    let evt;
    try {
      evt = JSON.parse(lines[i]);
    } catch (err) {
      continue; // บรรทัดนี้เขียนไม่สมบูรณ์ (เช่น backend ดับกลางคัน) - ข้ามไป ไม่ทำให้ทั้งไฟล์พัง
    }
    const s = byId.get(evt.id);
    if (s) {
      s.status = evt.status;
      s.message = evt.message;
    }
  }

  return { date: first.date || dateFromFileName, studies };
}

function loadStateFromDisk() {
  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    return { status: 'idle' };
  }

  const plan = [];
  try {
    const files = fs.readdirSync(PLAN_DIR).filter((f) => f.endsWith('.jsonl')).sort();
    for (const f of files) {
      try {
        const entry = loadDayFile(path.join(PLAN_DIR, f), f.replace(/\.jsonl$/, ''));
        if (entry) plan.push(entry);
      } catch (err) {
        // ไฟล์วันนั้นอ่านไม่ได้ - ข้ามไปดีกว่าทำให้ resume ทั้งงานพัง
      }
    }
  } catch (err) {
    // ยังไม่มีโฟลเดอร์ - ยังไม่เคยรันหรือเพิ่งเริ่ม ไม่เป็นไร
  }

  return { ...summary, plan };
}

let state = loadStateFromDisk();

function getState() {
  if (
    state &&
    FINISHED_STATUSES.includes(state.status) &&
    state.finishedAt &&
    Date.now() - state.finishedAt > AUTO_CLEAR_MS
  ) {
    clearPlanFiles();
    state = { status: 'idle' };
    saveSummary();
  }
  return state;
}

function setState(newState) {
  clearPlanFiles();
  state = newState;
  saveSummary();
}

// บันทึกแค่ "สรุป" (ไม่มีรายชื่อเคส) - ไฟล์เล็กขนาดคงที่ เขียนทับได้บ่อยๆ สบายๆ ไม่แพงเหมือนเขียน
// ทับรายชื่อเคสทั้งหมด
function saveSummary() {
  try {
    ensurePlanDir();
    const { plan, ...summary } = state;
    fs.writeFileSync(STATE_FILE, JSON.stringify(summary), 'utf8');
  } catch (err) {
    console.error('[OrthancMover] ---> บันทึกสถานะ job ไม่สำเร็จ:', err.message);
  }
}

// เขียนบรรทัดแรกของไฟล์วันนั้น (รายชื่อเคสเริ่มต้นทั้งหมด สถานะ pending) - เรียกครั้งเดียวตอน
// ค้นหาเจอวันนั้น ก่อนเริ่มส่งเคสไหนเลย
function recordDayDiscovered(dateEntry) {
  try {
    ensurePlanDir();
    const line = `${JSON.stringify({ date: dateEntry.date, studies: dateEntry.studies })}\n`;
    fs.writeFileSync(planFilePath(dateEntry.date), line, 'utf8');
  } catch (err) {
    console.error('[OrthancMover] ---> บันทึกวันที่ใหม่ไม่สำเร็จ:', err.message);
  }
}

// เขียนเพิ่ม 1 บรรทัดต่อท้ายไฟล์ของวันนั้น (สถานะล่าสุดของเคสเดียว) - ไม่ว่าไฟล์จะมีกี่บรรทัด
// อยู่แล้วก็เร็วเท่าเดิม เพราะแค่ต่อท้าย ไม่ต้องอ่าน/เขียนเนื้อหาเดิมใหม่เลย
function appendStudyUpdate(date, study) {
  try {
    ensurePlanDir();
    const line = `${JSON.stringify({ id: study.id, status: study.status, message: study.message })}\n`;
    fs.appendFileSync(planFilePath(date), line, 'utf8');
  } catch (err) {
    console.error('[OrthancMover] ---> บันทึกผลเคสไม่สำเร็จ:', err.message);
  }
}

module.exports = { getState, setState, saveSummary, recordDayDiscovered, appendStudyUpdate };
