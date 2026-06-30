# claude-statusline.ps1
#
# Claude Code 的 statusLine 指令腳本（Windows / PowerShell，無需 Node）。
# Claude Code 每次更新狀態列時，會把一份 JSON 從 stdin 餵給這支腳本。
# 其中（Pro/Max 訂閱、且送出第一則訊息後）會包含：
#   rate_limits.five_hour.used_percentage / resets_at
#   rate_limits.seven_day.used_percentage / resets_at
#
# 本腳本做兩件事：
#   1) 把 rate_limits 寫進 %USERPROFILE%\.claude\usage-cache.json（給收集器/儀表板讀）
#   2) 在 stdin 輸出一行狀態列文字（顯示於 Claude Code 底部）
#
# 設定方式見 collector/README.md。

$ErrorActionPreference = 'SilentlyContinue'

# 讀取 Claude Code 從 stdin 傳入的 JSON
$raw = [Console]::In.ReadToEnd()
if (-not $raw) { Write-Output "Claude"; exit 0 }

try { $data = $raw | ConvertFrom-Json } catch { Write-Output "Claude"; exit 0 }

$rl = $data.rate_limits

# 只要拿得到 rate_limits 就寫檔（只存用量摘要，不含對話內容）
if ($rl) {
  $cacheDir  = Join-Path $env:USERPROFILE '.claude'
  $cachePath = Join-Path $cacheDir 'usage-cache.json'
  if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }

  $out = [pscustomobject]@{
    fetchedAt   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    rate_limits = $rl
  }
  $out | ConvertTo-Json -Depth 10 | Set-Content -Path $cachePath -Encoding UTF8
}

# 組出狀態列文字
function Pct($v) { if ($null -ne $v) { [string][math]::Round([double]$v) + '%' } else { '?' } }
$five = Pct $rl.five_hour.used_percentage
$week = Pct $rl.seven_day.used_percentage
$model = if ($data.model.display_name) { $data.model.display_name } else { 'Claude' }

Write-Output "$model  |  5h $five  |  週 $week"
