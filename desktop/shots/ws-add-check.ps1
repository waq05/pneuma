# 添加工作区走查（0.6.44）：「添加工作区」按钮图标断言（dsh 的 add-workspace 同款加号）。
#
# 注意：原设计想走 switchCwd('C:\Windows') + openSession 端到端验证「选完目录组立即出现」，
# 但 restartHost 链路会绕过 USERPROFILE 覆盖——主进程状态（~/.dsc/desktop.json：lastCwd /
# recentCwds）走 Electron 的 os.homedir()，永远落在真实 HOME（0.6.44 实测污染过一次已还原）。
# 所以本脚本只做无污染的 DOM 断言，「组立即出现」一环由根侧探针 ws-add-groups-check.mjs
# 钉住（buildWorkGroups 对 recentCwds 空组的契约）；onChooseDir → switchCwd 全套是渲染层
# 一行复用（typecheck 保证），端到端装包人工点一遍即可。
#
# 断言：
#   ① 工作区头部第三颗按钮是加号图标（IconPlus 的两条线段 path）+ data-tip「添加工作区」
#   ② 侧栏 footer 当前目录行仍是文件夹图标（未被误伤）
#
# 用法（先在 desktop/ 跑 `pnpm run build`）：
#   pwsh -NoProfile -File ws-add-check.ps1

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
  const started = Date.now();
  try {
    await waitFor(() => document.querySelector('.group-row'), 20000);
    await wait(800);
    const results = { case: 'ws-add-check' };

    // ① 头部按钮：data-tip 是添加工作区、svg 是 IconPlus 的两条线段
    const btn = document.querySelector('.section-head .icon-btn[data-tip^="添加工作区"]');
    if (btn === null) return { ...results, error: '添加工作区按钮没找到', tips: [...document.querySelectorAll('.icon-btn')].map((b) => b.getAttribute('data-tip')) };
    const paths = [...btn.querySelectorAll('svg path')].map((p) => p.getAttribute('d'));
    results.addBtn = {
      tip: btn.getAttribute('data-tip'),
      plusPathOk: paths.includes('M12 5v14') && paths.includes('M5 12h14'),
      pathCount: paths.length,
    };

    // ② footer 当前目录行保持文件夹图标
    const footerIcon = document.querySelector('.sidebar-footer .row svg path');
    results.footerRow = { present: footerIcon !== null };
    return { ...results, ms: Date.now() - started };
  } catch (error) {
    return { case: 'ws-add-check', error: String(error), ms: Date.now() - started };
  }
})()
'@

$env:DSC_DESKTOP_USER_DATA = Join-Path $waHome 'electron-userdata'
$env:USERPROFILE = $waHome
$env:HOME = $waHome
$env:SOUND_FAKE_KEY = 'e2e-fake-key'
$env:DSC_DESKTOP_SHOT = Join-Path $wa 'ws-add-check.png'
$env:DSC_DESKTOP_SHOT_DELAY = '30000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '15000'
$env:DSC_DESKTOP_SHOT_EVAL = $waEval
Remove-Item Env:DSC_DESKTOP_SHOT_TOPMOST -ErrorAction SilentlyContinue
Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue

$outLog = Join-Path $wa 'ws-add-check.out.log'
$errLog = Join-Path $wa 'ws-add-check.err.log'
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
Write-Output '走查完成'
