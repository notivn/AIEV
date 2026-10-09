# AI Edit Video by noti.vn - script khởi động
# Tự kiểm tra môi trường -> cài dependencies (lần đầu) -> chạy server + web -> mở http://localhost:6868

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# doctor.mjs in tiếng Việt có dấu ra stdout - console cmd mặc định là codepage
# 437/1258 nên sẽ ra ký tự rác nếu không chuyển sang UTF-8 trước.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$WebUrl = "http://localhost:6868"
# Địa chỉ để DÒ bằng Invoke-WebRequest - phải là 127.0.0.1 chứ không phải localhost.
# PowerShell phân giải "localhost" ra ::1 (IPv6) trước, còn `next start` chỉ bind
# IPv4, nên request treo đến hết TimeoutSec rồi mới lỗi. Hậu quả đo được: bước 2
# không bao giờ nhận ra hệ thống đang chạy sẵn (lần nào cũng build + khởi động
# lại), và bước 8 luôn kết thúc bằng "chưa phản hồi sau 2 phút" dù web đã lên.
# Mở trình duyệt thì vẫn dùng $WebUrl cho dễ đọc.
$ProbeUrl = "http://127.0.0.1:6868"

function Write-Step($msg)  { Write-Host "  -> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Err($msg)   { Write-Host "  [LOI] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  AI Edit Video by: noti.vn" -ForegroundColor White
Write-Host "  ==========================" -ForegroundColor DarkGray

# 1. Kiểm tra Node.js
try {
    $nodeVer = (node --version) -replace "v", ""
} catch {
    Write-Err "Chưa cài Node.js. Tải tại https://nodejs.org (bản 22 trở lên) rồi chạy lại."
    exit 1
}
if ([int]($nodeVer.Split(".")[0]) -lt 22) {
    Write-Err "Node.js $nodeVer quá cũ - cần bản 22 trở lên."
    exit 1
}
Write-Ok "Node.js v$nodeVer"

# 1b. Kiểm tra môi trường + cài phần còn thiếu.
#     Danh sách kiểm tra nằm ở start/doctor.mjs - DÙNG CHUNG với start.sh và với
#     trang Cấu hình trên web, để ba nơi không bao giờ lệch nhau. Doctor không
#     cần node_modules nên chạy được ngay cả lần clone đầu tiên.
node (Join-Path $root "start\doctor.mjs") --fix
# winget ghi PATH vào registry chứ không vào tiến trình đang chạy: nạp lại để
# server (khởi động ở bước 6) thấy được ffmpeg/cloudflared vừa cài xong.
$env:Path = ([Environment]::GetEnvironmentVariable("Path", "Machine"),
             [Environment]::GetEnvironmentVariable("Path", "User")) -join ";"

# 2. Đang chạy sẵn hay không - và nếu có thì có ĐÚNG là bản dựng từ code hiện
#    tại không.
#
#    KHÔNG được kết luận chỉ vì cổng 6868 có người trả lời. Người dùng lỡ chạy
#    `npm run dev` trước đó thì dev server cũng trả lời 200, và script cũ sẽ mở
#    trình duyệt vào đúng cái bản CŨ đang nằm trong bộ nhớ của tiến trình đó -
#    sửa code xong bấm start.bat mà không thấy gì đổi, không hiểu tại sao.
#
#    Bằng chứng đáng tin là `.aiev/run.json`: chỉ chính script này ghi ra, và
#    trong đó có dấu vân tay mã nguồn lúc khởi động. Khớp với mã nguồn hiện tại
#    thì mới thật sự là "đang chạy sẵn, đúng bản".
$stateDir = Join-Path $root ".aiev"
$runFile  = Join-Path $stateDir "run.json"
$srcStamp = (node (Join-Path $root "start\build-stamp.mjs") --print)

function Stop-AievPorts {
    foreach ($port in 6868, 6869) {
        Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique |
            ForEach-Object { taskkill /pid $_ /t /f 2>$null | Out-Null }
    }
    Remove-Item $runFile -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

$webUp = $false; $apiUp = $false
try {
    $probe = Invoke-WebRequest -UseBasicParsing -Uri $ProbeUrl -TimeoutSec 2
    if ($probe.StatusCode -eq 200) { $webUp = $true }
} catch { }
try {
    $probeApi = Invoke-WebRequest -UseBasicParsing -Uri "$ProbeUrl/api/health" -TimeoutSec 3
    if ($probeApi.StatusCode -eq 200) { $apiUp = $true }
} catch { }

if ($webUp -or $apiUp) {
    $runStamp = $null
    try { $runStamp = (Get-Content $runFile -Raw | ConvertFrom-Json).stamp } catch { }

    if ($webUp -and $apiUp -and $runStamp -eq $srcStamp) {
        Write-Ok "Hệ thống đang chạy sẵn (đúng bản mới nhất) - mở trình duyệt."
        Start-Process $WebUrl
        exit 0
    }
    if ($null -eq $runStamp) {
        # Nháy đơn, KHÔNG backtick: trong chuỗi nháy kép của PowerShell backtick
        # là ký tự thoát, nên "`npm run dev`" biến `n thành ký tự xuống dòng và
        # câu thông báo bị cắt cụt ngay giữa chừng.
        Write-Step "Cổng 6868/6869 đang bị tiến trình khác chiếm (vd 'npm run dev') - dừng để chạy lại cho đúng..."
    } elseif ($runStamp -ne $srcStamp) {
        Write-Step "Code đã đổi so với bản đang chạy - dừng để build lại..."
    } else {
        Write-Step "Hệ thống chạy dở dang - khởi động lại cho sạch..."
    }
    Stop-AievPorts
}

# 3. Cài dependencies lần đầu - hoặc khi node_modules có mà thiếu công cụ build.
#    Chỉ kiểm tra thư mục node_modules là chưa đủ: lần cài đầu bị ngắt giữa
#    chừng (đóng cửa sổ, mất mạng, build better-sqlite3 lỗi) để lại một
#    node_modules dở dang, và máy đặt NODE_ENV=production hoặc
#    `npm config set omit dev` thì npm bỏ qua devDependencies - cả hai đều ra
#    "'tsc' is not recognized" ở bước build. `--include=dev` ép cài đủ
#    devDependencies (typescript, tsx...) bất kể cấu hình npm của máy.
$binDir = Join-Path $root "node_modules\.bin"
$missingTools = @("tsc", "next", "tsx", "remotion", "concurrently") | Where-Object {
    -not (Test-Path (Join-Path $binDir "$_.cmd")) -and -not (Test-Path (Join-Path $binDir $_))
}
if (-not (Test-Path (Join-Path $root "node_modules")) -or $missingTools) {
    if (Test-Path (Join-Path $root "node_modules")) {
        Write-Step "Dependencies chưa cài đủ (thiếu: $($missingTools -join ', ')) - đang cài lại (vài phút)..."
    } else {
        Write-Step "Lần chạy đầu tiên - đang cài dependencies (vài phút)..."
    }
    npm install --include=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Write-Err "npm install thất bại - xem log phía trên."; exit 1 }
    Write-Ok "Đã cài dependencies."
}

# 4. Build lại khi mã nguồn đã đổi so với lần build gần nhất.
#
#    So bằng DẤU VÂN TAY mã nguồn (start/build-stamp.mjs), không so thời gian
#    sửa file giữa `src` và `.next`/`dist` như bản cũ. Lý do: `next start` ghi
#    cache vào chính `.next` trong lúc chạy, nên `.next` luôn trông mới hơn
#    `src` và thay đổi thật thì bị bỏ sót - sửa code xong build không chạy lại.
$serverDist = Join-Path $root "apps\server\dist"
$webNext    = Join-Path $root "apps\web\.next"

node (Join-Path $root "start\build-stamp.mjs") --check
$stampOk = ($LASTEXITCODE -eq 0)

if (-not $stampOk -or -not (Test-Path $serverDist)) {
    Write-Step "Build backend..."
    npm run build -w apps/server
    if ($LASTEXITCODE -ne 0) { Write-Err "Build server thất bại."; exit 1 }
}
if (-not $stampOk -or -not (Test-Path $webNext)) {
    Write-Step "Build web UI (vài phút)..."
    npm run build -w apps/web
    if ($LASTEXITCODE -ne 0) { Write-Err "Build web thất bại."; exit 1 }
}
# Ghi dấu vân tay SAU KHI build xong: build hỏng giữa chừng thì lần chạy sau
# vẫn phải build lại, không được coi là đã xong.
node (Join-Path $root "start\build-stamp.mjs") --save | Out-Null

# (cloudflared, ffmpeg, Chrome... đã do doctor.mjs ở bước 1b lo)

# 5. Tạo .env nếu chưa có
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $root ".env.example") $envFile
    Write-Ok "Đã tạo file .env"
    Write-Host "     Lưu ý: muốn dùng tính năng Chat AI, đăng nhập Claude Code trên máy này (subscription OAuth - lệnh 'claude' -> /login) hoặc mở file .env và điền ANTHROPIC_API_KEY." -ForegroundColor Yellow
}

# 6. Chạy server + web trong cửa sổ riêng (giữ mở để xem log)
Write-Step "Khởi động server (port 6869) + web (port 6868)..."
Start-Process cmd -ArgumentList "/k", "title AI Edit Video - LOG && cd /d `"$root`" && npm run start" | Out-Null

# 7. Mở firewall port 6868 (trang web) + 6869 (backend API - trang /m trên điện
#    thoại upload file lớn gọi thẳng port này) cho tính năng "Kết nối điện thoại".
#    Không có quyền admin thì lệnh fail im lặng - Windows sẽ tự hỏi Allow khi có
#    kết nối đầu tiên.
try {
    netsh advfirewall firewall show rule name="AIEV Web 6868" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        netsh advfirewall firewall add rule name="AIEV Web 6868" dir=in action=allow protocol=TCP localport=6868 2>$null | Out-Null
    }
} catch { }
try {
    netsh advfirewall firewall show rule name="AIEV API 6869" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        netsh advfirewall firewall add rule name="AIEV API 6869" dir=in action=allow protocol=TCP localport=6869 2>$null | Out-Null
    }
} catch { }

# 8. Đợi web sẵn sàng rồi mở trình duyệt
Write-Step "Đang đợi hệ thống sẵn sàng..."
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri $ProbeUrl -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
}

if ($ready) {
    # Ghi lại "lần chạy này dựng từ mã nguồn nào". Lần bấm start.bat kế tiếp đọc
    # đúng file này để phân biệt ba trường hợp: đang chạy đúng bản (chỉ mở trình
    # duyệt), code đã đổi (build lại), hay cổng đang bị tiến trình lạ chiếm.
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    # WriteAllText chứ không Set-Content -Encoding UTF8: Windows PowerShell 5.1
    # thêm BOM vào đầu file, mà JSON.parse của Node (start.sh đọc bằng cách đó)
    # coi BOM là ký tự lạ và ném lỗi. Ghi không BOM thì cả hai bên đọc được.
    [IO.File]::WriteAllText(
        $runFile,
        (@{ stamp = $srcStamp; at = (Get-Date).ToString("o") } | ConvertTo-Json)
    )

    Write-Ok "Hệ thống đã sẵn sàng!"
    Start-Process $WebUrl
    Write-Host ""
    Write-Host "  Dashboard : $WebUrl" -ForegroundColor White
    Write-Host "  Muốn dừng : chạy start\stop.bat (hoặc đóng cửa sổ log)" -ForegroundColor DarkGray
    Start-Sleep -Seconds 2
} else {
    Write-Err "Hệ thống chưa phản hồi sau 2 phút - xem cửa sổ 'AI Edit Video - LOG' để biết lỗi."
    exit 1
}
