# 浏览器侧边栏专项实机自检（2026-10-14，对齐 dsh 的浏览器侧边栏：多页签 + 完整工具条）。
#
# 为什么单开一条：浏览器页签的内容是**主进程的原生 WebContentsView 覆盖层**，
# capturePage 拍不到（只拍合成帧），DOM 里也只有一块占位区。所以证据分三层：
#   ① DOM 层（eval 里读）：页签数 / chip 标题（= 网页标题）/ 空态 / 前后退可用态 / 地址栏；
#   ② 主进程 stderr：`[dock] browser view created|disposed`——建了几台、关页签有没有真销毁；
#   ③ 本机页面服务器的标题 token：切走再切回**token 不变 = 没有重新加载**（保活的唯一硬证据）。
#
# 硬验收（对应开发日志那一批）：
#   A. Ctrl+T 开出第一张浏览器页签：空态（「输入 HTTP(S) 地址开始浏览」）、**没建视图**、后退禁用；
#   B. 地址栏输 `127.0.0.1:<port>/` 回车：真加载 → data-browser-bound=1、chip 变网页标题、空态消失；
#   C. 同一页签再进一页：后退钮转为可用（原生把 canGoBack 推回来了）；
#   D. 再 Ctrl+T：**两张并存**（浏览器不再单例）、视图 id 不同、新那张是空态；
#   E. 切走（点「开始」chip）再切回：标题 token 不变 = 页面没重新加载；
#   F. 网页自己 window.open：**转成新页签**（不是顶掉当前页）；
#   G. 地址栏输 javascript: —— 就地报「只支持 http/https 地址」，不导航、不开新页签；
#   H. 关掉一张浏览器页签：原生 stderr 出 disposed（视图真的销毁，不是只藏起来）。
#
# 隔离：USERPROFILE/HOME + DSC_DESKTOP_STATE + DSC_DESKTOP_USER_DATA 全钉在隔离目录；
# 跑前跑后对真实 ~/.dsc 做「文件数 + 内容聚合 SHA256」比对。
#
# 用法：pwsh -NoProfile -File ui-browser-check.ps1（前置：pnpm run build + pnpm run build:ui
#       + desktop 的 pnpm run build）

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$swShots = 'D:\dsc\desktop\shots'
$swElectron = Join-Path $swShots '..\node_modules\electron\dist\electron.exe'
$swEntry = Join-Path $swShots '..\out\main\index.js'
$swHome = Join-Path $swShots 'browser-home'
$swDsc = Join-Path $swHome '.dsc'
$swRealDsc = Join-Path $env:USERPROFILE '.dsc'
$swWork = Join-Path $swHome 'ws'
$swPort = 38173

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
  return [pscustomobject]@{ Count = $files.Count; ContentDigest = $contentDigest; Locked = $locked }
}

$swRealBefore = if (Test-Path -LiteralPath $swRealDsc) { Get-DirFingerprint $swRealDsc } else { $null }

# ── 种子：一个工作区 + 一个「没有会话」的干净壳（浏览器页签不需要会话）──────────────
Remove-Item -Recurse -Force -LiteralPath $swHome -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $swDsc, $swWork | Out-Null
Set-Content -LiteralPath (Join-Path $swWork 'marker.txt') -Encoding UTF8 -Value 'browser check'
Set-Content -LiteralPath (Join-Path $swDsc 'desktop.json') -Encoding UTF8 -Value (@{
  lastCwd = $swWork
  recentCwds = @($swWork)
  ui = 'shell'
} | ConvertTo-Json -Depth 4)

# ── 本机页面服务器（浏览器要真加载一页才有标题/历史/弹窗可验）──────────────────────
$swPageOut = Join-Path $swShots 'browser-page.out.log'
Remove-Item -LiteralPath $swPageOut -ErrorAction SilentlyContinue
$swPages = Start-Process -FilePath 'node' -ArgumentList (Join-Path $swShots '_browser-page-server.mjs'), $swPort -PassThru -RedirectStandardOutput $swPageOut -RedirectStandardError (Join-Path $swShots 'browser-page.err.log')
$swPageReady = $false
for ($i = 0; $i -lt 40; $i++) {
  if (Test-Path -LiteralPath $swPageOut) {
    if ((Get-Content -LiteralPath $swPageOut -Raw -ErrorAction SilentlyContinue) -like '*page server on*') { $swPageReady = $true; break }
  }
  Start-Sleep -Milliseconds 250
}
if (-not $swPageReady) { Write-Output "FAIL  本机页面服务器没起来（端口 $swPort 被占？）"; & taskkill /PID $swPages.Id /T /F 2>&1 | Out-Null; exit 1 }

# ── 预跑 eval ──────────────────────────────────────────────────────────────────
$swEval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = pred(); if (v) return v; await wait(150); }
    return null;
  };
  const out = {};
  const panes = () => [...document.querySelectorAll('.browser-pane')];
  const holders = () => [...document.querySelectorAll('.browser-holder')];
  const visibleHolder = () => holders().find((h) => h.offsetParent !== null) ?? null;
  const input = () => [...document.querySelectorAll('.browser-url')].find((i) => i.offsetParent !== null) ?? null;
  // chip 文案带 ✕，统一剥掉；浏览器/开始/终端都走这一份
  const chipItems = () => [...document.querySelectorAll('.dock-chip')].map((c) => ({ el: c, text: (c.textContent ?? '').replace('✕', '').trim() }));
  const browserChips = () => chipItems().filter((c) => !['开始', '终端', '文件', 'Git'].includes(c.text));
  const backBtn = () => document.querySelector('.browser-bar .icon-btn[aria-label="后退"]');
  const forwardBtn = () => document.querySelector('.browser-bar .icon-btn[aria-label="前进"]');
  const tokenOf = (text) => (text.split('·')[1] ?? '').trim();
  // React 受控 input：直接改 value 不触发 onChange，要走原生 setter + input 事件
  const type = (el, text) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const enter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  await waitFor(() => { const root = document.querySelector('#root'); return root !== null && root.children.length > 0; }, 20000);
  await wait(1500);

  // ── A 第一张浏览器页签：空态、没建视图、后退禁用 ─────────────────────────────
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true }));
  const pane1 = await waitFor(() => document.querySelector('.browser-pane') !== null, 8000);
  out.paneCountAfterFirst = panes().length;
  out.emptyText = (document.querySelector('.browser-empty') ?? {}).textContent?.trim() ?? null;
  out.urlPlaceholder = input()?.getAttribute('placeholder') ?? null;
  out.boundBeforeLoad = visibleHolder()?.getAttribute('data-browser-bound') ?? null;
  out.backDisabledBefore = backBtn()?.disabled ?? null;

  // ── B 输地址回车：真加载（裸主机:端口 → 补 http://）──────────────────────────
  const first = input();
  if (first !== null) { type(first, '127.0.0.1:38173/'); enter(first); }
  out.bound1 = await waitFor(() => (visibleHolder()?.getAttribute('data-browser-bound') === '1' ? true : null), 20000);
  const label1 = await waitFor(() => {
    const hit = browserChips().find((c) => c.text.includes('自检页一'));
    return hit === undefined ? null : hit.text;
  }, 20000);
  out.loadedLabel1 = label1;
  out.emptyGoneAfterLoad = document.querySelector('.browser-empty') === null;
  out.addressAfterLoad = input()?.value ?? null;
  out.backDisabledAfterFirstLoad = backBtn()?.disabled ?? null;
  out.forwardDisabledAfterFirstLoad = forwardBtn()?.disabled ?? null;

  // ── C 同一页签再进一页：后退转可用 ──────────────────────────────────────────
  const second = input();
  if (second !== null) { type(second, '127.0.0.1:38173/two'); enter(second); }
  const label2 = await waitFor(() => {
    const hit = browserChips().find((c) => c.text.includes('自检页二'));
    return hit === undefined ? null : hit.text;
  }, 20000);
  out.loadedLabel2 = label2;
  out.backEnabledAfterTwo = backBtn()?.disabled === false;
  const firstToken = tokenOf(label2 ?? '');

  // ── D 再 Ctrl+T：两张并存、视图 id 不同、新那张空态 ─────────────────────────
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true }));
  await wait(800);
  out.paneCountAfterSecond = panes().length;
  out.viewIds = holders().map((h) => h.getAttribute('data-browser-view'));
  out.emptyCountAfterSecond = document.querySelectorAll('.browser-empty').length;

  // ── E 切走再切回：标题 token 不变 = 没重新加载 ──────────────────────────────
  chipItems().find((c) => c.text === '开始')?.el.click();
  await wait(1000);
  out.chipTextsAfterSwitchAway = chipItems().map((c) => c.text);
  browserChips().find((c) => c.text.includes('自检页二'))?.el.click();
  await wait(1500);
  out.labelAfterReturn = browserChips().find((c) => c.text.includes('自检页二'))?.text ?? null;
  out.sameTokenAfterReturn = out.labelAfterReturn !== null && tokenOf(out.labelAfterReturn) === firstToken && firstToken !== '';
  out.boundAfterReturn = visibleHolder()?.getAttribute('data-browser-bound') ?? null;

  // ── F 网页自己 window.open → 新页签（不是顶掉当前页）────────────────────────
  const popupInput = input();
  if (popupInput !== null) { type(popupInput, '127.0.0.1:38173/popup'); enter(popupInput); }
  await wait(6000);
  out.paneCountAfterPopup = panes().length;
  out.chipTextsAfterPopup = chipItems().map((c) => c.text);

  // ── G 地址闸门：javascript: 就地拒 ─────────────────────────────────────────
  const badInput = input();
  if (badInput !== null) { type(badInput, 'javascript:alert(1)'); enter(badInput); }
  await wait(600);
  out.badAddressError = (document.querySelector('.browser-error') ?? {}).textContent?.trim() ?? null;
  out.paneCountAfterBad = panes().length;
  out.addressAfterBad = input()?.value ?? null;

  // ── H 关掉一张浏览器页签（那张有真页面在的）─────────────────────────────────
  const before = panes().length;
  const victim = browserChips()[browserChips().length - 1];
  victim?.el.querySelector('.dock-chip-close')?.click();
  await wait(1500);
  out.paneCountBeforeClose = before;
  out.paneCountAfterClose = panes().length;
  out.closedDecreased = before > out.paneCountAfterClose;

  out.done = true;
  return out;
})()
'@

$env:DSC_DESKTOP_USER_DATA = Join-Path $swHome 'electron-userdata'
$env:USERPROFILE = $swHome
$env:HOME = $swHome
$env:DSC_DESKTOP_STATE = Join-Path $swDsc 'desktop.json'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SHOT = Join-Path $swShots 'ui-browser.png'
$env:DSC_DESKTOP_SHOT_DELAY = '180000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '162000'
$env:DSC_DESKTOP_SHOT_EVAL = $swEval
Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue
Remove-Item Env:DSC_UI_QUERY -ErrorAction SilentlyContinue

$outLog = Join-Path $swShots 'ui-browser.out.log'
$errLog = Join-Path $swShots 'ui-browser.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue

try {
  $swProc = Start-Process -FilePath $swElectron -ArgumentList $swEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $swDeadline = (Get-Date).AddSeconds(240)
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
  & taskkill /PID $swPages.Id /T /F 2>&1 | Out-Null
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
$swCreated = 0
$swDisposed = 0
if (Test-Path -LiteralPath $errLog) {
  $swCreated = @(Select-String -LiteralPath $errLog -Pattern '\[dock\] browser view created:').Count
  $swDisposed = @(Select-String -LiteralPath $errLog -Pattern '\[dock\] browser view disposed:').Count
}

Check '预跑脚本返回了读数' ($null -ne $swJson)
if ($null -ne $swJson) {
  # A
  Check 'Ctrl+T 开出一张浏览器页签' ($swJson.paneCountAfterFirst -eq 1) ("$($swJson.paneCountAfterFirst)")
  Check '新页签是空态（输入 HTTP(S) 地址开始浏览）' ($swJson.emptyText -like '*输入 HTTP(S) 地址开始浏览*') $swJson.emptyText
  Check '空态下没有建原生视图（不白开一个渲染进程）' ($null -eq $swJson.boundBeforeLoad) $swJson.boundBeforeLoad
  Check '没进过页面时后退禁用' ($swJson.backDisabledBefore -eq $true) ("$($swJson.backDisabledBefore)")
  # B
  Check '原生视图层真接住（data-browser-bound=1）' ($swJson.bound1 -eq $true)
  Check '裸主机:端口补成 http 且真加载（chip = 网页标题）' ($swJson.loadedLabel1 -like '自检页一*') $swJson.loadedLabel1
  Check '加载后空态消失' ($swJson.emptyGoneAfterLoad -eq $true)
  Check '地址栏回填成加载后的地址' ($swJson.addressAfterLoad -like '*127.0.0.1:38173*') $swJson.addressAfterLoad
  Check '第一页时前进仍禁用' ($swJson.forwardDisabledAfterFirstLoad -eq $true) ("$($swJson.forwardDisabledAfterFirstLoad)")
  # C
  Check '第二页标题进 chip' ($swJson.loadedLabel2 -like '自检页二*') $swJson.loadedLabel2
  Check '有历史后后退转可用（canGoBack 推回来了）' ($swJson.backEnabledAfterTwo -eq $true) ("$($swJson.backEnabledAfterTwo)")
  # D
  Check '再 Ctrl+T 开出第二张（浏览器不再单例）' ($swJson.paneCountAfterSecond -eq 2) ("$($swJson.paneCountAfterSecond)")
  $swIds = @($swJson.viewIds | Where-Object { $_ -ne $null })
  Check '每张页签各有自己的视图 id' ($swIds.Count -eq 2 -and $swIds[0] -ne $swIds[1]) ($swIds -join ',')
  Check '新开那张是空态（不自动加载页面）' ($swJson.emptyCountAfterSecond -eq 1) ("$($swJson.emptyCountAfterSecond)")
  # E
  Check '切走再切回：token 不变（页面没重新加载）' ($swJson.sameTokenAfterReturn -eq $true) ("$($swJson.labelAfterReturn)")
  Check '切回来视图仍接着（data-browser-bound=1）' ($swJson.boundAfterReturn -eq '1') $swJson.boundAfterReturn
  # F
  Check '网页自己 window.open → 转成新页签' ($swJson.paneCountAfterPopup -ge 3) ("$($swJson.paneCountAfterPopup) / $($swJson.chipTextsAfterPopup -join '|')")
  # G
  Check 'javascript: 被就地拒（不导航）' ($swJson.badAddressError -like '*只支持 http/https*') $swJson.badAddressError
  Check '被拒之后页签数没变（没整出新页签）' ($swJson.paneCountAfterBad -eq $swJson.paneCountAfterPopup) ("$($swJson.paneCountAfterBad)")
  # H
  Check '关页签后页签数减少' ($swJson.closedDecreased -eq $true) ("$($swJson.paneCountBeforeClose) → $($swJson.paneCountAfterClose)")
  Check '跑完拿到全部读数' ($swJson.done -eq $true)
}
# 原生层账本（stderr）：建了几台、关的有没有真销毁
Check '至少建了两台原生视图（真加载过的那两张）' ($swCreated -ge 2) ("created=$swCreated")
Check '关页签真的销毁了那一台' ($swDisposed -ge 1) ("disposed=$swDisposed")

$swRealAfter = if (Test-Path -LiteralPath $swRealDsc) { Get-DirFingerprint $swRealDsc } else { $null }
if ($null -eq $swRealBefore -and $null -eq $swRealAfter) {
  Check '真实 ~/.dsc 不存在 → 跑完仍不存在' $true
} else {
  Check '真实 ~/.dsc 未被触碰（文件数 + 内容聚合 SHA256）' (
    $null -ne $swRealBefore -and $null -ne $swRealAfter -and
    $swRealBefore.Count -eq $swRealAfter.Count -and $swRealBefore.ContentDigest -eq $swRealAfter.ContentDigest
  ) ("before=$($swRealBefore.Count)/$($swRealBefore.ContentDigest) after=$($swRealAfter.Count)/$($swRealAfter.ContentDigest)")
}

Write-Output ""
if ($swFail -eq 0) { Write-Output "全部 $swTotal 项通过" } else { Write-Output "$swFail/$swTotal 项失败" }
Write-Output "日志：$errLog"
exit $(if ($swFail -eq 0) { 0 } else { 1 })
