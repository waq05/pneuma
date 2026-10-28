# 工具卡折叠（紧凑行 + 展开区吸附快捷栏）的自检截图。
#
# 隔离怎么做：DSC_DESKTOP_USER_DATA 换掉 Electron 的 userData，USERPROFILE/HOME 换掉
# 宿主的 ~/.dsc——会话、配置、settings 全落在 desktop/shots/tc-home 下，用户真实的
# ~/.dsc 一个字节都不写。种子数据见 shots/tc-seed.mjs，假端点见 shots/tc-fake-llm.mjs。
#
# 用法（先 `pnpm run build`，否则拍的是旧包）：
#   pwsh -NoProfile -File tc-shots.ps1                # 全部用例
#   pwsh -NoProfile -File tc-shots.ps1 -Only tc-expand-long-dark

param([string]$Only = 'all')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$entry = Join-Path $shots '..\out\main\index.js'
$home2 = Join-Path $shots 'tc-home'
$port = 18931

# ── 预跑脚本里反复用到的探针（量几何、读规则、展开卡片）───────────────────────────
$head = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cards = () => Array.from(document.querySelectorAll('.tool-card'));
const head = (c) => c.querySelector('.tool-head');
const nameOf = (c) => c.querySelector('.tool-head .name').textContent;
const statusOf = (c) => c.querySelector('.tool-head .status').textContent;
const ready = async () => {
  for (let i = 0; i < 80; i += 1) { if (cards().length > 0) { await wait(900); return true; } await wait(250); }
  return false;
};
const rules = () => {
  const out = [];
  const walk = (list) => {
    for (const r of list) {
      if (r.selectorText === undefined && r.cssRules) walk(Array.from(r.cssRules));
      else out.push(r);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) { try { walk(Array.from(sheet.cssRules)); } catch (e) { void e; } }
  return out;
};
const expand = async (card) => {
  head(card).click();
  for (let i = 0; i < 60; i += 1) { if (card.querySelector('.tool-body') !== null) return; await wait(120); }
};
const waitBar = async (card) => {
  for (let i = 0; i < 40; i += 1) { const bar = card.querySelector('.tc-bar'); if (bar !== null) return bar; await wait(120); }
  return null;
};
const contentHeight = (card) => {
  const body = card.querySelector('.tool-body');
  if (body === null) return null;
  return Array.from(body.children).filter((c) => c.dataset.tcChrome === undefined)
    .reduce((sum, c) => sum + Math.max(c.scrollHeight, c.offsetHeight), 0);
};
const barInfo = (card) => {
  const bar = card.querySelector('.tc-bar');
  if (bar === null) return { hasBar: false, contentH: contentHeight(card) };
  const chat = document.querySelector('.chat');
  const cs = getComputedStyle(bar);
  const barRect = bar.getBoundingClientRect();
  const chatRect = chat.getBoundingClientRect();
  const btn = bar.querySelector('.tc-collapse');
  return {
    hasBar: true,
    text: bar.textContent.trim(),
    position: cs.position,
    cssTop: cs.top,
    z: cs.zIndex,
    bg: cs.backgroundColor,
    borderBottom: cs.borderBottomColor,
    painted: cs.backgroundColor !== 'rgba(0, 0, 0, 0)',
    chatTop: Math.round(chatRect.top),
    barTop: Math.round(barRect.top),
    stuckOffset: Math.round(barRect.top - chatRect.top),
    contentH: contentHeight(card),
    collapseBtn: btn !== null,
    collapseLabel: btn === null ? null : btn.textContent.trim(),
  };
};
// 把某张卡的顶端对到相对滚动容器顶端 offset 像素处（负数 = 卡片顶滚到容器上方），
// 闭环修正：读一次实际位置、补差值，最多三次。为什么不用「绝对偏移 + 一次赋值」：
// 展开一张卡会改变内容高度，浏览器自己的滚动锚定会在这中间微调 scrollTop，
// 一次算出来的目标值会差上几十像素。
const scrollToCard = async (card, offset) => {
  const chat = document.querySelector('.chat');
  for (let pass = 0; pass < 4; pass += 1) {
    const delta = card.getBoundingClientRect().top - chat.getBoundingClientRect().top - offset;
    if (Math.abs(delta) < 2) break;
    allowScroll();
    chat.scrollTop = Math.round(chat.scrollTop + delta);
    await wait(280);
  }
  holdScroll();
  await wait(400);
};
// 冻结滚动位置：ChatView 只要看到 entries 变了就会 scrollTop = scrollHeight（自动贴底），
// 那会把自检摆好的视角冲掉——拦住它，拍照那几秒画面才是我要取证的那一屏。
// 只挡「设定 scrollTop」这一个写入口，组件逻辑一个字没改，读数照旧是真的。
const allowScroll = () => { window.__tcAllowScroll = true; };
const holdScroll = () => { window.__tcAllowScroll = false; };
const freezeScroll = () => {
  const chat = document.querySelector('.chat');
  if (chat === null) return false;
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (desc === undefined || desc.get === undefined || desc.set === undefined) return false;
  const box = { value: desc.get.call(chat) };
  holdScroll();
  Object.defineProperty(chat, 'scrollTop', {
    configurable: true,
    get: () => box.value,
    set: (value) => { if (window.__tcAllowScroll === true) { box.value = value; desc.set.call(chat, value); } },
  });
  return true;
};
// 吸附探针：快捷栏相对滚动容器顶端的偏移 + 卡片顶端的位置。
// 往下滚一次，卡片上移而偏移不变，才说明栏真的吸住了（不是恰好停在原位）。
const barProbe = () => {
  const bar = document.querySelector('.tc-bar');
  if (bar === null) return null;
  const chat = document.querySelector('.chat');
  const card = bar.closest('.tool-card');
  return {
    offset: Math.round(bar.getBoundingClientRect().top - chat.getBoundingClientRect().top),
    cardTop: card === null ? null : Math.round(card.getBoundingClientRect().top),
    scrollTop: Math.round(chat.scrollTop),
  };
};
'@

# 1) 默认折叠：五行紧凑行 + 静态规则取证（hover 底色、展开态放开 overflow）
$collapsedEval = ($head + @'

(async () => {
  await ready();
  freezeScroll();
  const list = cards();
  const row = head(list[0]);
  const cs = getComputedStyle(row);
  const flat = rules();
  const hover = flat.find((r) => r.selectorText !== undefined && r.selectorText.indexOf('.tool-head:hover') >= 0);
  const openRule = flat.find((r) => r.selectorText !== undefined && r.selectorText.indexOf('.tool-card.open') >= 0);
  const chat = document.querySelector('.chat');
  // 把卡片群滚到视口顶部：紧凑行的价值就是「一屏能扫过多少条」，得让它们同框。
  await scrollToCard(list[0], 8);
  return {
    case: 'collapsed',
    theme: document.documentElement.dataset.theme,
    density: document.documentElement.dataset.density,
    rows: list.map((c) => ({
      name: nameOf(c),
      status: statusOf(c),
      open: c.classList.contains('open'),
      h: +head(c).getBoundingClientRect().height.toFixed(1),
      summary: c.querySelector('.preview').textContent,
    })),
    rowH: +row.getBoundingClientRect().height.toFixed(1),
    rowTransition: cs.transition,
    rowCursor: cs.cursor,
    rowRadius: cs.borderRadius,
    hoverRule: hover ? hover.style.background : '(没找到)',
    openRule: openRule ? openRule.style.overflow : '(没找到)',
    barsInDom: document.querySelectorAll('.tc-bar').length,
    chevrons: document.querySelectorAll('.tc-chevron').length,
    rowsPerViewport: +(chat.clientHeight / row.getBoundingClientRect().height).toFixed(1),
  };
})()
'@)

# 2) 展开长卡：吸附快捷栏贴在滚动容器顶端（卡片头部已经滚出视口，栏还在）
$longEval = ($head + @'

(async () => {
  await ready();
  freezeScroll();
  const card = cards().filter((c) => nameOf(c) === 'browser' && statusOf(c).indexOf('进行中') < 0)[0];
  await expand(card);
  const bar = await waitBar(card);
  await wait(400);
  const args = card.querySelector('.args');
  const result = card.querySelector('.result');
  await scrollToCard(card, -170);
  const probeA = barProbe();
  const chat = document.querySelector('.chat');
  allowScroll();
  chat.scrollTop = chat.scrollTop + 140;
  await wait(700);
  holdScroll();
  const probeB = barProbe();
  return {
    case: 'expand-long',
    cardTop: Math.round(card.getBoundingClientRect().top),
    chatTop: Math.round(chat.getBoundingClientRect().top),
    headScrolledOut: card.getBoundingClientRect().top < chat.getBoundingClientRect().top,
    probeA: probeA,
    probeB: probeB,
    scroll: { scrollHeight: chat.scrollHeight, clientHeight: chat.clientHeight, maxScroll: chat.scrollHeight - chat.clientHeight, cardOffset: Math.round(probeA.cardTop - chat.getBoundingClientRect().top + probeA.scrollTop) },
    postambleLines: document.querySelectorAll('.entry-text').length,
    stuck: probeA !== null && probeB !== null && probeA.offset === probeB.offset && probeB.cardTop < probeA.cardTop,
    argsH: args === null ? null : +args.getBoundingClientRect().height.toFixed(1),
    argsContentH: args === null ? null : args.scrollHeight,
    resultH: result === null ? null : +result.getBoundingClientRect().height.toFixed(1),
    resultContentH: result === null ? null : result.scrollHeight,
    barFound: bar !== null,
    bar: barInfo(card),
  };
})()
'@)

# 3) 展开短卡：内容不到 400px，卡片里不该出现快捷栏
$shortEval = ($head + @'

(async () => {
  await ready();
  freezeScroll();
  const card = cards().filter((c) => nameOf(c) === 'web_search')[0];
  await expand(card);
  await wait(600);
  await scrollToCard(card, -30);
  return {
    case: 'expand-short',
    bodyH: +card.querySelector('.tool-body').getBoundingClientRect().height.toFixed(1),
    barsInDom: document.querySelectorAll('.tc-bar').length,
    bar: barInfo(card),
    openCards: cards().filter((c) => c.classList.contains('open')).length,
  };
})()
'@)

# 4) 进行中：紧凑行有 spinner，展开长参数后快捷栏给进行中文案且不给「收起」
$runningEval = ($head + @'

(async () => {
  await ready();
  freezeScroll();
  const card = cards().filter((c) => statusOf(c).indexOf('进行中') >= 0)[0];
  const spin = card.querySelector('.tc-spin');
  const spinCs = spin === null ? null : getComputedStyle(spin);
  await expand(card);
  const bar = await waitBar(card);
  await wait(400);
  await scrollToCard(card, -150);
  return {
    case: 'running',
    rowStatus: statusOf(card),
    spinnerCount: card.querySelectorAll('.tc-spin').length,
    spinnerAnimation: spinCs === null ? null : spinCs.animationName + ' / ' + spinCs.animationDuration,
    barFound: bar !== null,
    bar: barInfo(card),
  };
})()
'@)

# 5) 实时一轮 · 进行中：真工具在跑（ask_user 等用户点选项），紧凑行有 spinner，
#    长参数展开后快捷栏给进行中文案、不给「收起」
$liveRunningEval = ($head + @'

(async () => {
  const started = Date.now();
  freezeScroll();
  await wait(1500);
  await window.dsc.invoke('submit', ['这次的范围我拿不准，你先问我。', undefined]);
  let card = null;
  for (let i = 0; i < 80 && card === null; i += 1) { await wait(250); card = cards().filter((c) => nameOf(c) === 'ask_user')[0] || null; }
  if (card === null) return { case: 'live-running', error: '没等到 ask_user 工具卡' };
  const spin = card.querySelector('.tc-spin');
  const spinAnimation = spin === null ? null : getComputedStyle(spin).animationName + ' / ' + getComputedStyle(spin).animationDuration;
  await expand(card);
  const bar = await waitBar(card);
  await wait(400);
  await scrollToCard(card, 0);
  return {
    case: 'live-running',
    rowStatus: statusOf(card),
    spinnerCount: card.querySelectorAll('.tc-spin').length,
    spinnerAnimation: spinAnimation,
    askCardPresent: document.querySelector('.ask-card') !== null,
    pendingTurnMs: Date.now() - started,
    barFound: bar !== null,
    bar: barInfo(card),
  };
})()
'@)

# 6) 实时一轮 · 完成：压住 2.5 秒再点选项回答，工具卡带着真实耗时定稿，
#    快捷栏该显示「完成 · 用时 N秒」。整段脚本有总预算，任何一步等不到都会照实报出来，
#    不会把 electron 拖到截图时刻之后（那样日志里只剩一条「已写出」）。
$liveDurationEval = ($head + @'

(async () => {
  const t0 = Date.now();
  freezeScroll();
  const BUDGET = 16000;
  const left = () => BUDGET - (Date.now() - t0);
  const marks = {};
  const findCard = () => cards().filter((c) => nameOf(c) === 'ask_user')[0] || null;
  const until = async (pred) => {
    while (left() > 0) { const value = pred(); if (value) return value; await wait(250); }
    return null;
  };
  await wait(1200);
  await window.dsc.invoke('submit', ['这次的范围我拿不准，你先问我。', undefined]);
  let card = await until(findCard);
  marks.cardAt = Date.now() - t0;
  if (card === null) return { case: 'live-duration', marks, error: '没等到 ask_user 工具卡' };
  // 压住 2.5 秒再回答：这样「用时」是个看得见的非零值，而不是被秒级取整吞掉的 1 秒
  for (let i = 0; i < 10; i += 1) { await wait(250); }
  marks.runningText = statusOf(card);
  const opt = document.querySelector('.ask-option');
  marks.optionAt = Date.now() - t0;
  if (opt === null) return { case: 'live-duration', marks, error: '没等到提问卡' };
  opt.click();
  const settled = await until(() => {
    const current = findCard();
    return current !== null && statusOf(current).indexOf('进行中') < 0 ? current : null;
  });
  marks.toolDoneAt = Date.now() - t0;
  await until(() => document.querySelector('.turn-status') === null);
  marks.turnEndAt = Date.now() - t0;
  if (settled === null) return { case: 'live-duration', marks, error: '回答后工具卡没离开进行中' };
  await wait(400);
  await expand(settled);
  const bar = await waitBar(settled);
  await wait(400);
  await scrollToCard(settled, 30);
  return {
    case: 'live-duration',
    marks: marks,
    sawRunning: marks.runningText,
    finalStatus: statusOf(settled),
    barFound: bar !== null,
    bar: barInfo(settled),
  };
})()
'@)

# ── 用例表：每条会重新造种子（换主题）再跑一次 electron ─────────────────────────
$cases = [ordered]@{
  'tc-collapsed-dark'    = @{ theme = 'dark';  live = '';       delay = 15000; lead = 9000;  eval = $collapsedEval }
  'tc-expand-long-dark'  = @{ theme = 'dark';  live = '';       delay = 16000; lead = 10000; eval = $longEval }
  'tc-expand-short-dark' = @{ theme = 'dark';  live = '';       delay = 16000; lead = 10000; eval = $shortEval }
  'tc-running-dark'      = @{ theme = 'dark';  live = '';       delay = 16000; lead = 10000; eval = $runningEval }
  'tc-expand-long-light' = @{ theme = 'light'; live = '';       delay = 16000; lead = 10000; eval = $longEval }
  'tc-live-running'      = @{ theme = 'dark';  live = 'asktool'; delay = 22000; lead = 14000; eval = $liveRunningEval }
  'tc-live-duration'     = @{ theme = 'dark';  live = 'asktool'; delay = 50000; lead = 22000; eval = $liveDurationEval }
}

$script:server = $null
function Start-Fake([string]$mode) {
  if ($script:server -ne $null) { return }
  $script:server = Start-Process -FilePath 'node' -ArgumentList (Join-Path $shots 'tc-fake-llm.mjs'), $mode, $port -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 800
}
function Stop-Fake {
  if ($script:server -ne $null) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue; $script:server = $null }
}

try {
  foreach ($name in $cases.Keys) {
    if ($Only -ne 'all' -and $Only -ne $name) { continue }
    $spec = $cases[$name]

    # 每次重新造种子：会话文件是新的（随机 id），主题也在这里换
    $env:TC_THEME = $spec.theme
    $env:TC_FAKE_PORT = [string]$port
    node (Join-Path $shots 'tc-seed.mjs') | Out-Null
    $sessions = Get-Content (Join-Path $shots 'tc-sessions.json') -Raw | ConvertFrom-Json

    if ($spec.live -ne '') { Stop-Fake; Start-Fake $spec.live } else { Stop-Fake }

    $env:DSC_DESKTOP_USER_DATA = Join-Path $home2 'electron-userdata'
    $env:USERPROFILE = $home2
    $env:HOME = $home2
    $env:TC_FAKE_KEY = 'sk-selfcheck-fake'
    $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
    $env:DSC_RESUME_SESSION = if ($spec.live -ne '') { $sessions.live } else { $sessions.static }
    $env:DSC_DESKTOP_SHOT = Join-Path $shots "$name.png"
    $env:DSC_DESKTOP_SHOT_DELAY = [string]$spec.delay
    $env:DSC_DESKTOP_SHOT_EVAL_LEAD = [string]$spec.lead
    $env:DSC_DESKTOP_SHOT_EVAL = $spec.eval

    $log = Join-Path $shots "$name.log"
    Write-Output "=== $name ($($spec.theme)) ==="
    & $electron $entry *>&1 | Out-File -FilePath $log -Encoding utf8
    Select-String -Path $log -Pattern '\[selfcheck\]' | ForEach-Object { '  ' + $_.Line } | Select-Object -First 4
  }
} finally {
  Stop-Fake
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_RESUME_SESSION,
    Env:DSC_DESKTOP_USER_DATA, Env:TC_THEME, Env:TC_FAKE_PORT -ErrorAction SilentlyContinue
}
Write-Output '全部完成'


