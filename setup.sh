#!/usr/bin/env bash
set -euo pipefail

# ติดตั้ง xray-worklists บนเครื่องใหม่แบบรันทีเดียวจบ (Linux/macOS)
# ใช้งาน: ./setup.sh        (รันอัตโนมัติทั้งหมด ไม่ต้องแก้ env ก่อน)
#
# หมายเหตุ: การเชื่อมต่อฐานข้อมูล HIS (PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD)
# ไม่ต้องตั้งในไฟล์ env แล้ว ให้ไปตั้งค่าในหน้าเว็บ Settings หลังระบบรันขึ้นแทน

cd "$(dirname "$0")"

echo "== xray-worklists setup =="

if ! command -v docker >/dev/null 2>&1; then
    echo "ไม่พบ Docker กำลังเปิดหน้าดาวน์โหลด Docker Desktop ให้..."
    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "https://www.docker.com/products/docker-desktop/" >/dev/null 2>&1 &
    elif command -v open >/dev/null 2>&1; then
        open "https://www.docker.com/products/docker-desktop/" >/dev/null 2>&1 &
    fi
    echo "ติดตั้ง Docker ให้เสร็จ (อาจต้อง restart เครื่อง) แล้วรัน setup.sh นี้ใหม่อีกครั้ง"
    read -rp "กด Enter เพื่อออก..." _
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: ไม่พบ \"docker compose\" ต้องใช้ Docker Compose v2"
    exit 1
fi

# ใช้ docker-compose.linux.yml (mount root filesystem "/" แทน C:\ D:\ ของ Windows)
COMPOSE=(docker compose -f docker-compose.linux.yml)

echo "-- IP ของเครื่องนี้ในวง LAN --"
echo "  ถ้าจะให้เครื่องอื่น (เช่นเครื่องหน้า X-ray, เครื่องอื่นในคลินิก) เปิดเว็บนี้ได้ ต้องกรอก IP ของเครื่องนี้"
echo "  ดู IP ได้จากคำสั่ง ip addr หรือ ifconfig (หา inet address ของวง LAN)"
echo "  ถ้าจะใช้แค่เครื่องนี้เครื่องเดียว กด Enter เว้นว่างไว้ได้ (จะใช้ localhost)"
read -rp "  กรอก IP (เว้นว่าง = localhost): " LAN_IP

if [ -n "$LAN_IP" ]; then
    echo "  ใช้ IP: $LAN_IP"
else
    echo "  ใช้ localhost"
fi

echo "-- เตรียมไฟล์ .env --"

if [ ! -f ".env" ]; then
    cp ".env.example" ".env"
    # PROJECT_HOST_PATH ใน .env.example เป็นแค่ค่าตัวอย่าง ต้องแทนที่ด้วย path จริงที่วางโปรเจกต์นี้ไว้
    # (ใช้แปลง path โฟลเดอร์ worklist default ให้ Orthanc ตอน sync อัตโนมัติ ถ้าไม่ตรงจะ sync ผิดโฟลเดอร์)
    CURRENT_DIR="$(pwd)"
    ESCAPED_DIR=$(printf '%s' "$CURRENT_DIR" | sed -e 's/[\&/]/\\&/g')
    sed -i.bak "s#^PROJECT_HOST_PATH=.*#PROJECT_HOST_PATH=${ESCAPED_DIR}#" ".env" && rm -f ".env.bak"
    echo "  สร้าง .env จาก .env.example แล้ว (ใช้ค่า default, ตั้ง PROJECT_HOST_PATH เป็น $CURRENT_DIR ให้อัตโนมัติ)"
else
    echo "  .env มีอยู่แล้ว ข้าม"
fi

if [ ! -d "orthanc-data" ]; then
    mkdir -p "orthanc-data"
    echo "  สร้างโฟลเดอร์ orthanc-data แล้ว (เก็บข้อมูล Orthanc)"
fi

if [ ! -f "backend/.env" ]; then
    cp "backend/.env.example" "backend/.env"
    if [ -n "$LAN_IP" ]; then
        # ตั้ง CORS_ORIGIN ให้ตรงกับ origin ที่เครื่องอื่นในวง LAN จะเปิดเว็บเข้ามา ไม่งั้น backend จะ block request
        sed -i.bak "s#^CORS_ORIGIN=.*#CORS_ORIGIN=http://${LAN_IP}:3000#" "backend/.env" && rm -f "backend/.env.bak"
    fi
    echo "  สร้าง backend/.env จาก backend/.env.example แล้ว (ใช้ค่า default)"
else
    echo "  backend/.env มีอยู่แล้ว ข้าม"
fi

echo "-- docker compose build --"
if ! "${COMPOSE[@]}" build; then
    echo "ERROR: docker compose build ล้มเหลว ดูข้อความ error ด้านบน"
    exit 1
fi

echo "-- docker compose up -d --"
if ! "${COMPOSE[@]}" up -d; then
    echo "ERROR: docker compose up ล้มเหลว ดูข้อความ error ด้านบน"
    exit 1
fi

echo "-- สถานะ container --"
"${COMPOSE[@]}" ps

echo
echo "เสร็จแล้ว!"
echo "  เปิดเว็บ (เครื่องนี้):         http://localhost:3000"
if [ -n "$LAN_IP" ]; then
    echo "  เปิดเว็บ (เครื่องอื่นในวง LAN): http://${LAN_IP}:3000"
fi
echo "  ไปตั้งค่าฐานข้อมูล HIS ต่อได้ที่หน้า Settings ในเว็บ"
echo "  Orthanc Explorer: http://localhost:8042"
echo "  ดู log backend:  docker compose -f docker-compose.linux.yml logs -f backend"
echo "  ดู log frontend: docker compose -f docker-compose.linux.yml logs -f frontend"
echo "  ดู log orthanc:  docker compose -f docker-compose.linux.yml logs -f orthanc"
echo "  หยุดระบบ:        docker compose -f docker-compose.linux.yml down"
