# `/` 命令菜单截图：打一个 `/`，把菜单留在屏幕上，截一张图（0.7.1 菜单改版的视觉验收）。
#
# 与 approval-shot.ps1 同一套做法：隔离 HOME + 假模型端点 + 真 Electron。区别只在预跑
# 脚本——这里往输入框里打一个 `/` 让候选面板弹出来，然后什么都不点，等截图。
#
# 用法（先在 desktop/ 跑 `pnpm run build`，根目录跑过 `pnpm run build:ui`）：
#   pwsh -NoProfile -File slash-menu-shot.ps1
#
# 产物：desktop/shots/slash-menu.png
$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$sm = 'D:\dsc\desktop\shots'
$smElectron = Join-Path $sm '..\node_modules\electron\dist\electron.exe'
$smEntry = Join-Path $sm '..\out\main\index.js'
$smHome = Join-Path $sm 'ui-home'

$smEvalHead = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await pred(); if (v) return v; await wait(120); }
  return null;
};
const text = (el) => (el === null || el === undefined ? null : el.textContent.trim());
const setVal = (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
'@

$smEval = @'
(async () => {
  const out = { rows: [], steps: [] };
  const box = await waitFor(() => document.querySelector('.composer textarea'), 25000);
  if (box === null) { out.error = '输入框没出现'; out.body = document.body.innerText.slice(0, 300); return out; }
  box.focus();
  setVal(box, '/');
  const pop = await waitFor(() => document.querySelector('.slash-pop'), 15000);
  if (pop === null) { out.error = '菜单没弹出'; out.body = document.body.innerText.slice(0, 300); return out; }
  await wait(600);
  out.sections = Array.from(pop.querySelectorAll('.slash-section')).map(text);
  out.rows = Array.from(pop.querySelectorAll('.slash-item')).map((row) => ({
    icon: row.querySelector('.slash-icon svg') !== null,
    label: text(row.querySelector('.slash-label')),
    name: text(row.querySelector('.slash-name')),
    desc: text(row.querySelector('.slash-desc')),
    descAlign: row.querySelector('.slash-desc') === null ? null : getComputedStyle(row.querySelector('.slash-desc')).textAlign,
    height: Math.round(row.getBoundingClientRect().height),
  }));
  out.hint = text(pop.querySelector('.slash-hint'));
  const first = pop.querySelector('.slash-item');
  if (first !== null) {
    const style = getComputedStyle(first);
    out.rowStyle = { display: style.display, gap: style.gap, minHeight: style.minHeight };
  }
  out.href = location.href;
  return out;
})()
'@

node (Join-Path $sm 'ui-seed.mjs') | Out-Null

$smServerLog = Join-Path $sm 'v1-server.out.log'
Remove-Item -LiteralPath $smServerLog -ErrorAction SilentlyContinue
$smServer = Start-Process -FilePath 'node' -ArgumentList (Join-Path $sm 'v1-fake-server.mjs') -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $smServerLog -RedirectStandardError (Join-Path $sm 'v1-server.err.log')
$smUp = $false
for ($i = 0; $i -lt 40; $i++) {
  $cli = New-Object System.Net.Sockets.TcpClient
  try { $cli.Connect('127.0.0.1', 18960); $smUp = $true; break } catch { Start-Sleep -Milliseconds 250 } finally { $cli.Dispose() }
}
if (-not $smUp) {
  Stop-Process -Id $smServer.Id -Force -ErrorAction SilentlyContinue
  throw '假端点 127.0.0.1:18960 没起来'
}
Write-Output '假端点已就绪（127.0.0.1:18960）'

try {
  $env:DSC_DESKTOP_USER_DATA = Join-Path $smHome 'electron-userdata'
  $env:USERPROFILE = $smHome
  $env:HOME = $smHome
  $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
  $env:UI_FAKE_KEY = 'e2e-fake-key'
  $env:DSC_DESKTOP_SHOT = Join-Path $sm 'slash-menu.png'
  # 菜单在第 20 秒左右弹出来；截图放在 50 秒，留足渲染时间。
  $env:DSC_DESKTOP_SHOT_DELAY = '50000'
  $env:DSC_DESKTOP_SHOT_EVAL_LEAD = '18000'
  $env:DSC_DESKTOP_SHOT_EVAL = ($smEvalHead + $smEval)
  Remove-Item Env:DSC_DESKTOP_SEARCH, Env:DSC_RESUME_SESSION -ErrorAction SilentlyContinue

  $smOutLog = Join-Path $sm 'slash-menu.out.log'
  $smErrLog = Join-Path $sm 'slash-menu.err.log'
  Remove-Item -LiteralPath $smOutLog, $smErrLog -ErrorAction SilentlyContinue

  $smProc = Start-Process -FilePath $smElectron -ArgumentList $smEntry -PassThru -RedirectStandardOutput $smOutLog -RedirectStandardError $smErrLog
  $smDeadline = (Get-Date).AddSeconds(140)
  while ((Get-Date) -lt $smDeadline) {
    if ($smProc.HasExited) { break }
    if (Test-Path -LiteralPath $smErrLog) {
      $hit = Select-String -LiteralPath $smErrLog -Pattern '已写出|截图超时|截图失败' -ErrorAction SilentlyContinue
      if ($null -ne $hit) { Write-Output ('  ' + $hit[0].Line); break }
    }
    Start-Sleep -Milliseconds 500
  }
  & taskkill /PID $smProc.Id /T /F 2>&1 | Out-Null
  Start-Sleep -Milliseconds 600

  if (Test-Path -LiteralPath $smErrLog) {
    Select-String -LiteralPath $smErrLog -Pattern '预跑脚本完成|预跑脚本失败' -ErrorAction SilentlyContinue |
      ForEach-Object { '  ' + $_.Line }
  }
} finally {
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_SEARCH,
    Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_USER_DATA, Env:UI_FAKE_KEY -ErrorAction SilentlyContinue
  Stop-Process -Id $smServer.Id -Force -ErrorAction SilentlyContinue
}
