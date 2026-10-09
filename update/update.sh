#!/usr/bin/env bash
# AI Edit Video - cập nhật bản mới nhất từ GitHub rồi khởi động lại (macOS/Linux)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Ghi toàn bộ output vào start/update.log - script chạy nền (spawn từ WebUI)
# không có cửa sổ, log là cách duy nhất soi được lỗi.
LOG="$ROOT/start/update.log"
mkdir -p "$ROOT/start"
exec > >(tee -a "$LOG") 2>&1
echo ""
echo "===== $(date '+%Y-%m-%d %H:%M:%S') - bắt đầu cập nhật ====="

echo ""
echo "  AI Edit Video - CẬP NHẬT"
echo "  ========================="

# 1. Kéo bản mới TRƯỚC KHI dừng hệ thống - pull fail thì hệ thống cũ vẫn chạy
echo "[STEP] pull"
printf '  \033[36m-> Đang kéo bản mới nhất từ GitHub...\033[0m\n'
# --tags: kênh "Bản chính thức" nhảy theo tag release nên bắt buộc kéo cả tag về
if ! git fetch origin --tags --force; then
  printf '  \033[31m[LOI] Không fetch được từ GitHub (mất mạng?). Hệ thống cũ vẫn chạy bình thường.\033[0m\n'
  exit 1
fi

# Mốc cần nhảy tới do server ghi ra theo kênh cập nhật đã chọn trong Cấu hình
# (tag release như "v1.0.1", hoặc "origin/main" cho kênh bản mới nhất).
# Bản cài cũ chưa có file này -> giữ nguyên hành vi cũ là bám ngọn main.
TARGET="origin/main"
if [ -f "$ROOT/start/update-target.txt" ]; then
  T="$(tr -d '\r\n' < "$ROOT/start/update-target.txt")"
  [ -n "$T" ] && TARGET="$T"
fi
printf '  \033[90m-> Cập nhật tới: %s\033[0m\n' "$TARGET"

# merge --ff-only chứ không checkout tag: checkout tag làm repo rơi vào detached
# HEAD, lần cập nhật sau sẽ rối. Cách này giữ nhánh main và chỉ tua tới đúng
# commit mà tag trỏ vào.
# Backup dữ liệu người dùng TRƯỚC KHI merge, LUÔN LUÔN - không chỉ khi pull lỗi.
#
# VÌ SAO KHÔNG ĐỢI PULL LỖI MỚI BACKUP: merge --ff-only THÀNH CÔNG cũng xóa file.
# Bản nào gỡ một file đang được theo dõi khỏi repo thì file đó biến mất khỏi máy
# người dùng ngay lúc tua tới - im lặng, vì merge có báo lỗi gì đâu. Đúng chuyện
# đã xảy ra ở v1.1.0: 104 file sound effect và Style Design chuyển sang "dữ liệu
# của máy, không đi theo repo", và nếu không có bước này thì ai cập nhật cũng
# mất sạch thư viện của mình. .gitignore KHÔNG cứu được - nó chỉ chặn commit
# file mới, không giữ lại file mà bản mới đã xóa.
USER_PATHS=(".claude/skills" "assets/styles" "assets/sound-effects" "assets/music" "assets/prompts")
BK="$ROOT/start/backup-$(date '+%Y%m%d-%H%M%S')"
mkdir -p "$BK"
for p in "${USER_PATHS[@]}"; do
  [ -e "$ROOT/$p" ] && mkdir -p "$BK/$(dirname "$p")" && cp -R "$ROOT/$p" "$BK/$(dirname "$p")/" 2>/dev/null || true
done

# Chép lại những file CÓ trong backup mà KHÔNG còn trong thư mục làm việc.
# Chỉ đụng vào file đã biến mất - file bản mới mang tới thì để nguyên.
restore_missing() {
  local restored=0 rel
  [ -d "$BK" ] || return 0
  while IFS= read -r -d '' rel; do
    rel="${rel#./}"
    if [ ! -e "$ROOT/$rel" ]; then
      mkdir -p "$ROOT/$(dirname "$rel")"
      cp -p "$BK/$rel" "$ROOT/$rel" 2>/dev/null && restored=$((restored + 1))
    fi
  done < <(cd "$BK" && find . -type f -print0)
  echo "$restored"
}

if ! git merge --ff-only "$TARGET"; then
  # Máy chỉ-dùng hay dính thay đổi cục bộ (đổi eol, sửa nhầm file…) - stash rồi pull lại
  # `git stash -u` gom cả file untracked (skill tự tạo) nên backup ở trên là bắt buộc.
  printf '  \033[33m-> Pull thất bại - đã backup dữ liệu vào %s rồi stash thay đổi cục bộ...\033[0m\n' "$BK"
  STASH_BEFORE="$(git rev-parse -q --verify refs/stash || true)"
  git stash push -u -m "aiev-auto-stash" || true
  STASH_AFTER="$(git rev-parse -q --verify refs/stash || true)"
  if ! git merge --ff-only "$TARGET"; then
    # stash -u đã RÚT file untracked (skill tự tạo…) khỏi thư mục làm việc - không
    # trả lại thì "hệ thống cũ vẫn chạy bình thường" là sai. Chỉ pop khi đúng là
    # vừa có stash mới, kẻo pop nhầm một stash cũ của người dùng.
    if [ "$STASH_AFTER" != "$STASH_BEFORE" ]; then git stash pop || true; fi
    printf '  \033[31m[LOI] Vẫn không pull được - xem chi tiết trong start/update.log. Hệ thống cũ vẫn chạy bình thường.\033[0m\n'
    printf '  \033[33m       Chạy "git status" xem file nào đổi.\033[0m\n'
    printf '  \033[33m       Dữ liệu của bạn vẫn nằm nguyên trong %s.\033[0m\n' "$BK"
    exit 1
  fi
fi

RESTORED="$(restore_missing)"
if [ "${RESTORED:-0}" -gt 0 ]; then
  printf '  \033[36m-> Bản mới không còn kèm %s file dữ liệu - đã chép lại từ máy bạn.\033[0m\n' "$RESTORED"
  printf '  \033[90m   Bản sao lưu giữ tại %s\033[0m\n' "$BK"
else
  # Không phải chép lại gì thì bản backup 18MB kia chỉ tổ chật đĩa qua từng lần cập nhật.
  rm -rf "$BK"
fi

# 2. Pull OK → giờ mới dừng hệ thống để build lại
echo "[STEP] stop"
printf '  \033[36m-> Dừng hệ thống đang chạy...\033[0m\n'
for port in 6868 6869; do
  lsof -ti tcp:$port 2>/dev/null | xargs kill -9 2>/dev/null || true
done

# 3. Cài dependencies mới (nếu có)
echo "[STEP] install"
printf '  \033[36m-> npm install...\033[0m\n'
npm install --include=dev --no-audit --no-fund || { printf '  \033[31m[LOI] npm install thất bại - xem start/update.log.\033[0m\n'; exit 1; }

# 4. Khởi động lại - start.sh tự build phần code mới rồi mở trình duyệt
printf '  \033[32m[OK] Đã cập nhật. Đang khởi động...\033[0m\n'
echo "[STEP] restart"
exec bash "$ROOT/start/start.sh"
