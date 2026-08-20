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

echo -- IP ของเครื่องนี้ในวง LAN --
echo   ถ้าจะให้เครื่องอื่น ^(เช่นเครื่องหน้า X-ray, เครื่องอื่นในคลินิก^) เปิดเว็บนี้ได้ ต้องกรอก IP ของเครื่องนี้
echo   ดู IP ได้จากคำสั่ง ipconfig ^(หา IPv4 Address^)
echo   ถ้าจะใช้แค่เครื่องนี้เครื่องเดียว กด Enter เว้นว่างไว้ได้ ^(จะใช้ localhost^)
set /p "LAN_IP=  กรอก IP (เว้นว่าง = localhost): "

if defined LAN_IP (
    echo   ใช้ IP: %LAN_IP%
) else (
    echo   ใช้ localhost
)

echo -- เตรียมไฟล์ .env --

if not exist ".env" (
    copy /y ".env.example" ".env" >nul
    rem PROJECT_HOST_PATH ใน .env.example เป็นแค่ค่าตัวอย่าง ต้องแทนที่ด้วย path จริงที่วางโปรเจกต์นี้ไว้
    rem (ใช้แปลง path โฟลเดอร์ worklist default ให้ Orthanc ตอน sync อัตโนมัติ ถ้าไม่ตรงจะ sync ผิดโฟลเดอร์)
    powershell -NoProfile -Command "(Get-Content '.env') -replace 'PROJECT_HOST_PATH=.*', 'PROJECT_HOST_PATH=%CD%' | Set-Content '.env'"
    echo   สร้าง .env จาก .env.example แล้ว ^(ใช้ค่า default, ตั้ง PROJECT_HOST_PATH เป็น %CD% ให้อัตโนมัติ^)
) else (
    echo   .env มีอยู่แล้ว ข้าม
)

if not exist "orthanc-data" (
    mkdir "orthanc-data"
    echo   สร้างโฟลเดอร์ orthanc-data แล้ว ^(เก็บข้อมูล Orthanc^)
)

if not exist "backend\.env" (
    copy /y "backend\.env.example" "backend\.env" >nul
    if defined LAN_IP (
        rem ตั้ง CORS_ORIGIN ให้ตรงกับ origin ที่เครื่องอื่นในวง LAN จะเปิดเว็บเข้ามา ไม่งั้น backend จะ block request
        powershell -NoProfile -Command "(Get-Content 'backend\.env') -replace 'CORS_ORIGIN=.*', 'CORS_ORIGIN=http://%LAN_IP%:3000' | Set-Content 'backend\.env'"
    )
    echo   สร้าง backend\.env จาก backend\.env.example แล้ว ^(ใช้ค่า default^)
) else (
    echo   backend\.env มีอยู่แล้ว ข้าม
)

rem ใช้ docker-compose.windows.yml (mount ไดรฟ์ C:\ D:\ แบบ Windows แทน root filesystem ของ Linux)
set COMPOSE=docker compose -f docker-compose.windows.yml

echo -- docker compose build --
%COMPOSE% build
if errorlevel 1 (
    echo ERROR: docker compose build ล้มเหลว ดูข้อความ error ด้านบน
    pause
    exit /b 1
)

echo -- docker compose up -d --
%COMPOSE% up -d
if errorlevel 1 (
    echo ERROR: docker compose up ล้มเหลว ดูข้อความ error ด้านบน
    pause
    exit /b 1
)

echo -- สถานะ container --
%COMPOSE% ps

echo.
echo เสร็จแล้ว!
echo   เปิดเว็บ ^(เครื่องนี้^):         http://localhost:3000
if defined LAN_IP echo   เปิดเว็บ ^(เครื่องอื่นในวง LAN^): http://%LAN_IP%:3000
echo   ไปตั้งค่าฐานข้อมูล HIS ต่อได้ที่หน้า Settings ในเว็บ
echo   Orthanc Explorer: http://localhost:8042
echo   ดู log backend:  docker compose -f docker-compose.windows.yml logs -f backend
echo   ดู log frontend: docker compose -f docker-compose.windows.yml logs -f frontend
echo   ดู log orthanc:  docker compose -f docker-compose.windows.yml logs -f orthanc
echo   หยุดระบบ:        docker compose -f docker-compose.windows.yml down

pause
endlocal
