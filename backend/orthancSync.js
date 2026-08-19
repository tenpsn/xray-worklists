const fs = require('fs');
const path = require('path');

const ORTHANC_CONFIG_PATH = path.join(__dirname, 'orthanc-config', 'orthanc.json');

// docker-compose.yml อยู่ที่ root ของโปรเจกต์ (นอก /app) ต้องอ้อมผ่าน /mnt/hostX เหมือน toOrthancPath
// PROJECT_HOST_PATH มาจาก setup.bat (Windows, เช่น "D:\xray-worklists") หรือ setup.sh (Linux, เช่น "/root/xray-worklists")
function getDockerComposeHostPath() {
  const projectHostPath = (process.env.PROJECT_HOST_PATH || '').trim();
  if (/^[a-zA-Z]:\\/.test(projectHostPath)) {
    const drive = projectHostPath[0].toUpperCase();
    const restOfProjectPath = projectHostPath.slice(2).replace(/\\/g, '/');
    return `/mnt/host${drive}${restOfProjectPath}/docker-compose.yml`;
  }
  if (projectHostPath.startsWith('/')) {
    return `/mnt/hostRoot${projectHostPath}/docker-compose.yml`;
  }
  return null;
}

// __dirname ในคอนเทนเนอร์ backend คือ /app - Orthanc ไม่ได้ mount ./backend เข้าไป
// เห็นแค่ /mnt/hostC, /mnt/hostD เหมือนกับ backend เท่านั้น
const APP_ROOT = path.resolve(__dirname);

// แปลง path โฟลเดอร์ worklist (ตามที่ backend ใช้งานจริง) ให้เป็น path ที่ Orthanc container มองเห็น
// - ถ้ามาจาก /mnt/hostC หรือ /mnt/hostD อยู่แล้ว (เลือกเองผ่านหน้า Settings) ใช้ค่าเดิมได้เลย เพราะ mount เหมือนกัน
// - ถ้าเป็นโฟลเดอร์ default ที่อยู่ใต้ /app (backend เอง) ต้องแปลงผ่าน PROJECT_HOST_PATH เพราะ Orthanc ไม่เห็น /app
function toOrthancPath(absoluteWorklistPath) {
  const resolved = path.resolve(absoluteWorklistPath);

  if (resolved !== APP_ROOT && !resolved.startsWith(APP_ROOT + path.sep)) {
    return resolved.replace(/\\/g, '/');
  }

  const projectHostPath = (process.env.PROJECT_HOST_PATH || '').trim();
  const rest = resolved.slice(APP_ROOT.length).replace(/\\/g, '/');

  if (/^[a-zA-Z]:\\/.test(projectHostPath)) {
    const drive = projectHostPath[0].toUpperCase();
    const restOfProjectPath = projectHostPath.slice(2).replace(/\\/g, '/');
    return `/mnt/host${drive}${restOfProjectPath}/backend${rest}`;
  }
  if (projectHostPath.startsWith('/')) {
    return `/mnt/hostRoot${projectHostPath}/backend${rest}`;
  }
  return null;
}

// sync โฟลเดอร์ worklist + AE Title + DICOM port เข้า orthanc.json ให้ตรงกับหน้า Settings เสมอ
// เทียบกับค่าที่เขียนไว้ในไฟล์จริง ไม่ใช่ตัวแปรในหน่วยความจำ เพราะ backend อาจ restart เองได้ (เช่น container ค้าง/OOM)
// ต้องอ่านของจริงทุกครั้ง กัน restart Orthanc ซ้ำโดยไม่จำเป็น
// key คงที่สำหรับเครื่อง X-ray เครื่องเดียวที่ลงทะเบียนผ่านหน้า Settings ได้ (ไม่รองรับหลายเครื่องตอนนี้)
const MODALITY_KEY = 'XRAY1';
// พอร์ตของเครื่อง X-ray เอง ไม่ได้ใช้ validate จริง (Orthanc เช็คแค่ AET) เลยตั้งค่าคงที่ไว้ ไม่ต้องให้กรอก
const MODALITY_PORT = 104;

async function syncOrthancWorklistPath(absoluteWorklistPath, aet, port, modalityAet, modalityIp) {
  const orthancPath = toOrthancPath(absoluteWorklistPath);
  if (!orthancPath) {
    console.warn('[Orthanc] ---> แปลง path ให้ Orthanc ไม่สำเร็จ');
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(ORTHANC_CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error('[Orthanc] ---> อ่าน orthanc.json ไม่สำเร็จ:', err.message);
    return;
  }

  let changed = false;

  if (orthancPath && (!config.Worklists || config.Worklists.Database !== orthancPath)) {
    config.Worklists = { Enable: true, Database: orthancPath };
    changed = true;
    console.log(`[Orthanc] ---> อัปเดต Worklists.Database เป็น: ${orthancPath}`);
  }

  const desiredAet = (aet || '').trim();
  if (desiredAet && config.DicomAet !== desiredAet) {
    config.DicomAet = desiredAet;
    changed = true;
    console.log(`[Orthanc] ---> อัปเดต DicomAet เป็น: ${desiredAet}`);
  }

  const desiredModalityAet = (modalityAet || '').trim();
  const desiredModalityIp = (modalityIp || '').trim();
  if (desiredModalityAet && desiredModalityIp) {
    const desiredModality = [desiredModalityAet, desiredModalityIp, MODALITY_PORT];
    const currentModality = config.DicomModalities && config.DicomModalities[MODALITY_KEY];
    if (JSON.stringify(currentModality) !== JSON.stringify(desiredModality)) {
      config.DicomModalities = { ...(config.DicomModalities || {}), [MODALITY_KEY]: desiredModality };
      changed = true;
      console.log(`[Orthanc] ---> อัปเดต DicomModalities.${MODALITY_KEY} เป็น: ${JSON.stringify(desiredModality)}`);
    }
  }

  const previousPort = config.DicomPort;
  const desiredPort = parseInt(port, 10);
  let portChanged = false;
  if (!isNaN(desiredPort) && previousPort !== desiredPort) {
    config.DicomPort = desiredPort;
    changed = true;
    portChanged = true;
    console.log(`[Orthanc] ---> อัปเดต DicomPort เป็น: ${desiredPort}`);
  }

  if (!changed) {
    return; // ไม่มีอะไรเปลี่ยน ไม่ต้อง restart
  }

  try {
    fs.writeFileSync(ORTHANC_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('[Orthanc] ---> เขียน orthanc.json ไม่สำเร็จ:', err.message);
    return;
  }

  if (portChanged) {
    // เปลี่ยน DICOM port ต้องผูก port ใหม่ที่ระดับ container ด้วย ไม่ใช่แค่แก้ orthanc.json
    // แก้ docker-compose.yml ให้อัตโนมัติ แต่ไม่ recreate container เองเพราะไม่เสถียร (ลองแล้วบน Docker
    // Desktop Windows มีทั้งเคส HTTP 500 ตอน start และเคส publish port ไม่ขึ้นจริงเงียบๆ)
    // ให้ผู้ดูแลรัน "docker compose up -d" เอง - docker compose จัดการ network/port publish ได้ถูกต้องกว่า
    updateDockerComposePort(previousPort, desiredPort);
    console.warn(
      `[Orthanc] ---> เปลี่ยน DICOM port เป็น ${desiredPort} แล้ว แต่ยังไม่มีผลจริงจนกว่าจะรัน ` +
      '"docker compose up -d" เอง (restart container เฉยๆ ไม่พอ เพราะ port ผูกไว้ตอน create)'
    );
  } else {
    await restartOrthancContainer();
  }
}

// แก้ "ports:" ของ service orthanc + ORTHANC_PUBLISHED_DICOM_PORT ของ service backend ใน docker-compose.yml
// ให้ตรงกับ DICOM port ใหม่ - ทำแบบ best-effort ด้วย string replace (ไม่ได้ parse YAML เต็มรูปแบบ)
function updateDockerComposePort(oldPort, newPort) {
  const composePath = getDockerComposeHostPath();
  if (!composePath) {
    console.warn('[Orthanc] ---> หา docker-compose.yml ไม่เจอ (PROJECT_HOST_PATH ไม่ถูกต้อง) ต้องแก้ port ใน docker-compose.yml เอง');
    return;
  }

  let text;
  try {
    text = fs.readFileSync(composePath, 'utf8');
  } catch (err) {
    console.error('[Orthanc] ---> อ่าน docker-compose.yml ไม่สำเร็จ:', err.message);
    return;
  }

  let updated = text;
  let replacements = 0;

  updated = updated.replace(
    new RegExp(`(-\\s*")${oldPort}:${oldPort}(")`),
    (match, p1, p2) => { replacements++; return `${p1}${newPort}:${newPort}${p2}`; }
  );
  updated = updated.replace(
    new RegExp(`(ORTHANC_PUBLISHED_DICOM_PORT=)${oldPort}\\b`),
    (match, p1) => { replacements++; return `${p1}${newPort}`; }
  );

  if (replacements < 2) {
    console.warn(
      `[Orthanc] ---> แก้ docker-compose.yml อัตโนมัติได้ไม่ครบ (เจอ ${replacements}/2 จุด) ` +
      `ช่วยเช็ค "ports:" ของ service orthanc และ ORTHANC_PUBLISHED_DICOM_PORT ของ service backend เองด้วย`
    );
  }

  try {
    fs.writeFileSync(composePath, updated, 'utf8');
    console.log(`[Orthanc] ---> อัปเดต docker-compose.yml พอร์ต DICOM เป็น ${newPort} แล้ว`);
  } catch (err) {
    console.error('[Orthanc] ---> เขียน docker-compose.yml ไม่สำเร็จ:', err.message);
  }
}

async function restartOrthancContainer() {
  const proxyUrl = process.env.DOCKER_PROXY_URL;
  const containerName = process.env.ORTHANC_CONTAINER_NAME;

  if (!proxyUrl || !containerName) {
    console.warn('[Orthanc] ---> ไม่ได้ตั้งค่า DOCKER_PROXY_URL/ORTHANC_CONTAINER_NAME ต้อง restart Orthanc เอง (docker compose restart orthanc)');
    return;
  }

  try {
    const res = await fetch(`${proxyUrl}/containers/${containerName}/restart`, { method: 'POST' });
    if (!res.ok && res.status !== 204) {
      throw new Error(`HTTP ${res.status}`);
    }
    console.log('[Orthanc] ---> สั่ง restart container Orthanc สำเร็จ');
  } catch (err) {
    console.error('[Orthanc] ---> สั่ง restart Orthanc ไม่สำเร็จ:', err.message, '- ต้อง restart เอง (docker compose restart orthanc)');
  }
}

module.exports = { syncOrthancWorklistPath, getDockerComposeHostPath };
