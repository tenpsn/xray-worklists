@echo off
chcp 65001 >nul
setlocal

rem ติดตั้ง xray-worklists บนเครื่องใหม่แบบรันทีเดียวจบ (Windows)
rem ใช้งาน: setup.bat        (รันอัตโนมัติทั้งหมด ไม่ต้องแก้ env ก่อน)
rem
rem หมายเหตุ: การเชื่อมต่อฐานข้อมูล HIS (PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD)
rem ไม่ต้องตั้งในไฟล์ env แล้ว ให้ไปตั้งค่าในหน้าเว็บ Settings หลังระบบรันขึ้นแทน

cd /d "%~dp0"

echo == xray-worklists setup ==

where docker >nul 2>nul
if errorlevel 1 (
    echo ไม่พบ Docker กำลังเปิดหน้าดาวน์โหลด Docker Desktop ให้...
    start https://www.docker.com/products/docker-desktop/
    echo ติดตั้ง Docker Desktop ให้เสร็จ ^(อาจต้อง restart เครื่อง^) แล้วรัน setup.bat นี้ใหม่อีกครั้ง
    pause
    exit /b 1
)

docker compose version >nul 2>nul
if errorlevel 1 (
    echo ERROR: ไม่พบ "docker compose" ต้องใช้ Docker Compose v2
    pause
    exit /b 1
)

echo -- เตรียมไฟล์ .env --

if not exist ".env" (
    copy /y ".env.example" ".env" >nul
    echo   สร้าง .env จาก .env.example แล้ว ^(ใช้ค่า default^)
) else (
    echo   .env มีอยู่แล้ว ข้าม
)

if not exist "backend\.env" (
    copy /y "backend\.env.example" "backend\.env" >nul
    echo   สร้าง backend\.env จาก backend\.env.example แล้ว ^(ใช้ค่า default^)
) else (
    echo   backend\.env มีอยู่แล้ว ข้าม
)

echo -- docker compose build --
docker compose build
if errorlevel 1 (
    echo ERROR: docker compose build ล้มเหลว ดูข้อความ error ด้านบน
    pause
    exit /b 1
)

echo -- docker compose up -d --
docker compose up -d
if errorlevel 1 (
    echo ERROR: docker compose up ล้มเหลว ดูข้อความ error ด้านบน
    pause
    exit /b 1
)

echo -- สถานะ container --
docker compose ps

echo.
echo เสร็จแล้ว!
echo   เปิดเว็บ:        http://localhost:3000
echo   ไปตั้งค่าฐานข้อมูล HIS ต่อได้ที่หน้า Settings ในเว็บ
echo   ดู log backend:  docker compose logs -f backend
echo   ดู log frontend: docker compose logs -f frontend
echo   หยุดระบบ:        docker compose down

pause
endlocal
