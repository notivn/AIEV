# AI Edit Video - cập nhật bản mới nhất từ GitHub rồi khởi động lại
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Ghi toàn bộ output vào start\update.log để soi được khi cập nhật lỗi
$log = Join-Path $root "start\update.log"
try { Start-Transcript -Path $log -Append | Out-Null } catch {}

function Stop-UpdateLog {
    try { Stop-Transcript | Out-Null } catch {}
}

# Mốc phân tách các lần chạy. Transcript ghi -Append nên log là file CỘNG DỒN;
# thiếu dòng này thì GET /api/update/log không biết lần chạy mới bắt đầu từ đâu
# và trả về bước của lần cập nhật TRƯỚC (update.sh đã có dòng tương đương).
Write-Host ("===== " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " - bắt đầu cập nhật =====")

Write-Host ""
Write-Host "  AI Edit Video - CAP NHAT" -ForegroundColor White
Write-Host "  =========================" -ForegroundColor DarkGray

# 1. Kéo bản mới TRƯỚC KHI dừng hệ thống - pull fail thì hệ thống cũ vẫn chạy
Write-Host "[STEP] pull"
Write-Host "  -> Đang kéo bản mới nhất từ GitHub..." -ForegroundColor Cyan
# --tags: kênh "Bản chính thức" nhảy theo tag release nên bắt buộc kéo cả tag về
git fetch origin --tags --force
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [LOI] Không fetch được từ GitHub (mất mạng?). Hệ thống cũ vẫn chạy bình thường." -ForegroundColor Red
    Stop-UpdateLog
    Read-Host "  Enter để thoát"
    exit 1
}

# Mốc cần nhảy tới do server ghi ra theo kênh cập nhật đã chọn trong Cấu hình
# (tag release như "v1.0.1", hoặc "origin/main" cho kênh bản mới nhất).
# Bản cài cũ chưa có file này -> giữ nguyên hành vi cũ là bám ngọn main.
$target = "origin/main"
$targetFile = Join-Path $root "start\update-target.txt"
if (Test-Path $targetFile) {
    $t = (Get-Content $targetFile -Raw -ErrorAction SilentlyContinue)
    if ($t) { $t = $t.Trim(); if ($t) { $target = $t } }
}
Write-Host ("  -> Cập nhật tới: " + $target) -ForegroundColor DarkGray

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
$userPaths = @(".claude\skills", "assets\styles", "assets\sound-effects", "assets\music", "assets\prompts")
$bk = Join-Path $root ("start\backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Force $bk | Out-Null
foreach ($p in $userPaths) {
    $src = Join-Path $root $p
    if (Test-Path $src) {
        $dst = Join-Path $bk (Split-Path $p -Parent)
        New-Item -ItemType Directory -Force $dst | Out-Null
        Copy-Item $src $dst -Recurse -Force -ErrorAction SilentlyContinue
    }
}

git merge --ff-only $target
if ($LASTEXITCODE -ne 0) {
    # Máy chỉ-dùng hay dính thay đổi cục bộ (đổi eol, sửa nhầm file…) - stash rồi pull lại
    # `git stash -u` gom cả file untracked (skill tự tạo) nên backup ở trên là bắt buộc.
    Write-Host "  -> Pull thất bại - đã backup dữ liệu vào $bk rồi stash thay đổi cục bộ..." -ForegroundColor Yellow
    $stashBefore = git rev-parse -q --verify refs/stash
    git stash push -u -m "aiev-auto-stash"
    $stashAfter = git rev-parse -q --verify refs/stash
    git merge --ff-only $target
    if ($LASTEXITCODE -ne 0) {
        # stash -u đã RÚT file untracked (skill tự tạo...) khỏi thư mục làm việc - trả
        # lại ngay. Chỉ pop khi đúng là vừa có stash mới, kẻo pop nhầm stash cũ.
        if ($stashAfter -and $stashAfter -ne $stashBefore) { git stash pop }
        Write-Host "  [LOI] Vẫn không pull được - xem chi tiết trong start\update.log. Hệ thống cũ vẫn chạy bình thường." -ForegroundColor Red
        Write-Host "        Chạy 'git status' xem file nào đổi." -ForegroundColor Yellow
        Write-Host "        Dữ liệu của bạn vẫn nằm nguyên trong $bk." -ForegroundColor Yellow
        Stop-UpdateLog
        Read-Host "  Enter để thoát"
        exit 1
    }
}

# Chép lại những file CÓ trong backup mà KHÔNG còn trong thư mục làm việc.
# Chỉ đụng vào file đã biến mất - file bản mới mang tới thì để nguyên.
$restored = 0
foreach ($f in Get-ChildItem -Path $bk -Recurse -File -ErrorAction SilentlyContinue) {
    $rel = $f.FullName.Substring($bk.Length).TrimStart('\')
    $dest = Join-Path $root $rel
    if (-not (Test-Path $dest)) {
        New-Item -ItemType Directory -Force (Split-Path $dest -Parent) | Out-Null
        Copy-Item $f.FullName $dest -Force -ErrorAction SilentlyContinue
        $restored++
    }
}
if ($restored -gt 0) {
    Write-Host "  -> Bản mới không còn kèm $restored file dữ liệu - đã chép lại từ máy bạn." -ForegroundColor Cyan
    Write-Host "     Bản sao lưu giữ tại $bk" -ForegroundColor DarkGray
} else {
    # Không phải chép lại gì thì bản backup kia chỉ tổ chật đĩa qua từng lần cập nhật.
    Remove-Item $bk -Recurse -Force -ErrorAction SilentlyContinue
}

# 2. Pull OK → giờ mới dừng hệ thống để build lại (tránh file bị khóa)
Write-Host "[STEP] stop"
Write-Host "  -> Dừng hệ thống đang chạy..." -ForegroundColor Cyan
foreach ($port in 6868, 6869) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object { taskkill /pid $_ /t /f 2>$null | Out-Null }
}

# 3. Cài dependencies mới (nếu có)
Write-Host "[STEP] install"
Write-Host "  -> npm install..." -ForegroundColor Cyan
npm install --include=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [LOI] npm install thất bại - xem start\update.log." -ForegroundColor Red
    Stop-UpdateLog
    Read-Host "  Enter để thoát"
    exit 1
}

# 4. Khởi động lại - start.ps1 tự build lại phần code mới rồi mở trình duyệt
Write-Host "  [OK] Đã cập nhật. Đang khởi động..." -ForegroundColor Green
Stop-UpdateLog
Write-Host "[STEP] restart"
& (Join-Path $root "start\start.ps1")
