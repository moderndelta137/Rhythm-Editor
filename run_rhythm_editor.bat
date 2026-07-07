@echo off
setlocal

cd /d "%~dp0"

set "PORT=8000"
set "HTML_FILE=rhythm_editor_canvas_prototype_v15.html"

where python >nul 2>nul
if %errorlevel% neq 0 (
  echo Python was not found on PATH.
  echo Install Python or run this folder with another local HTTP server.
  pause
  exit /b 1
)

echo Starting Rhythm Editor at http://localhost:%PORT%/%HTML_FILE%
echo.
echo Keep this window open while using the editor.
echo Press Ctrl+C here to stop the server.
echo.
echo Note: this launcher uses Python's static server.
echo Editor and Play mode work here, but Publish needs the Cloudflare Pages/Workers API.
echo.

start "" "http://localhost:%PORT%/%HTML_FILE%"
python -m http.server %PORT% --bind 127.0.0.1

endlocal
