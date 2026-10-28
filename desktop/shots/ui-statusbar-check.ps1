# 状态栏三段与三张悬浮卡的**真数据**验收（假模型端点驱动一轮真回合）。
#
# 为什么单起一个脚本：状态栏的速度 / 首字延迟 / 耗时 / 请求数这些行只在**真发生过模型请求**
# 之后才有值（数据源是宿主写的 ~/.dsc/usage/usage.jsonl，壳经原生桥 sessionUsage 读它）。
# 空会话下那几行按设计整行省略，验不了。
#
# 走查方式（见 docs 里的假端点配方）：隔离 home 里写一份 config.yaml 指向本地假端点
# （scripts/_fake-llm.mjs，只在内存里回 SSE），提交一句话 → 假端点先回一个 bash 工具调用
# （写工作区之外 → auto-edit 档必然要审批）→ 拒绝掉让它收口 → 第二次请求回正文。
#
# 判定：
#   ① 第一段读数变成「N 轮 N 步」且带上 tok/s（解码期有样本了）；
#   ② 第二段出现（累计 token > 0），段上是「N tok」（旧版口径：只有总量，不是 ↑↓ 分开）；
#   ③ 「会话进度」卡有：用户轮数 / 工具调用 / 输出速度 / 首字延迟 / LLM 耗时 / 会话开始 / 最近活动；
#   ④ 「会话用量」卡有：模型请求 / 输入 token / 输出 / 最近请求；
#   ⑤ 第三段还有百分比、悬浮卡标题是「上下文已用 X%」。
#   截图留档：把第一段的卡 focus 出来（.seg-hover:focus-within 就显形，旧样式表的口径）。
#
# 隔离：USERPROFILE/HOME + DSC_DESKTOP_STATE + DSC_DESKTOP_USER_DATA 全钉在隔离目录；
# 假端点只监听回环、只回内存里的 SSE，不落任何真实数据。
#
# 用法：pwsh -NoProfile -File ui-statusbar-check.ps1（壳产物需已构建：pnpm run build:ui）

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$swShots = 'D:\dsc\desktop\shots'
$swElectron = Join-Path $swShots '..\node_modules\electron\dist\electron.exe'
$swEntry = Join-Path $swShots '..\out\main\index.js'
$swHome = Join-Path $swShots 'shell-switch-home'
$swDsc = Join-Path $swHome '.dsc'
$swFakePort = 17399

# ── 种子：一个指向假端点的 provider + 一个工作区 + 一份合成会话 ─────────────────
$seedDocs = 'C:\Users\waq\Desktop\documents'
New-Item -ItemType Directory -Force -Path (Join-Path $swDsc 'sessions\C-Users-waq-Desktop-documents') | Out-Null
Set-Content -LiteralPath (Join-Path $swDsc 'desktop.json') -Encoding UTF8 -Value (@{
  lastCwd = $seedDocs
  recentCwds = @($seedDocs)
  ui = 'shell'
} | ConvertTo-Json -Depth 4)
$config = @"
default:
  provider: fake
  model: fake-model
providers:
  fake:
    displayName: 假端点（自检）
    baseURL: http://127.0.0.1:$swFakePort
    apiKeyEnv: DSC_FAKE_KEY
    api: openai-completions
    models:
      - id: fake-model
        name: fake-model
        contextWindow: 128000
        maxTokens: 4096
"@
Set-Content -LiteralPath (Join-Path $swDsc 'config.yaml') -Value $config -Encoding UTF8

$swEval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = pred(); if (v) return v; await wait(150); }
    return null;
  };
  await waitFor(() => {
    const root = document.querySelector('#root');
    return root !== null && root.children.length > 0;
  }, 20000);
  await wait(2500);
  const area = document.querySelector('.composer textarea');
  if (area === null) return { error: '没有找到输入框' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(area, '自检：跑一轮假回合');
  area.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(400);
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  // 假端点先回 bash 工具调用（写工作区之外）→ auto-edit 档必然弹审批卡
  const approval = await waitFor(() => document.querySelector('.approval') !== null, 25000);
  // 第一次请求定稿后累计 token > 0，第二段才出现
  const tokenSeg = await waitFor(() => document.querySelector('.seg-tokens .ctx-trigger') !== null, 20000);
  const rows = (sel) => Array.from(document.querySelectorAll(sel + ' .ctx-card .ctx-row')).map((r) => (r.textContent ?? '').trim());
  const turnCard = rows('.seg-turn');
  const tokenCard = rows('.seg-tokens');
  // 拒绝审批：这条命令不真跑，回合自己收口（第二次请求假端点会回正文）。
  let rejected = false;
  const rejectBtn = Array.from(document.querySelectorAll('.approval .approval-actions button')).find((b) => (b.textContent ?? '').includes('拒绝'));
  if (rejectBtn !== undefined) { rejectBtn.click(); rejected = true; }
  // 回合收口后再读一遍（轮数/速度/最近活动都会动）。
  await wait(2000);
  const turnBtn = document.querySelector('.seg-turn .ctx-trigger');
  const tokenBtn = document.querySelector('.seg-tokens .ctx-trigger');
  const ctxBtn = document.querySelector('.seg-context .ctx-trigger');
  // 把第一段的卡 focus 出来留档（.seg-hover:focus-within 显形，旧样式表的口径）。
  if (turnBtn !== null) turnBtn.focus();
  await wait(300);
  return {
    approvalShown: approval !== null,
    rejected,
    turnText: (turnBtn ?? {}).textContent?.trim() ?? null,
    tokenText: (tokenBtn ?? {}).textContent?.trim() ?? null,
    contextText: (ctxBtn ?? {}).textContent?.trim() ?? null,
    turnCard,
    tokenCard,
    ctxCardTitle: (document.querySelector('.seg-context .ctx-title') ?? {}).textContent?.trim() ?? null,
    tokenSegShown: tokenSeg !== null,
  };
})()
'@

# ── 假端点（回环上的内存 SSE 服务）────────────────────────────────────────────
$fakeLog = Join-Path $swShots 'ui-statusbar-fake-llm.log'
Remove-Item -LiteralPath $fakeLog -ErrorAction SilentlyContinue
$env:DSC_FAKE_LLM_DELAY = '0'
$fakeProc = Start-Process -FilePath 'node' -ArgumentList 'D:\dsc\scripts\_fake-llm.mjs' -PassThru -RedirectStandardOutput $fakeLog -RedirectStandardError "$fakeLog.err" -WorkingDirectory 'D:\dsc'
Start-Sleep -Milliseconds 1800

$env:DSC_DESKTOP_USER_DATA = Join-Path $swHome 'electron-userdata'
$env:USERPROFILE = $swHome
$env:HOME = $swHome
$env:DSC_DESKTOP_STATE = Join-Path $swDsc 'desktop.json'
$env:DSC_FAKE_KEY = 'sk-fake-selftest'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SHOT = Join-Path $swShots 'ui-statusbar.png'
$env:DSC_DESKTOP_SHOT_DELAY = '45000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '35000'
$env:DSC_DESKTOP_SHOT_EVAL = $swEval
Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue
Remove-Item Env:DSC_UI_QUERY -ErrorAction SilentlyContinue

$outLog = Join-Path $swShots 'ui-statusbar.out.log'
$errLog = Join-Path $swShots 'ui-statusbar.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue

try {
  $swProc = Start-Process -FilePath $swElectron -ArgumentList $swEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $swDeadline = (Get-Date).AddSeconds(100)
  while ((Get-Date) -lt $swDeadline) {
    if (Test-Path -LiteralPath $errLog) {
      $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|页面加载失败|截图失败' -ErrorAction SilentlyContinue
      if ($null -ne $hit) { break }
    }
    if ($swProc.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
  & taskkill /PID $swProc.Id /T /F 2>&1 | Out-Null
  Start-Sleep -Milliseconds 600
} finally {
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_USER_DATA,
    Env:DSC_DESKTOP_STATE, Env:DSC_FAKE_KEY, Env:DSC_FAKE_LLM_DELAY -ErrorAction SilentlyContinue
  if ($null -ne $fakeProc -and -not $fakeProc.HasExited) {
    & taskkill /PID $fakeProc.Id /T /F 2>&1 | Out-Null
  }
}

if (Test-Path -LiteralPath $errLog) {
  Select-String -LiteralPath $errLog -Pattern '预跑脚本完成|预跑脚本失败|已写出|页面加载失败|截图失败' |
    ForEach-Object { '  ' + $_.Line.Trim() }
}
if (Test-Path -LiteralPath $fakeLog) {
  Write-Output '── 假端点日志（前几行）──'
  Get-Content -LiteralPath $fakeLog | Select-Object -First 6 | ForEach-Object { '  ' + $_ }
}
Write-Output 'ui-statusbar-check 完成'
