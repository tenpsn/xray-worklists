# ระบบรายงานผล X-ray

คู่มือนี้สำหรับติดตั้ง/ใช้งาน ถ้าเป็นคนดูแลโค้ด อยากรู้โครงสร้างไฟล์, DICOM คุยกันยังไง, จะรันแบบไม่ผ่าน Docker ยังไง ไปดูที่ [DEVELOPMENT.md](DEVELOPMENT.md) แทน

## 1. เว็บนี้ทำอะไร

เว็บนี้เป็นตัวกลางเชื่อม 2 ฝั่ง — ฐานข้อมูลโรงพยาบาล (HIS) ที่มีรายชื่อคนไข้ที่ถูกส่งมาตรวจ X-ray กับเครื่อง X-ray ที่ต้องรู้ว่าวันนี้มีใครมาตรวจบ้าง แทนที่เจ้าหน้าที่ต้องพิมพ์ชื่อคนไข้ที่หน้าเครื่องเองทุกครั้ง ระบบจะดึงข้อมูลจาก HIS มาส่งให้เครื่องอัตโนมัติ

เปิดเว็บขึ้นมาจะเจอหน้าเลือกระบบก่อน มี 2 อย่าง:

1. **X-ray Report (Worklists)** — ตัวหลักตามที่อธิบายไว้ข้างบน
2. **Case Cleaner** — ค้นหา/ลบเคส (Study) เก่าที่ค้างอยู่ใน Orthanc ตามช่วงวันที่ตรวจ

ฝั่ง X-ray Report ทำได้ประมาณนี้:

- โชว์ตารางคนไข้ที่ถูกส่งตรวจ X-ray รีเฟรชเองทุก 10 วินาที
- กรอง/ค้นหาได้ เช่น ย้อนหลังกี่วัน, เฉพาะที่ยังไม่ยืนยันผล, ชื่อรายการตรวจ
- สลับไทย/อังกฤษได้ ชื่อคนไข้แปลงเป็นตัวสะกดอังกฤษให้อัตโนมัติ
- ส่งข้อมูลคนไข้ไปเครื่อง X-ray แล้วพอตรวจเสร็จหรือยืนยันผลแล้วก็เคลียร์คิวออกให้เอง
- มีหน้า "ตั้งค่าระบบ" กรอกข้อมูลเชื่อมต่อ HIS DB กับเครื่อง Modality ได้เองผ่านเว็บ

ระบบแบ่งเป็น 2 ส่วนที่ต้องรันคู่กัน แต่ทั้งคู่ถูกห่อไว้ใน Docker แล้วให้รันคำสั่งเดียวจบ ไม่ต้องยุ่งกับมันแยกส่วน:

- **Backend** (พอร์ต 4000) — คุยกับ HIS DB และคุยกับเครื่อง X-ray
- **Frontend** (พอร์ต 3000) — หน้าเว็บที่เราเปิดดูตารางผ่านเบราว์เซอร์

---

## 2. ของที่ต้องมีก่อนติดตั้ง

1. เครื่อง **Windows** ที่ลง **Docker Desktop** ไว้ — ตัวที่ทำให้ระบบรันเป็น container อยู่เบื้องหลังตลอด ไม่ต้องเปิดหน้าต่างค้าง ถ้ายังไม่มีก็ไม่เป็นไร ขั้นตอนติดตั้ง (หัวข้อ 3) จะพาไปโหลดเอง
2. ข้อมูลเชื่อมต่อ HIS DB ของโรงพยาบาล — IP, Port, ชื่อฐานข้อมูล, Username, Password (จะกรอกตอนไหนก็ได้ผ่านหน้าเว็บทีหลัง ไม่ต้องรู้ล่วงหน้าตั้งแต่ตอนนี้ก็ได้)
3. ไฟล์ `dump2dcm.exe` (มากับ DCMTK) ใช้แปลงข้อมูลเป็นไฟล์ที่เครื่อง X-ray อ่านได้ — **ติดมากับโปรเจกต์อยู่แล้ว** ไม่ต้องหาเพิ่ม

---

## 3. ติดตั้งครั้งแรก

### ขั้นที่ 1 — วางไฟล์โปรเจกต์

วางไว้ที่ `D:\xray-worklists` (จะวางที่อื่นก็ได้เหมือนกัน) โครงสร้างควรหน้าตาแบบนี้:

```
xray-worklists/
├── backend/
├── frontend/
├── docker-compose.yml
└── setup.bat
```

### ขั้นที่ 2 — เช็คไฟล์ dump2dcm.exe

เปิดดูว่า `backend\dcmtk\bin\dump2dcm.exe` มีอยู่จริง (ปกติติดมากับโปรเจกต์แล้ว ข้ามขั้นนี้ไปได้เลย) ถ้าหายไปจริงๆ ค่อยโหลด DCMTK เวอร์ชัน Windows binaries จาก [dcmtk.org](https://dcmtk.org) แตกไฟล์ zip จะเจอ `dump2dcm.exe` ในโฟลเดอร์ `bin` ของมันเลย (ไม่ต้อง build เอง) ก็อปปี้ทั้งโฟลเดอร์ `bin` ไปทับที่ `backend\dcmtk\bin\`

### ขั้นที่ 3 — รัน setup.bat

ดับเบิลคลิกไฟล์ `setup.bat` ที่ root โปรเจกต์ (หรือเปิด Command Prompt แล้วพิมพ์ `setup.bat`) จะมีหน้าต่างดำๆ ขึ้นมาแล้วทำให้เองทุกอย่าง:

1. เช็คว่ามี Docker ไหม — ถ้าไม่มีจะเปิดหน้าดาวน์โหลด Docker Desktop ให้เอง ติดตั้งแล้ว (อาจต้อง restart เครื่อง) ค่อยดับเบิลคลิก `setup.bat` ใหม่อีกที
2. เตรียมไฟล์ตั้งค่าที่จำเป็นให้เอง ใช้ค่า default ไปก่อนได้เลย ไม่ต้องแก้อะไร
3. ดาวน์โหลด/เตรียมของที่ต้องใช้แล้วสั่งรันระบบให้อัตโนมัติ (รอบแรกอาจใช้เวลาสักพัก)
4. ขึ้นสรุปสถานะให้ดูตอนจบ

รอจนจบแล้วกด Enter ปิดหน้าต่างได้เลย เข้า `http://localhost:3000` เช็คว่าเว็บขึ้นไหม (ตอนนี้ตารางจะยังว่าง/ขึ้น error สีแดงอยู่ เพราะยังไม่ได้บอกระบบว่าฐานข้อมูล HIS อยู่ที่ไหน ไปทำต่อขั้นที่ 4)

### ขั้นที่ 4 — กรอกข้อมูลเชื่อมต่อผ่านหน้าเว็บ

มุมขวาบนกด **"ตั้งค่าระบบ"** กรอก 2 ส่วน:

1. **ฐานข้อมูล HIS** — ชนิดฐานข้อมูล, IP, Port, ชื่อฐานข้อมูล, Username, Password
2. **การเชื่อมต่อเครื่อง Modality (MWL)** — AE Title, พอร์ตให้เครื่อง X-ray ดึงรายชื่อคนไข้, พอร์ตรับสถานะตรวจเสร็จ (MPPS), และโฟลเดอร์เก็บไฟล์ที่ส่งให้เครื่อง (ปล่อยเป็นค่า default `backend/worklists` ได้เลย ไม่ต้องเปลี่ยนก็ได้ ถ้าอยากเก็บที่อื่น เช่นไดรฟ์ที่แชร์กับ Orthanc โดยตรง กด **"เลือกโฟลเดอร์..."** เดินดูโฟลเดอร์จริงแล้วเลือก — ถ้าเปลี่ยน อย่าลืมไปแก้ `Worklists.Database` ใน `orthanc.json` ให้ตรงกันด้วย ดูขั้นที่ 6)

**พอร์ตรับสถานะตรวจเสร็จ (MPPS) ต้องกรอกเอง ไม่มีค่า default** — ถ้าปล่อยว่างไว้ backend จะยังไม่เปิดพอร์ตนี้ แปลว่ายังรับสถานะจากเครื่อง Modality ไม่ได้

**เรื่อง IP ของฐานข้อมูล HIS ที่ต้องรู้ไว้**: ระบบรันอยู่ใน Docker container คำว่า `localhost`/`127.0.0.1` ในมุมมอง container จะหมายถึงตัว container เอง ไม่ใช่เครื่อง Windows ที่รัน Docker อยู่

- ถ้าฐานข้อมูล HIS อยู่**เครื่องเดียวกัน**กับที่รัน Docker → ใส่ `host.docker.internal` แทน `localhost`
- ถ้าฐานข้อมูล HIS อยู่**คนละเครื่อง** (เซิร์ฟเวอร์แยกในวง LAN) → ใส่ IP ปกติ เช่น `192.168.x.x` ได้เลย

กด **"บันทึกการตั้งค่า"** ระบบจะทดสอบเชื่อมต่อ DB ให้ทันทีและบอกผลว่าสำเร็จไหม

### ขั้นที่ 5 — ตั้งค่าฝั่งเครื่อง X-ray

ที่เมนูตั้งค่าของเครื่อง X-ray เอง ใส่ IP ของเครื่องที่รัน backend นี้อยู่ พร้อมพอร์ตและ AE Title ให้ตรงกับขั้นที่ 4

### ขั้นที่ 6 — ตั้งค่า Orthanc

ระบบนี้ไม่ได้คุยกับเครื่อง X-ray ตรงๆ แต่ใช้ **Orthanc** เป็นตัวคอยตอบเครื่อง โดยอ่านไฟล์ที่ backend สร้างไว้ เปิด `orthanc.json` เช็ค 4 จุดนี้ (ปกติทำครั้งเดียวตอนติดตั้ง):

- **`StorageDirectory`, `IndexDirectory`** — โฟลเดอร์ที่มีอยู่จริงในเครื่อง เช่น `D:\Orthanc`
- **`Worklists.Database`** — ต้องเป็น**โฟลเดอร์เดียวกัน**กับที่ตั้งไว้ในขั้นที่ 4 (default คือ `backend\worklists`) เช่น:
  ```json
  "Worklists" : {
    "Enable": true,
    "Database": "D:/xray-worklists/backend/worklists"
  }
  ```
- **`DicomAet`** — ตรงกับ AE Title ที่กรอกในหน้า Settings
- **`DicomPort`** — ตรงกับ Port ที่กรอกในหน้า Settings
- **`DicomAlwaysAllowFind`** / **`DicomAlwaysAllowFindWorklist`** — ตั้ง `true` ทั้งคู่ ให้ Orthanc ตอบเครื่องที่ถามมาได้เลยโดยไม่ต้องเพิ่มชื่อเครื่อง (AE Title) ไว้ล่วงหน้าใน `DicomModalities` (ค่าแรกคุมภาพรวม ค่าที่สองเจาะจงเฉพาะการดึง Worklist)

แก้เสร็จต้อง **restart Orthanc** ค่าถึงจะมีผล

---

## 4. ดูแลระบบหลังติดตั้งแล้ว

ปกติเปิดเครื่องมาไม่ต้องทำอะไรเลย — container จะกลับมารันเองผ่าน `restart: unless-stopped` (ต้องเปิด **Docker Desktop > Settings > General > "Start Docker Desktop when you sign in"** ไว้ด้วย ให้ Docker เปิดเองตอนเข้า Windows)

เช็คว่ารันอยู่ไหม:

```bash
docker compose ps
```

ดู log ว่าเกิดอะไรขึ้นบ้าง:

```bash
docker compose logs -f backend
docker compose logs -f frontend
```

restart ตัวใดตัวหนึ่ง (เช่น backend ค้าง หรือแก้ `.env` แล้วอยากให้มีผล):

```bash
docker compose restart backend
```

หยุดทั้งระบบ:

```bash
docker compose down
```

แก้โค้ดหรือย้ายไปเครื่องใหม่แล้วอยากรันใหม่ทั้งหมด รัน `setup.bat` ซ้ำได้เลย (ไม่ทับไฟล์ตั้งค่าที่มีอยู่แล้ว) หรือรันเองทีละคำสั่ง:

```bash
docker compose build
docker compose up -d
```

### คำสั่ง Docker ที่ใช้บ่อย

หยุดชั่วคราวโดยไม่ลบ container (เปิดกลับมาเร็วกว่า `up -d`):

```bash
docker compose stop
docker compose start
```

เข้าไปเช็คข้างในตัว container (debug):

```bash
docker compose exec backend sh
```

พิมพ์ `exit` เพื่อออก

ลบทิ้งหมดรวม image ด้วย (เริ่มใหม่จริงจัง เช่นตอน dcmtk/Next.js มีปัญหาแปลกๆ):

```bash
docker compose down --rmi all
```

ลบแล้วต้อง `docker compose build` แล้ว `docker compose up -d` ใหม่

---

## 5. คำถามที่พบบ่อย

**เปิดเว็บแล้วตารางว่างเปล่า/ขึ้น error?**
เช็คหน้า "ตั้งค่าระบบ" ว่ากรอกข้อมูล HIS DB ถูกไหม (IP, Password) ลองเข้า `http://localhost:4000/health` ดู เห็น `"ok":true,"db":"connected"` แปลว่าต่อ DB ได้แล้ว ถ้ายัง `"db":"disconnected"` แปลว่า IP/Password/Port ที่กรอกยังไม่ถูก กลับไปแก้ในหน้า Settings

**เครื่อง X-ray ไม่เห็นรายชื่อคนไข้?**
เช็คว่า Orthanc ตั้ง `Worklists.Database` ตรงกับโฟลเดอร์ที่ backend ใช้จริงไหม (ขั้นที่ 6) เช็ค `dump2dcm` มีในตัว container ด้วย `docker compose exec backend which dump2dcm`

**ต้องยืนยันผล X-ray ที่เว็บนี้ไหม?**
ไม่ต้อง เว็บนี้แค่โชว์ตารางให้ดู การยืนยันผลยังทำผ่านระบบ HIS ตามเดิม

**ย้ายไป deploy บน Linux server ที่ไม่ใช่ Docker Desktop ได้ไหม?**
ได้ แต่ `host.docker.internal` (ในขั้นที่ 4) จะใช้ไม่ได้ทันที ต้องเพิ่ม `extra_hosts: ["host.docker.internal:host-gateway"]` ให้ service `backend` ใน `docker-compose.yml` ก่อน

---

# รายละเอียดสำหรับผู้พัฒนา

## รันแบบไม่ผ่าน Docker (สำหรับ debug/แก้โค้ด)

ปกติใช้ `setup.bat` ผ่าน Docker ก็พอแล้ว ไม่ต้องอ่านส่วนนี้ แต่ถ้าอยากรัน backend/frontend ตรงๆ บนเครื่องเพื่อ debug ไล่โค้ด ต้องมี **Node.js เวอร์ชัน 18 ขึ้นไป** ก่อน (โหลดจาก nodejs.org)

```bash
cd backend
npm install
copy .env.example .env
npm run dev
```

เปิด `http://localhost:4000/health` เจอ `{"ok":false,"db":"disconnected",...}` ถือว่าปกติถ้ายังไม่ได้ตั้งค่า DB (ไปตั้งผ่านหน้าเว็บได้เหมือนเดิม)

เปิด terminal อีกหน้าต่าง (ปล่อย backend รันค้างไว้):

```bash
cd frontend
npm install
npm run dev
```

เปิด `http://localhost:3000`

## ไฟล์และข้อมูลที่ระบบจัดการเองอัตโนมัติ

ระบบไม่แตะ HIS DB โดยตรง แต่จะจัดการไฟล์บนเครื่อง backend เองแบบนี้:

**โฟลเดอร์ `backend/worklists/`**

- **`<XN>.dump`** — สร้างชั่วคราวเมื่อมีเคสใหม่/ข้อมูลเปลี่ยน รอแปลงเป็น `.wl` แล้วลบทันทีหลังแปลงสำเร็จ (ถ้าไฟล์ล็อกอยู่ ลองซ้ำสูงสุด 3 ครั้ง)
- **`<XN>.wl`** — สร้าง/อัปเดตด้วย `dump2dcm` เมื่อข้อมูลเปลี่ยนจากครั้งก่อน (เทียบด้วย hash) ลบเมื่อยืนยันผลครบทั้งคู่ (`confirm`+`confirm_read_film`=Y) หรือเครื่องส่ง MPPS `COMPLETED`/`DISCONTINUED`
- **`.worklist-state.json`** — เก็บ hash + StudyInstanceUID ของแต่ละ XN กันสุ่ม UID ซ้ำ ลบ entry ของ XN นั้นเมื่อ `.wl` ถูกลบ (ไฟล์นี้เองไม่ถูกลบทั้งไฟล์)

**โฟลเดอร์ `backend/logs/`** เก็บ `dicom-network-YYYY-MM-DD.log` วันละไฟล์ (log การเชื่อมต่อ DICOM/MPPS) ลบอัตโนมัติเมื่ออายุเกิน 7 วัน

**`backend/mpps-state.json`** เก็บ mapping SOP Instance UID ↔ Accession Number (XN) ที่เครื่อง Modality ส่ง N-CREATE เข้ามา เพื่อจับคู่ตอนได้รับ N-SET ทีหลัง ลบ entry ทันทีเมื่อได้รับสถานะ `COMPLETED`/`DISCONTINUED`

**`backend/settings.json`** เก็บค่าที่ตั้งจากหน้า "ตั้งค่าระบบ" (แทนที่ค่าจาก `.env`) รหัสผ่านไม่ถูกส่งกลับไปแสดงที่หน้าเว็บ (ปิดบังด้วย `••••••••` เสมอ) และไม่ถูกเขียนทับด้วยค่าว่างโดยไม่ตั้งใจตอนกดบันทึก

## ไฟล์หลักในโค้ด

**Backend**

- **`server.js`** — จุดเริ่มต้น เปิด API ให้ frontend เรียก, ดึงข้อมูลจาก HIS DB, สั่งสร้างไฟล์ worklist
- **`db.js`** — เชื่อมต่อฐานข้อมูล รองรับ Postgres/MySQL/MSSQL สลับกันได้ตาม Settings (จัดการ encoding ไทยให้ด้วย)
- **`dicomService.js`** — แปลงข้อมูลคนไข้เป็นไฟล์ `.wl` (แปลงชื่อไทยเป็นคาราโอเกะถ้าเลือกอังกฤษ) ใช้ `dump2dcm.exe` แปลง `.dump` เป็น `.wl`
- **`Mppsservice.js`** — เปิด server แยกรับสถานะ "เริ่มตรวจ"/"ตรวจเสร็จ" จากเครื่อง Modality แล้วลบไฟล์ worklist เมื่อเสร็จ (พอร์ตต้องตั้งเองในหน้า Settings ไม่มี default)
- **`hl7Service.js`** — แปลงข้อความ HL7 เป็นข้อมูล worklist (`parsehl7ToWorklistItem`) ใช้กับ HIS System แบบ HL7 (ดูหัวข้อถัดไป)
- **`settingsService.js`** — โหลด/บันทึกการตั้งค่า HIS DB และ MWL ลงไฟล์ `settings.json`

## HIS System ที่รองรับ (เลือกในหน้า Settings)

- **HOSxP** / **SoftCon** — poll DB ตรง อ่าน table ของ HIS นั้นๆ โดยตรง (เช่น `xray_report`/`patient` สำหรับ HOSxP)
- **HL7** — ใช้กับไซต์ที่มี Gateway อื่น (เช่น BMS PACs Gateway) รับ HL7 จาก HIS แล้วเก็บ raw message เป็น blob ในตาราง `xray_request` (column `xray_request_data`) อยู่แล้ว โหมดนี้แค่ **อ่าน** table นั้นตรงๆ (`SELECT ... WHERE xray_request_receive = 'N'`) แปลง blob เป็นข้อมูลคนไข้ด้วย `parsehl7ToWorklistItem` แล้วแสดง/สร้างไฟล์ worklist เหมือนโหมดอื่น — **ไม่เขียนอะไรกลับเข้า DB ของ HIS เลย**
  - encoding ของ blob มักเป็น **TIS620** ไม่ใช่ UTF-8 (HOSxP รุ่นเก่าเก็บภาษาไทยแบบนี้) ต้องตั้ง Encoding = TIS620 ในหน้า Settings ไม่งั้นชื่อคนไข้จะเพี้ยน
  - segment ในข้อความ HL7 บางไซต์คั่นด้วย `\r\n` บางไซต์คั่นด้วย `\r` เดี่ยวๆ โค้ดรองรับทั้งคู่
  - field ที่ดึงมาแสดง: HN/CID/ชื่อ-นามสกุล/คำนำหน้า (จาก PID), เลข XN/รายการตรวจ/แผนก (จาก ORC/OBR) — field "Group" ไม่มีข้อมูลใน HL7 จึงว่างเสมอในโหมดนี้
  - ORC.1 = `CA` (ยกเลิก order) จะลบไฟล์ worklist แทนการสร้าง/อัปเดต

**Frontend**

โครงสร้าง route ใช้ `[lang]` (`th`/`en`) คุมภาษา หน้าเดิมที่ root (`app/page.js`, `app/settings/page.js`, `app/worklists/page.js`, `app/orthanc-cleaner/page.js`) เหลือแค่ redirect ไป `/en/...` เผื่อมีลิงก์เก่า โค้ดจริงย้ายไปอยู่ใต้ `app/[lang]/` ทั้งหมด

- **`app/[lang]/page.js`** — หน้าเลือกระบบ (X-ray Report / Case Cleaner)
- **`app/[lang]/worklists/page.js`** — หน้าหลัก แสดงตาราง X-ray, กรอง/ค้นหา, auto-refresh ทุก 10 วิ
- **`app/[lang]/settings/page.js`** — หน้าตั้งค่า HIS DB (host, port, username, password, encoding) และ MWL (AE Title, port)
- **`app/[lang]/orthanc-cleaner/page.js`** — หน้า Case Cleaner ค้นหา/ลบเคสใน Orthanc ตามช่วงวันที่ตรวจ
- **`app/lib/i18n.js`** — dictionary คำแปลไทย/อังกฤษของทุกหน้า รวม error message จาก backend ด้วย มี `getDictionary(lang)` ให้แต่ละหน้าดึงไปใช้
- **`app/lib/nameDisplay.js`** — จัดรูปแบบชื่อ-นามสกุลที่แสดงในตาราง ตัดความยาว, แปลงเป็นคาราโอเกะเมื่อเลือกอังกฤษ

## เลือกโฟลเดอร์เก็บไฟล์ Worklist

ปกติไฟล์ `.wl` เก็บในโฟลเดอร์ `backend/worklists` ถ้าอยากให้อยู่นอก backend เช่นอยู่บนไดรฟ์ที่แชร์กับ Orthanc โดยตรง ในหน้า Settings มีปุ่ม **"เลือกโฟลเดอร์..."** เปิดหน้าต่างเดินดูโฟลเดอร์จริงบนเครื่อง backend ได้เลย เปลี่ยนได้ตลอดเวลาโดยไม่ต้อง restart backend — แต่**ต้องไปแก้ `Worklists.Database` ใน `orthanc.json` ให้ชี้ตำแหน่งเดียวกันด้วยเสมอ** ไม่งั้นเครื่อง Modality จะหาไฟล์ไม่เจอ

## ความทนทานต่อ error

- **`mem_limit`** ใน `docker-compose.yml` — backend เกิน 500m หรือ frontend เกิน 400m Docker จะ OOM-kill container นั้น แล้ว `restart: unless-stopped` สั่งให้กลับมารันใหม่อัตโนมัติ (เทียบเท่า `max_memory_restart` ของ PM2 เดิม)
- **Uncaught exception / unhandled rejection** — error ที่ไม่ได้ดักไว้ ระบบ log แล้วปิดโปรแกรมทันที (`process.exit(1)`) แทนที่จะทำงานต่อในสภาพ state เพี้ยน ปล่อยให้ `restart: unless-stopped` สั่ง container เริ่มใหม่แบบสะอาด
- **Port ชนกัน** — backend เปิดไม่สำเร็จเพราะมีโปรแกรมอื่นใช้ port อยู่แล้ว ระบบปิดโปรแกรมทันทีพร้อม log ชัดเจน
- **MPPS server** — ถ้ายังไม่ได้ตั้งพอร์ตในหน้า Settings ระบบจะข้ามไม่เปิดพอร์ตนี้เฉยๆ ไม่ถือว่า error ถ้าตั้งพอร์ตแล้วแต่เปิดไม่สำเร็จตอนสตาร์ทเครื่อง (เช่นพอร์ตชนกัน) ถือว่าร้ายแรงและปิดโปรแกรม แต่ถ้าเปลี่ยนพอร์ตจากหน้าเว็บ Settings ทีหลังแล้วเปิดไม่สำเร็จ จะแค่แจ้งเตือน ไม่ปิดทั้งระบบ
- **เปลี่ยน MPPS port ผ่านหน้า Settings ตอนรันด้วย Docker** — Docker publish port แบบตายตัวตอน container start เท่านั้น เปลี่ยน `mppsPort` ผ่านหน้าเว็บแล้วต้องไปแก้ `ports:` ใน `docker-compose.yml` ให้ตรงกับพอร์ตใหม่ด้วย แล้ว `docker compose up -d` ใหม่ ไม่งั้นเครื่อง Modality เชื่อมเข้ามาไม่ได้
- **`GET /health`** ทดสอบเชื่อมต่อ DB จริงด้วย (`SELECT 1`) ไม่ใช่แค่เช็คว่า process ยังไม่ตาย ต่อ DB ไม่ได้จะตอบ HTTP `503` เหมาะให้เครื่องมือ monitor ภายนอกเรียกเช็คเป็นระยะ

## หมายเหตุอื่นๆ

- ระบบไม่แก้ไข/ลบข้อมูลใดๆ ใน HIS DB โดยตรง การยืนยันผล/อ่านฟิล์ม ยังทำผ่านระบบ HIS ตามปกติ
- การแปลงชื่อไทยเป็นภาษาอังกฤษ (คาราโอเกะ) ใช้เฉพาะแสดงผลและใส่ในไฟล์ worklist เท่านั้น ไม่กระทบข้อมูลจริงในฐานข้อมูล
- `dump2dcm.exe` ต้องมีอยู่จริงตาม path ที่กำหนด ไม่งั้นระบบสร้างได้แค่ไฟล์ `.dump` (เครื่อง Modality จะยังไม่เห็นรายการ เพราะต้องเป็นไฟล์ `.wl` เท่านั้น)
- path ของ `dump2dcm.exe` ตอนนี้เขียนแบบ Windows เท่านั้น ต้องรันบนเครื่อง Windows หรือแก้ path ในโค้ดถ้าจะรันบน Linux/Mac