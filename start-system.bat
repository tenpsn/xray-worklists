@echo off
cd /d "D:\xray-worklists"
call .\node_modules\.bin\pm2 start ecosystem.config.js