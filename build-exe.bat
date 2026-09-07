@echo off
REM ============================================================================
REM  Bien dich cau noi cho TUNG bo loc bang trinh bien dich C# di kem Windows.
REM  Khong can cai dat gi them - csc.exe la mot phan cua .NET Framework 4,
REM  co san tren moi ban Windows tu Vista tro di.
REM
REM  Mot nguon (tools\Launcher.cs) -> nhieu exe. Moi exe tu doc TEN FILE cua no
REM  de biet phai chay bo loc nao, nen them mot bo loc moi = them mot dong
REM  "call :build <id>" o duoi, khong phai sua Launcher.cs.
REM ============================================================================

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo Khong tim thay csc.exe. Can .NET Framework 4.
  exit /b 1
)

call :build softlight || exit /b 1
call :build instax    || exit /b 1
exit /b 0

:build
REM /target:winexe = khong co cua so console nhay len moi lan chup.
"%CSC%" /nologo /target:winexe /optimize+ /out:"%~dp0%~1.exe" "%~dp0tools\Launcher.cs"
if errorlevel 1 exit /b 1
echo Da tao: %~dp0%~1.exe
exit /b 0
