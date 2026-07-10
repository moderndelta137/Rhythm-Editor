@echo off
setlocal

cd /d "%~dp0"

set "PROJECT_NAME=rhythm-studio"
set "BRANCH=main"
set "SOURCE_HTML=rhythm_studio.html"
set "DEPLOY_DIR=%TEMP%\rhythm-studio-pages-deploy"
set "NPM_CONFIG_CACHE=%CD%\.npm-cache"

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo Node.js was not found on PATH.
  echo Install Node.js before deploying to Cloudflare Pages.
  pause
  exit /b 1
)

if not exist "%SOURCE_HTML%" (
  echo Could not find %SOURCE_HTML%.
  pause
  exit /b 1
)

if not exist "_redirects" (
  echo Could not find _redirects.
  pause
  exit /b 1
)

if not exist "functions" (
  echo Could not find functions folder.
  pause
  exit /b 1
)

if not exist "wrangler.toml" (
  echo Could not find wrangler.toml.
  pause
  exit /b 1
)

echo Checking Cloudflare login...
call npx.cmd --yes wrangler whoami
if %errorlevel% neq 0 (
  echo.
  echo Cloudflare login is required. Run:
  echo npx.cmd wrangler login
  pause
  exit /b 1
)

echo.
echo Checking Pages project %PROJECT_NAME%...
call npx.cmd --yes wrangler pages project list | findstr /I /C:"%PROJECT_NAME%" >nul
if %errorlevel% neq 0 (
  echo Creating Pages project %PROJECT_NAME%...
  call npx.cmd --yes wrangler pages project create %PROJECT_NAME% --production-branch %BRANCH%
  if %errorlevel% neq 0 (
    echo.
    echo Could not create Pages project %PROJECT_NAME%.
    echo If it already exists in Cloudflare, continue by deploying manually:
    echo npx.cmd --yes wrangler pages deploy "." --project-name %PROJECT_NAME% --branch %BRANCH%
    pause
    exit /b 1
  )
) else (
  echo Pages project %PROJECT_NAME% already exists.
)

echo.
echo Preparing clean Pages deploy folder...
if exist "%DEPLOY_DIR%" rmdir /s /q "%DEPLOY_DIR%"
mkdir "%DEPLOY_DIR%"

copy /y "%SOURCE_HTML%" "%DEPLOY_DIR%\index.html" >nul
copy /y "_redirects" "%DEPLOY_DIR%\_redirects" >nul
copy /y "wrangler.toml" "%DEPLOY_DIR%\wrangler.toml" >nul
if exist "schema.sql" copy /y "schema.sql" "%DEPLOY_DIR%\schema.sql" >nul
xcopy /e /i /y "functions" "%DEPLOY_DIR%\functions" >nul
if exist "SE" xcopy /e /i /y "SE" "%DEPLOY_DIR%\SE" >nul

echo.
echo Deploying %PROJECT_NAME% to Cloudflare Pages...
pushd "%DEPLOY_DIR%"
call npx.cmd --yes wrangler pages deploy "." --project-name %PROJECT_NAME% --branch %BRANCH% --commit-dirty=true --commit-message "Update Rhythm Studio"
set "DEPLOY_ERROR=%errorlevel%"
popd
if %DEPLOY_ERROR% neq 0 (
  echo.
  echo Deployment failed.
  pause
  exit /b 1
)

echo.
echo Deployment complete:
echo https://%PROJECT_NAME%.pages.dev/
pause

endlocal
