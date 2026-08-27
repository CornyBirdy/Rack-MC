@echo off
rem ---------------------------------------------------------------------------
rem MC Hoster - one-time setup. Run this by hand once; Rack never runs it.
rem There is nothing to build or install: the panel is zero-dependency Node.
rem This just checks the machine and reports what's there.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
echo === MC Hoster setup ===
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js was not found on PATH.
  echo     Install Node 18 or newer from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo [ok] Node %%v

if not exist "data\servers" mkdir "data\servers"
echo [ok] data\servers ready ^(worlds, jars and downloaded runtimes live here^)
echo.

echo Scanning for Java runtimes...
node -e "require('./lib/java').discover(true).then(r=>{if(!r.javas.length){console.log('  none found - MC Hoster will download the right Eclipse Temurin JRE the first time you start a server.');}else{for(const j of r.javas)console.log('  Java '+j.major+'  '+j.version+'  '+j.path);}}).catch(e=>console.log('  scan failed: '+e.message))"
if errorlevel 1 (
  echo [X] Node could not run the panel's own code. Check the error above.
  echo.
  pause
  exit /b 1
)

echo.
echo Setup complete.
echo   - In Rack: + Add app, point at this folder, Save.
echo   - Standalone: double-click run.bat.
echo.
pause
endlocal
