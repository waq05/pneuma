# 提问卡「一批一次挂出」的端到端自检（真宿主 + 真桌面端 + 假模型端点）。
#
# 验的是改版后的行为：一次 ask_user 问 3 题时只有**一张卡**、卡里装着 3 道题
# （不是三张卡顺序出现），题与题之间可以来回切换且草稿不丢，统一提交之后卡片消失、
# 假端点按题序收到 3 条各不相同的答案。
#
# 关于渲染层两版 DOM：桌面端同时在改，TaskDock.tsx 有「一卡列出全部题目行」
# （.ask-item / data-ask-item / .ask-item-head）与「向导式一题一面板」
# （.ask-panel / data-ask-index / .ask-text + 翻页器 data-ask-page）两种口径。
# 探针不假设是哪一版：题目文本、当前题号、切题动作都从统一的访问器走，
# 量的数字里带 layout 字段说明这次测到的是哪一版。
#
# 隔离怎么做（一个字节都不写真实的 ~/.dsc）：
#   DSC_HOME              → shots/ask3-home/.dsc（宿主的配置目录，path-policy.ts:20 认这个）
#   USERPROFILE           → shots/ask3-home（宿主里几十处 join(homedir(), '.dsc', ...) 认这个；
#                          父环境没有 HOME，Windows 上 node 的 os.homedir() 与 Electron 的
#                          app.getPath('home') 都先看 USERPROFILE，所以只设它就够——
#                          本脚本刻意不碰 $HOME 那个只读自动变量）
#   DSC_DESKTOP_USER_DATA → shots/ask3-home/electron-userdata（Electron 自己的 userData）
# 跑前跑后对真实家目录的 .dsc（逐个 SHA256）与 .dsh（长度+改动时间）做指纹比对。
# 模型走本机假端点（ask2-fake-llm.mjs 的 ask3 / ask1 模式）：不发真请求、不花钱。
#
# 用法（在 D:\dsc\desktop 下，或直接给绝对路径）：
#   pwsh -NoProfile -File D:\dsc\desktop\shots\ask3-shots.ps1              # 全部用例
#   pwsh -NoProfile -File D:\dsc\desktop\shots\ask3-shots.ps1 -Only ask3-batch-submit

param([string]$Only = 'all')

$ErrorActionPreference = 'Stop'
$script:runStart = Get-Date
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$script:failures = 0
function Assert([string]$label, [bool]$condition, [string]$extra = '') {
  if ($condition) {
    Write-Output "PASS  $label"
    return
  }
  $script:failures += 1
  $tail = $extra -eq '' ? '' : " → $extra"
  Write-Output "FAIL  $label$tail"
}

$shots = 'D:\dsc\desktop\shots'
$desktop = (Resolve-Path (Join-Path $shots '..')).Path
$electron = Join-Path $desktop 'node_modules\.bin\electron.cmd'
$isoProfile = Join-Path $shots 'ask3-home'
$isoDsc = Join-Path $isoProfile '.dsc'
$isoUserData = Join-Path $isoProfile 'electron-userdata'
$fake = Join-Path $shots 'ask2-fake-llm.mjs'

# ── 这次测的是哪一版渲染层（别的组同时在改，报告里要能对上号）──────────────────
$rendererSource = Join-Path $desktop 'src\renderer\TaskDock.tsx'
$rendererBundle = Get-ChildItem (Join-Path $desktop 'out\renderer\assets\index-*.js') -ErrorAction SilentlyContinue | Select-Object -First 1
$revision = @(
  "TaskDock.tsx mtime=$((Get-Item $rendererSource).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')) sha256=$((Get-FileHash $rendererSource -Algorithm SHA256).Hash)"
  if ($null -ne $rendererBundle) { "bundle=$($rendererBundle.Name) mtime=$($rendererBundle.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')) sha256=$((Get-FileHash $rendererBundle.FullName -Algorithm SHA256).Hash)" }
)
$revision | Set-Content (Join-Path $shots 'ask3-renderer-revision.txt') -Encoding utf8NoBOM
$revision | ForEach-Object { Write-Output "渲染层版本：$_" }

# ── 真实家目录指纹（跑完要比对，证明隔离真生效）────────────────────────────────
# 注意：$realProfile 必须在覆盖 $env:USERPROFILE 之前取。
$realProfile = $env:USERPROFILE
function Get-DscFingerprint([string]$root) {
  if (-not (Test-Path -LiteralPath $root)) { return @() }
  return Get-ChildItem -LiteralPath $root -File -Recurse -Force -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    ForEach-Object {
      $hash = ''
      try { $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } catch { $hash = 'UNREADABLE' }
      "$($_.FullName.Substring($root.Length))|$($_.Length)|$hash"
    }
}
function Get-DshFingerprint([string]$root) {
  if (-not (Test-Path -LiteralPath $root)) { return @() }
  return Get-ChildItem -LiteralPath $root -File -Recurse -Force -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    ForEach-Object { "$($_.FullName.Substring($root.Length))|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" }
}
$realDsc = Join-Path $realProfile '.dsc'
$realDsh = Join-Path $realProfile '.dsh'
$dscBefore = Get-DscFingerprint $realDsc
$dshBefore = Get-DshFingerprint $realDsh
$dscBefore | Set-Content (Join-Path $shots 'ask3-realhome-dsc-before.txt') -Encoding utf8NoBOM
$dshBefore | Set-Content (Join-Path $shots 'ask3-realhome-dsh-before.txt') -Encoding utf8NoBOM
Write-Output "指纹基线：$realDsc 有 $($dscBefore.Count) 个文件；$realDsh 有 $($dshBefore.Count) 个文件"

# ── 隔离环境 ─────────────────────────────────────────────────────────────────
# config.yaml 每个用例重写一次：每个用例用独立端口（下面 $cases 的 port），
# 一个端口被上一轮留下的 TIME_WAIT / 僵尸监听占住时，不至于把后面几个用例一起拖垮。
function Write-IsoConfig([int]$fakePort) {
  @"
# 自检专用配置：一个指向本机假端点的 provider（不联网、不花钱）
default:
  provider: fake
  model: fake-ask
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:$fakePort/v1
    apiKeyEnv: DSC_FAKE_KEY
    models:
      - id: fake-ask
        name: Fake Ask
        contextWindow: 128000
        maxTokens: 4096
"@ | Set-Content -Path (Join-Path $isoDsc 'config.yaml') -Encoding utf8NoBOM
}
Remove-Item -Recurse -Force $isoProfile -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $isoDsc, (Join-Path $isoDsc 'sessions'), (Join-Path $isoDsc 'usage') | Out-Null
$env:DSC_FAKE_KEY = 'sk-selfcheck-fake'
$env:DSC_HOME = $isoDsc
$env:USERPROFILE = $isoProfile
$env:DSC_DESKTOP_USER_DATA = $isoUserData
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'

# ── 假端点进程 ───────────────────────────────────────────────────────────────
# 输出重定向到 ask3-fake-<用例>.log：假端点要是没绑上端口（EADDRINUSE），
# 这张日志就是第一现场——请求到没到、绑定失败没有，一眼能看出来。
$script:server = $null
function Start-Fake([string]$mode, [int]$fakePort, [string]$name) {
  if ($script:server -ne $null) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300 }
  $log = Join-Path $shots "ask3-fake-$name.log"
  $script:server = Start-Process -FilePath 'node' -ArgumentList $fake, $mode, $fakePort -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  Start-Sleep -Milliseconds 800
  $alive = -not $script:server.HasExited
  Write-Output "  假端点 $mode @127.0.0.1:$fakePort（进程 $(if ($alive) { '存活' } else { "已退出 code=$($script:server.ExitCode)" })）"
}

# ── 探针头（每个用例都拼这一段）：全部走 DOM + 快照 ───────────────────────────
# 输入框赋值必须用原型上的 value setter + input 事件，React 才认得出这是一次真实编辑。
$head = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => document.querySelector(s);
const all = (s) => Array.from(document.querySelectorAll(s));
const text = (node) => (node === null || node === undefined ? null : node.textContent);
const card = () => q('.ask-card');
// 两版 DOM 的二选一：向导版有 .ask-panel，列表版有 [data-ask-item]。
const layout = () => {
  if (q('.ask-panel') !== null) return 'wizard';
  if (all('[data-ask-item]').length > 0) return 'list';
  return card() === null ? 'none' : 'unknown';
};
const curIndex = () => {
  const panel = q('.ask-panel');
  if (panel !== null) return Number(panel.getAttribute('data-ask-index'));
  const open = q('.ask-item.open');
  return open === null ? null : Number(open.getAttribute('data-ask-item'));
};
const curText = () => {
  const wizard = q('.ask-panel .ask-text');
  if (wizard !== null) return text(wizard);
  const row = q('.ask-item.open .ask-item-text');
  return row === null ? null : text(row);
};
const snap = () => {
  const el = card();
  if (el === null) return null;
  const input = q('.ask-input');
  const primary = q('.ask-submit');
  return {
    layout: layout(),
    count: el.getAttribute('data-ask-count'),
    index: curIndex(),
    text: curText(),
    progress: text(q('.ask-progress')),
    panelsInDom: all('.ask-panel, .ask-item').length,
    inputValue: input === null ? null : input.value,
    picked: all('.ask-option.picked').map((n) => text(n.querySelector('.ask-option-label'))),
    primary: text(primary),
    primaryDisabled: primary === null ? null : primary.disabled,
    hint: text(q('.ask-hint')),
  };
};
const waitCard = async (tries = 30) => {
  for (let i = 0; i < tries; i += 1) { if (card() !== null && curText() !== null) return card(); await wait(250); }
  return null;
};
const waitCardOf = async (needle, tries = 30) => {
  for (let i = 0; i < tries; i += 1) {
    const el = card();
    if (el !== null && String(curText() ?? '').includes(needle)) return el;
    await wait(250);
  }
  return null;
};
const waitCardGone = async (tries = 40) => {
  for (let i = 0; i < tries; i += 1) { if (card() === null) return true; await wait(250); }
  return false;
};
const clickOption = (index) => {
  const list = all('.ask-option');
  if (list[index] === undefined) return false;
  list[index].click();
  return true;
};
const clickRow = (index) => {
  const head = q('.ask-item[data-ask-item="' + String(index) + '"] .ask-item-head');
  if (head === null) return false;
  head.click();
  return true;
};
const clickPage = (dir) => {
  const button = q('[data-ask-page="' + dir + '"]');
  if (button === null || button.disabled) return false;
  button.click();
  return true;
};
// 切到第 index 题：向导版按翻页器一步步走，列表版点行头。两版都走同一个入口。
const goTo = async (index) => {
  for (let i = 0; i < 12; i += 1) {
    const now = curIndex();
    if (now === index) return true;
    if (now === null || layout() === 'list') { if (!clickRow(index)) return false; }
    else if (!clickPage(now < index ? 'next' : 'prev')) return false;
    await wait(220);
  }
  return curIndex() === index;
};
// 依次切到给定的几题，把每一题看到的正文与「第几题/共几题」记下来。
const walk = async (stops) => {
  const seen = [];
  for (const target of stops) {
    const ok = await goTo(target);
    if (ok) await wait(150);
    seen.push({ want: target, reached: ok, text: ok ? curText() : null, progress: ok ? text(q('.ask-progress')) : null });
  }
  return seen;
};
const typeInput = (value) => {
  const input = q('.ask-input');
  if (input === null) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
};
const clickPrimary = () => {
  const button = q('.ask-submit');
  if (button === null || button.disabled) return false;
  button.click();
  return true;
};
const echoText = () => {
  const hit = all('.entry-text .markdown').map((n) => n.innerText).filter((body) => body.includes('自检回显'));
  return hit.length === 0 ? null : hit[hit.length - 1];
};
const waitEcho = async (tries = 30) => {
  for (let i = 0; i < tries; i += 1) {
    const body = echoText();
    if (body !== null) return body;
    await wait(250);
  }
  return null;
};
const toBottom = () => { const chat = q('.chat'); if (chat !== null) chat.scrollTop = chat.scrollHeight; };
// 发一轮对话：submit 要是被宿主拒了（模型没配好 / 会话没起），这里必须留下原因。
const submitTurn = async (line) => {
  try {
    await window.dsc.invoke('submit', [line, undefined]);
    return null;
  } catch (error) {
    return String(error);
  }
};
// 卡片没出现时的现场。
const diag = () => {
  const entries = all('.entry-text');
  const last = entries.length === 0 ? null : text(entries[entries.length - 1]);
  return {
    cards: all('.ask-card').length,
    entries: entries.length,
    entriesWithEcho: all('.entry-text .markdown').filter((n) => n.innerText.includes('自检回显')).length,
    lastEntry: last === null ? null : last.slice(0, 160),
    hasDsc: typeof window.dsc !== 'undefined',
    hasOnSnapshot: typeof window.dsc.onSnapshot === 'function',
  };
};
// 直接盯宿主推下来的快照：挂着的那张提问卡 id 是否全程不变、questions 有几题。
// 这是契约层的证据——DOM 只能说界面画成什么样，快照能说宿主到底挂了一批还是逐题换卡。
const watchSnapshots = () => {
  if (typeof window.dsc.onSnapshot !== 'function') return null;
  const seen = [];
  window.dsc.onSnapshot((s) => {
    const pq = s === null || s === undefined || s.surfaces === undefined ? null : s.surfaces.pendingQuestion;
    seen.push({
      id: pq === null || pq === undefined ? null : String(pq.id),
      len: pq === null || pq === undefined || !Array.isArray(pq.questions) ? null : pq.questions.length,
      count: pq === null || pq === undefined ? null : String(pq.question ?? '').slice(0, 12),
    });
  });
  return seen;
};
const snapSummary = (seen) => {
  if (seen === null) return null;
  const ids = []; const lens = [];
  for (const item of seen) {
    if (!ids.includes(item.id)) ids.push(item.id);
    if (!lens.includes(item.len)) lens.push(item.len);
  }
  const pending = seen.filter((item) => item.id !== null);
  return {
    samples: seen.length,
    ids,
    lens,
    pendingSamples: pending.length,
    lastId: seen.length === 0 ? null : seen[seen.length - 1].id,
  };
};
const ASK = ['这次只改对话区', '只改对话区（推荐）', '另加一条兜底', '先按上面两条做'];
'@

# 1) 一批同屏：一次问 3 题时只有一张卡，同一张卡里能翻到 3 道题
$listEval = ($head + @'

(async () => {
  await wait(600);
  const seen = watchSnapshots();
  const submitError = await submitTurn('这次要动的范围我拿不准，你一次问清楚。');
  const el = await waitCardOf(ASK[0]);
  const opened = snap();
  // 卡片数要在卡片还挂着的时候数：提交之后整张卡会撤掉，那时再数就永远是 0。
  const cardCount = all('.ask-card').length;
  const walked = await walk([0, 1, 2]);
  await goTo(0);
  await wait(200);
  const backToFirst = snap();
  const cardCountAfterWalk = all('.ask-card').length;
  toBottom();
  return {
    case: 'batch-list',
    submitError,
    cardAppeared: el !== null,
    cardCount,
    cardCountAfterWalk,
    opened,
    walked,
    backToFirst,
    textsSeen: walked.map((s) => s.text),
    snapshots: snapSummary(seen),
    diag: diag(),
  };
})()
'@)

# 2) 切题不丢草稿：第 1 题点选项 → 跳第 3 题写字 → 回第 1 题看选项 → 再回第 3 题看输入框
$switchEval = ($head + @'

(async () => {
  await wait(600);
  const seen = watchSnapshots();
  const submitError = await submitTurn('这次要动的范围我拿不准，你一次问清楚。');
  const el = await waitCardOf(ASK[0]);
  const opened = snap();
  const cardCount = all('.ask-card').length;
  clickOption(0);
  await wait(400);
  // 单选点完会自动推进到下一题：这一张快照说的是「已经走到第 2 题了」，
  // 第 1 题那份勾要在切回去看（backToQ1）才算数。
  const afterPick = snap();
  await goTo(2);
  await wait(200);
  typeInput('没有，先按上面两条做');
  await wait(300);
  const q3Typed = snap();
  await goTo(0);
  await wait(300);
  const backToQ1 = snap();
  await goTo(2);
  await wait(300);
  const backToQ3 = snap();
  toBottom();
  return {
    case: 'batch-switch',
    submitError,
    cardAppeared: el !== null,
    cardCount,
    opened,
    afterPick,
    q3Typed,
    backToQ1,
    backToQ3,
    advancedAfterPick: afterPick.index === 1,
    draftKept: backToQ3.inputValue === '没有，先按上面两条做',
    q1MarkKept: (backToQ1.picked ?? []).join('、') === '只改对话区（推荐）',
    onlyOnePanel: backToQ3.panelsInDom === 1,
    snapshots: snapSummary(seen),
    diag: diag(),
  };
})()
'@)

# 3) 统一提交：三题各答各的 → 最后一题按主按钮＝一次交回 3 条答案 → 卡片消失
#    假端点把宿主交回去的工具结果原样回显，回显里三条答案必须按题序、各出现一次。
$submitEval = ($head + @'

(async () => {
  await wait(600);
  const seen = watchSnapshots();
  const submitError = await submitTurn('这次要动的范围我拿不准，你一次问清楚。');
  const el = await waitCardOf(ASK[0]);
  const opened = snap();
  const cardCount = all('.ask-card').length;
  clickOption(0);
  await wait(400);
  const q1done = snap();
  await goTo(1);
  await wait(200);
  typeInput('以正文列宽为准，另加一条兜底');
  await wait(300);
  const q2done = snap();
  await goTo(2);
  await wait(200);
  typeInput('没有，先按上面两条做');
  await wait(300);
  const typed = snap();
  await goTo(0);
  await wait(250);
  const peekQ1 = snap();
  await goTo(2);
  await wait(250);
  const backQ3 = snap();
  const submitted = clickPrimary();
  const gone = await waitCardGone();
  const echoed = await waitEcho();
  toBottom();
  await wait(400);
  const answers = ['只改对话区（推荐）', '另加一条兜底', '先按上面两条做'];
  const body = echoed === null ? '' : echoed;
  const order = answers.map((s) => body.indexOf(s));
  return {
    case: 'batch-submit',
    submitError,
    cardAppeared: el !== null,
    cardCount,
    opened,
    q1done,
    q2done,
    typed,
    peekQ1,
    backQ3,
    draftKept: backQ3.inputValue === '没有，先按上面两条做',
    submitted,
    cardGone: gone,
    echoOrder: order,
    orderOk: order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])),
    eachOnce: answers.map((s) => body.split(s).length - 1),
    cardCountAfter: all('.ask-card').length,
    echo: echoed,
    snapshots: snapSummary(seen),
    diag: diag(),
  };
})()
'@)

# 4) 单题不回归：一个问题时卡里只有 1 题、没有翻页/切题控件，主按钮直接就是「提交」
$singleEval = ($head + @'

(async () => {
  await wait(600);
  const seen = watchSnapshots();
  const submitError = await submitTurn('只有一个问题，你问吧。');
  const el = await waitCardOf(ASK[0]);
  const beforePick = snap();
  // 卡片数、面板数都要在卡片还挂着的时候数（提交之后整张卡撤掉，再数就是 0）。
  const cardCount = all('.ask-card').length;
  const panelsAtStart = all('.ask-panel, .ask-item').length;
  const blockedWhileEmpty = !clickPrimary();
  const pageControls = all('[data-ask-page], .ask-item-caret').length;
  clickOption(0);
  await wait(400);
  const afterPick = snap();
  clickPrimary();
  const gone = await waitCardGone();
  const echoed = await waitEcho();
  toBottom();
  return {
    case: 'single',
    submitError,
    cardAppeared: el !== null,
    cardCount,
    panelsInDom: panelsAtStart,
    pageControls,
    beforePick,
    blockedWhileEmpty,
    afterPick,
    cardGone: gone,
    echoHasAnswer: String(echoed ?? '').includes('只改对话区（推荐）'),
    echo: echoed,
    snapshots: snapSummary(seen),
    diag: diag(),
  };
})()
'@)

$cases = [ordered]@{
  'ask3-batch-list'   = @{ mode = 'ask3'; port = 18941; delay = 30000; lead = 22000; eval = $listEval }
  'ask3-batch-switch' = @{ mode = 'ask3'; port = 18942; delay = 30000; lead = 22000; eval = $switchEval }
  'ask3-batch-submit' = @{ mode = 'ask3'; port = 18943; delay = 32000; lead = 24000; eval = $submitEval }
  'ask3-single'       = @{ mode = 'ask1'; port = 18944; delay = 30000; lead = 22000; eval = $singleEval }
}

# 从日志里取回预跑脚本的返回值（主进程把 JSON 打在 [selfcheck] 预跑脚本完成：后面）
function Get-PreRun([string]$log) {
  $line = Select-String -Path $log -Pattern '预跑脚本完成：' | Select-Object -Last 1
  if ($null -eq $line) { return $null }
  $text = $line.Line
  $json = $text.Substring($text.IndexOf('预跑脚本完成：') + '预跑脚本完成：'.Length)
  try { return $json | ConvertFrom-Json } catch { return $null }
}

foreach ($name in $cases.Keys) {
  if ($Only -ne 'all' -and $Only -ne $name) { continue }
  $spec = $cases[$name]
  Write-IsoConfig $spec.port
  Start-Fake $spec.mode $spec.port $name
  $png = Join-Path $shots "$name.png"
  $log = Join-Path $shots "$name.log"
  $env:DSC_DESKTOP_SHOT = $png
  $env:DSC_DESKTOP_SHOT_DELAY = [string]$spec.delay
  $env:DSC_DESKTOP_SHOT_EVAL_LEAD = [string]$spec.lead
  $env:DSC_DESKTOP_SHOT_EVAL = $spec.eval
  Write-Output "=== $name ==="
  # 为什么不用 `& $electron ... | Out-File`：截完图 app.exit() 之后，Electron 里那个宿主
  # utilityProcess 可能还活着一小会儿，它继承了那条管道的写端，管道不 EOF、Out-File 就永远不返回
  # （本脚本第一次跑全程就卡死在这里，卡了十分钟）。改成 Start-Process + 自己轮询退出，
  # 输出直接写文件，跟不跟 EOF 没关系；再加一道到点强杀，自检不会挂在一次截图上。
  $stdoutFile = Join-Path $shots "$name.out"
  $log = Join-Path $shots "$name.log"
  Remove-Item $stdoutFile, $log -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath $electron -ArgumentList 'out\main\index.js' -WorkingDirectory $desktop -PassThru `
    -RedirectStandardOutput $stdoutFile -RedirectStandardError $log
  $deadline = (Get-Date).AddMilliseconds($spec.delay + 60000)
  while (-not $proc.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (-not $proc.HasExited) {
    Write-Output '  超时：electron 没自己退，按进程树强杀（只杀这一棵，不碰别人的 Electron）'
    & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
  }
  Start-Sleep -Milliseconds 400
  Select-String -Path $log -Pattern '页面加载完成|预跑脚本完成|预跑脚本失败|截图失败|页面加载失败' |
    ForEach-Object { '  ' + $_.Line } | Select-Object -First 6

  $data = Get-PreRun $log
  if ($null -eq $data) {
    Assert "$name 预跑脚本有返回值" $false "日志里没有可解析的预跑结果（假端点日志：$(Get-Content (Join-Path $shots "ask3-fake-$name.log") -Raw -ErrorAction SilentlyContinue)）"
    continue
  }
  if ($null -ne $data.submitError) { Write-Output "  submit 报错：$($data.submitError)" }
  Write-Output "  布局=$($data.opened.layout) 卡片数=$($data.cardCount) 批题数=$($data.opened.count) 同屏面板=$($data.opened.panelsInDom) 快照 id 数=$((@($data.snapshots.ids | Where-Object { $_ -ne $null })).Count) 快照 questions 长度=$($data.snapshots.lens -join '/')"
  if ($null -ne $data.diag -and -not $data.cardAppeared) {
    Write-Output "  现场：cards=$($data.diag.cards) entries=$($data.diag.entries) hasDsc=$($data.diag.hasDsc) last=$($data.diag.lastEntry)"
  }

  switch ($data.case) {
    'batch-list' {
      Assert '一批同屏：卡片出现了' ([bool]$data.cardAppeared)
      Assert '一批同屏：同屏只有 1 张卡（不是三张卡顺序出现）' ($data.cardCount -eq 1) "cardCount=$($data.cardCount)"
      Assert '一批同屏：data-ask-count=3（这张卡装着 3 题）' ($data.opened.count -eq '3') "count=$($data.opened.count)"
      Assert '一批同屏：同一张卡里能翻到 3 道题（题序正确）' (
        ([string]$data.textsSeen[0] -match '这次只改对话区') -and
        ([string]$data.textsSeen[1] -match '两条轨道的宽度') -and
        ([string]$data.textsSeen[2] -match '还有什么要我一并处理')
      ) "seen=$($data.textsSeen -join ' | ')"
      Assert '一批同屏：翻回第 1 题还是同一张卡' ($data.cardCountAfterWalk -eq 1 -and $data.backToFirst.count -eq '3') "afterWalk=$($data.cardCountAfterWalk)"
      Assert '快照：挂着的那张卡全程是同一个 id（视图稳定挂起）' ((@($data.snapshots.ids | Where-Object { $_ -ne $null })).Count -eq 1) "ids=$($data.snapshots.ids -join ',')"
      Assert '快照：挂着的视图带 questions 数组且长度=3' ($data.snapshots.lens -contains 3) "lens=$($data.snapshots.lens -join '/')"
    }
    'batch-switch' {
      Assert '切题：同屏只有 1 张卡、data-ask-count=3' ($data.cardCount -eq 1 -and $data.opened.count -eq '3') "card=$($data.cardCount) count=$($data.opened.count)"
      Assert '切题：第 1 题单选后自动推进到第 2 题' ([bool]$data.advancedAfterPick) "index=$($data.afterPick.index)"
      Assert '切题：第 3 题的字进了输入框' ($data.q3Typed.inputValue -eq '没有，先按上面两条做') "input=$($data.q3Typed.inputValue)"
      Assert '切题：切回第 1 题还带着刚才的勾' ([bool]$data.q1MarkKept) "picked=$(@($data.backToQ1.picked) -join '、')"
      Assert '切题：再切回第 3 题草稿还在' ([bool]$data.draftKept) "input=$($data.backToQ3.inputValue)"
      Assert '快照：三题作答期间视图 id 只有一个' ((@($data.snapshots.ids | Where-Object { $_ -ne $null })).Count -eq 1) "ids=$($data.snapshots.ids -join ',')"
    }
    'batch-submit' {
      Assert '提交：同屏只有 1 张卡、data-ask-count=3' ($data.cardCount -eq 1 -and $data.opened.count -eq '3') "card=$($data.cardCount) count=$($data.opened.count)"
      Assert '提交：第 1 题勾选、第 2 题写字各归各的' (
        ((@($data.peekQ1.picked) -join '、') -eq '只改对话区（推荐）') -and ($data.q2done.inputValue -eq '以正文列宽为准，另加一条兜底')
      ) "q1=$(@($data.peekQ1.picked) -join '、') q2=$($data.q2done.inputValue)"
      Assert '提交：切回来草稿仍在' ([bool]$data.draftKept) "input=$($data.backQ3.inputValue)"
      Assert '提交：最后一题按主按钮＝统一提交' ([bool]$data.submitted)
      Assert '提交：卡片消失、视图撤下' ([bool]$data.cardGone -and $data.cardCountAfter -eq 0) "gone=$($data.cardGone) after=$($data.cardCountAfter)"
      Assert '提交：回显里三条答案按题序齐全' ([bool]$data.orderOk) "order=$($data.echoOrder -join ',')"
      Assert '提交：三条答案各是各的（各出现 1 次）' ((@($data.eachOnce) -join ',') -eq '1,1,1') "eachOnce=$(@($data.eachOnce) -join ',')"
      Assert '快照：整批答完之前视图 id 一直只有一个，最后归 null' (
        (@($data.snapshots.ids | Where-Object { $_ -ne $null }).Count -eq 1) -and ($data.snapshots.lastId -eq $null)
      ) "ids=$($data.snapshots.ids -join ',') lastId=$($data.snapshots.lastId)"
      Assert '快照：中途挂着的视图 questions 长度一直是 3' ($data.snapshots.lens -contains 3) "lens=$($data.snapshots.lens -join '/')"
    }
    'single' {
      Assert '单题：卡片出现且只有 1 张' ([bool]$data.cardAppeared -and $data.cardCount -eq 1)
      Assert '单题：卡里只有 1 题' ($data.panelsInDom -eq 1) "panels=$($data.panelsInDom)"
      Assert '单题：没有翻页/切题控件' ($data.pageControls -eq 0) "pageControls=$($data.pageControls)"
      Assert '单题：没答之前主按钮是禁用的' ($data.beforePick.primaryDisabled -and [bool]$data.blockedWhileEmpty)
      Assert '单题：选完选项卡片撤下' ([bool]$data.cardGone)
      Assert '单题：回显里有这条答案' ([bool]$data.echoHasAnswer)
      Assert '单题：快照里 questions 长度=1' ($data.snapshots.lens -contains 1) "lens=$($data.snapshots.lens -join '/')"
    }
  }
}

if ($script:server -ne $null) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue }

# ── 真实家目录指纹比对 ───────────────────────────────────────────────────────
$dscAfter = Get-DscFingerprint $realDsc
$dshAfter = Get-DshFingerprint $realDsh
$dscAfter | Set-Content (Join-Path $shots 'ask3-realhome-dsc-after.txt') -Encoding utf8NoBOM
$dshAfter | Set-Content (Join-Path $shots 'ask3-realhome-dsh-after.txt') -Encoding utf8NoBOM
$dscDiff = Compare-Object $dscBefore $dscAfter
Assert "真实 $realDsc 跑前跑后没变（$($dscBefore.Count) 个文件逐个 SHA256）" ($null -eq $dscDiff) (($dscDiff | Select-Object -First 5 | ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" }) -join ' ; ')

# .dsh 是 DSH 自己的家目录：跑这段自检时，本会话（以及同工作区里并行的兄弟会话）一直在写
# sessions / usage 这两类活动文件，所以这里不能要求「一个字节都没变」。真正要证的只有一件事：
# 桌面端那一轮**没有**漏到真实 .dsh 里——活动的文件必须都在活动目录里，且不许出现桌面端
# 工作目录（D:\dsc\desktop）那一族的会话目录。
$dshDiff = Compare-Object $dshBefore $dshAfter
$dshChanged = @($dshDiff | ForEach-Object { ($_.InputObject -split '\|')[0] })
$liveDirs = @('\sessions\', '\usage\', '\storages\', '\dsh-usage\')
$dshOutside = @($dshChanged | Where-Object { $path = $_; -not ($liveDirs | Where-Object { $path.StartsWith($_) }) } | Sort-Object -Unique)
$dshChanged | Sort-Object -Unique | Set-Content (Join-Path $shots 'ask3-realhome-dsh-delta.txt') -Encoding utf8NoBOM
Assert "真实 $realDsh 动过的文件都在活动目录里（sessions/usage/storages/dsh-usage，共 $((@($dshChanged | Sort-Object -Unique)).Count) 个）" ($dshOutside.Count -eq 0) ($dshOutside -join ' ; ')
$desktopSessions = @(Get-ChildItem (Join-Path $realDsh 'sessions') -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like '*desktop*' -and $_.LastWriteTime -gt $script:runStart })
Assert '真实 .dsh/sessions 里没有桌面端工作目录那一族的会话来过（隔离没漏）' ($desktopSessions.Count -eq 0) (($desktopSessions | ForEach-Object { $_.Name }) -join ' ; ')

Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD, Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST -ErrorAction SilentlyContinue

if ($script:failures -gt 0) {
  Write-Output "提问卡批量化自检：FAIL $($script:failures) 条"
  exit 1
}
Write-Output '提问卡批量化自检：全部通过（FAIL 0）'
exit 0
