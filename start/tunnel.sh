#!/usr/bin/env bash
# Cloudflare Tunnel cho AI Edit Video - mở đường Internet về http://localhost:6868
# Có TUNNEL_DOMAIN trong .env → chạy named tunnel; chưa có → Quick Tunnel (URL ngẫu nhiên).
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# doctor.mjs tải cloudflared về .runtime/bin khi máy Mac không có brew (start/bin
# là chỗ cũ) - chỉ tìm trên PATH là báo "chưa cài" ngay sau khi vừa cài xong
export PATH="$ROOT/.runtime/bin:$ROOT/start/bin:$PATH"

# 1. Kiểm tra đã cài cloudflared chưa
if ! command -v cloudflared >/dev/null 2>&1; then
  printf '  \033[31m[LOI] Chưa cài cloudflared.\033[0m\n'
  echo "  macOS:    brew install cloudflared"
  echo "  Hoặc tải: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

# 2. Đọc TUNNEL_DOMAIN từ .env (nếu có), bỏ protocol/path nếu user lỡ dán kèm
TUNNEL_DOMAIN=""
if [ -f "$ROOT/.env" ]; then
  TUNNEL_DOMAIN="$(grep -E '^[[:space:]]*TUNNEL_DOMAIN=' "$ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '[:space:]"')"
fi
TUNNEL_DOMAIN="${TUNNEL_DOMAIN#https://}"
TUNNEL_DOMAIN="${TUNNEL_DOMAIN#http://}"
TUNNEL_DOMAIN="${TUNNEL_DOMAIN%%/*}"

if [ -n "$TUNNEL_DOMAIN" ]; then
  # 3a. Có domain → chạy named tunnel (tên tunnel = nhãn đầu tiên của domain)
  TUNNEL_NAME="${TUNNEL_DOMAIN%%.*}"
  echo "  Chạy tunnel cho domain $TUNNEL_DOMAIN (tên tunnel: $TUNNEL_NAME)"
  echo "  Nếu lệnh bên dưới báo lỗi (chưa login / chưa tạo tunnel / chưa route DNS),"
  echo "  chạy 1 lần các bước sau rồi mở lại script này:"
  echo "    cloudflared tunnel login"
  echo "    cloudflared tunnel create $TUNNEL_NAME"
  echo "    cloudflared tunnel route dns $TUNNEL_NAME $TUNNEL_DOMAIN"
  echo ""
  exec cloudflared tunnel run --url http://localhost:6868 "$TUNNEL_NAME"
else
  # 3b. Chưa có TUNNEL_DOMAIN → Quick Tunnel (URL ngẫu nhiên *.trycloudflare.com)
  echo "  Chưa điền TUNNEL_DOMAIN trong .env → chạy Quick Tunnel (URL ngẫu nhiên)."
  printf '  \033[33m[CANH BAO] URL này public trên Internet và dashboard CHƯA có đăng nhập -\033[0m\n'
  printf '  \033[33mchỉ dùng tạm thời, đừng chia sẻ link. Muốn domain riêng + QR tự động: điền TUNNEL_DOMAIN vào .env.\033[0m\n'
  echo ""
  exec cloudflared tunnel --url http://localhost:6868
fi
