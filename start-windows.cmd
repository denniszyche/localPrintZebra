@echo off
setlocal

cd /d "%~dp0"

if not exist logs mkdir logs

echo [%date% %time%] Starting localPrintZebra >> logs\service.log
call npm start >> logs\service.log 2>&1

set exit_code=%ERRORLEVEL%
echo [%date% %time%] localPrintZebra stopped with exit code %exit_code% >> logs\service.log
exit /b %exit_code%