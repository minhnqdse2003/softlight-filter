@echo off
REM Bam dup file nay tren may booth de kiem tra moi thu da san sang chua.
cd /d "%~dp0"

set "NODE=node"
if exist "%~dp0node-path.txt" set /p NODE=<"%~dp0node-path.txt"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"

"%NODE%" --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [LOI] Khong chay duoc Node.js.
  echo.
  echo   File softlight.exe chi la cau noi 6KB, no CAN Node.js de chay.
  echo   Chon mot trong hai cach:
  echo     - Cai Node.js 18+ tu https://nodejs.org
  echo     - Hoac chep node.exe vao thu muc con "node\" canh file exe
  echo.
  pause
  exit /b 1
)

"%NODE%" "%~dp0src\cli.js" --doctor
echo.
pause
