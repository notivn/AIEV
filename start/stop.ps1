# AI Edit Video by noti.vn - dừng toàn bộ hệ thống (web 6868 + server 6869)

$ErrorActionPreference = "SilentlyContinue"
$killed = 0

foreach ($port in 6868, 6869) {
    $pids = Get-NetTCPConnection -LocalPort $port -State Listen |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $pids) {
        if ($procId -and $procId -ne 0) {
            # Kill cả cây process (node + con của nó)
            taskkill /pid $procId /t /f | Out-Null
            $killed++
        }
    }
}

# Xóa dấu vết "đang chạy": để lại thì lần bấm start.bat sau nhìn thấy run.json
# còn đó và tưởng hệ thống vẫn sống.
Remove-Item (Join-Path (Split-Path -Parent $PSScriptRoot) ".aiev\run.json") -ErrorAction SilentlyContinue

if ($killed -gt 0) {
    Write-Host "  [OK] Đã dừng hệ thống AI Edit Video ($killed process)." -ForegroundColor Green
} else {
    Write-Host "  Hệ thống không chạy - không có gì để dừng." -ForegroundColor DarkGray
}
