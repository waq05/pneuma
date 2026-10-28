# 第七批自检（模型配置页专项，2026-10-12；2026-10-15 按「左端点 + 右详情」两栏版式重写）。
#
# 走的是桌面窗口的真路径：三个写操作（saveProvider / removeProvider / setProviderKey）
# 被界面通道排除，只能经原生桥转发给宿主——本脚本验证「桥上真的通」且**真的落盘**
# （PowerShell 侧直接读 batch7b-home/.dsc/config.yaml 比对）。
#
# 三种状态（-State）：
#   flow    全流程 + 截图落在**详情视图**（左栏端点 / 右栏配置与模型列表）：形态、能力
#           编辑器、新增端点、拉取清单、删模型、删端点，配 config.yaml 落盘证据。
#   editor  只打开 fake 端点、测一次连接、展开 fake-trace 的能力编辑器 → 截图（看编辑器观感）。
#   form    只点开「添加端点」 → 截图（看表单观感）。
#   narrow  把窗口种成 880×760 再打开模型页 → 截图（窄屏那一档：两栏叠一列）。
#
# 隔离：USERPROFILE/HOME + DSC_DESKTOP_STATE + DSC_DESKTOP_USER_DATA 全钉在隔离目录；
# 跑前跑后对真实 ~/.dsc 做「文件数 + 内容聚合 SHA256」比对。
#
# 用法：pwsh -NoProfile -File ui-batch7b-models-check.ps1 [-State flow|editor|form]
#       （宿主 lib 与壳产物需已构建：pnpm build + pnpm -C ui-shell build）

param(
  [ValidateSet('flow', 'editor', 'form', 'narrow')][string]$State = 'flow',
  # 自检窗口：默认按状态给（flow 要跑完整条流程）；调试用 -Delay/-Lead 覆盖。
  [int]$Delay = 0,
  [int]$Lead = 0
)

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$swShots = 'D:\dsc\desktop\shots'
$swElectron = Join-Path $swShots '..\node_modules\electron\dist\electron.exe'
$swEntry = Join-Path $swShots '..\out\main\index.js'
$swHome = Join-Path $swShots 'batch7b-home'
$swDsc = Join-Path $swHome '.dsc'
$swRealDsc = Join-Path $env:USERPROFILE '.dsc'
$swWs = Join-Path $swHome 'ws'
$swPort = 18928
$swFake = Join-Path $swShots '_batch7-fake-llm.mjs'
$swShotName = switch ($State) {
  'flow' { 'ui-batch7b.png' }
  'editor' { 'ui-models-v2-editor.png' }
  'form' { 'ui-models-v2-form.png' }
  default { 'ui-models-v2-narrow.png' }
}
$swDelay = if ($Delay -gt 0) { [string]$Delay } elseif ($State -eq 'flow') { '150000' } else { '80000' }
$swLead = if ($Lead -gt 0) { [string]$Lead } elseif ($State -eq 'flow') { '130000' } else { '65000' }

function Get-DirFingerprint([string]$Path) {
  $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Sort-Object FullName)
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($Path.Length)
    $hash = 'LOCKED'
    try { $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash } catch { }
    $lines.Add("$rel|$($file.Length)|$hash")
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $contentJoined = [string]::Join("`n", ($lines | ForEach-Object { $parts = $_ -split '\|'; "$($parts[0])|$($parts[2])" }))
  $contentDigest = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($contentJoined))).Replace('-', '').ToLowerInvariant()
  return [pscustomobject]@{ Count = $files.Count; ContentDigest = $contentDigest; Lines = $lines }
}

$swRealBefore = if (Test-Path -LiteralPath $swRealDsc) { Get-DirFingerprint $swRealDsc } else { $null }

# ── 种子：一个工作区 + 两个端点（官方款看着像真的，本地款指向假端点）─────────────
Remove-Item -Recurse -Force -LiteralPath $swHome -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $swDsc, $swWs, (Join-Path $swDsc 'sessions'), (Join-Path $swHome 'AppData\Roaming') | Out-Null

$swConfig = Join-Path $swDsc 'config.yaml'
Set-Content -LiteralPath $swConfig -Encoding utf8NoBOM -Value @"
default:
  provider: deepseek
  model: deepseek-v4-pro
providers:
  deepseek:
    displayName: DeepSeek 官方
    baseURL: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY
    models:
      - id: deepseek-v4-pro
        name: DeepSeek V4 Pro
        contextWindow: 1000000
        maxTokens: 65536
        modalities: [text, image]
        thinkingParam: reasoning-effort
      - id: deepseek-flash
        name: DeepSeek Flash
        contextWindow: 128000
        maxTokens: 8192
        thinkingLevels: []
        thinkingParam: none
  fake:
    displayName: 本地实验台
    baseURL: http://127.0.0.1:$swPort/v1
    apiKeyEnv: DSC_FAKE_KEY
    models:
      - id: fake-trace
        name: hy3-a
        contextWindow: 256000
        maxTokens: 32768
        modalities: [text, image, video]
        thinkingParam: reasoning-effort
"@
$env:DSC_FAKE_KEY = 'sk-selfcheck-fake'
$env:DEEPSEEK_API_KEY = 'sk-selfcheck-deepseek'

$swState = @{
  lastCwd = $swWs
  recentCwds = @($swWs)
  ui = 'shell'
}
if ($State -eq 'narrow') {
  $swState.windowBounds = @{ width = 880; height = 760; x = 60; y = 60; maximized = $false }
}
Set-Content -LiteralPath (Join-Path $swDsc 'desktop.json') -Encoding UTF8 -Value ($swState | ConvertTo-Json -Depth 4)
Set-Content -LiteralPath (Join-Path $swDsc 'sessions\meta.json') -Encoding UTF8 -Value (@{ version = 1; sessions = @{} } | ConvertTo-Json -Depth 4)

# ── 预跑 eval ──────────────────────────────────────────────────────────────────
$swEvalHead = @'
(async () => {
  const startedAt = Date.now();
  const hardDeadline = startedAt + 190000;
  const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, hardDeadline - Date.now()))));
  const waitFor = async (pred, ms) => {
    const until = Math.min(Date.now() + ms, hardDeadline);
    while (Date.now() < until) { const v = pred(); if (v !== null && v !== false && v !== undefined) return v; await wait(150); }
    return null;
  };
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const text = (el) => el === null || el === undefined ? null : (el.textContent ?? '').trim();
  const setInput = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const blur = (el) => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  const pickSelect = async (trigger, needle) => {
    if (trigger === null) return false;
    trigger.click();
    await wait(400);
    const option = qa('.select-pop .select-opt').find((o) => (o.textContent ?? '').includes(needle));
    if (option === undefined) return false;
    option.click();
    await wait(400);
    return true;
  };
  const openModels = async () => {
    window.__s = 'open';
    window.dispatchEvent(new CustomEvent('shell.settings.open', { detail: { section: 'models' } }));
    const page = await waitFor(() => q('.models-page'), 40000);
    await wait(600);
    return page !== null;
  };
  const railNames = () => qa('.models-rail-item[data-provider]').map((el) => el.getAttribute('data-provider'));
  const detailProvider = () => (q('[data-model-list]') ?? { getAttribute: () => null }).getAttribute('data-model-list');
  const modelIds = () => qa('[data-model-list] [data-model-chip]').map((el) => el.getAttribute('data-model-chip'));
  const selectProvider = async (name) => {
    const row = q('.models-rail-item[data-provider="' + name + '"]');
    if (row === null) return false;
    row.click();
    return (await waitFor(() => detailProvider() === name, 8000)) !== null;
  };
  const confirmYes = async () => {
    const box = await waitFor(() => q('.dsc-confirm'), 6000);
    if (box === null) return false;
    const go = qa('.dsc-confirm .dsc-btn').at(-1);
    if (go === undefined) return false;
    go.click();
    await wait(400);
    return true;
  };
  const out = { case: 'batch7b', state: window.__state ?? null };
  await waitFor(() => { const root = q('#root'); return root !== null && root.children.length > 0; }, 40000);
  await wait(1500);
  if (!(await openModels())) { out.openFailed = true; return out; }
'@

$swEvalFlow = @'
  // ── A. 两栏形态 ─────────────────────────────────────────────────────────────
  window.__s = 'A';
  out.shape = {
    rail: railNames(),
    selected: q('.models-rail-item.on')?.getAttribute('data-provider') ?? null,
    detail: detailProvider(),
    models: modelIds(),
    defaultModel: q('[data-model-default="1"]')?.getAttribute('data-model-chip') ?? null,
    title: text(q('.provider-title')),
    key: text(q('.conn-key')),
    baseUrl: q('.conn-input')?.value ?? null,
    paths: qa('.models-path .mono').map((el) => el.getAttribute('title')),
    addCard: q('[data-provider-add]') !== null,
    readonlyNote: q('[data-models-readonly]') === null,
  };

  // ── B. 模型能力编辑器（在假的本地端点上改）──────────────────────────────────
  window.__s = 'B';
  await selectProvider('fake');
  const editBtn = q('[data-model-edit="fake-trace"]');
  if (editBtn !== null) { editBtn.click(); }
  const editor = await waitFor(() => q('[data-model-edit-box="fake-trace"]'), 6000);
  out.editor = {
    open: editor !== null,
    modelInputs: qa('[data-model-edit-box="fake-trace"] .model-row-main .setting-input').length,
    levelChips: qa('[data-model-edit-box="fake-trace"] .cap-chip[data-cap-level]').map((c) => ({ level: c.getAttribute('data-cap-level'), on: c.classList.contains('on') })),
    modalityChips: qa('[data-model-edit-box="fake-trace"] .cap-chip[data-cap-modality]').map((c) => ({ modality: c.getAttribute('data-cap-modality'), on: c.classList.contains('on') })),
    paramSelect: text(q('[data-model-edit-box="fake-trace"] .cap-param')),
    wireInputs: qa('[data-model-edit-box="fake-trace"] [data-cap-wire]').length,
  };
  // 去掉「低」「最大」两档、去掉视频、把「高」档的线上值改成 HIGH（UPPER 在别处不会出现）
  for (const sel of ['[data-model-edit-box="fake-trace"] [data-cap-level="low"]', '[data-model-edit-box="fake-trace"] [data-cap-level="max"]', '[data-model-edit-box="fake-trace"] [data-cap-modality="video"]']) {
    const el = q(sel);
    if (el !== null) { el.click(); await wait(350); }
  }
  const wire = q('[data-model-edit-box="fake-trace"] [data-cap-wire="high"]');
  if (wire !== null) { setInput(wire, 'HIGH'); await wait(250); }
  out.editorChanged = {
    wireShown: q('[data-model-edit-box="fake-trace"] .cap-wire') !== null,
    wireValue: q('[data-model-edit-box="fake-trace"] [data-cap-wire="high"]')?.value ?? null,
    paramText: text(q('[data-model-edit-box="fake-trace"] .cap-param')),
  };
  const saveModel = q('[data-model-save="fake-trace"]');
  if (saveModel !== null) { saveModel.click(); }
  await waitFor(() => q('[data-model-edit-box="fake-trace"]') === null, 15000);
  await wait(700);
  // 回读：重开编辑器看勾选态
  const editAgain = q('[data-model-edit="fake-trace"]');
  if (editAgain !== null) { editAgain.click(); }
  await waitFor(() => q('[data-model-edit-box="fake-trace"]'), 6000);
  await wait(300);
  out.editorAfterSave = {
    levelOn: qa('[data-model-edit-box="fake-trace"] .cap-chip[data-cap-level]').filter((c) => c.classList.contains('on')).map((c) => c.getAttribute('data-cap-level')),
    modalityOn: qa('[data-model-edit-box="fake-trace"] .cap-chip[data-cap-modality]').filter((c) => c.classList.contains('on')).map((c) => c.getAttribute('data-cap-modality')),
    wireValue: q('[data-model-edit-box="fake-trace"] [data-cap-wire="high"]')?.value ?? null,
    rowCaps: text(q('[data-model-chip="fake-trace"] .model-caps-line')),
  };
  const cancelEdit = qa('[data-model-edit-box="fake-trace"] .model-edit-acts .btn-ghost')[0];
  if (cancelEdit !== undefined) { cancelEdit.click(); }
  await wait(400);
  // 测一次连接（假端点会回话）→ 结论点留在那一行后面
  const probe = q('[data-probe-model="fake-trace"]');
  if (probe !== null) { probe.click(); }
  out.probe = await waitFor(() => text(q('[data-probe="ok"]') ?? q('[data-probe="fail"]')), 20000) !== null
    ? { mark: q('[data-probe="ok"]') !== null ? 'ok' : 'fail', tip: q('[data-probe-model="fake-trace"][data-probe]')?.getAttribute('title') ?? null }
    : null;

  // ── C. 新增端点（表单占右栏，左栏出现伪条目）────────────────────────────────
  window.__s = 'C';
  const addCard = q('[data-provider-add]');
  if (addCard !== null) { addCard.click(); }
  const form = await waitFor(() => q('[data-provider-form="new"]'), 6000);
  out.newForm = {
    open: form !== null,
    railHasNew: q('.models-rail-item[data-provider="__new__"]') !== null,
    fields: qa('.pane-form-grid > .field > .setting-input').map((i) => i.type === 'password' ? 'password' : 'text'),
    modelInputs: qa('.pane-form-grid .model-row .model-row-main .setting-input').length,
  };
  if (form !== null) {
    const fields = qa('.pane-form-grid > .field > .setting-input');
    if (fields[0] !== undefined) setInput(fields[0], 'nova');
    if (fields[1] !== undefined) setInput(fields[1], 'Nova 试验端点');
    if (fields[2] !== undefined) setInput(fields[2], 'http://127.0.0.1:18928/v1');
    const mf = qa('.pane-form-grid .model-row .model-row-main .setting-input');
    if (mf[0] !== undefined) setInput(mf[0], 'nova-1');
    if (mf[2] !== undefined) { setInput(mf[2], '64000'); blur(mf[2]); }
    await wait(400);
    const saveNew = q('[data-provider-save]');
    if (saveNew !== null) { saveNew.click(); }
  }
  await waitFor(() => railNames().includes('nova'), 15000);
  await wait(700);
  out.afterAdd = { rail: railNames(), detail: detailProvider(), models: modelIds() };

  // ── D. 拉取清单（假端点的 GET /v1/models 回 3 个）──────────────────────────
  window.__s = 'D';
  await selectProvider('fake');
  const discoverBtn = q('[data-model-discover]');
  if (discoverBtn !== null) { discoverBtn.click(); }
  const dialog = await waitFor(() => q('[data-models-discover]'), 12000);
  await wait(400);
  out.discover = {
    open: dialog !== null,
    items: qa('[data-discover-item]').map((i) => ({ id: i.getAttribute('data-discover-item'), exists: i.classList.contains('exists'), on: i.classList.contains('on') })),
    adoptLabel: text(q('[data-models-discover-adopt]')),
  };
  const adoptBtn = q('[data-models-discover-adopt]');
  if (adoptBtn !== null) { adoptBtn.click(); }
  await waitFor(() => q('[data-models-discover]') === null, 15000);
  await wait(800);
  out.afterDiscover = { models: modelIds() };

  // ── E. 删模型（fake-pro；它不是默认模型）──────────────────────────────────
  window.__s = 'E';
  const delModel = q('[data-model-remove="fake-pro"]');
  if (delModel !== null) { delModel.click(); }
  out.deleteModel = { confirmShown: false, gone: false };
  out.deleteModel.confirmShown = await confirmYes();
  out.deleteModel.gone = (await waitFor(() => !modelIds().includes('fake-pro'), 12000)) !== null;
  await wait(600);
  out.deleteModel.models = modelIds();

  // ── F. 删端点（nova；确认框）──────────────────────────────────────────────
  window.__s = 'F';
  await selectProvider('nova');
  const delProvider = q('[data-provider-remove]');
  if (delProvider !== null) { delProvider.click(); }
  out.deleteProvider = { confirmShown: await confirmYes() };
  out.deleteProvider.gone = (await waitFor(() => !railNames().includes('nova'), 12000)) !== null;
  await wait(600);
  out.deleteProvider.rail = railNames();

  // ── G. 收尾停在详情视图（截图要的是常态：左栏端点 / 右栏配置与模型列表）──
  window.__s = 'G';
  await selectProvider('deepseek');
  await wait(600);
  out.final = { detail: detailProvider(), models: modelIds(), rail: railNames(), mouse: 'none' };
'@

$swEvalEditor = @'
  window.__s = 'editor';
  await selectProvider('fake');
  await wait(400);
  const probe = q('[data-probe-model="fake-trace"]');
  if (probe !== null) { probe.click(); }
  out.probe = await waitFor(() => q('[data-probe]'), 20000) !== null
    ? { mark: q('[data-probe="ok"]') !== null ? 'ok' : 'fail', tip: q('[data-probe-model="fake-trace"][data-probe]')?.getAttribute('title') ?? null }
    : null;
  const editBtn = q('[data-model-edit="fake-trace"]');
  if (editBtn !== null) { editBtn.click(); }
  out.editorOpen = (await waitFor(() => q('[data-model-edit-box="fake-trace"]'), 6000)) !== null;
  await wait(600);
'@

$swEvalForm = @'
  window.__s = 'form';
  const addCard = q('[data-provider-add]');
  if (addCard !== null) { addCard.click(); }
  out.formOpen = (await waitFor(() => q('[data-provider-form="new"]'), 6000)) !== null;
  await wait(800);
'@

$swEvalNarrow = @'
  window.__s = 'narrow';
  await selectProvider('fake');
  await wait(600);
  out.narrow = { rail: railNames(), detail: detailProvider(), models: modelIds() };
'@
$swEvalBody = if ($State -eq 'flow') { $swEvalFlow } elseif ($State -eq 'editor') { $swEvalEditor } elseif ($State -eq 'form') { $swEvalForm } else { $swEvalNarrow }
$swEval = "window.__state = '$State';`n" + @"
$swEvalHead
$swEvalBody
  out.ms = Date.now() - startedAt;
  return out;
})().catch((error) => ({
  case: 'batch7b',
  state: window.__state ?? null,
  error: String(error && error.message ? error.message : error),
  stage: window.__s ?? null,
}))
"@

# ── 起假端点 ──────────────────────────────────────────────────────────────────
$swFakeOut = Join-Path $swShots 'ui-batch7b-fake.out.log'
$swFakeErr = Join-Path $swShots 'ui-batch7b-fake.err.log'
Remove-Item -LiteralPath $swFakeOut, $swFakeErr -ErrorAction SilentlyContinue
$swFakeProc = Start-Process -FilePath 'node' -ArgumentList $swFake, "$swPort" -PassThru -RedirectStandardOutput $swFakeOut -RedirectStandardError $swFakeErr
$swFakeReady = $false
$swFakeWait = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $swFakeWait) {
  if ((Test-Path -LiteralPath $swFakeOut) -and (Select-String -LiteralPath $swFakeOut -Pattern '监听' -Quiet -ErrorAction SilentlyContinue)) { $swFakeReady = $true; break }
  if ($swFakeProc.HasExited) { break }
  Start-Sleep -Milliseconds 200
}
if (-not $swFakeReady) { Write-Output '  WARN  假端点没在 10 秒内就绪' }

$env:USERPROFILE = $swHome
$env:HOME = $swHome
$env:DSC_DESKTOP_USER_DATA = Join-Path $swHome 'electron-userdata'
$env:DSC_DESKTOP_STATE = Join-Path $swDsc 'desktop.json'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SHOT = Join-Path $swShots $swShotName
$env:DSC_DESKTOP_SHOT_DELAY = $swDelay
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = $swLead
$env:DSC_DESKTOP_SHOT_EVAL = $swEval
Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue
Remove-Item Env:DSC_UI_QUERY -ErrorAction SilentlyContinue

$outLog = Join-Path $swShots 'ui-batch7b.out.log'
$errLog = Join-Path $swShots 'ui-batch7b.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue

# 截图前把鼠标挪到角落：悬停态（行底色、按钮发亮）会进照片，让观感失真。
Add-Type -AssemblyName System.Windows.Forms
try { [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(2, 1000) } catch { }

$swProc = $null
$swStart = Get-Date
try {
  $swProc = Start-Process -FilePath $swElectron -ArgumentList $swEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $swDeadline = (Get-Date).AddSeconds(300)
  $swBreak = 'deadline'
  while ((Get-Date) -lt $swDeadline) {
    if (Test-Path -LiteralPath $errLog) {
      $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|页面加载失败|截图失败' -ErrorAction SilentlyContinue
      if ($null -ne $hit) { $swBreak = 'marker:' + ($hit | Select-Object -Last 1).Line.Trim(); break }
    }
    if ($swProc.HasExited) { $swBreak = 'exited'; break }
    Start-Sleep -Milliseconds 500
  }
  Write-Output "  INFO  循环结束原因：$swBreak"
  # 早退取证：进程自己退了（不是循环超时）时把退出码与耗时写出来——「没有读数」先看这里，
  # 免得怀疑成探针或界面挂了。
  $swElapsed = [int]((Get-Date) - $swStart).TotalSeconds
  if ($swProc.HasExited) {
    Write-Output "  INFO  窗口进程自己退了：exit=$($swProc.ExitCode) 耗时=${swElapsed}s（截图应在 $($swDelay)ms 时落盘）"
  } else {
    Write-Output "  INFO  循环到点收工（${swElapsed}s，截图窗口 $($swDelay)ms）"
  }
  & taskkill /PID $swProc.Id /T /F 2>&1 | Out-Null
  Start-Sleep -Milliseconds 600
} finally {
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_USER_DATA,
    Env:DSC_DESKTOP_STATE -ErrorAction SilentlyContinue
  if ($null -ne $swFakeProc -and -not $swFakeProc.HasExited) {
    & taskkill /PID $swFakeProc.Id /T /F 2>&1 | Out-Null
  }
}

if (Test-Path -LiteralPath $errLog) {
  Select-String -LiteralPath $errLog -Pattern '预跑脚本失败|页面加载失败|截图失败' | ForEach-Object { '  ' + $_.Line.Trim() }
}

# ── 断言 ───────────────────────────────────────────────────────────────────────
$swFail = 0
$swTotal = 0
function Check($Name, $Ok, $Detail = '') {
  $script:swTotal += 1
  if ($Ok) { Write-Output "  PASS  $Name" }
  else { $script:swFail += 1; Write-Output "  FAIL  $Name$(if ($Detail -ne '') { " — $Detail" })" }
}

$swJson = $null
if (Test-Path -LiteralPath $errLog) {
  $line = Select-String -LiteralPath $errLog -Pattern '预跑脚本完成：' | Select-Object -Last 1
  if ($null -ne $line) {
    $marker = '预跑脚本完成：'
    $raw = $line.Line.Substring($line.Line.IndexOf($marker) + $marker.Length).Trim()
    try { $swJson = $raw | ConvertFrom-Json } catch { $swJson = $null }
  }
}
Check '预跑脚本返回了读数' ($null -ne $swJson)

if ($null -ne $swJson) {
  Check '设置 → 模型分区打开' ($swJson.openFailed -ne $true)

  if ($State -eq 'flow') {
    # A：两栏形态
    Check '左栏列出两个端点（deepseek / fake）' (($swJson.shape.rail -join ',') -eq 'deepseek,fake') (($swJson.shape.rail) -join ',')
    Check '默认落在默认端点 deepseek 上' ($swJson.shape.selected -eq 'deepseek' -and $swJson.shape.detail -eq 'deepseek') "$($swJson.shape.selected)/$($swJson.shape.detail)"
    Check '右栏详情头写着显示名 + id + 默认标' ($swJson.shape.title -like 'DeepSeek 官方*' -and $swJson.shape.title -like '*deepseek*' -and $swJson.shape.title -like '*默认*') $swJson.shape.title
    Check '模型列表两行（v4-pro / flash），默认模型是 v4-pro' ((($swJson.shape.models -join ',') -eq 'deepseek-v4-pro,deepseek-flash') -and ($swJson.shape.defaultModel -eq 'deepseek-v4-pro')) (($swJson.shape.models) -join ',')
    Check '连接行：密钥已配置（写的是变量名）' ($swJson.shape.key -like '*已配置*' -and $swJson.shape.key -like '*DEEPSEEK_API_KEY*') $swJson.shape.key
    Check 'Base URL 是输入框且带着配置里的地址' ($swJson.shape.baseUrl -eq 'https://api.deepseek.com/v1') $swJson.shape.baseUrl
    Check '左栏底部给出配置文件与凭据的完整路径' ($swJson.shape.paths.Count -eq 2 -and ($swJson.shape.paths -join ',') -like '*config.yaml*') (($swJson.shape.paths) -join ',')
    Check '桥可用：有「添加端点」卡、不出现只读说明' ($swJson.shape.addCard -eq $true -and $swJson.shape.readonlyNote -eq $true)

    # B：能力编辑器
    Check '点编辑在那一行下面展开能力编辑器' ($swJson.editor.open -eq $true)
    Check '编辑器四个字段（id / 显示名 / 上下文 / 最大输出）' ($swJson.editor.modelInputs -eq 4) ("$($swJson.editor.modelInputs)")
    Check '思考档位四档 chip 都在' ($swJson.editor.levelChips.Count -eq 4) (($swJson.editor.levelChips | ForEach-Object { $_.level }) -join ',')
    Check '输入模态三档 chip 都在（文本 / 照片 / 视频）' ($swJson.editor.modalityChips.Count -eq 3) (($swJson.editor.modalityChips | ForEach-Object { $_.modality }) -join ',')
    Check '档位字段是「线上值」那一档时并列画出四个输入框' ($swJson.editor.paramSelect -like '*reasoning_effort*' -and $swJson.editor.wireInputs -eq 4) "$($swJson.editor.paramSelect) / $($swJson.editor.wireInputs)"
    Check '改完之后：只剩「关 / 高」两档勾着、视频取消、线上值可以手写' ($swJson.editorChanged.wireShown -eq $true -and $swJson.editorChanged.wireValue -eq 'HIGH') $swJson.editorChanged.wireValue
    $swOnLevels = @($swJson.editorAfterSave.levelOn)
    Check '保存后回读：档位只剩 off / high，照片留着、视频去掉' (($swOnLevels -join ',') -eq 'off,high' -and ($swJson.editorAfterSave.modalityOn -join ',') -eq 'text,image' -and $swJson.editorAfterSave.wireValue -eq 'HIGH') "$($swOnLevels -join ',') / $($swJson.editorAfterSave.modalityOn -join ',')"
    Check '行上那串能力标跟着草稿实时更新' ($swJson.editorAfterSave.rowCaps -like '*256K*' -and $swJson.editorAfterSave.rowCaps -like '*图*') $swJson.editorAfterSave.rowCaps
    Check '测一次连接：假端点回话，结论点留在那一行后面' ($swJson.probe.mark -eq 'ok') ($swJson.probe.tip)

    # C：新增端点
    Check '点「添加端点」长出表单，左栏同时出现「新增端点」那一条' ($swJson.newForm.open -eq $true -and $swJson.newForm.railHasNew -eq $true)
    Check '表单四个输入（名字 / 显示名 / Base URL / API key）' ($swJson.newForm.fields.Count -eq 4 -and ($swJson.newForm.fields -join ',') -like '*password*') (($swJson.newForm.fields) -join ',')
    Check '表单里带着第一个模型（宿主拒收没有模型的端点）' ($swJson.newForm.modelInputs -eq 4) ("$($swJson.newForm.modelInputs)")
    Check '创建后左栏多出 nova、右栏落到它，模型列表有 nova-1' (($swJson.afterAdd.rail -join ',') -eq 'deepseek,fake,nova' -and $swJson.afterAdd.detail -eq 'nova' -and ($swJson.afterAdd.models -join ',') -eq 'nova-1') "$($swJson.afterAdd.rail -join ',') / $($swJson.afterAdd.detail) / $($swJson.afterAdd.models -join ',')"

    # D：拉取清单
    Check '拉取清单弹窗打开' ($swJson.discover.open -eq $true)
    Check '弹窗列出 3 个线上模型' ($swJson.discover.items.Count -eq 3) (($swJson.discover.items | ForEach-Object { $_.id }) -join ',')
    Check '已有的 fake-trace 置灰（种子里那个模型 id）（exists）' (($swJson.discover.items | Where-Object { $_.id -eq 'fake-trace' }).exists -eq $true)
    Check '未有的默认勾选' (($swJson.discover.items | Where-Object { $_.id -eq 'fake-fast' }).on -eq $true)
    Check '采用按钮计数 = 2' ($swJson.discover.adoptLabel -like '*2 个*') $swJson.discover.adoptLabel
    Check '采用后 fake 端点带上 fake-fast / fake-pro' ((($swJson.afterDiscover.models) -join ',') -like '*fake-fast*' -and (($swJson.afterDiscover.models) -join ',') -like '*fake-pro*') (($swJson.afterDiscover.models) -join ',')

    # E：删模型
    Check '删模型先过确认框' ($swJson.deleteModel.confirmShown -eq $true)
    Check '确认后 fake-pro 从列表消失，fake-trace 还在' ($swJson.deleteModel.gone -eq $true -and (($swJson.deleteModel.models) -join ',') -like '*fake-trace*') (($swJson.deleteModel.models) -join ',')

    # F：删端点
    Check '删端点先过确认框' ($swJson.deleteProvider.confirmShown -eq $true)
    Check '确认后 nova 从左栏消失' ($swJson.deleteProvider.gone -eq $true -and ($swJson.deleteProvider.rail -join ',') -eq 'deepseek,fake') (($swJson.deleteProvider.rail) -join ',')

    # G：收尾
    Check '收尾停在详情视图（截图拍的就是它）' ($swJson.final.detail -eq 'deepseek' -and ($swJson.final.models -join ',') -eq 'deepseek-v4-pro,deepseek-flash') "$($swJson.final.detail) / $($swJson.final.models -join ',')"

    # ── 落盘证据（直接读 config.yaml）───────────────────────────────────────────
    # 档位只剩 [off, high] 是非默认组合（默认四档会被省略不写），所以「整份文件里既没有
    # low 又有 off/high」就证明档位真被改过；`HIGH` 只可能来自手写的线上值；
    # `video` 只在种子里的 fake-trace 出现过一次，改完就不该再有。
    $swYaml = Get-Content -LiteralPath $swConfig -Raw
    Check 'config.yaml：fake-trace 的档位没有 low、仍写着 off / high' ($swYaml -notlike '*low*' -and $swYaml -like '*off*' -and $swYaml -like '*high*')
    Check 'config.yaml：线上值 HIGH 写进去了' ($swYaml -like '*HIGH*')
    $swVideoLines = @(Select-String -LiteralPath $swConfig -Pattern '^\s+- video\s*$' -ErrorAction SilentlyContinue)
    Check 'config.yaml：modalities 里不再有 video 那一行' ($swVideoLines.Count -eq 0) ("$($swVideoLines.Count) 行")
    Check 'config.yaml：nova 已被删除' ($swYaml -notlike '*nova*')
    Check 'config.yaml：采用进来的 fake-fast 在，被删的 fake-pro 不在' ($swYaml -like '*fake-fast*' -and $swYaml -notlike '*fake-pro*')
  }

  if ($State -eq 'editor') {
    Check '点编辑在那一行下面展开能力编辑器' ($swJson.editorOpen -eq $true)
    Check '测一次连接拿到结论点' ($swJson.probe.mark -eq 'ok') ($swJson.probe.tip)
  }

  if ($State -eq 'form') {
    Check '点「添加端点」长出表单' ($swJson.formOpen -eq $true)
  }

  if ($State -eq 'narrow') {
    Check '窄窗里两栏照常渲染（叠成一列）' ($swJson.narrow.detail -eq 'fake' -and ($swJson.narrow.models -join ',') -like '*fake-trace*')
  }
}

# ── 真实 ~/.dsc 未被污染 ───────────────────────────────────────────────────────
if ($null -ne $swRealBefore) {
  $swRealAfter = Get-DirFingerprint $swRealDsc
  Check '真实 ~/.dsc 文件数与内容指纹不变' ($swRealAfter.Count -eq $swRealBefore.Count -and $swRealAfter.ContentDigest -eq $swRealBefore.ContentDigest) ("$($swRealBefore.Count)/$($swRealAfter.Count)")
}

Check "截图落盘（$swShotName）" (Test-Path -LiteralPath (Join-Path $swShots $swShotName))

Write-Output ""
Write-Output "第七批·模型页自检（$State）：$($swTotal - $swFail)/$swTotal 通过"
if ($swFail -gt 0) { exit 1 }
