// อ่านและแปลงไฟล์ DICOM ระดับ byte เอง ไม่ผ่านไลบรารี DICOM
// เพราะไลบรารีจะแปลงชื่อภาษาไทยเพี้ยน ที่นี่จึงไม่แตะ byte ของค่าเลย

const iconv = require('iconv-lite');

const TS_IMPLICIT_LE = '1.2.840.10008.1.2';
const TS_EXPLICIT_LE = '1.2.840.10008.1.2.1';
const TS_DEFLATED_LE = '1.2.840.10008.1.2.1.99';
const TS_EXPLICIT_BE = '1.2.840.10008.1.2.2';

const UNDEFINED_LENGTH = 0xffffffff;

// VR กลุ่มนี้ใช้ส่วนหัวแบบยาว นอกนั้นใช้ส่วนหัวแบบสั้น
const LONG_FORM_EXPLICIT_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);

function readUid(buffer, start, length) {
  return buffer.toString('ascii', start, start + length).replace(/[\0 ]+$/, '');
}

// แยกไฟล์เป็นส่วน meta กับ byte ของ dataset
// ส่วน meta เข้ารหัสแบบ Explicit VR Little Endian เสมอ
function parseP10(buffer) {
  const DICM_OFFSET = 128;
  if (buffer.length < DICM_OFFSET + 4 || buffer.toString('ascii', DICM_OFFSET, DICM_OFFSET + 4) !== 'DICM') {
    throw new Error('ไม่ใช่ไฟล์ DICOM P10 ที่ถูกต้อง (ไม่พบ DICM magic ที่ offset 128)');
  }

  const meta = {};
  let offset = DICM_OFFSET + 4;
  while (offset + 8 <= buffer.length && buffer.readUInt16LE(offset) === 0x0002) {
    const element = buffer.readUInt16LE(offset + 2);
    const vr = buffer.toString('ascii', offset + 4, offset + 6);
    let length;
    let valueStart;
    if (LONG_FORM_EXPLICIT_VRS.has(vr)) {
      length = buffer.readUInt32LE(offset + 8);
      valueStart = offset + 12;
    } else {
      length = buffer.readUInt16LE(offset + 6);
      valueStart = offset + 8;
    }
    if (element === 0x0002) meta.sopClassUid = readUid(buffer, valueStart, length);
    if (element === 0x0003) meta.sopInstanceUid = readUid(buffer, valueStart, length);
    if (element === 0x0010) meta.transferSyntaxUid = readUid(buffer, valueStart, length);
    offset = valueStart + length;
  }

  if (!meta.transferSyntaxUid) {
    throw new Error('ไม่พบ TransferSyntaxUID (0002,0010) ใน meta header');
  }
  return { meta, datasetBuffer: buffer.slice(offset) };
}

// อ่านส่วนหัวของ element หนึ่งตัว
// item และตัวปิด item ไม่มี VR เสมอ
function readElementHeader(buffer, pos, explicit) {
  const group = buffer.readUInt16LE(pos);
  const element = buffer.readUInt16LE(pos + 2);
  if (group === 0xfffe || !explicit) {
    return { group, element, vr: null, length: buffer.readUInt32LE(pos + 4), headerLength: 8 };
  }
  const vr = buffer.toString('ascii', pos + 4, pos + 6);
  if (LONG_FORM_EXPLICIT_VRS.has(vr)) {
    return { group, element, vr, length: buffer.readUInt32LE(pos + 8), headerLength: 12 };
  }
  return { group, element, vr, length: buffer.readUInt16LE(pos + 6), headerLength: 8 };
}

function isSequence(header) {
  // element ที่ไม่ระบุความยาวและเป็น sequence จะถูกนับเป็น sequence
  if (header.vr === 'SQ') return true;
  return header.length === UNDEFINED_LENGTH && (header.vr === null || header.vr === 'UN');
}

// ข้าม sequence ทั้งก้อน รองรับแบบซ้อนกันหลายชั้น
function skipSequence(buffer, valueStart, length, explicit) {
  if (length !== UNDEFINED_LENGTH) return valueStart + length;
  let pos = valueStart;
  while (pos + 8 <= buffer.length) {
    const item = readElementHeader(buffer, pos, explicit);
    pos += 8;
    if (item.group === 0xfffe && item.element === 0xe0dd) return pos; // ตัวปิด sequence
    if (item.length !== UNDEFINED_LENGTH) {
      pos += item.length;
    } else {
      pos = skipElements(buffer, pos, explicit, true);
    }
  }
  return pos;
}

function skipElements(buffer, pos, explicit, untilItemDelimiter) {
  while (pos + 8 <= buffer.length) {
    const h = readElementHeader(buffer, pos, explicit);
    if (h.group === 0xfffe && h.element === 0xe00d) return pos + 8;
    const valueStart = pos + h.headerLength;
    pos = isSequence(h) ? skipSequence(buffer, valueStart, h.length, explicit) : valueStart + h.length;
  }
  if (untilItemDelimiter) throw new Error('item ไม่มีตัวปิด (Item Delimitation) ข้อมูลไม่สมบูรณ์');
  return pos;
}

// แปลงชื่อเป็นข้อความตามชุดอักขระของไฟล์ ใช้แสดงในหน้าเว็บเท่านั้น
function decodeText(raw, charset) {
  const cs = String(charset || '').toUpperCase();
  let text;
  if (cs.includes('ISO_IR 166') || cs.includes('ISO 2022 IR 166')) text = iconv.decode(raw, 'tis620');
  else if (cs.includes('ISO_IR 192')) text = raw.toString('utf8');
  else text = raw.toString('latin1');
  return text.replace(/[\0 ]+$/, '').trim();
}

const INFO_TAGS = {
  '00080005': 'specificCharacterSet',
  '00080020': 'studyDate',
  '00080050': 'accessionNumber',
  '00080060': 'modality',
  '00100010': 'patientName',
  '00100020': 'patientId',
  '00180015': 'bodyPartExamined',
  '0020000d': 'studyInstanceUid',
};

// ดึงข้อมูลผู้ป่วยไว้แสดงในหน้าคิว อ่านแค่ส่วนต้นไฟล์ ไม่ต้องอ่านถึงภาพ
function extractInfo(datasetBuffer, transferSyntaxUid) {
  if (transferSyntaxUid === TS_DEFLATED_LE || transferSyntaxUid === TS_EXPLICIT_BE) return {};
  const explicit = transferSyntaxUid !== TS_IMPLICIT_LE;
  const raw = {};
  let pos = 0;
  try {
    while (pos + 8 <= datasetBuffer.length) {
      const h = readElementHeader(datasetBuffer, pos, explicit);
      if (h.group > 0x0020) break;
      const valueStart = pos + h.headerLength;
      if (isSequence(h)) {
        pos = skipSequence(datasetBuffer, valueStart, h.length, explicit);
        continue;
      }
      const key = INFO_TAGS[`${h.group.toString(16).padStart(4, '0')}${h.element.toString(16).padStart(4, '0')}`];
      if (key) raw[key] = datasetBuffer.slice(valueStart, valueStart + h.length);
      pos = valueStart + h.length;
    }
  } catch (err) {
    // ข้อมูลผิดรูปแบบก็หยุด ใช้เท่าที่อ่านได้
  }

  const charset = raw.specificCharacterSet ? raw.specificCharacterSet.toString('ascii').trim() : '';
  const info = {};
  for (const key of ['studyDate', 'accessionNumber', 'modality', 'patientId', 'bodyPartExamined', 'studyInstanceUid']) {
    if (raw[key]) info[key] = raw[key].toString('latin1').replace(/[\0 ]+$/, '').trim();
  }
  if (raw.patientName) info.patientName = decodeText(raw.patientName, charset);
  return info;
}

function implicitHeader(group, element, length) {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(group, 0);
  header.writeUInt16LE(element, 2);
  header.writeUInt32LE(length, 4);
  return header;
}

// แปลง element จาก Explicit VR เป็น Implicit VR โดยเปลี่ยนแค่ส่วนหัว
// byte ของค่าไม่ถูกแตะเลย ชื่อภาษาไทยจึงไม่เพี้ยน
function convertElements(buffer, pos, end, untilItemDelimiter) {
  const chunks = [];
  while (pos + 8 <= end) {
    const h = readElementHeader(buffer, pos, true);
    if (h.group === 0xfffe && h.element === 0xe00d) {
      if (!untilItemDelimiter) throw new Error('เจอ Item Delimitation นอก item');
      return { chunks, pos: pos + 8 };
    }
    const valueStart = pos + h.headerLength;

    if (isSequence(h)) {
      const seq = convertSequence(buffer, valueStart, h.length);
      const size = seq.chunks.reduce((n, c) => n + c.length, 0);
      chunks.push(implicitHeader(h.group, h.element, h.length === UNDEFINED_LENGTH ? UNDEFINED_LENGTH : size), ...seq.chunks);
      pos = seq.pos;
      continue;
    }
    if (h.length === UNDEFINED_LENGTH) {
      // ไม่ระบุความยาวแต่ไม่ใช่ sequence แปลว่าเป็นภาพบีบอัด ซึ่งแปลงไม่ได้
      throw new Error(`element (${h.group.toString(16)},${h.element.toString(16)}) ความยาวไม่ระบุ แปลงเป็น Implicit VR ไม่ได้`);
    }
    chunks.push(implicitHeader(h.group, h.element, h.length), buffer.slice(valueStart, valueStart + h.length));
    pos = valueStart + h.length;
  }
  if (untilItemDelimiter) throw new Error('item ไม่มีตัวปิด (Item Delimitation) ข้อมูลไม่สมบูรณ์');
  return { chunks, pos };
}

// แปลง element ข้างในแต่ละ item ของ sequence
function convertSequence(buffer, valueStart, length) {
  const undefinedLength = length === UNDEFINED_LENGTH;
  const end = undefinedLength ? buffer.length : valueStart + length;
  const chunks = [];
  let pos = valueStart;
  while (pos + 8 <= end) {
    const item = readElementHeader(buffer, pos, true);
    if (item.group === 0xfffe && item.element === 0xe0dd) {
      chunks.push(buffer.slice(pos, pos + 8));
      return { chunks, pos: pos + 8 };
    }
    if (item.group !== 0xfffe || item.element !== 0xe000) {
      throw new Error('โครงสร้าง sequence ผิดรูปแบบ (ไม่พบ Item tag)');
    }
    const contentStart = pos + 8;
    if (item.length === UNDEFINED_LENGTH) {
      const inner = convertElements(buffer, contentStart, end, true);
      chunks.push(implicitHeader(0xfffe, 0xe000, UNDEFINED_LENGTH), ...inner.chunks, implicitHeader(0xfffe, 0xe00d, 0));
      pos = inner.pos;
    } else {
      const inner = convertElements(buffer, contentStart, contentStart + item.length, false);
      const size = inner.chunks.reduce((n, c) => n + c.length, 0);
      chunks.push(implicitHeader(0xfffe, 0xe000, size), ...inner.chunks);
      pos = contentStart + item.length;
    }
  }
  if (undefinedLength) throw new Error('sequence ไม่มีตัวปิด (Sequence Delimitation) ข้อมูลไม่สมบูรณ์');
  return { chunks, pos: end };
}

function explicitToImplicit(datasetBuffer) {
  return Buffer.concat(convertElements(datasetBuffer, 0, datasetBuffer.length, false).chunks);
}

module.exports = {
  TS_IMPLICIT_LE,
  TS_EXPLICIT_LE,
  parseP10,
  extractInfo,
  explicitToImplicit,
};
