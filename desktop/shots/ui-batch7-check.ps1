# 第七批专项自检（2026-10-12）：执行轨迹页 + 右缘刻度条 + 「在轨迹中查看」跳转。
#
# 分两段（一条 eval 里跑完）：
#   A. 历史会话重放（种子 jsonl，无耗时数据）：顶栏页签切轨迹页、时间条刻度、轮次表折叠、
#      检查器开合、搜索过滤、拖选聚焦、滚轮缩放、会话右键「查看轨迹」、刻度条本体。
#   B. 假端点实跑一轮（read 工具真跑一次）：轨迹页里长出**有宽度的耗时条**与行内「用时」；
#      对话页工具行的「在轨迹中查看」药丸点一下 → 轨迹页 + 聚焦闪烁。
#
# 隔离：USERPROFILE/HOME + DSC_DESKTOP_STATE + DSC_DESKTOP_USER_DATA 全钉在隔离目录；
# 跑前跑后对真实 ~/.dsc 做「文件数 + 内容聚合 SHA256」比对。
#
# 用法：pwsh -NoProfile -File ui-batch7-check.ps1（宿主 lib 与壳产物需已构建：
#       pnpm run build + pnpm run build:ui + desktop 的 pnpm run build）

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$swShots = 'D:\dsc\desktop\shots'
$swElectron = Join-Path $swShots '..\node_modules\electron\dist\electron.exe'
$swEntry = Join-Path $swShots '..\out\main\index.js'
$swHome = Join-Path $swShots 'batch7-home'
$swDsc = Join-Path $swHome '.dsc'
$swRealDsc = Join-Path $env:USERPROFILE '.dsc'
$swWsB = Join-Path $swHome 'ws-b'
$swPort = 18927
$swFake = Join-Path $swShots '_batch7-fake-llm.mjs'

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

# ── 种子：一个工作区 + 一条三轮会话（工具 / 思考 / 多轮，供轨迹页与刻度条用）────────
Remove-Item -Recurse -Force -LiteralPath $swHome -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $swDsc, $swWsB, (Join-Path $swHome 'AppData\Roaming') | Out-Null

Set-Content -LiteralPath (Join-Path $swWsB 'marker-ws-b.txt') -Value 'ws' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $swWsB 'readme.txt') -Value "第一行：这是轨迹自检的工作区说明。`n第二行：假端点会读这个文件一次。" -Encoding UTF8

$swKeyB = ($swWsB -replace '[:\\/]+', '-')
New-Item -ItemType Directory -Force -Path (Join-Path $swDsc "sessions\$swKeyB") | Out-Null

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$swUuid1 = 'd7777777-8888-9999-aaaa-bbbbbbbbbbbb'
$swMarker = ($swWsB -replace '\\', '\\')

Set-Content -LiteralPath (Join-Path $swDsc 'config.yaml') -Encoding utf8NoBOM -Value @"
# 自检专用配置：一个指向本机假端点的 provider（不联网、不花钱）
default:
  provider: fake
  model: fake-trace
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:$swPort/v1
    apiKeyEnv: DSC_FAKE_KEY
    models:
      - id: fake-trace
        name: Fake Trace
        contextWindow: 128000
        maxTokens: 4096
"@
$env:DSC_FAKE_KEY = 'sk-selfcheck-fake'

$swLines = New-Object System.Collections.Generic.List[string]
$swLines.Add("{""type"":""meta"",""id"":""$swUuid1"",""cwd"":""$swMarker"",""createdAt"":$now}")
$swLines.Add("{""type"":""user"",""text"":""轨迹自检第一轮：先读会话记录，再看刻度条。"",""ts"":$($now + 1000)}")
$swLines.Add("{""type"":""assistant"",""text"":"""",""reasoning"":""先看看配置"",""toolCalls"":[{""id"":""t1"",""name"":""read"",""arguments"":""{\""path\"":\""marker-ws-b.txt\""}""},{""id"":""t2"",""name"":""grep"",""arguments"":""{\""pattern\"":\""compilerOptions\""}""}],""ts"":$($now + 2000)}")
$swLines.Add("{""type"":""tool"",""callId"":""t1"",""name"":""read"",""text"":""读完了：一行"" ,""ts"":$($now + 2200)}")
$swLines.Add("{""type"":""tool"",""callId"":""t2"",""name"":""grep"",""text"":""搜到了：两处"",""ts"":$($now + 2400)}")
$swLines.Add("{""type"":""assistant"",""text"":""第一轮收尾：读了两处，先把结论记下。"",""reasoning"":"""",""ts"":$($now + 2600)}")
$swLines.Add("{""type"":""user"",""text"":""轨迹自检第二轮：这一轮只有一次 bash 调用。"",""ts"":$($now + 4000)}")
$swLines.Add("{""type"":""assistant"",""text"":"""",""reasoning"":""跑一下校验"",""toolCalls"":[{""id"":""t3"",""name"":""bash"",""arguments"":""{\""command\"":\""pnpm typecheck\""}""}],""ts"":$($now + 5000)}")
$swLines.Add("{""type"":""tool"",""callId"":""t3"",""name"":""bash"",""text"":""校验通过"",""ts"":$($now + 6000)}")
$swLines.Add("{""type"":""assistant"",""text"":""第二轮收尾：校验通过，没有别的问题。"",""reasoning"":"""",""ts"":$($now + 6200)}")
$swLines.Add("{""type"":""user"",""text"":""轨迹自检第三轮：这一轮不跑工具，只有回答。"",""ts"":$($now + 8000)}")
$swLines.Add("{""type"":""assistant"",""text"":""第三轮收尾：没有工具，只有这段回答。"",""reasoning"":"""",""ts"":$($now + 9000)}")
Set-Content -LiteralPath (Join-Path $swDsc "sessions\$swKeyB\$swUuid1.jsonl") -Value $swLines -Encoding UTF8

Set-Content -LiteralPath (Join-Path $swDsc 'sessions\meta.json') -Encoding UTF8 -Value (@{
  version = 1
  sessions = @{ $swUuid1 = @{ title = '轨迹自检会话' } }
} | ConvertTo-Json -Depth 4)

Set-Content -LiteralPath (Join-Path $swDsc 'desktop.json') -Encoding UTF8 -Value (@{
  lastCwd = $swWsB
  recentCwds = @($swWsB)
  ui = 'shell'
} | ConvertTo-Json -Depth 4)

# ── 预跑 eval ──────────────────────────────────────────────────────────────────
$swEval = @'
(async () => {
  // 硬截止：整段脚本必须在截图前收工（截图时刻一到进程就退，没返回的读数全丢）。
  // 每段把阶段写进 window.__batch7Stage，异常时外层 catch 能说清跑到哪一步了。
  const startedAt = Date.now();
  const hardDeadline = startedAt + 380000;
  const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, hardDeadline - Date.now()))));
  const waitFor = async (pred, ms) => {
    const until = Math.min(Date.now() + ms, hardDeadline);
    while (Date.now() < until) { const v = pred(); if (v !== null && v !== false && v !== undefined) return v; await wait(150); }
    return null;
  };
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const text = (el) => el === null || el === undefined ? null : (el.textContent ?? '').trim();
  const setInput = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const out = { case: 'batch7' };
  await waitFor(() => { const root = q('#root'); return root !== null && root.children.length > 0; }, 30000);
  await wait(2000);

  // 打开种子会话：会话行可能已经在（分组默认展开）；不在就先展开 ws-b 分组再找。
  // 注意别盲目点分组行——分组本来就是展开的，点一下反而把它收起来（第一版自检这么翻过一次）。
  let row = qa('.sess-item').find((r) => (r.textContent ?? '').includes('轨迹自检会话'));
  if (row === undefined) {
    const group = qa('.group-row').find((g) => (g.textContent ?? '').includes('ws-b'));
    if (group !== undefined) { group.click(); }
    await wait(500);
    row = await waitFor(() => qa('.sess-item').find((r) => (r.textContent ?? '').includes('轨迹自检会话')) ?? null, 8000);
  }
  if (row !== undefined && row !== null) { row.click(); }
  await waitFor(() => q('.turn-seat') !== null, 15000);
  await wait(1200);
  out.opened = q('.turn-seat') !== null;
  window.__batch7Stage = 'open';

  // ── A. 顶栏页签 → 轨迹页 ───────────────────────────────────────────────────
  window.__batch7Stage = 'A';
  out.tabs = qa('.topbar .tabs button').map((b) => text(b));
  out.tabsOn = qa('.topbar .tabs button.on').map((b) => text(b));
  const traceTab = qa('.topbar .tabs button')[1];
  if (traceTab !== undefined) { traceTab.click(); }
  const tracePage = await waitFor(() => q('.trace-page'), 8000);
  out.traceShown = { page: tracePage !== null, chatWrap: q('.chat-wrap') !== null, composer: q('.composer-zone') !== null };

  // ── B. 时间条：宿主的重放路径用 jsonl 的 ts 差算出了工具耗时（200/400/1000ms）────
  window.__batch7Stage = 'B';
  const timeline = await waitFor(() => q('[data-trace-timeline="1"]'), 6000);
  out.timeline = {
    present: timeline !== null,
    marks: timeline === null ? null : timeline.getAttribute('data-marks'),
    ticks: qa('.ttl-tick').length,
    bars: qa('.ttl-bar').length,
    range: text(q('.ttl-range')),
    separators: qa('.ttl-sep').length,
  };

  // 先把三轮全展开，再数步骤（折叠的轮不渲染步骤行）
  const toggleAll = q('.trace-toggle-all');
  const expandAll = () => {
    if (toggleAll !== null && (toggleAll.textContent ?? '').includes('全部展开')) toggleAll.click();
  };

  // ── C. 轮次表：三轮、默认只展开最新一轮 ───────────────────────────────────
  window.__batch7Stage = 'C';
  out.rounds = qa('.trace-round').map((r) => ({
    index: r.getAttribute('data-trace-round'),
    open: r.classList.contains('open'),
    head: text(r.querySelector('.round-no')),
    meta: text(r.querySelector('.round-meta')),
  }));

  // 点第一轮的轮头 → 展开（原本只有最新一轮展开）；再点一次收起（双态）
  const head0 = q('.round-head[data-round-index="0"]');
  if (head0 !== null) { head0.click(); }
  await wait(400);
  out.round0OpenAfterClick = q('[data-trace-round="0"]')?.classList.contains('open') ?? null;
  if (head0 !== null) { head0.click(); }
  await wait(300);
  out.round0ReClosed = !(q('[data-trace-round="0"]')?.classList.contains('open') ?? false);

  // 全部展开之后数步骤（折叠的轮不渲染步骤行）
  expandAll();
  await wait(500);
  out.steps = qa('.trace-step').length;
  out.toolSteps = qa('.trace-step[data-kind="tool"]').length;
  out.thinkSteps = qa('.trace-step[data-kind="thinking"]').length;

  // ── D. 检查器：点一条工具行 → 面板出；Esc 关 ──────────────────────────────
  window.__batch7Stage = 'D';
  const step0 = q('.trace-step[data-kind="tool"]');
  if (step0 !== null) { step0.click(); }
  const inspector = await waitFor(() => q('.trace-inspector'), 4000);
  out.inspector = {
    open: inspector !== null,
    kind: inspector === null ? null : inspector.getAttribute('data-kind'),
    sections: qa('.trace-inspector .ti-label').map((e) => text(e)),
  };
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await wait(400);
  out.inspectorClosed = q('.trace-inspector') === null;

  // ── E. 搜索：grep 只命中第一轮 → 未命中的轮从表里收起来 ────────────────────
  window.__batch7Stage = 'E';
  const searchInput = q('[data-trace-search]');
  if (searchInput !== null) { setInput(searchInput, 'grep'); }
  const chip = await waitFor(() => q('[data-trace-search-count="1"]'), 4000);
  await wait(300);
  out.search = {
    chip: text(chip),
    hits: qa('.trace-step.is-search-hit').length,
    visibleRounds: qa('.trace-round').map((r) => r.getAttribute('data-trace-round')),
  };
  const clearBtn = q('[data-trace-search-clear]');
  if (clearBtn !== null) { clearBtn.click(); }
  await wait(400);
  out.searchCleared = qa('.trace-round').length;

  // ── F. 拖选聚焦：轨道上拖一段 → 出现选中区间 + 命中行 ─────────────────────
  window.__batch7Stage = 'F';
  const track = q('[data-trace-track="1"]');
  if (track !== null) {
    const rect = track.getBoundingClientRect();
    const at = (x) => ({ bubbles: true, cancelable: true, clientX: x, clientY: rect.top + rect.height / 2, button: 0, buttons: 1, pointerId: 7, pointerType: 'mouse', isPrimary: true });
    track.dispatchEvent(new PointerEvent('pointerdown', at(rect.left + rect.width * 0.15)));
    track.dispatchEvent(new PointerEvent('pointermove', at(rect.left + rect.width * 0.75)));
    track.dispatchEvent(new PointerEvent('pointerup', at(rect.left + rect.width * 0.75)));
  }
  const sel = await waitFor(() => q('[data-trace-selection="1"]'), 4000);
  await wait(500);
  out.selection = {
    sel: sel !== null,
    chip: text(q('[data-trace-selection-chip="1"]')),
    hits: qa('.trace-step.is-hit').length,
    dimmed: qa('.trace-step.is-dim').length,
  };
  // 点一下（无拖动）＝清除
  if (track !== null) {
    const rect2 = track.getBoundingClientRect();
    const at2 = { bubbles: true, cancelable: true, clientX: rect2.left + rect2.width * 0.5, clientY: rect2.top + rect2.height / 2, button: 0, buttons: 1, pointerId: 8, pointerType: 'mouse', isPrimary: true };
    track.dispatchEvent(new PointerEvent('pointerdown', at2));
    track.dispatchEvent(new PointerEvent('pointerup', { ...at2, buttons: 0 }));
  }
  await wait(500);
  out.selectionCleared = q('[data-trace-selection="1"]') === null;

  // ── G. 滚轮缩放：轨道上滚一格 → 出现「已缩放 · 全览」→ 点它复位 ───────────
  window.__batch7Stage = 'G';
  if (track !== null) {
    const rect3 = track.getBoundingClientRect();
    track.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, clientX: rect3.left + rect3.width * 0.5, clientY: rect3.top + rect3.height / 2 }));
  }
  const zoomReset = await waitFor(() => q('[data-trace-zoom-reset="1"]'), 4000);
  out.zoom = { chip: text(zoomReset), zoomed: q('[data-trace-track="1"]')?.getAttribute('data-zoomed') ?? null };
  if (zoomReset !== null) { zoomReset.click(); }
  await wait(400);
  out.zoomReset = q('[data-trace-zoom-reset="1"]') === null;

  // ── H. 会话右键菜单：「查看轨迹」在；点了仍停在轨迹页 ─────────────────────
  window.__batch7Stage = 'H';
  const sessRow = row ?? q('.sess-item');
  if (sessRow !== null && sessRow !== undefined) {
    sessRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 320 }));
  }
  const menu = await waitFor(() => q('.row-menu'), 4000);
  out.sessionMenu = menu === null ? null : qa('.row-menu .menu-item').map((i) => text(i));
  const traceItem = qa('.row-menu .menu-item').find((i) => (i.textContent ?? '').includes('查看轨迹'));
  if (traceItem !== undefined) { traceItem.click(); }
  await wait(800);
  out.traceViaMenu = q('.trace-page') !== null;

  // ── I. 刻度条（对话页的右缘）：回到对话页 → .jump-rail 在、刻度数=轮数 ─────
  window.__batch7Stage = 'I';
  const chatTab = qa('.topbar .tabs button')[0];
  if (chatTab !== undefined) { chatTab.click(); }
  await waitFor(() => q('.chat-wrap') !== null, 5000);
  await wait(800);
  out.rail = {
    present: q('.jump-rail') !== null,
    ticks: qa('.jump-tick').length,
    current: qa('.jump-tick.on').map((t) => t.getAttribute('data-turn')),
    hidden: q('.jump-rail')?.hasAttribute('hidden') ?? null,
  };

  // ── J. 工具行「在轨迹中查看」药丸：点第一个 → 轨迹页 + 聚焦闪烁 ───────────
  window.__batch7Stage = 'J';
  const pill = await waitFor(() => q('.tool-head [data-trace-jump]'), 6000);
  out.pillCount = qa('.tool-head [data-trace-jump]').length;
  // 工具卡诊断：数一数对话页到底画了几张工具卡（种子里 3 个工具），带上父级与隐藏态。
  out.toolCards = qa('.tool-card').map((c) => ({
    head: text(c.querySelector('.tool-head .preview')),
    status: (c.className.match(/status-(\w+)/) ?? [])[1] ?? null,
    round: c.closest('.turn-seat')?.getAttribute('data-round-seat') ?? null,
    hidden: c.closest('[hidden]') !== null,
    pills: c.querySelectorAll('[data-trace-jump]').length,
  }));
  const pillText = pill === null ? null : text(pill);
  if (pill !== null) { pill.click(); }
  const flash = await waitFor(() => q('.trace-step.is-flash'), 6000);
  out.jump = { pillText, flushed: q('.trace-page') !== null, flash: flash !== null };

  // ── K. 假端点实跑一轮：read 工具真跑 → 轨迹里出「有宽度的条」与「用时」 ────
  window.__batch7Stage = 'K';
  if (chatTab !== undefined) { chatTab.click(); }
  await waitFor(() => q('.composer textarea') !== null, 5000);
  const area = q('.composer textarea');
  if (area !== null) { setInput(area, '自检：读一下说明文件。'); }
  await wait(400);
  const beforeTools = qa('.tool-card').length;
  const beforeRounds = qa('.turn-seat').length;
  const sendBtn = q('.composer .send-btn:not(.stop)');
  if (sendBtn !== null) { sendBtn.click(); }
  // 完成判定：回合跑动中（.send-btn.stop 在）→ 结束（它消失）；再等新工具卡落定。
  await waitFor(() => q('.send-btn.stop') !== null, 15000);
  const finished = await waitFor(() => q('.send-btn.stop') === null, 45000);
  await wait(700);
  out.liveRun = {
    finished: finished !== null && finished !== false,
    doneTools: qa('.tool-card.status-done').length,
    newTools: qa('.tool-card').length - beforeTools,
    newRounds: qa('.turn-seat').length - beforeRounds,
    footDur: text(qa('.round-foot').at(-1)?.querySelector('.round-clock') ?? null),
  };
  // 切回轨迹页读新数据
  if (traceTab !== undefined) { traceTab.click(); }
  await waitFor(() => q('.trace-page') !== null, 6000);
  await wait(800);
  const bars = qa('.ttl-bar');
  const lastToolStep = qa('.trace-step[data-kind="tool"]').at(-1);
  out.liveTrace = {
    bars: bars.length,
    barDurations: bars.map((b) => b.getAttribute('data-duration')).slice(0, 6),
    rounds: qa('.trace-round').length,
    lastToolMeta: lastToolStep === undefined ? null : lastToolStep.querySelector('.tmeta-dur')?.textContent?.trim() ?? null,
    lastToolHead: lastToolStep === undefined ? null : text(lastToolStep.querySelector('.tool-head .preview')),
    lastRoundMeta: text(qa('.round-meta').at(-1) ?? null),
  };

  out.ms = Date.now() - startedAt;
  return out;
})().catch((error) => ({
  case: 'batch7',
  error: String(error && error.message ? error.message : error),
  stage: window.__batch7Stage ?? null,
}))
'@

# ── 起假端点（先把这一轮的「工具真跑」备好）────────────────────────────────────
$swFakeOut = Join-Path $swShots 'ui-batch7-fake.out.log'
$swFakeErr = Join-Path $swShots 'ui-batch7-fake.err.log'
Remove-Item -LiteralPath $swFakeOut, $swFakeErr -ErrorAction SilentlyContinue
$swFakeProc = Start-Process -FilePath 'node' -ArgumentList $swFake, "$swPort" -PassThru -RedirectStandardOutput $swFakeOut -RedirectStandardError $swFakeErr
# 等端点真的在听：没起来时这一轮请求会挂到超时，自检会以「实跑没结束」的假象收场。
$swFakeReady = $false
$swFakeWait = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $swFakeWait) {
  if ((Test-Path -LiteralPath $swFakeOut) -and (Select-String -LiteralPath $swFakeOut -Pattern '监听' -Quiet -ErrorAction SilentlyContinue)) { $swFakeReady = $true; break }
  if ($swFakeProc.HasExited) { break }
  Start-Sleep -Milliseconds 200
}
if (-not $swFakeReady) { Write-Output '  WARN  假端点没在 10 秒内就绪（实跑段会失败）' }

$env:USERPROFILE = $swHome
$env:HOME = $swHome
$env:DSC_DESKTOP_USER_DATA = Join-Path $swHome 'electron-userdata'
# 桌面主进程的记忆文件也钉进隔离目录：漏了这一项时 lastCwd 会读成真实的那份，
# 宿主就以 D:\dsc 起、侧栏列出真实工作区（第一版自检这么翻车过一次）。
$env:DSC_DESKTOP_STATE = Join-Path $swDsc 'desktop.json'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SHOT = Join-Path $swShots 'ui-batch7.png'
$env:DSC_DESKTOP_SHOT_DELAY = '420000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '400000'
$env:DSC_DESKTOP_SHOT_EVAL = $swEval
Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue
Remove-Item Env:DSC_UI_QUERY -ErrorAction SilentlyContinue

$outLog = Join-Path $swShots 'ui-batch7.out.log'
$errLog = Join-Path $swShots 'ui-batch7.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue

try {
  $swProc = Start-Process -FilePath $swElectron -ArgumentList $swEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $swDeadline = (Get-Date).AddSeconds(500)
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
  if ($null -ne $swFakeProc -and -not $swFakeProc.HasExited) {
    & taskkill /PID $swFakeProc.Id /T /F 2>&1 | Out-Null
  }
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
  # A 页签与轨迹页
  Check '顶栏两个页签（对话 / 轨迹）' (($swJson.tabs -join ',') -eq '对话,轨迹') ($swJson.tabs -join ',')
  Check '切到轨迹页：.trace-page 在、.chat-wrap 收走、输入区仍在' ($swJson.traceShown.page -eq $true -and $swJson.traceShown.chatWrap -eq $false -and $swJson.traceShown.composer -eq $true) ($swJson.traceShown | ConvertTo-Json -Compress)

  # B 时间条：宿主重放路径用 jsonl 的 ts 差算出了工具耗时（200/400/1000ms）→ 3 条有宽度的工具条
  Check '时间条在，标记数 = 6（3 工具 + 2 思考 + 1 恢复提示）' ($swJson.timeline.present -eq $true -and $swJson.timeline.marks -eq '6') ("$($swJson.timeline.marks)")
  Check '重放算出的耗时画出 3 条宽度条、其余 3 个只画起点刻度' ($swJson.timeline.bars -eq 3 -and $swJson.timeline.ticks -eq 3) ("bars=$($swJson.timeline.bars) ticks=$($swJson.timeline.ticks)")
  Check '轮次分隔刻度 = 3 条' ($swJson.timeline.separators -eq 3) ("$($swJson.timeline.separators)")
  Check '时间范围行有「→」（跨时段）' ($null -ne $swJson.timeline.range -and $swJson.timeline.range -like '*→*') $swJson.timeline.range

  # C 轮次表
  Check '三轮都在表里（第 1/2/3 轮）' ($swJson.rounds.Count -eq 3 -and $swJson.rounds[0].head -eq '第 1 轮' -and $swJson.rounds[2].head -eq '第 3 轮') (($swJson.rounds | ForEach-Object { $_.head }) -join ',')
  Check '默认只展开最新一轮' ($swJson.rounds[0].open -eq $false -and $swJson.rounds[2].open -eq $true) (($swJson.rounds | ForEach-Object { $_.open }) -join ',')
  Check '轮头统计对（第 1 轮 2 次工具 / 第 2 轮 1 次）' ($swJson.rounds[0].meta -like '*2 次工具*' -and $swJson.rounds[1].meta -like '*1 次工具*') (($swJson.rounds | ForEach-Object { $_.meta }) -join ' | ')
  Check '全部展开后步骤数 = 6（3 工具 + 2 思考 + 1 恢复提示）' ($swJson.steps -eq 6 -and $swJson.toolSteps -eq 3 -and $swJson.thinkSteps -eq 2) ("steps=$($swJson.steps) tools=$($swJson.toolSteps) think=$($swJson.thinkSteps)")
  Check '点轮头展开第一轮' ($swJson.round0OpenAfterClick -eq $true)
  Check '再点一次收起（双态）' ($swJson.round0ReClosed -eq $true)

  # D 检查器
  Check '点工具行开检查器（kind=tool）' ($swJson.inspector.open -eq $true -and $swJson.inspector.kind -eq 'tool') ($swJson.inspector.kind)
  Check '检查器分区齐（输入 / 输出 / 计时 / 用量）' ((($swJson.inspector.sections -join ',') -like '*输入*输出*计时*用量*')) ($swJson.inspector.sections -join ',')
  Check 'Esc 关掉检查器' ($swJson.inspectorClosed -eq $true)

  # E 搜索
  Check '搜索 grep 命中计数 chip 在' ($null -ne $swJson.search.chip -and $swJson.search.chip -like '*命中 1 步*') $swJson.search.chip
  Check '命中行带 is-search-hit' ($swJson.search.hits -ge 1) ("$($swJson.search.hits)")
  Check '未命中的轮从表里收起来（只剩第 1 轮）' (($swJson.search.visibleRounds -join ',') -eq '0') ($swJson.search.visibleRounds -join ',')
  Check '清除搜索后三轮回来' ($swJson.searchCleared -eq 3) ("$($swJson.searchCleared)")

  # F 拖选
  Check '拖选出现选中区间与清除 chip' ($swJson.selection.sel -eq $true -and $null -ne $swJson.selection.chip) $swJson.selection.chip
  Check '命中行有 is-hit、未命中压暗' ($swJson.selection.hits -ge 1 -and $swJson.selection.dimmed -ge 0) ("hit=$($swJson.selection.hits) dim=$($swJson.selection.dimmed)")
  Check '点一下清除选区' ($swJson.selectionCleared -eq $true)

  # G 缩放
  Check '滚轮缩放出「已缩放 · 全览」chip' ($null -ne $swJson.zoom.chip -and $swJson.zoom.chip -like '*全览*') $swJson.zoom.chip
  Check '轨道带 data-zoomed' ($swJson.zoom.zoomed -eq '1') ($swJson.zoom.zoomed)
  Check '点全览复位' ($swJson.zoomReset -eq $true)

  # H 右键入口
  Check '会话右键菜单有「查看轨迹」' ($null -ne $swJson.sessionMenu -and ($swJson.sessionMenu -join ',') -like '*查看轨迹*') (($swJson.sessionMenu) -join ',')
  Check '点「查看轨迹」后停在轨迹页' ($swJson.traceViaMenu -eq $true)

  # I 刻度条
  Check '对话页右缘刻度条在（.jump-rail）' ($swJson.rail.present -eq $true)
  Check '刻度条刻度数 = 轮数（3）' ($swJson.rail.ticks -eq 3) ("$($swJson.rail.ticks)")
  Check '刻度条不是隐藏态（宽屏）' ($swJson.rail.hidden -eq $false) ("$($swJson.rail.hidden)")

  # J 药丸跳转（对话页工具卡逐张带一颗药丸；张数与药丸数一致）
  Check '工具卡数与药丸数一致（每张卡一颗）' ($swJson.toolCards.Count -ge 3 -and $swJson.pillCount -eq $swJson.toolCards.Count) ("cards=$($swJson.toolCards.Count) pills=$($swJson.pillCount)")
  Check '点药丸切到轨迹页并闪烁聚焦' ($swJson.jump.flushed -eq $true -and $swJson.jump.flash -eq $true) ($swJson.jump | ConvertTo-Json -Compress)

  # K 实跑
  Check '实跑回合结束（.send-btn.stop 收起）' ($swJson.liveRun.finished -eq $true) ("doneTools=$($swJson.liveRun.doneTools)")
  Check '实跑新增一张工具卡与一轮' ($swJson.liveRun.newTools -ge 1 -and $swJson.liveRun.newRounds -ge 1) ("newTools=$($swJson.liveRun.newTools) newRounds=$($swJson.liveRun.newRounds)")
  Check '实跑后轨迹条数增加（≥4）' ($swJson.liveTrace.bars -ge 4) ("bars=$($swJson.liveTrace.bars) durations=$($swJson.liveTrace.barDurations -join ',')")
  Check '耗时条带 data-duration（真值非空）' ((($swJson.liveTrace.barDurations | Where-Object { $_ -ne '' -and $null -ne $_ }).Count) -ge 1) ($swJson.liveTrace.barDurations -join ',')
  Check '实跑的工具行有行内「用时」读数' ($null -ne $swJson.liveTrace.lastToolMeta -and $swJson.liveTrace.lastToolMeta -like '*s') ("$($swJson.liveTrace.lastToolMeta) / $($swJson.liveTrace.lastToolHead)")
  Check '实跑后轮数 = 4（新开一轮）' ($swJson.liveTrace.rounds -eq 4) ("$($swJson.liveTrace.rounds)")
}

# ── 真实 ~/.dsc 未被污染 ───────────────────────────────────────────────────────
if ($null -ne $swRealBefore) {
  $swRealAfter = Get-DirFingerprint $swRealDsc
  Check '真实 ~/.dsc 文件数与内容指纹不变' ($swRealAfter.Count -eq $swRealBefore.Count -and $swRealAfter.ContentDigest -eq $swRealBefore.ContentDigest) ("$($swRealBefore.Count)/$($swRealAfter.Count)")
}

Check '截图落盘（ui-batch7.png）' (Test-Path -LiteralPath (Join-Path $swShots 'ui-batch7.png'))

Write-Output ""
Write-Output "第七批自检：$($swTotal - $swFail)/$swTotal 通过"
if ($swFail -gt 0) { exit 1 }
