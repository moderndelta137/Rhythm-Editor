@echo off
setlocal

cd /d "%~dp0"

set "PORT=8016"
set "URL=http://127.0.0.1:%PORT%/iphone_16_pro_max_simulator.html"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found on PATH.
  echo Install Python, then run this launcher again.
  pause
  exit /b 1
)

set "BROWSER="
if exist "%EDGE%" set "BROWSER=%EDGE%"
if not defined BROWSER if exist "%CHROME%" set "BROWSER=%CHROME%"

if not defined BROWSER (
  echo Microsoft Edge or Google Chrome was not found.
  pause
  exit /b 1
)

echo Starting the local Rhythm Studio server on port %PORT%...
start "Rhythm Studio mobile server" /min cmd /c "cd /d ""%~dp0"" && python -m http.server %PORT% --bind 127.0.0.1"

timeout /t 2 /nobreak >nul

echo Opening an iPhone 16 Pro Max simulator: 440 x 956 CSS pixels.
start "" "%BROWSER%" --app="%URL%" --window-size=520,1040 --window-position=40,20 --force-device-scale-factor=1 --user-data-dir="%TEMP%\rhythm-editor-iphone16pm"

echo.
echo Close this window when finished. The local server window can be closed separately.
timeout /t 3 /nobreak >nul

endlocal
