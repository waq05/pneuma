# 「新建会话」切工作区专项自检：工作区行那颗钮 → 原生桥 switchCwd → 宿主重启换端口 →
# 窗口必须重新加载到新源（否则壳页面钉在旧端口上，界面看着还在、点什么都不动）。
#
# 这一步故意单独成一个脚本：重载会把页面里的 eval 上下文刷掉，跑在 ui-parity-check.ps1
# 里会把那个脚本前面的读数一起弄丢。
#
# 判定看四样证据：
#   ① stderr 里「界面形态=…」出现两次（宿主重启过一次）；
#   ② stderr 里「窗口来自宿主界面服务 …（宿主重启，窗口重新加载）」出现（新源 → 重载）；
#   ③ 隔离 home 的 desktop.json lastCwd 变成 D:\dsc（切目录真落了盘）；
#   ④ 截图（重载之后拍的）里侧栏的活动组跟着换成 dsc。
#
# 隔离：USERPROFILE/HOME + DSC_DESKTOP_STATE + DSC_DESKTOP_USER_DATA 全钉在隔离目录；
# 种子数据是合成会话（不含真实对话内容）。
#
# 用法：pwsh -NoProfile -File ui-switch-cwd-check.ps1（壳产物需已构建：pnpm run build:ui）

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$swShots = 'D:\dsc\desktop\shots'
$swElectron = Join-Path $swShots '..\node_modules\electron\dist\electron.exe'
$swEntry = Join-Path $swShots '..\out\main\index.js'
$swHome = Join-Path $swShots 'shell-switch-home'
$swDsc = Join-Path $swHome '.dsc'

# ── 种子：两个工作区（documents 是当前，D:\dsc 是目标），各带一份合成会话 ─────────
$seedDocs = 'C:\Users\waq\Desktop\documents'
$seedDsc = 'D:\dsc'
New-Item -ItemType Directory -Force -Path (Join-Path $swDsc 'sessions\C-Users-waq-Desktop-documents') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $swDsc 'sessions\D-dsc') | Out-Null
Set-Content -LiteralPath (Join-Path $swDsc 'desktop.json') -Encoding UTF8 -Value (@{
  lastCwd = $seedDocs
  recentCwds = @($seedDocs, $seedDsc)
  ui = 'shell'
} | ConvertTo-Json -Depth 4)
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Set-Content -LiteralPath (Join-Path $swDsc 'sessions\C-Users-waq-Desktop-documents\11111111-2222-3333-4444-555555555555.jsonl') -Encoding UTF8 -Value @(
  "{`"type`":`"meta`",`"id`":`"11111111-2222-3333-4444-555555555555`",`"cwd`":`"C:\\Users\\waq\\Desktop\\documents`",`"createdAt`":$($now - 3600000)}",
  "{`"type`":`"user`",`"text`":`"自检样本会话：这里是一句合成的用户消息。`",`"ts`":$($now - 3590000)}"
)
Set-Content -LiteralPath (Join-Path $swDsc 'sessions\D-dsc\66666666-7777-8888-9999-aaaaaaaaaaaa.jsonl') -Encoding UTF8 -Value @(
  "{`"type`":`"meta`",`"id`":`"66666666-7777-8888-9999-aaaaaaaaaaaa`",`"cwd`":`"D:\\dsc`",`"createdAt`":$($now - 7200000)}",
  "{`"type`":`"user`",`"text`":`"自检样本会话（第二个工作区）。`",`"ts`":$($now - 7190000)}"
)

$swEval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = pred(); if (v) return v; await wait(120); }
    return null;
  };
  await waitFor(() => {
    const root = document.querySelector('#root');
    return root !== null && root.children.length > 0;
  }, 20000);
  await wait(2500);
  const activeBefore = ((document.querySelector('.group-row.active .dir') ?? {}).textContent ?? '').trim();
  const otherRow = Array.from(document.querySelectorAll('.group-row')).find((r) => !r.classList.contains('active'));
  const target = otherRow === undefined ? null : ((otherRow.querySelector('.dir') ?? {}).textContent ?? '').trim();
  const btn = otherRow === undefined
    ? undefined
    : Array.from(otherRow.querySelectorAll('.row-actions .icon-btn')).find((b) => (b.getAttribute('aria-label') ?? '').includes('新建会话'));
  if (btn !== undefined) { btn.click(); }
  // 点完就交差：宿主重启 + 窗口重载会把本上下文刷掉，后面的断言在 pwsh 侧做。
  await wait(900);
  return { activeBefore, target, clicked: btn !== undefined };
})()
'@

$env:DSC_DESKTOP_USER_DATA = Join-Path $swHome 'electron-userdata'
$env:USERPROFILE = $swHome
$env:HOME = $swHome
$env:DSC_DESKTOP_STATE = Join-Path $swDsc 'desktop.json'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SHOT = Join-Path $swShots 'ui-switch-cwd.png'
$env:DSC_DESKTOP_SHOT_DELAY = '40000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '30000'
$env:DSC_DESKTOP_SHOT_EVAL = $swEval
Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue
Remove-Item Env:DSC_UI_QUERY -ErrorAction SilentlyContinue

$outLog = Join-Path $swShots 'ui-switch-cwd.out.log'
$errLog = Join-Path $swShots 'ui-switch-cwd.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue

try {
  $swProc = Start-Process -FilePath $swElectron -ArgumentList $swEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $swDeadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $swDeadline) {
    if (Test-Path -LiteralPath $errLog) {
      $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|页面加载失败|截图失败' -ErrorAction SilentlyContinue
      if ($null -ne $hit) { break }
    }
    if ($swProc.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
  & taskkill /PID $swProc.Id /T /F 2>&1 | Out-Null
  Start-Sleep -Milliseconds 600
} finally {
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_USER_DATA,
    Env:DSC_DESKTOP_STATE -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $errLog) {
  Select-String -LiteralPath $errLog -Pattern '界面形态=|窗口来自宿主界面服务|预跑脚本完成|预跑脚本失败|已写出|页面加载失败|截图失败' |
    ForEach-Object { '  ' + $_.Line.Trim() }
  $swLogText = Get-Content -LiteralPath $errLog -Raw
  $swRestarts = ([regex]::Matches($swLogText, '界面形态=')).Count
  $swReloaded = $swLogText -match '（宿主重启，窗口重新加载）'
  Write-Output ("宿主重启次数（应 = 2）：{0}" -f $swRestarts)
  Write-Output ("窗口重载到新源（应有）：{0}" -f $swReloaded)
}

$swState = Get-Content -LiteralPath (Join-Path $swDsc 'desktop.json') -Raw | ConvertFrom-Json
Write-Output ("desktop.json lastCwd（应 = D:\dsc）：{0}" -f $swState.lastCwd)
Write-Output 'ui-switch-cwd-check 完成'
