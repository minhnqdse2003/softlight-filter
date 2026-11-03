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
  echo   File softlight.exe / instax.exe / snow.exe chi la cau noi 6KB, no CAN Node.js de chay.
  echo   Chon mot trong hai cach:
  echo     - Cai Node.js 18+ tu https://nodejs.org
  echo     - Hoac chep node.exe vao thu muc con "node\" canh file exe
  echo.
  pause
  exit /b 1
)

REM Kiem tung bo loc mot: moi bo co file exe va file cau hinh rieng. Chi kiem
REM bo loc co exe trong thu muc nay - goi /chi-tuyet khong co softlight, instax.
for %%F in (softlight instax snow) do if exist "%~dp0%%F.exe" "%NODE%" "%~dp0src\cli.js" --filter %%F --doctor
echo.
pause
