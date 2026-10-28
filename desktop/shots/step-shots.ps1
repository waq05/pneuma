# 「阶段组折叠」的隔离桌面自检（截图 + 取证）。
#
# 隔离怎么做：DSC_DESKTOP_USER_DATA 换掉 Electron 的 userData，USERPROFILE / HOME 换掉宿主的
# ~/.dsc——会话、配置、settings 全落在 desktop/shots/step-home 下，用户真实的 ~/.dsc 一个字节
# 都不写。种子数据见 shots/step-seed.mjs。
# 跑前跑后各对真实 ~/.dsc 做一次「文件数 + 全量 SHA256 聚合指纹」比对。
#
# 进程管理（刻意不用 `& electron | Out-File`）：Start-Process 起 electron.exe、轮询 stderr
# 日志里的关键行、最后 taskkill /PID <自己起的那棵进程树> /T /F。
# 临时目录变量一律自命名（$stepHome 等），绝不用 $home / $HOME——那是 PowerShell 只读自动变量，
# 赋值会静默失败并把后续写入落到真实用户目录。
#
# 六个用例覆盖三层显隐与四档档位（对照 dsh 的 conversation-nodes/README.zh.md:56-59 那张表）：
#   step-static   标准档：整轮收起时组头根本不画 → 展开整轮后浮出三个组头且默认全收起
#                 → 点开第一组，它自己的成员回来、另外两组仍然收起。
#                 同一个用例里另验四件事：组体限高与组内独立滚动（C1）、
#                 焦点在过程区里时收起被撤回（D1）、Ctrl+F 那种 beforematch 命中能放出内容（D2）、
#                 计划卡不进组（D3）。
#   step-live     标准档 + 真跑一轮：跑动中组头已出现且带实时详情、组体收起（A1）；
#                 采样确认标题不因事件密集而抖（A2）→ 定稿后两级一起自动收起。
#   step-detailed 详细档 + 真跑一轮：正在跑的那一轮不分组（直接摊开），历史轮才有组头（B1）。
#   step-verbose  完全展开档：不折整轮、也不分组，过程条目逐条摊开（B1）。
#   step-light    浅色主题：组头比思考行醒目这条分层换主题后仍成立（E1）。
#   step-plan     计划卡：封掉它前面那一组、自己不在任何组体里（D3）。
#   step-prepare  标准档 + 真跑一轮：抓到「准备中」那一瞬（不可展开的一行），并验假端点头一次 500
#                 之后界面上真的出现「模型重试行」（批 2）。
#   step-paging   12 轮的长样张：初始只画最近一页（8 轮）+ 顶上「加载更早」；点它之后更早的轮
#                 画出来、而**锚点元素在视口里一动不动**（分页锚定），手动展开的整轮保持展开。
#   step-control  标准档 + 真跑三轮：轮中途插话两条消息落在同一轮且锁住整轮折叠、
#                 组收口时不重置组内阅读位置、中断的轮报「已停止」且过程保持展开（与 dsh 对齐）。
#
# 用法（先在 desktop/ 跑 `pnpm run build`，否则拍的是旧包）：
#   pwsh -NoProfile -File step-shots.ps1              # 三个用例
#   pwsh -NoProfile -File step-shots.ps1 -Only step-static
#
# 每个用例把证据打成一行 JSON（日志里搜「预跑脚本完成」），截图落在 shots/step-*.png。

param([string]$Only = 'all')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$stepShots = 'D:\dsc\desktop\shots'
$stepElectron = Join-Path $stepShots '..\node_modules\electron\dist\electron.exe'
$stepEntry = Join-Path $stepShots '..\out\main\index.js'
$stepHome = Join-Path $stepShots 'step-home'
$stepPort = 18953
# 真实用户目录：必须在把 USERPROFILE/HOME 指到隔离目录之前读出来。
$stepRealProfile = $env:USERPROFILE
$stepRealDsc = Join-Path $stepRealProfile '.dsc'

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
$stepHead = @'
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
// ── 可见性过滤（0.6.6 起「收起」不再卸载 DOM，而是挂 hidden="until-found"） ────
// 判据是「祖先（含自身）带 hidden 属性」而不是只看 getClientRects：Chromium 把
// hidden="until-found" 实现成 `content-visibility: hidden`，被跳过的内容在 getClientRects 里
// **仍然报矩形**（实测 8 条收起的组成员全报 1），只按矩形判会把收起来的那一堆又算成可见。
// 两个条件一起用：hidden 属性管「我们主动收起来的」，矩形管「别的原因没渲染出来的」。
const visible = (nodes) => Array.from(nodes).filter(
  (el) => el.closest('[hidden]') === null && el.getClientRects().length > 0,
);
const toggles = () => visible(document.querySelectorAll('.turn-fold'));
const steps = () => visible(document.querySelectorAll('.step-fold'));
const feet = () => visible(document.querySelectorAll('.round-foot'));
const blocks = () => visible(document.querySelectorAll('.think-block'));
const cards = () => visible(document.querySelectorAll('.tool-card'));
const planCards = () => visible(document.querySelectorAll('.plan-card'));
const chat = () => document.querySelector('.chat');
// 阶段组头的取证形状：文案 / 类别 / 收口状态 / 类别次数 / 组号 / 实时详情 / 开合态 / 箭头朝向
const stepInfo = (s) => {
  const labelEl = s.querySelector('.step-fold-label');
  const detailEl = s.querySelector('.step-fold-detail');
  return {
    label: labelEl === null ? '' : labelEl.textContent.trim(),
    activity: s.dataset.stepActivity ?? null,
    closed: s.dataset.stepClosed ?? null,
    counts: s.dataset.stepCounts ?? null,
    detail: s.dataset.stepDetail ?? null,
    group: s.dataset.stepGroup ?? null,
    ariaExpanded: s.getAttribute('aria-expanded'),
    open: s.dataset.open ?? null,
    chevronTransform: getComputedStyle(s.querySelector('.step-fold-chevron')).transform,
    // 跑动中的扫光挂点：属性值就是被复制出来的那串文字（收口的组应为 null）
    shimmer: labelEl === null ? null : labelEl.getAttribute('data-shimmer'),
    iconOpacity: getComputedStyle(s.querySelector('.step-fold-icon')).opacity,
    chevronOpacity: getComputedStyle(s.querySelector('.step-fold-chevron')).opacity,
    box: shape(s),
    // 0.6.46 起详情在标题下一行：量两行的纵向距离与详情行的横向范围，
    // 断言「真的换行了」「截在组头宽度里没撑破会话」
    labelTop: labelEl === null ? null : Math.round(labelEl.getBoundingClientRect().top),
    detailLine: detailEl === null ? null : {
      text: detailEl.textContent.trim(),
      top: Math.round(detailEl.getBoundingClientRect().top),
      left: Math.round(detailEl.getBoundingClientRect().left),
      right: Math.round(detailEl.getBoundingClientRect().right),
      clipped: detailEl.scrollWidth > detailEl.clientWidth,
    },
  };
};
// 组体 / 收起态的行（D2 的取证；组体内的行不单独挂 hidden，由组体那两层管）
const stepBodies = () => visible(document.querySelectorAll('.step-body'));
const hiddenRows = () => Array.from(document.querySelectorAll('.entry-row[hidden="until-found"]'));
// 某一轮里实际看得见的过程条目：用来验「组收起时组员不再渲染出画面」。
// 注意口径变了——0.6.3 是「组员根本不渲染」，0.6.6 是「渲染但被 hidden 挡住」，所以按可见性数。
const roundMembers = (round) => {
  const rows = visible(document.querySelectorAll('.entry-row[data-round="' + String(round) + '"]'));
  const count = (sel) => rows.reduce((n, r) => n + visible(r.querySelectorAll(sel)).length, 0);
  return {
    rows: rows.length,
    stepHeads: count('.step-fold'),
    thinkBlocks: count('.think-block'),
    toolCards: count('.tool-card'),
    bodies: count('.think-body') + count('.tool-body'),
  };
};
/** 同一轮里**不管可见性**的条目构成：诊断用（收起时条目仍在 DOM 里）。 */
const rawMembers = (round) => {
  const rows = Array.from(document.querySelectorAll('.entry-row[data-round="' + String(round) + '"]'));
  const count = (sel) => rows.reduce((n, r) => n + r.querySelectorAll(sel).length, 0);
  return {
    rows: rows.length,
    think: count('.think-block'),
    tools: count('.tool-card'),
    texts: count('.entry-text'),
  };
};
// ── 颜色对比 ──
// 解析出的颜色可能是 `rgb(…)` 也可能是 `color(srgb 0.94 0.95 0.97 / 0.74)`（Chromium 对
// color-mix 的结果就用后者），而且正文色带 alpha——必须先按 alpha 与背景合成，再算相对亮度，
// 否则两个半透明色会算成同一个亮度、对比度都是 1（0.6.6 自检里踩过这一脚）。
const parseColor = (color) => {
  const match = /^(rgba?|color)\((.+)\)$/.exec(color.trim());
  if (match === null) return null;
  const srgb = match[1].toLowerCase() === 'color';
  const body = srgb ? match[2].replace(/^\s*srgb\s+/i, '') : match[2];
  const parts = body.split(/[,/\s]+/).filter((piece) => piece !== '').map(Number);
  if (parts.length < 3 || parts.slice(0, 4).some((n) => !Number.isFinite(n))) return null;
  // color(srgb …) 的分量是 0~1 的浮点数，rgb() 是 0~255，两种都要认（与 appearance.ts 的 toHexColor 同一套口径）
  const to255 = srgb ? (n) => n * 255 : (n) => n;
  return {
    r: to255(parts[0]),
    g: to255(parts[1]),
    b: to255(parts[2]),
    a: parts.length > 3 ? parts[3] : 1,
  };
};
const relativeLuminance = (channel) => {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
};
const luminanceOf = (rgb) => 0.2126 * relativeLuminance(rgb.r) + 0.7152 * relativeLuminance(rgb.g) + 0.0722 * relativeLuminance(rgb.b);
const composite = (foreground, background) => ({
  r: foreground.r * foreground.a + background.r * (1 - foreground.a),
  g: foreground.g * foreground.a + background.g * (1 - foreground.a),
  b: foreground.b * foreground.a + background.b * (1 - foreground.a),
  a: 1,
});
const contrastWith = (foreground, background) => {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (fg === null || bg === null) return null;
  const solid = fg.a >= 1 ? fg : composite(fg, bg);
  const high = Math.max(luminanceOf(solid), luminanceOf(bg));
  const low = Math.min(luminanceOf(solid), luminanceOf(bg));
  return Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100;
};
// 第一个组头 / 第一个思考行的实际配色（深浅两套主题下都直接量真值，不比对令牌名）
const colorProbe = () => {
  const head = document.querySelector('.step-fold-label');
  const think = document.querySelector('.think-label');
  const bg = getComputedStyle(document.body).backgroundColor;
  return {
    theme: document.documentElement.dataset.theme,
    background: bg,
    head: head === null ? null : getComputedStyle(head).color,
    think: think === null ? null : getComputedStyle(think).color,
    headContrast: head === null ? null : contrastWith(getComputedStyle(head).color, bg),
    thinkContrast: think === null ? null : contrastWith(getComputedStyle(think).color, bg),
  };
};
// 读样式表里的规则：真实 :hover 抓不进静态图，所以「hover 底色」这条改成比两条规则声明的令牌一致。
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
const declOf = (selector, property) => {
  const rule = rulesOf().find((r) => r.selectorText === selector);
  if (rule === undefined) return null;
  const m = new RegExp(property + '\\s*:\\s*([^;]+)').exec(rule.style.cssText);
  return m === null ? null : m[1].trim();
};
// 冻结滚动位置：ChatView 看到 entries 变了就会 scrollTop = scrollHeight（自动贴底），
// 那会把自检摆好的视角冲掉——拦住它，拍照那几秒画面才是要取证的那一屏。
const freezeScroll = () => {
  const box = chat();
  if (box === null) return false;
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (desc === undefined || desc.get === undefined || desc.set === undefined) return false;
  const held = { value: desc.get.call(box) };
  window.__stepAllow = false;
  Object.defineProperty(box, 'scrollTop', {
    configurable: true,
    get: () => held.value,
    set: (value) => { if (window.__stepAllow === true) { held.value = value; desc.set.call(box, value); } },
  });
  return true;
};
const allowScroll = () => { window.__stepAllow = true; };
const holdScroll = () => { window.__stepAllow = false; };
/**
 * 比 waitFor 更密的轮询（30ms）：用来抓「只在跑动中显形」的东西——
 * 比如某一轮的阶段组头，那一轮跑完就默认收起、组头当场变 hidden，120ms 的间隔容易擦肩。
 */
const fastWait = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = pred();
    if (value !== null && value !== undefined) return value;
    await wait(30);
  }
  return null;
};
const scrollTo = async (el, offset) => {
  const box = chat();
  for (let pass = 0; pass < 5; pass += 1) {
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top - offset;
    if (Math.abs(delta) < 2) break;
    allowScroll();
    box.scrollTop = Math.round(box.scrollTop + delta);
    await wait(240);
  }
  holdScroll();
  await wait(350);
};
'@

# ── 用例 1：标准档 · 三层显隐 + 组体限高（C1）+ 可访问性（D1 / D2 / D3） ─────────
$stepStaticEval = ($stepHead + @'

(async () => {
  const ready = await waitFor(() => document.querySelectorAll('.entry-user').length >= 4, 30000);
  if (ready === null) return { case: 'step-static', error: '没等到四轮样张上屏' };
  await wait(1500);
  freezeScroll();

  const rounds = document.querySelectorAll('.entry-user').length;
  const collapsed = { toggles: toggles().length, steps: steps().length, round0: roundMembers(0), hiddenRows: hiddenRows().length };
  // D2：收起时内容不再卸载，而是留在 DOM 里带 hidden="until-found"
  const hiddenWhileCollapsed = hiddenRows().length;

  // 展开第 1 轮的整轮总开关：三个阶段组头应当浮出来
  const firstToggle = toggles()[0];
  if (firstToggle === undefined) return { case: 'step-static', error: '第 1 轮没有整轮总开关', collapsed };
  firstToggle.click();
  await wait(800);
  const turnOpen = { steps: steps().length, infos: steps().map(stepInfo), round0: roundMembers(0), hiddenRows: hiddenRows().length };
  // 诊断：整轮展开、组仍收起时，组体到底挂没挂上 hidden、浏览器拿它当什么
  const bodyState = {
    total: document.querySelectorAll('.step-body').length,
    allHidden: Array.from(document.querySelectorAll('.step-body')).every((b) => b.getAttribute('hidden') === 'until-found'),
    allContentHidden: Array.from(document.querySelectorAll('.step-body')).every((b) => getComputedStyle(b).contentVisibility === 'hidden'),
  };

  // 点开第一个阶段组：它自己的成员回来
  const firstStep = steps()[0];
  if (firstStep !== undefined) firstStep.click();
  await wait(900);
  const stepOpen = { infos: steps().map(stepInfo), round0: roundMembers(0) };
  const chevronOnOpen = stepOpen.infos[0] === undefined ? null : { icon: stepOpen.infos[0].iconOpacity, chevron: stepOpen.infos[0].chevronOpacity };

  // ── D1：焦点落在过程区里时，收起不许把它连根拔掉 ──
  // 做法：把焦点放进组体里的一个按钮，再点整轮总开关收起——收起会让那个按钮所在的
  // .entry-row / .step-seat 被挂 hidden，而 useSearchableHidden 看到焦点在里面就撤回这次收起。
  const innerButton = document.querySelector('.step-seat button:not(.step-fold)');
  if (innerButton !== null) innerButton.focus();
  const seatBox = document.querySelector('.step-seat');
  const focusWasInside = seatBox !== null && seatBox.contains(document.activeElement);
  const toggleAgain = toggles()[0];
  if (toggleAgain !== undefined) toggleAgain.click();
  await wait(900);
  const afterGuardSeat = document.querySelector('.step-seat');
  const focusGuard = {
    focusWasInside,
    ariaExpanded: toggleAgain === undefined ? null : toggleAgain.getAttribute('aria-expanded'),
    stepsAfter: steps().length,
    focusStillInside: afterGuardSeat !== null && afterGuardSeat.contains(document.activeElement),
  };

  // 焦点挪开之后再收：这次收得掉——证明上面那次是焦点保护，不是开关坏了
  if (document.activeElement !== null && typeof document.activeElement.blur === 'function') document.activeElement.blur();
  const toggleThird = toggles()[0];
  if (toggleThird !== undefined) toggleThird.click();
  await wait(900);
  const collapseAfterBlur = {
    ariaExpanded: toggleThird === undefined ? null : toggleThird.getAttribute('aria-expanded'),
    steps: steps().length,
    hiddenRows: hiddenRows().length,
  };

  // ── D2：模拟浏览器查找命中（beforematch 冒泡到收起的那一层）→ 它自己展开 ──
  const hiddenList = hiddenRows();
  const hiddenRow = hiddenList.find((row) => row.querySelector('.tool-card') !== null) ?? hiddenList[0];
  const inner = hiddenRow === undefined
    ? null
    : (hiddenRow.querySelector('.tool-card') ?? hiddenRow.querySelector('.think-block') ?? hiddenRow);
  let reveal = { dispatched: false, ariaExpanded: null, stepsAfter: 0, hiddenAfter: 0 };
  if (inner !== null) {
    inner.dispatchEvent(new Event('beforematch', { bubbles: true }));
    await wait(900);
    const head = toggles()[0];
    reveal = {
      dispatched: true,
      ariaExpanded: head === undefined ? null : head.getAttribute('aria-expanded'),
      stepsAfter: steps().length,
      hiddenAfter: hiddenRows().length,
    };
  }

  // ── C1：第 4 轮那一组压着 33 条，展开后组体限高、渐隐、组内独立滚动 ──
  const allToggles = toggles();
  const lastToggle = allToggles[allToggles.length - 1];
  if (lastToggle !== undefined) lastToggle.click();
  await wait(900);
  const tallHead = steps().find((s) => s.dataset.stepGroup === '3:0');
  if (tallHead !== undefined) tallHead.click();
  await wait(1200);
  const tallSeat = tallHead === undefined ? undefined : tallHead.parentElement;
  const tallBody = tallSeat === null || tallSeat === undefined ? null : tallSeat.querySelector('.step-body');
  const tall = tallBody === null ? null : {
    clientHeight: tallBody.clientHeight,
    scrollHeight: tallBody.scrollHeight,
    capped: tallBody.clientHeight <= 400,
    scrollable: tallBody.scrollHeight > tallBody.clientHeight,
    scrollUp: tallBody.dataset.scrollUp ?? null,
    scrollDown: tallBody.dataset.scrollDown ?? null,
    mask: getComputedStyle(tallBody).maskImage || getComputedStyle(tallBody).webkitMaskImage || '',
    members: tallBody.querySelectorAll('.think-block, .tool-card').length,
    closed: tallHead === undefined ? null : tallHead.dataset.stepClosed ?? null,
  };
  // 组内滚动不该动外层 transcript（先把冻结放开，让两边都能读真值）
  const chatBox = chat();
  const outerBefore = chatBox.scrollTop;
  if (tallBody !== null) {
    allowScroll();
    tallBody.scrollTop = 0;
    await wait(500);
    holdScroll();
  }
  const innerScroll = {
    outerBefore,
    outerAfter: chatBox.scrollTop,
    innerTop: tallBody === null ? null : tallBody.scrollTop,
    scrollUpAfter: tallBody === null ? null : (tallBody.dataset.scrollUp ?? null),
  };

  // ── 记一笔：第 4 轮那一组（在计划卡之前）此时已收口 ──
  const lastGroupClosed = tall === null ? null : tall.closed;

  // 收掉第 4 轮，回到第 1 轮摆视角拍图
  if (lastToggle !== undefined) lastToggle.click();
  await wait(600);
  const head1 = toggles()[0];
  if (head1 !== undefined && head1.getAttribute('aria-expanded') === 'false') head1.click();
  await wait(700);
  const step1 = steps()[0];
  if (step1 !== undefined && step1.getAttribute('aria-expanded') === 'false') step1.click();
  await wait(700);
  if (step1 !== undefined) await scrollTo(step1, Math.round(chat().getBoundingClientRect().height * 0.26));

  const labels = turnOpen.infos.map((s) => s.label);
  const colors = colorProbe();
  return {
    case: 'step-static',
    theme: document.documentElement.dataset.theme,
    rounds,
    collapsed,
    turnOpen,
    bodyState,
    stepOpen,
    labels,
    hiddenWhileCollapsed,
    chevronOnOpen,
    focusGuard,
    collapseAfterBlur,
    reveal,
    tall,
    innerScroll,
    lastGroupClosed,
    colors,
    // 三层显隐
    stepsHiddenWithTurn: collapsed.steps === 0,
    threeStepsOnOpen: turnOpen.steps === 3,
    stepsDefaultCollapsed: turnOpen.infos.length === 3 && turnOpen.infos.every((s) => s.ariaExpanded === 'false'),
    membersHiddenWhenGroupClosed: turnOpen.round0.thinkBlocks === 0 && turnOpen.round0.toolCards === 0,
    reopenedFirstGroup: stepOpen.round0.thinkBlocks === 1 && stepOpen.round0.toolCards === 2,
    firstGroupOpen: stepOpen.infos[0] !== undefined && stepOpen.infos[0].ariaExpanded === 'true',
    othersStayClosed: stepOpen.infos.length === 3 && stepOpen.infos.slice(1).every((s) => s.ariaExpanded === 'false'),
    // 文案照 dsh 的类别聚合规则
    labelMatchesDsh: labels.length === 3 &&
      labels[0] === '已搜索代码并读取文件' && labels[1] === '执行了命令' && labels[2] === '修改了文件并已写入文件',
    // 组头带类别 / 次数 / 组号钩子（自检与调试用）
    headHooksOk: turnOpen.infos.every((s) => s.activity !== null && s.counts !== null && s.group !== null),
    firstHeadCounts: turnOpen.infos[0] === undefined ? null : turnOpen.infos[0].counts,
    // 展开后箭头转 180°
    chevronRotates: stepOpen.infos[0] !== undefined && turnOpen.infos[0] !== undefined &&
      stepOpen.infos[0].chevronTransform !== turnOpen.infos[0].chevronTransform,
    // C2：展开时图标让位给箭头（叠放切换）
    expandedSwapsIconForChevron: chevronOnOpen !== null && chevronOnOpen.chevron === '1' && chevronOnOpen.icon === '0',
    // 样式：组头标题色比思考行亮一档（两级折叠靠颜色分层）
    labelColor: declOf('.step-fold-label', 'color'),
    thinkLabelColor: declOf('.think-label', 'color'),
    // 行高一致：组头与思考行、整轮开关同档
    rowHeights: { step: turnOpen.infos[0] === undefined ? null : turnOpen.infos[0].box.h, think: blocks().length === 0 ? null : shape(blocks()[0]).h },
    // D1：焦点在过程区里时收起被撤回；焦点挪开后收得掉
    focusGuardWorks: focusGuard.focusWasInside && focusGuard.ariaExpanded === 'true' && focusGuard.focusStillInside,
    collapseAfterBlurWorks: collapseAfterBlur.ariaExpanded === 'false' && collapseAfterBlur.steps === 0,
    // D2：收起的内容留在 DOM 里，且 beforematch 能把被命中的那一层放出来
    hiddenWhileCollapsedLooksRight: hiddenWhileCollapsed > 0,
    beforematchReveals: reveal.dispatched && reveal.ariaExpanded === 'true' && reveal.hiddenAfter === 0,
    // C1：限高、渐隐、组内滚动各管各的
    tallGroupCapped: tall !== null && tall.capped && tall.scrollable && tall.members >= 30,
    tallGroupFaded: tall !== null && tall.mask.indexOf('linear-gradient') >= 0,
    tallGroupScrollEdge: tall !== null && (tall.scrollUp !== null || tall.scrollDown !== null),
    innerScrollIsInnerOnly: innerScroll.outerBefore === innerScroll.outerAfter && innerScroll.innerTop === 0,
    // 第 4 轮那一组（计划卡前面那一组）已收口：计划卡因此是「成界」的那一刀
    lastGroupClosedBefore: lastGroupClosed === '1',
    // E1：组头比思考行醒目（与主题无关的对比度判据）
    headMoreProminent: colors.headContrast !== null && colors.thinkContrast !== null && colors.headContrast > colors.thinkContrast,
  };
})()
'@)

# ── 用例 2：标准档 · 实时一轮（A1 组头实时详情 + A2 标题防抖） ────────────────────
$stepLiveEval = ($stepHead + @'

(async () => {
  const base = await waitFor(() => document.querySelectorAll('.entry-user').length >= 1, 30000);
  if (base === null) return { case: 'step-live', error: '没等到实时样张的会话' };
  await wait(1200);
  freezeScroll();

  await window.dsc.invoke('submit', ['把阶段分组那处改动再确认一遍。', undefined]);

  // 跑动中：组头已经出现，而且这一组是**收起**的——那一刻「在干什么」由组头的实时详情承载
  // 谓词等到「组头带非空详情行」为止：详情只在思考直播的那几百毫秒里存在，早一拍抓到的是
  // 还没填详情的组头、晚一拍抓到的是已收口的（detailLine 为 null），两种都重试下一轮
  const during = await waitFor(() => {
    if (document.querySelector('.think-block[data-state="running"]') === null) return null;
    const lastRound = document.querySelectorAll('.entry-user').length - 1;
    const heads = steps();
    const infos = heads.map(stepInfo);
    if (!infos.some((s) => s.detailLine !== null && s.detailLine.text !== '')) return null;
    return { lastRound, stepCount: heads.length, infos, round: roundMembers(lastRound) };
  }, 30000);

  // A2：直播期间高频采样组头文案（每 60ms 一次，比 150ms 的最短保留还密）。
  // 三种样本不算「标题在抖」：
  //   · 组头还没出现（label 为 null）；
  //   · 这一组已经收口——定稿的组头改走聚合文案，本来就不参与防抖（见 StepGroupRow）；
  //   · 采到的已经是另一个组了（尾组被正文封口、新组冒出来），那是换了一行，不是同一行在跳。
  const sampleOf = () => {
    const head = steps()[0];
    if (head === undefined) return { at: Date.now(), group: null, closed: null, label: null };
    return {
      at: Date.now(),
      group: head.dataset.stepGroup ?? null,
      closed: head.dataset.stepClosed ?? null,
      label: head.querySelector('.step-fold-label') === null ? null : head.querySelector('.step-fold-label').textContent.trim(),
    };
  };
  const samples = [];
  const until = Date.now() + 1600;
  while (Date.now() < until) {
    samples.push(sampleOf());
    await wait(60);
  }
  const gaps = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous.label === null || current.label === null) continue;
    if (previous.closed === '1' || current.closed === '1') continue;
    if (previous.group !== current.group) continue;
    if (previous.label !== current.label) gaps.push(current.at - previous.at);
  }
  const liveTitle = {
    samples: samples.length,
    changes: gaps.length,
    minGap: gaps.length === 0 ? null : Math.min.apply(null, gaps),
    labels: Array.from(new Set(samples.map((s) => s.label))),
  };

  // 收尾：这一轮定稿后组头改成聚合文案，且默认收起
  const settled = await waitFor(() => document.querySelector('.turn-status') === null && toggles().length > 0, 40000);
  await wait(1200);
  const lastToggle = toggles()[toggles().length - 1];
  const after = {
    stepCount: steps().length,
    infos: steps().map(stepInfo),
    round: roundMembers(document.querySelectorAll('.entry-user').length - 1),
    toggle: lastToggle === undefined ? null : { ariaExpanded: lastToggle.getAttribute('aria-expanded') },
  };

  // 展开刚定稿的这一轮：组头回来，且各自仍是收起态
  if (lastToggle !== undefined) lastToggle.click();
  await wait(900);
  const reopened = { stepCount: steps().length, infos: steps().map(stepInfo) };
  if (lastToggle !== undefined) {
    const head = steps()[0];
    if (head !== undefined) await scrollTo(head, Math.round(chat().getBoundingClientRect().height * 0.3));
  }

  return {
    case: 'step-live',
    theme: document.documentElement.dataset.theme,
    // 会话容器横向溢出的量化：0.6.46 报障的本质是旧布局把它撑出横向滚动
    chatScroll: { sw: chat().scrollWidth, cw: chat().clientWidth },
    during,
    after,
    reopened,
    liveTitle,
    settled: settled !== null,
    // A1：跑动中组头在，且这一组收起（组员不在 DOM 里）
    liveGroupHeadsShown: during !== null && during.stepCount >= 1,
    liveGroupCollapsed: during !== null && during.infos.every((s) => s.ariaExpanded === 'false') && during.round.thinkBlocks === 0,
    // A1：组头带实时详情（0.6.46 起详情在标题下一行，label 本体是纯类别文案）
    liveTitleUsesRunningWords: during !== null && during.infos.some((s) => s.label.indexOf('正在') === 0),
    liveTitleHasDetail: during !== null && during.infos.some((s) => s.detailLine !== null && s.detailLine.text !== ''),
    // 详情真的换行了：详情行与标题行的纵向距离超过行高的两成（同一行会是 0）
    liveDetailOnOwnLine: during !== null && during.infos.some((s) =>
      s.detailLine !== null && s.detailLine.text !== '' && s.labelTop !== null &&
      s.detailLine.top - s.labelTop >= 12),
    // 详情截在组头宽度里（详情行右缘不出组头，盒键名是 l/r/t/b）；会话容器没有横向溢出
    // （0.6.46 报障的本质就是旧布局把 .chat 撑出横向滚动）——溢出用 scrollWidth 口径判
    liveDetailContained: during !== null && during.infos.some((s) =>
      s.detailLine !== null && s.detailLine.text !== '' &&
      s.detailLine.right <= s.box.r + 1) &&
      chat().scrollWidth <= chat().clientWidth,
    // 长详情确实被截（scrollWidth > clientWidth）——假端点的超长思考填充保证了这条可判
    liveDetailClipped: during !== null && during.infos.some((s) =>
      s.detailLine !== null && s.detailLine.text !== '' && s.detailLine.clipped === true),
    // 批 3：跑动中的组头带扫光挂点（收口的组不该有）
    liveHeadShimmers: during !== null && during.infos.some((s) => s.shimmer !== null && s.shimmer !== ''),
    liveDetailHookPresent: during !== null && during.infos.some((s) => s.detail !== null && s.detail !== ''),
    // A2：采样期间没有短于 150ms 的抖动（采集间隔 60ms，抖动会立刻显形）
    liveTitleHoldsLongEnough: liveTitle.minGap === null || liveTitle.minGap >= 120,
    // 定稿后：这一轮的两级折叠一起复位——整轮收起，组头跟着整轮一起退场（三层显隐从外向内）
    settledHidesMembers: after.round.thinkBlocks === 0,
    settledHidesGroupHeadsWithTurn: after.stepCount === 0,
    // 整轮总开关也是收起态
    roundToggleClosedAfter: after.toggle !== null && after.toggle.ariaExpanded === 'false',
    // 展开刚定稿的这一轮：两个组头回来，默认全是收起态，文案已换成聚合
    reopenedAllHeads: reopened.stepCount === 2,
    settledGroupsClosed: reopened.infos.length === 2 && reopened.infos.every((s) => s.ariaExpanded === 'false'),
    settledTitleIsAggregate: reopened.infos.length === 2 &&
      reopened.infos.every((s) => s.label === '已完成分析' || s.label === '已读取文件'),
    settledLabels: reopened.infos.map((s) => s.label),
  };
})()
'@)

# ── 用例 3：详细档 · 正在跑的那一轮直接摊开，只有历史轮分组（B1） ────────────────
$stepDetailedEval = ($stepHead + @'

(async () => {
  const base = await waitFor(() => document.querySelectorAll('.entry-user').length >= 1, 30000);
  if (base === null) return { case: 'step-detailed', error: '没等到实时样张的会话' };
  await wait(1200);
  freezeScroll();
  /** 提交前那几轮（全是历史轮）已有的整轮总开关数量：跑动中那一轮不该再多出一个。 */
  const togglesBefore = toggles().length;

  await window.dsc.invoke('submit', ['把阶段分组那处改动再确认一遍。', undefined]);

  // 详细档：整轮照旧折叠，但正在跑的那一轮**不分组**——组头一个都不画，过程条目直接摊开
  const during = await waitFor(() => {
    if (document.querySelector('.think-block[data-state="running"]') === null) return null;
    const lastRound = document.querySelectorAll('.entry-user').length - 1;
    return { lastRound, stepCount: steps().length, toggles: toggles().length, round: roundMembers(lastRound) };
  }, 30000);

  // 收尾后：这一轮成了历史轮，于是它也有组头了
  const settled = await waitFor(() => document.querySelector('.turn-status') === null && toggles().length >= 2, 40000);
  await wait(1200);
  const lastToggle = toggles()[toggles().length - 1];
  const after = {
    toggles: toggles().length,
    steps: steps().length,
    round: roundMembers(document.querySelectorAll('.entry-user').length - 1),
  };
  if (lastToggle !== undefined) lastToggle.click();
  await wait(900);
  const reopened = { steps: steps().length, infos: steps().map(stepInfo) };
  if (lastToggle !== undefined) {
    const head = steps()[0];
    if (head !== undefined) await scrollTo(head, Math.round(chat().getBoundingClientRect().height * 0.3));
  }

  return {
    case: 'step-detailed',
    theme: document.documentElement.dataset.theme,
    fold: 'detailed',
    during,
    togglesBefore,
    after,
    reopened,
    settled: settled !== null,
    // 详细档的关键差异：跑动中那一轮不分组（标准档这时会画一个收起的组头）
    runningRoundUngrouped: during !== null && during.stepCount === 0,
    runningRoundMembersVisible: during !== null && during.round.thinkBlocks >= 1,
    // 跑动中那一轮连总开关都不画：开关数量与提交前一致（历史轮那些本来就在）
    runningRoundNoToggle: during !== null && during.toggles === togglesBefore,
    // 定稿后两轮都有总开关，展开刚定稿的那一轮能看到组头
    settledHasTurnToggles: after.toggles >= 2,
    reopenedHeadsAppear: reopened.steps >= 1,
    reopenedLabels: reopened.infos.map((s) => s.label),
  };
})()
'@)

# ── 用例 4：完全展开档 · 不做整轮折叠、阶段也不分组，过程条目逐条摊开（B1） ──────
$stepVerboseEval = ($stepHead + @'

(async () => {
  const ready = await waitFor(() => document.querySelectorAll('.entry-user').length >= 4, 30000);
  if (ready === null) return { case: 'step-verbose', error: '没等到四轮样张上屏' };
  await wait(1500);
  freezeScroll();
  const state = {
    toggles: toggles().length,
    steps: steps().length,
    thinkBlocks: blocks().length,
    toolCards: cards().length,
    round0: roundMembers(0),
    round3: roundMembers(3),
    hiddenRows: hiddenRows().length,
  };
  return {
    case: 'step-verbose',
    theme: document.documentElement.dataset.theme,
    fold: 'verbose',
    state,
    // 完全展开档：整轮折叠关掉，于是既没有总开关，也没有阶段组头，过程条目直接摊开
    noTurnToggles: state.toggles === 0,
    noStepHeads: state.steps === 0,
    membersVisible: state.round0.thinkBlocks >= 1 && state.round0.toolCards >= 1,
    // 每一轮都摊着（含压着 32 条调用的第 4 轮）
    allRoundsVisible: [0, 1, 2, 3].every((index) => roundMembers(index).rows > 0),
    record: document.getElementById('record-a') === null ? null : 'x',
  };
})()
'@)

# ── 用例 5：浅色主题 · 组头与思考行的分层仍成立（E1） ────────────────────────────
$stepLightEval = ($stepHead + @'

(async () => {
  const ready = await waitFor(() => document.querySelectorAll('.entry-user').length >= 4, 30000);
  if (ready === null) return { case: 'step-light', error: '没等到四轮样张上屏' };
  await wait(1500);
  freezeScroll();
  const firstToggle = toggles()[0];
  if (firstToggle !== undefined) firstToggle.click();
  await wait(900);
  const step1 = steps()[0];
  if (step1 !== undefined) step1.click();
  await wait(900);
  const colors = colorProbe();
  if (step1 !== undefined) await scrollTo(step1, Math.round(chat().getBoundingClientRect().height * 0.26));
  return {
    case: 'step-light',
    theme: document.documentElement.dataset.theme,
    fold: 'standard',
    steps: steps().length,
    infos: steps().map(stepInfo),
    colors,
    stepsVisible: steps().length === 3,
    // E1：浅色下「组头比思考行醒目」仍成立（用与背景的对比度比，不写死谁更亮）
    headMoreProminent: colors.headContrast !== null && colors.thinkContrast !== null && colors.headContrast > colors.thinkContrast,
    labelColor: declOf('.step-fold-label', 'color'),
    thinkLabelColor: declOf('.think-label', 'color'),
  };
})()
'@)

# ── 用例 6：计划卡成界（D3）：封掉前面的组、自己不进组 ───────────────────────────
$stepPlanEval = ($stepHead + @'

(async () => {
  const ready = await waitFor(() => document.querySelectorAll('.entry-user').length >= 4, 30000);
  if (ready === null) return { case: 'step-plan', error: '没等到四轮样张上屏' };
  await wait(1200);
  // 启动恢复那条路**不发 dsc/session-open**（host/kernel.ts:363-366 只把历史重放成条目），
  // 而计划卡是 plan 插件在 dsc/session-open 时 emit 回会话流的（src/plugins/plan.ts:114-121）。
  // 所以这里重新打开一次同一条会话，走真正的「切会话」路径——重复打开同一条时 transcript 插件
  // 会因「重放结果没变」而跳过重建（src/plugins/transcript.ts:68-71），条目不会抖。
  await window.dsc.invoke('openSession', [__STATIC_SESSION__]);
  const planReady = await waitFor(() => document.querySelectorAll('.plan-card').length >= 1, 20000);
  if (planReady === null) return { case: 'step-plan', error: '重新打开会话后仍然没有计划卡' };
  await wait(1500);
  freezeScroll();
  // 展开最后一轮（计划卡前面那一轮）的整轮总开关，让它的组头浮出来
  const all = toggles();
  const last = all[all.length - 1];
  if (last !== undefined) last.click();
  await wait(1000);
  const head = steps().find((s) => s.dataset.stepGroup === '3:0');
  const plan = planCards()[0];
  const info = {
    stepCount: steps().length,
    labels: steps().map((s) => s.querySelector('.step-fold-label').textContent.trim()),
    groupClosed: head === undefined ? null : head.dataset.stepClosed ?? null,
    planInStepBody: plan === undefined ? null : plan.closest('.step-body') !== null,
    planInStepSeat: plan === undefined ? null : plan.closest('.step-seat') !== null,
    planInEntryRow: plan === undefined ? null : plan.closest('.entry-row') !== null,
    planTitle: plan === undefined ? null : plan.querySelector('.plan-title').textContent.trim(),
    planVerdict: plan === undefined ? null : plan.querySelector('.plan-verdict').textContent.trim(),
  };
  if (plan !== undefined) await scrollTo(plan, Math.round(chat().getBoundingClientRect().height * 0.32));
  return {
    case: 'step-plan',
    theme: document.documentElement.dataset.theme,
    info,
    // 计划卡封掉了前面的组（那一组已收口），自己不在任何组体里
    groupClosedBeforePlan: info.groupClosed === '1',
    planOutsideGroups: info.planInStepBody === false && info.planInStepSeat === false && info.planInEntryRow === true,
    planCardVisible: info.planTitle !== null && info.planTitle !== '',
  };
})()
'@)

# ── 用例 7：轮中途插话 / 中断 / 组收口不重置阅读位置（与 dsh 对齐的三条硬规矩） ──
$stepControlEval = ($stepHead + @'

(async () => {
  /** 走到哪一步了：万一被下面的兜底掐断，返回里带上它就一眼看得出卡在哪。 */
  const stage = { at: 'boot' };
  const main = (async () => {
  const base = await waitFor(() => document.querySelectorAll('.entry-user').length >= 1, 15000);
  if (base === null) return { error: '没等到实时样张的会话' };
  await wait(1200);
  freezeScroll();

  /** 每条用户消息所在行的 data-round：两条消息轮号相同就说明它们属于同一轮。 */
  const userRowRounds = () => Array.from(document.querySelectorAll('.entry-row'))
    .filter((row) => row.querySelector('.entry-user') !== null)
    .map((row) => row.dataset.round ?? null);
  /**
   * 某一轮现在「整轮没被收起」吗——判据是**它的组头看得见**。
   *
   * 为什么不用「组员看得见」：组的默认态本来就是收起（0.6.7 起，与 dsh 一致），
   * 组员不可见是正常的。整轮收起时连组头都不画，所以组头可见 = 整轮展开。
   */
  const roundHeadsVisible = (round) => steps()
    .filter((head) => (head.dataset.stepGroup ?? '').indexOf(String(round) + ':') === 0).length;

  // ── A) 轮中途插话：两条用户消息必须落在同一轮，且这一轮不给整轮折叠 ──
  stage.at = 'A-steer';
  await window.dsc.invoke('submit', ['先跑第一件事。', undefined]);
  await wait(260);
  await window.dsc.invoke('submit', ['顺便说一句：那边也要看。', undefined]);
  const steerSettled = await waitFor(
    () => document.querySelector('.turn-status') === null && toggles().length >= 2,
    15000,
  );
  await wait(1000);
  const steerToggle = toggles()[toggles().length - 1];
  const steerRound = userRowRounds().slice(-2);
  const steer = {
    settled: steerSettled !== null,
    lastTwoRounds: steerRound,
    sameRound: steerRound.length === 2 && steerRound[0] === steerRound[1],
    toggleLabel: steerToggle === undefined ? null : steerToggle.textContent.trim(),
    toggleBlocked: steerToggle === undefined ? null : steerToggle.dataset.turnBlocked ?? null,
    toggleDisabled: steerToggle === undefined ? null : steerToggle.disabled,
    roundMembers: roundMembers(Number(steerRound[0] ?? -1)),
    headsVisible: roundHeadsVisible(Number(steerRound[0] ?? -1)),
  };

  // ── B) 组收口时阅读位置不被重置（这一轮会调二十几个工具，组体必然超过限高） ──
  // 这一段的可抓窗口很短（组头只在跑动中显形），所以用 fastWait，而且**不滤可见性**：
  // 那一轮跑完就默认收起，组头和组体当场变 hidden，但 DOM 元素还在——要的是元素本身。
  stage.at = 'B-scroll';
  const beforeTall = Number(userRowRounds().slice(-1)[0] ?? -1);
  await window.dsc.invoke('submit', ['再跑一件会调很多工具的事。', undefined]);
  const tall = await fastWait(() => {
    const rows = userRowRounds();
    const round = Number(rows[rows.length - 1] ?? -1);
    if (round <= beforeTall) return null;
    const heads = Array.from(document.querySelectorAll('.step-fold'))
      .filter((head) => (head.dataset.stepGroup ?? '').indexOf(String(round) + ':') === 0);
    // 这一轮有两个组：思考那组（被正文封口）+ 压着二十几个工具那组
    return heads.length >= 2 ? { round, head: heads[1] } : null;
  }, 20000);
  let tallBox = null;
  if (tall !== null) {
    // 这一轮要是已经收尾（整轮收起），先把整轮展开，再展开压着工具的那一组
    const flip = Array.from(document.querySelectorAll('.turn-fold'))
      .find((item) => item.dataset.roundIndex === String(tall.round));
    if (flip !== undefined && flip.getAttribute('aria-expanded') === 'false') {
      flip.click();
      await wait(400);
    }
    if (tall.head.getAttribute('aria-expanded') === 'false') tall.head.click();
    tallBox = await fastWait(() => {
      const seat = tall.head.parentElement;
      const box = seat === null ? null : seat.querySelector('.step-body');
      if (box === null) return null;
      return box.scrollHeight > box.clientHeight + 8 ? box : null;
    }, 15000);
  }
  const probe = tall === null
    ? {
        tallFound: false,
        beforeTall,
        // 诊断：此刻界面上有哪些组（组号 + 文案 + 类别次数）、哪几条用户消息、轮 2 的构成
        groups: Array.from(document.querySelectorAll('.step-fold')).map((head) => ({
          group: head.dataset.stepGroup ?? '?',
          label: head.textContent.trim(),
          counts: head.dataset.stepCounts ?? '',
        })),
        rounds: userRowRounds(),
        raw: rawMembers(2),
        statusPresent: document.querySelector('.turn-status') !== null,
      }
    : {
        tallFound: true,
        round: tall.round,
        label: tall.head.textContent.trim(),
        closed: tall.head.dataset.stepClosed ?? null,
        clientHeight: tallBox === null ? null : tallBox.clientHeight,
        scrollHeight: tallBox === null ? null : tallBox.scrollHeight,
      };
  const scroll = { scrollable: tallBox !== null, before: null, after: null, held: null, probe };
  if (tallBox !== null) {
    // 滚到中间：这一步同时会把这一组自己的「跟随」关掉（离底超出贴底档）
    tallBox.scrollTop = 60;
    await wait(400);
    scroll.before = tallBox.scrollTop;
    // 等**这一组收口**（而不是等这一轮结束）：中间那一跳的正文到达就把它封掉，
    // 而那一跳还带了一个工具，所以此刻这一轮仍在跑——两个时刻是分开的，
    // 测的才是「组收口不重置阅读位置」，而不是「轮收尾复位组内开合」。
    await waitFor(() => tall.head.dataset.stepClosed === '1', 25000);
    await wait(700);
    scroll.after = tallBox.scrollTop;
    scroll.held = tallBox.scrollTop === scroll.before;
    scroll.turnStillRunning = document.querySelector('.turn-status') !== null;
  }

  // ── C) 中断：这一轮不能折，且开关行报「已停止」──
  stage.at = 'C-abort';
  // 先等上一段那一轮跑完。不等的话这次提交会被当成它的轮中途插话（steering），
  // 于是根本没有「新一轮」可打断——自检里表现为「轮号没前进、interrupt 扑空」。
  await waitFor(() => document.querySelector('.turn-status') === null, 20000);
  await wait(400);
  const beforeAbort = Number(userRowRounds().slice(-1)[0] ?? -1);
  await window.dsc.invoke('submit', ['再跑一件事，然后打断它。', undefined]);
  const advanced = await waitFor(
    () => Number(userRowRounds().slice(-1)[0] ?? -1) > beforeAbort,
    8000,
  );
  const roundAdvanced = advanced !== null;
  stage.at = 'C-interrupt';
  await wait(350);
  let interruptError = null;
  try {
    await window.dsc.invoke('interrupt', []);
  } catch (error) {
    interruptError = String(error);
  }
  const statusRightAfter = document.querySelector('.turn-status') !== null;
  const stopped = await waitFor(() => {
    const head = toggles()[toggles().length - 1];
    return head !== undefined && head.textContent.trim() === '已停止' ? head : null;
  }, 12000);
  await wait(800);
  // 诊断：把中断后所有总开关的样子都记下来（万一没出现「已停止」，一眼看得出实际是什么）
  const toggleSnapshot = toggles().map((item) => ({
    label: item.textContent.trim(),
    disabled: item.disabled,
    blocked: item.dataset.turnBlocked ?? null,
  }));
  const abort = {
    found: stopped !== null,
    label: stopped === null ? null : stopped.textContent.trim(),
    disabled: stopped === null ? null : stopped.disabled,
    dataBlocked: stopped === null ? null : stopped.dataset.turnBlocked ?? null,
    roundMembers: roundMembers(Number(userRowRounds().slice(-1)[0] ?? -1)),
    headsVisible: roundHeadsVisible(Number(userRowRounds().slice(-1)[0] ?? -1)),
    roundAdvanced,
    toggleSnapshot,
    statusPresent: document.querySelector('.turn-status') !== null,
    interruptError,
    statusRightAfter,
  };

  if (stopped !== null) await scrollTo(stopped, Math.round(chat().getBoundingClientRect().height * 0.35));
  stage.at = 'done';
  return { steer, scroll, abort };
  })();

  // 兜底：自检脚本自己跑飞时也要把结果交回来。否则截图先到、日志里一个字都留不下，
  // 只能靠猜卡在哪一步。48 秒是截图预算（62 秒）减去几段正常耗时之后留的余量。
  const done = await Promise.race([
    main,
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, 55000);
    }),
  ]);
  if (done === null) return { case: 'step-control', stage: stage.at, error: '预跑脚本超时（48 秒兜底）' };
  if (done.error !== undefined) return { case: 'step-control', stage: stage.at, error: done.error };
  const { steer, scroll, abort } = done;

  return {
    case: 'step-control',
    stage: stage.at,
    theme: document.documentElement.dataset.theme,
    steer,
    scroll,
    abort,
    // A) 插话不另起一轮，且这一轮不给整轮折叠（对照 dsh 的 hasInterleavedInput）
    steeringStaysInTurn: steer.sameRound && steer.settled,
    steeringBlocksFold: steer.toggleBlocked === '1' && steer.toggleDisabled === true,
    // 整轮没被收起：判据是它的组头还看得见（组的默认态本来就收起，组员看不见是正常的）
    steeringKeepsProcessOpen: steer.headsVisible >= 1,
    // B) 组收口时不重置阅读位置（dsh 的 conversation-nodes/README.zh.md:170），
    //    且收口那一刻这一轮确实还在跑（否则测到的是轮收尾的复位）
    scrollKeptOnClose: scroll.scrollable && scroll.held && scroll.turnStillRunning === true,
    // C) 中断的轮报「已停止」、不可折、过程保持展开（dsh 的 turnProcessAlwaysOpen）
    abortedShowsStopped: abort.found && abort.label === '已停止',
    abortedBlocksFold: abort.dataBlocked === '1' && abort.disabled === true,
    abortedKeepsProcessOpen: abort.headsVisible >= 1,
  };
})()
'@)


# ── 用例 8：「准备中」态与「模型重试行」（批 2，两个都只在流式期间出现） ─────────
$stepPrepareEval = ($stepHead + @'

(async () => {
  const stage = { at: 'boot' };
  const main = (async () => {
  const base = await waitFor(() => document.querySelectorAll('.entry-user').length >= 1, 15000);
  if (base === null) return { error: '没等到实时样张的会话' };
  await wait(1200);
  freezeScroll();

  // ── A) 准备中：模型刚吐了工具名、参数还没到齐的那一瞬间 ──
  // 假端点为这一段停了 2.2 秒（FOLD_FAKE_PREPARE_MS），不然它转瞬即逝抓不到。
  stage.at = 'A-prepare';
  await window.dsc.invoke('submit', ['准备一下再动手。', undefined]);
  const preparing = await fastWait(() => document.querySelector('.tool-card.status-preparing'), 25000);
  // 抓到的那一刻先把工具卡自己的样子记下来：下面还要等组头，期间这张卡可能已经升级成「进行中」
  const card = preparing === null ? null : {
    cardStatus: preparing.querySelector('.status') === null ? null : preparing.querySelector('.status').textContent.trim(),
    cardName: preparing.querySelector('.name') === null ? null : preparing.querySelector('.name').textContent.trim(),
    cardTooltip: preparing.querySelector('.tool-head') === null ? null : preparing.querySelector('.tool-head').dataset.tip ?? null,
    hasChevron: preparing.querySelector('.tc-chevron') !== null,
    hasBody: preparing.querySelector('.tool-body') !== null,
    preppedCount: document.querySelectorAll('.tool-card.status-preparing').length,
  };
  // 组头标题有 150ms 最短保留（上一步那套防抖）：刚抓到「准备中」时它多半还停在上一句，
  // 等它落定再读——这一段等待本身就是那条规矩在起作用，不是组头没跟上。
  if (card !== null) await wait(450);
  const plan = card === null ? null : {
    ...card,
    // 诊断：把此刻所有组头的文案与钩子都记下来（万一不是「准备…」，一眼看得出实际是什么）
    heads: Array.from(document.querySelectorAll('.step-fold')).map((item) => ({
      label: item.textContent.trim(),
      activity: item.dataset.stepActivity ?? null,
      counts: item.dataset.stepCounts ?? null,
      detail: item.dataset.stepDetail ?? null,
      closed: item.dataset.stepClosed ?? null,
    })),
    preparingCardNow: document.querySelectorAll('.tool-card.status-preparing').length,
    // 诊断：这一轮到底「还在跑」吗——状态行在不在、有几个整轮开关、几条用户消息
    statusPresent: document.querySelector('.turn-status') !== null,
    roundToggles: Array.from(document.querySelectorAll('.turn-fold')).map((item) => item.textContent.trim()),
    entryUsers: document.querySelectorAll('.entry-user').length,
    groupIds: Array.from(document.querySelectorAll('.step-fold')).map((item) => item.dataset.stepGroup ?? '?'),
    // 诊断：这一轮的条目在 DOM 里的真实先后（正文到底在工具之前还是之后）
    round1Order: Array.from(document.querySelectorAll('.entry-row[data-round="1"]')).map((row) => {
      if (row.querySelector('.entry-user') !== null) return 'user';
      if (row.querySelector('.step-fold') !== null) return 'head';
      if (row.querySelector('.tool-card') !== null) return `tool:${row.querySelector('.tool-card').className.replace('entry tool-card ', '')}`;
      if (row.querySelector('.think-block') !== null) return 'think';
      if (row.querySelector('.entry-text') !== null) {
        return row.querySelector('.entry-text').classList.contains('live') ? 'text-live' : 'text';
      }
      const notice = row.querySelector('[data-turn-notice]');
      return notice === null ? 'other' : `notice:${notice.dataset.turnNotice}`;
    }),
    headLabel: (() => {
      const head = Array.from(document.querySelectorAll('.step-fold'))
        .find((item) => item.textContent.trim().indexOf('准备') === 0);
      return head === undefined ? null : head.textContent.trim();
    })(),
  };

  // ── B) 等这一轮结束：假端点头一次故意 500，所以这里该出现一条「模型重试行」 ──
  stage.at = 'B-retry';
  const settled = await waitFor(
    () => document.querySelector('.turn-status') === null && toggles().length > 0,
    45000,
  );
  await wait(1200);
  const notice = document.querySelector('[data-turn-notice="model-retry"]');
  const retry = {
    settled: settled !== null,
    noticeText: notice === null ? null : notice.textContent.trim(),
    // 轮末应该把没等到升级的「准备中」清掉（这条用例里它们都升级了，数量应为 0）
    preparingLeft: document.querySelectorAll('.tool-card.status-preparing').length,
    statuses: Array.from(document.querySelectorAll('.tool-card')).map((card) => {
      const status = card.querySelector('.status');
      return status === null ? '' : status.textContent.trim();
    }),
  };
  stage.at = 'done';
  return { plan, retry };
  })();

  const done = await Promise.race([
    main,
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, 55000);
    }),
  ]);
  if (done === null) return { case: 'step-prepare', stage: stage.at, error: '预跑脚本超时（55 秒兜底）' };
  if (done.error !== undefined) return { case: 'step-prepare', stage: stage.at, error: done.error };
  const { plan, retry } = done;

  return {
    case: 'step-prepare',
    stage: stage.at,
    theme: document.documentElement.dataset.theme,
    plan,
    retry,
    // A) 准备中那一行：状态是「准备中」、右侧没有箭头、也没有展开区（参数此刻本来就不全）
    preparingShown: plan !== null,
    preparingCardStatus: plan === null ? null : plan.cardStatus,
    preparingNotExpandable: plan !== null && plan.hasChevron === false && plan.hasBody === false,
    preparingHeadSaysPrepare: plan !== null && plan.headLabel !== null && plan.headLabel.indexOf('准备') === 0,
    // B) 重试那一行 + 重试之后这一轮正常跑完
    retryNoticeShown: retry.noticeText !== null && retry.noticeText.indexOf('正在重试') >= 0,
    retryRoundCompleted: retry.settled,
    preparingCleared: retry.preparingLeft === 0,
  };
})()
'@)

# ── 用例 9：加载更早（渐进渲染）＋ 分页锚定不动 ＋ 保留组级开合 ──────────────────
$stepPagingEval = ($stepHead + @'

(async () => {
  const stage = { at: 'boot' };
  const main = (async () => {
  const ready = await waitFor(() => document.querySelectorAll('.entry-user').length >= 1, 20000);
  if (ready === null) return { error: '没等到分页样张上屏' };
  await wait(1200);

  stage.at = 'A-initial';
  const before = {
    userRows: document.querySelectorAll('.entry-user').length,
    earlier: (() => {
      const button = document.querySelector('.chat-earlier');
      return button === null
        ? null
        : { label: button.textContent.trim(), rounds: button.dataset.earlierRounds ?? null };
    })(),
  };

  // 展开最后一轮的整轮开关：验「加载更早之后，用户手动展开的还开着」
  const lastToggle = toggles()[toggles().length - 1];
  if (lastToggle !== undefined) lastToggle.click();
  await wait(500);
  const openedRound = lastToggle === undefined ? null : lastToggle.dataset.roundIndex ?? null;
  const openedBefore = lastToggle === undefined ? null : lastToggle.getAttribute('aria-expanded');

  // 把视角往下摆一点：锚点位于「会被推动」的位置，锚定断言才有意义
  const scrollerEl = chat();
  allowScroll();
  scrollerEl.scrollTop = Math.round(scrollerEl.scrollHeight * 0.3);
  await wait(300);
  holdScroll();

  stage.at = 'B-load';
  const button = document.querySelector('.chat-earlier');
  let anchorInfo = null;
  if (button !== null) {
    // 锚点按正文顺序取按钮之后第一个有高度的兄弟（与 ChatView 的 loadEarlier 同一套规则）
    let anchor = button.nextElementSibling;
    while (anchor !== null && anchor.getBoundingClientRect().height === 0) anchor = anchor.nextElementSibling;
    if (anchor !== null) {
      const topBefore = anchor.getBoundingClientRect().top;
      const scrollBefore = scrollerEl.scrollTop;
      // 分页补偿要写外层 scrollTop，冻结态下会被拦掉，所以这一步放开
      allowScroll();
      button.click();
      await wait(800);
      holdScroll();
      anchorInfo = {
        stillInDom: document.body.contains(anchor),
        topBefore: Math.round(topBefore),
        topAfter: Math.round(anchor.getBoundingClientRect().top),
        moved: Math.round(anchor.getBoundingClientRect().top - topBefore),
        scrollBefore: Math.round(scrollBefore),
        scrollAfter: Math.round(scrollerEl.scrollTop),
      };
    }
  }

  stage.at = 'C-after';
  await wait(400);
  const after = {
    userRows: document.querySelectorAll('.entry-user').length,
    earlierStillThere: document.querySelector('.chat-earlier') !== null,
    openedRound,
    openedStillOpen: (() => {
      if (openedRound === null) return null;
      const toggle = Array.from(document.querySelectorAll('.turn-fold'))
        .find((item) => item.dataset.roundIndex === openedRound);
      return toggle === undefined ? null : toggle.getAttribute('aria-expanded');
    })(),
  };

  // 拍照：把视角摆到「加载更早」那一行（还在的话）
  const finalButton = document.querySelector('.chat-earlier');
  allowScroll();
  if (finalButton !== null) {
    const delta = finalButton.getBoundingClientRect().top
      - scrollerEl.getBoundingClientRect().top - 140;
    scrollerEl.scrollTop = Math.round(scrollerEl.scrollTop + delta);
  }
  await wait(350);
  holdScroll();

  stage.at = 'done';
  return { before, after, anchorInfo, openedBefore };
  })();

  const done = await Promise.race([
    main,
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, 45000);
    }),
  ]);
  if (done === null) return { case: 'step-paging', stage: stage.at, error: '预跑脚本超时（45 秒兜底）' };
  if (done.error !== undefined) return { case: 'step-paging', stage: stage.at, error: done.error };
  const { before, after, anchorInfo, openedBefore } = done;

  return {
    case: 'step-paging',
    stage: stage.at,
    theme: document.documentElement.dataset.theme,
    before,
    after,
    anchorInfo,
    openedBefore,
    // 初始只画最近一页（12 轮的样张里画出 8 轮），顶上有「加载更早」
    firstPageOnly: before.userRows === 8 && before.earlier !== null,
    earlierButtonLabeled: before.earlier !== null && before.earlier.label.indexOf('加载更早') === 0,
    // 点完放出更早的轮
    moreRoundsAfterLoad: after.userRows > before.userRows,
    // 锚定：「按正文顺序锚定按钮下第一个可见内容项」，DOM 更新后它自己不动
    anchorStayedPut: anchorInfo !== null && Math.abs(anchorInfo.moved) <= 2,
    // 手动展开的整轮在分页前后保持展开（开合状态按轮号存，与渲染窗口无关）
    foldKeptAcrossLoad: openedBefore === null || after.openedStillOpen === 'true',
  };
})()
'@)

# ── 用例表 ─────────────────────────────────────────────────────────────────────
# delay = 页面加载完成后多少毫秒截图；lead = 截图前多少毫秒开始跑预跑脚本。
# 两者之差就是预跑脚本能用的时间，必须大于它自己的耗时（否则截图先到、证据还没打出来）。
# theme 走 step-seed.mjs 的 STEP_THEME：浅色那一档专门验「组头与思考行的分层换主题后还成立」。
# tools 走假端点的 FOLD_FAKE_TOOLS：只有 step-control 需要一次吐十几个调用，好撑出超限高的组。
$stepCases = [ordered]@{
  'step-static'   = @{ delay = 62000; lead = 48000; live = $false; fold = 'standard'; theme = 'dark';  eval = $stepStaticEval }
  'step-live'     = @{ delay = 65000; lead = 50000; live = $true;  fold = 'standard'; theme = 'dark';  eval = $stepLiveEval }
  'step-detailed' = @{ delay = 62000; lead = 48000; live = $true;  fold = 'detailed'; theme = 'dark';  eval = $stepDetailedEval }
  'step-verbose'  = @{ delay = 45000; lead = 32000; live = $false; fold = 'verbose';  theme = 'dark';  eval = $stepVerboseEval }
  'step-light'    = @{ delay = 52000; lead = 38000; live = $false; fold = 'standard'; theme = 'light'; eval = $stepLightEval }
  'step-plan'     = @{ delay = 52000; lead = 38000; live = $false; fold = 'standard'; theme = 'dark';  eval = $stepPlanEval }
  'step-control'  = @{ delay = 100000; lead = 62000; live = $true;  fold = 'standard'; theme = 'dark';  tools = 24; tail = 2000; hops = 3; eval = $stepControlEval }
  'step-prepare'  = @{ delay = 74000; lead = 50000; live = $true;  fold = 'standard'; theme = 'dark';  prepare = 4000; failFirst = $true; eval = $stepPrepareEval }
  'step-paging'   = @{ delay = 62000; lead = 46000; live = $false; fold = 'standard'; theme = 'dark';  session = 'paging'; eval = $stepPagingEval }
}

$script:stepServer = $null
function Start-StepFake {
  if ($script:stepServer -ne $null) { return }
  # 超长思考填充：把组头实时详情顶到必被截断的长度——不设的话几十字的思考在旧布局里也
  # 超不了宽，step-live 的「详情不撑破会话」断言测不出差别。端点单例，所有用例共享；
  # 多出来的填充只进第一跳思考的末段（detail 的数据源），各用例断言的 label/聚合文案不受影响。
  $env:FOLD_FAKE_REASON_PAD = '、顺手把每一段的依据也逐条展开核对：先对 identity 段核对提示词的组装顺序与插值来源，再对 behavior 段核对行为约束是否与沙箱档位一致，最后对工具段核对参数键序与重试语义，逐段确认没有漂移之后再收口作答，避免只对名字不对内容。'
  $script:stepServer = Start-Process -FilePath 'node' -ArgumentList (Join-Path $stepShots 'fold-fake-llm.mjs'), $stepPort, 'step' -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 900
}
function Stop-StepFake {
  if ($script:stepServer -ne $null) {
    & taskkill /PID $script:stepServer.Id /T /F 2>&1 | Out-Null
    $script:stepServer = $null
  }
  Remove-Item Env:FOLD_FAKE_REASON_PAD -ErrorAction SilentlyContinue
}

Write-Output '=== 真实 ~/.dsc 跑前指纹 ==='
$stepBefore = Get-DirFingerprint $stepRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 清单聚合 {2} · 内容聚合 {3}" -f $stepBefore.Count, $stepBefore.Locked, $stepBefore.Digest, $stepBefore.ContentDigest)
Write-FingerprintFile (Join-Path $stepShots 'step-realhome-before.txt') $stepBefore '跑前'

try {
  foreach ($name in $stepCases.Keys) {
    if ($Only -ne 'all' -and $Only -ne $name) { continue }
    $spec = $stepCases[$name]

    # 每个用例重新造种子：会话文件是新的（随机 id），档位与主题也在这里定
    $env:STEP_THEME = $spec.theme
    $env:STEP_PROCESS_FOLD = $spec.fold
    # 假端点第一跳吐几个调用（只有 step-control 需要十几个，见用例表那行注释）
    $env:FOLD_FAKE_TOOLS = if ($null -ne $spec.tools) { [string]$spec.tools } else { '1' }
    # 第二跳「思考 → 正文」之间的停顿：step-control 靠它撑出「组还没收口」那段窗口
    $env:FOLD_FAKE_TAIL_MS = if ($null -ne $spec.tail) { [string]$spec.tail } else { '400' }
    # 一轮有几跳：只有 step-control 要三跳（中间那跳用来把「组收口」与「轮收尾」错开）
    $env:FOLD_FAKE_HOPS = if ($null -ne $spec.hops) { [string]$spec.hops } else { '2' }
    # 第一跳吐完 tool_calls 之后停多久：step-prepare 靠它把「准备中」那一瞬拉长到抓得住
    $env:FOLD_FAKE_PREPARE_MS = if ($null -ne $spec.prepare) { [string]$spec.prepare } else { '200' }
    # 头一次请求故意 500：step-prepare 靠它让 llm 的重试环真的跑一次
    $env:FOLD_FAKE_FAIL_FIRST = if ($spec.failFirst -eq $true) { '1' } else { '' }
    $env:STEP_FAKE_PORT = [string]$stepPort
    node (Join-Path $stepShots 'step-seed.mjs') | Out-Null
    $stepSessions = Get-Content (Join-Path $stepShots 'step-sessions.json') -Raw | ConvertFrom-Json

    if ($spec.live) { Stop-StepFake; Start-StepFake } else { Stop-StepFake }

    $env:DSC_DESKTOP_USER_DATA = Join-Path $stepHome 'electron-userdata'
    $env:USERPROFILE = $stepHome
    $env:HOME = $stepHome
    $env:STEP_FAKE_KEY = 'sk-selfcheck-fake'
    # 假端点脚本读的是 FOLD_PROBE_TARGET 这个变量名（它按 fold 用例写的，这里照用同一个脚本）
    $env:FOLD_PROBE_TARGET = $stepSessions.probeTarget
    $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
    # 挂哪条会话：默认静态样张（实时用例挂 live），step-paging 挂它自己的 12 轮样张
    $env:DSC_RESUME_SESSION = if ($null -ne $spec.session) {
      $stepSessions.($spec.session)
    } elseif ($spec.live) {
      $stepSessions.live
    } else {
      $stepSessions.static
    }
    $env:DSC_DESKTOP_SHOT = Join-Path $stepShots "$name.png"
    $env:DSC_DESKTOP_SHOT_DELAY = [string]$spec.delay
    $env:DSC_DESKTOP_SHOT_EVAL_LEAD = [string]$spec.lead
    # 计划卡那个用例要重新打开一次会话（见那段注释）：把种子会话路径以 JSON 字面量的形式
    # 塞进去——直接拼路径的话 JS 会把 `\d` 当转义吃掉，路径当场就废了。
    $env:DSC_DESKTOP_SHOT_EVAL = $spec.eval.Replace('__STATIC_SESSION__', ($stepSessions.static | ConvertTo-Json -Compress))
    Write-Output ("  预跑脚本：{0} 字符（lead {1}ms）" -f $env:DSC_DESKTOP_SHOT_EVAL.Length, $spec.lead)
    Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue

    $outLog = Join-Path $stepShots "$name.out.log"
    $errLog = Join-Path $stepShots "$name.err.log"
    Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
    Write-Output "=== $name（档位 $($spec.fold)；隔离目录 $stepHome）==="

    $stepProc = Start-Process -FilePath $stepElectron -ArgumentList $stepEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $stepDeadline = (Get-Date).AddSeconds($spec.delay + 60)
    $stepSeen = ''
    while ((Get-Date) -lt $stepDeadline) {
      if (Test-Path -LiteralPath $errLog) {
        $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|页面加载失败|截图失败' -ErrorAction SilentlyContinue
        if ($null -ne $hit) { $stepSeen = $hit[0].Line; break }
      }
      if ($stepProc.HasExited) { break }
      Start-Sleep -Milliseconds 500
    }
    # 只杀自己刚起的那一棵进程树（electron + 它拉起的宿主子进程），不碰别的进程。
    if (-not $stepProc.HasExited) {
      & taskkill /PID $stepProc.Id /T /F 2>&1 | Out-Null
      Start-Sleep -Milliseconds 600
    } else {
      & taskkill /PID $stepProc.Id /T /F 2>&1 | Out-Null
    }
    Write-Output ("  electron 已收工：{0}" -f ($stepSeen -replace '\s+$', ''))

    if (Test-Path -LiteralPath $errLog) {
      Select-String -LiteralPath $errLog -Pattern '预跑脚本完成|预跑脚本失败|已写出|页面加载失败' |
        ForEach-Object { '  ' + $_.Line }
    }
    $stepWritten = (Get-Content -LiteralPath (Join-Path $stepHome '.dsc\settings.json') -Raw | ConvertFrom-Json).ui.processFold
    Write-Output "  隔离 settings.json 里的 ui.processFold = $stepWritten"
  }
} finally {
  Stop-StepFake
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_SEARCH,
    Env:DSC_DESKTOP_USER_DATA, Env:STEP_THEME, Env:STEP_PROCESS_FOLD, Env:STEP_FAKE_PORT,
    Env:FOLD_FAKE_TOOLS, Env:FOLD_FAKE_TAIL_MS, Env:FOLD_FAKE_HOPS, Env:FOLD_FAKE_PREPARE_MS,
    Env:FOLD_FAKE_FAIL_FIRST, Env:STEP_FAKE_KEY, Env:FOLD_PROBE_TARGET, Env:FOLD_FAKE_REASON_PAD -ErrorAction SilentlyContinue
}

Write-Output '=== 真实 ~/.dsc 跑后指纹 ==='
$stepAfter = Get-DirFingerprint $stepRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 清单聚合 {2} · 内容聚合 {3}" -f $stepAfter.Count, $stepAfter.Locked, $stepAfter.Digest, $stepAfter.ContentDigest)
Write-FingerprintFile (Join-Path $stepShots 'step-realhome-after.txt') $stepAfter '跑后'
$stepDiff = Compare-Object -ReferenceObject $stepBefore.Lines -DifferenceObject $stepAfter.Lines
if ($null -eq $stepDiff) {
  Write-Output '差异行：无（逐文件哈希完全一致）'
} else {
  Write-Output ("差异行：{0} 条（只看路径集合是否有增删，与内容是否变化）" -f @($stepDiff).Count)
  $stepDiff | ForEach-Object { '  ' + $_.SideIndicator + ' ' + $_.InputObject }
}
$stepPathsBefore = @($stepBefore.Lines | ForEach-Object { ($_ -split '\|')[0] })
$stepPathsAfter = @($stepAfter.Lines | ForEach-Object { ($_ -split '\|')[0] })
$stepAdded = @($stepPathsAfter | Where-Object { $stepPathsBefore -notcontains $_ })
$stepRemoved = @($stepPathsBefore | Where-Object { $stepPathsAfter -notcontains $_ })
Write-Output ("路径增删：新增 {0} 个、减少 {1} 个" -f $stepAdded.Count, $stepRemoved.Count)
Write-Output ("文件数一致：{0}；内容聚合一致：{1}" -f ($stepBefore.Count -eq $stepAfter.Count), ($stepBefore.ContentDigest -eq $stepAfter.ContentDigest))
Write-Output '全部完成'
