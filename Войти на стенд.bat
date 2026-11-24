@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules\playwright call npm run setup
echo Откроется браузер: войдите в GigaCowork, затем вернитесь сюда и нажмите Enter.
node cowork.mjs login --stand https://demo.cowork.ru
pause
