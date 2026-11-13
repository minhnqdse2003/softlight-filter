@echo off
REM ============================================================================
REM  Tao thu muc _deploy chua DUNG nhung gi can de chay tren may booth.
REM  Mac dinh chep luon node.exe vao _deploy\node\ de khoi tu chua hoan toan,
REM  khong phu thuoc may dich co cai Node.js hay khong.
REM
REM    dong-goi.bat                  ca ba bo loc (softlight, instax, snow)
REM    dong-goi.bat /chi-tuyet       chi bo loc Tuyet - may booth chi chay snow.exe
REM    dong-goi.bat /kem-birefnet    kem model BiRefNet (~190 MB) cho subject.model = birefnet
REM    dong-goi.bat /khong-kem-node  goi nhe, may booth tu cai Node.js
REM  Cac tham so ghep duoc voi nhau, thu tu nao cung duoc.
REM ============================================================================
setlocal
cd /d "%~dp0"

set "CHI_TUYET="
set "KEM_BIREFNET="
set "KEM_NODE=1"
:doc_tham_so
if "%~1"=="" goto het_tham_so
if /I "%~1"=="/chi-tuyet"      set "CHI_TUYET=1"
if /I "%~1"=="/kem-birefnet"   set "KEM_BIREFNET=1"
if /I "%~1"=="/khong-kem-node" set "KEM_NODE="
shift
goto doc_tham_so
:het_tham_so

if not defined CHI_TUYET (
  if not exist "softlight.exe"  ( echo [LOI] Chua co softlight.exe. Chay build-exe.bat truoc. & exit /b 1 )
  if not exist "instax.exe"     ( echo [LOI] Chua co instax.exe. Chay build-exe.bat truoc.    & exit /b 1 )
)
if not exist "snow.exe"       ( echo [LOI] Chua co snow.exe. Chay build-exe.bat truoc.      & exit /b 1 )
if not exist "node_modules"   ( echo [LOI] Chua co node_modules. Chay 'npm install' truoc.   & exit /b 1 )
if not exist "models\modnet.onnx" ( echo [LOI] Chua co models\modnet.onnx ^(tach nguoi cho bo loc Tuyet^). Chay 'npm run model' truoc. & exit /b 1 )
if defined KEM_BIREFNET if not exist "models\birefnet-lite-512.onnx" ( echo [LOI] Chua co models\birefnet-lite-512.onnx. Chay 'npm run model -- birefnet' truoc. & exit /b 1 )

if exist "_deploy" rmdir /s /q "_deploy"
mkdir "_deploy"

REM  Goi day du: CA BA bo loc phai co mat - truoc day script kiem tra instax.exe
REM  va bao operator tro dslrBooth toi no, nhung chi chep softlight sang _deploy.
REM  Goi /chi-tuyet: src van chep NGUYEN (cli.js nap ca registry), chi bo exe va
REM  cau hinh cua hai bo loc kia de khong ai tro nham dslrBooth vao chung.
REM  instaxlight / instaxblue: mau preset Light / Blue cua may Instax (dslrBooth
REM  Post-Processing, FilmongBooth tu tro event vao) - di cung instax.exe.
set "FILES=softlight.exe softlight.config.json instax.exe instax.config.json instaxlight.exe instaxlight.config.json instaxblue.exe instaxblue.config.json snow.exe snow.config.json"
if defined CHI_TUYET set "FILES=snow.exe snow.config.json"
for %%F in (%FILES% kiem-tra.bat tach-nguoi.bat xem-thu.bat package.json README.md) do copy /y "%%F" "_deploy\" >nul
xcopy /e /i /q /y "src"          "_deploy\src"          >nul
xcopy /e /i /q /y "web"          "_deploy\web"          >nul
xcopy /e /i /q /y "node_modules" "_deploy\node_modules" >nul
if defined CHI_TUYET copy /y "tools\huong-dan-tuyet.txt" "_deploy\HUONG-DAN.txt" >nul

REM  Model tach nguoi: MODNet luon co. BiRefNet (~190 MB) chi khi xin - thieu no
REM  thi pipeline tu lui ve MODNet, khong hong anh.
mkdir "_deploy\models"
copy /y "models\modnet.onnx" "_deploy\models\" >nul
if defined KEM_BIREFNET copy /y "models\birefnet-lite-512.onnx" "_deploy\models\" >nul

REM  Model xoa mun cua Capture One (retouch da cua snow.exe, ~33 MB) - KHONG nam
REM  trong git, chep tay vao models\mun. Thieu thi snow.exe tu dung bo nhat mun
REM  tu viet. KHONG chep may.json: ket qua do CPU / GPU cua may NAY, may booth
REM  tu do lai lan dau (kiem-tra.bat).
set "KEM_MUN="
if exist "models\mun\skinMasking.onnx" if exist "models\mun\blemishRemoval_dynamic.onnx" set "KEM_MUN=1"
if defined KEM_MUN (
  mkdir "_deploy\models\mun"
  copy /y "models\mun\*.onnx" "_deploy\models\mun\" >nul
  echo   Da kem model xoa mun Capture One.
) else (
  echo [CANH BAO] Khong co models\mun - retouch da se nhat mun bang bo tu viet.
)

REM  Luoi mat 478 diem (MediaPipe Face Mesh V2, ~5 MB) cho buoc to sang / toi
REM  (retouch.dodgeBurn). Tai bang: npm run model -- facemesh. Thieu thi buoc do
REM  tu bo qua, anh van ra.
if exist "models\facemesh-v2.onnx" (
  copy /y "models\facemesh-v2.onnx" "_deploy\models\" >nul
  echo   Da kem model luoi mat ^(to sang / toi^).
) else (
  echo [CANH BAO] Khong co models\facemesh-v2.onnx - buoc to sang / toi se bo qua. Chay 'npm run model -- facemesh'.
)

REM onnxruntime-node mang binary cho moi he dieu hanh (~290 MB). May booth chi
REM can win32\x64 (~64 MB) - bo phan con lai cho goi nhe.
for /d %%D in ("_deploy\node_modules\onnxruntime-node\bin\napi-v*") do (
  if exist "%%D\darwin"      rmdir /s /q "%%D\darwin"
  if exist "%%D\linux"       rmdir /s /q "%%D\linux"
  if exist "%%D\win32\arm64" rmdir /s /q "%%D\win32\arm64"
)

if not defined KEM_NODE goto done

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
if defined CHI_TUYET (
  echo     4. Tro dslrBooth Post-Processing toi snow.exe
  echo     5. Chinh tham so: mo web\snow-tuner.html, Luu, dat snow.config.json canh snow.exe
) else (
  echo     4. Tro dslrBooth Post-Processing toi MOT trong ba file:
  echo          softlight.exe  - lam mem da
  echo          instax.exe     - chat phim lay lien
  echo          snow.exe       - tuyet nhieu lop do sau
  echo     5. Chinh tham so: mo web\index.html
)
echo.
