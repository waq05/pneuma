# UI 修复自检（0.6.35）：turn-fold 分节线对齐 dsh + 滚动条 8px→5px。
#
# 隔离与指纹照 final-shots.ps1 的同一套：DSC_DESKTOP_USER_DATA 换 userData，USERPROFILE/HOME
# 换掉宿主 ~/.dsc（种子见 shots/ui-seed.mjs），跑前跑后对真实 ~/.dsc 做「文件数 + 聚合 SHA256」
# 比对。进程用 Start-Process 起、轮询 stderr 关键行、taskkill /T /F 收自己那棵树。
#
# 用例（主题固定 dark，工作区就是 D:\dsc 本仓库）：
#   ui-fold   重放种子会话：第 0 轮折叠行 = 不可点「用时 2秒」（实机截图被圈的那行的形态，
#             现在应有 0.5px 下边框），第 1 轮折叠行可点带 chevron；顺带取 ::-webkit-scrollbar 宽度
#   ui-start  新会话开始页：欢迎页 + 输入框 + 侧栏（会话足够多时 .sidebar-scroll 溢出出滚动条）
#
# 用法（先在 desktop/ 跑 `pnpm run build`）：
#   pwsh -NoProfile -File ui-fix-shots.ps1              # 两个用例
#   pwsh -NoProfile -File ui-fix-shots.ps1 -Only ui-fold

param([string]$Only = 'all')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$uiShots = 'D:\dsc\desktop\shots'
$uiElectron = Join-Path $uiShots '..\node_modules\electron\dist\electron.exe'
$uiEntry = Join-Path $uiShots '..\out\main\index.js'
$uiHome = Join-Path $uiShots 'ui-home'
$uiRealProfile = $env:USERPROFILE
$uiRealDsc = Join-Path $uiRealProfile '.dsc'

function Get-DirFingerprint([string]$Path) {
  $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Sort-Object FullName)
  $lines = New-Object System.Collections.Generic.List[string]
  $locked = 0
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($Path.Length)
    $hash = 'LOCKED'
    try {
      $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash
    } catch {
      $locked += 1
    }
    $lines.Add("$rel|$($file.Length)|$hash")
  }
  $joined = [string]::Join("`n", $lines)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $digest = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($joined))).Replace('-', '').ToLowerInvariant()
  $contentJoined = [string]::Join("`n", ($lines | ForEach-Object { $parts = $_ -split '\|'; "$($parts[0])|$($parts[2])" }))
  $contentDigest = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($contentJoined))).Replace('-', '').ToLowerInvariant()
  return [pscustomobject]@{ Count = $files.Count; Digest = $digest; ContentDigest = $contentDigest; Locked = $locked; Lines = $lines }
}

function Write-FingerprintFile([string]$Path, $Fingerprint, [string]$Label) {
  $head = @(
    "# 真实 ~/.dsc 指纹（$Label）",
    "# 文件数：$($Fingerprint.Count)（其中被别的进程独占、只能记 LOCKED 的：$($Fingerprint.Locked)）",
    "# 清单聚合 SHA256（相对路径|字节数|SHA256）：$($Fingerprint.Digest)",
    "# 内容聚合 SHA256（相对路径|SHA256）：$($Fingerprint.ContentDigest)",
    ''
  )
  Set-Content -LiteralPath $Path -Value ($head + $Fingerprint.Lines) -Encoding utf8
}

$uiEvalHead = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = pred(); if (v) return v; await wait(120); }
  return null;
};
const text = (el) => (el === null || el === undefined ? null : el.textContent.trim());
const all = (sel) => Array.from(document.querySelectorAll(sel));
const composerBox = () => document.querySelector('.composer textarea');
/** 全局滚动条皮肤（base.css ::-webkit-scrollbar）在构建产物里的宽度。 */
const scrollbarWidth = () => {
  for (const sheet of document.styleSheets) {
    let list; try { list = sheet.cssRules; } catch { continue }
    for (const rule of list) {
      if (rule.selectorText === '::-webkit-scrollbar') return rule.style.width;
    }
  }
  return null;
};
'@

$uiCases = [ordered]@{
  'ui-fold' = @'
(async () => {
  const started = Date.now();
  const rows = await waitFor(() => (all('.turn-fold').length >= 2 ? all('.turn-fold') : null), 20000);
  if (rows === null) {
    return { case: 'ui-fold', error: '.turn-fold 行不足两条', count: all('.turn-fold').length, ms: Date.now() - started };
  }
  await wait(600);
  const foldInfo = all('.turn-fold').map((b) => {
    const s = getComputedStyle(b);
    return {
      label: text(b.querySelector('.turn-fold-label')),
      disabled: b.disabled,
      chevron: b.querySelector('.turn-fold-chevron') !== null,
      borderBottom: `${s.borderBottomWidth}/${s.borderBottomStyle}`,
      height: Math.round(b.getBoundingClientRect().height),
    };
  });
  const scrollWidth = scrollbarWidth();
  return {
    case: 'ui-fold',
    ms: Date.now() - started,
    theme: document.documentElement.dataset.theme,
    foldInfo, scrollWidth,
    // ── 判定 ──
    foldRowsOk: foldInfo.length >= 2
      && foldInfo.some((r) => !r.disabled && r.chevron)
      && foldInfo.some((r) => r.disabled && !r.chevron && (r.label ?? '').indexOf('用时') === 0),
    borderOk: foldInfo.every((r) => r.borderBottom.indexOf('solid') >= 0 && r.borderBottom.indexOf('0px/') < 0),
    scrollOk: scrollWidth === '5px',
  };
})()
'@
  'ui-start' = @'
(async () => {
  const started = Date.now();
  const composer = await waitFor(() => composerBox(), 20000);
  if (composer === null) return { case: 'ui-start', error: 'composer textarea 没找到', ms: Date.now() - started };
  await wait(800);
  const sidebar = document.querySelector('.sidebar-scroll');
  const scrollWidth = scrollbarWidth();
  // 垂直居中取证：引导块上方的留白应与输入框下方的留白大致相等（dsh EmptyHero 形态）
  const main = document.querySelector('.thread-main');
  const welcome = document.querySelector('.welcome');
  const card = document.querySelector('.composer');
  let centering = null;
  if (main !== null && welcome !== null && card !== null) {
    const m = main.getBoundingClientRect();
    const w = welcome.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const above = w.top - m.top;
    const below = m.bottom - c.bottom;
    centering = { above: Math.round(above), below: Math.round(below) };
  }
  return {
    case: 'ui-start',
    ms: Date.now() - started,
    theme: document.documentElement.dataset.theme,
    welcome: document.querySelector('.welcome') !== null,
    sidebarRows: all('.sess-item').length,
    sidebarOverflow: sidebar !== null && sidebar.scrollHeight > sidebar.clientHeight,
    scrollWidth,
    centering,
    // ── 判定 ──
    startOk: composer !== null && document.querySelector('.welcome') !== null && sidebar !== null,
    scrollOk: scrollWidth === '5px',
    centeredOk: centering !== null && Math.abs(centering.above - centering.below) <= 32 && centering.above > 40,
  };
})()
'@
  'ui-term' = @'
(async () => {
  const started = Date.now();
  // 展开工作区面板（收起态顶栏那颗开关；已展开时它不存在，dock 条已在场）
  const toggle = document.querySelector('.icon-btn.dock-toggle');
  if (toggle !== null) toggle.click();
  const strip = await waitFor(() => document.querySelector('.dock-strip'), 8000);
  if (strip === null) return { case: 'ui-term', error: 'dock 没展开', ms: Date.now() - started };
  // 「开始」页的「新建终端」卡 → 打开终端页签 → xterm 懒加载装配
  const entry = all('.dock-guide-entry').find((b) => (b.textContent ?? '').indexOf('新建终端') >= 0);
  if (entry === undefined) return { case: 'ui-term', error: 'guide 里没有新建终端卡', ms: Date.now() - started };
  entry.click();
  const xterm = await waitFor(() => document.querySelector('.term-host .xterm'), 15000);
  await wait(1200);
  const hostInfo = (() => {
    const host = document.querySelector('.term-host');
    if (host === null) return null;
    const b = host.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), visible: b.height > 0 };
  })();
  return {
    case: 'ui-term',
    ms: Date.now() - started,
    theme: document.documentElement.dataset.theme,
    xtermMounted: xterm !== null,
    hostInfo,
    // ── 判定 ──
    termOk: xterm !== null && hostInfo !== null && hostInfo.visible && hostInfo.w > 100,
  };
})()
'@
}

Write-Output '=== 真实 ~/.dsc 跑前指纹 ==='
$uiBefore = Get-DirFingerprint $uiRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 清单聚合 {2} · 内容聚合 {3}" -f $uiBefore.Count, $uiBefore.Locked, $uiBefore.Digest, $uiBefore.ContentDigest)
Write-FingerprintFile (Join-Path $uiShots 'ui-realhome-before.txt') $uiBefore '跑前'

node (Join-Path $uiShots 'ui-seed.mjs') | Out-Null
$uiSessions = Get-Content (Join-Path $uiShots 'ui-sessions.json') -Raw | ConvertFrom-Json

try {
  foreach ($name in $uiCases.Keys) {
    if ($Only -ne 'all' -and $Only -ne $name) { continue }

    $env:DSC_DESKTOP_USER_DATA = Join-Path $uiHome 'electron-userdata'
    $env:USERPROFILE = $uiHome
    $env:HOME = $uiHome
    $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
    if ($name -eq 'ui-fold') {
      $env:DSC_RESUME_SESSION = $uiSessions.session
    } else {
      Remove-Item Env:DSC_RESUME_SESSION -ErrorAction SilentlyContinue
    }
    $env:DSC_DESKTOP_SHOT = Join-Path $uiShots "$name.png"
    $env:DSC_DESKTOP_SHOT_DELAY = '48000'
    $env:DSC_DESKTOP_SHOT_EVAL_LEAD = '36000'
    $env:DSC_DESKTOP_SHOT_EVAL = ($uiEvalHead + $uiCases[$name])
    Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue

    $outLog = Join-Path $uiShots "$name.out.log"
    $errLog = Join-Path $uiShots "$name.err.log"
    Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
    Write-Output "=== $name（隔离目录 $uiHome）==="

    $uiProc = Start-Process -FilePath $uiElectron -ArgumentList $uiEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $uiDeadline = (Get-Date).AddSeconds(110)
    $uiSeen = ''
    while ((Get-Date) -lt $uiDeadline) {
      if (Test-Path -LiteralPath $errLog) {
        $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|页面加载失败|截图失败' -ErrorAction SilentlyContinue
        if ($null -ne $hit) { $uiSeen = $hit[0].Line; break }
      }
      if ($uiProc.HasExited) { break }
      Start-Sleep -Milliseconds 500
    }
    & taskkill /PID $uiProc.Id /T /F 2>&1 | Out-Null
    Start-Sleep -Milliseconds 600
    Write-Output ("  electron 已收工：{0}" -f ($uiSeen -replace '\s+$', ''))

    if (Test-Path -LiteralPath $errLog) {
      Select-String -LiteralPath $errLog -Pattern '预跑脚本完成|预跑脚本失败|已写出|页面加载失败' |
        ForEach-Object { '  ' + $_.Line }
    }
  }
} finally {
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_SEARCH,
    Env:DSC_DESKTOP_USER_DATA -ErrorAction SilentlyContinue
}

Write-Output '=== 真实 ~/.dsc 跑后指纹 ==='
$uiAfter = Get-DirFingerprint $uiRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 清单聚合 {2} · 内容聚合 {3}" -f $uiAfter.Count, $uiAfter.Locked, $uiAfter.Digest, $uiAfter.ContentDigest)
Write-FingerprintFile (Join-Path $uiShots 'ui-realhome-after.txt') $uiAfter '跑后'
$uiDiff = Compare-Object -ReferenceObject $uiBefore.Lines -DifferenceObject $uiAfter.Lines
if ($null -eq $uiDiff) {
  Write-Output '差异行：无（逐文件哈希完全一致）'
} else {
  Write-Output ("差异行：{0} 条" -f @($uiDiff).Count)
  $uiDiff | Select-Object -First 10 | ForEach-Object { '  ' + $_.SideIndicator + ' ' + $_.InputObject }
}
$uiPathsBefore = @($uiBefore.Lines | ForEach-Object { ($_ -split '\|')[0] })
$uiPathsAfter = @($uiAfter.Lines | ForEach-Object { ($_ -split '\|')[0] })
$uiAdded = @($uiPathsAfter | Where-Object { $uiPathsBefore -notcontains $_ })
$uiRemoved = @($uiPathsBefore | Where-Object { $uiPathsAfter -notcontains $_ })
Write-Output ("路径增删：新增 {0} 个、减少 {1} 个" -f $uiAdded.Count, $uiRemoved.Count)
Write-Output ("文件数一致：{0}；内容聚合一致：{1}" -f ($uiBefore.Count -eq $uiAfter.Count), ($uiBefore.ContentDigest -eq $uiAfter.ContentDigest))
Write-Output '全部完成'
