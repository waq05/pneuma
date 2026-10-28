# 第四批专项自检（2026-10-12）：手动排序拖拽 / csv+xlsx 表格预览 / 信任卡 / 市场源与安装。
#
# 一回跑完四组硬验收（eval 读 DOM 与几何 + 文件系统侧证据）：
#   ① 手动排序拖拽：缺省档就是 manual（宿主缺省）；视图菜单三项且「手动排序」点亮；
#      合成 DragEvent 把第二组拖到第一组之上（指示线出现过）→ 侧栏顺序翻转 →
#      隔离 settings.json 的 ui.workspaceOrder 写出同一顺序；会话行同组内上移 →
#      DOM 顺序变化 + ui.sessionOrder 写出这一组的完整序列。
#   ② csv/xlsx 预览：文件面板点 samples.csv → 表头/行数与内容一致；点 samples.xlsx →
#      两个 sheet 页签（汇总/明细），切页签表格跟着换。
#   ③ 信任卡：~/.dsc/plugins 里放两个第三方界面插件目录（一个可信任、一个门禁不过）→
#      插件中心出现「第三方界面插件」组；展开披露（契约区间 / 原生桥能力）→ 确认信任 →
#      卡片变已信任（出现开关）+ 隔离 plugins.json 的 uiTrust 段落记录；
#      门禁不过的那个只报原因、不给信任按钮。
#   ④ 市场源与安装：技能页市场 tab 里「编辑源」→ 写入本地自检源（scripts/_market-local.mjs）
#      → 保存（原生桥 setMarketSources）→ 浏览出 selftest-skill → 安装（原生桥
#      installMarketSkill）→ 隔离 ~/.dsc/skills 里落地那份 .md。
#
# 截图留档：默认停在 xlsx 预览；DSC_BATCH4_END=trust 时停在信任卡的披露展开态。
#
# 隔离：USERPROFILE/HOME + DSC_DESKTOP_STATE + DSC_DESKTOP_USER_DATA 全钉在隔离目录；
# 种子工作区也放在隔离 home 里（绝不碰用户的真实文件夹）；跑前跑后对真实 ~/.dsc 做
# 「文件数 + 内容聚合 SHA256」比对。
#
# 用法：pwsh -NoProfile -File ui-batch4-check.ps1（壳产物需已构建：pnpm run build:ui）

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$swShots = 'D:\dsc\desktop\shots'
$swElectron = Join-Path $swShots '..\node_modules\electron\dist\electron.exe'
$swEntry = Join-Path $swShots '..\out\main\index.js'
$swHome = Join-Path $swShots 'batch4-home'
$swDsc = Join-Path $swHome '.dsc'
$swRealDsc = Join-Path $env:USERPROFILE '.dsc'
$swMarketPort = 17441
$swDocsA = Join-Path $swHome 'docs-a'
$swDocsB = Join-Path $swHome 'docs-b'

function Get-DirFingerprint([string]$Path) {
  $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Sort-Object FullName)
  $lines = New-Object System.Collections.Generic.List[string]
  $locked = 0
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($Path.Length)
    $hash = 'LOCKED'
    try { $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash } catch { $locked += 1 }
    $lines.Add("$rel|$($file.Length)|$hash")
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $contentJoined = [string]::Join("`n", ($lines | ForEach-Object { $parts = $_ -split '\|'; "$($parts[0])|$($parts[2])" }))
  $contentDigest = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($contentJoined))).Replace('-', '').ToLowerInvariant()
  return [pscustomobject]@{ Count = $files.Count; ContentDigest = $contentDigest; Locked = $locked; Lines = $lines }
}

# ── 种子：两个隔离工作区 + 三/一条合成会话 + desktop.json ─────────────────────
Remove-Item -Recurse -Force -LiteralPath $swHome -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $swDsc | Out-Null
New-Item -ItemType Directory -Force -Path $swDocsA, $swDocsB | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $swHome 'AppData\Roaming') | Out-Null

# 会话目录名 = cwd 的 `[\\/:]+` → '-'（core/session.ts）。docs-a 三个会话（拖拽用），docs-b 一个。
$swKeyA = ($swDocsA -replace '[:\\/]+', '-')
$swKeyB = ($swDocsB -replace '[:\\/]+', '-')
New-Item -ItemType Directory -Force -Path (Join-Path $swDsc "sessions\$swKeyA"), (Join-Path $swDsc "sessions\$swKeyB") | Out-Null

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$swA1 = 'a1111111-2222-3333-4444-555555555555'
$swA2 = 'a2222222-2222-3333-4444-555555555555'
$swA3 = 'a3333333-2222-3333-4444-555555555555'
$swB1 = 'b1111111-2222-3333-4444-555555555555'
$swSeedSession = {
  param($Dir, $Uuid, $Cwd, $Title, $AgoMs)
  $lines = @(
    "{`"type`":`"meta`",`"id`":`"$Uuid`",`"cwd`":`"$($Cwd -replace '\\', '\\')`",`"createdAt`":$($now - $AgoMs)}",
    "{`"type`":`"user`",`"text`":`"自检样本会话：$Title`",`"ts`":$($now - $AgoMs + 1000)}"
  )
  Set-Content -LiteralPath (Join-Path $Dir "$Uuid.jsonl") -Value $lines -Encoding UTF8
}
& $swSeedSession (Join-Path $swDsc "sessions\$swKeyA") $swA1 $swDocsA '样本甲' 30000
& $swSeedSession (Join-Path $swDsc "sessions\$swKeyA") $swA2 $swDocsA '样本乙' 20000
& $swSeedSession (Join-Path $swDsc "sessions\$swKeyA") $swA3 $swDocsA '样本丙' 10000
& $swSeedSession (Join-Path $swDsc "sessions\$swKeyB") $swB1 $swDocsB '样本丁' 40000
$seedMeta = @{
  version = 1
  sessions = @{
    $swA1 = @{ title = '样本甲' }
    $swA2 = @{ title = '样本乙' }
    $swA3 = @{ title = '样本丙' }
    $swB1 = @{ title = '样本丁' }
  }
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath (Join-Path $swDsc 'sessions\meta.json') -Value $seedMeta -Encoding UTF8

Set-Content -LiteralPath (Join-Path $swDsc 'desktop.json') -Encoding UTF8 -Value (@{
  lastCwd = $swDocsA
  recentCwds = @($swDocsA, $swDocsB)
  ui = 'shell'
} | ConvertTo-Json -Depth 4)

# 市场源直接种成本地自检源：市场 tab 的首次浏览不走网络，编辑源也有现成的前值可验。
Set-Content -LiteralPath (Join-Path $swDsc 'settings.json') -Encoding UTF8 -Value (@{
  marketSources = @(@{ name = '自检源'; url = "http://127.0.0.1:$swMarketPort/index.json" })
} | ConvertTo-Json -Depth 4)

# csv / xlsx 样本 + 两个第三方界面插件目录
& node (Join-Path $swShots '_batch4-seed.mjs') $swHome $swDocsA | Out-Null
if ($LASTEXITCODE -ne 0) { throw '种子脚本失败' }

# ── 预跑 eval：拖拽 / 预览 / 信任卡 / 市场 ─────────────────────────────────────
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
  const out = {};
  try {

  // ── ① 手动排序拖拽 ──────────────────────────────────────────────────────────
  out.phase = 'drag';
  const groupRows = () => [...document.querySelectorAll('.group .group-row')];
  const groupOrder = () => groupRows().map((r) => (r.querySelector('.dir') ?? {}).textContent?.trim() ?? '');
  const sessRows = () => [...document.querySelectorAll('.sess-item')];
  const sessionTitles = () => sessRows().map((r) => (r.querySelector('.title') ?? {}).textContent?.trim() ?? '');

  const viewBtn = document.querySelector('[aria-label="视图选项"]');
  if (viewBtn !== null) { viewBtn.click(); await wait(350); }
  const menu = document.querySelector('.view-menu');
  const items = menu === null ? [] : [...menu.querySelectorAll('.menu-item')].map((b) => ({
    text: (b.querySelector('.menu-text') ?? {}).textContent?.trim() ?? '',
    on: b.classList.contains('on'),
  }));
  out.viewMenuDiag = {
    found: viewBtn !== null,
    menu: menu !== null,
    texts: items.map((i) => i.text),
    html: viewBtn === null ? null : viewBtn.outerHTML.slice(0, 100),
  };
  const sortNames = ['手动排序', '最近更新', '创建时间'];
  out.sortSection = items.filter((i) => sortNames.includes(i.text));
  out.manualActive = out.sortSection.some((i) => i.text === '手动排序' && i.on);
  const backdrop = document.querySelector('.menu-backdrop');
  if (backdrop !== null) backdrop.click();
  await wait(300);

  out.groupOrderBefore = groupOrder();
  if (groupRows().length >= 2) {
    const dt = new DataTransfer();
    const src = groupRows()[1];
    const dst = groupRows()[0];
    const rect = dst.getBoundingClientRect();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    await wait(100);
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: rect.top + 4 }));
    await wait(120);
    out.groupDropLine = document.querySelector('.group.drop-above') !== null || document.querySelector('.group.drop-below') !== null;
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: rect.top + 4 }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    await wait(800);
  }
  out.groupOrderAfter = groupOrder();

  out.sessionBefore = sessionTitles();
  if (sessRows().length >= 2) {
    const dt = new DataTransfer();
    const src = sessRows()[1];
    const dst = sessRows()[0];
    const rect = dst.getBoundingClientRect();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    await wait(100);
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: rect.top + 2 }));
    await wait(120);
    out.sessionDropLine = document.querySelector('.sess-item.drop-above') !== null || document.querySelector('.sess-item.drop-below') !== null;
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: rect.top + 2 }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    await wait(800);
  }
  out.sessionAfter = sessionTitles();

  // ── ② csv / xlsx 预览 ──────────────────────────────────────────────────────
  out.phase = 'preview';
  const chips = () => [...document.querySelectorAll('.dock-strip .dock-chip')];
  const clickChip = (label) => {
    const chip = chips().find((c) => (c.textContent ?? '').includes(label));
    if (chip !== undefined) chip.click();
    return chip !== undefined;
  };
  const previewTable = () => document.querySelector('.file-preview-body .file-table');
  const previewHeaders = () => [...document.querySelectorAll('.file-preview-body .file-table thead th')].map((c) => (c.textContent ?? '').trim());
  const previewBodyRows = () => document.querySelectorAll('.file-preview-body .file-table tbody tr').length;
  const clickFile = async (name) => {
    const rows = [...document.querySelectorAll('.files-list .file-row')];
    const row = rows.find((r) => (r.querySelector('.file-name') ?? {}).textContent?.trim() === name);
    if (row === undefined) return false;
    row.click();
    return true;
  };

  // dock 默认收起：Ctrl+P 打开右侧栏并落到「文件」页签（旧桌面版的快捷键路径），
  // 顶栏那颗开合钮只展开、不指定页签（展开给上次那套布局）。
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }));
  await waitFor(() => chips().length > 0, 5000);
  clickChip('文件');
  await wait(400);
  await waitFor(() => document.querySelectorAll('.files-list .file-row').length > 0, 12000);
  out.dockDiag = {
    chips: chips().map((c) => (c.textContent ?? '').trim()),
    rows: document.querySelectorAll('.files-list .file-row').length,
    cwd: (document.querySelector('.files-cwd') ?? {}).textContent ?? null,
  };
  out.fsProbe = await fetch('/api/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'dock', args: ['fs-list', { dir: '__DOCS_A__' }] }),
  })
    .then((res) => res.json())
    .then((doc) => ({ ok: doc.ok, count: Array.isArray(doc.value?.entries) ? doc.value.entries.length : null, error: doc.error ?? null }))
    .catch((error) => ({ error: String(error) }));
  out.csvOpened = await clickFile('samples.csv');
  const csvTable = await waitFor(() => previewTable(), 8000);
  out.csv = csvTable === null ? null : {
    headers: previewHeaders(),
    rows: previewBodyRows(),
    truncated: document.querySelector('.file-preview-body .tree-note') !== null,
  };
  clickChip('文件');
  await wait(250);
  out.xlsxOpened = await clickFile('samples.xlsx');
  const xlsxTable = await waitFor(() => previewTable() !== null && document.querySelectorAll('.file-sheet').length > 0, 10000);
  out.xlsx = xlsxTable === null ? null : {
    sheets: [...document.querySelectorAll('.file-sheet')].map((b) => (b.textContent ?? '').trim()),
    headers: previewHeaders(),
    rows: previewBodyRows(),
  };
  const detailSheet = [...document.querySelectorAll('.file-sheet')].find((b) => (b.textContent ?? '').includes('明细'));
  if (detailSheet !== undefined) { detailSheet.click(); await wait(500); }
  out.xlsxDetail = { headers: previewHeaders(), rows: previewBodyRows() };

  // ── ③ 信任卡 ───────────────────────────────────────────────────────────────
  out.phase = 'trust';
  const navItems = () => [...document.querySelectorAll('.sidebar-nav .nav-item')];
  const clickNav = (text) => {
    const item = navItems().find((b) => (b.textContent ?? '').includes(text));
    if (item !== undefined) item.click();
    return item !== undefined;
  };
  clickNav('插件');
  await waitFor(() => document.querySelector('.plugins') !== null, 8000);
  await wait(500);
  out.trustProbe = await fetch('/api/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'listUiTrust', args: [] }),
  })
    .then((res) => res.json())
    .then((doc) => ({ ok: doc.ok, count: Array.isArray(doc.value) ? doc.value.length : null, error: doc.error ?? null }))
    .catch((error) => ({ error: String(error) }));
  out.trustGroups = [...document.querySelectorAll('.plugin-group-label')].map((g) => (g.textContent ?? '').trim());
  const badge = document.querySelector('.trust-card[data-trust="demo-badge"]');
  const bad = document.querySelector('.trust-card[data-trust="demo-bad"]');
  out.badgeBefore = badge === null ? null : {
    desc: (badge.querySelector('.plugin-desc') ?? {}).textContent?.trim() ?? '',
    hasTrustButton: badge.querySelector('.btn-primary') !== null,
    hasSwitch: badge.querySelector('.switch') !== null,
  };
  out.badCard = bad === null ? null : {
    desc: (bad.querySelector('.plugin-desc') ?? {}).textContent?.trim() ?? '',
    hasTrustButton: bad.querySelector('.btn-primary') !== null,
  };
  if (badge !== null) {
    const openBtn = badge.querySelector('.btn-primary');
    if (openBtn !== null) { openBtn.click(); }
    const disclosure = await waitFor(() => badge.querySelector('.trust-disclosure'), 4000);
    out.disclosure = disclosure === null ? null : (disclosure.textContent ?? '');
    const confirmBtn = disclosure === null ? undefined : disclosure.querySelector('.btn-primary');
    if (confirmBtn !== undefined && confirmBtn !== null) { confirmBtn.click(); }
    const trusted = await waitFor(() => badge.querySelector('.switch') !== null, 8000);
    out.badgeAfter = { trusted: trusted !== null, desc: (badge.querySelector('.plugin-desc') ?? {}).textContent?.trim() ?? '' };
  }

  // ── ④ 市场源与安装 ─────────────────────────────────────────────────────────
  out.phase = 'market';
  clickNav('技能');
  await waitFor(() => document.querySelector('.skills') !== null, 8000);
  await wait(400);
  const marketTab = [...document.querySelectorAll('.skills-tabs button')].find((b) => (b.textContent ?? '').includes('市场'));
  if (marketTab !== undefined) { marketTab.click(); }
  await waitFor(() => document.querySelectorAll('.market-row').length > 0 || document.querySelector('.settings-note.error') !== null, 15000);
  const editBtn = [...document.querySelectorAll('.market-sources .text-btn')].find((b) => (b.textContent ?? '').trim() === '编辑源');
  if (editBtn !== undefined) { editBtn.click(); }
  const area = await waitFor(() => document.querySelector('.market-edit textarea'), 3000);
  out.marketPrefill = area === null ? null : (area.value ?? '');
  if (area !== null) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(area, '自检源B, http://127.0.0.1:__MARKET_PORT__/index.json');
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);
    const saveBtn = [...document.querySelectorAll('.market-edit .btn-primary')].find((b) => (b.textContent ?? '').includes('保存市场源'));
    if (saveBtn !== undefined) { saveBtn.click(); }
  }
  // 原生桥直调：拿旧源名必得 ok:false（保存后清单里已经没有它）——桥活着、回包毫秒级。
  {
    const t0 = performance.now();
    try {
      const value = await window.dscNative.call('installMarketSkill', ['自检源', 'selftest-skill']);
      out.nativeInstallProbe = { ms: Math.round(performance.now() - t0), ok: value?.ok === true, error: value?.error ?? null };
    } catch (error) {
      out.nativeInstallProbe = { ms: Math.round(performance.now() - t0), error: String(error) };
    }
  }
  // 等保存后的重抓落地：认准**新源名**的行（旧源名的残留行不算数）。
  const row = await waitFor(
    () =>
      [...document.querySelectorAll('.market-row')].find((r) => {
        const text = r.textContent ?? '';
        return text.includes('selftest-skill') && text.includes('自检源B');
      }),
    20000,
  );
  out.market = { rowShown: row !== undefined, rowText: row === undefined ? null : (row.textContent ?? '').trim() };
  if (row !== undefined) {
    const installBtn = row.querySelector('.market-install');
    if (installBtn !== null && !(installBtn.textContent ?? '').includes('已安装')) { installBtn.click(); }
    const done = await waitFor(() => {
      const btn = row.querySelector('.market-install');
      return btn !== null && (btn.textContent ?? '').includes('已安装') ? btn : null;
    }, 20000);
    out.market.installed = done !== null;
    out.market.installLabel = done === null
      ? (row.querySelector('.market-install') ?? {}).textContent?.trim() ?? null
      : (done.textContent ?? '').trim();
    out.market.toasts = [...document.querySelectorAll('.dsc-toast')].map((t) => (t.textContent ?? '').trim());
  }

  // ── 收尾画面：默认停在 xlsx 预览（切回对话页再开预览） ───────────────────────
  out.phase = 'end';
  const endScreen = '__END_SCREEN__';
  const backToChat = navItems().find((b) => b.classList.contains('on'));
  if (backToChat !== undefined) { backToChat.click(); await wait(400); }
  if (endScreen === 'trust') {
    clickNav('插件');
    await waitFor(() => document.querySelector('.trust-card[data-trust="demo-badge"]') !== null, 6000);
    await wait(300);
    const card = document.querySelector('.trust-card[data-trust="demo-badge"]');
    const btn = card === null ? null : card.querySelector('.btn-primary');
    if (btn !== null && btn !== undefined) btn.click();
    await wait(500);
  } else {
    clickChip('文件');
    await wait(300);
    await clickFile('samples.xlsx');
    await waitFor(() => previewTable() !== null, 6000);
    await wait(300);
  }
  out.endScreen = endScreen;
  } catch (error) {
    out.error = (error && error.message) || String(error);
  }
  return out;
})()
'@
$swEval = $swEval.Replace('__MARKET_PORT__', [string]$swMarketPort)
$swEval = $swEval.Replace('__DOCS_A__', $swDocsA.Replace('\', '\\'))
$swEval = $swEval.Replace('__END_SCREEN__', $(if ($env:DSC_BATCH4_END) { $env:DSC_BATCH4_END } else { 'table' }))

# ── 本地市场源（回环上的内存服务）──────────────────────────────────────────────
$swMarketLog = Join-Path $swShots 'ui-batch4-market.log'
Remove-Item -LiteralPath $swMarketLog -ErrorAction SilentlyContinue
$swMarketProc = Start-Process -FilePath 'node' -ArgumentList "D:\dsc\scripts\_market-local.mjs $swMarketPort" -PassThru -RedirectStandardOutput $swMarketLog -RedirectStandardError "$swMarketLog.err" -WorkingDirectory 'D:\dsc'
Start-Sleep -Milliseconds 1200

Write-Output '=== 真实 ~/.dsc 跑前指纹 ==='
$swBefore = Get-DirFingerprint $swRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 内容聚合 {2}" -f $swBefore.Count, $swBefore.Locked, $swBefore.ContentDigest)

$env:DSC_DESKTOP_USER_DATA = Join-Path $swHome 'electron-userdata'
$env:USERPROFILE = $swHome
$env:HOME = $swHome
$env:DSC_DESKTOP_STATE = Join-Path $swDsc 'desktop.json'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SHOT = Join-Path $swShots 'ui-batch4.png'
$env:DSC_DESKTOP_SHOT_DELAY = '108000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '98000'
$env:DSC_DESKTOP_SHOT_EVAL = $swEval
Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue
Remove-Item Env:DSC_UI_QUERY -ErrorAction SilentlyContinue

$outLog = Join-Path $swShots 'ui-batch4.out.log'
$errLog = Join-Path $swShots 'ui-batch4.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue

try {
  $swProc = Start-Process -FilePath $swElectron -ArgumentList $swEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $swDeadline = (Get-Date).AddSeconds(200)
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
    Env:DSC_DESKTOP_STATE -ErrorAction SilentlyContinue
  if ($null -ne $swMarketProc -and -not $swMarketProc.HasExited) {
    & taskkill /PID $swMarketProc.Id /T /F 2>&1 | Out-Null
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
  # ① 拖拽
  Check '视图选项菜单打得开（定位按钮在）' ($null -ne $swJson.viewMenuDiag -and $swJson.viewMenuDiag.found -eq $true -and $swJson.viewMenuDiag.menu -eq $true) ($swJson.viewMenuDiag | ConvertTo-Json -Compress)
  Check '缺省排序档是「手动排序」（宿主缺省）' ($swJson.manualActive -eq $true)
  Check '排序方式三项：手动排序/最近更新/创建时间' ($swJson.sortSection.Count -eq 3 -and ($swJson.sortSection.text -join ',') -eq '手动排序,最近更新,创建时间') ($swJson.viewMenuDiag.texts -join ',')
  Check '时间档顺序：最新在前（丙/乙/甲）' (($swJson.sessionBefore -join ',') -eq '样本丙,样本乙,样本甲')
  Check '组行拖拽出现指示线' ($swJson.groupDropLine -eq $true)
  Check '组顺序翻转（第二组拖到第一组之上）' ($swJson.groupOrderAfter[0] -eq $swJson.groupOrderBefore[1] -and $swJson.groupOrderAfter[1] -eq $swJson.groupOrderBefore[0])
  Check '会话行拖拽出现指示线' ($swJson.sessionDropLine -eq $true)
  Check '会话顺序：[乙,丙,甲]（把第二条拖到第一条之上）' (($swJson.sessionAfter -join ',') -eq (($swJson.sessionBefore[1], $swJson.sessionBefore[0], $swJson.sessionBefore[2]) -join ','))

  $swSettings = Get-Content -LiteralPath (Join-Path $swDsc 'settings.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
  if ($null -eq $swSettings) { $swSettings = [pscustomobject]@{} }
  $swOrder = @($swSettings.ui.workspaceOrder)
  $swOrderLeaf = @($swOrder | ForEach-Object { [System.IO.Path]::GetFileName($_) })
  Check 'settings.json 里 workspaceOrder 与拖后的侧栏顺序一致' (($swOrderLeaf -join ',') -eq ($swJson.groupOrderAfter -join ',')) (($swOrder -join ',') + ' / ' + ($swJson.groupOrderAfter -join ','))
  $swSessionKeys = @($swSettings.ui.sessionOrder.PSObject.Properties.Name)
  $swSessionSeq = if ($swSessionKeys.Count -gt 0) { @($swSettings.ui.sessionOrder.$($swSessionKeys[0])) } else { @() }
  Check 'settings.json 里 sessionOrder 写出这一组的完整序列（3 条，乙在首）' ($swSessionSeq.Count -eq 3 -and $swSessionSeq[0].EndsWith("$swA2.jsonl")) ($swSessionSeq -join ',')

  # ② 预览
  Check '停靠区开关打开后文件面板出条目（fs-list 通道也直查过一次）' ($null -ne $swJson.dockDiag -and $swJson.dockDiag.rows -gt 0 -and $null -ne $swJson.fsProbe -and $swJson.fsProbe.ok -eq $true -and $swJson.fsProbe.count -gt 0) (($swJson.dockDiag | ConvertTo-Json -Compress) + ' / ' + ($swJson.fsProbe | ConvertTo-Json -Compress))
  Check 'csv 表格：表头/行数正确、未截断' ($null -ne $swJson.csv -and ($swJson.csv.headers -join ',') -eq '名称,数量,单价' -and $swJson.csv.rows -eq 3 -and $swJson.csv.truncated -eq $false) ($swJson.csv | ConvertTo-Json -Compress)
  Check 'xlsx 表格：两个 sheet 页签（汇总/明细）+ 首表数据' ($null -ne $swJson.xlsx -and ($swJson.xlsx.sheets -join ',') -eq '汇总,明细' -and ($swJson.xlsx.headers -join ',') -eq '季度,收入,成本' -and $swJson.xlsx.rows -eq 4)
  Check '切换 sheet 后表格跟着换（明细表头）' (($swJson.xlsxDetail.headers -join ',') -eq '项目,负责人' -and $swJson.xlsxDetail.rows -eq 3)

  # ③ 信任卡
  Check 'listUiTrust 直查返回 2 行（宿主侧）' ($null -ne $swJson.trustProbe -and $swJson.trustProbe.ok -eq $true -and $swJson.trustProbe.count -eq 2) ($swJson.trustProbe | ConvertTo-Json -Compress)
  Check '插件页出现「第三方界面插件」组（2 个）' (($swJson.trustGroups -join '|') -match '第三方界面插件 2')
  Check 'demo-badge 卡：还没有信任记录、有信任按钮、无开关' ($null -ne $swJson.badgeBefore -and $swJson.badgeBefore.desc -match '还没有信任记录' -and $swJson.badgeBefore.hasTrustButton -eq $true -and $swJson.badgeBefore.hasSwitch -eq $false)
  Check '披露摊开能力面（契约区间 + 原生桥）' ($null -ne $swJson.disclosure -and $swJson.disclosure.Contains('@dsc/ui 区间：^1.0.0') -and $swJson.disclosure.Contains('原生桥'))
  Check '确认信任后卡片变已信任（出现开关）' ($null -ne $swJson.badgeAfter -and $swJson.badgeAfter.trusted -eq $true)
  Check 'demo-bad 只报门禁原因、不给信任按钮' ($null -ne $swJson.badCard -and $swJson.badCard.desc -match '^⚠' -and $swJson.badCard.hasTrustButton -eq $false)
  $swPluginsJson = Get-Content -LiteralPath (Join-Path $swDsc 'plugins.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
  Check 'plugins.json 的 uiTrust 落了 demo-badge 这条' ($null -ne $swPluginsJson.uiTrust.'demo-badge/ui/client.js')

  # ④ 市场
  Check '原生桥直调：旧源名回 ok:false、回包毫秒级（桥活着）' ($null -ne $swJson.nativeInstallProbe -and $swJson.nativeInstallProbe.ok -eq $false -and $swJson.nativeInstallProbe.ms -lt 5000) ($swJson.nativeInstallProbe | ConvertTo-Json -Compress)
  Check '市场源保存后重抓出的是新源名的行' ($null -ne $swJson.market -and $swJson.market.rowShown -eq $true -and $swJson.market.rowText -match '自检源B') ($swJson.market.rowText)
  Check '安装完成（按钮变已安装）' ($null -ne $swJson.market -and $swJson.market.installed -eq $true)
  $swSkillFile = Join-Path $swDsc 'skills\selftest-skill.md'
  Check '技能真的落进隔离 ~/.dsc/skills/selftest-skill.md' (Test-Path -LiteralPath $swSkillFile)
  $swSettings2 = Get-Content -LiteralPath (Join-Path $swDsc 'settings.json') -Raw | ConvertFrom-Json
  Check '编辑源预填当前清单（自检源 + 本地地址）' ($null -ne $swJson.marketPrefill -and $swJson.marketPrefill.Contains('自检源') -and $swJson.marketPrefill.Contains('http://127.0.0.1:'))
  Check 'settings.json 的 marketSources 写成保存后的自检源B' (@($swSettings2.marketSources.name) -contains '自检源B')
}

Write-Output ("截图：{0}" -f (Test-Path -LiteralPath (Join-Path $swShots 'ui-batch4.png')))

Write-Output '=== 真实 ~/.dsc 跑后指纹 ==='
$swAfter = Get-DirFingerprint $swRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 内容聚合 {2}" -f $swAfter.Count, $swAfter.Locked, $swAfter.ContentDigest)
$swDiff = Compare-Object -ReferenceObject $swBefore.Lines -DifferenceObject $swAfter.Lines
if ($null -eq $swDiff) { Write-Output '差异行：无（逐文件哈希完全一致）' }
else { Write-Output ("差异行：{0} 条" -f @($swDiff).Count); $swDiff | Select-Object -First 10 | ForEach-Object { '  ' + $_.SideIndicator + ' ' + $_.InputObject } }
Check '真实 ~/.dsc 零污染' ($swBefore.Count -eq $swAfter.Count -and $swBefore.ContentDigest -eq $swAfter.ContentDigest)

if ($swFail -eq 0) { Write-Output ("ui-batch4-check 完成：{0} 条断言全部通过" -f $swTotal) }
else { Write-Output ("ui-batch4-check 完成：{0}/{1} 条断言失败" -f $swFail, $swTotal); exit 1 }
