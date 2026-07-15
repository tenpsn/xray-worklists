# รายงาน X-ray — แยก Frontend / Backend

โปรเจกต์นี้แยกเป็น **2 โปรเจกต์อิสระ** รันคนละ process / คนละ port:

```
xray-report-app/
├── backend/    -> Express API (port 4000)
└── frontend/   -> Next.js (port 3000)
```

## 1) รัน Backend (Express API)

```bash
cd backend
npm install
cp .env.example .env    # แก้ค่า DB และ CORS_ORIGIN ให้ตรงกับ frontend
npm run dev
```

ค่า default: `http://localhost:4000`
ทดสอบว่าตื่นอยู่: `GET http://localhost:4000/health`

## 2) รัน Frontend (Next.js)

เปิด terminal อีกอันหนึ่ง:

```bash
cd frontend
npm install
cp .env.local.example .env.local   # ชี้ NEXT_PUBLIC_API_URL ไปที่ backend
npm run dev
```

เปิด http://localhost:3000

## การเชื่อมต่อกันระหว่างสองฝั่ง

- Frontend อ่าน URL ของ backend จาก `NEXT_PUBLIC_API_URL` (ค่า default `http://localhost:4000`) แล้วยิง `fetch` ตรงไปที่ backend เลย (ไม่ผ่าน Next.js API route แล้ว)
- Backend เปิด CORS ให้เฉพาะ origin ที่ตั้งไว้ใน `CORS_ORIGIN` (ค่า default `http://localhost:3000`)
- ถ้า deploy จริง (คนละโดเมน/เซิร์ฟเวอร์) ให้แก้ 2 ค่านี้ให้ตรงกับ URL จริงของแต่ละฝั่ง

## Error handling

ทั้งสองฝั่งมี `try/catch` ครบ:

- **Backend** (`backend/server.js`): ครอบ `pool.query()` — query ผิดพลาดจะ return `{ success: false, message, error }` พร้อม HTTP 500 แทนที่จะทำให้ process ล่ม
- **Frontend** (`frontend/app/page.js`): ครอบ `fetch()` — ถ้าเรียก backend ไม่ได้ (server ล่ม, CORS บล็อก, network error) จะขึ้นข้อความ "เชื่อมต่อ server ไม่ได้" ให้ผู้ใช้เห็นแทนที่แอปจะค้าง

## Production build

```bash
# backend
cd backend && npm start

# frontend
cd frontend && npm run build && npm start
```

แนะนำให้รันทั้งสองอย่างต่อเนื่องด้วย process manager เช่น `pm2` หรือแยก container คนละตัว (Docker) ในระบบจริง
