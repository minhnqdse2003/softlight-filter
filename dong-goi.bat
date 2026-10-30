@echo off
REM ============================================================================
REM  Tao thu muc _deploy chua DUNG nhung gi can de chay tren may booth.
REM  Mac dinh chep luon node.exe vao _deploy\node\ de khoi tu chua hoan toan,
REM  khong phu thuoc may dich co cai Node.js hay khong.
REM  Muon goi nhe (khong kem Node): dong-goi.bat /khong-kem-node
REM ============================================================================
setlocal
cd /d "%~dp0"

if not exist "softlight.exe"  ( echo [LOI] Chua co softlight.exe. Chay build-exe.bat truoc. & exit /b 1 )
if not exist "instax.exe"     ( echo [LOI] Chua co instax.exe. Chay build-exe.bat truoc.    & exit /b 1 )
if not exist "snow.exe"       ( echo [LOI] Chua co snow.exe. Chay build-exe.bat truoc.      & exit /b 1 )
if not exist "node_modules"   ( echo [LOI] Chua co node_modules. Chay 'npm install' truoc.   & exit /b 1 )
if not exist "models\modnet.onnx" ( echo [LOI] Chua co models\modnet.onnx ^(tach nguoi cho bo loc Tuyet^). Chay 'npm run model' truoc. & exit /b 1 )

if exist "_deploy" rmdir /s /q "_deploy"
mkdir "_deploy"

REM  CA HAI bo loc phai co mat: script nay van kiem tra instax.exe o tren
REM  va van bao operator tro dslrBooth toi no o duoi, nhung truoc day chi
REM  chep softlight sang _deploy - goi giao di khong he co bo loc Instax.
for %%F in (softlight.exe softlight.config.json instax.exe instax.config.json snow.exe snow.config.json kiem-tra.bat tach-nguoi.bat package.json README.md) do copy /y "%%F" "_deploy\" >nul
xcopy /e /i /q /y "src"          "_deploy\src"          >nul
xcopy /e /i /q /y "web"          "_deploy\web"          >nul
xcopy /e /i /q /y "models"       "_deploy\models"       >nul
xcopy /e /i /q /y "node_modules" "_deploy\node_modules" >nul

REM onnxruntime-node mang binary cho moi he dieu hanh (~290 MB). May booth chi
REM can win32\x64 (~64 MB) - bo phan con lai cho goi nhe.
for /d %%D in ("_deploy\node_modules\onnxruntime-node\bin\napi-v*") do (
  if exist "%%D\darwin"      rmdir /s /q "%%D\darwin"
  if exist "%%D\linux"       rmdir /s /q "%%D\linux"
  if exist "%%D\win32\arm64" rmdir /s /q "%%D\win32\arm64"
)

if /I "%~1"=="/khong-kem-node" goto done

REM Chep node.exe dang chay tren may nay vao goi.
for /f "delims=" %%N in ('where node 2^>nul') do set "NODEEXE=%%N" & goto found
echo [CANH BAO] Khong tim thay node.exe de kem theo goi.
echo            May booth se PHAI tu cai Node.js.
goto done

:found
mkdir "_deploy\node"
copy /y "%NODEEXE%" "_deploy\node\node.exe" >nul
echo   Da kem node.exe -^> goi tu chua, may booth khong can cai gi.

:done
echo.
echo   Xong. Cach dung:
echo     1. Zip thu muc _deploy
echo     2. Giai nen sang may booth - TRANH C:\Program Files (can quyen ghi)
echo     3. Tren may booth: bam dup kiem-tra.bat de xac nhan
echo     4. Tro dslrBooth Post-Processing toi MOT trong ba file:
echo          softlight.exe  - lam mem da
echo          instax.exe     - chat phim lay lien
echo          snow.exe       - tuyet nhieu lop do sau
echo     5. Chinh tham so: mo web\index.html
echo.
