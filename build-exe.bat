@echo off
REM Bien dich softlight.exe bang trinh bien dich C# di kem Windows.
REM Khong can cai dat gi them - csc.exe la mot phan cua .NET Framework 4,
REM co san tren moi ban Windows tu Vista tro di.

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo Khong tim thay csc.exe. Can .NET Framework 4.
  exit /b 1
)

REM /target:winexe = khong co cua so console nhay len moi lan chup.
"%CSC%" /nologo /target:winexe /optimize+ /out:"%~dp0softlight.exe" "%~dp0tools\Launcher.cs"
if errorlevel 1 exit /b 1

echo Da tao: %~dp0softlight.exe
