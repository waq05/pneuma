# 第五批专项自检（2026-10-12）：修改预览（悬停浮层/审查/打开/折叠）、轮尾时间口径、终端对齐。
#
# 种子按用户报障的那条会话复刻：**7 天前**的 user/assistant/tool 时间戳、整轮真实跨度 3 秒、
# 6 个文件改动（6 刀 changes，每刀带 hunks）——用来钉住两件已经修掉的事：
#   ① 恢复会话时那个「已恢复会话」system 行的 ts 是「现在」，早期壳版把它算进轮结束时刻，
#      轮尾直接报出「684083.4 秒」这种天文数字；现在轮尾/总开关的用时都跳过 system 行。
#   ② 轮尾不许把用时印成可见一行（旧版口径：只挂在整行 title 上）——DOM 里出现
#      「用时 … 秒」或「N 次工具」就是回退了。
#
# 硬验收（eval 读 DOM）：
#   A. 轮尾：`.round-foot` 的 title 含「用时 3秒」；可见文本不含「用时」/「次工具」。
#   B. 总开关：`.turn-fold` 标签是「用时 3秒」（不是 190时）。
#   C. 改动卡：标题「6 个文件已更改」+ 提示「点击审查改动」+ 折叠态首屏 4 行 +
#      「展开全部 6 个文件」→ 点开 6 行。
#   D. 悬停预览：行上 mouseenter 停 500ms → body 下出 `.hover-preview`（含 diff hunk 头）。
#   E. 审查：点行 → 停靠区切到审查面板（`.diff-pane[data-embed]` + 文件下拉 + chip 点亮）。
#   F. 打开：审查面板点「打开」→ 预览面板顶上来（`.file-preview-head`）。
#   G. 终端：切到终端页签 → 栏里**没有**「启动/结束」按钮（旧版自动起 shell）、
#      有 Shell 自绘下拉；等 shell 起来后 xterm 里出现「管道模式」与提示符。
#   H. 侧栏回车：焦点在会话行上按 Enter 就打开那条会话（旧版 rowKeys 同款）。
#
# 截图留档：默认停在「悬停预览浮层开着」的对话页（DSC_BATCH5_END=terminal 停在终端）。
#
# 隔离：USERPROFILE/HOME + DSC_DESKTOP_STATE + DSC_DESKTOP_USER_DATA 全钉在隔离目录；
# 种子工作区放在隔离 home 里；跑前跑后对真实 ~/.dsc 做「文件数 + 内容聚合 SHA256」比对。
#
# 用法：pwsh -NoProfile -File ui-batch5-check.ps1（宿主 lib 与壳产物需已构建：
#       pnpm run build + pnpm run build:ui）

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$swShots = 'D:\dsc\desktop\shots'
$swElectron = Join-Path $swShots '..\node_modules\electron\dist\electron.exe'
$swEntry = Join-Path $swShots '..\out\main\index.js'
$swHome = Join-Path $swShots 'batch5-home'
$swDsc = Join-Path $swHome '.dsc'
$swRealDsc = Join-Path $env:USERPROFILE '.dsc'
$swDocsA = Join-Path $swHome 'docs-a'

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

# ── 种子：一个隔离工作区 + 两条合成会话（一条复刻报障场景，一条给回车键用）──────────
Remove-Item -Recurse -Force -LiteralPath $swHome -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $swDsc | Out-Null
New-Item -ItemType Directory -Force -Path $swDocsA | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $swHome 'AppData\Roaming') | Out-Null

$swKeyA = ($swDocsA -replace '[:\\/]+', '-')
New-Item -ItemType Directory -Force -Path (Join-Path $swDsc "sessions\$swKeyA") | Out-Null

# 工作区里把「改动的文件」真建出来：预览页签（打开）读得到，diff 数据与磁盘一致。
$swFileNames = @('hover-a.txt', 'hover-b.txt', 'hover-c.txt', 'hover-d.txt', 'hover-e.txt', 'hover-f.txt')
$swFilePaths = @()
foreach ($name in $swFileNames) {
  $full = Join-Path $swDocsA $name
  Set-Content -LiteralPath $full -Value "第一行`r`n第二行" -Encoding UTF8 -NoNewline
  $swFilePaths += ($full -replace '\\', '\\')
}

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$swAgo = [int64]7 * 24 * 3600 * 1000   # 7 天前：与用户报障会话同款
$swUuid1 = 'c1111111-2222-3333-4444-555555555555'
$swUuid2 = 'c2222222-2222-3333-4444-555555555555'

$swSeedLines = New-Object System.Collections.Generic.List[string]
$swSeedLines.Add("{""type"":""meta"",""id"":""$swUuid1"",""cwd"":""$($swDocsA -replace '\\', '\\')"",""createdAt"":$($now - $swAgo)}")
$swSeedLines.Add("{""type"":""user"",""text"":""继续，写完后面两个文件"",""ts"":$($now - $swAgo)}")
# 模型一条 assistant + 6 刀工具结果（每刀一个文件），整轮跨度 3 秒。
$swCalls = @()
for ($i = 0; $i -lt 6; $i++) { $swCalls += "{""id"":""t$i"",""name"":""write"",""arguments"":""{\""path\"":\""$($swFilePaths[$i])\"",\""content\"":\""第一行\n第二行\n\""}""" }
$swSeedLines.Add("{""type"":""assistant"",""text"":"""",""reasoning"":"""",""toolCalls"":[$($swCalls -join ',')],""ts"":$($now - $swAgo + 1000)}")
for ($i = 0; $i -lt 6; $i++) {
  $ts = $now - $swAgo + 1500 + ($i * 100)
  $hunks = "[{""oldStart"":0,""oldCount"":0,""newStart"":1,""newCount"":2,""lines"":[{""kind"":""add"",""text"":""第一行"",""oldLine"":null,""newLine"":1},{""kind"":""add"",""text"":""第二行"",""oldLine"":null,""newLine"":2}]}]"
  $swSeedLines.Add("{""type"":""tool"",""callId"":""t$i"",""name"":""write"",""text"":""已写入 $($swFilePaths[$i])"",""changes"":{""path"":""$($swFilePaths[$i])"",""added"":2,""removed"":0,""status"":""added"",""hunks"":$hunks},""ts"":$ts}")
}
$swSeedLines.Add("{""type"":""assistant"",""text"":""两个文件写好了，正文里提一下 hover-a.txt 供 chip 验证。"",""reasoning"":"""",""ts"":$($now - $swAgo + 3000)}")
Set-Content -LiteralPath (Join-Path $swDsc "sessions\$swKeyA\$swUuid1.jsonl") -Value $swSeedLines -Encoding UTF8

# 第二条：只一条用户消息（回车键打开用）。
Set-Content -LiteralPath (Join-Path $swDsc "sessions\$swKeyA\$swUuid2.jsonl") -Encoding UTF8 -Value @(
  "{""type"":""meta"",""id"":""$swUuid2"",""cwd"":""$($swDocsA -replace '\\', '\\')"",""createdAt"":$($now - 60000)}",
  "{""type"":""user"",""text"":""回车键样本会话"",""ts"":$($now - 59000)}"
)

Set-Content -LiteralPath (Join-Path $swDsc 'sessions\meta.json') -Encoding UTF8 -Value (@{
  version = 1
  sessions = @{
    $swUuid1 = @{ title = '改动的悬停复刻' }
    $swUuid2 = @{ title = '回车键样本会话' }
  }
} | ConvertTo-Json -Depth 4)

Set-Content -LiteralPath (Join-Path $swDsc 'desktop.json') -Encoding UTF8 -Value (@{
  lastCwd = $swDocsA
  recentCwds = @($swDocsA)
  ui = 'shell'
} | ConvertTo-Json -Depth 4)

# ── 预跑 eval：轮尾 / 改动卡 / 悬停 / 审查 / 打开 / 终端 / 回车 ──────────────────
$swEval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = pred(); if (v) return v; await wait(150); }
    return null;
  };
  const out = {};
  await waitFor(() => {
    const root = document.querySelector('#root');
    return root !== null && root.children.length > 0;
  }, 20000);
  await wait(1200);

  // ── A 打开复刻会话（点侧栏那一条）──────────────────────────────────────────
  out.phase = 'open';
  const rows = [...document.querySelectorAll('.sess-item')];
  out.sessionTitles = rows.map((r) => (r.querySelector('.title') ?? {}).textContent?.trim() ?? '');
  const target = rows.find((r) => (r.textContent ?? '').includes('悬停复刻')) ?? rows[0];
  if (target !== undefined) { target.click(); }
  const foot = await waitFor(() => document.querySelector('.round-foot'), 12000);
  await wait(600);
  out.foot = foot === null ? null : {
    title: foot.getAttribute('title'),
    text: (foot.textContent ?? '').trim(),
    hasUsedText: /用时|次工具/.test(foot.textContent ?? ''),
    acts: [...foot.querySelectorAll('.round-act, .user-act')].length,
  };
  const fold = document.querySelector('.turn-fold');
  out.fold = fold === null ? null : { label: (fold.textContent ?? '').trim() };

  // ── C 改动卡：标题/提示/折叠/展开 ───────────────────────────────────────────
  out.phase = 'card';
  const card = await waitFor(() => document.querySelector('.changes-card[data-changed-files]'), 8000);
  const cardDiag = () => {
    const el = document.querySelector('.changes-card[data-changed-files]');
    if (el === null) return null;
    return {
      title: (el.querySelector('.changes-title') ?? {}).textContent?.trim() ?? '',
      hint: (el.querySelector('.changes-hint') ?? {}).textContent?.trim() ?? '',
      tile: el.querySelector('.changes-tile svg') !== null,
      rows: el.querySelectorAll('.changes-row').length,
      toggle: (el.querySelector('.changes-toggle') ?? {}).textContent?.trim() ?? null,
    };
  };
  out.cardBefore = cardDiag();
  const toggleBtn = card === null ? null : card.querySelector('.changes-toggle');
  if (toggleBtn !== null) { toggleBtn.click(); await wait(300); }
  out.cardAfter = cardDiag();

  // ── D 悬停预览：行上停 500ms 出浮层 ─────────────────────────────────────────
  out.phase = 'hover';
  const wrap = document.querySelector('.changes-row-wrap');
  if (wrap !== null) { wrap.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); }
  const hover = await waitFor(() => document.querySelector('.hover-preview'), 3000);
  out.hover = hover === null ? null : {
    name: (hover.querySelector('.hover-preview-name') ?? {}).textContent?.trim() ?? '',
    hunks: hover.querySelectorAll('.hover-preview-diff .diff-hunk').length,
    stat: (hover.querySelector('.hover-preview-stat') ?? {}).textContent?.trim() ?? '',
  };
  out.hoverKept = document.querySelector('.hover-preview') !== null;

  // ── E 审查：点一行 → 正文右侧的并排审查栏（旧桌面版形态：thread-zone 里的 .diff-pane）──
  out.phase = 'review';
  const firstRow = document.querySelector('.changes-row');
  if (firstRow !== null) { firstRow.click(); }
  const pane = await waitFor(() => document.querySelector('.thread-zone[data-review] .diff-pane[data-diff-pane]'), 5000);
  await wait(400);
  out.review = pane === null ? null : {
    visible: true,
    inDock: pane.closest('.dock') !== null,
    select: pane.querySelector('.diff-file-select') !== null,
    file: (pane.querySelector('.diff-file-name') ?? { textContent: '' }).textContent?.trim() ?? '',
    toolTexts: [...pane.querySelectorAll('.diff-tool')].map((b) => (b.textContent ?? '').trim()),
  };

  // ── F 打开：审查栏点「打开」→ 预览页签（右侧栏的 preview 页签）──────────────
  out.phase = 'preview';
  const openBtn = [...document.querySelectorAll('.diff-pane .diff-tool')].find((b) => (b.textContent ?? '').trim() === '打开');
  if (openBtn !== undefined) { openBtn.click(); }
  const head = await waitFor(() => document.querySelector('.file-preview-head'), 5000);
  out.preview = head === null ? null : {
    path: (head.querySelector('.file-preview-path') ?? {}).textContent?.trim() ?? '',
    chip: [...document.querySelectorAll('.dock-chip-label')].map((c) => (c.textContent ?? '').trim()).some((t) => t.includes('hover-')),
  };

  // ── G 终端：从开始页开（`+` 开开始页 → 点「新建终端」就地替换；旧版同款）───
  out.phase = 'terminal';
  // 「开始」页签在默认布局里，但它可能被 F 步的预览页签顶到后台——GuideBody 只在
  // 激活时渲染，先点它的 chip 把开始页叫到前台，再点入口卡。
  const guideChip = [...document.querySelectorAll('.dock-chip')].find((c) => (c.textContent ?? '').includes('开始'));
  if (guideChip !== undefined) { guideChip.click(); }
  await waitFor(() => document.querySelector('.dock-guide') !== null, 4000);
  const termEntry = [...document.querySelectorAll('.dock-guide-entry')].find((e) => (e.textContent ?? '').includes('新建终端'));
  if (termEntry !== undefined) { termEntry.click(); }
  await waitFor(() => document.querySelector('.term-bar') !== null, 8000);
  const bar = document.querySelector('.term-bar');
  out.terminal = bar === null ? null : {
    label: (bar.querySelector('.term-bar-label') ?? {}).textContent?.trim() ?? '',
    select: bar.querySelector('.select-trigger.term-select') !== null,
    buttons: [...bar.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).filter((t) => t !== ''),
    xterm: document.querySelector('.term-host .xterm') !== null,
  };
  // 等 shell 起来（宿主 spawn + 提示符）：xterm 的行文本里应出现管道模式说明与 PS>
  const rowsText = await waitFor(() => {
    const el = document.querySelector('.term-host .xterm-rows');
    const text = el === null ? '' : (el.textContent ?? '');
    return text.includes('管道模式') ? text : null;
  }, 15000);
  out.terminalRows = rowsText === null ? null : rowsText.replace(/\s+/g, ' ').slice(0, 220);
  out.terminalPrompt = rowsText !== null && rowsText.includes('PS>');

  // ── H 侧栏回车：焦点在行上按 Enter 打开 ─────────────────────────────────────
  out.phase = 'enter';
  const rows2 = [...document.querySelectorAll('.sess-item')];
  const second = rows2.find((r) => (r.textContent ?? '').includes('回车键样本'));
  let enterOk = false;
  if (second !== undefined) {
    second.focus();
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    enterOk = (await waitFor(() => document.querySelector('.sess-item.active') !== null && (document.querySelector('.sess-item.active').textContent ?? '').includes('回车键样本'), 8000)) !== null;
  }
  out.enterOpened = enterOk;

  // ── 收尾画面 ───────────────────────────────────────────────────────────────
  out.phase = 'end';
  const endScreen = '__END_SCREEN__';
  if (endScreen === 'terminal') {
    const chip = [...document.querySelectorAll('.dock-chip')].find((c) => (c.textContent ?? '').includes('终端'));
    if (chip !== undefined) { chip.click(); }
    await wait(400);
  } else {
    // 回到复刻会话，把悬停浮层重新点出来（截图留档）
    const back = [...document.querySelectorAll('.sess-item')].find((r) => (r.textContent ?? '').includes('悬停复刻'));
    if (back !== undefined) { back.click(); }
    await waitFor(() => document.querySelector('.changes-row-wrap') !== null, 8000);
    await wait(400);
    const wrap2 = document.querySelector('.changes-row-wrap');
    if (wrap2 !== null) { wrap2.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); }
    await waitFor(() => document.querySelector('.hover-preview') !== null, 3000);
  }
  out.done = true;
  return out;
})()
'@

$env:DSC_DESKTOP_USER_DATA = Join-Path $swHome 'electron-userdata'
$env:USERPROFILE = $swHome
$env:HOME = $swHome
$env:DSC_DESKTOP_STATE = Join-Path $swDsc 'desktop.json'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SHOT = Join-Path $swShots 'ui-batch5.png'
$env:DSC_DESKTOP_SHOT_DELAY = '108000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '98000'
Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue
Remove-Item Env:DSC_UI_QUERY -ErrorAction SilentlyContinue

$swEnd = $env:DSC_BATCH5_END
$swEvalFinal = $swEval.Replace('__END_SCREEN__', $(if ($swEnd -eq 'terminal') { 'terminal' } else { 'card' }))
$env:DSC_DESKTOP_SHOT_EVAL = $swEvalFinal

$outLog = Join-Path $swShots 'ui-batch5.out.log'
$errLog = Join-Path $swShots 'ui-batch5.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue

try {
  $swProc = Start-Process -FilePath $swElectron -ArgumentList $swEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $swDeadline = (Get-Date).AddSeconds(200)
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
  # A 轮尾：用时只进 title、可见面没有用时/次工具，且 7 天的会话恢复后报的是真实的 3 秒
  Check '复刻会话打开后轮尾在（.round-foot）' ($null -ne $swJson.foot)
  if ($null -ne $swJson.foot) {
    Check '轮尾 title 含「用时 3秒」（跳过「已恢复会话」system 行的口径）' ($swJson.foot.title -like '*用时 3秒*') $swJson.foot.title
    Check '轮尾可见文本不含「用时」' ($swJson.foot.hasUsedText -eq $false) $swJson.foot.text
    Check '轮尾可见文本不含「次工具」' (-not ($swJson.foot.text -like '*次工具*')) $swJson.foot.text
    Check '轮尾有复制/分叉两颗钮（旧界面同套动作去掉赞踩）' ($swJson.foot.acts -ge 2) ("$($swJson.foot.acts)")
  }
  Check '总开关标签是「用时 3秒」（不是 190时 这种天文数字）' ($null -ne $swJson.fold -and $swJson.fold.label -eq '用时 3秒') ($swJson.fold | ConvertTo-Json -Compress)
  # C 改动卡
  Check '改动卡标题「6 个文件已更改」' ($swJson.cardBefore.title -eq '6 个文件已更改') $swJson.cardBefore.title
  Check '改动卡提示是「点击审查改动」' ($swJson.cardBefore.hint -eq '点击审查改动') $swJson.cardBefore.hint
  Check '改动卡卡头是彩色文件图标（.changes-tile svg）' ($swJson.cardBefore.tile -eq $true)
  Check '6 行超过阈值：首屏只露 4 行' ($swJson.cardBefore.rows -eq 4) ("$($swJson.cardBefore.rows)")
  Check '折叠钮写「展开全部 6 个文件」' ($swJson.cardBefore.toggle -eq '展开全部 6 个文件') $swJson.cardBefore.toggle
  Check '点开折叠后 6 行全露' ($swJson.cardAfter.rows -eq 6) ("$($swJson.cardAfter.rows)")
  # D 悬停预览
  Check '悬停 500ms 出预览浮层（.hover-preview）' ($null -ne $swJson.hover)
  if ($null -ne $swJson.hover) {
    Check '浮层头是文件名（hover-a.txt）' ($swJson.hover.name -like '*hover-a.txt*') $swJson.hover.name
    Check '浮层里有 diff hunk' ($swJson.hover.hunks -ge 1) ("$($swJson.hover.hunks)")
  }
  Check '预览浮层在截图那拍还开着' ($swJson.hoverKept -eq $true)
  # E 审查（并排栏：旧桌面版形态——正文右侧，不在 dock 里）
  Check '点一行开并排审查栏（可见 + 文件下拉 + 不在 dock 里）' ($null -ne $swJson.review -and $swJson.review.visible -eq $true -and $swJson.review.select -eq $true -and $swJson.review.inDock -eq $false) ($swJson.review | ConvertTo-Json -Compress)
  Check '审查面板工具条含 分栏/换行/打开/关闭' ($null -ne $swJson.review -and ($swJson.review.toolTexts -join ',') -like '*分栏*换行*打开*关闭*') ($swJson.review.toolTexts -join ',')
  # F 打开进预览
  Check '审查栏点「打开」→ 预览页签顶上（.file-preview-head + 页签进条）' ($null -ne $swJson.preview -and $swJson.preview.chip -eq $true) ($swJson.preview | ConvertTo-Json -Compress)
  # G 终端
  Check '终端栏里没有「启动/结束」按钮（旧版自动起 shell）' ($null -ne $swJson.terminal -and -not (($swJson.terminal.buttons -join ',') -like '*启动*') -and -not (($swJson.terminal.buttons -join ',') -like '*结束*')) ($swJson.terminal.buttons -join ',')
  Check '终端栏有 Shell 自绘下拉 + xterm 已装配' ($null -ne $swJson.terminal -and $swJson.terminal.select -eq $true -and $swJson.terminal.xterm -eq $true)
  Check '终端里出现管道模式说明（spawn 的横幅）' ($null -ne $swJson.terminalRows -and $swJson.terminalRows -like '*管道模式*') $swJson.terminalRows
  Check '终端出现提示符（PS>，shell 真的起来了）' ($swJson.terminalPrompt -eq $true) $swJson.terminalRows
  # H 回车
  Check '侧栏会话行按 Enter 就打开（旧版 rowKeys 同款）' ($swJson.enterOpened -eq $true)
}

# ── 真实 ~/.dsc 未被污染 ───────────────────────────────────────────────────────
if ($null -ne $swRealBefore) {
  $swRealAfter = Get-DirFingerprint $swRealDsc
  Check '真实 ~/.dsc 文件数与内容指纹不变' ($swRealAfter.Count -eq $swRealBefore.Count -and $swRealAfter.ContentDigest -eq $swRealBefore.ContentDigest) ("$($swRealBefore.Count)/$($swRealAfter.Count)")
}

Check '截图落盘（ui-batch5.png）' (Test-Path -LiteralPath (Join-Path $swShots 'ui-batch5.png'))

Write-Output ""
Write-Output "第五批自检：$($swTotal - $swFail)/$swTotal 通过"
if ($swFail -gt 0) { exit 1 }
