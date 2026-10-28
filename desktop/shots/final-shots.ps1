# 收尾自检（批次 A–E UI 实机目检）：@ 面板 / findings 卡与行号跳转 / 设置页模型发现。
#
# 隔离与指纹照 trace-shots.ps1 的同一套：DSC_DESKTOP_USER_DATA 换 userData，USERPROFILE/HOME
# 换掉宿主 ~/.dsc（种子见 shots/final-seed.mjs），跑前跑后对真实 ~/.dsc 做「文件数 + 聚合 SHA256」
# 比对。进程用 Start-Process 起、轮询 stderr 关键行、taskkill /T /F 收自己那棵树。
#
# 用例（主题固定 dark，workspace 就是 D:\dsc 本仓库——findings 的位置与 @ 候选都是真文件）：
#   final-findings  findings 卡渲染取证 → 点 P1 位置按钮 → preview 行号高亮取证 → 停在 preview
#   final-mention   @ 面板候选取证 → 点候选插入断言 → 清空再输入 @rev → 停在面板打开
#   final-settings  设置 → 模型分区 → 「拉取清单」按钮取证 → 顺带记侧栏状态点 → 停在设置页
#
# 用法（先在 desktop/ 跑 `pnpm run build`）：
#   pwsh -NoProfile -File final-shots.ps1              # 三个用例
#   pwsh -NoProfile -File final-shots.ps1 -Only final-mention

param([string]$Only = 'all')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$finalShots = 'D:\dsc\desktop\shots'
$finalElectron = Join-Path $finalShots '..\node_modules\electron\dist\electron.exe'
$finalEntry = Join-Path $finalShots '..\out\main\index.js'
$finalHome = Join-Path $finalShots 'final-home'
$finalRealProfile = $env:USERPROFILE
$finalRealDsc = Join-Path $finalRealProfile '.dsc'

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

$finalEvalHead = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = pred(); if (v) return v; await wait(120); }
  return null;
};
const text = (el) => (el === null || el === undefined ? null : el.textContent.trim());
const all = (sel) => Array.from(document.querySelectorAll(sel));
const tabs = () => Array.from(document.querySelectorAll('.tabs button'));
/** React 受控 textarea 的标准触发法：native setter 赋值 + input 冒泡。 */
const typeInto = (textarea, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
};
const composerBox = () => document.querySelector('.composer textarea');
'@

$finalCases = [ordered]@{
  'final-findings' = @'
(async () => {
  const started = Date.now();
  const card = await waitFor(() => document.querySelector('[data-review-findings]'), 20000);
  if (card === null) return { case: 'final-findings', error: 'findings 卡没渲染', ms: Date.now() - started };
  card.scrollIntoView({ block: 'center' });
  await wait(700);

  const head = {
    title: text(document.querySelector('.review-findings-title')),
    state: text(document.querySelector('.review-findings-state')),
    note: text(document.querySelector('.review-findings-note')),
  };
  const findings = all('.review-finding').map((li) => ({
    priority: li.dataset.priority,
    title: text(li.querySelector('.review-finding-title')),
    loc: text(li.querySelector('.review-finding-loc')),
    line: text(li.querySelector('.review-finding-line')),
    hasSuggest: li.querySelector('.review-finding-suggest') !== null,
  }));

  // 点 P1 的位置按钮：应开 preview tab 并滚到第 40 行高亮
  const p1loc = document.querySelector('.review-finding[data-priority="P1"] .review-finding-loc');
  if (p1loc === null) return { case: 'final-findings', error: 'P1 位置按钮不存在', head, findings };
  p1loc.click();
  const tab = await waitFor(() => {
    const strip = document.querySelector('.dock-strip');
    return strip !== null && strip.textContent.indexOf('dock-model.ts') >= 0 ? strip : null;
  }, 8000);
  const numbered = await waitFor(() => document.querySelector('.file-code--numbered') !== null, 8000);
  await wait(900);
  const target = document.querySelector('.file-code-line-target');
  const targetInfo = target === null
    ? null
    : {
        snippet: target.textContent.slice(0, 70),
        visible: (() => { const b = target.getBoundingClientRect(); return b.height > 0 && b.top > 0 && b.bottom < window.innerHeight; })(),
        isLine: target.classList.contains('line'),
      };
  const lineCount = all('.file-code--numbered .line').length;

  const endState = { previewOpen: tab !== null, numbered, target: targetInfo, lineCount };
  return {
    case: 'final-findings',
    ms: Date.now() - started,
    theme: document.documentElement.dataset.theme,
    head, findings,
    endState,
    // ── 判定 ──
    headOk: head.title !== null && head.title.indexOf('代码审查') === 0 && head.state === 'completed' && (head.note ?? '').indexOf('只读审查') >= 0,
    findingsOk: findings.length === 3
      && findings[0].priority === 'P1' && findings[0].line === ':40' && findings[0].hasSuggest
      && findings[1].priority === 'P2' && findings[1].line === ':80'
      && findings[2].priority === 'P3' && findings[2].loc === null,
    priorityBadgeOk: all('.review-finding').every((li) => (text(li.querySelector('.review-finding-badge')) ?? '').indexOf(li.dataset.priority) === 0),
    previewJumpOk: endState.previewOpen && numbered === true && targetInfo !== null && targetInfo.isLine && targetInfo.visible,
    endState,
  };
})()
'@
  'final-mention' = @'
(async () => {
  const started = Date.now();
  const ta = await waitFor(() => composerBox(), 20000);
  if (ta === null) return { case: 'final-mention', error: 'composer textarea 没找到', ms: Date.now() - started };
  ta.focus();
  typeInto(ta, '@dock-m');
  const panel = await waitFor(() => document.querySelector('.composer .completions'), 10000);
  if (panel === null) return { case: 'final-mention', error: '@ 面板没弹出', ms: Date.now() - started };
  const loading = panel.textContent.indexOf('正在读取') >= 0;
  const candidates = await waitFor(() => {
    const items = all('.composer .completions .item .label').map((n) => text(n));
    return items.length > 0 && items.every((s) => s !== null && s.indexOf('正在读取') < 0) ? items : null;
  }, 12000);
  await wait(400);
  const mentionInfo = {
    loadingShown: loading,
    candidates: candidates === null ? [] : candidates,
    activeIsFirst: document.querySelector('.composer .completions .item.active') === panel.querySelector('.item'),
  };
  const hasDockModel = mentionInfo.candidates.some((s) => (s ?? '').indexOf('dock-model.ts') >= 0);

  // 点 dock-model.ts 候选：应插入正文并收面板
  const dockItem = all('.composer .completions .item').find((n) => text(n.querySelector('.label'))?.indexOf('dock-model.ts') >= 0);
  if (dockItem === undefined) return { case: 'final-mention', error: '候选里没有 dock-model.ts', mentionInfo };
  dockItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await wait(500);
  const insertedValue = ta.value;
  const panelClosedAfterPick = document.querySelector('.composer .completions') === null;

  // 清空再输入 @review：面板重开（这是截图停住的那一屏）
  typeInto(ta, '');
  await wait(300);
  typeInto(ta, '@rev');
  const panel2 = await waitFor(() => document.querySelector('.composer .completions') !== null, 10000);
  await wait(900);
  const secondCandidates = all('.composer .completions .item .label').map((n) => text(n));
  const visiblePanel = panel2 !== null && document.querySelector('.composer .completions').getBoundingClientRect().height > 0;

  return {
    case: 'final-mention',
    ms: Date.now() - started,
    theme: document.documentElement.dataset.theme,
    mentionInfo, insertedValue, panelClosedAfterPick, secondCandidates, visiblePanel,
    // ── 判定 ──
    candidatesOk: hasDockModel && mentionInfo.candidates.every((s) => (s ?? '').indexOf('@') === 0),
    insertOk: panelClosedAfterPick && insertedValue.indexOf('dock-model.ts') >= 0,
    panelReopens: visiblePanel && secondCandidates.length > 0,
  };
})()
'@
  'final-settings' = @'
(async () => {
  const started = Date.now();
  const dotInfo = {
    items: all('.sess-item').length,
    dots: all('.sess-item .session-dot').length,
    working: all('.sess-item .session-dot.working').length,
    waiting: all('.sess-item .session-dot.waiting').length,
  };
  const btn = document.querySelector('.rail-btn[data-tip^="设置"]') ?? document.querySelector('.row-btn[data-tip^="设置"]');
  if (btn === null) return { case: 'final-settings', error: '设置按钮没找到', dotInfo, ms: Date.now() - started };
  btn.click();
  const mask = await waitFor(() => document.querySelector('.settings-mask') !== null, 8000);
  if (mask === null) return { case: 'final-settings', error: '设置模态没打开', dotInfo, ms: Date.now() - started };
  const modelsNav = all('.settings-nav-item').find((n) => text(n.querySelector('.label')) === '模型');
  if (modelsNav !== undefined) modelsNav.click();
  const discover = await waitFor(() => document.querySelector('[data-tip="从端点拉取线上可用模型清单"]'), 8000);
  await wait(700);
  const discoverInfo = discover === null
    ? null
    : {
        text: text(discover),
        enabled: !discover.disabled,
        tip: discover.getAttribute('data-tip'),
      };
  return {
    case: 'final-settings',
    ms: Date.now() - started,
    theme: document.documentElement.dataset.theme,
    dotInfo, discoverInfo,
    // ── 判定 ──
    discoverButtonOk: discoverInfo !== null && discoverInfo.text === '拉取清单' && discoverInfo.enabled,
    dotIdleHidden: dotInfo.working === 0 && dotInfo.waiting === 0,
  };
})()
'@
}

Write-Output '=== 真实 ~/.dsc 跑前指纹 ==='
$finalBefore = Get-DirFingerprint $finalRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 清单聚合 {2} · 内容聚合 {3}" -f $finalBefore.Count, $finalBefore.Locked, $finalBefore.Digest, $finalBefore.ContentDigest)
Write-FingerprintFile (Join-Path $finalShots 'final-realhome-before.txt') $finalBefore '跑前'

node (Join-Path $finalShots 'final-seed.mjs') | Out-Null
$finalSessions = Get-Content (Join-Path $finalShots 'final-sessions.json') -Raw | ConvertFrom-Json

try {
  foreach ($name in $finalCases.Keys) {
    if ($Only -ne 'all' -and $Only -ne $name) { continue }

    $env:DSC_DESKTOP_USER_DATA = Join-Path $finalHome 'electron-userdata'
    $env:USERPROFILE = $finalHome
    $env:HOME = $finalHome
    $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
    $env:DSC_RESUME_SESSION = $finalSessions.session
    $env:DSC_DESKTOP_SHOT = Join-Path $finalShots "$name.png"
    $env:DSC_DESKTOP_SHOT_DELAY = '48000'
    $env:DSC_DESKTOP_SHOT_EVAL_LEAD = '36000'
    $env:DSC_DESKTOP_SHOT_EVAL = ($finalEvalHead + $finalCases[$name])
    Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue

    $outLog = Join-Path $finalShots "$name.out.log"
    $errLog = Join-Path $finalShots "$name.err.log"
    Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
    Write-Output "=== $name（隔离目录 $finalHome）==="

    $finalProc = Start-Process -FilePath $finalElectron -ArgumentList $finalEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $finalDeadline = (Get-Date).AddSeconds(110)
    $finalSeen = ''
    while ((Get-Date) -lt $finalDeadline) {
      if (Test-Path -LiteralPath $errLog) {
        $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|页面加载失败|截图失败' -ErrorAction SilentlyContinue
        if ($null -ne $hit) { $finalSeen = $hit[0].Line; break }
      }
      if ($finalProc.HasExited) { break }
      Start-Sleep -Milliseconds 500
    }
    & taskkill /PID $finalProc.Id /T /F 2>&1 | Out-Null
    Start-Sleep -Milliseconds 600
    Write-Output ("  electron 已收工：{0}" -f ($finalSeen -replace '\s+$', ''))

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
$finalAfter = Get-DirFingerprint $finalRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 清单聚合 {2} · 内容聚合 {3}" -f $finalAfter.Count, $finalAfter.Locked, $finalAfter.Digest, $finalAfter.ContentDigest)
Write-FingerprintFile (Join-Path $finalShots 'final-realhome-after.txt') $finalAfter '跑后'
$finalDiff = Compare-Object -ReferenceObject $finalBefore.Lines -DifferenceObject $finalAfter.Lines
if ($null -eq $finalDiff) {
  Write-Output '差异行：无（逐文件哈希完全一致）'
} else {
  Write-Output ("差异行：{0} 条" -f @($finalDiff).Count)
  $finalDiff | Select-Object -First 10 | ForEach-Object { '  ' + $_.SideIndicator + ' ' + $_.InputObject }
}
$finalPathsBefore = @($finalBefore.Lines | ForEach-Object { ($_ -split '\|')[0] })
$finalPathsAfter = @($finalAfter.Lines | ForEach-Object { ($_ -split '\|')[0] })
$finalAdded = @($finalPathsAfter | Where-Object { $finalPathsBefore -notcontains $_ })
$finalRemoved = @($finalPathsBefore | Where-Object { $finalPathsAfter -notcontains $_ })
Write-Output ("路径增删：新增 {0} 个、减少 {1} 个" -f $finalAdded.Count, $finalRemoved.Count)
Write-Output ("文件数一致：{0}；内容聚合一致：{1}" -f ($finalBefore.Count -eq $finalAfter.Count), ($finalBefore.ContentDigest -eq $finalAfter.ContentDigest))
Write-Output '全部完成'
