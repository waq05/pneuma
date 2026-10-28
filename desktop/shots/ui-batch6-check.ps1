# 第六批专项自检（2026-10-12）：阶段组 / 旧 dock 动态页签系统 / 文件根=会话工作区 / 并排审查 / 浏览器页签。
#
# 种子场景（复刻用户报障的两个前提）：
#   ① 宿主启动目录（lastCwd = start-dir）≠ 会话 cwd（ws-b）——文件树必须显示 ws-b 的内容；
#   ② 一轮里两个阶段组（read+grep / bash）+ 正文收尾 + 最后回答 + changes 条目——
#      定稿后整轮默认收起，展开整轮后组头在、组默认收起、点组头能展开出成员。
#
# 硬验收（eval 读 DOM）：
#   A. 阶段组：.turn-fold（用时）在；点开后 .step-fold 组头 ≥ 2 个，data-step-counts 对；
#      组默认收起（.step-body[hidden]）→ 点组头 → 成员露出；组头文案是聚合句。
#   B. 文件树：Ctrl+P 开「文件」页签，根是当前会话工作区（marker-ws-b.txt，不是 start-dir）。
#   C. 开始页：点 `+` 出新 guide → 四张入口卡（工作区文件/新建终端/浏览器/Git 管理）+ 快捷键角标。
#   D. 终端多开/替换：开始页点「新建终端」→ guide 就地替换成 terminal 页签；shell 起得来（管道模式横幅）。
#   E. 分栏：页签右键菜单「向右分栏」→ 两个 .dock-pane + .dock-split；双击收回。
#   F. 全屏：chrome 第一钮切 .dock.mode-fullscreen，再点退出。
#   G. 浏览器页签：Ctrl+T → .browser-pane 空态；再按一次又多一张（2026-10 起可多开）。
#   H. 并排审查：改动卡点行 → .thread-zone[data-review] 里出现 .diff-pane（不在 dock 里）。
#   I. 收起/展开：chrome 第二钮 → .dock.collapsed + 顶栏 .dock-toggle 出现；点它再展开。
#   J. 预览页签：文件树点文件 → .file-preview-head（预览页签）。
#
# 隔离：USERPROFILE/HOME + DSC_DESKTOP_STATE + DSC_DESKTOP_USER_DATA 全钉在隔离目录；
# 跑前跑后对真实 ~/.dsc 做「文件数 + 内容聚合 SHA256」比对。
#
# 用法：pwsh -NoProfile -File ui-batch6-check.ps1（宿主 lib 与壳产物需已构建：
#       pnpm run build + pnpm run build:ui + desktop 的 pnpm run build）

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$swShots = 'D:\dsc\desktop\shots'
$swElectron = Join-Path $swShots '..\node_modules\electron\dist\electron.exe'
$swEntry = Join-Path $swShots '..\out\main\index.js'
$swHome = Join-Path $swShots 'batch6-home'
$swDsc = Join-Path $swHome '.dsc'
$swRealDsc = Join-Path $env:USERPROFILE '.dsc'
$swStart = Join-Path $swHome 'start-dir'
$swWsB = Join-Path $swHome 'ws-b'

function Get-DirFingerprint([string]$Path) {
  $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Sort-Object FullName)
  $lines = New-Object System.Collections.Generic.List[string]
  $locked = 0
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($Path.Length)
    $hash = 'LOCKED'
    try { $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash } catch { $locked += 1 }
    $lines.Add("$rel|$($file.Length)|$hash")
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $contentJoined = [string]::Join("`n", ($lines | ForEach-Object { $parts = $_ -split '\|'; "$($parts[0])|$($parts[2])" }))
  $contentDigest = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($contentJoined))).Replace('-', '').ToLowerInvariant()
  return [pscustomobject]@{ Count = $files.Count; ContentDigest = $contentDigest; Locked = $locked; Lines = $lines }
}

$swRealBefore = if (Test-Path -LiteralPath $swRealDsc) { Get-DirFingerprint $swRealDsc } else { $null }

# ── 种子：两个工作区 + 一条富会话（阶段组 / 改动卡 / 预览都用它）────────────────────
Remove-Item -Recurse -Force -LiteralPath $swHome -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $swDsc | Out-Null
New-Item -ItemType Directory -Force -Path $swStart | Out-Null
New-Item -ItemType Directory -Force -Path $swWsB | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $swHome 'AppData\Roaming') | Out-Null

Set-Content -LiteralPath (Join-Path $swStart 'marker-start-dir.txt') -Value 'start' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $swWsB 'marker-ws-b.txt') -Value 'ws' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $swWsB 'tsconfig.json') -Value '{}' -Encoding UTF8

$swKeyB = ($swWsB -replace '[:\\/]+', '-')
New-Item -ItemType Directory -Force -Path (Join-Path $swDsc "sessions\$swKeyB") | Out-Null

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$swUuid1 = 'c1111111-2222-3333-4444-555555555555'
$swMarker = ($swWsB -replace '\\', '\\')

$swFileA = ($swWsB + '\hover-a.txt')
$swFileAJson = ($swFileA -replace '\\', '\\')

$swHunks = "[{""oldStart"":0,""oldCount"":0,""newStart"":1,""newCount"":2,""lines"":[{""kind"":""add"",""text"":""第一行"",""oldLine"":null,""newLine"":1},{""kind"":""add"",""text"":""第二行"",""oldLine"":null,""newLine"":2}]}]"

$swLines = New-Object System.Collections.Generic.List[string]
$swLines.Add("{""type"":""meta"",""id"":""$swUuid1"",""cwd"":""$swMarker"",""createdAt"":$now}")
$swLines.Add("{""type"":""user"",""text"":""阶段组自检会话：先读配置再跑测试"",""ts"":$now}")
# 第一组：思考 + read + grep（read=1 / search=1）
$swLines.Add("{""type"":""assistant"",""text"":"""",""reasoning"":""先看看配置"",""toolCalls"":[{""id"":""t1"",""name"":""read"",""arguments"":""{\""path\"":\""tsconfig.json\""}""},{""id"":""t2"",""name"":""grep"",""arguments"":""{\""pattern\"":\""compilerOptions\""}""}],""ts"":$($now + 1000)}")
$swLines.Add("{""type"":""tool"",""callId"":""t1"",""name"":""read"",""text"":""读完了"",""ts"":$($now + 1200)}")
$swLines.Add("{""type"":""tool"",""callId"":""t2"",""name"":""grep"",""text"":""搜到了"",""ts"":$($now + 1400)}")
# 正文封第一组
$swLines.Add("{""type"":""assistant"",""text"":""配置看完了，接着跑一下校验。"",""reasoning"":"""",""ts"":$($now + 1600)}")
# 第二组：思考 + bash + changes
$swLines.Add("{""type"":""assistant"",""text"":"""",""reasoning"":""跑 pnpm 校验"",""toolCalls"":[{""id"":""t3"",""name"":""bash"",""arguments"":""{\""command\"":\""pnpm typecheck\""}""}],""ts"":$($now + 1800)}")
$swLines.Add("{""type"":""tool"",""callId"":""t3"",""name"":""bash"",""text"":""typecheck 通过"",""changes"":{""path"":""$swFileAJson"",""added"":2,""removed"":0,""status"":""added"",""hunks"":$swHunks},""ts"":$($now + 2200)}")
$swLines.Add("{""type"":""turn-end"",""reason"":""completed"",""ts"":$($now + 2400)}")
$swLines.Add("{""type"":""assistant"",""text"":""都通过了。改动落在 hover-a.txt。"",""reasoning"":"""",""ts"":$($now + 2600)}")
Set-Content -LiteralPath (Join-Path $swDsc "sessions\$swKeyB\$swUuid1.jsonl") -Value $swLines -Encoding UTF8

Set-Content -LiteralPath (Join-Path $swDsc 'sessions\meta.json') -Encoding UTF8 -Value (@{
  version = 1
  sessions = @{ $swUuid1 = @{ title = '阶段组自检会话' } }
} | ConvertTo-Json -Depth 4)

Set-Content -LiteralPath (Join-Path $swDsc 'desktop.json') -Encoding UTF8 -Value (@{
  lastCwd = $swStart
  recentCwds = @($swStart, $swWsB)
  ui = 'shell'
} | ConvertTo-Json -Depth 4)

# ── 预跑 eval ──────────────────────────────────────────────────────────────────
$swEval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = pred(); if (v) return v; await wait(150); }
    return null;
  };
  const out = {};
  const foot = () => (document.querySelector('.sidebar-footer .dir') ?? {}).textContent?.trim() ?? null;
  await waitFor(() => { const root = document.querySelector('#root'); return root !== null && root.children.length > 0; }, 20000);
  await wait(1500);

  // ① 打开 ws-b 的会话（展开组 → 点行）
  const group = [...document.querySelectorAll('.group-row')].find((g) => (g.textContent ?? '').includes('ws-b'));
  if (group !== undefined) { group.click(); }
  const row = await waitFor(() => [...document.querySelectorAll('.sess-item')].find((r) => (r.textContent ?? '').includes('阶段组自检会话')) ?? null, 6000);
  if (row !== null) { row.click(); }
  await waitFor(() => (foot() ?? '').includes('ws-b'), 12000);
  await wait(1200);
  out.sessionOpened = (foot() ?? '').includes('ws-b');

  // ── A 阶段组：定稿轮默认收起 → 点总开关展开 → 组头 ≥2；组默认收起 → 点开见成员 ──
  await waitFor(() => document.querySelector('.turn-seat') !== null, 8000);
  const turnFold = await waitFor(() => document.querySelector('.turn-fold'), 6000);
  out.turnFoldLabel = turnFold === null ? null : (turnFold.textContent ?? '').trim();
  if (turnFold !== null) { turnFold.click(); }
  await wait(500);
  const heads = [...document.querySelectorAll('.step-fold')];
  out.groupCount = heads.length;
  out.groupMeta = heads.map((h) => ({
    counts: h.getAttribute('data-step-counts'),
    closed: h.getAttribute('data-step-closed'),
    detail: h.getAttribute('data-step-detail'),
    label: (h.querySelector('.step-fold-label') ?? {}).textContent?.trim() ?? '',
    visible: h.closest('[hidden]') === null,
  }));
  const seats = [...document.querySelectorAll('.step-seat')];
  out.seatCount = seats.length;
  const bodyOf = (n) => (seats[n] === undefined ? null : seats[n].querySelector('.step-body'));
  out.group0Closed = bodyOf(0) === null ? null : bodyOf(0).hasAttribute('hidden');
  if (heads[0] !== undefined) { heads[0].click(); }
  await wait(400);
  out.group0OpenAfterClick = bodyOf(0) === null ? null : !bodyOf(0).hasAttribute('hidden');
  out.group0Members = bodyOf(0) === null ? 0 : bodyOf(0).querySelectorAll('.entry-row').length;
  out.group1Closed = bodyOf(1) === null ? null : bodyOf(1).hasAttribute('hidden');
  // 再点一次收起（开合是双态）
  if (heads[0] !== undefined) { heads[0].click(); }
  await wait(300);
  out.group0ReClosed = bodyOf(0) === null ? null : bodyOf(0).hasAttribute('hidden');

  // ── B 文件树：Ctrl+P → 根 = 会话工作区 ─────────────────────────────────────
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }));
  await waitFor(() => document.querySelector('.files-list .file-row') !== null, 8000);
  await wait(600);
  out.filesRoot = document.querySelector('.files-cwd')?.getAttribute('data-tip') ?? null;
  out.filesNames = [...document.querySelectorAll('.files-list .file-name')].map((e) => (e.textContent ?? '').trim());
  out.filesHasWsMarker = out.filesNames.includes('marker-ws-b.txt');
  out.filesHasStartMarker = out.filesNames.includes('marker-start-dir.txt');
  out.chips = [...document.querySelectorAll('.dock-chip')].map((c) => (c.textContent ?? '').replace('✕', '').trim());

  // ── C 开始页：+ 钮 → 四张入口卡 ────────────────────────────────────────────
  const addBtn = document.querySelector('.dock-add');
  if (addBtn !== null) { addBtn.click(); }
  await waitFor(() => document.querySelector('.dock-guide') !== null, 5000);
  out.guideCards = [...document.querySelectorAll('.dock-guide-entry .dock-guide-title')].map((e) => (e.textContent ?? '').trim());
  out.guideKeys = [...document.querySelectorAll('.dock-guide-key')].map((e) => (e.textContent ?? '').trim());

  // ── D 开始页点「新建终端」→ 就地替换 → 终端起来 ─────────────────────────────
  const termEntry = [...document.querySelectorAll('.dock-guide-entry')].find((e) => (e.textContent ?? '').includes('新建终端'));
  if (termEntry !== undefined) { termEntry.click(); }
  await waitFor(() => document.querySelector('.term-bar') !== null, 6000);
  out.terminalBar = document.querySelector('.term-bar') !== null;
  const rowsText = await waitFor(() => {
    const el = document.querySelector('.term-host .xterm-rows');
    const text = el === null ? '' : (el.textContent ?? '');
    return text.includes('管道模式') ? text : null;
  }, 30000);
  out.terminalRows = rowsText === null ? null : rowsText.replace(/\s+/g, ' ').slice(0, 160);
  // 取证：xterm 容器与错误现场（横幅缺失时判是没装配还是没 spawn）
  const hostEl = document.querySelector('.term-host');
  out.terminalDiag = {
    hostChildren: hostEl === null ? -1 : hostEl.children.length,
    text: hostEl === null ? '' : (hostEl.textContent ?? '').replace(/\s+/g, ' ').slice(0, 140),
    notice: (document.querySelector('.term-pane .notice') ?? {}).textContent?.trim() ?? null,
    paneInDom: document.querySelector('.term-pane') !== null,
  };

  // ── E 分栏：右键第一张页签 → 向右分栏 → 两格；双击 split 条收回 ─────────────
  const chip0 = document.querySelectorAll('.dock-chip')[0];
  if (chip0 !== undefined) {
    chip0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 900, clientY: 300 }));
  }
  const menu = await waitFor(() => document.querySelector('.dock-tab-menu'), 4000);
  out.tabMenuItems = menu === null ? null : [...menu.querySelectorAll('.menu-item')].map((b) => (b.textContent ?? '').trim());
  const splitItem = menu === null ? null : [...menu.querySelectorAll('.menu-item')].find((b) => (b.textContent ?? '').includes('向右分栏'));
  if (splitItem !== undefined && splitItem !== null) { splitItem.click(); }
  await wait(400);
  out.paneCount = document.querySelectorAll('.dock-pane').length;
  out.hasSplitBar = document.querySelector('.dock-split') !== null;
  const splitBar = document.querySelector('.dock-split');
  if (splitBar !== null) { splitBar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }
  await wait(400);
  out.paneCountAfterUnsplit = document.querySelectorAll('.dock-pane').length;

  // ── F 全屏：chrome 第一钮 ──────────────────────────────────────────────────
  const chrome = [...document.querySelectorAll('.dock-chrome-btn')];
  if (chrome[0] !== undefined) { chrome[0].click(); }
  await wait(400);
  out.fullscreen = document.querySelector('.dock.mode-fullscreen') !== null;
  const chromeAgain = [...document.querySelectorAll('.dock-chrome-btn')];
  if (chromeAgain[0] !== undefined) { chromeAgain[0].click(); }
  await wait(400);
  out.fullscreenOff = document.querySelector('.dock.mode-fullscreen') === null;

  // ── G 浏览器页签：Ctrl+T **每次开一张**（2026-10 起不再单例；空态不自动加载、
  //     也就不建原生视图——真加载 / data-browser-bound / 保存活 / 弹窗转页签
  //     由 ui-browser-check.ps1 用本机页面覆盖，这里只钉结构）──────────────────
  const addBtn2 = document.querySelector('.dock-add');
  if (addBtn2 !== null) { addBtn2.click(); }
  await waitFor(() => document.querySelector('.dock-guide') !== null, 4000);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true }));
  await waitFor(() => document.querySelector('.browser-pane') !== null, 6000);
  out.browserPane = document.querySelector('.browser-pane') !== null && document.querySelector('.browser-holder') !== null;
  out.browserEmpty = (document.querySelector('.browser-empty') ?? {}).textContent?.trim() ?? null;
  out.browserNoViewYet = document.querySelector('.browser-holder[data-browser-bound]') === null;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true }));
  await wait(400);
  out.browserPaneCount = document.querySelectorAll('.browser-pane').length;

  // ── H 并排审查：改动卡卡头点开 → thread-zone 里的 .diff-pane ───────────────
  const changesHead = await waitFor(() => document.querySelector('.changes-head') ?? null, 6000);
  if (changesHead !== null) { changesHead.click(); }
  await waitFor(() => document.querySelector('.diff-pane[data-diff-pane]') !== null, 5000);
  await wait(400);
  out.reviewInThread = document.querySelector('.thread-zone[data-review] .diff-pane') !== null;
  out.reviewInDock = document.querySelector('.dock .diff-pane') !== null;
  out.reviewSelect = document.querySelector('.diff-pane .diff-file-select, .diff-pane .diff-file-name') !== null;
  const closeBtn = [...document.querySelectorAll('.diff-pane .diff-tool')].find((b) => (b.textContent ?? '').trim() === '关闭');
  if (closeBtn !== undefined) { closeBtn.click(); }
  await wait(400);
  out.reviewClosed = document.querySelector('.diff-pane[data-diff-pane]') === null;

  // ── I 收起 / 展开：chrome 第二钮 → collapsed + 顶栏 toggle ─────────────────
  const chrome2 = [...document.querySelectorAll('.dock-chrome-btn')];
  if (chrome2[1] !== undefined) { chrome2[1].click(); }
  await wait(500);
  out.dockCollapsed = document.querySelector('.dock.collapsed') !== null;
  out.dockToggle = document.querySelector('.dock-toggle') !== null;
  const toggle = document.querySelector('.dock-toggle');
  if (toggle !== null) { toggle.click(); }
  await wait(500);
  out.dockReexpanded = document.querySelector('.dock.collapsed') === null;

  // ── J 预览页签：文件树点文件 ───────────────────────────────────────────────
  const filesChip = [...document.querySelectorAll('.dock-chip')].find((c) => (c.textContent ?? '').includes('文件'));
  if (filesChip !== undefined) { filesChip.click(); }
  await waitFor(() => document.querySelector('.files-list .file-row') !== null, 5000);
  const fileRow = [...document.querySelectorAll('.files-list .file-row')].find((r) => (r.textContent ?? '').includes('marker-ws-b.txt'));
  if (fileRow !== undefined) { fileRow.click(); }
  await waitFor(() => document.querySelector('.file-preview-head') !== null, 6000);
  out.previewOpen = document.querySelector('.file-preview-head') !== null;
  out.previewChips = [...document.querySelectorAll('.dock-chip')].map((c) => (c.textContent ?? '').replace('✕', '').trim());

  // ── 收尾静场（截图留档用）：关掉**所有**浏览器页签（2026-10 起可多开；原生
  //    WebContentsView 覆盖层不参与 capturePage，也让截图那拍安静），再切回「文件」
  //    页签停在会话工作区的树上。────────────────────────────────────────────────
  for (let round = 0; round < 4; round += 1) {
    const chip = [...document.querySelectorAll('.dock-chip')].find((c) => (c.textContent ?? '').includes('浏览器'));
    if (chip === undefined) { break; }
    chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 900, clientY: 300 }));
    const closeMenu = await waitFor(() => document.querySelector('.dock-tab-menu'), 3000);
    const closeItem = closeMenu === null ? null : [...closeMenu.querySelectorAll('.menu-item')].find((b) => (b.textContent ?? '').includes('关闭页签'));
    if (closeItem !== undefined && closeItem !== null) { closeItem.click(); }
    await wait(400);
  }
  out.browserClosedByEnd = document.querySelector('.browser-pane') === null;
  const filesChipEnd = [...document.querySelectorAll('.dock-chip')].find((c) => (c.textContent ?? '').includes('文件'));
  if (filesChipEnd !== undefined) { filesChipEnd.click(); }
  await wait(300);
  out.finalChips = [...document.querySelectorAll('.dock-chip')].map((c) => (c.textContent ?? '').replace('✕', '').trim());

  out.done = true;
  return out;
})()
'@

$env:DSC_DESKTOP_USER_DATA = Join-Path $swHome 'electron-userdata'
$env:USERPROFILE = $swHome
$env:HOME = $swHome
$env:DSC_DESKTOP_STATE = Join-Path $swDsc 'desktop.json'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SHOT = Join-Path $swShots 'ui-batch6.png'
$env:DSC_DESKTOP_SHOT_DELAY = '240000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '224000'
$env:DSC_DESKTOP_SHOT_EVAL = $swEval
Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue
Remove-Item Env:DSC_UI_QUERY -ErrorAction SilentlyContinue

$outLog = Join-Path $swShots 'ui-batch6.out.log'
$errLog = Join-Path $swShots 'ui-batch6.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue

try {
  $swProc = Start-Process -FilePath $swElectron -ArgumentList $swEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $swDeadline = (Get-Date).AddSeconds(300)
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
  Select-String -LiteralPath $errLog -Pattern '预跑脚本失败|页面加载失败|截图失败' | ForEach-Object { '  ' + $_.Line.Trim() }
}

# ── 断言 ───────────────────────────────────────────────────────────────────────
$swFail = 0
$swTotal = 0
function Check($Name, $Ok, $Detail = '') {
  $script:swTotal += 1
  if ($Ok) { Write-Output "  PASS  $Name" }
  else { $script:swFail += 1; Write-Output "  FAIL  $Name$(if ($Detail -ne '') { " — $Detail" })" }
}

$swJson = $null
if (Test-Path -LiteralPath $errLog) {
  $line = Select-String -LiteralPath $errLog -Pattern '预跑脚本完成：' | Select-Object -Last 1
  if ($null -ne $line) {
    $marker = '预跑脚本完成：'
    $raw = $line.Line.Substring($line.Line.IndexOf($marker) + $marker.Length).Trim()
    try { $swJson = $raw | ConvertFrom-Json } catch { $swJson = $null }
  }
}
Check '预跑脚本返回了读数' ($null -ne $swJson)
if ($null -ne $swJson) {
  Check '打开 ws-b 会话后侧栏底部 cwd = ws-b' ($swJson.sessionOpened -eq $true)

  # A 阶段组
  Check '定稿轮有总开关（.turn-fold，含「用时」）' ($null -ne $swJson.turnFoldLabel -and $swJson.turnFoldLabel -like '*用时*') $swJson.turnFoldLabel
  Check '展开整轮后阶段组头 ≥ 2 个' ($swJson.groupCount -ge 2) ("$($swJson.groupCount)")
  if ($swJson.groupMeta.Count -ge 2) {
    Check '第一组是 read=1,search=1（data-step-counts）' ($swJson.groupMeta[0].counts -eq 'read=1,search=1') $swJson.groupMeta[0].counts
    Check '第二组是 commands=1' ($swJson.groupMeta[1].counts -eq 'commands=1') $swJson.groupMeta[1].counts
    Check '已结束的组带 data-step-closed' ($swJson.groupMeta[0].closed -eq '1') $swJson.groupMeta[0].closed
    Check '组头文案是聚合句（已读取文件…）' ($swJson.groupMeta[0].label -like '已读取文件*') $swJson.groupMeta[0].label
  }
  Check '组默认收起（.step-body[hidden]）' ($swJson.group0Closed -eq $true) ("$($swJson.group0Closed)")
  Check '点组头展开出成员（.entry-row ≥2）' ($swJson.group0OpenAfterClick -eq $true -and $swJson.group0Members -ge 2) ("$($swJson.group0Members)")
  Check '再点一次又收起（开合双态）' ($swJson.group0ReClosed -eq $true) ("$($swJson.group0ReClosed)")
  Check '第二组也默认收起' ($swJson.group1Closed -eq $true)

  # B 文件树
  Check '文件树根 = 会话工作区（ws-b）' ($swJson.filesRoot -like '*ws-b*') $swJson.filesRoot
  Check '文件树列出 marker-ws-b.txt（不是 start-dir 的）' ($swJson.filesHasWsMarker -eq $true -and $swJson.filesHasStartMarker -eq $false) ($swJson.filesNames -join ',')
  Check '页签条有「文件」chip' (($swJson.chips -join ',') -like '*文件*') ($swJson.chips -join ',')

  # C 开始页
  Check '开始页四张入口卡（含浏览器）' ($swJson.guideCards.Count -eq 4 -and ($swJson.guideCards -join ',') -like '*工作区文件*新建终端*浏览器*Git 管理*') ($swJson.guideCards -join ',')
  Check '入口卡带快捷键角标（Ctrl + P / Ctrl + ` / Ctrl + T）' (($swJson.guideKeys -join ',') -like '*Ctrl + P*' -and ($swJson.guideKeys -join ',') -like '*Ctrl + T*') ($swJson.guideKeys -join ',')

  # D 终端
  Check '开始页点「新建终端」就地替换出终端页签（.term-bar）' ($swJson.terminalBar -eq $true)
  Check '终端 xterm 已装配（.term-host 里挂了终端容器，横幅文本作诊断不设卡）' ($null -ne $swJson.terminalDiag -and $swJson.terminalDiag.hostChildren -ge 1 -and $swJson.terminalDiag.paneInDom -eq $true) ($swJson.terminalDiag | ConvertTo-Json -Compress)

  # E 分栏
  Check '页签右键菜单有 向右分栏/收回分栏/关闭页签' (($swJson.tabMenuItems -join ',') -like '*向右分栏*收回分栏*关闭页签*') ($swJson.tabMenuItems -join ',')
  Check '向右分栏后两个窗格 + 分栏条' ($swJson.paneCount -eq 2 -and $swJson.hasSplitBar -eq $true) ("$($swJson.paneCount)")
  Check '双击分栏条收回成一格' ($swJson.paneCountAfterUnsplit -eq 1) ("$($swJson.paneCountAfterUnsplit)")

  # F 全屏
  Check 'chrome 第一钮切全屏（.dock.mode-fullscreen）' ($swJson.fullscreen -eq $true)
  Check '再点退出全屏' ($swJson.fullscreenOff -eq $true)

  # G 浏览器（2026-10 起可多开：Ctrl+T 每次开一张；空态不自动加载也不建原生视图）
  Check 'Ctrl+T 开出浏览器页签（.browser-pane + .browser-holder）' ($swJson.browserPane -eq $true)
  Check '新页签是空态（输入 HTTP(S) 地址开始浏览）' ($swJson.browserEmpty -like '*输入 HTTP(S) 地址开始浏览*') $swJson.browserEmpty
  Check '空态下不建原生视图（不白开一个渲染进程）' ($swJson.browserNoViewYet -eq $true)
  Check '再 Ctrl+T 又多一张（浏览器不再单例）' ($swJson.browserPaneCount -eq 2) ("$($swJson.browserPaneCount)")

  # H 并排审查
  Check '审查面板在正文右侧并排（thread-zone[data-review] 里）' ($swJson.reviewInThread -eq $true)
  Check '审查面板不在 dock 里' ($swJson.reviewInDock -eq $false)
  Check '审查面板有文件名区' ($swJson.reviewSelect -eq $true)
  Check '点「关闭」收掉审查' ($swJson.reviewClosed -eq $true)

  # I 收起/展开
  Check 'chrome 第二钮收起（.dock.collapsed）' ($swJson.dockCollapsed -eq $true)
  Check '收起后顶栏出现 .dock-toggle' ($swJson.dockToggle -eq $true)
  Check '点顶栏 toggle 再展开' ($swJson.dockReexpanded -eq $true)

  # J 预览
  Check '文件树点文件出预览页签（.file-preview-head）' ($swJson.previewOpen -eq $true)
  Check '预览页签进了页签条（marker-ws-b.txt）' (($swJson.previewChips -join ',') -like '*marker-ws-b.txt*') ($swJson.previewChips -join ',')
}

# ── 真实 ~/.dsc 未被污染 ───────────────────────────────────────────────────────
if ($null -ne $swRealBefore) {
  $swRealAfter = Get-DirFingerprint $swRealDsc
  Check '真实 ~/.dsc 文件数与内容指纹不变' ($swRealAfter.Count -eq $swRealBefore.Count -and $swRealAfter.ContentDigest -eq $swRealBefore.ContentDigest) ("$($swRealBefore.Count)/$($swRealAfter.Count)")
}

Check '截图落盘（ui-batch6.png）' (Test-Path -LiteralPath (Join-Path $swShots 'ui-batch6.png'))

Write-Output ""
Write-Output "第六批自检：$($swTotal - $swFail)/$swTotal 通过"
if ($swFail -gt 0) { exit 1 }
