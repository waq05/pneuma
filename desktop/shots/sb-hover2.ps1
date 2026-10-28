# 真悬停截图（闭环版）：页面把「当前 hover 到谁」写进 document.title，
# 这个脚本读窗口标题来确认光标是否真的落在文件夹行上，没落上就换下一个候选
# 坐标。DPI 缩放（dpr=1.5）下 SetCursorPos 的坐标空间靠这一闭环校准，
# 不用猜 pwsh 是不是 DPI 感知进程。
param([string]$Out = 'sb-02-hover')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$home2 = Join-Path $shots 'sb-home'

$env:DSC_DESKTOP_USER_DATA = Join-Path $shots 'sb-udata'
$env:USERPROFILE = $home2
$env:DSC_HOME = Join-Path $home2 '.dsc'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_RESUME_SESSION = Join-Path $home2 '.dsc\sessions\D-dsc\ca1de16f-1aa7-4514-bddb-2ca1a9940795.jsonl'
$env:DSC_DESKTOP_SHOT = Join-Path $shots "$Out.png"
$env:DSC_DESKTOP_SHOT_DELAY = '30000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '15000'

# 页面侧：每 200ms 把 hover 落点写进标题，供脚本读回来校准光标
$env:DSC_DESKTOP_SHOT_EVAL = @'
(async () => {
  document.documentElement.style.setProperty('--dsc-dur', '0ms');
  for (let i = 0; i < 80; i++) {
    const hov = document.querySelectorAll(':hover');
    const deepest = hov.length > 0 ? hov[hov.length - 1] : null;
    const row = document.querySelector('.group-row');
    const acts = row ? row.querySelector('.row-tail .row-actions') : null;
    document.title = 'HOV|' + JSON.stringify({
      n: hov.length,
      hit: deepest ? String(deepest.className).slice(0, 40) : '',
      rows: Array.from(document.querySelectorAll('.group-row:hover')).map((el) => el.querySelector('.dir').textContent),
      acts: acts ? getComputedStyle(acts).visibility : '',
    });
    await new Promise((r) => setTimeout(r, 200));
  }
  return 'loop done';
})()
'@

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Hov32 {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, ref RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$start = Get-Date
$log = Join-Path $shots "$Out.log"
$proc = Start-Process -FilePath $electron -ArgumentList 'out\main\index.js' -PassThru -WindowStyle Hidden `
  -RedirectStandardError $log -RedirectStandardOutput (Join-Path $shots "$Out.out")

function Get-Win {
  Get-Process -Name electron -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.StartTime -gt $start } |
    Sort-Object StartTime -Descending | Select-Object -First 1
}
function Read-Title([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  $null = [Hov32]::GetWindowText($h, $sb, 512)
  $sb.ToString()
}
# 页面在标题里报回的 hover 状态（还没跑到那一步时返回 null）
function Parse-Hov([string]$title) {
  if (-not $title.StartsWith('HOV|')) { return $null }
  try { return $title.Substring(4) | ConvertFrom-Json } catch { return $null }
}

$win = $null
for ($i = 0; $i -lt 60 -and $null -eq $win; $i++) { Start-Sleep -Milliseconds 400; $win = Get-Win }
if ($null -eq $win) { throw '没找到自检窗口' }
$h = $win.MainWindowHandle

$pt = New-Object Hov32+POINT
$null = [Hov32]::ClientToScreen($h, [ref]$pt)
$rect = New-Object Hov32+RECT
$null = [Hov32]::GetClientRect($h, [ref]$rect)
Write-Output "窗口客户区原点=($($pt.X),$($pt.Y)) 客户区尺寸=$($rect.R)x$($rect.B)"

# 探针量出的候选点（CSS px，相对客户区）：文件夹行右端往里 30px 的行中线、行中线中点、徽标中心
$candidates = @(
  @{ name = 'row-right@1.5'; scale = 1.5; x = 198.3; y = 204.6 },
  @{ name = 'row-right@1.0'; scale = 1.0; x = 198.3; y = 204.6 },
  @{ name = 'row-mid@1.5'; scale = 1.5; x = 118.0; y = 204.6 },
  @{ name = 'row-mid@1.0'; scale = 1.0; x = 118.0; y = 204.6 },
  @{ name = 'row-mid@1.25'; scale = 1.25; x = 118.0; y = 204.6 }
)

foreach ($c in $candidates) {
  # 等页面进入报状态的循环（标题带上 HOV| 前缀）
  for ($i = 0; $i -lt 100; $i++) {
    if ($null -ne (Parse-Hov (Read-Title $h))) { break }
    Start-Sleep -Milliseconds 300
  }
  $x = [int][Math]::Round($pt.X + $c.x * $c.scale)
  $y = [int][Math]::Round($pt.Y + $c.y * $c.scale)
  $null = [Hov32]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 500
  $null = [Hov32]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 400
  $hov = Parse-Hov (Read-Title $h)
  Write-Output ("候选 {0} 光标=({1},{2}) → hover n={3} hit={4} rows={5} 浮层={6}" -f $c.name, $x, $y, $hov.n, $hov.hit, ($hov.rows -join ','), $hov.acts)
  if ($hov.rows.Count -gt 0) { Write-Output "命中：$($c.name)"; break }
}

$proc.WaitForExit(60000) | Out-Null
Select-String -Path $log -Pattern 'selfcheck' | ForEach-Object { $_.Line }
