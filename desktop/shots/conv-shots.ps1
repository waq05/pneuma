# 「对话区按钮位置与边界优化」的自检截图 + 取证。
#
# 隔离怎么做：DSC_DESKTOP_USER_DATA 换掉 Electron 的 userData，USERPROFILE/HOME 换掉
# 宿主的 ~/.dsc——会话、配置、插件开关、settings 全落在 desktop/shots/conv-home 下，
# 用户真实的 ~/.dsc 一个字节都不写。种子数据见 shots/conv-seed.mjs，假端点见 shots/conv-fake-llm.mjs。
#
# 用法（先 `pnpm run build` 与 `desktop && pnpm run build`，否则拍的是旧包）：
#   pwsh -NoProfile -File conv-shots.ps1              # 全部用例
#   pwsh -NoProfile -File conv-shots.ps1 -Only conv-width
#
# 每个用例都把证据打成一行 JSON（日志里搜「预跑脚本完成」），截图落在 shots/*.png。

param([string]$Only = 'all')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$entry = Join-Path $shots '..\out\main\index.js'
$home2 = Join-Path $shots 'conv-home'
$port = 18971

# ── 预跑脚本里反复用到的探针 ───────────────────────────────────────────────────
$head = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const bubbles = () => Array.from(document.querySelectorAll('.entry-user'));
const cards = () => Array.from(document.querySelectorAll('.tool-card'));
const entries = () => Array.from(document.querySelectorAll('.entry-row'));
const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = pred(); if (v) return v; await wait(120); }
  return null;
};
// 冻结滚动：ChatView 只要看到 entries 变了就会贴底，那会把摆好的视角冲掉
const freezeScroll = () => {
  const chat = document.querySelector('.chat');
  if (chat === null) return false;
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (desc === undefined || desc.set === undefined) return false;
  const box = { value: desc.get.call(chat) };
  Object.defineProperty(chat, 'scrollTop', { configurable: true, get: () => box.value, set: () => {} });
  return true;
};
const rulesOf = () => {
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
const ready = async () => {
  for (let i = 0; i < 80; i += 1) { if (bubbles().length >= 2 && cards().length > 0) { await wait(700); return true; } await wait(250); }
  return false;
};
const sessionNow = async () => {
  let last = null;
  const off = window.dsc.onSnapshot((s) => { last = s; });
  await window.dsc.invoke('refreshSessions');
  await waitFor(() => last !== null && last.sessions.length > 0, 4000);
  off();
  return last;
};
const shape = (el) => {
  const b = el.getBoundingClientRect();
  return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) };
};
'@

# 1) 编辑按钮：在气泡外面、气泡正下方（而不是压在气泡背景里）
$editBelowEval = ($head + @'

(async () => {
  await ready();
  freezeScroll();
  const wraps = Array.from(document.querySelectorAll('.user-turn'));
  if (wraps.length === 0) return { case: 'edit-below', error: '没有 .user-turn（气泡外层容器没渲染）' };
  const wrap = wraps[wraps.length - 1];
  const bubble = wrap.querySelector('.entry-user');
  const actions = wrap.querySelector('.user-actions');
  if (bubble === null || actions === null) return { case: 'edit-below', error: '气泡或操作条缺失' };
  const btn = actions.querySelector('.user-act');
  const idleOpacity = getComputedStyle(actions).opacity;
  // 走键盘路径取证：focus 到按钮上（等价于 Tab 进来），:focus-within 才把它点亮
  btn.focus();
  await wait(500);
  const shownOpacity = getComputedStyle(actions).opacity;
  // 拍图在预跑脚本结束之后好几秒：中途焦点会不会被别的东西抢走，这里一并量出来
  await wait(8000);
  const lateOpacity = getComputedStyle(actions).opacity;
  const stillFocused = document.activeElement === btn;
  const activeTag = document.activeElement === null ? null : document.activeElement.tagName + '.' + document.activeElement.className;
  btn.focus();
  await wait(300);
  const sBubble = shape(bubble);
  const sBtn = shape(btn);
  const sWrap = shape(wrap);
  // 这一块后面的下一条内容：按钮有没有挤到别人身上
  const nextRow = wrap.parentElement === null ? null : wrap.parentElement.nextElementSibling;
  const nextNode = nextRow === null ? null : nextRow.firstElementChild;
  const sNext = nextNode === null ? null : shape(nextNode);
  const flat = rulesOf();
  return {
    case: 'edit-below',
    theme: document.documentElement.dataset.theme,
    userBlocks: wraps.length,
    // 证据一：按钮不在气泡这个盒子里（DOM 层面）
    insideBubble: btn.closest('.entry-user') !== null,
    bubbleOwnsActions: bubble.querySelector('.user-actions') !== null,
    // 证据二：几何上落在气泡底边之下，且右缘不越出气泡
    bubble: sBubble,
    button: sBtn,
    wrapper: sWrap,
    gapBelowBubble: sBtn.t - sBubble.b,
    buttonInsideBubbleBox: sBtn.t < sBubble.b && sBtn.r > sBubble.l && sBtn.l < sBubble.r,
    rightDeltaToBubble: sBubble.r - sBtn.r,
    // 证据三：这条消息的按钮只剩编辑，分叉已经不在气泡上
    buttonsInBlock: Array.from(wrap.querySelectorAll('.user-act')).map((x) => x.getAttribute('aria-label')),
    bubbleButtonCount: bubble.querySelectorAll('.user-act').length,
    // 证据四：按钮占的是自己的位置（下一块内容在它下面，没有叠上去）
    nextEntryTop: sNext === null ? null : sNext.t,
    overlapsNextEntry: sNext === null ? null : sNext.t < sBtn.b,
    // 显隐那条规则还在（hover 与 focus-within 同一组）
    opacityIdle: idleOpacity,
    opacityFocused: shownOpacity,
    opacityLate: lateOpacity,
    stillFocusedLate: stillFocused,
    activeLate: activeTag,
    hoverRuleDeclared: flat.some((r) => r.selectorText !== undefined && r.selectorText.indexOf('.user-turn:hover .user-actions') >= 0),
  };
})()
'@)

# 2) 分叉按钮：在每轮页脚的时间/用时旁边，不在气泡上；第 1 轮那颗置灰
$forkFooterEval = ($head + @'

(async () => {
  await ready();
  freezeScroll();
  const feet = Array.from(document.querySelectorAll('.round-foot'));
  const rows = feet.map((f, i) => {
    const clock = f.querySelector('.round-clock');
    const used = f.querySelector('.round-used');
    const btn = f.querySelector('.user-act');
    const sFoot = shape(f);
    const sBtn = btn === null ? null : shape(btn);
    const sClock = clock === null ? null : shape(clock);
    const sUsed = used === null ? null : shape(used);
    const anchor = sUsed !== null ? sUsed : sClock;
    return {
      round: i + 1,
      footerText: f.textContent.trim(),
      footer: sFoot,
      clock: clock === null ? null : clock.textContent.trim(),
      used: used === null ? null : used.textContent.trim(),
      hasFork: btn !== null,
      forkIcon: btn === null ? null : btn.querySelector('svg') !== null,
      forkAria: btn === null ? null : btn.getAttribute('aria-label'),
      forkTitle: btn === null ? null : btn.getAttribute('title'),
      forkDisabled: btn === null ? null : btn.disabled,
      forkBox: sBtn,
      // 与时间/用时同一行、且在它右边
      sameRowAsTime: anchor === null || sBtn === null ? null : Math.abs((anchor.t + anchor.b) / 2 - (sBtn.t + sBtn.b) / 2) <= 6,
      rightOfTime: anchor === null || sBtn === null ? null : sBtn.l >= anchor.r,
      insideFooter: sBtn === null ? null : sBtn.t >= sFoot.t - 1 && sBtn.b <= sFoot.b + 1,
      // 悬停提示（原生 title）
      defaultTip: btn !== null && btn.getAttribute('title') === '以这条消息为界分叉出新会话',
    };
  });
  return {
    case: 'fork-footer',
    userBubbles: bubbles().length,
    footers: feet.length,
    everyRoundHasFooter: bubbles().length === feet.length,
    everyFooterHasFork: rows.length > 0 && rows.every((r) => r.hasFork === true),
    rowsInSameRow: rows.every((r) => r.sameRowAsTime !== false),
    allRightOfTime: rows.every((r) => r.rightOfTime === true),
    forkStillInBubble: document.querySelectorAll('.entry-user .user-act').length,
    rows,
  };
})()
'@)

# 3) 点页脚那颗分叉：新会话只含这条之前的全部内容（确认点的是现成的 forkAt）
$forkClickEval = ($head + @'

(async () => {
  await ready();
  freezeScroll();
  const before = await sessionNow();
  const beforeId = String(before.status.sessionId);
  const feet = Array.from(document.querySelectorAll('.round-foot'));
  const btn = feet[feet.length - 1].querySelector('.user-act');
  if (btn === null || btn === undefined) return { case: 'fork-click', error: '最后一轮的页脚里没有分叉按钮' };
  const clickedDisabled = btn.disabled;
  btn.click();
  await waitFor(() => document.querySelector('.user-edit-box') === null, 3000);
  await wait(2000);
  const after = await sessionNow();
  const texts = Array.from(document.querySelectorAll('.entry-row')).map((r) => {
    const user = r.querySelector('.entry-user');
    if (user !== null) return 'user: ' + user.textContent.trim().slice(0, 24);
    const sys = r.querySelector('.entry-system');
    if (sys !== null) return 'system: ' + sys.textContent.trim().slice(0, 24);
    const think = r.querySelector('.think-block');
    if (think !== null) return 'thinking';
    const card = r.querySelector('.tool-card');
    if (card !== null) return 'tool: ' + card.querySelector('.name').textContent;
    return 'text: ' + (r.querySelector('.entry-text') === null ? '?' : r.querySelector('.entry-text').textContent.trim().slice(0, 24));
  });
  const toast = document.querySelector('.dsc-toast');
  return {
    case: 'fork-click',
    buttonWasDisabled: clickedDisabled,
    beforeSession: beforeId.slice(0, 8),
    afterSession: after === null ? '?' : String(after.status.sessionId).slice(0, 8),
    switched: after !== null && String(after.status.sessionId) !== beforeId,
    sessionsInList: after === null ? 0 : after.sessions.length,
    userBubblesAfter: bubbles().length,
    footersAfter: document.querySelectorAll('.round-foot').length,
    toast: toast === null ? '(已经散了)' : toast.textContent.trim(),
    rows: texts,
  };
})()
'@)

# 4) 进行中的状态行：两行之间那条分割线（假端点在这一档会挂住 20 秒）
$statusRuleEval = ($head + @'

(async () => {
  await ready();
  // 这一档不冻结滚动：状态行挂在流末尾，得让 ChatView 自己贴到底才拍得到
  await window.dsc.invoke('submit', ['第四轮：假装这一轮跑得久一点，我要拍状态行中间那条分割线。', undefined]);
  const status = await waitFor(() => document.querySelector('.turn-status'), 15000);
  if (status === null) return { case: 'status-rule', error: '状态行没出现（假端点没挂住？）' };
  // 等自动滚动贴到底：不贴底的话状态行会落在视口下面，截图上什么都看不到
  await waitFor(() => {
    const chat = document.querySelector('.chat');
    return chat !== null && chat.scrollHeight - chat.scrollTop - chat.clientHeight <= 40;
  }, 8000);
  await wait(800);
  const chatBox = shape(document.querySelector('.chat'));
  const rows = Array.from(document.querySelectorAll('.turn-status-row'));
  const rule = document.querySelector('.turn-status-rule');
  const s0 = rows[0] === undefined ? null : shape(rows[0]);
  const s1 = rows[1] === undefined ? null : shape(rows[1]);
  const sr = rule === null ? null : shape(rule);
  const cs = rule === null ? null : getComputedStyle(rule);
  const feet = Array.from(document.querySelectorAll('.round-foot'));
  const lastFoot = feet[feet.length - 1];
  const lastBtn = lastFoot === undefined ? null : lastFoot.querySelector('.user-act');
  return {
    case: 'status-rule',
    stageText: rows[0] === undefined ? null : rows[0].textContent.trim(),
    activityText: rows[1] === undefined ? null : rows[1].textContent.trim(),
    rowCount: rows.length,
    hasRule: rule !== null,
    ruleBox: sr,
    stageBox: s0,
    activityBox: s1,
    // 状态行整个在视口里（拍得到）
    chatVisibleBottom: chatBox.b,
    statusLineVisible: sr === null ? null : sr.t >= chatBox.t && sr.b <= chatBox.b,
    // 几何证据：线夹在阶段行与活动行之间，两边各留一点缝
    betweenRows: s0 === null || s1 === null || sr === null ? null : sr.t >= s0.b - 1 && sr.b <= s1.t + 1,
    gapUnderStage: sr === null || s0 === null ? null : sr.t - s0.b,
    gapAboveActivity: sr === null || s1 === null ? null : s1.t - sr.b,
    // 宽度对齐文本区：与两行里最宽那行等宽、左缘对齐
    ruleWidth: sr === null ? null : sr.w,
    stageWidth: s0 === null ? null : s0.w,
    activityWidth: s1 === null ? null : s1.w,
    widestRowWidth: s0 === null || s1 === null ? null : Math.max(s0.w, s1.w),
    widthAlignedToRows: sr === null || s0 === null || s1 === null ? null : Math.abs(sr.w - Math.max(s0.w, s1.w)) <= 1,
    leftAlignedToRows: sr === null || s0 === null ? null : Math.abs(sr.l - s0.l) <= 1,
    border: cs === null ? null : cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
    // 这一轮还在跑：它的页脚有分叉按钮，但是置灰的
    runningRoundFooterExists: lastBtn !== null,
    runningRoundFooterText: lastFoot === undefined ? null : lastFoot.textContent.trim(),
    runningForkDisabled: lastBtn === null ? null : lastBtn.disabled,
    runningForkTitle: lastBtn === null ? null : lastBtn.getAttribute('title'),
    // 已经收工的那几轮：分叉按钮同样置灰（一轮在跑时整排都不给点）
    finishedRoundsForkDisabled: feet.slice(0, -1).map((f) => { const b = f.querySelector('.user-act'); return b === null ? null : b.disabled; }),
  };
})()
'@)

# 5) 拖宽边界：正文拖到最宽，量 .chat-inner 右缘与刻度轨道左缘的关系
$widthEval = ($head + @'

(async () => {
  await ready();
  freezeScroll();
  const zone = document.querySelector('.thread-zone');
  const inner = document.querySelector('.chat-inner');
  const strip = document.querySelector('.jump-rail');
  const handle = document.querySelector('.thread-handle[data-side="right"]');
  if (zone === null || inner === null || handle === null) return { case: 'width-clamp', error: '量宽度要的节点缺失' };
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const lane = parseFloat(cs.getPropertyValue('--dsc-jump-lane'));
  const sb = parseFloat(cs.getPropertyValue('--dsc-scrollbar-w'));
  const zoneW = zone.clientWidth;
  const zoneBox = shape(zone);
  const stripBox = strip === null ? null : shape(strip);
  // 合成一次拖拽：Pointer Capture 在合成事件里没有活动指针，先把三个方法替掉
  const proto = Element.prototype;
  const saved = { set: proto.setPointerCapture, has: proto.hasPointerCapture, rel: proto.releasePointerCapture };
  proto.setPointerCapture = function () {};
  proto.hasPointerCapture = function () { return true; };
  proto.releasePointerCapture = function () {};
  const x0 = shape(handle).l + 2;
  const mk = (x, buttons) => new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons, clientX: x, clientY: 400 });
  const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x0, clientY: 400 });
  const far = x0 + 4000;
  handle.dispatchEvent(down);
  handle.dispatchEvent(mk(far, 1));
  await wait(150);
  const duringVar = root.style.getPropertyValue('--dsc-thread-max').trim();
  const duringBox = shape(inner);
  handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0, clientX: far, clientY: 400 }));
  await wait(400);
  const afterVar = root.style.getPropertyValue('--dsc-thread-max').trim();
  const afterBox = shape(inner);
  const stored = localStorage.getItem('dsc.threadWidth');
  proto.setPointerCapture = saved.set; proto.hasPointerCapture = saved.has; proto.releasePointerCapture = saved.rel;
  const gapNow = stripBox === null ? null : stripBox.l - afterBox.r;
  const composerBox = shape(document.querySelector('.composer'));
  const composerGapNow = stripBox === null ? null : stripBox.l - composerBox.r;
  // 旧上限（只扣 THREAD_EDGE_BUDGET 80px，不让刻度轨道）落在哪：手工摆一次量一量
  const legacyPx = zoneW - 80;
  root.style.setProperty('--dsc-thread-max', legacyPx + 'px');
  await wait(150);
  const legacyBox = shape(inner);
  const legacyGap = stripBox === null ? null : stripBox.l - legacyBox.r;
  const legacyComposer = shape(document.querySelector('.composer'));
  const legacyComposerGap = stripBox === null ? null : stripBox.l - legacyComposer.r;
  root.style.setProperty('--dsc-thread-max', afterVar === '' ? '' : afterVar);
  if (afterVar === '') root.style.removeProperty('--dsc-thread-max');
  await wait(150);
  return {
    case: 'width-clamp',
    windowInner: window.innerWidth,
    zoneWidth: zoneW,
    zoneBox,
    laneFromToken: lane,
    scrollbarFromToken: sb,
    expectedMax: zoneW - 80 - (lane + sb),
    threadMaxDuringDrag: duringVar,
    threadMaxAfterCommit: afterVar,
    storedThreadWidth: stored,
    dragAndCommitAgree: duringVar === afterVar && duringVar === (zoneW - 80 - (lane + sb)) + 'px',
    // 正文右缘 vs 刻度轨道左缘：差为正 = 不重叠
    chatInnerAfter: afterBox,
    jumpStrip: stripBox,
    gapInnerToStrip: gapNow,
    noOverlap: gapNow === null ? null : gapNow >= 0,
    // 输入框是与正文同宽的那块可见底色（正文的盒子看不见，输入框看得见）：
    // 它的右缘跟刻度轨道差多少，才是肉眼看到的「压没压到刻度」
    composerBox,
    composerGapToStrip: composerGapNow,
    composerNoOverlap: composerGapNow === null ? null : composerGapNow >= 0,
    // 同一把尺子量旧上限：对照用
    legacyMaxPx: legacyPx,
    chatInnerAtLegacyMax: legacyBox,
    gapAtLegacyMax: legacyGap,
    legacyNoOverlap: legacyGap === null ? null : legacyGap >= 0,
    composerAtLegacyMax: legacyComposer,
    composerGapAtLegacyMax: legacyComposerGap,
  };
})()
'@)

# 6) 只读视图（队友运行记录）：编辑与分叉都不许出现，页脚的时间照常
$peekEval = ($head + @'

(async () => {
  const peek = await waitFor(() => document.querySelector('.peek'), 10000);
  if (peek === null) return { case: 'peek-readonly', error: '队友只读视图没打开（名册或 subagent 插件没起来）' };
  await waitFor(() => document.querySelectorAll('.peek .entry-row').length > 0, 10000);
  await wait(600);
  freezeScroll();
  return {
    case: 'peek-readonly',
    rounds: document.querySelectorAll('.peek .entry-user').length,
    userBlocks: document.querySelectorAll('.peek .user-turn').length,
    footers: document.querySelectorAll('.peek .round-foot').length,
    footerText: Array.from(document.querySelectorAll('.peek .round-foot')).map((f) => f.textContent.trim()),
    // 只读视图里三样都必须是 0：编辑按钮、分叉按钮、气泡下的操作条
    editButtons: document.querySelectorAll('.peek .user-actions .user-act').length,
    forkButtons: document.querySelectorAll('.peek .round-foot .user-act').length,
    anyUserAct: document.querySelectorAll('.peek .user-act').length,
  };
})()
'@)

# 6) 编辑态没有因为「多包一层 .user-turn」走样：气泡原地摊满正文列宽，按钮收起
$editOpenEval = ($head + @'

(async () => {
  await ready();
  freezeScroll();
  const wraps = Array.from(document.querySelectorAll('.user-turn'));
  const wrap = wraps[wraps.length - 1];
  const btn = wrap.querySelector('.user-actions .user-act');
  btn.click();
  const box = await waitFor(() => document.querySelector('.user-edit-box'), 3000);
  if (box === null) return { case: 'edit-open', error: '编辑框没出现' };
  await wait(500);
  const editing = wrap.querySelector('.entry-user.editing');
  const inner = document.querySelector('.chat-inner');
  const sBubble = editing === null ? null : shape(editing);
  const sInner = shape(inner);
  const cs = getComputedStyle(inner);
  const contentWidth = sInner.w - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return {
    case: 'edit-open',
    editingBubbles: document.querySelectorAll('.entry-user.editing').length,
    prefilled: box.value.slice(0, 20),
    bubbleBox: sBubble,
    chatInnerBox: sInner,
    innerContentWidth: Math.round(contentWidth),
    // 编辑态要摊满正文列（改之前就是这么定的），并且下面那条编辑按钮已经收起
    fillsColumn: sBubble === null ? null : Math.abs(sBubble.w - contentWidth) <= 1,
    editActionsHidden: wrap.querySelector('.user-actions') === null,
    actions: Array.from(document.querySelectorAll('.user-edit-actions .dsc-btn')).map((b) => b.textContent.trim()),
  };
})()
'@)

# ── 用例表 ─────────────────────────────────────────────────────────────────────
$cases = [ordered]@{
  'conv-edit-below'    = @{ delay = 16000; lead = 10000; hold = 0;     eval = $editBelowEval }
  'conv-fork-footer'   = @{ delay = 16000; lead = 10000; hold = 0;     eval = $forkFooterEval }
  'conv-width'         = @{ delay = 16000; lead = 10000; hold = 0;     eval = $widthEval }
  'conv-status-rule'   = @{ delay = 24000; lead = 11000; hold = 20000; eval = $statusRuleEval }
  'conv-fork-click'    = @{ delay = 30000; lead = 18000; hold = 0;     eval = $forkClickEval }
  'conv-edit-open'     = @{ delay = 18000; lead = 7000;  hold = 0;     eval = $editOpenEval }
  'conv-peek'          = @{ delay = 16000; lead = 8000;  hold = 0;     eval = $peekEval; search = 'peek=1' }
}

$script:server = $null
function Stop-Fake {
  if ($script:server -ne $null) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue; $script:server = $null }
}
function Start-Fake([int]$hold) {
  Stop-Fake
  $script:server = Start-Process -FilePath 'node' -ArgumentList (Join-Path $shots 'conv-fake-llm.mjs'), $port, $hold -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 900
}

try {
  foreach ($name in $cases.Keys) {
    if ($Only -ne 'all' -and $Only -ne $name) { continue }
    $spec = $cases[$name]

    Start-Fake ([int]$spec.hold)
    $env:CONV_THEME = 'dark'
    $env:CONV_FAKE_PORT = [string]$port
    $env:CONV_FAKE_HOLD_MS = [string]$spec.hold
    node (Join-Path $shots 'conv-seed.mjs') | Out-Null
    $sessions = Get-Content (Join-Path $shots 'conv-sessions.json') -Raw | ConvertFrom-Json

    $env:DSC_DESKTOP_USER_DATA = Join-Path $home2 'electron-userdata'
    $env:USERPROFILE = $home2
    $env:HOME = $home2
    $env:CONV_FAKE_KEY = 'sk-selfcheck-fake'
    $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
    $env:DSC_RESUME_SESSION = $sessions.static
    $env:DSC_DESKTOP_SHOT = Join-Path $shots "$name.png"
    $env:DSC_DESKTOP_SHOT_DELAY = [string]$spec.delay
    $env:DSC_DESKTOP_SHOT_EVAL_LEAD = [string]$spec.lead
    $env:DSC_DESKTOP_SHOT_EVAL = $spec.eval
    if ($spec.ContainsKey('search')) { $env:DSC_DESKTOP_SEARCH = $spec.search } else { Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue }

    $log = Join-Path $shots "$name.log"
    Write-Output "=== $name ==="
    & $electron $entry *>&1 | Out-File -FilePath $log -Encoding utf8
    Select-String -Path $log -Pattern '预跑脚本完成|预跑脚本失败|已写出' | ForEach-Object { '  ' + $_.Line }
  }
} finally {
  Stop-Fake
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_SEARCH,
    Env:DSC_DESKTOP_USER_DATA, Env:CONV_THEME, Env:CONV_FAKE_PORT, Env:CONV_FAKE_HOLD_MS, Env:CONV_FAKE_KEY -ErrorAction SilentlyContinue
}
Write-Output '全部完成'
