@echo off
title Cloudflare Tunnel - AI Edit Video
setlocal EnableExtensions
cd /d "%~dp0.."
rem cloudflared doctor tai rieng nam o .runtime\bin (start\bin la cho cu)
set "PATH=%CD%\.runtime\bin;%CD%\start\bin;%PATH%"

rem 1. Kiem tra da cai cloudflared chua
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [LOI] Chua cai cloudflared.
  echo   Cai bang:  winget install --id Cloudflare.cloudflared
  echo   Hoac tai:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  echo.
  pause
  exit /b 1
)

rem 2. Doc TUNNEL_DOMAIN tu .env (neu co)
set "TUNNEL_DOMAIN="
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="TUNNEL_DOMAIN" set "TUNNEL_DOMAIN=%%b"
  )
)
rem Bo protocol / khoang trang neu user lo dan kem
if defined TUNNEL_DOMAIN set "TUNNEL_DOMAIN=%TUNNEL_DOMAIN:https://=%"
if defined TUNNEL_DOMAIN set "TUNNEL_DOMAIN=%TUNNEL_DOMAIN:http://=%"
if defined TUNNEL_DOMAIN set "TUNNEL_DOMAIN=%TUNNEL_DOMAIN: =%"

if not defined TUNNEL_DOMAIN goto quick

rem 3a. Co domain -> chay named tunnel (ten tunnel = nhan dau tien cua domain)
for /f "delims=." %%a in ("%TUNNEL_DOMAIN%") do set "TUNNEL_NAME=%%a"
echo.
echo   Chay tunnel cho domain %TUNNEL_DOMAIN% (ten tunnel: %TUNNEL_NAME%)
echo   Neu lenh ben duoi bao loi (chua login / chua tao tunnel / chua route DNS),
echo   chay 1 lan cac buoc sau roi mo lai script nay:
echo     cloudflared tunnel login
echo     cloudflared tunnel create %TUNNEL_NAME%
echo     cloudflared tunnel route dns %TUNNEL_NAME% %TUNNEL_DOMAIN%
echo.
cloudflared tunnel run --url http://localhost:6868 %TUNNEL_NAME%
pause
exit /b

:quick
rem 3b. Chua co TUNNEL_DOMAIN -> Quick Tunnel (URL ngau nhien *.trycloudflare.com)
echo.
echo   Chua dien TUNNEL_DOMAIN trong .env -^> chay Quick Tunnel (URL ngau nhien).
echo   [CANH BAO] URL nay public tren Internet va dashboard CHUA co dang nhap -
echo   chi dung tam thoi, dung chia se link. Muon dung domain rieng + QR tu dong:
echo   dien TUNNEL_DOMAIN vao .env roi chay lai script nay.
echo.
cloudflared tunnel --url http://localhost:6868
pause
