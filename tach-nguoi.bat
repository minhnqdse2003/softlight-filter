@echo off
REM ============================================================================
REM  Keo tha mot (hoac nhieu) anh vao file nay -> ghi ra <anh>.MATTE.png canh anh.
REM  Mo web\snow-tuner.html, mo anh do, tab Nguoi -> "Nap matte" de xem truoc
REM  tuyet bi nguoi che DUNG nhu snow.exe se lam tren booth.
REM ============================================================================
cd /d "%~dp0"

set "NODE=node"
if exist "%~dp0node-path.txt" set /p NODE=<"%~dp0node-path.txt"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"

if "%~1"=="" (
  echo Keo tha anh vao file nay de tach nguoi.
  pause
  exit /b 0
)

for %%F in (%*) do "%NODE%" "%~dp0src\cli.js" --filter snow --matte "%%~fF"
echo.
pause
