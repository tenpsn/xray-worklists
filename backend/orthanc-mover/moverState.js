// เก็บสถานะ job ย้าย Study ลง disk แบบ sync เพื่อให้ backend restart กลางงานแล้วทำต่อจากจุดเดิม
// ได้ (ดู resumeIfNeeded ใน orthancMoverService.js) - แยกเป็น 2 ส่วน แทนที่จะรวมเป็นไฟล์เดียว:
//   1. ไฟล์สรุป (mover-state.json) - ทุกอย่างยกเว้นรายชื่อเคส เล็กและคงที่ เขียนทับได้ถี่ๆ สบายๆ
//   2. ไฟล์รายวัน (mover-plan/{date}.json) - รายชื่อเคสของแต่ละวัน แยกไฟล์กันคนละวัน
// เขียนทับแค่ไฟล์ของ "วันที่กำลังทำอยู่ตอนนี้" เท่านั้นทุกครั้งที่มีเคสเสร็จ วันที่ทำเสร็จไปแล้ว
// จะไม่ถูกแตะอีกเลย - ขนาดที่ต้องเขียนทับต่อครั้งเลยคงที่ตามจำนวนเคสต่อวัน ไม่โตขึ้นเรื่อยๆ ตาม
// ทั้งงาน (ปัญหาเดิมตอนเก็บทุกวันรวมเป็น JSON ก้อนเดียว ยิ่งงานยาวยิ่งเขียนช้าลงเรื่อยๆ)
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
  return path.join(PLAN_DIR, `${date}.json`);
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

// อ่านไฟล์สรุปกับไฟล์รายวันทุกไฟล์ที่มี แล้วประกอบกลับเป็น state เดียวเหมือนก่อนแยกไฟล์
function loadStateFromDisk() {
  let summary;
  try {
    const text = fs.readFileSync(STATE_FILE, 'utf8');
    summary = JSON.parse(text);
  } catch (err) {
    return { status: 'idle' };
  }

  const plan = [];
  try {
    const files = fs.readdirSync(PLAN_DIR).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      try {
        plan.push(JSON.parse(fs.readFileSync(path.join(PLAN_DIR, f), 'utf8')));
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
    saveState();
  }
  return state;
}

function setState(newState) {
  clearPlanFiles();
  state = newState;
  saveState();
}

function saveState() {
  try {
    ensurePlanDir();
    const { plan, ...summary } = state;
    fs.writeFileSync(STATE_FILE, JSON.stringify(summary), 'utf8');

    // เขียนแค่ไฟล์ของวันที่กำลังทำอยู่ตอนนี้เท่านั้น - วันอื่นที่ทำไปแล้วก่อนหน้านี้ถูกบันทึกไว้
    // ครบแล้วตั้งแต่ตอนที่มันยังเป็น currentDate อยู่ ไม่ต้องเขียนซ้ำอีก
    if (state.currentDate && Array.isArray(plan)) {
      const entry = plan.find((d) => d.date === state.currentDate);
      if (entry) {
        fs.writeFileSync(planFilePath(state.currentDate), JSON.stringify(entry), 'utf8');
      }
    }
  } catch (err) {
    console.error('[OrthancMover] ---> บันทึกสถานะ job ไม่สำเร็จ:', err.message);
  }
}

module.exports = { getState, setState, saveState };
