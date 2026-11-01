# 轮尾「已编辑 N 个文件」卡的时机 + 执行任务期间的内存占用（假模型端点驱动真回合）。
#
# 验的是两件事（2026-11-01 报障）：
#   ① 卡只在一轮**收口之后**才出现；回合进行中不得出现（旧行为是第一条 changes 条目落地就挂出来）。
#   ② 一轮里连着多刀写盘时，界面进程与内核进程各自的内存峰值与收口后的回落。
#
# 做法：假端点（_tail-probe-llm.mjs）按「请求里已有几条 tool 结果」连发 N 个 write，
# 每刀前等一会儿留出「回合进行中」的窗口；渲染层的预跑脚本每 250ms 采样一次
# 「停止生成按钮在不在 / 轮尾卡在不在 / JS 堆 / DOM 节点数」，外层脚本每 1s 采一次
# 整棵进程树的 working set。
#
# 隔离：USERPROFILE/HOME + DSC_DESKTOP_STATE + DSC_DESKTOP_USER_DATA 全钉在隔离目录；
# 工作区是 shots 下的一次性目录，假端点只监听回环、只回内存里的 SSE。
#
# 用法：
#   pwsh -NoProfile -File ui-tail-changes-check.ps1
#     → 跑仓库里的 electron + out/main（开发态；壳产物需已构建：pnpm run build:ui）
#   pwsh -NoProfile -File ui-tail-changes-check.ps1 -ExePath D:\dsc\desktop\dist\win-unpacked\Pneuma.exe
#     → 跑**打包产物**（冒烟：验 asar / dsc-core / 原生模块装得对不对）
#   两种都要求先起一个不冲突的假端点端口；产物版没有 out/main 可指，只认 exe。

param(
  [string]$ExePath = ''
)

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$swShots = 'D:\dsc\desktop\shots'
$swElectron = Join-Path $swShots '..\node_modules\electron\dist\electron.exe'
$swEntry = Join-Path $swShots '..\out\main\index.js'
$swHome = Join-Path $swShots 'tail-probe-home'
$swDsc = Join-Path $swHome '.dsc'
$swWs = Join-Path $swShots 'tail-probe-ws'
$swPort = 17421
$swPackaged = $ExePath -ne ''
if ($swPackaged -and -not (Test-Path -LiteralPath $ExePath)) { throw "没有这个 exe：$ExePath" }

# ── 现场清干净（只清这个自检自己的三个目录）───────────────────────────────────
foreach ($dir in @($swHome, $swWs)) {
  if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
}
New-Item -ItemType Directory -Force -Path $swWs | Out-Null
New-Item -ItemType Directory -Force -Path $swDsc | Out-Null

$seedDocs = $swWs
Set-Content -LiteralPath (Join-Path $swDsc 'desktop.json') -Encoding UTF8 -Value (@{
  lastCwd = $seedDocs
  recentCwds = @($seedDocs)
  ui = 'shell'
} | ConvertTo-Json -Depth 4)
$config = @"
default:
  provider: probe
  model: probe-model
providers:
  probe:
    displayName: 探针端点（自检）
    baseURL: http://127.0.0.1:$swPort
    apiKeyEnv: DSC_PROBE_KEY
    api: openai-completions
    models:
      - id: probe-model
        name: probe-model
        contextWindow: 128000
        maxTokens: 4096
"@
Set-Content -LiteralPath (Join-Path $swDsc 'config.yaml') -Value $config -Encoding UTF8

# ── 渲染层预跑脚本：提交一句话，然后一直采样到收口 ─────────────────────────────
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
  }, 25000);
  await wait(2500);
  const area = document.querySelector('.composer textarea');
  if (area === null) return { error: '没有找到输入框' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(area, '自检：连写几个文件，验轮尾卡时机');
  area.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(400);
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  const samples = [];
  let cardWhileRunning = 0;
  let runningSeen = 0;
  let firstCardAt = null;
  const started = Date.now();
  while (Date.now() - started < 75000) {
    const stop = document.querySelector('[aria-label="停止生成"]');
    const card = document.querySelector('.changes-card');
    const running = stop !== null;
    if (running) runningSeen += 1;
    if (card !== null) {
      if (firstCardAt === null) firstCardAt = Date.now() - started;
      if (running) cardWhileRunning += 1;
    }
    samples.push({
      t: Date.now() - started,
      running: running ? 1 : 0,
      card: card === null ? 0 : 1,
      heapMb: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 104857) / 10,
      dom: document.querySelectorAll('*').length,
    });
    // 收口之后再多看 12 秒：回落曲线要的是这段
    if (!running && firstCardAt !== null && Date.now() - started - firstCardAt > 12000) break;
    await wait(250);
  }
  const card = document.querySelector('.changes-card');
  return {
    runningSamples: runningSeen,
    samplesWhileRunning: samples.filter((s) => s.running === 1).length,
    cardWhileRunning,
    firstCardAt,
    finalCardText: (card?.textContent ?? '').trim().slice(0, 120),
    finalCardRows: document.querySelectorAll('.changes-card .changes-row').length,
    heapPeakMb: Math.max(...samples.map((s) => s.heapMb)),
    heapEndMb: samples[samples.length - 1]?.heapMb ?? null,
    domPeak: Math.max(...samples.map((s) => s.dom)),
    domEnd: samples[samples.length - 1]?.dom ?? null,
    samples,
  };
})()
'@

# ── 假端点 ────────────────────────────────────────────────────────────────────
$fakeLog = Join-Path $swShots 'ui-tail-changes-fake-llm.log'
Remove-Item -LiteralPath $fakeLog -ErrorAction SilentlyContinue
$env:DSC_PROBE_PORT = "$swPort"
$env:DSC_PROBE_STEPS = '6'
$env:DSC_PROBE_STEP_DELAY = '2500'
$env:DSC_PROBE_BODY_KB = '8'
$fakeProc = Start-Process -FilePath 'node' -ArgumentList 'D:\dsc\desktop\shots\_tail-probe-llm.mjs' -PassThru -RedirectStandardOutput $fakeLog -RedirectStandardError "$fakeLog.err" -WorkingDirectory 'D:\dsc'
Start-Sleep -Milliseconds 1500
if ($fakeProc.HasExited) { throw "假端点没起来，看 $fakeLog.err" }

$env:DSC_DESKTOP_USER_DATA = Join-Path $swHome 'electron-userdata'
$env:USERPROFILE = $swHome
$env:HOME = $swHome
$env:DSC_DESKTOP_STATE = Join-Path $swDsc 'desktop.json'
$env:DSC_PROBE_KEY = 'sk-fake-selftest'
$env:DSC_DESKTOP_SHOT = Join-Path $swShots 'ui-tail-changes.png'
$env:DSC_DESKTOP_SHOT_DELAY = '95000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '87000'
$env:DSC_DESKTOP_SHOT_EVAL = $swEval
Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue
Remove-Item Env:DSC_UI_QUERY -ErrorAction SilentlyContinue

$outLog = Join-Path $swShots 'ui-tail-changes.out.log'
$errLog = Join-Path $swShots 'ui-tail-changes.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue

# ── 进程树的内存采样（每 1s 一次，按 pid 分组）────────────────────────────────
function Get-TreeIds([int]$root) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
  $ids = @($root)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($p in $all) {
      if ($ids -contains $p.ProcessId) { continue }
      if ($ids -contains $p.ParentProcessId) { $ids += $p.ProcessId; $changed = $true }
    }
  }
  return $ids
}

try {
  $swProc = if ($swPackaged) {
    Start-Process -FilePath $ExePath -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  } else {
    Start-Process -FilePath $swElectron -ArgumentList $swEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  }
  $swStart = Get-Date
  $memLog = Join-Path $swShots 'ui-tail-changes-memory.csv'
  Remove-Item -LiteralPath $memLog -ErrorAction SilentlyContinue
  while (-not $swProc.HasExited) {
    $ids = Get-TreeIds $swProc.Id
    $cells = @()
    foreach ($id in $ids) {
      $p = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($null -eq $p) { continue }
      $cells += "$id=$([math]::Round($p.WorkingSet64 / 1MB, 1))"
    }
    $elapsed = [math]::Round(((Get-Date) - $swStart).TotalSeconds, 1)
    Add-Content -LiteralPath $memLog -Encoding UTF8 -Value "$elapsed`t$($cells -join ' ')`t$(($cells | Measure-Object).Count)"
    Start-Sleep -Milliseconds 1000
  }
  Start-Sleep -Milliseconds 500
} finally {
  if ($null -ne $swProc -and -not $swProc.HasExited) {
    & taskkill /PID $swProc.Id /T /F 2>&1 | Out-Null
  }
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_USER_DATA, Env:DSC_DESKTOP_STATE,
    Env:DSC_PROBE_KEY, Env:DSC_PROBE_PORT, Env:DSC_PROBE_STEPS, Env:DSC_PROBE_STEP_DELAY,
    Env:DSC_PROBE_BODY_KB -ErrorAction SilentlyContinue
  if ($null -ne $fakeProc -and -not $fakeProc.HasExited) {
    & taskkill /PID $fakeProc.Id /T /F 2>&1 | Out-Null
  }
}

if (Test-Path -LiteralPath $errLog) {
  Select-String -LiteralPath $errLog -Pattern '预跑脚本完成|预跑脚本失败|已写出|页面加载失败|截图失败' |
    ForEach-Object { '  ' + $_.Line.Trim() }
}
Write-Output 'ui-tail-changes-check 完成'
