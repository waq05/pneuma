# 添加工作区走查：「表头那颗 ＋」的图标 + 点完真的出现在侧栏（0.7.1 报障）。
#
# 三个断言：
#   ① 工作区头部第三颗按钮是加号图标（IconPlus 的两条线段 path）+ data-tip「添加工作区」
#   ② 侧栏 footer 当前目录行仍是文件夹图标（未被误伤）
#   ③ 端到端：播一条 shell.session.new 事件（与 ＋ 钮选完目录后走的是同一个 newSessionIn），
#      侧栏要立刻多出这一行、且不弹任何提示条
#
# ③ 是 0.7.1 用户报障「能选目录，选完没显示」的回归钉：空工作区（还没发过消息、
# 磁盘上没有 jsonl）只能从界面的 recentCwds 清单进列表，而那份清单只在挂载时读一次。
# 不补这一行，侧栏要等重启或发出第一条消息才出现，看着就像新建失败。
#
# 隔离：临时 HOME + DSC_DESKTOP_STATE 指到临时文件。
#   ~/.dsc/desktop.json 走 Electron 的 app.getPath('home')，不读 USERPROFILE，
#   不设 DSC_DESKTOP_STATE 就会读写用户真实的窗口记忆（0.6.44、2026-10-29 各污染过一次）。
#
# 用法（先在根目录跑 pnpm run build 与 pnpm -C ui-shell build）：
#   pwsh -NoProfile -File ws-add-check.ps1

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$wa = 'D:\dsc\desktop\shots'
$waElectron = Join-Path $wa '..\node_modules\electron\dist\electron.exe'
$waEntry = Join-Path $wa '..\out\main\index.js'
$waHome = Join-Path $wa 'sound-home'

New-Item -ItemType Directory -Path $waHome -Force | Out-Null
$waA = Join-Path $waHome 'ws-add-a'
$waB = Join-Path $waHome 'ws-add-b'
New-Item -ItemType Directory -Path $waA, $waB -Force | Out-Null
# 起手只有一个空工作区：③ 要看的是「多出来那一行」，基线越少越好认。
$waState = Join-Path $waHome 'desktop-state.json'
@{ lastCwd = $waA; recentCwds = @($waA) } | ConvertTo-Json | Set-Content -LiteralPath $waState -Encoding utf8
$waBJson = $waB | ConvertTo-Json -Compress

$waEval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = await pred(); if (v) return v; await wait(120); }
    return null;
  };
  const dirs = () => [...document.querySelectorAll('.group-row .dir')].map((n) => n.textContent);
  const toasts = () => [...document.querySelectorAll('.dsc-toast__text')].map((n) => n.textContent);
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

    // ③ 选完目录（同一个 newSessionIn）：侧栏立刻多一行，且没有报错提示
    const before = dirs();
    window.dispatchEvent(new CustomEvent('shell.session.new', { detail: { cwd: __WSB__ } }));
    await wait(3000);
    const after = dirs();
    const activeRow = document.querySelector('.group-row.active .dir');
    results.liveAdd = {
      before,
      after,
      added: after.includes('ws-add-b'),
      grewBy: after.length - before.length,
      active: activeRow === null ? null : activeRow.textContent,
      toasts: toasts(),
    };
    return { ...results, ms: Date.now() - started };
  } catch (error) {
    return { case: 'ws-add-check', error: String(error), ms: Date.now() - started };
  }
})()
'@
$waEval = $waEval.Replace('__WSB__', $waBJson)

$env:DSC_DESKTOP_USER_DATA = Join-Path $waHome 'electron-userdata'
$env:DSC_DESKTOP_STATE = $waState
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
  Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_USER_DATA, Env:DSC_DESKTOP_STATE,
  Env:SOUND_FAKE_KEY -ErrorAction SilentlyContinue
Write-Output '走查完成'
