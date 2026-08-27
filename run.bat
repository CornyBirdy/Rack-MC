@echo off
rem MC Hoster launcher - a single foreground process, safe for Rack.
rem Under Rack the port arrives as RACK_PORT (and as MC_PORT via portEnv);
rem standalone it falls back to 8100 and opens your browser.
cd /d "%~dp0"
if not "%RACK_PORT%"=="" set "MC_PORT=%RACK_PORT%"
if "%MC_PORT%"=="" set "MC_PORT=8100"
node "%~dp0server.js" %*
