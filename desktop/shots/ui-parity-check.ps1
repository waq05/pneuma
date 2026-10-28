# 界面对照修复专项自检（2026-10-12 第二批：侧栏/工作区/状态栏/插件页/技能页/dock 页签条）。
#
# 一回跑完八处硬验收（eval 读 DOM 与几何，截图留档）：
#   ① 侧栏头：logo + 品牌 + 收起钮有 no-drag 豁免；点它 → .sidebar.rail 出现（56px 窄栏），
#      点窄栏 logo → 展开回来；
#   ② dock 页签条在面板**顶部**（几何断言：条顶 == 面板顶，条宽 == 面板宽）；
#   ③ 工作区行行尾两颗钮（··· 与 新建会话）；··· 菜单里有「删除工作区」；
#   ④ 状态栏第一段只有「N 轮 N 步」（模型名不在段上，收进悬浮说明）；ctx-card 在；
#   ⑤ 侧栏「技能」→ 主区独立整页（.skills 挂上、页签在、入口点亮）；再点回对话页；
#   ⑥ 「插件」→ 插件页；点卡片 → 详情页（面包屑 + 配置区）；可配置插件有齿轮图标；
#   ⑦ 底部目录行/用量行/设置行都在（数据统计行）；
#   ⑧ 「删除工作区」（挑非当前组）真能删：确认框 → 组从侧栏消失；跑完再看隔离 home 的
#      sessions/.archived 里有没有那份被归档的 jsonl（文件系统侧的硬证据）。
#      （「新建会话」切工作区的验收在 ui-switch-cwd-check.ps1：那一步会让宿主重启、
#       窗口重新加载，eval 上下文会被刷掉，跑在这个脚本里会把前面的读数一起弄丢。）
#
# 隔离：USERPROFILE/HOME 换掉宿主 ~/.dsc、独立 userData、`DSC_DESKTOP_STATE` 把桌面记忆
# 文件（desktop.json）也钉到隔离目录——`app.getPath('home')` 不读 USERPROFILE，没有最后
# 这一条，自检会读到真实工作区、⑧ 还会真写用户的记忆文件。跑前跑后对真实 ~/.dsc 做
# 「文件数 + 内容聚合 SHA256」比对。种子数据是合成会话（不含真实对话内容）。
#
# 用法：pwsh -NoProfile -File ui-parity-check.ps1（壳产物需已构建：pnpm run build:ui）

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$swShots = 'D:\dsc\desktop\shots'
$swElectron = Join-Path $swShots '..\node_modules\electron\dist\electron.exe'
$swEntry = Join-Path $swShots '..\out\main\index.js'
$swHome = Join-Path $swShots 'shell-switch-home'
$swDsc = Join-Path $swHome '.dsc'
$swRealDsc = Join-Path $env:USERPROFILE '.dsc'

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

# ── 种子数据：合成工作区（中性的自检样本，不含真实对话） ─────────────────────────
$seedDocs = 'C:\Users\waq\Desktop\documents'
$seedDsc = 'D:\dsc'
New-Item -ItemType Directory -Force -Path (Join-Path $swDsc 'sessions\C-Users-waq-Desktop-documents') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $swDsc 'sessions\D-dsc') | Out-Null
# 桌面记忆文件（DSC_DESKTOP_STATE 指到这里）：两个工作区，别的一律没有——断言才稳。
$seedDesktop = @{
  lastCwd = $seedDocs
  recentCwds = @($seedDocs, $seedDsc)
  ui = 'shell'
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath (Join-Path $swDsc 'desktop.json') -Value $seedDesktop -Encoding UTF8
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$docUuid = '11111111-2222-3333-4444-555555555555'
$dscUuid = '66666666-7777-8888-9999-aaaaaaaaaaaa'
$docLines = @(
  "{`"type`":`"meta`",`"id`":`"$docUuid`",`"cwd`":`"C:\\Users\\waq\\Desktop\\documents`",`"createdAt`":$($now - 3600000)}",
  "{`"type`":`"user`",`"text`":`"自检样本会话：这里是一句合成的用户消息。`",`"ts`":$($now - 3590000)}",
  "{`"type`":`"assistant`",`"text`":`"自检样本回复。`",`"ts`":$($now - 3580000)}"
)
Set-Content -LiteralPath (Join-Path $swDsc "sessions\C-Users-waq-Desktop-documents\$docUuid.jsonl") -Value $docLines -Encoding UTF8
$dscLines = @(
  "{`"type`":`"meta`",`"id`":`"$dscUuid`",`"cwd`":`"D:\\dsc`",`"createdAt`":$($now - 7200000)}",
  "{`"type`":`"user`",`"text`":`"自检样本会话（第二个工作区）。`",`"ts`":$($now - 7190000)}"
)
Set-Content -LiteralPath (Join-Path $swDsc "sessions\D-dsc\$dscUuid.jsonl") -Value $dscLines -Encoding UTF8
$seedMeta = @{
  version = 1
  sessions = @{
    $docUuid = @{ title = '自检样本 A' }
    $dscUuid = @{ title = '自检样本 B' }
  }
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath (Join-Path $swDsc 'sessions\meta.json') -Value $seedMeta -Encoding UTF8

$swEval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = pred(); if (v) return v; await wait(120); }
    return null;
  };
  await waitFor(() => {
    const root = document.querySelector('#root');
    return root !== null && root.children.length > 0;
  }, 20000);
  await wait(2500);
  const out = {};

  // ① 侧栏头：logo/品牌/收起钮（no-drag），点它 → 窄栏；点窄栏 logo → 展开回来。
  const header = document.querySelector('.sidebar-header');
  out.header = header === null ? null : {
    img: header.querySelector('img') !== null,
    brand: (header.querySelector('.brand') ?? {}).textContent ?? null,
    railToggle: header.querySelector('.rail-toggle') !== null,
    toggleRegion: (() => {
      const b = header.querySelector('.rail-toggle');
      return b === null ? null : getComputedStyle(b).webkitAppRegion;
    })(),
    channelTextGone: !(header.textContent ?? '').includes('已连接'),
  };
  const toggle = document.querySelector('.sidebar-header .rail-toggle');
  if (toggle !== null) { toggle.click(); await wait(500); }
  const rail = document.querySelector('.sidebar.rail');
  out.rail = rail === null ? null : {
    width: Math.round(rail.getBoundingClientRect().width),
    logo: rail.querySelector('.rail-logo img') !== null,
    buttons: Array.from(rail.querySelectorAll('.rail-btn, .rail-logo')).length,
    contentHidden: (() => {
      const slot = document.querySelector('.sidebar-slot');
      return slot !== null && getComputedStyle(slot).display === 'none';
    })(),
  };
  const railLogo = rail === null ? null : rail.querySelector('.rail-logo');
  if (railLogo !== null) { railLogo.click(); await wait(500); }
  out.expandedBack = document.querySelector('.sidebar.rail') === null && document.querySelector('.sidebar-header') !== null;

  // ② dock 页签条：开面板 → 条在面板顶部、条宽 == 面板宽。
  const dockToggle = document.querySelector('.icon-btn.dock-toggle');
  if (dockToggle !== null) { dockToggle.click(); await wait(600); }
  const strip = document.querySelector('.dock-strip');
  const slot = document.querySelector('.dock-slot');
  out.dock = strip === null || slot === null ? null : (() => {
    const s = strip.getBoundingClientRect();
    const d = slot.getBoundingClientRect();
    return {
      chips: Array.from(strip.querySelectorAll('.dock-chip')).map((b) => (b.textContent ?? '').trim()),
      topDelta: Math.round(s.top - d.top),
      widthDelta: Math.round(s.width - d.width),
    };
  })();

  // ③ 工作区行：行尾两颗钮 + ··· 菜单里有「删除工作区」。
  const groupRow = document.querySelector('.group-row');
  const rowButtons = groupRow === null ? [] : Array.from(groupRow.querySelectorAll('.row-actions .icon-btn'));
  out.workspaceRow = groupRow === null ? null : {
    buttons: rowButtons.length,
    tips: rowButtons.map((b) => b.getAttribute('data-tip')),
    groups: document.querySelectorAll('.group-row').length,
  };
  const moreBtn = rowButtons.find((b) => (b.getAttribute('aria-label') ?? '').includes('更多'));
  if (moreBtn !== undefined) { moreBtn.click(); await wait(350); }
  out.groupMenu = Array.from(document.querySelectorAll('.row-menu .menu-item')).map((b) => (b.textContent ?? '').trim());
  const backdrop = document.querySelector('.menu-backdrop');
  if (backdrop !== null) { backdrop.click(); await wait(250); }

  // ④ 状态栏：第一段只有「N 轮 N 步」；三张悬浮卡在。
  const turnTrigger = document.querySelector('.seg-turn .ctx-trigger');
  out.statusbar = turnTrigger === null ? null : {
    turnText: (turnTrigger.textContent ?? '').trim(),
    tokens: (document.querySelector('.seg-tokens .ctx-trigger') ?? {}).textContent?.trim() ?? null,
    context: (document.querySelector('.seg-context .ctx-trigger') ?? {}).textContent?.trim() ?? null,
    cards: document.querySelectorAll('.ctx-card').length,
    cardTitles: Array.from(document.querySelectorAll('.ctx-card .ctx-title')).map((t) => (t.textContent ?? '').trim()),
  };

  // ⑤ 技能入口 → 独立整页；再点一次 → 回对话页。
  const navItems = Array.from(document.querySelectorAll('.sidebar-nav .nav-item'));
  const skillsNav = navItems.find((b) => (b.textContent ?? '').includes('技能'));
  if (skillsNav !== undefined) { skillsNav.click(); await wait(800); }
  out.skillsPage = {
    mounted: document.querySelector('.skills') !== null,
    tab: (document.querySelector('.skills-tabs button.on') ?? {}).textContent?.trim() ?? null,
    navOn: skillsNav === undefined ? null : skillsNav.classList.contains('on'),
    importButton: Array.from(document.querySelectorAll('.skills-actions button')).map((b) => (b.textContent ?? '').trim()),
  };
  if (skillsNav !== undefined) { skillsNav.click(); await wait(400); }
  out.skillsBackToChat = document.querySelector('.skills') === null;

  // ⑥ 插件页：入口 → 整页；卡片 → 详情；齿轮图标数量。
  const pluginsNav = navItems.find((b) => (b.textContent ?? '').includes('插件'));
  if (pluginsNav !== undefined) { pluginsNav.click(); await wait(900); }
  out.pluginsPage = {
    mounted: document.querySelector('.plugins') !== null,
    rows: document.querySelectorAll('.plugin-row').length,
    gears: document.querySelectorAll('.plugin-row .icon-btn').length,
    groups: Array.from(document.querySelectorAll('.plugin-group-label')).map((g) => (g.textContent ?? '').trim()),
  };
  const firstRow = document.querySelector('.plugin-row');
  if (firstRow !== null) { firstRow.click(); await wait(900); }
  out.pluginDetail = {
    mounted: document.querySelector('.plugin-detail') !== null,
    back: (document.querySelector('.plugin-back') ?? {}).textContent?.trim() ?? null,
    configTitle: (document.querySelector('.plugin-detail-config .settings-group-title') ?? {}).textContent?.trim() ?? null,
    hasSwitches: document.querySelectorAll('.plugin-detail .switch').length,
  };
  const backBtn = document.querySelector('.plugin-back');
  if (backBtn !== null) { backBtn.click(); await wait(350); }
  if (pluginsNav !== undefined) { pluginsNav.click(); await wait(600); }
  out.pluginsBackToChat = document.querySelector('.plugins') === null && document.querySelector('.chat-wrap') !== null;

  // ⑦ 底部行：目录/用量/设置都在。
  const footer = document.querySelector('.sidebar-footer');
  out.footer = footer === null ? null : {
    rows: Array.from(footer.querySelectorAll('.row')).map((r) => (r.textContent ?? '').trim()),
    hasDir: footer.querySelector('.row .dir') !== null,
    hasSettings: footer.querySelector('.row-btn') !== null,
  };

  // ⑧ 删除工作区（挑非当前组）：··· 菜单 → 删除工作区 → 确认框「删除」→ 组从侧栏消失。
  const otherRow = Array.from(document.querySelectorAll('.group-row')).find((r) => !r.classList.contains('active'));
  const otherName = otherRow === undefined ? null : ((otherRow.querySelector('.dir') ?? {}).textContent ?? '').trim();
  const moreBtn2 = otherRow === undefined
    ? undefined
    : Array.from(otherRow.querySelectorAll('.row-actions .icon-btn')).find((b) => (b.getAttribute('aria-label') ?? '').includes('更多'));
  if (moreBtn2 !== undefined) { moreBtn2.click(); await wait(400); }
  const delItem = Array.from(document.querySelectorAll('.row-menu .menu-item')).find((b) => (b.textContent ?? '').trim() === '删除工作区');
  if (delItem !== undefined) { delItem.click(); await wait(600); }
  const confirmBtn = await waitFor(() => {
    const card = document.querySelector('.dsc-confirm');
    if (card === null) return null;
    return Array.from(card.querySelectorAll('.dsc-confirm__actions .dsc-btn')).find((b) => (b.textContent ?? '').trim() === '删除') ?? null;
  }, 5000);
  if (confirmBtn !== null) { confirmBtn.click(); }
  const gone = await waitFor(() => {
    const names = Array.from(document.querySelectorAll('.group-row .dir')).map((n) => (n.textContent ?? '').trim());
    return names.includes(otherName) ? null : names;
  }, 10000);
  out.deleteWorkspace = {
    name: otherName,
    confirmShown: confirmBtn !== null,
    removed: gone !== null,
    groupsAfter: document.querySelectorAll('.group-row').length,
  };
  return out;
})()
'@

Write-Output '=== 真实 ~/.dsc 跑前指纹 ==='
$swBefore = Get-DirFingerprint $swRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 内容聚合 {2}" -f $swBefore.Count, $swBefore.Locked, $swBefore.ContentDigest)

$env:DSC_DESKTOP_USER_DATA = Join-Path $swHome 'electron-userdata'
$env:USERPROFILE = $swHome
$env:HOME = $swHome
$env:DSC_DESKTOP_STATE = Join-Path $swDsc 'desktop.json'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SHOT = Join-Path $swShots 'ui-parity.png'
$env:DSC_DESKTOP_SHOT_DELAY = '52000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '45000'
$env:DSC_DESKTOP_SHOT_EVAL = $swEval
Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue
Remove-Item Env:DSC_UI_QUERY -ErrorAction SilentlyContinue

$outLog = Join-Path $swShots 'ui-parity.out.log'
$errLog = Join-Path $swShots 'ui-parity.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue

try {
  $swProc = Start-Process -FilePath $swElectron -ArgumentList $swEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $swDeadline = (Get-Date).AddSeconds(120)
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
}

if (Test-Path -LiteralPath $errLog) {
  Select-String -LiteralPath $errLog -Pattern '界面形态=|窗口来自宿主界面服务|预跑脚本完成|预跑脚本失败|已写出|页面加载失败|截图失败' |
    ForEach-Object { '  ' + $_.Line.Trim() }
}

# ⑧ 的文件系统侧证据：被删工作区（D:\dsc 组）那份合成会话该已归进 sessions/.archived。
$swArchived = Join-Path $swDsc 'sessions\.archived\D-dsc\66666666-7777-8888-9999-aaaaaaaaaaaa.jsonl'
Write-Output ("归档落位（⑧ 证据）：{0}" -f (Test-Path -LiteralPath $swArchived))

Write-Output '=== 真实 ~/.dsc 跑后指纹 ==='
$swAfter = Get-DirFingerprint $swRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 内容聚合 {2}" -f $swAfter.Count, $swAfter.Locked, $swAfter.ContentDigest)
$swDiff = Compare-Object -ReferenceObject $swBefore.Lines -DifferenceObject $swAfter.Lines
if ($null -eq $swDiff) { Write-Output '差异行：无（逐文件哈希完全一致）' }
else { Write-Output ("差异行：{0} 条" -f @($swDiff).Count); $swDiff | Select-Object -First 10 | ForEach-Object { '  ' + $_.SideIndicator + ' ' + $_.InputObject } }
Write-Output ("文件数一致：{0}；内容聚合一致：{1}" -f ($swBefore.Count -eq $swAfter.Count), ($swBefore.ContentDigest -eq $swAfter.ContentDigest))
Write-Output 'ui-parity-check 完成'
