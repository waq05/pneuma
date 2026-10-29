# 「会话脚注与思考折叠改版」的自检截图 + 取证。
#
# 隔离怎么做：DSC_DESKTOP_USER_DATA 换掉 Electron 的 userData，USERPROFILE/HOME 换掉
# 宿主的 ~/.dsc——会话、配置、settings 全落在 desktop/shots/tf-home 下，
# 用户真实的 ~/.dsc 一个字节都不写。种子数据见 shots/tf-seed.mjs，假端点见 shots/tf-fake-llm.mjs。
#
# 用法（先在 desktop/ 跑 `pnpm run build`，否则拍的是旧包）：
#   pwsh -NoProfile -File tf-shots.ps1              # 全部用例
#   pwsh -NoProfile -File tf-shots.ps1 -Only tf-handle
#
# 每个用例都把证据打成一行 JSON（日志里搜「预跑脚本完成」），截图落在 shots/*.png。

param([string]$Only = 'all')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$entry = Join-Path $shots '..\out\main\index.js'
$home2 = Join-Path $shots 'tf-home'
$port = 18941

# ── 预跑脚本里反复用到的探针 ───────────────────────────────────────────────────
$head = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = pred(); if (v) return v; await wait(120); }
  return null;
};
const shape = (el) => {
  const b = el.getBoundingClientRect();
  return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) };
};
const blocks = () => Array.from(document.querySelectorAll('.think-block'));
const feet = () => Array.from(document.querySelectorAll('.round-foot'));
const chat = () => document.querySelector('.chat');
const chatBox = () => shape(chat());
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
// 静态样张就绪：四条思考折叠条 + 两个页脚
const readyStatic = async () => {
  const ok = await waitFor(() => blocks().length >= 4 && feet().length >= 2, 25000);
  await wait(800);
  return ok !== null;
};
// 冻结滚动位置：ChatView 只要看到 entries 变了就会 scrollTop = scrollHeight（自动贴底），
// 那会把自检摆好的视角冲掉——拦住它，拍照那几秒画面才是我要取证的那一屏。
// 只挡「设定 scrollTop」这一个写入口，组件逻辑一个字没改，读数照旧是真的。
const allowScroll = () => { window.__tfAllowScroll = true; };
const holdScroll = () => { window.__tfAllowScroll = false; };
const freezeScroll = () => {
  const box = chat();
  if (box === null) return false;
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (desc === undefined || desc.get === undefined || desc.set === undefined) return false;
  const held = { value: desc.get.call(box) };
  holdScroll();
  Object.defineProperty(box, 'scrollTop', {
    configurable: true,
    get: () => held.value,
    set: (value) => { if (window.__tfAllowScroll === true) { held.value = value; desc.set.call(box, value); } },
  });
  return true;
};
// 把某个元素的顶端对到相对滚动容器顶端 offset 像素处（负数 = 元素顶滚到容器上方），
// 闭环修正：读一次实际位置、补差值，最多四次。展开一张折叠条会改内容高度，浏览器自己的
// 滚动锚定会在这中间微调 scrollTop，一次算出来的目标值会差上几十像素。
const scrollTo = async (el, offset) => {
  const box = chat();
  for (let pass = 0; pass < 5; pass += 1) {
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top - offset;
    if (Math.abs(delta) < 2) break;
    allowScroll();
    box.scrollTop = Math.round(box.scrollTop + delta);
    await wait(260);
  }
  holdScroll();
  await wait(400);
};
// 吸附探针：快捷栏相对滚动容器顶端的偏移 + 折叠条顶端的位置。
// 往下滚一次，折叠条上移而偏移不变，才说明栏真的吸住了（不是恰好停在原位）。
const barProbe = () => {
  const bar = document.querySelector('.think-bar');
  if (bar === null) return null;
  return {
    offset: Math.round(bar.getBoundingClientRect().top - chat().getBoundingClientRect().top),
    blockTop: Math.round(bar.closest('.think-block').getBoundingClientRect().top),
    scrollTop: Math.round(chat().scrollTop),
  };
};
// 折叠条折叠态的读数：标题行、分隔点、摘要、状态、箭头、展开区
const blockInfo = (b) => {
  const head = b.querySelector('.think-head');
  const summary = b.querySelector('.think-summary-text');
  const dot = b.querySelector('.think-dot');
  const status = b.querySelector('.think-status');
  const chev = b.querySelector('.think-chevron');
  const body = b.querySelector('.think-body');
  const headCs = getComputedStyle(head);
  return {
    open: b.classList.contains('open'),
    liveClass: b.classList.contains('live'),
    state: b.dataset.state ?? null,
    preview: b.dataset.preview ?? null,
    headBox: shape(head),
    role: head.getAttribute('role'),
    tabIndex: head.getAttribute('tabindex'),
    ariaExpanded: head.getAttribute('aria-expanded'),
    tip: head.getAttribute('data-tip'),
    cursor: headCs.cursor,
    summary: summary === null ? null : summary.textContent,
    summaryBox: summary === null ? null : shape(summary),
    // 跑动中：摘要容器的 data-streaming 与扫光伪元素的动画
    streaming: b.querySelector('.think-summary') === null ? null : (b.querySelector('.think-summary').dataset.streaming ?? null),
    shimmerContent: summary === null ? null : getComputedStyle(summary, '::after').content,
    shimmerAnimation: summary === null ? null : getComputedStyle(summary, '::after').animationName + ' / ' + getComputedStyle(summary, '::after').animationDuration,
    dotCount: b.querySelectorAll('.think-dot').length,
    dotBox: dot === null ? null : shape(dot),
    statusText: status === null ? null : status.textContent,
    spinCount: b.querySelectorAll('.think-spin').length,
    chevron: chev === null ? null : shape(chev),
    chevronTransform: chev === null ? null : getComputedStyle(chev).transform,
    bodyInDom: body !== null,
    bodyH: body === null ? null : Math.round(body.getBoundingClientRect().height),
    bodyTransition: body === null ? null : getComputedStyle(body).transitionProperty + ' ' + getComputedStyle(body).transitionDuration,
    bodyDisplay: body === null ? null : getComputedStyle(body).display,
    clipOverflow: body === null ? null : (body.querySelector('.think-body-clip') === null ? null : getComputedStyle(body.querySelector('.think-body-clip')).overflow),
    barCount: b.querySelectorAll('.think-bar').length,
    srText: b.querySelector('.think-sr') === null ? null : b.querySelector('.think-sr').textContent,
  };
};
'@

# 1) 每轮页脚：四项（时刻 · 用时 · 分叉 · 用量）在正文列左缘一行读齐
$footEval = ($head + @'

(async () => {
  await readyStatic();
  freezeScroll();
  const inner = document.querySelector('.chat-inner');
  const innerCs = getComputedStyle(inner);
  const innerBox = shape(inner);
  const contentLeft = innerBox.l + parseFloat(innerCs.paddingLeft);
  const contentRight = innerBox.r - parseFloat(innerCs.paddingRight);
  const bodies = Array.from(document.querySelectorAll('.entry-text')).map((b) => shape(b).l);
  const rows = feet().map((f, i) => {
    const clock = f.querySelector('.round-clock');
    const used = f.querySelector('.round-used');
    const tokens = f.querySelector('.round-tokens');
    const fork = f.querySelector('.user-act');
    const s = shape(f);
    return {
      round: i + 1,
      text: f.textContent.trim(),
      foot: s,
      clockLeft: clock === null ? null : shape(clock).l,
      usedText: used === null ? null : used.textContent.trim(),
      tokenText: tokens === null ? null : tokens.textContent.trim(),
      tokenLeft: tokens === null ? null : shape(tokens).l,
      hasFork: fork !== null,
      forkLeft: fork === null ? null : shape(fork).l,
      forkDisabled: fork === null ? null : fork.disabled,
      // 整行各项同一行（中线差 ≤ 6px）
      oneRow: [clock, used, tokens, fork].filter((x) => x !== null)
        .every((x) => Math.abs((shape(x).t + shape(x).b) / 2 - (s.t + s.b) / 2) <= 6),
    };
  });
  // 把第一轮的页脚摆到视口下部：页脚与它上面那段正文同框
  await scrollTo(feet()[0], Math.round(chatBox().h * 0.62));
  const afterScroll = shape(feet()[0]);
  const flat = rulesOf();
  const footRule = flat.filter((r) => r.selectorText === '.round-foot').map((r) => r.style.cssText);
  return {
    case: 'foot-left',
    theme: document.documentElement.dataset.theme,
    innerBox,
    contentLeft,
    contentRight,
    assistantBodyLeft: bodies,
    footerCount: rows.length,
    rows,
    // 验收口径一：页脚整行与正文列内容左缘的差 ≤ 4px
    footLeftDelta: rows.map((r) => Math.abs(r.foot.l - contentLeft)),
    allFootersAligned: rows.every((r) => Math.abs(r.foot.l - contentLeft) <= 4),
    clockAligned: rows.every((r) => r.clockLeft !== null && Math.abs(r.clockLeft - contentLeft) <= 4),
    tokenInFooter: rows.every((r) => r.tokenText !== null && r.tokenText.indexOf('tok') > 0),
    // 用量已经不在助手消息末尾那条操作条上了
    metaUsageInDom: document.querySelectorAll('.meta-usage').length,
    // 页脚离对话区右缘还剩多远（改版前它贴在最右缘，这个差只有 1px）
    footRightGap: rows.map((r) => contentRight - r.foot.r),
    footRuleText: footRule,
    footerVisible: afterScroll.t >= chatBox().t && afterScroll.b <= chatBox().b,
  };
})()
'@)

# 2) 思考折叠态：图标 + 标题 + 分隔点 + 摘要行（收工取首行），没有展开区
$collapsedEval = ($head + @'

(async () => {
  await readyStatic();
  freezeScroll();
  const list = blocks();
  await scrollTo(list[0], 6);
  const rows = list.map(blockInfo);
  const headRule = rulesOf().filter((r) => r.selectorText === '.think-head').map((r) => r.style.cssText);
  return {
    case: 'think-collapsed',
    theme: document.documentElement.dataset.theme,
    count: rows.length,
    rows,
    // 收工后的摘要必须是「首行」，不是「最后一段首行」——种子里这两句不一样，正好分辨口径
    firstSummary: rows[0].summary,
    firstSummaryIsFirstLine: rows[0].summary === '第一段首行：先把三条改版各自的位置量清楚。',
    firstSummaryIsNotLastParagraph: rows[0].summary !== '第三段首行：最后把三处坐标再量一遍收工。',
    // 折叠态不许有展开区；每块一个分隔点；标题行可点（role/tabindex/cursor）
    bodiesInDom: rows.filter((r) => r.bodyInDom).length,
    dotsPerBlock: rows.map((r) => r.dotCount),
    allRowClickable: rows.every((r) => r.role === 'button' && r.tabIndex === '0' && r.cursor === 'pointer'),
    allCollapsed: rows.every((r) => !r.open),
    ariaExpanded: rows.map((r) => r.ariaExpanded),
    previewFlags: rows.map((r) => r.preview),
    rowHeights: rows.map((r) => r.headBox.h),
    headRuleText: headRule,
  };
})()
'@)

# 3) 点开 / 收起：高度过渡 + 展开后吸附快捷栏仍贴在滚动容器顶端
$expandEval = ($head + @'

(async () => {
  await readyStatic();
  freezeScroll();
  const long = blocks()[1];
  const head = long.querySelector('.think-head');
  const before = blockInfo(long);
  // 点整行（不是点箭头）：role=button 的标题行
  head.click();
  // 高度过渡：点完立刻连续采样，抓到「0 到终值之间」的高度就说明高度真的在长
  const samples = [];
  for (let i = 0; i < 26; i += 1) {
    const body = long.querySelector('.think-body');
    samples.push({ t: i * 16, h: body === null ? null : Math.round(body.getBoundingClientRect().height) });
    await wait(16);
  }
  const body = await waitFor(() => long.querySelector('.think-body'), 2000);
  if (body === null) return { case: 'think-expand', error: '点了标题行，展开区没出现' };
  const finalH = Math.round(body.getBoundingClientRect().height);
  const bar = await waitFor(() => long.querySelector('.think-bar'), 3000);
  await wait(400);
  // 吸附探针：把折叠条顶端滚到容器上方，栏应该还贴在容器顶端
  await scrollTo(long, -170);
  const probeA = barProbe();
  allowScroll();
  chat().scrollTop = chat().scrollTop + 140;
  await wait(700);
  holdScroll();
  const probeB = barProbe();
  const expanded = blockInfo(long);
  const midSamples = samples.filter((s) => s.h !== null && s.h > 0 && s.h < finalH - 4);
  // 再点一次收起：展开区必须整个退出 DOM，摘要行回到折叠态
  head.click();
  await wait(500);
  const afterCollapse = blockInfo(long);
  // 第三次点开，把这屏留给截图（展开态 + 吸附栏）
  head.click();
  await wait(700);
  await scrollTo(long, -150);
  return {
    case: 'think-expand',
    before,
    afterOpen: expanded,
    finalBodyH: finalH,
    heightSamples: samples,
    heightAnimated: midSamples.length > 0,
    midSampleCount: midSamples.length,
    // 吸附：滚过一屏以后栏与容器顶端的偏移不变，而折叠条顶端已经上移
    barFound: bar !== null,
    probeA,
    probeB,
    barStuck: probeA !== null && probeB !== null && probeA.offset === probeB.offset && probeB.blockTop < probeA.blockTop,
    afterCollapse,
    // 收起后再点开：折叠态摘要行原样还在（不是被展开态吃掉）
    summaryKeptAfterCollapse: afterCollapse.summary === before.summary,
  };
})()
'@)

# 4) 再点一次收起：展开区退出 DOM、摘要行回到折叠态（这一屏也出一张图）
$recollapseEval = ($head + @'

(async () => {
  await readyStatic();
  freezeScroll();
  const long = blocks()[1];
  const head = long.querySelector('.think-head');
  const summaryBefore = long.querySelector('.think-summary-text').textContent;
  // 点整行展开
  head.click();
  const body = await waitFor(() => long.querySelector('.think-body'), 3000);
  const whileOpen = blockInfo(long);
  // 再点整行收起
  head.click();
  await wait(600);
  const afterClose = blockInfo(long);
  await scrollTo(long, 6);
  return {
    case: 'think-recollapse',
    bodyAppeared: body !== null,
    whileOpen: { open: whileOpen.open, bodyInDom: whileOpen.bodyInDom, bodyH: whileOpen.bodyH, ariaExpanded: whileOpen.ariaExpanded, tip: whileOpen.tip },
    afterClose: { open: afterClose.open, bodyInDom: afterClose.bodyInDom, bodyH: afterClose.bodyH, ariaExpanded: afterClose.ariaExpanded, tip: afterClose.tip, summary: afterClose.summary, dotCount: afterClose.dotCount, barCount: afterClose.barCount },
    // 收起以后：展开区没了、摘要行原样还在、aria-expanded 回到 false
    bodyGone: afterClose.bodyInDom === false,
    summaryKept: afterClose.summary === summaryBefore,
    ariaFlippedBack: afterClose.ariaExpanded === 'false',
  };
})()
'@)

# 5) 折叠态跨重放保持（fold-state.ts）：展开第一条 → 切到另一条会话 → 切回来
#    两条会话的绝对路径由脚本在循环里拼进来（会话文件名是随机 id，这里不该猜）。
$foldBody = @'

(async () => {
  // 每一步都记一笔：万一哪次调用没回来，日志里也能看出卡在哪一步，而不是只剩一张截图。
  const steps = [];
  const call = async (method, args, ms) => {
    const result = await Promise.race([
      window.dsc.invoke(method, args).then(() => 'ok').catch((e) => 'err:' + String(e)),
      wait(ms).then(() => 'timeout'),
    ]);
    steps.push({ name: method, result });
    return result;
  };
  await readyStatic();
  steps.push({ name: 'ready', blocks: blocks().length, footers: feet().length });
  freezeScroll();
  const before = blocks()[0];
  if (before.classList.contains('open')) before.querySelector('.think-head').click();
  await wait(300);
  before.querySelector('.think-head').click();
  await wait(500);
  // 给这一枚折叠条打个标记：切回来以后如果还是同一个 DOM 元素，说明 React 是复用而不是重挂
  before.dataset.tfMark = 'before-switch';
  const wrap = (b) => ({ open: b.classList.contains('open'), key: b.dataset.foldKey ?? null, summary: b.querySelector('.think-summary-text') === null ? null : b.querySelector('.think-summary-text').textContent });
  const beforeSwitch = blocks().map(wrap);
  const otherEl = blocks()[0];
  // 切走：宿主会清空条目表、把另一条会话重放进来
  await call('openSession', [OTHER], 9000);
  const switched = await waitFor(() => {
    const bubble = document.querySelector('.entry-user');
    return bubble !== null && bubble.textContent.indexOf('另一条会话') >= 0 ? bubble : null;
  }, 10000);
  steps.push({ name: 'switchedToOther', ok: switched !== null, blocks: blocks().length });
  const otherKeys = blocks().map((b) => b.dataset.foldKey ?? null);
  const otherMark = otherEl === blocks()[0];
  // 切回来：同一份 jsonl 再重放一遍，条目 id 从 1 重新发号、组件全部重挂
  await call('openSession', [SELF], 9000);
  const back = await waitFor(() => (blocks().length >= 4 ? blocks() : null), 10000);
  steps.push({ name: 'backToSelf', ok: back !== null, blocks: blocks().length });
  await wait(900);
  const sameFirstElement = blocks()[0] === before;
  const marksLeft = document.querySelectorAll('[data-tf-mark]').length;
  const afterReplay = blocks().map(wrap);
  await scrollTo(blocks()[0], 6);
  return {
    case: 'think-fold-replay',
    steps,
    sameFirstElement,
    otherFirstElementReused: otherMark,
    otherKeys,
    marksLeft,
    beforeSwitch,
    switchedToOther: switched !== null,
    backToSelf: back !== null,
    afterReplay,
    // 折叠条挂载时用的 key、以及每一次写存档的 key（fold-state 的键是「会话:序号」）
    // 展开的那一条重放后仍然展开，其余三条仍然是折叠态
    expandedSurvived: beforeSwitch[0].open === true && afterReplay[0].open === true,
    othersStillCollapsed: afterReplay.slice(1).every((r) => r.open === false),
    summaryStable: afterReplay[0].summary === beforeSwitch[0].summary,
    summaryAfterReplay: afterReplay[0].summary,
  };
})()
'@

# 5) 跑动中的折叠态：摘要停在「最新写完的那一段首行」，带扫光，直播尾默认展开
$liveEval = ($head + @'

(async () => {
  await waitFor(() => document.querySelectorAll('.entry-user').length >= 1, 20000);
  await wait(1200);
  await window.dsc.invoke('submit', ['把跑动中的思考念一段给我看看。', undefined]);
  const block = await waitFor(() => document.querySelector('.think-block[data-state="running"]'), 20000);
  if (block === null) return { case: 'think-live', error: '没等到跑动中的思考折叠条（假端点没吐 reasoning_content？）' };
  await wait(1500);
  const info = blockInfo(block);
  const summaryEl = block.querySelector('.think-summary-text');
  await scrollTo(block, 6);
  return {
    case: 'think-live',
    theme: document.documentElement.dataset.theme,
    state: info.state,
    summary: info.summary,
    // 第三段还在往下吐、没有换行，所以摘要必须停在第二段首行
    summaryIsLatestCompletedParagraph: info.summary === '第二段：折叠态的摘要取最新写完的那一段首行。',
    summaryIsNotStreamingParagraph: info.summary === null ? null : info.summary.indexOf('第三段') < 0,
    streaming: info.streaming,
    shimmerContent: info.shimmerContent,
    shimmerAnimation: info.shimmerAnimation,
    maskImage: getComputedStyle(block.querySelector('.think-summary')).maskImage,
    spinCount: info.spinCount,
    srText: info.srText,
    // 直播尾（entry.id < 0）挂载即展开：行为与改之前一致
    liveOpensByDefault: info.open,
    bodyInDom: info.bodyInDom,
    rowClickable: info.role === 'button' && info.cursor === 'pointer',
    dotCount: info.dotCount,
  };
})()
'@)

# 6) 拖宽把手：中心压在正文列左右缘上；拖到最宽仍受刻度轨道的上边界约束
$handleEval = ($head + @'

(async () => {
  await readyStatic();
  freezeScroll();
  const zone = document.querySelector('.thread-zone');
  const inner = document.querySelector('.chat-inner');
  const left = document.querySelector('.thread-handle[data-side="left"]');
  const right = document.querySelector('.thread-handle[data-side="right"]');
  if (zone === null || inner === null || left === null || right === null) return { case: 'handle-edge', error: '量把手要的节点缺失' };
  const centre = (el) => { const b = shape(el); return b.l + b.w / 2; };
  const snapshot = () => {
    const box = shape(inner);
    return {
      inner: box,
      leftCentre: centre(left),
      rightCentre: centre(right),
      leftW: shape(left).w,
      rightW: shape(right).w,
      // 验收口径：把手中心与正文列左右缘的差 ≤ 2px
      leftDelta: Math.abs(centre(left) - box.l),
      rightDelta: Math.abs(centre(right) - box.r),
      vars: {
        start: zone.style.getPropertyValue('--dsc-thread-col-start').trim(),
        end: zone.style.getPropertyValue('--dsc-thread-col-end').trim(),
      },
    };
  };
  const atDefault = snapshot();
  // 上边界：zone 宽 − 两侧预算 − 刻度轨道（panels.ts 的 THREAD_EDGE_BUDGET + readRightRailPx）
  const cs = getComputedStyle(document.documentElement);
  const lane = parseFloat(cs.getPropertyValue('--dsc-jump-lane'));
  const sb = parseFloat(cs.getPropertyValue('--dsc-scrollbar-w'));
  const expectedMax = zone.clientWidth - 80 - (lane + sb);
  // 合成一次拖拽：Pointer Capture 在合成事件里没有活动指针，先把三个方法替掉
  const proto = Element.prototype;
  const saved = { set: proto.setPointerCapture, has: proto.hasPointerCapture, rel: proto.releasePointerCapture };
  proto.setPointerCapture = function () {};
  proto.hasPointerCapture = function () { return true; };
  proto.releasePointerCapture = function () {};
  const mk = (type, x, buttons) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons, clientX: x, clientY: 400 });
  // 拖动中的宽度更新挂在 requestAnimationFrame 上：窗口被压在别的窗口后面时不保证按帧投递，
  // 所以这里最多试三趟，每趟都重新按下——一趟没落到变量上不代表拖动逻辑坏了。
  let attempts = 0;
  let duringVar = '';
  let atMax = atDefault;
  while (attempts < 3) {
    attempts += 1;
    const x0 = shape(right).l + 2;
    const far = x0 + 4000;
    right.dispatchEvent(mk('pointerdown', x0, 1));
    right.dispatchEvent(mk('pointermove', far, 1));
    await wait(400);
    duringVar = document.documentElement.style.getPropertyValue('--dsc-thread-max').trim();
    atMax = snapshot();
    right.dispatchEvent(mk('pointerup', far, 0));
    await wait(350);
    if (duringVar === expectedMax + 'px') break;
  }
  const varAfterCommit = document.documentElement.style.getPropertyValue('--dsc-thread-max').trim();
  const storedAfterDrag = localStorage.getItem('dsc.threadWidth');
  proto.setPointerCapture = saved.set; proto.hasPointerCapture = saved.has; proto.releasePointerCapture = saved.rel;
  // 双击复位：删掉存档，回到样式表默认的列宽
  right.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0 }));
  await wait(500);
  const storedAfterReset = localStorage.getItem('dsc.threadWidth');
  const atReset = snapshot();
  const strip = document.querySelector('.jump-rail');
  const stripBox = strip === null ? null : shape(strip);
  // 竖条只在 hover / 拖动时亮：真实 :hover 抓不进静态图，这里把 data-dragging 挂上
  // （样式表里 `.thread-handle[data-dragging]::after { opacity: 1 }` 就是拖动时的样子），
  // 留给截图那几秒，好让「把手中心 = 正文列边缘」在图上直接看得见。
  for (const h of Array.from(document.querySelectorAll('.thread-handle'))) h.setAttribute('data-dragging', '');
  await wait(300);
  const stripeRule = rulesOf().filter((r) => r.selectorText === '.thread-handle::after').map((r) => r.style.cssText);
  return {
    case: 'handle-edge',
    windowInner: window.innerWidth,
    zoneWidth: zone.clientWidth,
    atDefault,
    atMax,
    atReset,
    threadMaxDuringDrag: duringVar,
    threadMaxAfterCommit: varAfterCommit,
    dragAttempts: attempts,
    expectedMax: expectedMax + 'px',
    // 上边界：拖到最宽时落在「zone 宽 − 两侧预算 − 刻度轨道」上，不多占刻度条那一格。
    // 拖动中的读数依赖 rAF 投递，落盘那一份（App 应用列宽）不依赖，两者任一命中就算守住。
    clampHolds: duringVar === expectedMax + 'px' || varAfterCommit === expectedMax + 'px',
    storedAfterDrag,
    storedAfterReset,
    // 拖宽以后把手跟着列走（两种宽度下都与列缘重合）
    followsColumn: atMax.leftDelta <= 2 && atMax.rightDelta <= 2,
    // 没拖过之前的静息态也要重合：把手第一帧就得压在列缘上（不能等观察器下一帧）
    alignedAtDefault: atDefault.leftDelta <= 2 && atDefault.rightDelta <= 2,
    varsWrittenBeforeAnyDrag: atDefault.vars.start !== '' && atDefault.vars.end !== '',
    // 双击复位只换列宽、不走拖动：那一帧同样要跟上
    alignedAtReset: atReset.leftDelta <= 2 && atReset.rightDelta <= 2,
    jumpStrip: stripBox,
    gapInnerToStripAtMax: stripBox === null ? null : stripBox.l - atMax.inner.r,
    stripeRuleText: stripeRule,
  };
})()
'@)

# ── 用例表 ─────────────────────────────────────────────────────────────────────
$cases = [ordered]@{
  'tf-foot-left'        = @{ delay = 15000; lead = 8000;  live = $false; eval = $footEval }
  'tf-think-collapsed'  = @{ delay = 15000; lead = 8000;  live = $false; eval = $collapsedEval }
  'tf-think-expand'     = @{ delay = 19000; lead = 9000;  live = $false; eval = $expandEval }
  'tf-think-recollapse' = @{ delay = 18000; lead = 9000;  live = $false; eval = $recollapseEval }
  'tf-think-fold'       = @{ delay = 26000; lead = 12000; live = $false; eval = $null }
  'tf-handle'           = @{ delay = 17000; lead = 9000;  live = $false; eval = $handleEval }
  'tf-think-live'       = @{ delay = 30000; lead = 16000; live = $true;  eval = $liveEval }
}

$script:server = $null
function Stop-Fake {
  if ($script:server -ne $null) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue; $script:server = $null }
}
function Start-Fake {
  Stop-Fake
  $script:server = Start-Process -FilePath 'node' -ArgumentList (Join-Path $shots 'tf-fake-llm.mjs'), $port -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 900
}

try {
  foreach ($name in $cases.Keys) {
    if ($Only -ne 'all' -and $Only -ne $name) { continue }
    $spec = $cases[$name]

    $env:TF_THEME = 'dark'
    $env:TF_FAKE_PORT = [string]$port
    node (Join-Path $shots 'tf-seed.mjs') | Out-Null
    $sessions = Get-Content (Join-Path $shots 'tf-sessions.json') -Raw | ConvertFrom-Json

    # 跨重放那条用例要用两条会话的绝对路径（随机文件名，脚本不该猜），在这里拼进预跑脚本
    $caseEval = $spec.eval
    if ($name -eq 'tf-think-fold') {
      $consts = "`nconst SELF = " + ($sessions.static | ConvertTo-Json -Compress) +
        ";`nconst OTHER = " + ($sessions.other | ConvertTo-Json -Compress) + ";`n"
      $caseEval = $head + $consts + $foldBody
    }

    if ($spec.live) { Start-Fake } else { Stop-Fake }

    $env:DSC_DESKTOP_USER_DATA = Join-Path $home2 'electron-userdata'
    $env:USERPROFILE = $home2
    $env:HOME = $home2
    $env:TF_FAKE_KEY = 'sk-selfcheck-fake'
    $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
    $env:DSC_RESUME_SESSION = if ($spec.live) { $sessions.live } else { $sessions.static }
    $env:DSC_DESKTOP_SHOT = Join-Path $shots "$name.png"
    $env:DSC_DESKTOP_SHOT_DELAY = [string]$spec.delay
    $env:DSC_DESKTOP_SHOT_EVAL_LEAD = [string]$spec.lead
    $env:DSC_DESKTOP_SHOT_EVAL = $caseEval

    $log = Join-Path $shots "$name.log"
    Write-Output "=== $name ==="
    & $electron $entry *>&1 | Out-File -FilePath $log -Encoding utf8
    Select-String -Path $log -Pattern '预跑脚本完成|预跑脚本失败|已写出' | ForEach-Object { '  ' + $_.Line }
  }
} finally {
  Stop-Fake
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_RESUME_SESSION,
    Env:DSC_DESKTOP_USER_DATA, Env:TF_THEME, Env:TF_FAKE_PORT, Env:TF_FAKE_KEY -ErrorAction SilentlyContinue
}
Write-Output '全部完成'
