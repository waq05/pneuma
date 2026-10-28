# 「每轮分叉与编辑重发」的自检截图 + 取证。
#
# 隔离怎么做：DSC_DESKTOP_USER_DATA 换掉 Electron 的 userData，USERPROFILE/HOME 换掉
# 宿主的 ~/.dsc——会话、配置、settings 全落在 desktop/shots/fork-home 下，用户真实的
# ~/.dsc 一个字节都不写。种子数据见 shots/fork-seed.mjs，假端点见 shots/fork-fake-llm.mjs。
#
# 用法（先 `pnpm run build` 与 `desktop && pnpm run build`，否则拍的是旧包）：
#   pwsh -NoProfile -File fork-shots.ps1              # 全部用例
#   pwsh -NoProfile -File fork-shots.ps1 -Only fork-edit-result

param([string]$Only = 'all')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$entry = Join-Path $shots '..\out\main\index.js'
$home2 = Join-Path $shots 'fork-home'
$port = 18961

# ── 预跑脚本里反复用到的探针 ───────────────────────────────────────────────────
$head = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const bubbles = () => Array.from(document.querySelectorAll('.entry-user'));
const acts = () => Array.from(document.querySelectorAll('.entry-user .user-act'));
const cards = () => Array.from(document.querySelectorAll('.tool-card'));
const thinks = () => Array.from(document.querySelectorAll('.think-block'));
const entries = () => Array.from(document.querySelectorAll('.entry-row'));
const openCards = () => cards().filter((c) => c.classList.contains('open')).length;
const openThinks = () => thinks().filter((t) => t.classList.contains('open')).length;
const userText = () => bubbles().map((b) => (b.querySelector('.user-edit-box') !== null ? '(编辑中)' : b.textContent.trim().slice(0, 30)));
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
// React 受控 textarea：必须走原型上的原生 setter 再派发 input，直接改 value React 收不到
const typeInto = (el, text) => {
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  desc.set.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
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
'@

# 1) 悬停操作条：默认不可见（opacity 0），键盘聚焦后现身；两颗按钮的 aria 与 title 都在
$hoverEval = ($head + @'

(async () => {
  await ready();
  freezeScroll();
  const list = bubbles();
  const second = list[1] !== undefined ? list[1] : list[0];
  const beforeFocus = getComputedStyle(second.querySelector('.user-actions')).opacity;
  const btns = Array.from(second.querySelectorAll('.user-act'));
  // 走键盘路径取证：focus 到按钮上（等价于 Tab 进来），:focus-within 才把它点亮
  if (btns[0] !== undefined) btns[0].focus();
  await wait(400);
  const afterFocus = getComputedStyle(second.querySelector('.user-actions')).opacity;
  const flat = rulesOf();
  const hoverRule = flat.find((r) => r.selectorText !== undefined && r.selectorText.indexOf('.entry-user:hover .user-actions') >= 0);
  return {
    case: 'hover-actions',
    theme: document.documentElement.dataset.theme,
    userBubbles: list.length,
    actionBars: document.querySelectorAll('.user-actions').length,
    opacityIdle: beforeFocus,
    opacityFocused: afterFocus,
    hoverRuleDeclared: hoverRule !== undefined,
    buttons: btns.map((b) => ({
      aria: b.getAttribute('aria-label'),
      title: b.getAttribute('title'),
      disabled: b.disabled,
      tabIndex: b.tabIndex,
      tag: b.tagName,
      size: Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height),
    })),
    // 焦点真的落在按钮上（键盘可达的硬证据）
    activeIsButton: document.activeElement === btns[0],
  };
})()
'@)

# 2) 点编辑：气泡原地变编辑框，预填原文，说明行写清「会分叉出新会话、原会话保留」
$editBoxEval = ($head + @'

(async () => {
  await ready();
  freezeScroll();
  const second = bubbles()[1];
  second.querySelectorAll('.user-act')[0].click();
  const box = await waitFor(() => document.querySelector('.user-edit-box'), 3000);
  if (box === null) return { case: 'edit-box', error: '编辑框没出现' };
  await wait(400);
  const note = document.querySelector('.user-edit-note');
  const bubble = box.closest('.entry-user');
  const cs = getComputedStyle(box);
  return {
    case: 'edit-box',
    editingBubbles: document.querySelectorAll('.entry-user.editing').length,
    prefilled: box.value,
    savedText: document.querySelector('.user-edit-actions .dsc-btn[data-variant="primary"]') !== null,
    noteText: note === null ? '(没有说明行)' : note.textContent.trim(),
    actions: Array.from(document.querySelectorAll('.user-edit-actions .dsc-btn')).map((b) => b.textContent.trim()),
    boxFocused: document.activeElement === box,
    boxFont: cs.fontSize + ' / ' + cs.lineHeight,
    boxWidth: Math.round(box.getBoundingClientRect().width),
    bubbleWidthRatio: +(bubble.getBoundingClientRect().width / document.querySelector('.chat-inner').getBoundingClientRect().width).toFixed(2),
    aria: box.getAttribute('aria-label'),
  };
})()
'@)

# 3) 编辑重发：改掉第二条用户消息 → 提交 → 新会话（含这条之前的全部内容）+ 改后正文 + 一轮回复
$editSubmitEval = ($head + @'

(async () => {
  await ready();
  freezeScroll();
  const before = await sessionNow();
  const beforeId = String(before.status.sessionId);
  const second = bubbles()[1];
  second.querySelectorAll('.user-act')[0].click();
  const box = await waitFor(() => document.querySelector('.user-edit-box'), 3000);
  if (box === null) return { case: 'edit-result', error: '编辑框没出现' };
  const changed = '第二轮（改过的）：折叠条的 hover 底色请直接用控制层令牌，别再写颜色字面量。';
  typeInto(box, changed);
  await wait(200);
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  // 等新会话 + 回复：会话 id 变了，且最后一条是助手正文
  const done = await waitFor(() => {
    const last = Array.from(document.querySelectorAll('.entry-row'));
    return last.length >= 9 && document.querySelector('.turn-status') === null;
  }, 25000);
  await wait(800);
  const after = await sessionNow();
  const texts = Array.from(document.querySelectorAll('.entry-row')).map((r) => {
    const user = r.querySelector('.entry-user');
    if (user !== null) return 'user: ' + user.textContent.trim().slice(0, 26);
    const sys = r.querySelector('.entry-system');
    if (sys !== null) return 'system: ' + sys.textContent.trim().slice(0, 26);
    const think = r.querySelector('.think-block');
    if (think !== null) return 'thinking';
    const card = r.querySelector('.tool-card');
    if (card !== null) return 'tool: ' + card.querySelector('.name').textContent;
    return 'text: ' + (r.querySelector('.entry-text') === null ? '?' : r.querySelector('.entry-text').textContent.trim().slice(0, 26));
  });
  return {
    case: 'edit-result',
    beforeSession: beforeId.slice(0, 8),
    afterSession: after === null ? '?' : String(after.status.sessionId).slice(0, 8),
    switched: after !== null && String(after.status.sessionId) !== beforeId,
    sessionsInList: after === null ? 0 : after.sessions.length,
    finished: done !== null,
    editingClosed: document.querySelector('.user-edit-box') === null,
    rows: texts,
    editCostBubbles: bubbles().length,
  };
})()
'@)

# 4) 每轮分叉：第二条用户消息上的「分叉」→ 新会话只含这条之前的全部内容
$forkEval = ($head + @'

(async () => {
  await ready();
  freezeScroll();
  const before = await sessionNow();
  bubbles()[1].querySelectorAll('.user-act')[1].click();
  const switched = await waitFor(() => document.querySelectorAll('.entry-row').length >= 4 && document.querySelector('.user-edit-box') === null, 8000);
  await wait(1200);
  const after = await sessionNow();
  const texts = Array.from(document.querySelectorAll('.entry-row')).map((r) => {
    const user = r.querySelector('.entry-user');
    if (user !== null) return 'user: ' + user.textContent.trim().slice(0, 26);
    const sys = r.querySelector('.entry-system');
    if (sys !== null) return 'system: ' + sys.textContent.trim().slice(0, 26);
    const think = r.querySelector('.think-block');
    if (think !== null) return 'thinking';
    const card = r.querySelector('.tool-card');
    if (card !== null) return 'tool: ' + card.querySelector('.name').textContent;
    return 'text: ' + (r.querySelector('.entry-text') === null ? '?' : r.querySelector('.entry-text').textContent.trim().slice(0, 26));
  });
  const toast = document.querySelector('.dsc-toast');
  return {
    case: 'fork-turn',
    beforeSession: String(before.status.sessionId).slice(0, 8),
    afterSession: after === null ? '?' : String(after.status.sessionId).slice(0, 8),
    switched: after !== null && String(after.status.sessionId) !== String(before.status.sessionId),
    sessionsInList: after === null ? 0 : after.sessions.length,
    userBubbles: bubbles().length,
    toast: toast === null ? '(已经散了)' : toast.textContent.trim(),
    rows: texts,
  };
})()
'@)

# 5) 折叠态跨会话往返不重置 + 重复打开同一会话是空操作（迟到重放幂等）
$idemEval = ($head + @'

(async () => {
  await ready();
  freezeScroll();
  const cards0 = cards();
  cards0[0].querySelector('.tool-head').click();
  await wait(400);
  if (cards0[1] !== undefined) { cards0[1].querySelector('.tool-head').click(); await wait(400); }
  const think = thinks()[0];
  if (think !== undefined) { think.querySelector('.think-head').click(); await wait(400); }
  const expanded = { cards: openCards(), thinks: openThinks() };

  const me = await sessionNow();
  const myPath = me.sessions.filter((s) => String(s.id).endsWith(String(me.status.sessionId) + '.jsonl'))[0].id;

  // 切去一个空会话（ChatView 整个被欢迎态换掉，组件全卸载）再切回来
  await window.dsc.invoke('openSession', []);
  await wait(1200);
  const welcome = document.querySelector('.welcome') !== null;
  await window.dsc.invoke('openSession', [myPath]);
  await waitFor(() => cards().length > 0, 6000);
  await wait(800);
  const roundTrip = { cards: openCards(), thinks: openThinks() };

  // 原地再开一次同一条会话：重放内容与当前一模一样，不该重建条目
  const rowsBefore = entries().length;
  const systemsBefore = document.querySelectorAll('.entry-system').length;
  await window.dsc.invoke('openSession', [myPath]);
  await wait(1500);
  const rowsAfter = entries().length;
  const systemsAfter = document.querySelectorAll('.entry-system').length;

  return {
    case: 'idempotent',
    expanded: expanded,
    welcomeSeen: welcome,
    afterRoundTrip: roundTrip,
    foldsSurvived: roundTrip.cards === expanded.cards && roundTrip.thinks === expanded.thinks,
    rowsBefore: rowsBefore,
    rowsAfter: rowsAfter,
    systemsBefore: systemsBefore,
    systemsAfter: systemsAfter,
    redundantReplayNoop: rowsBefore === rowsAfter && systemsBefore === systemsAfter,
  };
})()
'@)

# 6) 编辑第一条用户消息：分叉点之前没有任何内容，宿主会拒绝分叉，
#    这条路径要退化成「开一个新会话 + 把改后的正文当第一条消息发出去」
$editFirstEval = ($head + @'

(async () => {
  await ready();
  freezeScroll();
  const before = await sessionNow();
  const first = bubbles()[0];
  const forkBtn = first.querySelectorAll('.user-act')[1];
  const forkDisabled = forkBtn.disabled;
  const forkTitle = forkBtn.getAttribute('title');
  first.querySelectorAll('.user-act')[0].click();
  const box = await waitFor(() => document.querySelector('.user-edit-box'), 3000);
  if (box === null) return { case: 'edit-first', error: '编辑框没出现' };
  typeInto(box, '第一轮（改过的）：工具卡收成一行这件事先放一放，改成先统一折叠条的令牌。');
  await wait(200);
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitFor(() => document.querySelector('.turn-status') === null && bubbles().length === 1, 25000);
  await wait(1000);
  const after = await sessionNow();
  const texts = Array.from(document.querySelectorAll('.entry-row')).map((r) => {
    const user = r.querySelector('.entry-user');
    if (user !== null) return 'user: ' + user.textContent.trim().slice(0, 26);
    const sys = r.querySelector('.entry-system');
    if (sys !== null) return 'system: ' + sys.textContent.trim().slice(0, 26);
    const card = r.querySelector('.tool-card');
    if (card !== null) return 'tool: ' + card.querySelector('.name').textContent;
    return 'text: ' + (r.querySelector('.entry-text') === null ? '?' : r.querySelector('.entry-text').textContent.trim().slice(0, 26));
  });
  return {
    case: 'edit-first',
    forkButtonDisabledOnFirst: forkDisabled,
    forkButtonTitle: forkTitle,
    beforeSession: String(before.status.sessionId).slice(0, 8),
    afterSession: after === null ? '?' : String(after.status.sessionId).slice(0, 8),
    switched: after !== null && String(after.status.sessionId) !== String(before.status.sessionId),
    sessionsInList: after === null ? 0 : after.sessions.length,
    userBubbles: bubbles().length,
    rows: texts,
  };
})()
'@)

# ── 用例表 ─────────────────────────────────────────────────────────────────────
$cases = [ordered]@{
  'fork-hover-actions' = @{ delay = 14000; lead = 9000;  eval = $hoverEval }
  'fork-edit-box'      = @{ delay = 14000; lead = 9000;  eval = $editBoxEval }
  'fork-edit-result'   = @{ delay = 42000; lead = 20000; eval = $editSubmitEval }
  'fork-turn'          = @{ delay = 24000; lead = 15000; eval = $forkEval }
  'fork-idempotent'    = @{ delay = 34000; lead = 12000; eval = $idemEval }
  'fork-edit-first'    = @{ delay = 36000; lead = 18000; eval = $editFirstEval }
}

$script:server = $null
function Start-Fake {
  if ($script:server -ne $null) { return }
  $script:server = Start-Process -FilePath 'node' -ArgumentList (Join-Path $shots 'fork-fake-llm.mjs'), $port -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 800
}
function Stop-Fake {
  if ($script:server -ne $null) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue; $script:server = $null }
}

try {
  Start-Fake
  foreach ($name in $cases.Keys) {
    if ($Only -ne 'all' -and $Only -ne $name) { continue }
    $spec = $cases[$name]

    $env:FORK_THEME = 'dark'
    $env:FORK_FAKE_PORT = [string]$port
    node (Join-Path $shots 'fork-seed.mjs') | Out-Null
    $sessions = Get-Content (Join-Path $shots 'fork-sessions.json') -Raw | ConvertFrom-Json

    $env:DSC_DESKTOP_USER_DATA = Join-Path $home2 'electron-userdata'
    $env:USERPROFILE = $home2
    $env:HOME = $home2
    $env:FORK_FAKE_KEY = 'sk-selfcheck-fake'
    $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
    $env:DSC_RESUME_SESSION = $sessions.static
    $env:DSC_DESKTOP_SHOT = Join-Path $shots "$name.png"
    $env:DSC_DESKTOP_SHOT_DELAY = [string]$spec.delay
    $env:DSC_DESKTOP_SHOT_EVAL_LEAD = [string]$spec.lead
    $env:DSC_DESKTOP_SHOT_EVAL = $spec.eval

    $log = Join-Path $shots "$name.log"
    Write-Output "=== $name ==="
    & $electron $entry *>&1 | Out-File -FilePath $log -Encoding utf8
    Select-String -Path $log -Pattern '预跑脚本完成|预跑脚本失败|已写出' | ForEach-Object { '  ' + $_.Line }
  }
} finally {
  Stop-Fake
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_RESUME_SESSION,
    Env:DSC_DESKTOP_USER_DATA, Env:FORK_THEME, Env:FORK_FAKE_PORT, Env:FORK_FAKE_KEY -ErrorAction SilentlyContinue
}
Write-Output '全部完成'
