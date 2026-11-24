@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Тест GigaCowork ===
where node >nul 2>nul || (echo Не установлен Node.js. Установите LTS-версию с https://nodejs.org и запустите снова. & start https://nodejs.org & pause & exit /b 1)
if not exist node_modules\playwright (
  echo Первый запуск: устанавливаю нужные компоненты...
  call npm run setup || (echo Установка не удалась. & pause & exit /b 1)
)
if not exist "%USERPROFILE%\.skill-craft\storage-state.json" (
  echo Нет входа на стенд. Откроется браузер: войдите в GigaCowork, затем вернитесь сюда и нажмите Enter.
  node cowork.mjs login --stand https://demo.cowork.ru
)
if not exist "%USERPROFILE%\.skill-craft\yadisk-token" (
  if not exist "%USERPROFILE%\.skill-craft" mkdir "%USERPROFILE%\.skill-craft"
  set /p T=Вставьте токен Яндекс Диска и нажмите Enter: 
  call echo %%T%%> "%USERPROFILE%\.skill-craft\yadisk-token"
)
echo.
echo Выберите папку теста на Яндекс Диске и пространство. Не закрывайте окно, пока идёт тест (до 2 часов).
echo.
powershell -NoProfile -Command "$p=[Diagnostics.Process]::GetCurrentProcess(); Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint e);'; [W.P]::SetThreadExecutionState(0x80000001) | Out-Null; node yadisk-test.mjs | Tee-Object -Variable out; $m=[regex]::Match(($out -join \"`n\"), '\"web\":\"([^\"]+)\"'); if ($m.Success) { Start-Process $m.Groups[1].Value } else { Write-Host 'Тест завершился с ошибкой. Сделайте снимок окна и отправьте тому, кто настраивал раннер.' }"
pause
