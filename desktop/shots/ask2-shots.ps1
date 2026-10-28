# 提问卡（ask_user）改版的自检截图：列表形态 / 逐题作答 / 草稿清空 / 统一提交。
#
# 隔离怎么做（一个字节都不写真实的 ~/.dsc）：
#   DSC_HOME            → shots/ask2-home/.dsc（宿主的配置目录，path-policy.ts:20 认这个）
#   USERPROFILE / HOME  → shots/ask2-home（libuv 在 Windows 上先认 USERPROFILE，
#                          宿主读 homedir() 的那几处——plugins.json / credentials.yaml 等——一起落进来）
#   DSC_DESKTOP_USER_DATA → shots/ask2-home/electron-userdata（Electron 自己的 userData）
# 模型走本机假端点（ask2-fake-llm.mjs）：不发真请求、不花钱，答案由它回显。
#
# 用法：
#   pwsh -NoProfile -File ask2-shots.ps1              # 全部用例
#   pwsh -NoProfile -File ask2-shots.ps1 -Only ask2-list

param([string]$Only = 'all')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$shots = 'D:\dsc\desktop\shots'
$desktop = Join-Path $shots '..'
$electron = Join-Path $desktop 'node_modules\.bin\electron.cmd'
$iso = Join-Path $shots 'ask2-home'
$dsc = Join-Path $iso '.dsc'
$port = 18931
$fake = Join-Path $shots 'ask2-fake-llm.mjs'

# ── 隔离环境 ─────────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $dsc, (Join-Path $dsc 'sessions'), (Join-Path $dsc 'usage') | Out-Null
@"
# 自检专用配置：一个指向本机假端点的 provider（不联网、不花钱）
default:
  provider: fake
  model: fake-ask
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:$port/v1
    apiKeyEnv: DSC_FAKE_KEY
    models:
      - id: fake-ask
        name: Fake Ask
        contextWindow: 128000
        maxTokens: 4096
"@ | Set-Content -Path (Join-Path $dsc 'config.yaml') -Encoding utf8NoBOM
$env:DSC_FAKE_KEY = 'sk-selfcheck-fake'
$env:DSC_HOME = $dsc
$env:USERPROFILE = $iso
$env:HOME = $iso
$env:DSC_DESKTOP_USER_DATA = Join-Path $iso 'electron-userdata'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'

# ── 假端点进程 ───────────────────────────────────────────────────────────────
$script:server = $null
function Start-Fake([string]$mode) {
  if ($script:server -ne $null) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300 }
  $script:server = Start-Process -FilePath 'node' -ArgumentList $fake, $mode, $port -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 700
}

# ── 探针（每个用例都拼这一段）────────────────────────────────────────────────
# 全部走 DOM：卡片结构、输入框的 value、按钮的 disabled、宿主回显的原文。
# 输入框赋值用原型上的 value setter + input 事件，React 才认得出这是一次真实编辑。
$head = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => document.querySelector(s);
const all = (s) => Array.from(document.querySelectorAll(s));
const text = (node) => (node === null || node === undefined ? null : node.textContent);
const card = () => q('.ask-card');
const rows = () => all('.ask-item').map((el) => ({
  idx: el.getAttribute('data-ask-item'),
  state: el.getAttribute('data-ask-state'),
  done: el.getAttribute('data-ask-done'),
  text: text(el.querySelector('.ask-item-text')),
  note: text(el.querySelector('.ask-item-note')),
}));
const snapCard = () => {
  const el = card();
  if (el === null) return null;
  const input = q('.ask-input');
  const primary = q('.ask-submit');
  return {
    count: el.getAttribute('data-ask-count'),
    rows: rows(),
    inputValue: input === null ? null : input.value,
    picked: all('.ask-option.picked').map((n) => text(n.querySelector('.ask-option-label'))),
    primary: text(primary),
    primaryDisabled: primary === null ? null : primary.disabled,
    progress: text(q('.ask-progress')),
    hint: text(q('.ask-hint')),
  };
};
const waitCardOf = async (needle, tries = 80) => {
  for (let i = 0; i < tries; i += 1) {
    const el = card();
    if (el !== null && (text(el.querySelector('.ask-item-text')) || '').includes(needle)) return el;
    await wait(250);
  }
  return null;
};
const waitCardGone = async (tries = 80) => {
  for (let i = 0; i < tries; i += 1) { if (card() === null) return true; await wait(250); }
  return false;
};
const clickOption = (index) => {
  const list = all('.ask-option');
  if (list[index] === undefined) return false;
  list[index].click();
  return true;
};
const clickPrimary = () => {
  const button = q('.ask-submit');
  if (button === null || button.disabled) return false;
  button.click();
  return true;
};
const typeInput = (value) => {
  const input = q('.ask-input');
  if (input === null) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
};
const echoText = () => {
  const bodies = all('.entry-text .markdown').map((n) => n.innerText);
  const hit = bodies.filter((body) => body.includes('自检回显'));
  return hit.length === 0 ? null : hit[hit.length - 1];
};
const waitEcho = async (tries = 60) => {
  for (let i = 0; i < tries; i += 1) {
    const body = echoText();
    if (body !== null) return body;
    await wait(250);
  }
  return null;
};
const toBottom = () => { const chat = q('.chat'); if (chat !== null) chat.scrollTop = chat.scrollHeight; };
'@

# 1) 列表形态：一次 ask_user 问 3 题时，界面第一张卡长什么样（题目行 / 展开区 / 页脚）
$listEval = ($head + @'

(async () => {
  await wait(600);
  await window.dsc.invoke('submit', ['这次要动的范围我拿不准，你一次问清楚。', undefined]);
  const el = await waitCardOf('这次只改对话区');
  const opened = snapCard();
  const pickedBeforeClick = clickOption(1);
  await wait(500);
  const afterPick = snapCard();
  toBottom();
  return { case: 'list', cardAppeared: el !== null, opened, pickedBeforeClick, afterPick };
})()
'@)

# 2) 逐题走完：宿主现在一次只挂一题，所以三题是「一题一卡」顺序出现。
#    每一题都记录卡片的行数/输入框值/已选项，用来证明：
#    a) 第一题的输入框里写的字不会漏到第二题（提交后清空）；
#    b) 同一题里输入的字在重渲染后还在（草稿不丢）；
#    c) 三题答完后卡片消失、假端点回显收到全部答案。
$walkEval = ($head + @'

(async () => {
  await wait(600);
  await window.dsc.invoke('submit', ['这次要动的范围我拿不准，你一次问清楚。', undefined]);

  // 第一题：带选项的单选
  const first = await waitCardOf('这次只改对话区');
  const q1 = snapCard();
  clickOption(0);
  await wait(400);
  const q1picked = snapCard();
  clickPrimary();
  await wait(400);

  // 第二题：多选带选项。它是一张新卡（宿主换了一题的视图），输入框必须从空开始。
  const second = await waitCardOf('两条轨道的宽度');
  const q2 = snapCard();
  typeInput('以正文列宽为准，另加一条兜底');
  await wait(1200);
  const q2typed = snapCard();
  clickPrimary();
  await wait(400);

  // 第三题：只有自由输入
  const third = await waitCardOf('还有什么要我一并处理');
  const q3 = snapCard();
  typeInput('没有，先按上面两条做');
  await wait(400);
  const q3typed = snapCard();
  clickPrimary();

  const gone = await waitCardGone();
  const echoed = await waitEcho();
  toBottom();
  await wait(600);
  return {
    case: 'walk',
    sawEachQuestion: [first !== null, second !== null, third !== null],
    q1,
    q1picked,
    q2,
    q2typed,
    q3,
    q3typed,
    cardGone: gone,
    echoHasAllThree: echoed !== null
      && echoed.includes('只改对话区') && echoed.includes('另加一条兜底') && echoed.includes('先按上面两条做'),
    echo: echoed,
  };
})()
'@)

# 3) 单题场景不回归：一个问题时没有切题夹，主按钮直接就是「提交」
$singleEval = ($head + @'

(async () => {
  await wait(600);
  await window.dsc.invoke('submit', ['只有一个问题，你问吧。', undefined]);
  const el = await waitCardOf('这次只改对话区');
  const beforePick = snapCard();
  const blockedWhileEmpty = !clickPrimary();
  clickOption(0);
  await wait(400);
  const afterPick = snapCard();
  clickPrimary();
  const gone = await waitCardGone();
  const echoed = await waitEcho();
  toBottom();
  await wait(600);
  return {
    case: 'single',
    cardAppeared: el !== null,
    beforePick,
    blockedWhileEmpty,
    afterPick,
    cardGone: gone,
    echoHasAnswer: echoed !== null && echoed.includes('只改对话区'),
    echo: echoed,
  };
})()
'@)

$cases = [ordered]@{
  'ask2-list'   = @{ mode = 'ask3'; delay = 14000; lead = 10000; eval = $listEval }
  'ask2-walk'   = @{ mode = 'ask3'; delay = 30000; lead = 25000; eval = $walkEval }
  'ask2-single' = @{ mode = 'ask1'; delay = 26000; lead = 21000; eval = $singleEval }
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
