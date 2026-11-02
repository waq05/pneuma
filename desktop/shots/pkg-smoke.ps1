# 打包件冒烟：直接起 dist/win-unpacked 的 Pneuma.exe（electron-builder 刚出的产物），
# 隔离 HOME 与 userData，截图 + eval 断言 UI 真渲染（不是白屏）。
#
# 用法：pwsh -NoProfile -File pkg-smoke.ps1
$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$pkgShots = 'D:\dsc\desktop\shots'
$pkgExe = 'D:\dsc\desktop\dist\win-unpacked\Pneuma.exe'
$pkgHome = Join-Path $pkgShots 'pkg-smoke-home'

# 种子最小化：只建目录骨架 + 假端点配置（打包件起来不出请求）
Remove-Item $pkgHome -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $pkgHome '.dsc') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $pkgHome 'AppData', 'Roaming') | Out-Null
Set-Content -LiteralPath (Join-Path $pkgHome '.dsc', 'config.yaml') -Value @'
default:
  provider: fake
  model: fake-chat
providers:
  fake:
    displayName: 冒烟假端点
    baseURL: http://127.0.0.1:18961/v1
    apiKeyEnv: PKG_SMOKE_KEY
    models:
      - id: fake-chat
        name: Fake Chat
        contextWindow: 128000
        maxTokens: 4096
'@ -Encoding utf8

$env:DSC_DESKTOP_USER_DATA = Join-Path $pkgHome 'electron-userdata'
$env:USERPROFILE = $pkgHome
$env:HOME = $pkgHome
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SHOT = Join-Path $pkgShots 'pkg-smoke-0634.png'
$env:DSC_DESKTOP_SHOT_DELAY = '26000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '16000'
$env:DSC_DESKTOP_SHOT_EVAL = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = pred(); if (v) return v; await wait(150); }
    return null;
  };
  const started = Date.now();
  const app = await waitFor(() => document.querySelector('.app, #root > div, body > div'), 20000);
  const composer = await waitFor(() => document.querySelector('.composer textarea'), 15000);
  const sidebar = document.querySelector('.sess-item, .sidebar, [class*="sidebar"]');
  await wait(800);
  return {
    case: 'pkg-smoke',
    ms: Date.now() - started,
    theme: document.documentElement.dataset.theme,
    bodyChars: document.body.textContent.length,
    hasApp: app !== null,
    hasComposer: composer !== null,
    hasSidebar: sidebar !== null,
    // 判定
    rendered: app !== null && composer !== null && document.body.textContent.length > 40,
  };
})()
'@

$outLog = Join-Path $pkgShots 'pkg-smoke-0634.out.log'
$errLog = Join-Path $pkgShots 'pkg-smoke-0634.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
Write-Output "=== 打包件冒烟（$pkgExe）==="

$pkgProc = Start-Process -FilePath $pkgExe -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
$pkgDeadline = (Get-Date).AddSeconds(90)
$pkgSeen = ''
while ((Get-Date) -lt $pkgDeadline) {
  if (Test-Path -LiteralPath $errLog) {
    $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|页面加载失败|截图失败' -ErrorAction SilentlyContinue
    if ($null -ne $hit) { $pkgSeen = $hit[0].Line; break }
  }
  if ($pkgProc.HasExited) { break }
  Start-Sleep -Milliseconds 500
}
& taskkill /PID $pkgProc.Id /T /F 2>&1 | Out-Null
Start-Sleep -Milliseconds 600
Write-Output ("  已收工：{0}" -f ($pkgSeen -replace '\s+$', ''))
if (Test-Path -LiteralPath $errLog) {
  Select-String -LiteralPath $errLog -Pattern '预跑脚本完成|预跑脚本失败|已写出|页面加载失败' | ForEach-Object { '  ' + $_.Line }
}

Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
  Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_USER_DATA -ErrorAction SilentlyContinue
Write-Output '冒烟完成'
