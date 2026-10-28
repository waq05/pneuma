# 「轨迹页对标 dsh 改版」的隔离桌面自检（截图 + 取证）。
#
# 隔离怎么做：DSC_DESKTOP_USER_DATA 换掉 Electron 的 userData，USERPROFILE / HOME 换掉宿主的
# ~/.dsc——会话、配置、settings 全落在 desktop/shots/trace-home 下，用户真实的 ~/.dsc 一个字节
# 都不写。种子数据见 shots/trace-seed.mjs（手写 jsonl，走的是与「打开老会话」相同的重放路径）。
# 跑前跑后各对真实 ~/.dsc 做一次「文件数 + 全量 SHA256 聚合指纹」比对，两个指纹都写进报告。
#
# 进程管理（本脚本刻意不用 `& electron | Out-File`）：Start-Process 起 electron.exe、
# 轮询 stderr 日志里的关键行、最后 taskkill /PID <自己起的那棵进程树> /T /F。
# 临时目录变量一律自命名（$traceHome 等），绝不用 $home / $HOME——那是 PowerShell 只读自动变量，
# 赋值会静默失败并把后续写入落到真实用户目录。
#
# 用法（先在 desktop/ 跑 `pnpm run build`，否则拍的是旧包）：
#   pwsh -NoProfile -File trace-shots.ps1              # 两个用例（深色 / 浅色）
#   pwsh -NoProfile -File trace-shots.ps1 -Only trace-static
#
# 每个用例把证据打成一行 JSON（日志里搜「预跑脚本完成」），截图落在 shots/trace-*.png。

param([string]$Only = 'all')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$traceShots = 'D:\dsc\desktop\shots'
$traceElectron = Join-Path $traceShots '..\node_modules\electron\dist\electron.exe'
$traceEntry = Join-Path $traceShots '..\out\main\index.js'
$traceHome = Join-Path $traceShots 'trace-home'
# 真实用户目录：必须在把 USERPROFILE/HOME 指到隔离目录之前读出来。
$traceRealProfile = $env:USERPROFILE
$traceRealDsc = Join-Path $traceRealProfile '.dsc'

# ── 真实 ~/.dsc 的指纹：文件数 + 「相对路径|字节数|SHA256」全量清单的聚合哈希 ────────
# 为什么带 try/catch：真实 ~/.dsc 下可能有正在运行的会话 jsonl 被宿主独占着（用户此刻就在用
# Muse Code），Get-FileHash 会直接抛。这种文件记成 LOCKED + 字节数 + 最后写入时刻，
# 「跑前跑后有没有多出/少掉文件」这条最关键的安全性判断照样成立。
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
  # 内容指纹：只看「相对路径 + 内容哈希」，字节数与锁定状态不参与（被别的进程写着的活跃会话
  # 一变，清单指纹就会变，那不是本次改动造成的）。
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

# ── 预跑脚本里反复用到的探针 ────────────────────────────────────────────────────
$traceEvalHead = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = pred(); if (v) return v; await wait(120); }
  return null;
};
const shape = (el) => {
  const b = el.getBoundingClientRect();
  return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
};
const text = (el) => (el === null || el === undefined ? null : el.textContent.trim());
const rows = () => Array.from(document.querySelectorAll('[data-trace-step]'));
const all = (sel) => Array.from(document.querySelectorAll(sel));
const labelsOf = (root) => Array.from(root.querySelectorAll('.ti-label')).map((n) => n.textContent.trim());
const chatBox = () => document.querySelector('.chat');
/** 满距底还有多远（一次性读数；内容变高后要重算）。 */
const awayFromBottom = (chat) => chat.scrollHeight - chat.clientHeight - chat.scrollTop;
/** 在轨道上按比例拖一段：PointerEvent 合成派发（React 挂在根容器上，冒泡到根就能收到）。 */
const dragTrack = (fromRatio, toRatio) => {
  const track = document.querySelector('[data-trace-track]');
  if (track === null) return false;
  const box = track.getBoundingClientRect();
  const y = box.top + box.height / 2;
  const at = (ratio) => box.left + box.width * ratio;
  const fire = (type, x, buttons) => track.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'mouse',
    isPrimary: true, button: 0, buttons, clientX: x, clientY: y,
  }));
  fire('pointerdown', at(fromRatio), 1);
  fire('pointermove', at((fromRatio + toRatio) / 2), 1);
  fire('pointermove', at(toRatio), 1);
  fire('pointerup', at(toRatio), 0);
  return true;
};
const clickTrack = (ratio) => {
  const track = document.querySelector('[data-trace-track]');
  if (track === null) return false;
  const box = track.getBoundingClientRect();
  const y = box.top + box.height / 2;
  const x = box.left + box.width * ratio;
  const fire = (type, buttons) => track.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'mouse',
    isPrimary: true, button: 0, buttons, clientX: x, clientY: y,
  }));
  fire('pointerdown', 1);
  fire('pointerup', 0);
  return true;
};
'@

# ── 用例正文：切到轨迹页 → 逐项取证 → 摆成留给截图的那一屏 ──────────────────────
# __END__ 由脚本替换成 inspector（深色用例：停在检查器打开的那一屏）
# 或 selection（浅色用例：停在拖选区间聚焦的那一屏）。
$traceEvalBody = @'

(async () => {
  const END = '__END__';
  const started = Date.now();
  const tab = await waitFor(() => Array.from(document.querySelectorAll('.tabs button')).find((b) => b.textContent.trim() === '轨迹'), 20000);
  if (tab === undefined || tab === null) return { case: 'trace', error: '没找到「轨迹」标签' };
  tab.click();
  const ready = await waitFor(() => document.querySelector('[data-trace-timeline]') !== null && rows().length >= 4, 25000);
  if (ready === null) return { case: 'trace', error: '轨迹页没渲染出来', rows: rows().length, ms: Date.now() - started };
  await wait(900);

  // 加载完这一眼先量「默认贴底」：轨迹页默认只展开最新一轮，正好是贴底那一屏。
  const chat = chatBox();
  const atBottomOnLoad = Math.abs(awayFromBottom(chat)) <= 2;

  // 断言要看全部步骤，所以先把每一轮都展开（默认只展开最新一轮）。
  const expandAll = document.querySelector('.trace-toggle-all');
  if (expandAll !== null && expandAll.textContent.trim() === '全部展开') expandAll.click();
  const allRows = await waitFor(() => rows().length >= 10, 8000);
  await wait(600);

  // ── 时间概览条 ──
  const timeline = document.querySelector('.trace-timeline');
  const track = document.querySelector('[data-trace-track]');
  const bars = all('.ttl-bar').map((b) => ({
    id: b.dataset.traceMark, kind: b.dataset.kind, duration: Number(b.dataset.duration), ...shape(b),
  }));
  const ticks = all('.ttl-tick').map((t) => ({ id: t.dataset.traceMark, kind: t.dataset.kind, ...shape(t) }));
  const timelineInfo = {
    present: timeline !== null,
    projectable: track === null ? null : track.dataset.projectable,
    marks: timeline === null ? null : timeline.dataset.marks,
    box: timeline === null ? null : shape(timeline),
    bars, ticks,
    separators: all('.ttl-sep').map((s) => ({ round: s.dataset.traceBoundary, ...shape(s) })),
    range: text(document.querySelector('.ttl-range')),
  };

  // ── 压缩区段行 ──
  const compactions = all('[data-trace-compaction]').map((n) => ({ count: n.dataset.traceCompaction, text: text(n) }));

  // ── 行内元信息 ──
  const rowInfo = rows().map((r) => ({
    id: r.dataset.traceStep, kind: r.dataset.kind, round: r.dataset.round, status: r.dataset.status ?? null,
    clock: text(r.querySelector('.tmeta-clock')), dur: text(r.querySelector('.tmeta-dur')),
    tok: text(r.querySelector('.tmeta-tok')), hasOpen: r.querySelector('.tmeta-open') !== null,
  }));
  const failedColor = all('[data-trace-step][data-status="failed"] .tmeta-clock')
    .map((n) => getComputedStyle(n).color)[0] ?? null;
  const rejectedColor = all('[data-trace-step][data-status="rejected"] .tmeta-clock')
    .map((n) => getComputedStyle(n).color)[0] ?? null;
  const okColor = all('[data-trace-step][data-kind="tool"]:not([data-status="failed"]):not([data-status="rejected"]) .tmeta-clock')
    .map((n) => getComputedStyle(n).color)[0] ?? null;

  // ── 尾部跟随：上滚不被拽回 / 回底恢复（不弹按钮） ──
  // （默认贴底那一条在展开全部之前就量过了，见上面 atBottomOnLoad）
  // 先把所有轮展开：默认只展开最新一轮时内容可能不够滚（scrollUpBy<120 就没法判持住）。
  // 按钮文案是「全部展开/全部折叠」二态——前面步骤可能已经把轮全点开了，那时再点就是收起。
  const traceToggleAll = document.querySelector('.trace-toggle-all');
  if (traceToggleAll !== null && traceToggleAll.textContent.indexOf('全部展开') >= 0) {
    traceToggleAll.click();
    await wait(600);
  }
  // 滚多远要看内容有多高：总可滚量不足 300px 时按剩余量滚（种子内容短的时候也能量）。
  const scrollLimit = chat.scrollHeight - chat.clientHeight;
  const scrollUpBy = Math.min(300, Math.max(0, scrollLimit - 40));
  chat.scrollTop = chat.scrollHeight - chat.clientHeight - scrollUpBy;
  await wait(700);
  const awayAfterScrollUp = chat.scrollHeight - chat.clientHeight - chat.scrollTop;
  // 内容不足以滚出 120px（暂停阈值）时，「持住」没法量，记成跳过而不是失败——
  // 短会话本来就不存在「滚离底部」这个状态，跟随后面回到贴底照旧要验。
  const heldAfterScrollUp = scrollLimit < 150
    ? null
    : (scrollUpBy >= 120 && Math.abs(awayAfterScrollUp - scrollUpBy) <= 8);
  const followButtonCount = all('.trace-page .chat-to-bottom').length;
  chat.scrollTop = chat.scrollHeight;
  await wait(500);
  const backAtBottom = Math.abs(awayFromBottom(chat)) <= 2;

  // ── 拖选区间 → 聚焦 → 三种清除方式 ──
  dragTrack(0.005, 0.5);
  await wait(700);
  const selection = {
    band: document.querySelector('[data-trace-selection]') !== null,
    chip: text(document.querySelector('.ttl-chip')),
    hits: all('[data-trace-step][data-hit="1"]').length,
    dim: all('[data-trace-step].is-dim').length,
  };
  clickTrack(0.5);
  await wait(400);
  const clearedByClick = document.querySelector('[data-trace-selection]') === null && all('[data-trace-selection-chip]').length === 0;
  dragTrack(0.005, 0.5);
  await wait(500);
  const track2 = document.querySelector('[data-trace-track]');
  track2.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await wait(400);
  const clearedByRightClick = document.querySelector('[data-trace-selection]') === null;

  // ── 检查器：工具行 ──
  const readRow = rows().find((r) => r.dataset.kind === 'tool' && text(r.querySelector('.tmeta-dur')) === '4.2s');
  const openCount = { before: all('.trace-inspector').length };
  if (readRow !== undefined) readRow.querySelector('.tmeta-open').click();
  await wait(600);
  const panel = document.querySelector('.trace-inspector');
  const toolPanel = panel === null ? null : {
    kind: panel.dataset.kind,
    scrim: document.querySelector('[data-trace-scrim]') !== null,
    labels: labelsOf(panel),
    argsPretty: (() => { const c = panel.querySelector('[data-trace-code="args"]'); return c === null ? null : { formatted: c.dataset.formatted, lines: c.textContent.split('\n').length, head: c.textContent.slice(0, 40) }; })(),
    resultFormatted: (() => { const c = panel.querySelector('[data-trace-code="result"]'); return c === null ? null : c.dataset.formatted; })(),
    facts: {
      start: text(panel.querySelector('[data-trace-fact="发起时刻"]')),
      used: text(panel.querySelector('[data-trace-fact="耗时"]')),
    },
    usage: text(panel.querySelector('.ti-sec:last-child .ti-empty')),
    hasCopy: panel.querySelector('[data-trace-copy-args]') !== null,
    hasFormatToggle: panel.querySelector('[data-trace-format-toggle]') !== null,
    close: panel.querySelector('[data-trace-inspector-close]') !== null,
  };
  // 格式化开关：切一下要变回原文（单行、无缩进）
  let rawToggle = null;
  const toggle = panel === null ? null : panel.querySelector('[data-trace-format-toggle]');
  if (toggle !== null && toggle !== undefined) {
    toggle.click();
    await wait(300);
    const code = document.querySelector('[data-trace-code="args"]');
    rawToggle = { label: text(toggle), lines: code.textContent.split('\n').length, state: toggle.dataset.state };
  }
  // 复制参数：点一下取回执（回执是短命的，这里只记录证据，判定不看它）
  const copyBtn = panel === null ? null : panel.querySelector('[data-trace-copy-args]');
  if (copyBtn !== null && copyBtn !== undefined) copyBtn.click();
  await wait(400);
  const copyToast = text(document.querySelector('.dsc-toast__text'));
  // 关：右上角 ×
  if (toolPanel !== null) panel.querySelector('[data-trace-inspector-close]').click();
  await wait(400);
  const closedByX = document.querySelector('.trace-inspector') === null && document.querySelector('[data-trace-scrim]') === null;

  // 换个入口：点系统事件那一行本身（不是那颗按钮）也要开
  const sysRow = rows().find((r) => r.dataset.kind === 'system');
  if (sysRow !== undefined) sysRow.querySelector('.trace-sys').click();
  await wait(500);
  const sysPanel = document.querySelector('.trace-inspector');
  const systemPanel = sysPanel === null ? null : { kind: sysPanel.dataset.kind, labels: labelsOf(sysPanel) };
  // 关：点遮罩
  const scrim = document.querySelector('[data-trace-scrim]');
  if (scrim !== null) scrim.click();
  await wait(400);
  const closedByScrim = document.querySelector('.trace-inspector') === null;

  // ── 检查器：用户消息（附件区 + 放大浮层） ──
  const userOpen = document.querySelector('[data-trace-round="3"] .round-open');
  if (userOpen !== null) userOpen.click();
  await wait(600);
  const userPanel = document.querySelector('.trace-inspector');
  const userInfo = userPanel === null ? null : {
    kind: userPanel.dataset.kind,
    labels: labelsOf(userPanel),
    attachments: userPanel.querySelector('[data-trace-attachments]') === null
      ? null : Number(userPanel.querySelector('[data-trace-attachments]').dataset.traceAttachments),
    shots: userPanel.querySelectorAll('[data-trace-shot]').length,
    thumbs: Array.from(userPanel.querySelectorAll('[data-trace-shot] img')).map((img) => ({ w: Math.round(img.getBoundingClientRect().width), src: img.getAttribute('src').slice(0, 22) })),
  };
  const firstShot = userPanel === null ? null : userPanel.querySelector('[data-trace-shot]');
  if (firstShot !== null && firstShot !== undefined) firstShot.click();
  await wait(400);
  const lightboxOpen = document.querySelector('[data-trace-lightbox]') !== null;
  const lightbox = document.querySelector('[data-trace-lightbox]');
  if (lightbox !== null) lightbox.click();
  await wait(300);
  const lightboxClosed = document.querySelector('[data-trace-lightbox]') === null;
  const closeUser = document.querySelector('[data-trace-inspector-close]');
  if (closeUser !== null) closeUser.click();
  await wait(400);

  // ── 留给截图的那一屏 ──
  await wait(300);
  let endState = {};
  if (END === 'inspector') {
    const again = rows().find((r) => r.dataset.kind === 'tool' && text(r.querySelector('.tmeta-dur')) === '4.2s');
    if (again !== undefined) again.querySelector('.tmeta-open').click();
    const box = chatBox();
    box.scrollTop = 0;
    await wait(900);
    endState = { inspectorOpen: document.querySelector('.trace-inspector') !== null, scrollTop: Math.round(box.scrollTop) };
  } else {
    dragTrack(0.02, 0.42);
    const box = chatBox();
    box.scrollTop = 0;
    await wait(900);
    endState = { selected: document.querySelector('[data-trace-selection]') !== null, chip: text(document.querySelector('.ttl-chip')) };
  }

  const compactRowVisible = (() => {
    const node = document.querySelector('[data-trace-compaction]');
    if (node === null) return false;
    const b = node.getBoundingClientRect();
    const c = chatBox().getBoundingClientRect();
    return b.top >= c.top - 1 && b.bottom <= c.bottom + 1;
  })();

  return {
    case: 'trace',
    ms: Date.now() - started,
    theme: document.documentElement.dataset.theme,
    rowsRendered: allRows !== null ? rows().length : rows().length,
    timeline: timelineInfo,
    compactions,
    rows: rowInfo,
    colors: { failed: failedColor, rejected: rejectedColor, ok: okColor },
    follow: { atBottomOnLoad, heldAfterScrollUp, backAtBottom, followButtonCount, diag: { scrollLimit, scrollUpBy, awayAfterScrollUp } },
    selection,
    toolPanel, rawToggle, copyToast, closedByX,
    systemPanel, closedByScrim,
    userInfo, lightboxOpen, lightboxClosed,
    endState,
    compactRowVisible,
    end: END,
    openCount,
    // ── 判定 ──
    hasCompactionRow: compactions.length === 1 && compactions[0].text.indexOf('已压缩历史 · 第 1 次') === 0,
    compactRowVisible,
    timelineRendered: timelineInfo.present && timelineInfo.projectable === '1' && timelineInfo.bars.length === 5
      && Number(timelineInfo.marks) === timelineInfo.bars.length + ticks.length,
    // 有宽度的只有拿到 durationMs 的工具：5 条 bar 的 data-duration 就是那五个真值
    barDurations: bars.map((b) => b.duration).join(','),
    barsOnlyTools: bars.every((b) => b.kind === 'tool' && Number.isFinite(b.duration)),
    // 刻度一律 2px：宽度不是投影出来的（刻度条数 = 总标记 − 有宽度的条，不写死数字）
    ticksAreTicks: ticks.length > 0 && ticks.every((t) => t.w <= 3),
    // 63s 的条该是 4.2s 那条的约 15 倍宽（同一套线性投影）
    widthRatioHonest: (() => {
      const long = bars.find((b) => b.duration === 63000);
      const short = bars.find((b) => b.duration === 4200);
      if (long === undefined || short === undefined || short.w === 0) return false;
      const ratio = long.w / short.w;
      return ratio > 10 && ratio < 22;
    })(),
    roundSeparators: timelineInfo.separators.length === 3,
    clockFormat: rowInfo.filter((r) => r.clock !== null).every((r) => /^\d\d:\d\d$/.test(r.clock)),
    durationsShown: ['4.2s', '1m03s', '0.5s', '16.0s', '0.3s'].every((d) => rowInfo.some((r) => r.dur === d)),
    // running 的那次调用：有卡、有刻度、没有耗时格
    runningNoDuration: (() => {
      const running = rowInfo.filter((r) => r.status === 'running');
      return running.length === 1 && running[0].dur === null && ticks.length > 0;
    })(),
    noUsageOnReplay: rowInfo.every((r) => r.tok === null),
    failedColorIsRed: failedColor !== null && failedColor !== okColor,
    rejectedColorIsAmber: rejectedColor !== null && rejectedColor !== okColor && rejectedColor !== failedColor,
    // 检查器
    inspectorOpens: toolPanel !== null && toolPanel.scrim,
    inspectorSections: toolPanel !== null && toolPanel.labels.join(',') === '输入,输出,计时,用量',
    argsPrettyPrinted: toolPanel !== null && toolPanel.argsPretty.formatted === '1' && toolPanel.argsPretty.lines > 1,
    resultJsonPreferred: toolPanel !== null && toolPanel.resultFormatted === '0',
    timingFacts: toolPanel !== null && toolPanel.facts.start.indexOf('发起时刻') === 0 && /\d\d:\d\d:\d\d/.test(toolPanel.facts.start) && /4\.2s/.test(toolPanel.facts.used),
    usageHonest: toolPanel !== null && typeof toolPanel.usage === 'string' && toolPanel.usage.indexOf('未记录') >= 0,
    copyButton: toolPanel !== null && toolPanel.hasCopy,
    formatToggleWorks: rawToggle !== null && rawToggle.lines === 1 && rawToggle.state === 'raw' && rawToggle.label === '格式化',
    closedByX,
    rowClickOpensInspector: systemPanel !== null && systemPanel.kind === 'system',
    closedByScrim,
    userAttachments: userInfo !== null && userInfo.kind === 'user' && userInfo.attachments === 2 && userInfo.shots === 2 && userInfo.thumbs.every((t) => t.w > 100 && t.src.indexOf('data:image/png') === 0),
    lightboxWorks: lightboxOpen && lightboxClosed,
    selectionWorks: selection.band && selection.hits >= 2 && selection.dim >= 2 && typeof selection.chip === 'string' && selection.chip.indexOf('清除') > 0,
    selectionCleared: clearedByClick && clearedByRightClick,
    followWorks: heldAfterScrollUp !== false && atBottomOnLoad && backAtBottom && followButtonCount === 0,
    endState,
  };
})()
'@

$traceCases = [ordered]@{
  'trace-static' = @{ theme = 'dark';  end = 'inspector'; delay = 45000; lead = 34000 }
  'trace-light'  = @{ theme = 'light'; end = 'selection'; delay = 45000; lead = 34000 }
}

Write-Output '=== 真实 ~/.dsc 跑前指纹 ==='
$traceBefore = Get-DirFingerprint $traceRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 清单聚合 {2} · 内容聚合 {3}" -f $traceBefore.Count, $traceBefore.Locked, $traceBefore.Digest, $traceBefore.ContentDigest)
Write-FingerprintFile (Join-Path $traceShots 'trace-realhome-before.txt') $traceBefore '跑前'

try {
  foreach ($name in $traceCases.Keys) {
    if ($Only -ne 'all' -and $Only -ne $name) { continue }
    $spec = $traceCases[$name]

    # 每个用例重新造种子：会话文件是新的，主题在这里定
    $env:TRACE_THEME = $spec.theme
    node (Join-Path $traceShots 'trace-seed.mjs') | Out-Null
    $traceSessions = Get-Content (Join-Path $traceShots 'trace-sessions.json') -Raw | ConvertFrom-Json

    $env:DSC_DESKTOP_USER_DATA = Join-Path $traceHome 'electron-userdata'
    $env:USERPROFILE = $traceHome
    $env:HOME = $traceHome
    $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
    $env:DSC_RESUME_SESSION = $traceSessions.session
    $env:DSC_DESKTOP_SHOT = Join-Path $traceShots "$name.png"
    $env:DSC_DESKTOP_SHOT_DELAY = [string]$spec.delay
    $env:DSC_DESKTOP_SHOT_EVAL_LEAD = [string]$spec.lead
    $env:DSC_DESKTOP_SHOT_EVAL = ($traceEvalHead + $traceEvalBody).Replace('__END__', $spec.end)
    Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue

    $outLog = Join-Path $traceShots "$name.out.log"
    $errLog = Join-Path $traceShots "$name.err.log"
    Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
    Write-Output "=== $name（主题 $($spec.theme)；收尾状态 $($spec.end)；隔离目录 $traceHome）==="

    # Start-Process 起 electron.exe（不用 `& electron | Out-File`），stderr 直接重定向到文件，
    # 自检那几行 [selfcheck] 就在里面。
    $traceProc = Start-Process -FilePath $traceElectron -ArgumentList $traceEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $traceDeadline = (Get-Date).AddSeconds($spec.delay + 60)
    $traceSeen = ''
    while ((Get-Date) -lt $traceDeadline) {
      if (Test-Path -LiteralPath $errLog) {
        $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|页面加载失败|截图失败' -ErrorAction SilentlyContinue
        if ($null -ne $hit) { $traceSeen = $hit[0].Line; break }
      }
      if ($traceProc.HasExited) { break }
      Start-Sleep -Milliseconds 500
    }
    # 只杀自己刚起的那一棵进程树（electron + 它拉起的宿主子进程），不碰别的进程（比如 Muse Code.exe）。
    & taskkill /PID $traceProc.Id /T /F 2>&1 | Out-Null
    Start-Sleep -Milliseconds 600
    Write-Output ("  electron 已收工：{0}" -f ($traceSeen -replace '\s+$', ''))

    if (Test-Path -LiteralPath $errLog) {
      Select-String -LiteralPath $errLog -Pattern '预跑脚本完成|预跑脚本失败|已写出|页面加载失败' |
        ForEach-Object { '  ' + $_.Line }
      # 判定行单独拎出来，报告里直接抄这一行
      Select-String -LiteralPath $errLog -Pattern '"hasCompactionRow"' | ForEach-Object { '  ' + $_.Line }
    }
  }
} finally {
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_SEARCH,
    Env:DSC_DESKTOP_USER_DATA, Env:TRACE_THEME -ErrorAction SilentlyContinue
}

Write-Output '=== 真实 ~/.dsc 跑后指纹 ==='
$traceAfter = Get-DirFingerprint $traceRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 清单聚合 {2} · 内容聚合 {3}" -f $traceAfter.Count, $traceAfter.Locked, $traceAfter.Digest, $traceAfter.ContentDigest)
Write-FingerprintFile (Join-Path $traceShots 'trace-realhome-after.txt') $traceAfter '跑后'
$traceDiff = Compare-Object -ReferenceObject $traceBefore.Lines -DifferenceObject $traceAfter.Lines
if ($null -eq $traceDiff) {
  Write-Output '差异行：无（逐文件哈希完全一致）'
} else {
  Write-Output ("差异行：{0} 条（只看路径集合是否有增删，与内容是否变化）" -f @($traceDiff).Count)
  $traceDiff | ForEach-Object { '  ' + $_.SideIndicator + ' ' + $_.InputObject }
}
$tracePathsBefore = @($traceBefore.Lines | ForEach-Object { ($_ -split '\|')[0] })
$tracePathsAfter = @($traceAfter.Lines | ForEach-Object { ($_ -split '\|')[0] })
$traceAdded = @($tracePathsAfter | Where-Object { $tracePathsBefore -notcontains $_ })
$traceRemoved = @($tracePathsBefore | Where-Object { $tracePathsAfter -notcontains $_ })
Write-Output ("路径增删：新增 {0} 个、减少 {1} 个" -f $traceAdded.Count, $traceRemoved.Count)
Write-Output ("文件数一致：{0}；内容聚合一致：{1}" -f ($traceBefore.Count -eq $traceAfter.Count), ($traceBefore.ContentDigest -eq $traceAfter.ContentDigest))
Write-Output '全部完成'
