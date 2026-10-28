# 工作区图标 active 目检截图：只做「跨组点会话」一个动作，拍选中态（waq 组图标亮 + 会话行高亮）。
# 配套 ws-active-check.ps1（数值断言）；这条是给人看的。

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$wa = 'D:\dsc\desktop\shots'
$waElectron = Join-Path $wa '..\node_modules\electron\dist\electron.exe'
$waEntry = Join-Path $wa '..\out\main\index.js'
$waHome = Join-Path $wa 'sound-home'

$waEval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = await pred(); if (v) return v; await wait(120); }
    return null;
  };
  await waitFor(() => document.querySelector('.group-row'), 20000);
  await wait(1000);
  const groups = [...document.querySelectorAll('.group')];
  for (const g of groups) {
    const row = g.querySelector('.group-row');
    if (row === null || row.classList.contains('active')) continue;
    if (row.getAttribute('aria-expanded') === 'false') { row.click(); await wait(500); }
    const item = g.querySelector('.sess-item');
    if (item !== null) { item.click(); return { clicked: row.querySelector('.dir')?.textContent }; }
  }
  return { clicked: null };
})()
'@

$env:DSC_DESKTOP_USER_DATA = Join-Path $waHome 'electron-userdata'
$env:USERPROFILE = $waHome
$env:HOME = $waHome
$env:SOUND_FAKE_KEY = 'e2e-fake-key'
$env:DSC_DESKTOP_SHOT = Join-Path $wa 'ws-active-shot.png'
$env:DSC_DESKTOP_SHOT_DELAY = '30000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '15000'
$env:DSC_DESKTOP_SHOT_EVAL = $waEval
Remove-Item Env:DSC_DESKTOP_SHOT_TOPMOST -ErrorAction SilentlyContinue
Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue

$outLog = Join-Path $wa 'ws-active-shot.out.log'
$errLog = Join-Path $wa 'ws-active-shot.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $waElectron -ArgumentList $waEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
$deadline = (Get-Date).AddSeconds(55)
$seen = ''
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) { break }
  if (Test-Path -LiteralPath $errLog) {
    $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|截图失败|页面加载失败' -ErrorAction SilentlyContinue
    if ($null -ne $hit) { $seen = $hit[0].Line; break }
  }
  Start-Sleep -Milliseconds 800
}
& taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
Start-Sleep -Milliseconds 600
Write-Output ("electron 已收工：{0}" -f ($seen -replace '\s+$', ''))
Select-String -LiteralPath $errLog -Pattern '预跑脚本完成|预跑脚本失败' -ErrorAction SilentlyContinue |
  ForEach-Object { '  ' + $_.Line }

Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
  Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_USER_DATA, Env:SOUND_FAKE_KEY -ErrorAction SilentlyContinue
Write-Output '截图完成'
