# 「整轮过程折叠 + 脚注合并 + 过程折叠程度」的隔离桌面自检（截图 + 取证）。
#
# 隔离怎么做：DSC_DESKTOP_USER_DATA 换掉 Electron 的 userData，USERPROFILE / HOME 换掉宿主的
# ~/.dsc——会话、配置、settings 全落在 desktop/shots/fold-home 下，用户真实的 ~/.dsc 一个字节
# 都不写。种子数据见 shots/fold-seed.mjs，假端点见 shots/fold-fake-llm.mjs。
# 跑前跑后各对真实 ~/.dsc 做一次「文件数 + 全量 SHA256 聚合指纹」比对，两个指纹都写进报告。
#
# 进程管理（本脚本刻意不用 `& electron | Out-File`）：Start-Process 起 electron.exe、
# 轮询 stderr 日志里的关键行、最后 taskkill /PID <自己起的那棵进程树> /T /F。
# 临时目录变量一律自命名（$foldHome 等），绝不用 $home / $HOME——那是 PowerShell 只读自动变量，
# 赋值会静默失败并把后续写入落到真实用户目录。
#
# 用法（先在 desktop/ 跑 `pnpm run build`，否则拍的是旧包）：
#   pwsh -NoProfile -File fold-shots.ps1              # 三个用例
#   pwsh -NoProfile -File fold-shots.ps1 -Only fold-static
#
# 每个用例把证据打成一行 JSON（日志里搜「预跑脚本完成」），截图落在 shots/fold-*.png。

param([string]$Only = 'all')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$foldShots = 'D:\dsc\desktop\shots'
$foldElectron = Join-Path $foldShots '..\node_modules\electron\dist\electron.exe'
$foldEntry = Join-Path $foldShots '..\out\main\index.js'
$foldHome = Join-Path $foldShots 'fold-home'
$foldPort = 18951
# 真实用户目录：必须在把 USERPROFILE/HOME 指到隔离目录之前读出来。
$foldRealProfile = $env:USERPROFILE
$foldRealDsc = Join-Path $foldRealProfile '.dsc'

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
$foldHead = @'
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
const toggles = () => Array.from(document.querySelectorAll('.turn-fold'));
const feet = () => Array.from(document.querySelectorAll('.round-foot'));
const blocks = () => Array.from(document.querySelectorAll('.think-block'));
const cards = () => Array.from(document.querySelectorAll('.tool-card'));
const chat = () => document.querySelector('.chat');
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
  window.__foldAllow = false;
  Object.defineProperty(box, 'scrollTop', {
    configurable: true,
    get: () => held.value,
    set: (value) => { if (window.__foldAllow === true) { held.value = value; desc.set.call(box, value); } },
  });
  return true;
};
const allowScroll = () => { window.__foldAllow = true; };
const holdScroll = () => { window.__foldAllow = false; };
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
const toggleInfo = (t) => ({
  label: t.textContent.trim(),
  tag: t.tagName,
  role: t.getAttribute('role') ?? 'button(原生)',
  ariaExpanded: t.getAttribute('aria-expanded'),
  open: t.dataset.open ?? null,
  round: t.dataset.roundIndex ?? null,
  box: shape(t),
  chevronTransform: getComputedStyle(t.querySelector('.turn-fold-chevron')).transform,
  labelFlex: getComputedStyle(t.querySelector('.turn-fold-label')).flex,
});
const footInfo = (f) => ({
  children: Array.from(f.children).map((c) => c.className),
  text: f.textContent.trim(),
  title: f.getAttribute('title'),
  tokens: f.querySelector('.round-tokens') === null ? null : f.querySelector('.round-tokens').textContent.trim(),
  tokensTitle: f.querySelector('.round-tokens') === null ? null : f.querySelector('.round-tokens').getAttribute('title'),
  clock: f.querySelector('.round-clock') === null ? null : f.querySelector('.round-clock').textContent.trim(),
  copy: f.querySelector('.round-act') !== null,
  acts: f.querySelectorAll('.round-act').length,
  fork: f.querySelector('.user-act') !== null,
  oneRow: Array.from(f.children).every((c, _, all) => Math.abs((shape(c).t + shape(c).b) / 2 - (shape(f).t + shape(f).b) / 2) <= 7),
});
'@

# ── 用例 1：标准档 · 定稿轮整组收起（静态三轮话题） ─────────────────────────────
$foldStaticEval = ($foldHead + @'

(async () => {
  // 时间线：宿主把会话重放上屏要多久，是排查「等了半天没内容」的第一手线索
  const started = Date.now();
  const polls = [];
  const ready = await waitFor(() => {
    const state = {
      ms: Date.now() - started,
      users: document.querySelectorAll('.entry-user').length,
      toggles: toggles().length,
      texts: document.querySelectorAll('.entry-text').length,
    };
    const last = polls[polls.length - 1];
    if (last === undefined || last.users !== state.users || last.toggles !== state.toggles) polls.push(state);
    return state.users >= 3 && state.toggles >= 3 ? state : null;
  }, 30000);
  await wait(900);
  if (ready === null) return { case: 'fold-static', error: '没等到三轮话题与三个总开关', polls };
  freezeScroll();
  const inner = document.querySelector('.chat-inner');
  const innerCs = getComputedStyle(inner);
  const innerBox = shape(inner);
  const contentLeft = innerBox.l + parseFloat(innerCs.paddingLeft);
  const contentWidth = inner.clientWidth - parseFloat(innerCs.paddingLeft) - parseFloat(innerCs.paddingRight);

  // 收起态：过程成员一个都不在 DOM 里（不是被 CSS 藏起来）
  const collapsed = {
    toggleCount: toggles().length,
    thinkBlocks: blocks().length,
    toolCards: cards().length,
    texts: document.querySelectorAll('.entry-text').length,
    toggles: toggles().map(toggleInfo),
    footers: feet().map(footInfo),
  };

  // 展开第一轮：过程条目回来，箭头转 180°，aria 跟着翻
  toggles()[0].click();
  await wait(600);
  const expanded = {
    thinkBlocks: blocks().length,
    toolCards: cards().length,
    texts: document.querySelectorAll('.entry-text').length,
    toggle: toggleInfo(toggles()[0]),
    bodyInDom: document.querySelectorAll('.think-body').length,
  };

  // 竖排字修复：把正文列压到 360px（旧版在这一档就会把「思考过程」压成一列字），
  // 再看标题是不是仍然只占一行：getClientRects().length === 1 且高度 ≈ 一行。
  document.documentElement.style.setProperty('--dsc-thread-max', '360px');
  await wait(500);
  const label = document.querySelector('.think-label');
  const labelInfo = label === null ? null : {
    text: label.textContent,
    lineCount: label.getClientRects().length,
    box: shape(label),
    fontSize: getComputedStyle(label).fontSize,
    flex: getComputedStyle(label).flex,
    whiteSpace: getComputedStyle(label).whiteSpace,
    headWidth: Math.round(document.querySelector('.think-head').getBoundingClientRect().width),
    chatWidth: Math.round(chat().clientWidth),
  };
  document.documentElement.style.removeProperty('--dsc-thread-max');
  await wait(400);

  // 再收起：过程条目退出 DOM，aria 回 false
  toggles()[0].click();
  await wait(600);
  const recollapsed = { thinkBlocks: blocks().length, toolCards: cards().length, toggle: toggleInfo(toggles()[0]) };

  // 页脚结构：六项顺序 + 用时进 title + 老会话回落估算（带 ~）
  const footers = feet().map(footInfo);

  // 留给截图：第一轮保持在收起态，把它的总开关摆在视口 1/4 处
  await scrollTo(toggles()[0], Math.round(chat().getBoundingClientRect().height * 0.22));
  const shotState = {
    visibleToggles: toggles().filter((t) => {
      const b = t.getBoundingClientRect();
      const c = chat().getBoundingClientRect();
      return b.top >= c.top && b.bottom <= c.bottom;
    }).length,
    toggleBox: shape(toggles()[0]),
    footBox: shape(feet()[0]),
  };
  return {
    case: 'fold-static',
    polls,
    theme: document.documentElement.dataset.theme,
    contentLeft,
    contentWidth,
    collapsed,
    expanded,
    recollapsed,
    labelInfo,
    footers,
    shotState,
    // 判定：整行开关铺满正文列宽、贴正文列左缘
    toggleAligned: collapsed.toggles.every((t) => Math.abs(t.box.l - contentLeft) <= 2),
    toggleFullWidth: collapsed.toggles.every((t) => Math.abs(t.box.w - contentWidth) <= 2),
    // 收起时只剩开关：组内条目一个都不在 DOM
    collapsedHidesMembers: collapsed.thinkBlocks === 0 && collapsed.toolCards === 0,
    expandedBringsMembers: expanded.thinkBlocks === 1 && expanded.toolCards === 1 && expanded.bodyInDom === 0,
    recollapsedAgain: recollapsed.thinkBlocks === 0 && recollapsed.toggle.ariaExpanded === 'false',
    // 「用时 X」+ 算不出时「已完成」
    labelsLookRight: collapsed.toggles.every((t) => /^用时 /.test(t.label) || t.label === '已完成'),
    // hover 底色与 .think-head 同款令牌
    hoverTokenSame: declOf('.turn-fold:hover', 'background') === declOf('.think-head:hover', 'background'),
    // 页面里已经没有任何 .entry-meta 操作条
    metaGone: document.querySelector('.entry-meta') === null,
    // 竖排字：标题只占一行，且 flex 是 none / white-space 是 nowrap
    labelOneLine: labelInfo !== null && labelInfo.lineCount === 1 && labelInfo.box.h <= parseInt(labelInfo.fontSize, 10) * 2,
    labelNotSqueezed: labelInfo !== null && labelInfo.flex.indexOf('0 0 auto') === 0,
    labelNowrap: labelInfo !== null && labelInfo.whiteSpace === 'nowrap',
    // 脚注：第一 / 第二轮有最终正文 → 复制 + 分叉 + 用量 + 时刻（赞/踩钮已去掉）；
    // 第三轮没有最终正文 → 没有可复制的东西，只剩分叉 + 用量 + 时刻
    footOrder: footers.map((f) => f.children),
    footOneRow: footers.every((f) => f.oneRow),
    // 老会话没有宿主上报的用量：前两轮（有最终正文）回落估算，带 ~ 前缀
    footTokensEstimated: footers.slice(0, 2).every((f) => f.tokens !== null && f.tokens.indexOf('~') === 0),
    // 第三轮一句正文都没有 → 没有可估算的正文，用量那一项整格不画（而不是画个 ~0 tok）
    thirdRoundNoTokens: footers.length === 3 && footers[2].tokens === null,
    footUsedInTitle: footers.every((f) => typeof f.title === 'string' && f.title.indexOf('用时 ') === 0),
    footUsedNotInline: footers.every((f) => f.text.indexOf('用时') < 0),
    thirdRoundNoCopy: footers.length === 3 && footers[2].copy === false && footers[2].acts === 0 && footers[2].fork === true,
    otherRoundsHaveCopy: footers.slice(0, 2).every((f) => f.copy === true && f.acts === 1 && f.fork === true),
  };
})()
'@)

# ── 用例 2：设置项「过程折叠程度」三档 + 真实落盘（隔离 settings.json） ───────────
$foldSettingsEval = ($foldHead + @'

(async () => {
  const row = await waitFor(() => Array.from(document.querySelectorAll('.setting-row'))
    .find((r) => r.textContent.indexOf('过程折叠程度') === 0 || r.textContent.indexOf('过程折叠程度') >= 0), 20000);
  if (row === null) return { case: 'fold-settings', error: '设置面板里没找到「过程折叠程度」这一行' };
  const labels = () => Array.from(row.querySelectorAll('.dsc-segmented__btn')).map((b) => ({ label: b.textContent.trim(), selected: b.getAttribute('aria-selected') }));
  const initial = { labels: labels(), help: row.querySelector('.setting-help') === null ? null : row.querySelector('.setting-help').textContent.trim() };
  const toasts = () => Array.from(document.querySelectorAll('.dsc-toast__text')).map((t) => t.textContent.trim());
  const pick = (name) => { const b = Array.from(row.querySelectorAll('.dsc-segmented__btn')).find((x) => x.textContent.trim() === name); if (b !== undefined) b.click(); };
  // 定稿思考行那一行的摘要预览：紧凑档该没有（分隔点与摘要都不画），标准档该回来
  const previewInfo = () => {
    const block = document.querySelector('.think-block');
    return {
      thinkBlocks: blocks().length,
      preview: block === null ? null : (block.dataset.preview ?? null),
      summaryCount: document.querySelectorAll('.think-summary').length,
      dotCount: document.querySelectorAll('.think-dot').length,
      summaryText: block === null || block.querySelector('.think-summary-text') === null
        ? null : block.querySelector('.think-summary-text').textContent,
      labelWidth: block === null ? null : Math.round(block.querySelector('.think-label').getBoundingClientRect().width),
    };
  };

  pick('紧凑');
  await wait(900);
  const compact = { labels: labels(), toasts: toasts() };
  // 浮层底下的消息流还在，程序性点一下第一个总开关就能把过程展开来看摘要（真实点击被遮罩挡住，
  // 但这只是自检取证，量到的是真的 DOM）
  const firstToggle = document.querySelector('.turn-fold');
  if (firstToggle !== null) firstToggle.click();
  await wait(800);
  const compactPreview = previewInfo();
  pick('标准');
  await wait(900);
  const standardPreview = previewInfo();
  const standard = { labels: labels(), toasts: toasts() };
  if (firstToggle !== null) firstToggle.click();
  await wait(600);
  pick('详细');
  await wait(900);
  const detailed = { labels: labels(), toasts: toasts() };
  // 设置面板是浮层、消息流还在下面挂着，所以不必关掉它就能量到「详细档不做整轮折叠」：
  // 关掉反而拍不到设置行本身（截图要留着这一行做证据）。
  await wait(600);
  const behindModal = {
    modalOpen: document.querySelector('.settings') !== null,
    toggleCount: toggles().length,
    thinkBlocks: blocks().length,
    toolCards: cards().length,
  };
  // 留给截图：把这一行滚到面板中间（它排在「密度」下面，默认视口看不到）
  row.scrollIntoView({ block: 'center' });
  await wait(600);
  return {
    case: 'fold-settings',
    theme: document.documentElement.dataset.theme,
    initial,
    compact,
    compactPreview,
    standard,
    standardPreview,
    detailed,
    behindModal,
    hasThree: initial.labels.length === 3,
    defaultStandard: initial.labels.filter((l) => l.selected === 'true').map((l) => l.label).join(',') === '标准',
    compactSelected: compact.labels.filter((l) => l.selected === 'true').map((l) => l.label).join(',') === '紧凑',
    compactReceipt: compact.toasts.some((t) => t.indexOf('过程折叠程度改为紧凑') === 0),
    detailedSelected: detailed.labels.filter((l) => l.selected === 'true').map((l) => l.label).join(',') === '详细',
    detailedReceipt: detailed.toasts.some((t) => t.indexOf('过程折叠程度改为详细') === 0),
    // 紧凑档：整轮展开以后，定稿思考行不画分隔点与摘要（data-preview 也不带），标题还在
    compactDropsPreview: compactPreview.thinkBlocks === 1 &&
      compactPreview.preview === null &&
      compactPreview.summaryCount === 0 &&
      compactPreview.dotCount === 0 &&
      compactPreview.labelWidth > 40,
    // 标准档（默认）：摘要预览回来，data-preview 重新挂上
    standardKeepsPreview: standardPreview.thinkBlocks === 1 &&
      standardPreview.preview === '1' &&
      standardPreview.summaryCount === 1 &&
      typeof standardPreview.summaryText === 'string' &&
      standardPreview.summaryText.length > 0,
    // 详细档不做整轮折叠：总开关一个都不画，过程条目照旧摊开
    detailedNoFold: behindModal.toggleCount === 0 && behindModal.thinkBlocks === 3 && behindModal.toolCards === 2,
  };
})()
'@)

# ── 用例 3：实时一轮（跑动中不画开关 → 定稿自动收起 → 用量显示真值 330） ──────────
$foldLiveEval = ($foldHead + @'

(async () => {
  const base = await waitFor(() => document.querySelectorAll('.entry-user').length >= 1, 25000);
  if (base === null) return { case: 'fold-live', error: '没等到实时样张的会话' };
  await wait(1200);
  freezeScroll();
  const beforeToggleCount = toggles().length;

  await window.dsc.invoke('submit', ['把刚才那处改动跑一遍自检，顺便看一眼用量是不是真值。', undefined]);

  // 跑动中：一看到「跑动中的思考条」就立刻取快照。为什么不等工具卡进入「进行中」再取——
  // read 是瞬间返回的工具，那张卡处于进行中的窗口只有几十毫秒，等它会把整轮等完，
  // 量到的就成了定稿态（这一版第一回跑就是这么把结论读反的）。
  const during = await waitFor(() => {
    if (document.querySelector('.think-block[data-state="running"]') === null) return null;
    const lastRound = document.querySelectorAll('.entry-user').length - 1;
    return {
      lastRound,
      thinkBlocks: blocks().length,
      toolCards: cards().length,
      // 跑动这一轮里过程条目在不在 DOM（在 = 整组展开着）
      membersInLiveRound: document.querySelectorAll('.entry-row[data-round="' + String(lastRound) + '"] .think-block').length,
      // 各总开关分别属于哪一轮：跑动这一轮**不该**有
      toggleRounds: toggles().map((t) => Number(t.dataset.roundIndex)),
      statusLine: document.querySelector('.turn-status') !== null,
    };
  }, 30000);

  // 收尾：这一轮定稿后自动长出一个总开关（收起态）
  const settled = await waitFor(() => document.querySelector('.turn-status') === null && toggles().length > beforeToggleCount, 40000);
  await wait(1000);
  const roundToggle = toggles()[toggles().length - 1];
  const after = {
    toggleCount: toggles().length,
    thinkBlocks: blocks().length,
    toolCards: cards().length,
    toggle: roundToggle === undefined ? null : toggleInfo(roundToggle),
    footer: feet().length === 0 ? null : footInfo(feet()[feet().length - 1]),
  };

  // 展开刚定稿的这一轮：过程条目（两段思考 + 工具卡）回来
  if (roundToggle !== undefined) roundToggle.click();
  await wait(700);
  const opened = { thinkBlocks: blocks().length, toolCards: cards().length, bodies: document.querySelectorAll('.think-body').length, toggle: roundToggle === undefined ? null : toggleInfo(roundToggle) };
  if (roundToggle !== undefined) roundToggle.click();
  await wait(700);
  const afterScreenshotScroll = await (async () => {
    if (roundToggle !== undefined) await scrollTo(roundToggle, Math.round(chat().getBoundingClientRect().height * 0.3));
    return { thinkBlocks: blocks().length, toggleCount: toggles().length };
  })();

  return {
    case: 'fold-live',
    theme: document.documentElement.dataset.theme,
    beforeToggleCount,
    during,
    after,
    opened,
    afterScreenshotScroll,
    settled: settled !== null,
    // 跑动中：这一轮的过程条目全部摊开，且这一轮没有总开关（dsh：跑动轮永远展开、不提供折叠）
    liveNeverFolds: during !== null &&
      during.membersInLiveRound >= 1 &&
      during.toggleRounds.includes(during.lastRound) === false,
    liveRoundHasNoToggle: during !== null && during.toggleRounds.includes(during.lastRound) === false,
    // 定稿后：自动多出一个总开关，且是收起态（跑动中的展开不会留在定稿轮上）
    settledFolds: after.toggleCount === beforeToggleCount + 1 && after.toggle !== null && after.toggle.ariaExpanded === 'false',
    settledHidesMembers: after.thinkBlocks === 0,
    reopensMembers: opened.thinkBlocks === 2 && opened.toolCards === 1,
    // 用量是真值：宿主上报的整轮累计（100+10 + 200+20 = 330），不带波浪号
    tokenIsReal: after.footer !== null && after.footer.tokens === '用量 330 tok',
    tokenNoTilde: after.footer !== null && after.footer.tokens.indexOf('~') < 0,
    tokenTitleSaysReal: after.footer !== null && typeof after.footer.tokensTitle === 'string' && after.footer.tokensTitle.indexOf('宿主上报的真实用量') >= 0,
    clockShown: after.footer !== null && typeof after.footer.clock === 'string' && after.footer.clock.length === 5,
    footStillThere: after.footer !== null && after.footer.copy === true && after.footer.fork === true,
  };
})()
'@)

# ── 用例表 ─────────────────────────────────────────────────────────────────────
# delay = 页面加载完成后多少毫秒截图；lead = 截图前多少毫秒开始跑预跑脚本。
# 两者之差就是预跑脚本能用的时间，必须大于它自己的耗时（否则截图先到、证据还没打出来）。
$foldCases = [ordered]@{
  'fold-static'   = @{ delay = 45000; lead = 32000; live = $false; search = '';                 eval = $foldStaticEval }
  'fold-settings' = @{ delay = 45000; lead = 32000; live = $false; search = 'settings=general'; eval = $foldSettingsEval }
  'fold-live'     = @{ delay = 60000; lead = 45000; live = $true;  search = '';                 eval = $foldLiveEval }
}

$script:foldServer = $null
function Start-FoldFake {
  if ($script:foldServer -ne $null) { return }
  $script:foldServer = Start-Process -FilePath 'node' -ArgumentList (Join-Path $foldShots 'fold-fake-llm.mjs'), $foldPort -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 900
}
function Stop-FoldFake {
  if ($script:foldServer -ne $null) {
    & taskkill /PID $script:foldServer.Id /T /F 2>&1 | Out-Null
    $script:foldServer = $null
  }
}

Write-Output '=== 真实 ~/.dsc 跑前指纹 ==='
$foldBefore = Get-DirFingerprint $foldRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 清单聚合 {2} · 内容聚合 {3}" -f $foldBefore.Count, $foldBefore.Locked, $foldBefore.Digest, $foldBefore.ContentDigest)
Write-FingerprintFile (Join-Path $foldShots 'fold-realhome-before.txt') $foldBefore '跑前'

try {
  foreach ($name in $foldCases.Keys) {
    if ($Only -ne 'all' -and $Only -ne $name) { continue }
    $spec = $foldCases[$name]

    # 每个用例重新造种子：会话文件是新的（随机 id），档位与主题也在这里定
    $env:FOLD_THEME = 'dark'
    $env:FOLD_PROCESS_FOLD = 'standard'
    $env:FOLD_FAKE_PORT = [string]$foldPort
    node (Join-Path $foldShots 'fold-seed.mjs') | Out-Null
    $foldSessions = Get-Content (Join-Path $foldShots 'fold-sessions.json') -Raw | ConvertFrom-Json

    if ($spec.live) { Stop-FoldFake; Start-FoldFake } else { Stop-FoldFake }

    $env:DSC_DESKTOP_USER_DATA = Join-Path $foldHome 'electron-userdata'
    $env:USERPROFILE = $foldHome
    $env:HOME = $foldHome
    $env:FOLD_FAKE_KEY = 'sk-selfcheck-fake'
    $env:FOLD_PROBE_TARGET = $foldSessions.probeTarget
    $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
    $env:DSC_RESUME_SESSION = if ($spec.live) { $foldSessions.live } else { $foldSessions.static }
    $env:DSC_DESKTOP_SHOT = Join-Path $foldShots "$name.png"
    $env:DSC_DESKTOP_SHOT_DELAY = [string]$spec.delay
    $env:DSC_DESKTOP_SHOT_EVAL_LEAD = [string]$spec.lead
    $env:DSC_DESKTOP_SHOT_EVAL = $spec.eval
    if ($spec.search -ne '') { $env:DSC_DESKTOP_SEARCH = $spec.search } else { Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue }

    $outLog = Join-Path $foldShots "$name.out.log"
    $errLog = Join-Path $foldShots "$name.err.log"
    Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
    Write-Output "=== $name（档位 $($spec.search)；隔离目录 $foldHome）==="

    # Start-Process 起 electron.exe（不用 `& electron | Out-File`），stderr 直接重定向到文件，
    # 自检那几行 [selfcheck] 就在里面。
    $foldProc = Start-Process -FilePath $foldElectron -ArgumentList $foldEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $foldDeadline = (Get-Date).AddSeconds($spec.delay + 60)
    $foldSeen = ''
    while ((Get-Date) -lt $foldDeadline) {
      if (Test-Path -LiteralPath $errLog) {
        $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|页面加载失败|截图失败' -ErrorAction SilentlyContinue
        if ($null -ne $hit) { $foldSeen = $hit[0].Line; break }
      }
      if ($foldProc.HasExited) { break }
      Start-Sleep -Milliseconds 500
    }
    # 只杀自己刚起的那一棵进程树（electron + 它拉起的宿主子进程），不碰别的进程。
    if (-not $foldProc.HasExited) {
      & taskkill /PID $foldProc.Id /T /F 2>&1 | Out-Null
      Start-Sleep -Milliseconds 600
    } else {
      & taskkill /PID $foldProc.Id /T /F 2>&1 | Out-Null
    }
    Write-Output ("  electron 已收工：{0}" -f ($foldSeen -replace '\s+$', ''))

    if (Test-Path -LiteralPath $errLog) {
      Select-String -LiteralPath $errLog -Pattern '预跑脚本完成|预跑脚本失败|已写出|页面加载失败' |
        ForEach-Object { '  ' + $_.Line }
    }
    if ($spec.search -ne '') {
      $foldSettingsPath = Join-Path $foldHome '.dsc\settings.json'
      $foldWritten = (Get-Content -LiteralPath $foldSettingsPath -Raw | ConvertFrom-Json).ui.processFold
      Write-Output "  隔离 settings.json 里的 ui.processFold = $foldWritten"
    }
  }
} finally {
  Stop-FoldFake
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_SEARCH,
    Env:DSC_DESKTOP_USER_DATA, Env:FOLD_THEME, Env:FOLD_PROCESS_FOLD, Env:FOLD_FAKE_PORT,
    Env:FOLD_FAKE_KEY, Env:FOLD_PROBE_TARGET -ErrorAction SilentlyContinue
}

Write-Output '=== 真实 ~/.dsc 跑后指纹 ==='
$foldAfter = Get-DirFingerprint $foldRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 清单聚合 {2} · 内容聚合 {3}" -f $foldAfter.Count, $foldAfter.Locked, $foldAfter.Digest, $foldAfter.ContentDigest)
Write-FingerprintFile (Join-Path $foldShots 'fold-realhome-after.txt') $foldAfter '跑后'
$foldDiff = Compare-Object -ReferenceObject $foldBefore.Lines -DifferenceObject $foldAfter.Lines
if ($null -eq $foldDiff) {
  Write-Output '差异行：无（逐文件哈希完全一致）'
} else {
  Write-Output ("差异行：{0} 条（只看路径集合是否有增删，与内容是否变化）" -f @($foldDiff).Count)
  $foldDiff | ForEach-Object { '  ' + $_.SideIndicator + ' ' + $_.InputObject }
}
$foldPathsBefore = @($foldBefore.Lines | ForEach-Object { ($_ -split '\|')[0] })
$foldPathsAfter = @($foldAfter.Lines | ForEach-Object { ($_ -split '\|')[0] })
$foldAdded = @($foldPathsAfter | Where-Object { $foldPathsBefore -notcontains $_ })
$foldRemoved = @($foldPathsBefore | Where-Object { $foldPathsAfter -notcontains $_ })
Write-Output ("路径增删：新增 {0} 个、减少 {1} 个" -f $foldAdded.Count, $foldRemoved.Count)
Write-Output ("文件数一致：{0}；内容聚合一致：{1}" -f ($foldBefore.Count -eq $foldAfter.Count), ($foldBefore.ContentDigest -eq $foldAfter.ContentDigest))
Write-Output '全部完成'
