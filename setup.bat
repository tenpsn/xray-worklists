@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem ติดตั้ง xray-worklists บนเครื่องใหม่แบบรันทีเดียวจบ (Windows)
rem ใช้งาน: setup.bat        (ปกติ หยุดรอให้แก้ env ก่อน)
rem         setup.bat -y     (ข้ามขั้นตอนหยุดรอ)

set SKIP_PAUSE=0
if /i "%~1"=="-y" set SKIP_PAUSE=1

cd /d "%~dp0"

echo == xray-worklists setup ==

where docker >nul 2>nul
if errorlevel 1 (
    echo ERROR: ไม่พบ docker ติดตั้ง/เปิด Docker Desktop ก่อนนะครับ
    exit /b 1
)

docker compose version >nul 2>nul
if errorlevel 1 (
    echo ERROR: ไม่พบ "docker compose" ต้องใช้ Docker Compose v2
    exit /b 1
)

echo -- เตรียมไฟล์ .env --

if not exist ".env" (
    copy /y ".env.example" ".env" >nul
    echo   สร้าง .env จาก .env.example แล้ว - ควรเปิดแก้ค่าให้ตรงกับเครื่องนี้
) else (
    echo   .env มีอยู่แล้ว ข้าม
)

if not exist "backend\.env" (
    copy /y "backend\.env.example" "backend\.env" >nul
    echo   สร้าง backend\.env จาก backend\.env.example แล้ว - ควรเปิดแก้ค่าให้ตรงกับเครื่องนี้
) else (
    echo   backend\.env มีอยู่แล้ว ข้าม
)

if "%SKIP_PAUSE%"=="0" (
    echo.
    echo ---------------------------------------------------------------
    echo ก่อนไปต่อ กรุณาตรวจสอบไฟล์ env ต่อไปนี้ให้ตรงกับเครื่องนี้:
    echo   - backend\.env   ^(PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD^)
    echo   - .env           ^(NEXT_PUBLIC_API_URL^)
    echo.
    echo หมายเหตุ: ถ้าฐานข้อมูล HIS อยู่เครื่องเดียวกับที่รัน Docker
    echo ให้ใช้ host.docker.internal แทน localhost ใน backend\.env
    echo ---------------------------------------------------------------
    echo.
    pause
)

echo -- docker compose build --
docker compose build
if errorlevel 1 exit /b 1

echo -- docker compose up -d --
docker compose up -d
if errorlevel 1 exit /b 1

echo -- สถานะ container --
docker compose ps

echo.
echo เสร็จแล้ว!
echo   ดู log backend:  docker compose logs -f backend
echo   ดู log frontend: docker compose logs -f frontend
echo   หยุดระบบ:        docker compose down

endlocal
