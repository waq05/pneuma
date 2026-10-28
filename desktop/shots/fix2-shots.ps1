# 「对话区修正批」的自检截图 + 取证。
#
# 隔离怎么做：DSC_DESKTOP_USER_DATA 换掉 Electron 的 userData，USERPROFILE/HOME 换掉宿主的
# ~/.dsc，DSC_HOME 再钉一道 dsc 自己的配置目录——会话、配置、settings、desktop.json 全落在
# desktop/shots/fix2-home 下，用户真实的 ~/.dsc 一个字节都不写。脚本跑前跑后各取一次真实
# ~/.dsc 的「路径|大小|mtime」指纹，比对结果打进日志（fix2-realhome-*.txt 留证）。
#
# 用法（先在 desktop/ 跑 `pnpm run build`，否则拍的是旧包）：
#   pwsh -NoProfile -File fix2-shots.ps1                          # 全部用例（改后）
#   pwsh -NoProfile -File fix2-shots.ps1 -Tag before              # 改前那一遍（文件名带 before-）
#   pwsh -NoProfile -File fix2-shots.ps1 -Only fix2-buttons
#
# 每个用例都把证据打成一行 JSON（日志里搜「预跑脚本完成」），截图落在 shots/*.png。
# 注意：临时目录一律用自命名变量（$fix2Home / $realHome），绝不碰 PowerShell 的只读 $HOME。

param([string]$Only = 'all', [string]$Tag = '')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# 文件名前缀：改前那一遍带 before-，改后不带（截图与日志都落在 shots/fix2-*）
$prefix = if ($Tag -eq '') { 'fix2-' } else { "fix2-$Tag-" }

$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$entry = Join-Path $shots '..\out\main\index.js'
$fix2Home = Join-Path $shots 'fix2-home'
$port = 18951

# 真实主目录在换环境变量之前先记下来：下面会把 USERPROFILE/HOME 指到沙箱去。
$realHome = $env:USERPROFILE
$realDsc = Join-Path $realHome '.dsc'

# ── 真实 ~/.dsc 的指纹（跑前跑后各一次） ─────────────────────────────────────
function Get-DscFingerprint([string]$root) {
  if (-not (Test-Path -LiteralPath $root)) { return '' }
  $rows = Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    ForEach-Object { $_.FullName.Substring($root.Length) + '|' + $_.Length + '|' + $_.LastWriteTimeUtc.Ticks }
  return ($rows -join "`n")
}
function Get-DscFingerprintStat([string]$text) {
  if ($text -eq '') { return @{ files = 0; bytes = 0 } }
  $files = 0
  $bytes = 0
  foreach ($row in ($text -split "`n")) {
    $parts = $row.Split('|')
    if ($parts.Count -lt 3) { continue }
    $files += 1
    $bytes += [int64]$parts[1]
  }
  return @{ files = $files; bytes = $bytes }
}

$fingerBefore = Get-DscFingerprint $realDsc
Set-Content -LiteralPath (Join-Path $shots 'fix2-realhome-before.txt') -Value $fingerBefore -Encoding utf8

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
const chat = () => document.querySelector('.chat');
const blocks = () => Array.from(document.querySelectorAll('.think-block'));
// 离最底下还有多少像素：与 JumpStrip 的 AT_BOTTOM_EPS(32) 同一个口径
const gapToBottom = () => { const c = chat(); return Math.round(c.scrollHeight - c.clientHeight - c.scrollTop); };
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
const ruleTextOf = (frag) => rulesOf()
  .filter((r) => r.selectorText !== undefined && r.selectorText.indexOf(frag) >= 0)
  .map((r) => r.selectorText + ' { ' + r.style.cssText + ' }');
const btnScale = () => getComputedStyle(document.documentElement).getPropertyValue('--dsc-btn-scale').trim();
// 流式正文那一条（entry.id < 0 的直播尾）
const liveText = () => document.querySelector('.entry-text.live');
'@

# 1) 消息操作条按钮：改后尺寸 ≥ dsh 的 28px hit area / 17px(助手) 与 15px(用户) 图标；
#    并且跟着 --dsc-btn-scale 一起长大（1.3 倍那一档实测）。
$buttonsEval = ($head + @'

(async () => {
  const ready = await waitFor(
    () => document.querySelectorAll('.entry-meta .meta-btn').length >= 3
      && document.querySelector('.user-turn .user-act') !== null
      && document.querySelector('.round-foot .user-act') !== null,
    25000,
  );
  await wait(900);
  const one = (el) => el === null ? null : {
    box: shape(el),
    svg: el.querySelector('svg') === null ? null : shape(el.querySelector('svg')),
    padding: getComputedStyle(el).paddingTop + ' ' + getComputedStyle(el).paddingRight,
    radius: getComputedStyle(el).borderRadius,
  };
  const read = () => {
    const actions = document.querySelector('.entry-meta .meta-actions');
    return {
      scale: btnScale(),
      metaBtns: Array.from(document.querySelectorAll('.entry-meta .meta-btn')).map(one),
      metaGap: actions === null ? null : getComputedStyle(actions).columnGap,
      userEdit: one(document.querySelector('.user-turn .user-act')),
      fork: one(document.querySelector('.round-foot .user-act')),
    };
  };
  if (ready === null) return { case: 'buttons', error: '没等到三种消息操作按钮同时出现' };
  const at100 = read();
  // 1.3 倍：与「设置 → 外观 → 按钮大小」滑杆写的是同一个 --dsc-btn-scale，
  // 等价于 appearance.ts 的 applyButtonScale(1.3)
  document.documentElement.style.setProperty('--dsc-btn-scale', '1.3');
  await wait(500);
  const at130 = read();
  // dsh 的对应值（packages/client/ui-chat/src/client/chat/MessageIconActions.module.css）：
  //   .actions 行高 28px(:9)、gap 8px(:8)；.action 框 28px(:67-68)、内距 6px(:69)；
  //   .action svg 15px(:80-81)，助手那条（data-clock='end'）17px(:84-87)。
  const dsh = { row: 28, gap: 8, box: 28, glyph: 15, glyphAssistant: 17 };
  const boxOf = (x) => x === null ? null : x.box.w;
  const svgOf = (x) => x === null || x.svg === null ? null : x.svg.w;
  return {
    case: 'buttons',
    dsh,
    ruleText: ruleTextOf('.meta-btn').concat(ruleTextOf('.user-turn .user-act'), ruleTextOf('.round-foot .user-act')),
    at100,
    at130,
    // 改后口径：三处按钮的框都 ≥ 28px，助手操作条的图标 ≥ 17px，气泡下与页脚的图标 ≥ 15px
    at100BoxOk: at100.metaBtns.every((x) => x.box.w >= dsh.box) && boxOf(at100.userEdit) >= dsh.box && boxOf(at100.fork) >= dsh.box,
    at100GlyphOk: svgOf(at100.metaBtns[0]) >= dsh.glyphAssistant && svgOf(at100.userEdit) >= dsh.glyph && svgOf(at100.fork) >= dsh.glyph,
    gapOk: at100.metaGap === dsh.gap + 'px',
    // 1.3 倍：三个框都跟着变大（≈ 28 × 1.3 = 36.4px）
    scaled: at130.metaBtns.every((x) => x.box.w > at100.metaBtns[0].box.w + 2)
      && boxOf(at130.userEdit) > boxOf(at100.userEdit) + 2
      && boxOf(at130.fork) > boxOf(at100.fork) + 2,
    scaledNumbers: {
      meta: [at100.metaBtns[0].box.w, at130.metaBtns[0].box.w],
      userEdit: [boxOf(at100.userEdit), boxOf(at130.userEdit)],
      fork: [boxOf(at100.fork), boxOf(at130.fork)],
      metaGlyph: [svgOf(at100.metaBtns[0]), svgOf(at130.metaBtns[0])],
    },
  };
})()
'@)

# 2) 折叠修复：两条「形状一模一样」的会话往返，展开态靠 fold-state 存档活下来。
#    路径由脚本在循环里拼进来（会话文件名是随机 id，这里不该猜）。
$foldBody = @'

(async () => {
  const t0 = Date.now();
  const steps = [];
  const call = async (method, args, ms) => {
    const result = await Promise.race([
      window.dsc.invoke(method, args).then(() => 'ok').catch((e) => 'err:' + String(e)),
      wait(ms).then(() => 'timeout'),
    ]);
    steps.push({ name: method, result, ms: Date.now() - t0 });
    return result;
  };
  const summaryOf = (b) => {
    const el = b.querySelector('.think-summary-text');
    return el === null ? '' : el.textContent;
  };
  const wrap = (b) => b === null || b === undefined ? null : ({
    open: b.classList.contains('open'),
    bodyInDom: b.querySelector('.think-body') !== null,
    summary: summaryOf(b),
  });
  // 每一步都把当时 DOM 里全部折叠条列出来（可能不止一条：换会话的重放是分批到的）
  const listBlocks = () => blocks().map((b) => ({ summary: summaryOf(b).slice(0, 3), open: b.classList.contains('open') }));
  // 等这一条会话的折叠条确实就位：只剩一条、且摘要的开头就是这条会话的标签
  const settle = async (tag, ms) => {
    const hit = await waitFor(() => {
      const list = blocks();
      return list.length === 1 && summaryOf(list[0]).indexOf(tag) === 0 ? list[0] : null;
    }, ms);
    await wait(500);
    return hit;
  };
  const rows = () => Array.from(document.querySelectorAll('.entry-row'))
    .map((r) => (r.firstElementChild === null ? '?' : r.firstElementChild.className)).join(',');
  const ready = await waitFor(() => blocks().length >= 1, 25000);
  if (ready === null) return { case: 'fold', error: '没等到思考折叠条' };
  const self0 = await settle('会话甲', 12000);
  if (self0 === null) return { case: 'fold', error: '会话甲的思考折叠条没就位', listBlocks: listBlocks() };
  steps.push({ name: 'ready', blocks: blocks().length, ms: Date.now() - t0 });
  // 1) 在会话甲里把思考折叠条点开
  if (self0.classList.contains('open')) { self0.querySelector('.think-head').click(); await wait(400); }
  self0.querySelector('.think-head').click();
  await wait(600);
  // 打个标记：换会话以后如果还找得到这个 DOM 元素，说明 React 是「复用实例」而不是重挂
  self0.dataset.fix2MarkA = 'in-self';
  const beforeSwitch = wrap(self0);
  // 2) 切到会话乙（形状与甲完全一样），到那边先什么都不点，看它初始是展开还是折叠
  await call('openSession', [OTHER], 9000);
  const other0 = await settle('会话乙', 12000);
  steps.push({ name: 'switchedToOther', ok: other0 !== null, blocks: blocks().length, ms: Date.now() - t0 });
  const reuseAToB = document.querySelectorAll('[data-fix2-mark-a]').length;
  const inOther = wrap(other0);
  const otherList = listBlocks();
  const rowsInOther = rows();
  // 3) 把会话乙这一条弄成「折叠」：复用实例的话，这一步改的就是实例状态，
  //    切回会话甲时会被它顶掉（fold-state 的存档根本读不到）
  if (other0 !== null) {
    if (other0.classList.contains('open')) { other0.querySelector('.think-head').click(); await wait(500); }
    other0.dataset.fix2MarkB = 'in-other';
  }
  const otherForcedCollapsed = wrap(other0);
  // 4) 切回会话甲：同一份 jsonl 再重放一遍
  await call('openSession', [SELF], 9000);
  const back0 = await settle('会话甲', 12000);
  steps.push({ name: 'backToSelf', ok: back0 !== null, blocks: blocks().length, ms: Date.now() - t0 });
  await wait(900);
  const afterReplay = wrap(back0);
  return {
    case: 'fold',
    elapsedMs: Date.now() - t0,
    steps,
    switchedToOther: other0 !== null,
    backToSelf: back0 !== null,
    beforeSwitch,
    inOther,
    otherForcedCollapsed,
    afterReplay,
    otherList,
    rowsInOther,
    // 两次换会话分别是「复用实例」还是「重挂」：标记还在 = 复用（有 bug 时的样子）
    reuseAToB,
    reuseBToA: document.querySelectorAll('[data-fix2-mark-b]').length,
    // 验收口径：会话甲里展开的那一条，切走再切回来仍然展开
    expandedSurvived: beforeSwitch !== null && beforeSwitch.open === true
      && afterReplay !== null && afterReplay.open === true,
    summaryStable: beforeSwitch !== null && afterReplay !== null && afterReplay.summary === beforeSwitch.summary,
  };
})()
'@

# 3) 流式滚动（暂停）：假端点边吐边撑高，探针往上翻，500ms（实际观察 1.5 秒）内不许被拽回底部。
$scrollPauseEval = ($head + @'

(async () => {
  await waitFor(() => chat() !== null, 20000);
  await wait(1500);
  await window.dsc.invoke('submit', ['请慢慢写一段很长的回复，我要在它往外写的时候往上翻历史。', undefined]);
  const ready = await waitFor(() => {
    const c = chat();
    return c !== null && c.scrollHeight - c.clientHeight > 300 && liveText() !== null ? true : null;
  }, 40000);
  if (ready === null) return { case: 'scroll-paused', error: '没等到流式正文把滚动容器撑过一屏' };
  await wait(600);
  const box = chat();
  const before = { scrollTop: Math.round(box.scrollTop), gap: gapToBottom(), scrollHeight: box.scrollHeight, clientHeight: box.clientHeight };
  // 模拟「用户主动往上滚」：先派一个真实的滚轮事件（deltaY < 0 = 往上），
  // 再把 scrollTop 真的挪上去——合成事件不会真的滚，所以两步都做。
  box.dispatchEvent(new WheelEvent('wheel', { deltaY: -420, bubbles: true, cancelable: true }));
  box.scrollTop = Math.max(0, box.scrollTop - 420);
  const samples = [];
  for (let i = 0; i < 15; i += 1) {
    await wait(100);
    samples.push({ t: (i + 1) * 100, scrollTop: Math.round(chat().scrollTop), gap: gapToBottom(), scrollHeight: chat().scrollHeight });
  }
  const firstFive = samples.slice(0, 5);
  const last = samples[samples.length - 1];
  return {
    case: 'scroll-paused',
    before,
    afterWheel: { scrollTop: Math.round(chat().scrollTop), gap: gapToBottom() },
    samples,
    // 验收口径：500ms（前五帧）内一次都没有回到贴底
    notPulledBack500: firstFive.every((s) => s.gap > 32),
    // 整个 1.5 秒窗口都没被拽回去（内容还在长，所以 gap 只会越来越大）
    notPulledBackAll: samples.every((s) => s.gap > 32),
    contentKeptGrowing: last.scrollHeight > before.scrollHeight,
    scrollTopKept: Math.abs(last.scrollTop - samples[0].scrollTop) < 40,
    // 「回到底部」按钮在这一刻应该出现（暂停跟随的可见凭据）
    toBottomButton: document.querySelector('.chat-to-bottom') !== null,
    buttonText: document.querySelector('.chat-to-bottom') === null ? null : document.querySelector('.chat-to-bottom').textContent,
  };
})()
'@)

# 4) 流式滚动（恢复）：滚回底部就恢复跟随；再暂停一次、点「回到底部」也要恢复。
$scrollResumeEval = ($head + @'

(async () => {
  await waitFor(() => chat() !== null, 20000);
  await wait(1500);
  await window.dsc.invoke('submit', ['请慢慢写一段很长的回复，我要在它往外写的时候往上翻历史。', undefined]);
  const ready = await waitFor(() => {
    const c = chat();
    return c !== null && c.scrollHeight - c.clientHeight > 300 && liveText() !== null ? true : null;
  }, 40000);
  if (ready === null) return { case: 'scroll-resumed', error: '没等到流式正文把滚动容器撑过一屏' };
  await wait(600);
  const pause = async () => {
    const box = chat();
    box.dispatchEvent(new WheelEvent('wheel', { deltaY: -420, bubbles: true, cancelable: true }));
    box.scrollTop = Math.max(0, box.scrollTop - 420);
    await wait(300);
    return { scrollTop: Math.round(box.scrollTop), gap: gapToBottom() };
  };
  const sample = async (count) => {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      await wait(100);
      out.push({ t: (i + 1) * 100, scrollTop: Math.round(chat().scrollTop), gap: gapToBottom(), scrollHeight: chat().scrollHeight });
    }
    return out;
  };
  // ── 第一段：往上翻（暂停），再滚回底部（恢复跟随） ──
  const pausedAt = await pause();
  const pausedSamples = await sample(10);
  const box = chat();
  box.scrollTop = box.scrollHeight;
  const atBottom = { scrollTop: Math.round(box.scrollTop), gap: gapToBottom(), scrollHeight: box.scrollHeight };
  const followSamples = await sample(30);
  const followLast = followSamples[followSamples.length - 1];
  const scrolledBackResumed = followLast.gap <= 32
    && followLast.scrollHeight > atBottom.scrollHeight
    && followLast.scrollTop > atBottom.scrollTop;
  // ── 第二段：再往上翻一次，这回点「回到底部」 ──
  const pausedAgain = await pause();
  const button = document.querySelector('.chat-to-bottom');
  const clicked = button !== null;
  if (button !== null) button.click();
  const buttonAtBottom = { scrollTop: Math.round(chat().scrollTop), gap: gapToBottom(), scrollHeight: chat().scrollHeight };
  const buttonSamples = await sample(30);
  const buttonLast = buttonSamples[buttonSamples.length - 1];
  return {
    case: 'scroll-resumed',
    pausedAt,
    pausedSamples,
    pausedStayedUp: pausedSamples.every((s) => s.gap > 32),
    atBottom,
    followSamples,
    // 验收口径：滚回底部以后新块到来时 scrollTop 跟着长，且始终贴底（gap ≤ 32）
    scrolledBackResumed,
    resumedGap: followLast.gap,
    resumedScrollTopGrowth: followLast.scrollTop - atBottom.scrollTop,
    resumedHeightGrowth: followLast.scrollHeight - atBottom.scrollHeight,
    // 「回到底部」按钮：点一下就恢复跟随
    pausedAgain,
    buttonClicked: clicked,
    buttonText: button === null ? null : button.textContent,
    buttonAtBottom,
    buttonResumed: clicked && buttonLast.gap <= 32 && buttonLast.scrollTop > buttonAtBottom.scrollTop,
    buttonSamplesTail: buttonSamples.slice(-5),
  };
})()
'@)

# ── 用例表 ─────────────────────────────────────────────────────────────────────
$cases = [ordered]@{
  'buttons'        = @{ delay = 17000; lead = 7000;  live = $false; eval = $buttonsEval;     session = 'btn' }
  'fold'           = @{ delay = 42000; lead = 18000; live = $false; eval = $null;            session = 'foldA' }
  'scroll-paused'  = @{ delay = 44000; lead = 30000; live = $true;  eval = $scrollPauseEval;  session = 'live' }
  'scroll-resumed' = @{ delay = 46000; lead = 30000; live = $true;  eval = $scrollResumeEval; session = 'live' }
}

$script:server = $null
function Stop-Fake {
  if ($script:server -ne $null) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue; $script:server = $null }
}
function Start-Fake {
  Stop-Fake
  $script:server = Start-Process -FilePath 'node' -ArgumentList (Join-Path $shots 'fix2-fake-llm.mjs'), $port -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 900
}

try {
  $env:FIX2_THEME = 'dark'
  $env:FIX2_FAKE_PORT = [string]$port
  node (Join-Path $shots 'fix2-seed.mjs') | Out-Null
  $sessions = Get-Content (Join-Path $shots 'fix2-sessions.json') -Raw | ConvertFrom-Json

  foreach ($name in $cases.Keys) {
    if ($Only -ne 'all' -and $Only -ne $name) { continue }
    $spec = $cases[$name]

    # 跨重放那条用例要用两条会话的绝对路径，在这里拼进预跑脚本
    $caseEval = $spec.eval
    if ($name -eq 'fold') {
      $consts = "`nconst SELF = " + ($sessions.foldA | ConvertTo-Json -Compress) +
        ";`nconst OTHER = " + ($sessions.foldB | ConvertTo-Json -Compress) + ";`n"
      $caseEval = $head + $consts + $foldBody
    }

    if ($spec.live) { Start-Fake } else { Stop-Fake }

    $env:DSC_DESKTOP_USER_DATA = Join-Path $fix2Home 'electron-userdata'
    $env:USERPROFILE = $fix2Home
    $env:HOME = $fix2Home
    $env:DSC_HOME = Join-Path $fix2Home '.dsc'
    $env:FIX2_FAKE_KEY = 'sk-selfcheck-fake'
    $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
    # ?reveal=1：把 hover 才出现的消息操作条常驻，静态截图才拍得到
    $env:DSC_DESKTOP_SEARCH = 'reveal=1'
    $env:DSC_RESUME_SESSION = $sessions.($spec.session)
    $env:DSC_DESKTOP_SHOT = Join-Path $shots "$($prefix)$name.png"
    $env:DSC_DESKTOP_SHOT_DELAY = [string]$spec.delay
    $env:DSC_DESKTOP_SHOT_EVAL_LEAD = [string]$spec.lead
    $env:DSC_DESKTOP_SHOT_EVAL = $caseEval

    $log = Join-Path $shots "$($prefix)$name.log"
    Write-Output "=== $($prefix)$name ==="
    & $electron $entry *>&1 | Out-File -FilePath $log -Encoding utf8
    Select-String -Path $log -Pattern '预跑脚本完成|预跑脚本失败|已写出' | ForEach-Object { '  ' + $_.Line }
  }
} finally {
  Stop-Fake
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_SEARCH,
    Env:DSC_DESKTOP_USER_DATA, Env:USERPROFILE, Env:HOME, Env:DSC_HOME,
    Env:FIX2_THEME, Env:FIX2_FAKE_PORT, Env:FIX2_FAKE_KEY -ErrorAction SilentlyContinue
}

# ── 跑后：真实 ~/.dsc 的指纹比对 ───────────────────────────────────────────────
$fingerAfter = Get-DscFingerprint $realDsc
Set-Content -LiteralPath (Join-Path $shots 'fix2-realhome-after.txt') -Value $fingerAfter -Encoding utf8
$statBefore = Get-DscFingerprintStat $fingerBefore
$statAfter = Get-DscFingerprintStat $fingerAfter
$same = $fingerBefore -eq $fingerAfter
if (-not $same) {
  $diff = Compare-Object ($fingerBefore -split "`n") ($fingerAfter -split "`n") |
    ForEach-Object { $_.SideIndicator + ' ' + $_.InputObject }
  Set-Content -LiteralPath (Join-Path $shots 'fix2-realhome-diff.txt') -Value $diff -Encoding utf8
}
Write-Output ('真实 ~/.dsc 指纹比对：相同=' + $same + ' 文件数=' + $statBefore.files + '→' + $statAfter.files +
  ' 总字节=' + $statBefore.bytes + '→' + $statAfter.bytes)
Write-Output ('真实 ~/.dsc 路径：' + $realDsc)
Write-Output '全部完成'





