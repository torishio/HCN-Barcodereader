@echo off
cd /d "%~dp0"

if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

echo Starting barcode API server...
node index.js

pause
