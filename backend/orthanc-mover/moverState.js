// เก็บสถานะ job ย้าย Study ลง disk แบบ sync เหมือน pattern ของ mpps-state.json
// โหลดเข้าหน่วยความจำตอน module ถูก require ครั้งแรก แล้วเขียนทับทั้งไฟล์ทุกครั้งที่สถานะเปลี่ยน
// เพื่อให้ backend restart กลางงานแล้วทำต่อจากจุดเดิมได้ (ดู resumeIfNeeded ใน orthancMoverService.js)
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'mover-state.json');

// ล้างผลงานที่จบไปแล้ว (done/stopped/error) กลับเป็น idle อัตโนมัติ หลังจบงานไป 1 ชั่วโมง
// กันหน้าเว็บค้างโชว์ผลงานเก่าตลอดไปโดยไม่มีใครมากดเริ่มงานใหม่
const AUTO_CLEAR_MS = 60 * 60 * 1000;
const FINISHED_STATUSES = ['done', 'stopped', 'error'];

function loadStateFromDisk() {
  try {
    const text = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    return { status: 'idle' };
  }
}

let state = loadStateFromDisk();

function getState() {
  if (
    state &&
    FINISHED_STATUSES.includes(state.status) &&
    state.finishedAt &&
    Date.now() - state.finishedAt > AUTO_CLEAR_MS
  ) {
    state = { status: 'idle' };
    saveState();
  }
  return state;
}

function setState(newState) {
  state = newState;
  saveState();
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  } catch (err) {
    console.error('[OrthancMover] ---> บันทึกสถานะ job ไม่สำเร็จ:', err.message);
  }
}

module.exports = { getState, setState, saveState };
