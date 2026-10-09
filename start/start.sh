#!/usr/bin/env bash
# AI Edit Video by noti.vn - script khởi động (macOS / Linux)
# Tự kiểm tra môi trường -> cài dependencies (lần đầu) -> chạy server + web -> mở http://localhost:6868
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# .command chạy với PATH tối giản của macOS - thêm đường Homebrew (Apple Silicon
# /opt/homebrew, Intel /usr/local) để thấy brew/cloudflared/ffmpeg; server con kế thừa PATH này.
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"
WEB_URL="http://localhost:6868"
LOG_FILE="$ROOT/start/server.log"

step() { printf '  \033[36m-> %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m[OK] %s\033[0m\n' "$1"; }
err()  { printf '  \033[31m[LOI] %s\033[0m\n' "$1"; }

echo ""
echo "  AI Edit Video by: noti.vn"
echo "  =========================="

# 1. Kiểm tra Node.js >= 22
if ! command -v node >/dev/null 2>&1; then
  err "Chưa cài Node.js. Tải tại https://nodejs.org (bản 22 trở lên) rồi chạy lại."
  exit 1
fi
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  err "Node.js $(node --version) quá cũ - cần bản 22 trở lên."
  exit 1
fi
ok "Node.js $(node --version)"

# Kiểm tra môi trường + cài phần còn thiếu (ffmpeg, Chrome, faster-whisper,
# cloudflared...). Danh sách nằm ở start/doctor.mjs - DÙNG CHUNG với start.ps1
# và trang Cấu hình trên web, để ba nơi không bao giờ lệch nhau.
export PATH="$ROOT/start/bin:$PATH"
node "$ROOT/start/doctor.mjs" --fix

# --- Claude Code: kiểm tra đăng nhập, dẫn vào /login nếu chưa ---
# Doctor cài được CLI nhưng KHÔNG đăng nhập thay được (phải mở trình duyệt,
# nhập mã) - đoạn dưới bàn giao terminal cho `claude` để người dùng gõ /login.
claude_authed() {
  [ -n "${ANTHROPIC_API_KEY:-}" ] && return 0
  [ -f "$HOME/.claude/.credentials.json" ] && return 0
  # macOS: Claude Code lưu OAuth trong Keychain
  if command -v security >/dev/null 2>&1; then
    security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 && return 0
  fi
  return 1
}

if command -v claude >/dev/null 2>&1 && ! claude_authed; then
  echo ""
  printf '  \033[33mChưa đăng nhập Claude (subscription) - tính năng edit AI sẽ chưa dùng được.\033[0m\n'
  printf '  Đăng nhập ngay? Claude Code sẽ mở - gõ \033[1m/login\033[0m trong đó, đăng nhập xong thoát (Ctrl+C 2 lần). [Y/n] '
  read -r REPLY_LOGIN || REPLY_LOGIN="n"
  if [ "$REPLY_LOGIN" != "n" ] && [ "$REPLY_LOGIN" != "N" ]; then
    claude || true
    if claude_authed; then ok "Đã đăng nhập Claude."; else
      printf '  \033[33mVẫn chưa thấy đăng nhập - hệ thống vẫn chạy, đăng nhập sau bằng: claude → /login\033[0m\n'
    fi
  else
    printf '  \033[33mBỏ qua - đăng nhập sau bằng: claude → /login (hoặc điền ANTHROPIC_API_KEY vào .env)\033[0m\n'
  fi
fi

open_browser() {
  if command -v open >/dev/null 2>&1; then open "$WEB_URL"; # macOS
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$WEB_URL"; fi
}

probe() { curl -s -o /dev/null -w '%{http_code}' -m 3 "$1" 2>/dev/null || echo 000; }

# 2. Đang chạy sẵn hay không - và nếu có thì có ĐÚNG là bản dựng từ code hiện
#    tại không.
#
#    KHÔNG được kết luận chỉ vì cổng 6868 có người trả lời. Người dùng lỡ chạy
#    `npm run dev` trước đó thì dev server cũng trả 200, và script cũ sẽ mở
#    trình duyệt vào đúng cái bản CŨ nằm trong bộ nhớ tiến trình đó - sửa code
#    xong bấm start mà không thấy gì đổi.
#
#    Bằng chứng đáng tin là .aiev/run.json: chỉ chính script này ghi ra, kèm dấu
#    vân tay mã nguồn lúc khởi động.
STATE_DIR="$ROOT/.aiev"
RUN_FILE="$STATE_DIR/run.json"
SRC_STAMP="$(node "$ROOT/start/build-stamp.mjs" --print)"

kill_ports() {
  for port in 6868 6869; do
    lsof -ti tcp:$port 2>/dev/null | xargs kill -9 2>/dev/null || true
  done
  rm -f "$RUN_FILE"
  sleep 1
}

WEB_UP=false; API_UP=false
[ "$(probe "$WEB_URL")" = "200" ] && WEB_UP=true
[ "$(probe "$WEB_URL/api/health")" = "200" ] && API_UP=true

if $WEB_UP || $API_UP; then
  RUN_STAMP=""
  if [ -f "$RUN_FILE" ]; then
    RUN_STAMP="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).stamp||"")}catch(e){}' "$RUN_FILE")"
  fi

  if $WEB_UP && $API_UP && [ -n "$RUN_STAMP" ] && [ "$RUN_STAMP" = "$SRC_STAMP" ]; then
    ok "Hệ thống đang chạy sẵn (đúng bản mới nhất) - mở trình duyệt."
    open_browser
    exit 0
  fi

  if [ -z "$RUN_STAMP" ]; then
    step "Cổng 6868/6869 đang bị tiến trình khác chiếm (vd 'npm run dev') - dừng để chạy lại cho đúng..."
  elif [ "$RUN_STAMP" != "$SRC_STAMP" ]; then
    step "Code đã đổi so với bản đang chạy - dừng để build lại..."
  else
    step "Hệ thống chạy dở dang - khởi động lại cho sạch..."
  fi
  kill_ports
fi

# 3. Cài dependencies lần đầu - hoặc khi node_modules có mà thiếu công cụ build.
#    Chỉ kiểm tra thư mục node_modules là chưa đủ: lần cài đầu bị ngắt giữa
#    chừng để lại node_modules dở dang, và máy đặt NODE_ENV=production hoặc
#    `npm config set omit dev` thì npm bỏ qua devDependencies - cả hai đều ra
#    "tsc: command not found" ở bước build. `--include=dev` ép cài đủ
#    devDependencies (typescript, tsx...) bất kể cấu hình npm của máy.
MISSING_TOOLS=""
for t in tsc next tsx remotion concurrently; do
  [ -e "$ROOT/node_modules/.bin/$t" ] || MISSING_TOOLS="$MISSING_TOOLS $t"
done
if [ ! -d "$ROOT/node_modules" ] || [ -n "$MISSING_TOOLS" ]; then
  if [ -d "$ROOT/node_modules" ]; then
    step "Dependencies chưa cài đủ (thiếu:$MISSING_TOOLS) - đang cài lại (vài phút)..."
  else
    step "Lần chạy đầu tiên - đang cài dependencies (vài phút)..."
  fi
  npm install --include=dev --no-audit --no-fund || { err "npm install thất bại - xem log phía trên."; exit 1; }
  ok "Đã cài dependencies."
fi

# 4. Build lại khi mã nguồn đã đổi so với lần build gần nhất.
#
#    So bằng DẤU VÂN TAY mã nguồn (start/build-stamp.mjs), không dùng
#    `find src -newer .next` như bản cũ. Hai lý do: `next start` ghi cache vào
#    chính `.next` lúc chạy nên `.next` luôn trông mới hơn `src`; và `-newer`
#    so với mtime của THƯ MỤC `.next`, thứ chỉ đổi khi thêm/xóa file con trực
#    tiếp - gần như không bao giờ bắt được thay đổi thật.
STAMP_OK=true
node "$ROOT/start/build-stamp.mjs" --check || STAMP_OK=false

if ! $STAMP_OK || [ ! -d "$ROOT/apps/server/dist" ]; then
  step "Build backend..."
  npm run build -w apps/server || { err "Build server thất bại."; exit 1; }
fi
if ! $STAMP_OK || [ ! -d "$ROOT/apps/web/.next" ]; then
  step "Build web UI (vài phút)..."
  npm run build -w apps/web || { err "Build web thất bại."; exit 1; }
fi
# Ghi dấu vân tay SAU KHI build xong - build hỏng giữa chừng thì lần sau vẫn
# phải build lại.
node "$ROOT/start/build-stamp.mjs" --save >/dev/null

# 5. Tạo .env nếu chưa có
if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  ok "Đã tạo file .env"
  printf '     \033[33mLưu ý: muốn dùng Chat AI, đăng nhập Claude Code trên máy này (lệnh `claude` -> /login) hoặc điền ANTHROPIC_API_KEY vào .env.\033[0m\n'
fi

# 6. Chạy nền, log ra file (macOS không có cửa sổ cmd riêng như Windows)
step "Khởi động server (port 6869) + web (port 6868)..."
: > "$LOG_FILE"
nohup npm run start >> "$LOG_FILE" 2>&1 &
disown

# 7. Đợi sẵn sàng rồi mở trình duyệt
step "Đang đợi hệ thống sẵn sàng..."
for _ in $(seq 1 60); do
  sleep 2
  if [ "$(probe "$WEB_URL")" = "200" ]; then
    # Ghi lại "lần chạy này dựng từ mã nguồn nào" - lần chạy script kế tiếp đọc
    # đúng file này để biết nên mở trình duyệt luôn hay phải build lại.
    mkdir -p "$STATE_DIR"
    printf '{\n  "stamp": "%s",\n  "at": "%s"\n}\n' \
      "$SRC_STAMP" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RUN_FILE"

    ok "Hệ thống đã sẵn sàng!"
    open_browser
    echo ""
    echo "  Dashboard : $WEB_URL"
    echo "  Xem log   : tail -f start/server.log"
    echo "  Muốn dừng : ./start/stop.sh"
    exit 0
  fi
done

err "Hệ thống chưa phản hồi sau 2 phút - xem log: tail -f start/server.log"
exit 1
