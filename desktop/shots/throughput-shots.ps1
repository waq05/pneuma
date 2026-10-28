# 状态栏「会话进度」卡的输出速度口径自检（0.6.67：换成 dsh 的纯解码吞吐）。
#
# 隔离怎么做：DSC_DESKTOP_USER_DATA 换掉 Electron 的 userData，USERPROFILE/HOME/DSC_HOME
# 换掉宿主的 ~/.dsc —— 会话、配置、用量日志全落在 desktop/shots/throughput-home 下，
# 用户真实的 ~/.dsc 一个字节都不写。
#
# 跑法：
#   cd desktop
#   pnpm exec electron-vite build            # 先出 out/（main 里的 @dsc/runtime 别名要根包 lib）
#   pwsh -NoProfile -File shots/throughput-shots.ps1                # 两个用例（源码构建 out/）
#   pwsh -NoProfile -File shots/throughput-shots.ps1 -Only throughput-card
#   pwsh -NoProfile -File shots/throughput-shots.ps1 -Packaged      # 跑打包后的 exe（dist\win-unpacked）
#
# 两步证据：
#   1. 屏幕上的读数（截图 + eval 读回的段文本与卡片行）
#   2. 用量日志里的原始行（lm/ft/d 与工具行），由本脚本运行后打印

param([string]$Only = 'all', [switch]$Packaged)

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
# 打包档跑 dist\win-unpacked 里那个 exe（asar 里的 main + 随包携带的 dsc-core）
$packagedExe = Join-Path $shots '..\dist\win-unpacked\Muse Code.exe'
$iso = Join-Path $shots 'throughput-home'
$dsc = Join-Path $iso '.dsc'
$port = 18931
$fake = Join-Path $shots 'throughput-fake-llm.mjs'

New-Item -ItemType Directory -Force -Path (Join-Path $dsc 'usage'), (Join-Path $dsc 'sessions') | Out-Null
@"
# 自检专用配置：一个指向本机假端点的 provider（不联网、不花钱）
default:
  provider: fake
  model: fake-throughput
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:$port/v1
    apiKeyEnv: DSC_FAKE_KEY
    models:
      - id: fake-throughput
        name: Fake Throughput
        contextWindow: 128000
        maxTokens: 4096
"@ | Set-Content -Path (Join-Path $dsc 'config.yaml') -Encoding utf8NoBOM
$env:DSC_FAKE_KEY = 'sk-selfcheck-fake'
$env:USERPROFILE = $iso
$env:HOME = $iso
$env:DSC_HOME = $dsc
$env:DSC_DESKTOP_USER_DATA = Join-Path $iso 'electron-userdata'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'

$script:server = $null
function Start-Fake([string]$mode) {
  if ($script:server -ne $null) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300 }
  $script:server = Start-Process -FilePath 'node' -ArgumentList $fake, $mode, $port -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 700
}

# eval 的骨架：提交一句 → 等状态栏出现速度读数 → 抢焦点把卡钉住（截图前一直抢）→ 读回读数。
# 焦点循环留一个 setInterval 在 eval 返回之后继续跑，否则输入区的 autoFocus 会把卡关掉。
$head = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => document.querySelector(s);
const all = (s) => Array.from(document.querySelectorAll(s));
const submit = (text) => window.dsc.invoke('submit', [text, undefined]);
const segTurn = () => q('.seg-turn .ctx-trigger');
const readCard = () => {
  const seg = q('.seg-turn');
  const card = seg ? seg.querySelector('.ctx-card') : null;
  const head = card ? card.querySelector('.ctx-head') : null;
  return {
    segment: seg ? seg.textContent.trim() : null,
    head: head ? head.textContent.trim() : null,
    rows: card ? all('.ctx-row').map((r) => r.textContent.trim()) : [],
    // 0.6.67 起卡片不带脚注：这一项应当为空
    notes: all('.ctx-card .ctx-note').length,
  };
};
'@

function Get-Eval([string]$mode) {
  $body = if ($mode -eq 'tool') { '跑一下 read 工具，然后收尾。' } else { '给我一段四十片的回复。' }
  return ($head + @"

(async () => {
  await wait(800);
  await submit('__MSG__');
  // 等到状态栏那一段真的出现速度读数（说明日志里已经有定稿请求、卡片数据齐了）
  let hasSpeed = false;
  for (let i = 0; i < 120 && !hasSpeed; i += 1) {
    await wait(250);
    const t = segTurn();
    hasSpeed = t !== null && t.textContent.includes('tok/s');
  }
  // 再等一拍，让这一轮收尾（工具耗时那一行可能在后一次请求定稿后才更新）
  await wait(2500);
  const seg = segTurn();
  if (seg) seg.focus();
  await wait(400);
  const out = readCard();
  // eval 返回之后继续抢焦点：截图在几秒后，卡必须还在
  let held = 0;
  const timer = setInterval(() => {
    const t = segTurn();
    if (t) t.focus();
    if (++held > 400) clearInterval(timer);
  }, 200);
  return { case: '__CASE__', hasSpeed, ...out };
})()
"@) -replace '__MSG__', $body -replace '__CASE__', $mode
}

$cases = [ordered]@{
  # 预跑脚本在 delay − lead = 8s 开始：提交 → 等读数 → 抢焦点一直抢到 32s 那次截图。
  # 提前量必须够大，否则脚本还在等回合收尾，窗口已经截图退出了（第一版就是这么空的）。
  'throughput-card'      = @{ mode = 'timed'; delay = 32000; lead = 24000 }
  'throughput-card-tool' = @{ mode = 'tool';  delay = 32000; lead = 24000 }
}

foreach ($name in $cases.Keys) {
  if ($Only -ne 'all' -and $Only -ne $name) { continue }
  $spec = $cases[$name]
  # 打包档的证据文件带 -packaged 后缀：源码构建与打包构建各自留一张，不互相覆盖
  $suffix = if ($Packaged) { '-packaged' } else { '' }
  Remove-Item (Join-Path $dsc 'usage\usage.jsonl') -ErrorAction SilentlyContinue
  Start-Fake $spec.mode
  $log = Join-Path $shots "$name$suffix.log"
  $env:DSC_DESKTOP_SHOT = Join-Path $shots "$name$suffix.png"
  $env:DSC_DESKTOP_SHOT_DELAY = [string]$spec.delay
  $env:DSC_DESKTOP_SHOT_EVAL_LEAD = [string]$spec.lead
  $env:DSC_DESKTOP_SHOT_EVAL = Get-Eval $spec.mode
  if ($Packaged) {
    if (-not (Test-Path $packagedExe)) { throw "没有打包产物：$packagedExe（先在 desktop 里 pnpm dist）" }
    Write-Output "=== $name（模式 $($spec.mode) · 打包版）==="
    & $packagedExe *>&1 | Out-File -FilePath $log -Encoding utf8
  } else {
    Write-Output "=== $name（模式 $($spec.mode)）==="
    & $electron 'out\main\index.js' *>&1 | Out-File -FilePath $log -Encoding utf8
  }
  Select-String -Path $log -Pattern 'selfcheck' | ForEach-Object { '  ' + $_.Line }
  Write-Output '  --- 用量日志 ---'
  $usage = Join-Path $dsc 'usage\usage.jsonl'
  if (Test-Path $usage) { Get-Content $usage | ForEach-Object { '  ' + $_ } } else { Write-Output '  （没有日志）' }
}

if ($script:server -ne $null) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue }
Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD, Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST -ErrorAction SilentlyContinue
Write-Output '全部完成'
