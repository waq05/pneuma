# 折叠三缺陷的隔离桌面自检（截图 + 取证）。
#
# 隔离怎么做：DSC_DESKTOP_USER_DATA 换掉 Electron 的 userData，USERPROFILE / HOME 换掉宿主的
# ~/.dsc——会话、配置、settings 全落在 desktop/shots/fold-fix-home 下，用户真实的 ~/.dsc 一个
# 字节都不写。种子见 scripts/ui-fold-fix-seed.mjs，假端点见 scripts/ui-fold-fix-fake-llm.mjs。
# 跑前跑后各对真实 ~/.dsc 做一次指纹比对（文件数 + 全量内容哈希），两个指纹都写进输出。
#
# 用法（先跑 pnpm run build 与 pnpm run build:ui 与 pnpm --dir desktop build，否则拍的是旧包）：
#   pwsh -NoProfile -File scripts/ui-fold-fix-shots.ps1
#   pwsh -NoProfile -File scripts/ui-fold-fix-shots.ps1 -Only fold-fix-tail
#
# 每个用例把证据打成一行 JSON（stderr 里搜「预跑脚本完成」），截图落在 desktop/shots/fold-fix-*.png。

param([string]$Only = 'all')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$fixRoot = 'D:\dsc'
$fixShots = Join-Path $fixRoot 'desktop\shots'
$fixElectron = Join-Path $fixRoot 'desktop\node_modules\electron\dist\electron.exe'
$fixEntry = Join-Path $fixRoot 'desktop\out\main\index.js'
$fixHome = Join-Path $fixShots 'fold-fix-home'
$fixPort = 18952
# 真实用户目录：必须在把 USERPROFILE/HOME 指到隔离目录之前读出来。
$fixRealDsc = Join-Path $env:USERPROFILE '.dsc'

# ── 真实 ~/.dsc 的指纹：文件数 + 「相对路径|字节数|SHA256」全量清单的聚合哈希 ──────────
function Get-DirFingerprint([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ Count = -1; Digest = 'MISSING'; Locked = 0 } }
  $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Sort-Object FullName)
  $lines = New-Object System.Collections.Generic.List[string]
  $locked = 0
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($Path.Length)
    $hash = 'LOCKED'
    try { $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash } catch { $locked += 1 }
    $lines.Add("$rel|$($file.Length)|$hash")
  }
  $joined = [string]::Join("`n", $lines)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $digest = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($joined))).Replace('-', '').ToLowerInvariant()
  return [pscustomobject]@{ Count = $files.Count; Digest = $digest; Locked = $locked }
}

# ── 预跑脚本里反复用到的探针 ────────────────────────────────────────────────────
$fixHead = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = pred(); if (v) return v; await wait(150); }
  return null;
};
const shape = (el) => {
  const b = el.getBoundingClientRect();
  return { t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height) };
};
const text = (el) => (el === null || el === undefined ? null : el.textContent.replace(/\s+/g, ' ').trim());
const toggles = () => Array.from(document.querySelectorAll('.turn-fold'));
const steps = () => Array.from(document.querySelectorAll('.step-fold'));
const cards = () => Array.from(document.querySelectorAll('.tool-card'));
const chat = () => document.querySelector('.chat');
// 看得见 = 没有被 hidden 祖先挡住、也没有零高度
const shown = (el) => el.closest('[hidden]') === null && el.getBoundingClientRect().height > 0;
const cardInfo = (card) => ({
  status: text(card.querySelector('.status')),
  cls: card.className,
  spinning: card.querySelector('.tc-spin') !== null,
  line: text(card).slice(0, 90),
});
'@

# ── 用例 1：缺陷一 · 紧凑档，收起态下总开关下面不再挂尾巴 ────────────────────────
$fixTailEval = ($fixHead + @'

(async () => {
  const ready = await waitFor(() => (document.querySelectorAll('.entry-user').length >= 1 && toggles().length >= 1) ? true : null, 30000);
  if (ready === null) return { case: 'fold-fix-tail', error: '没等到会话与总开关' };
  await wait(1200);
  const fold = toggles()[0];
  const round = Number(fold.dataset.roundIndex);
  const seat = document.querySelector('.turn-seat[data-round-seat="' + String(round) + '"]');
  const count = (sel) => seat.querySelectorAll(sel).length;
  const visible = (sel) => Array.from(seat.querySelectorAll(sel)).filter(shown).length;
  const foldBox = fold.getBoundingClientRect();
  // 总开关下面还看得见的行（修之前就是那 3 条思考 + 2 条工具）
  // 只数过程行（思考 / 工具卡 / 正文）；开场提示那类 system 行本来就不属于这一轮的过程区。
  const below = Array.from(seat.querySelectorAll('.entry-row'))
    .filter((row) => shown(row) && row.getBoundingClientRect().top > foldBox.bottom - 2)
    .filter((row) => row.querySelector('.think-block, .tool-card, .entry-text') !== null)
    .map((row) => row.className + ' :: ' + text(row).slice(0, 60));
  const info = {
    label: text(fold),
    ariaExpanded: fold.getAttribute('aria-expanded'),
    open: fold.dataset.open ?? null,
    disabled: fold.disabled === true,
    round,
    thinkInDom: count('.think-block'),
    thinkVisible: visible('.think-block'),
    toolsInDom: count('.tool-card'),
    toolsVisible: visible('.tool-card'),
    textsInDom: count('.entry-text'),
    textsVisible: visible('.entry-text'),
    below,
  };
  fold.scrollIntoView({ block: 'center' });
  await wait(700);
  return {
    case: 'fold-fix-tail',
    info,
    folded: info.ariaExpanded === 'false' && info.open === null,
    tailHidden: below.length === 0 && info.thinkVisible === 0 && info.toolsVisible === 0,
  };
})()
'@)

# ── 用例 2 / 3：缺陷二 · 跑动中的阶段组，标准档有实时详情、紧凑档没有 ─────────────
$fixLiveEval = ($fixHead + @'

(async () => {
  // 等界面把这条会话铺出来、再过两拍才提交：提交得太早会赶上宿主那边的重放，
  // 同一轮的内容会在屏幕上出现两份（第一版就是这么拍出鬼影的）。
  const base = await waitFor(() => (document.querySelectorAll('.entry-user').length >= 1 && chat() !== null) ? true : null, 40000);
  if (base === null) return { case: 'fold-fix-live', error: '没等到会话' };
  await wait(2500);
  await window.dsc.invoke('submit', ['跑一次构建，顺便读一下样张文件。', undefined]);
  const step = await waitFor(() => {
    const running = steps().filter((el) => el.dataset.stepClosed === undefined);
    return running.find((el) => el.dataset.stepSize === '2') ?? null;
  }, 45000);
  if (step === null) {
    return {
      case: 'fold-fix-live',
      error: '没等到跑动中的两条工具组',
      users: document.querySelectorAll('.entry-user').length,
      steps: steps().map((el) => ({ closed: el.dataset.stepClosed ?? null, size: el.dataset.stepSize ?? null, label: text(el), detail: el.dataset.stepDetail ?? null })),
    };
  }
  await wait(800);
  const detailEl = step.querySelector('.step-fold-detail');
  const info = {
    label: text(step.querySelector('.step-fold-label')),
    detailAttr: step.dataset.stepDetail ?? null,
    detailText: text(detailEl),
    closed: step.dataset.stepClosed ?? null,
    size: step.dataset.stepSize,
    activity: step.dataset.stepActivity,
    counts: step.dataset.stepCounts,
    oneLine: step.querySelector('.step-fold-line') === null ? null : Math.round(shape(step.querySelector('.step-fold-line')).h),
  };
  step.scrollIntoView({ block: 'center' });
  await wait(800);
  return {
    case: 'fold-fix-live',
    info,
    runningGroup: info.closed === null && info.size === '2',
    hasDetail: info.detailText !== null && info.detailText.length > 0 && info.detailAttr !== null,
  };
})()
'@)

# ── 用例 4：缺陷三 · 被中断（没有结果）的工具重开后不再是「进行中」 ──────────────
$fixOrphanEval = ($fixHead + @'

(async () => {
  const ready = await waitFor(() => document.querySelectorAll('.entry-user').length >= 2 ? true : null, 30000);
  if (ready === null) return { case: 'fold-fix-orphan', error: '没等到两轮对话' };
  await wait(1000);
  const fold = document.querySelector('.turn-fold[data-round-index="0"]');
  if (fold !== null && fold.getAttribute('aria-expanded') === 'false') {
    fold.click();
    await wait(900);
  }
  const list = cards().map(cardInfo);
  if (fold !== null) fold.scrollIntoView({ block: 'center' });
  await wait(600);
  return {
    case: 'fold-fix-orphan',
    foldFound: fold !== null,
    cards: list,
    running: list.filter((card) => card.cls.includes('status-running')).length,
    statuses: list.map((card) => card.status),
    noRunning: list.every((card) => card.cls.includes('status-running') === false && card.spinning === false),
  };
})()
'@)

# ── 用例表 ─────────────────────────────────────────────────────────────────────
# delay = 页面加载完成后多少毫秒截图；lead = 截图前多少毫秒开始跑预跑脚本。
$fixCases = [ordered]@{
  'fold-fix-tail'          = @{ delay = 60000; lead = 40000; processFold = 'compact';  session = 'tail';   live = $false; eval = $fixTailEval }
  'fold-fix-live-standard' = @{ delay = 90000; lead = 60000; processFold = 'standard'; session = 'live';   live = $true;  eval = $fixLiveEval }
  'fold-fix-live-compact'  = @{ delay = 90000; lead = 60000; processFold = 'compact';  session = 'live';   live = $true;  eval = $fixLiveEval }
  'fold-fix-orphan'        = @{ delay = 60000; lead = 40000; processFold = 'standard'; session = 'orphan'; live = $false; eval = $fixOrphanEval }
}

$script:fixServer = $null
function Start-FixFake {
  if ($script:fixServer -ne $null) { return }
  $script:fixServer = Start-Process -FilePath 'node' -ArgumentList (Join-Path $fixRoot 'scripts\ui-fold-fix-fake-llm.mjs'), $fixPort -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 900
}
function Stop-FixFake {
  if ($script:fixServer -ne $null) {
    & taskkill /PID $script:fixServer.Id /T /F 2>&1 | Out-Null
    $script:fixServer = $null
  }
}

Write-Output '=== 真实 ~/.dsc 跑前指纹 ==='
$fixBefore = Get-DirFingerprint $fixRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 内容聚合 {2}" -f $fixBefore.Count, $fixBefore.Locked, $fixBefore.Digest)

try {
  foreach ($name in $fixCases.Keys) {
    if ($Only -ne 'all' -and $Only -ne $name) { continue }
    $spec = $fixCases[$name]

    # 每个用例重新造种子：会话文件是新的（随机 id），档位也在这里定
    $env:FOLD_FIX_HOME = $fixHome
    $env:FOLD_FIX_PROCESS = $spec.processFold
    $env:FOLD_FIX_PORT = [string]$fixPort
    Remove-Item Env:FOLD_FIX_OUT -ErrorAction SilentlyContinue
    node (Join-Path $fixRoot 'scripts\ui-fold-fix-seed.mjs') | Out-Null
    $fixSessions = Get-Content (Join-Path $fixHome 'sessions.json') -Raw | ConvertFrom-Json

    # 上一轮没杀干净的电子窗（用户数据目录是这个隔离目录的）会抢单实例锁，先按 PID 精确清掉。
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
      Where-Object { $_.CommandLine -like '*fold-fix-home*' } |
      ForEach-Object { & taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }
    Start-Sleep -Milliseconds 700

    if ($spec.live) { Stop-FixFake; Start-FixFake } else { Stop-FixFake }

    $env:DSC_DESKTOP_USER_DATA = Join-Path $fixHome 'electron-userdata'
    $env:USERPROFILE = $fixHome
    $env:HOME = $fixHome
    $env:FOLD_FIX_KEY = 'sk-selfcheck-fake'
    $env:FOLD_FIX_TARGET = $fixSessions.probeTarget
    $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
    $env:DSC_RESUME_SESSION = $fixSessions.($spec.session)
    $env:DSC_DESKTOP_SHOT = Join-Path $fixShots ($name + '.png')
    $env:DSC_DESKTOP_SHOT_DELAY = [string]$spec.delay
    $env:DSC_DESKTOP_SHOT_EVAL_LEAD = [string]$spec.lead
    $env:DSC_DESKTOP_SHOT_EVAL = $spec.eval
    Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue

    $outLog = Join-Path $fixShots ($name + '.out.log')
    $errLog = Join-Path $fixShots ($name + '.err.log')
    Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
    Write-Output "=== $name（档位 $($spec.processFold)；隔离目录 $fixHome）==="

    # --disable-gpu：这台机器上 GPU 合成偶尔报 UnknownVizError（截图拿不到显示面），
    # 软件合成下 capturePage 稳定得多；画面内容与真机一致（同一份产物、同一套样式）。
    $fixProc = Start-Process -FilePath $fixElectron -ArgumentList $fixEntry, '--disable-gpu' -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $fixDeadline = (Get-Date).AddSeconds($spec.delay + 90)
    $fixSeen = ''
    while ((Get-Date) -lt $fixDeadline) {
      if (Test-Path -LiteralPath $errLog) {
        $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|页面加载失败|截图失败' -ErrorAction SilentlyContinue
        if ($null -ne $hit) { $fixSeen = $hit[0].Line; break }
      }
      if ($fixProc.HasExited) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not $fixProc.HasExited) {
      & taskkill /PID $fixProc.Id /T /F 2>&1 | Out-Null
      Start-Sleep -Milliseconds 600
    } else {
      & taskkill /PID $fixProc.Id /T /F 2>&1 | Out-Null
    }
    Write-Output ("  electron 已收工：{0}" -f ($fixSeen -replace '\s+$', ''))

    if (Test-Path -LiteralPath $errLog) {
      Select-String -LiteralPath $errLog -Pattern '预跑脚本完成|预跑脚本失败|已写出|页面加载失败' |
        ForEach-Object { '  ' + $_.Line }
    }
  }
} finally {
  Stop-FixFake
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_SEARCH,
    Env:DSC_DESKTOP_USER_DATA, Env:FOLD_FIX_HOME, Env:FOLD_FIX_PROCESS, Env:FOLD_FIX_PORT,
    Env:FOLD_FIX_KEY, Env:FOLD_FIX_TARGET -ErrorAction SilentlyContinue
}

Write-Output '=== 真实 ~/.dsc 跑后指纹 ==='
$fixAfter = Get-DirFingerprint $fixRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 内容聚合 {2}" -f $fixAfter.Count, $fixAfter.Locked, $fixAfter.Digest)
Write-Output ("文件数一致：{0}；内容聚合一致：{1}" -f ($fixBefore.Count -eq $fixAfter.Count), ($fixBefore.Digest -eq $fixAfter.Digest))
Write-Output '全部完成'
