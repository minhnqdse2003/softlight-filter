@echo off
REM ============================================================================
REM  Keo tha mot (hoac nhieu) anh vao file nay -> ghi ra <anh>.SO-SANH.jpg canh
REM  anh: trai = goc, phai = qua snow.exe (retouch da + tuyet + mau) theo dung
REM  snow.config.json canh file nay. Anh goc KHONG bi ghi de.
REM  Dung de xem retouch da - trang chinh web khong xem truoc duoc buoc nay.
REM ============================================================================
cd /d "%~dp0"

set "NODE=node"
if exist "%~dp0node-path.txt" set /p NODE=<"%~dp0node-path.txt"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"

if "%~1"=="" (
  echo Keo tha anh vao file nay de xem thu snow.exe.
  pause
  exit /b 0
)

for %%F in (%*) do "%NODE%" "%~dp0src\cli.js" --filter snow --preview "%%~fF"
echo.
pause
