# 诊断区勘查：读实机（隔离）里诊断面板的内容——「1 处故障」到底是什么。
# 用法：pwsh -NoProfile -File diag-check.ps1（壳产物需已构建）

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$swShots = 'D:\dsc\desktop\shots'
$swElectron = Join-Path $swShots '..\node_modules\electron\dist\electron.exe'
$swEntry = Join-Path $swShots '..\out\main\index.js'
$swHome = Join-Path $swShots 'shell-switch-home'

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
  const diag = document.querySelector('.diagnostics');
  const bad = Array.from(document.querySelectorAll('.diag-plugins .bad')).map((li) => (li.textContent ?? '').trim());
  const faults = Array.from(document.querySelectorAll('[data-fault]')).map((li) => (li.textContent ?? '').trim());
  const plugins = Array.from(document.querySelectorAll('.diag-plugins li[data-plugin]')).map((li) => ({
    id: li.getAttribute('data-plugin'),
    ok: li.classList.contains('ok'),
    text: (li.textContent ?? '').trim(),
  }));
  return {
    hasDiag: diag !== null,
    diagOpen: diag === null ? null : diag.open,
    bad,
    faults,
    pluginOk: plugins.filter((p) => p.ok).length,
    pluginBad: plugins.filter((p) => !p.ok),
    slots: Array.from(document.querySelectorAll('.diag-line')).map((p) => (p.textContent ?? '').trim()).slice(0, 6),
  };
})()
'@

$env:DSC_DESKTOP_USER_DATA = Join-Path $swHome 'electron-userdata'
$env:USERPROFILE = $swHome
$env:HOME = $swHome
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SHOT = Join-Path $swShots 'diag-check.png'
$env:DSC_DESKTOP_SHOT_DELAY = '22000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '18000'
$env:DSC_DESKTOP_SHOT_EVAL = $swEval
# 诊断区默认不常显（旧界面没有）；读它的 DOM 要走 diag=1。
$env:DSC_UI_QUERY = 'diag=1'
Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue

$outLog = Join-Path $swShots 'diag-check.out.log'
$errLog = Join-Path $swShots 'diag-check.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue

try {
  $swProc = Start-Process -FilePath $swElectron -ArgumentList $swEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $swDeadline = (Get-Date).AddSeconds(70)
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
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST,
    Env:DSC_DESKTOP_USER_DATA -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $errLog) {
  Select-String -LiteralPath $errLog -Pattern '预跑脚本完成|预跑脚本失败|已写出|页面加载失败|截图失败' |
    ForEach-Object { '  ' + $_.Line.Trim() }
}
Write-Output 'diag-check 完成'
