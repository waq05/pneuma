# 审批卡截图：把一张真的审批卡留在屏幕上，截一张图（0.7.1 卡片改版的视觉验收）。
#
# 做法与 v1-walkthrough.ps1 同一套：隔离 HOME + 假模型端点 + 真 Electron。
# 区别只在预跑脚本——这里不点任何决定按钮，让卡一直挂着，截图才能拍到它。
#
# 用法（先在 desktop/ 跑 `pnpm run build`，根目录跑过 `pnpm run build:ui`）：
#   pwsh -NoProfile -File approval-shot.ps1
#
# 产物：desktop/shots/approval-card.png
$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$vt = 'D:\dsc\desktop\shots'
$vtElectron = Join-Path $vt '..\node_modules\electron\dist\electron.exe'
$vtEntry = Join-Path $vt '..\out\main\index.js'
$vtHome = Join-Path $vt 'ui-home'

$vtEvalHead = @'
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

$vtEval = @'
(async () => {
  const out = { steps: [] };
  const box = await waitFor(() => document.querySelector('.composer textarea'), 20000);
  if (box === null) { out.error = '输入框没出现'; return out; }
  setVal(box, '帮我在工作区外写一个探测文件。');
  await wait(150);
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  out.steps.push('已发送');
  const card = await waitFor(() => document.querySelector('.approval'), 30000);
  if (card === null) {
    out.error = '审批卡没出现';
    out.body = document.body.innerText.slice(0, 200);
    return out;
  }
  await wait(1200);
  const again = document.querySelector('.approval');
  out.stillThere = again !== null;
  if (again !== null) {
    const rect = again.getBoundingClientRect();
    out.rect = [Math.round(rect.top), Math.round(rect.height)];
    out.display = getComputedStyle(again).display;
    out.href = location.href;
  }
  out.tool = text(card.querySelector('.tool-name'));
  out.meaning = text(card.querySelector('.approval-meaning'));
  out.args = text(card.querySelector('.approval-args'));
  out.reason = text(card.querySelector('.approval-reason'));
  out.badges = Array.from(card.querySelectorAll('.risk-badge')).map(text);
  out.buttons = Array.from(card.querySelectorAll('.approval-actions button')).map((b) => b.textContent.trim());
  out.hint = text(card.querySelector('.hint'));
  return out;
})()
'@

node (Join-Path $vt 'ui-seed.mjs') | Out-Null

$vtTarget = (Join-Path $env:TEMP 'dsc-approval-shot\probe.md') -replace '\\', '/'
$vtSettingsPath = Join-Path $vtHome '.dsc\settings.json'
$vtSettings = Get-Content -LiteralPath $vtSettingsPath -Raw
Set-Content -LiteralPath $vtSettingsPath -Value $vtSettings.Replace('"defaultPolicy": "readonly"', '"defaultPolicy": "auto-edit"') -Encoding utf8
Remove-Item -LiteralPath ([System.IO.Path]::GetDirectoryName($vtTarget)) -Recurse -Force -ErrorAction SilentlyContinue
$env:DSC_V1_PROBE_TARGET = $vtTarget

$vtServerLog = Join-Path $vt 'v1-server.out.log'
Remove-Item -LiteralPath $vtServerLog -ErrorAction SilentlyContinue
$vtServer = Start-Process -FilePath 'node' -ArgumentList (Join-Path $vt 'v1-fake-server.mjs') -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $vtServerLog -RedirectStandardError (Join-Path $vt 'v1-server.err.log')
$vtUp = $false
for ($i = 0; $i -lt 40; $i++) {
  $cli = New-Object System.Net.Sockets.TcpClient
  try { $cli.Connect('127.0.0.1', 18960); $vtUp = $true; break } catch { Start-Sleep -Milliseconds 250 } finally { $cli.Dispose() }
}
if (-not $vtUp) {
  Stop-Process -Id $vtServer.Id -Force -ErrorAction SilentlyContinue
  throw '假端点 127.0.0.1:18960 没起来'
}
Write-Output '假端点已就绪（127.0.0.1:18960）'

try {
  $env:DSC_DESKTOP_USER_DATA = Join-Path $vtHome 'electron-userdata'
  $env:USERPROFILE = $vtHome
  $env:HOME = $vtHome
  $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
  $env:UI_FAKE_KEY = 'e2e-fake-key'
  $env:DSC_DESKTOP_SHOT = Join-Path $vt 'approval-card.png'
  # 卡片大约在第 15 秒挂上；截图放在 40 秒，中间留足渲染时间。
  $env:DSC_DESKTOP_SHOT_DELAY = '60000'
  $env:DSC_DESKTOP_SHOT_EVAL_LEAD = '20000'
  $env:DSC_DESKTOP_SHOT_EVAL = ($vtEvalHead + $vtEval)
  Remove-Item Env:DSC_DESKTOP_SEARCH, Env:DSC_RESUME_SESSION -ErrorAction SilentlyContinue

  $vtOutLog = Join-Path $vt 'approval-shot.out.log'
  $vtErrLog = Join-Path $vt 'approval-shot.err.log'
  Remove-Item -LiteralPath $vtOutLog, $vtErrLog -ErrorAction SilentlyContinue

  $vtProc = Start-Process -FilePath $vtElectron -ArgumentList $vtEntry -PassThru -RedirectStandardOutput $vtOutLog -RedirectStandardError $vtErrLog
  $vtDeadline = (Get-Date).AddSeconds(150)
  while ((Get-Date) -lt $vtDeadline) {
    if ($vtProc.HasExited) { break }
    if (Test-Path -LiteralPath $vtErrLog) {
      $hit = Select-String -LiteralPath $vtErrLog -Pattern '已写出|截图超时|截图失败' -ErrorAction SilentlyContinue
      if ($null -ne $hit) { Write-Output ('  ' + $hit[0].Line); break }
    }
    Start-Sleep -Milliseconds 500
  }
  & taskkill /PID $vtProc.Id /T /F 2>&1 | Out-Null
  Start-Sleep -Milliseconds 600

  if (Test-Path -LiteralPath $vtErrLog) {
    Select-String -LiteralPath $vtErrLog -Pattern '预跑脚本完成|预跑脚本失败' -ErrorAction SilentlyContinue |
      ForEach-Object { '  ' + $_.Line }
  }
} finally {
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_SEARCH,
    Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_USER_DATA, Env:UI_FAKE_KEY, Env:DSC_V1_PROBE_TARGET -ErrorAction SilentlyContinue
  Stop-Process -Id $vtServer.Id -Force -ErrorAction SilentlyContinue
}
