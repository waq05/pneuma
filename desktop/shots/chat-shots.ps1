# 对话区三件事的自检截图（进行中状态行 / 每轮时间与用时 / 右缘刻度条判定与轨道）。
#
# 隔离怎么做：DSC_DESKTOP_USER_DATA 换掉 Electron 自己的 userData，
# USERPROFILE 换掉宿主进程的 ~/.dsc（宿主读 homedir()，libuv 在 Windows 上先认
# USERPROFILE）——会话、配置、用量日志全落在 desktop/shots/chat-home 下，
# 用户真实的 ~/.dsc 一个字节都不写（electron 主进程读真实 profile 的
# desktop.json 拿工作目录，但自检走 app.exit，不触发落盘的 close 分支）。
#
# 用法：
#   pwsh -NoProfile -File chat-shots.ps1                 # 全部用例
#   pwsh -NoProfile -File chat-shots.ps1 -Only thinking   # 只跑一个

param([string]$Only = 'all')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$iso = Join-Path $shots 'chat-home'
$dsc = Join-Path $iso '.dsc'
$sessions = Join-Path $dsc 'sessions\C-Windows-System32'
$seedId = '7f3a1c22-9d1b-4a55-9c31-2b7e5d0a4411'
$seed = Join-Path $sessions "$seedId.jsonl"
$port = 18924
$fake = Join-Path $shots 'chat-fake-llm.mjs'

# ── 隔离环境 ─────────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $sessions, (Join-Path $dsc 'usage') | Out-Null
@"
# 自检专用配置：一个指向本机假端点的 provider（不联网、不花钱）
default:
  provider: fake
  model: fake-chat
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:$port/v1
    apiKeyEnv: DSC_FAKE_KEY
    models:
      - id: fake-chat
        name: Fake Chat
        contextWindow: 128000
        maxTokens: 4096
"@ | Set-Content -Path (Join-Path $dsc 'config.yaml') -Encoding utf8NoBOM
$env:DSC_FAKE_KEY = 'sk-selfcheck-fake'
$env:USERPROFILE = $iso
$env:HOME = $iso
$env:DSC_DESKTOP_USER_DATA = Join-Path $iso 'electron-userdata'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'

# ── 种子会话：四轮对话，覆盖「有 ts / 缺 ts」的三种组合 ──────────────────────
# 第 1 轮：完整（user 14:02:11 → assistant 14:04:52，用时 2分41秒）
# 第 2 轮：中间的工具记录缺 ts（user 14:10:00 → tool 无 ts → assistant 14:12:41，仍算 2分41秒）
# 第 3 轮：整轮都没有 ts（2026-09 之前的老日志格式）→ 那一行时间与用时都不显示
# 第 4 轮：只有用户消息有 ts → 只显示 14:30，不显示用时
function Get-Ms([string]$local) {
  [DateTimeOffset]::new([datetime]$local).ToUnixTimeMilliseconds()
}
$para = (1..9 | ForEach-Object { "第 $_ 段：对话区右缘现在有三条轨道——正文、刻度条、滚动条，互不重叠。" }) -join "`n`n"
$lines = @()
$lines += (@{ type = 'meta'; id = $seedId; cwd = 'C:\Windows\System32'; createdAt = (Get-Ms '2026-09-30T14:02:00') } | ConvertTo-Json -Compress)
$lines += (@{ type = 'user'; text = '第一轮：帮我看一下对话区右缘的刻度条判定准不准。'; ts = (Get-Ms '2026-09-30T14:02:11') } | ConvertTo-Json -Compress)
$lines += (@{ type = 'assistant'; text = "第一轮的回复。`n`n$para"; reasoning = ''; ts = (Get-Ms '2026-09-30T14:04:52') } | ConvertTo-Json -Compress)
$lines += (@{ type = 'user'; text = '第二轮：这一轮中间有一次工具调用，也算进用时里吗？'; ts = (Get-Ms '2026-09-30T14:10:00') } | ConvertTo-Json -Compress)
$lines += (@{ type = 'assistant'; text = '这一轮先读文件再回答，中间那条工具记录故意不写 ts。'; reasoning = ''; toolCalls = @(@{ id = 'call_seed_1'; name = 'read'; arguments = '{"path":"README.md"}' }); ts = (Get-Ms '2026-09-30T14:10:20') } | ConvertTo-Json -Compress -Depth 8)
$lines += (@{ type = 'tool'; callId = 'call_seed_1'; name = 'read'; text = '（这条老格式的工具记录没有 ts，中间的缺口要跳过）' } | ConvertTo-Json -Compress)
$lines += (@{ type = 'assistant'; text = "第二轮的收尾回复。`n`n$para"; reasoning = ''; ts = (Get-Ms '2026-09-30T14:12:41') } | ConvertTo-Json -Compress)
$lines += (@{ type = 'user'; text = '第三轮：这一轮是 2026-09 之前的老日志格式，一条时间都没有。' } | ConvertTo-Json -Compress)
$lines += (@{ type = 'assistant'; text = "第三轮的回复：这条会话日志里没有任何 ts，界面应当连时间那一行都不画。`n`n$para" } | ConvertTo-Json -Compress)
$lines += (@{ type = 'user'; text = '第四轮：只有我这条消息有时间，回复那条没有。'; ts = (Get-Ms '2026-09-30T14:30:00') } | ConvertTo-Json -Compress)
$lines += (@{ type = 'assistant'; text = "第四轮的回复：没有 ts 就只显示开始的时刻，不显示用时。`n`n$para" } | ConvertTo-Json -Compress)
Set-Content -Path $seed -Value ($lines -join "`n") -Encoding utf8NoBOM

# ── 假端点进程 ───────────────────────────────────────────────────────────────
$script:server = $null
function Start-Fake([string]$mode) {
  if ($script:server -ne $null) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300 }
  $script:server = Start-Process -FilePath 'node' -ArgumentList $fake, $mode, $port -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 700
}

# ── 用例 ─────────────────────────────────────────────────────────────────────
$head = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => document.querySelector(s);
const all = (s) => Array.from(document.querySelectorAll(s));
const submit = (text) => window.dsc.invoke('submit', [text, undefined]);
'@

# 1) 回合进行中 · 思考阶段
$thinkingEval = ($head + @'

(async () => {
  await wait(600);
  await submit('请检查一下对话区右缘的刻度条：现在的高亮判定准不准？');
  await wait(11000);
  const st = q('.turn-status');
  const seg = q('.segment.seg-turn');
  return {
    case: 'thinking',
    turnState: q('.composer .stop') ? 'working' : 'unknown',
    // 2026-10-30：状态行只剩一行（文本 + 三点动画），用时在底部状态栏
    text: st ? st.querySelector('.turn-status-stage').textContent : null,
    rows: st ? st.children.length : 0,
    hasSecondLine: !!(st && st.querySelector('.turn-status-activity')),
    dots: st ? st.querySelectorAll('.turn-status-dots i').length : 0,
    statusbarText: seg ? seg.textContent : null,
    liveThinking: !!q('.thinking.live'),
  };
})()
'@)

# 2) 回合进行中 · 工具阶段（假端点发起 ask_user 后停住等回答，无副作用）
$toolEval = ($head + @'

(async () => {
  await wait(600);
  await submit('这个需求的范围我拿不准，你先问我。');
  await wait(9000);
  const st = q('.turn-status');
  const groupHead = q('.step-fold-label');
  return {
    case: 'tool',
    // 有过程组头时状态行不画（同一件事只说一遍）；组头自己说「正在运行命令 · xxx」
    statusText: st ? st.querySelector('.turn-status-stage').textContent : null,
    groupLabel: groupHead ? groupHead.textContent : null,
    hasSecondLine: !!(st && st.querySelector('.turn-status-activity')),
    runningToolCards: all('.tool-card .tool-name, .tool-card .tool-title').map((n) => n.textContent),
    askCard: !!q('.ask-card'),
  };
})()
'@)

# 3) 回合结束 · 每轮底部的时间与用时（真跑一轮，走完整落盘链路）
#    先等状态行「出现」（回合真起来了），再等它「消失」（回合结束），然后量页脚。
$roundEval = ($head + @'

(async () => {
  await wait(600);
  await submit('用一句话说明刻度条现在有几条轨道。');
  let started = false;
  for (let i = 0; i < 20 && !started; i += 1) { await wait(250); started = q('.turn-status') !== null; }
  const seenActivity = q('.turn-status-stage') ? q('.turn-status-stage').textContent : null;
  let ended = false;
  for (let i = 0; i < 60 && !ended; i += 1) { await wait(250); ended = q('.turn-status') === null; }
  await wait(500);
  return {
    case: 'round-foot',
    started,
    ended,
    seenActivity,
    statusGone: q('.turn-status') === null,
    foots: all('.round-foot').map((n) => n.textContent),
    rounds: all('[data-round]').length,
    liveLeft: all('.entry-text.live').length,
  };
})()
'@)

# 4) 刻度条：滚动到多个位置，逐个核对高亮 + 量三条轨道的几何关系
#    顺带把「改动前」的旧规则注入量一遍（before）再撤掉，用同一份数据说明重叠这件事。
$jumpEval = ($head + @'

(async () => {
  await wait(700);
  await window.dsc.invoke('openSession', [__SEED__]);
  await wait(2200);

  const chat = q('.chat');
  const strip = q('.jump-rail');
  const measure = () => {
    const cs = getComputedStyle(chat);
    const chatRect = chat.getBoundingClientRect();
    const scrollbarW = chat.offsetWidth - chat.clientWidth;
    const tick = q('.jump-tick');
    const tickRect = tick ? tick.getBoundingClientRect() : null;
    const stripRect = strip ? strip.getBoundingClientRect() : null;
    const inner = q('.chat-inner');
    const para = q('.entry-text .markdown p');
    return {
      scrollbarW,
      scrollbarLeft: Math.round(chatRect.right - scrollbarW),
      contentRight: Math.round(chatRect.right - scrollbarW - parseFloat(cs.paddingRight)),
      innerRight: inner ? Math.round(inner.getBoundingClientRect().right) : null,
      textRight: para ? Math.round(para.getBoundingClientRect().right) : null,
      stripRight: stripRect ? Math.round(stripRect.right) : null,
      tickLeft: tickRect ? Math.round(tickRect.left) : null,
      tickRight: tickRect ? Math.round(tickRect.right) : null,
    };
  };
  const after = measure();

  // 改动前的旧规则（只 CSS，不改逻辑）：没有预留轨道、刻度条 right:16px
  const old = document.createElement('style');
  old.textContent = '.chat-wrap > .chat{padding-right:0;scrollbar-gutter:auto}.chat-wrap > .jump-rail{right:16px}';
  document.head.append(old);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const before = measure();
  old.remove();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // 滚动条画宽了会怎样（主题/缩放出岔子时不是没可能）：旧规则把刻度条写死在
  // right:16px，与滚动条宽度无关，16px 宽时两条正好贴死；新规则跟着令牌让位。
  const wide = document.createElement('style');
  wide.textContent = '::-webkit-scrollbar{width:16px}';
  const wideOld = document.createElement('style');
  wideOld.textContent = '.chat-wrap > .chat{padding-right:0;scrollbar-gutter:auto}.chat-wrap > .jump-rail{right:16px}';
  document.head.append(wide, wideOld);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wideBefore = measure();
  wideOld.remove();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wideAfter = measure();
  wide.remove();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const checks = [];
  for (const ratio of [0, 0.18, 0.42, 0.66, 0.88, 1]) {
    chat.scrollTop = Math.round((chat.scrollHeight - chat.clientHeight) * ratio);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
    const ticks = all('.jump-tick');
    const on = ticks.findIndex((b) => b.classList.contains('on'));
    const anchors = all('.entry-user');
    const box = chat.getBoundingClientRect();
    const line = box.top + 8;
    const onTop = anchors[on] ? Math.round(anchors[on].getBoundingClientRect().top) : null;
    const nextTop = anchors[on + 1] ? Math.round(anchors[on + 1].getBoundingClientRect().top) : null;
    const hit = document.elementFromPoint(Math.round(box.left + chat.clientWidth / 2), Math.round(line));
    const row = hit && hit.closest ? hit.closest('[data-round]') : null;
    checks.push({
      ratio,
      on,
      lineY: Math.round(line),
      onTop,
      nextTop,
      atBottom: chat.scrollHeight - chat.clientHeight - chat.scrollTop <= 32,
      startAbove: onTop === null ? null : onTop <= Math.round(line) + 1,
      nextBelow: nextTop === null ? true : nextTop > Math.round(line),
      hitRound: row === null ? null : Number(row.getAttribute('data-round')),
    });
  }

  // 截图留在最后一个位置；这一屏正好是第 3、4 轮（缺 ts 的降级样张）
  chat.scrollTop = chat.scrollHeight;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // 命中测试这条路径要真跑到：把探针线压进每条正文里，看 elementFromPoint 认出的回合
  // 与刻度高亮是不是同一条（这是「以命中测试为准」那一半的直接证据）。
  const hits = [];
  for (const row of all('.entry-row[data-round]')) {
    const node = row.querySelector('.entry-text');
    if (node === null) continue;
    const absTop = node.getBoundingClientRect().top - chat.getBoundingClientRect().top + chat.scrollTop;
    chat.scrollTop = Math.round(absTop + 40 - 8);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
    const box = chat.getBoundingClientRect();
    const line = box.top + 8;
    const hit = document.elementFromPoint(Math.round(box.left + chat.clientWidth / 2), Math.round(line));
    const row2 = hit && hit.closest ? hit.closest('[data-round]') : null;
    const on = all('.jump-tick').findIndex((b) => b.classList.contains('on'));
    hits.push({
      want: Number(row.getAttribute('data-round')),
      hit: row2 === null ? null : Number(row2.getAttribute('data-round')),
      on,
      at: hit ? hit.tagName : null,
    });
  }
  chat.scrollTop = chat.scrollHeight;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  return {
    case: 'jump',
    ticks: all('.jump-tick').length,
    rows: all('[data-round]').length,
    foots: all('.round-foot').map((n) => n.textContent),
    after,
    before,
    wideBefore,
    wideAfter,
    checks,
    hits,
  };
})()
'@) -replace '__SEED__', ($seed | ConvertTo-Json -Compress)

# 5) 同一个种子会话、同一个滚动位置，只把旧规则注入回去 —— 给「改动前」留一张对照图
$jumpBeforeEval = ($head + @'

(async () => {
  const old = document.createElement('style');
  old.textContent = '.chat-wrap > .chat{padding-right:0;scrollbar-gutter:auto}.chat-wrap > .jump-rail{right:16px}';
  document.head.append(old);
  await wait(700);
  await window.dsc.invoke('openSession', [__SEED__]);
  await wait(2200);
  const chat = q('.chat');
  chat.scrollTop = chat.scrollHeight;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { case: 'jump-before', stripRight: Math.round(q('.jump-rail').getBoundingClientRect().right) };
})()
'@) -replace '__SEED__', ($seed | ConvertTo-Json -Compress)

# 6) 滚动到顶部：第 1、2 轮（完整时间与用时）+ 高亮第一枚刻度
$jumpTopEval = ($head + @'

(async () => {
  await wait(700);
  await window.dsc.invoke('openSession', [__SEED__]);
  await wait(2200);
  const chat = q('.chat');
  chat.scrollTop = 0;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
  return {
    case: 'jump-top',
    on: all('.jump-tick').findIndex((b) => b.classList.contains('on')),
    foots: all('.round-foot').map((n) => n.textContent),
  };
})()
'@) -replace '__SEED__', ($seed | ConvertTo-Json -Compress)

$cases = [ordered]@{
  'chat-working-thinking' = @{ mode = 'slow'; delay = 18000; lead = 13000; eval = $thinkingEval }
  'chat-working-tool'     = @{ mode = 'asktool'; delay = 16000; lead = 11000; eval = $toolEval }
  'chat-round-foot'       = @{ mode = 'fast'; delay = 13000; lead = 8000; eval = $roundEval }
  'chat-jump'             = @{ mode = 'fast'; delay = 12000; lead = 6000; eval = $jumpEval }
  'chat-jump-before'      = @{ mode = 'fast'; delay = 12000; lead = 6000; eval = $jumpBeforeEval }
  'chat-jump-top'         = @{ mode = 'fast'; delay = 12000; lead = 6000; eval = $jumpTopEval }
}

foreach ($name in $cases.Keys) {
  if ($Only -ne 'all' -and $Only -ne $name) { continue }
  $spec = $cases[$name]
  Start-Fake $spec.mode
  $png = Join-Path $shots "$name.png"
  $log = Join-Path $shots "$name.log"
  $env:DSC_DESKTOP_SHOT = $png
  $env:DSC_DESKTOP_SHOT_DELAY = [string]$spec.delay
  $env:DSC_DESKTOP_SHOT_EVAL_LEAD = [string]$spec.lead
  $env:DSC_DESKTOP_SHOT_EVAL = $spec.eval
  Write-Output "=== $name ==="
  & $electron 'out\main\index.js' *>&1 | Out-File -FilePath $log -Encoding utf8
  Select-String -Path $log -Pattern '预跑脚本完成|已写出|截图失败|页面加载失败' |
    ForEach-Object { '  ' + $_.Line } | Select-Object -First 6
}

if ($script:server -ne $null) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue }
Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD, Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST -ErrorAction SilentlyContinue
Write-Output '全部完成'


