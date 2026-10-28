# 按钮大小滑杆（设置 → 外观 → 按钮大小）的自检截图与取证。
#
# 隔离：临时 USERPROFILE/HOME + DSC_HOME + 独立 DSC_DESKTOP_USER_DATA，
# 会话数据从上一批已建好的假 home（shots\btn-home）拷进临时沙箱，拷完把
# .last-session 指到沙箱里的副本，宿主只往沙箱写；真实 ~/.dsc 跑完做一次
# 指纹比对，证明一个字节都没动。
#
# 八个用例：
#   slider-100    设置页：滑杆默认 100%，量 .icon-btn 实际宽高（26px）
#   slider-150    设置页：拖到 150% 松手落盘，量出来 39px，截图停在这一档
#   clamp-bounds  拖动越界：1.9 与 0.5 各来一次，看夹到 1.5 / 0.9
#   sidebar-100   侧栏（?reveal=1）：按钮 1.0 档的样子 + 行尾按钮/菜单实测
#   sidebar-150   侧栏：拖到 150% → 关设置面板 → 同一批按钮的放大样子
#   drag-130      拖动落盘：拖到 130% 松手，落盘的值写进 settings.json
#   restart-130   跨重启：settings.json 里放着 1.30，冷启动读回来是多少
#   theme-write   改一次主题：宿主重写 ui 段后，buttonScale 还在不在文件里
#
# 用法（在 desktop 目录下跑）：
#   pwsh -NoProfile -File shots\btn-size-shots.ps1
#   pwsh -NoProfile -File shots\btn-size-shots.ps1 -Case sidebar-150

param([string]$Case = 'all')

$ErrorActionPreference = 'Stop'
# 带着 ELECTRON_RUN_AS_NODE 启动会被当成纯 Node 直接退出，什么都拍不到
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$desktop = 'D:\dsc\desktop'
$shots = Join-Path $desktop 'shots'
$electron = Join-Path $desktop 'node_modules\.bin\electron.cmd'
$realDsc = Join-Path $env:USERPROFILE '.dsc'

$sandbox = Join-Path $env:TEMP 'dsc-btnsize-shot'
$sandboxHome = Join-Path $sandbox 'home'
$hostDsc = Join-Path $sandboxHome '.dsc'
# 活动工作区的会话（宿主拿 .last-session 复原它，会话行才会画出来）
$resume = Join-Path $hostDsc 'sessions\C-Users-waq\eae52707-2f2b-4e07-a230-c7b30a597796.jsonl'
$settings = Join-Path $hostDsc 'settings.json'

Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $sandboxHome, (Join-Path $sandbox 'udata') | Out-Null
Copy-Item (Join-Path $shots 'btn-home\.dsc') $hostDsc -Recurse -Force
Set-Content -Path (Join-Path $hostDsc '.last-session') -Value $resume -Encoding utf8NoBOM

# 真实 ~/.dsc 的指纹（路径|大小|写入时刻），跑完比对
function Get-DscFingerprint {
  Get-ChildItem $realDsc -Recurse -File -Force -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    ForEach-Object { "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" }
}
$realBefore = Get-DscFingerprint

# 每档的界面偏好：固定深色 + 标准密度（行高 28px，正好是按钮的基准档），
# 按钮缩放按用例给；空串 = 整项不写，用来证明「存档里没这一项」回落 100%。
function Set-Prefs([string]$buttonJson) {
  $button = if ([string]::IsNullOrEmpty($buttonJson)) { '' } else { "`n    `"buttonScale`": $buttonJson," }
  $body = @"
{
  "closeToTray": false,
  "ui": {$button
    "sessionSort": "recent",
    "sessionGroup": "workspace",
    "archivedFilter": "hide",
    "workspaceOrder": ["C:\\Users\\waq", "D:\\dsc"],
    "workspaceAliases": {},
    "themeMode": "dark",
    "fontSize": 1,
    "density": "standard"
  }
}
"@
  Set-Content -Path $settings -Value $body -Encoding utf8NoBOM
}

$env:USERPROFILE = $sandboxHome
$env:HOME = $sandboxHome
$env:DSC_HOME = $hostDsc
$env:DSC_DESKTOP_USER_DATA = Join-Path $sandbox 'udata'
$env:DSC_DESKTOP_SHOT_DELAY = '9000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '5000'
# 截屏要窗口真的被合成过：不 show() 时 capturePage 会抛 UnknownVizError
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
Remove-Item Env:DSC_RESUME_SESSION -ErrorAction SilentlyContinue

# 各用例共用的小工具
$helper = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => document.querySelector(s);
const qa = (s) => Array.from(document.querySelectorAll(s));
const until = async (sel, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (q(sel)) return true; await wait(100); } return false; };
const rootScale = () => document.documentElement.style.getPropertyValue('--dsc-btn-scale').trim();
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
const svgBox = (el) => { const s = el ? el.querySelector('svg') : null; return s ? box(s) : null; };
// React 对受控 input 做值追踪，必须走原生 setter 才能让它收到 change
const setRange = (el, v) => { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); };
const rowOf = (label) => qa('.settings-appearance .setting-row').find((r) => r.querySelector('.setting-label') && r.querySelector('.setting-label').textContent === label);
const closeSettings = async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(700); return qa('.settings-mask').length === 0; };
// 会话列表是宿主异步送来的，等第一行画出来再量
const waitRow = async (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = q('.sess-item'); if (r) return r; await wait(200); } return null; };
'@

# 设置页探针：滑杆位置、百分比、帮助文案、按钮实测
$sliderProbe = @'
(async () => {
  await until('.btn-scale-range', 6000);
  await wait(500);
  const row = rowOf('按钮大小');
  const range = row ? row.querySelector('.btn-scale-range') : null;
  const value = row ? row.querySelector('.btn-scale-value') : null;
  const help = row ? row.querySelector('.setting-help') : null;
  const closeBtn = q('.settings-head .icon-btn');
  const fontRange = q('.font-scale-range');
  return {
    scaleVar: rootScale(),
    scaleToken: token('--dsc-btn-scale'),
    labels: qa('.settings-appearance .setting-label').map((el) => el.textContent),
    rangeValue: range ? range.value : null,
    rangeMin: range ? range.min : null,
    rangeMax: range ? range.max : null,
    rangeStep: range ? range.step : null,
    rangeW: range ? Math.round(range.getBoundingClientRect().width) : null,
    fontRangeW: fontRange ? Math.round(fontRange.getBoundingClientRect().width) : null,
    percent: value ? value.textContent : null,
    help: help ? help.textContent.trim() : null,
    ariaLabel: range ? range.getAttribute('aria-label') : null,
    ariaValue: range ? range.getAttribute('aria-valuetext') : null,
    settingsCloseBtn: box(closeBtn),
    settingsCloseIcon: svgBox(closeBtn),
  };
})()
'@

# 拖动探针：连续改值 → 松手落盘，看即时预览、落盘后的值、提示条数
$dragProbe = @'
(async () => {
  await until('.btn-scale-range', 6000);
  await wait(500);
  const range = q('.btn-scale-range');
  for (const v of __STEPS__) { setRange(range, v); await wait(80); }
  const midDrag = {
    scaleVar: rootScale(),
    percent: q('.btn-scale-value') ? q('.btn-scale-value').textContent : null,
    closeBtn: box(q('.settings-head .icon-btn')),
    closeIcon: svgBox(q('.settings-head .icon-btn')),
  };
  range.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  await wait(2000);
  return {
    midDrag,
    scaleVar: rootScale(),
    scaleToken: token('--dsc-btn-scale'),
    rangeValue: range.value,
    percent: q('.btn-scale-value') ? q('.btn-scale-value').textContent : null,
    closeBtn: box(q('.settings-head .icon-btn')),
    closeIcon: svgBox(q('.settings-head .icon-btn')),
    toastCount: qa('.dsc-toast').length,
    toastText: qa('.dsc-toast').map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
  };
})()
'@

# 越界探针：分别把滑杆推到 1.9 与 0.5（原生 range 先夹到 min/max，JS 再归一一次）
$clampProbe = @'
(async () => {
  await until('.btn-scale-range', 6000);
  await wait(500);
  const range = q('.btn-scale-range');
  const read = () => ({ range: range.value, scaleVar: rootScale(), percent: q('.btn-scale-value').textContent, closeBtn: box(q('.settings-head .icon-btn')) });
  setRange(range, '1.9');
  await wait(400);
  const over = read();
  setRange(range, '0.5');
  await wait(400);
  const under = read();
  range.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  await wait(1600);
  return {
    min: range.min,
    max: range.max,
    over,
    under,
    final: { scaleVar: rootScale(), percent: q('.btn-scale-value').textContent, closeBtn: box(q('.settings-head .icon-btn')), closeIcon: svgBox(q('.settings-head .icon-btn')) },
    toastText: qa('.dsc-toast').map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
  };
})()
'@

# 侧栏读数：按钮本体、图标、菜单行内距与勾选列
$sidebarRead = @'
  const rail = q('.rail-toggle');
  const headBtn = q('.head-actions .icon-btn');
  const row = await waitRow(8000);
  const rowBtns = row ? qa('.sess-item .row-actions .icon-btn') : [];
  const tail = q('.group-row .row-tail .row-actions');
  const tailBtns = tail ? qa('.group-row .row-tail .row-actions .icon-btn') : [];
  // 行菜单：量内距与图标（量完关掉，截图里留干净的侧栏）
  let rowMenu = null;
  const moreBtn = rowBtns[rowBtns.length - 1];
  if (moreBtn) {
    moreBtn.click();
    await wait(600);
    const item = q('.row-menu .menu-item');
    const cs = item ? getComputedStyle(item) : null;
    rowMenu = {
      open: qa('.row-menu').length,
      items: qa('.row-menu .menu-item').length,
      item: box(item),
      padTop: cs ? cs.paddingTop : null,
      padLeft: cs ? cs.paddingLeft : null,
      icon: svgBox(item),
    };
    const backdrop = q('.menu-backdrop');
    if (backdrop) backdrop.click();
    await wait(400);
  }
  // 视图选项菜单：勾选列（.menu-check）是 15px 那一档
  let viewMenu = null;
  const viewBtn = qa('.head-actions .icon-btn').find((el) => (el.getAttribute('data-tip') || '').startsWith('视图选项'));
  if (viewBtn) {
    viewBtn.click();
    await wait(600);
    const check = q('.view-menu .menu-check');
    viewMenu = {
      open: qa('.view-menu').length,
      item: box(q('.view-menu .menu-item')),
      checkW: check ? +check.getBoundingClientRect().width.toFixed(1) : null,
      checkIcon: svgBox(check),
    };
    const backdrop = q('.menu-backdrop');
    if (backdrop) backdrop.click();
    await wait(400);
  }
  const side = {
    scaleVar: rootScale(),
    scaleToken: token('--dsc-btn-scale'),
    density: document.documentElement.dataset.density,
    railToggle: box(rail),
    railIcon: svgBox(rail),
    headBtn: box(headBtn),
    headIcon: svgBox(headBtn),
    rowBtns: rowBtns.map(box),
    rowIcons: rowBtns.map(svgBox),
    rowActions: box(row ? row.querySelector('.row-actions') : null),
    tailBtns: tailBtns.map(box),
    sessRowH: box(row),
    groupRowH: box(q('.group-row')),
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    rowMenu,
    viewMenu,
  };
'@

$sidebarProbe = "`n(async () => {`n  await until('.sidebar-header', 6000);`n  await wait(1500);`n$sidebarRead`n  return side;`n})()`n"

# 先拖到 150% 再关设置面板，量的是同一批侧栏按钮的放大样子
$sidebarDragProbe = @"
(async () => {
  await until('.btn-scale-range', 6000);
  await wait(600);
  const range = q('.btn-scale-range');
  for (const v of ['1.1', '1.3', '1.5']) { setRange(range, v); await wait(80); }
  const preview = { scaleVar: rootScale(), percent: q('.btn-scale-value') ? q('.btn-scale-value').textContent : null };
  range.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  await wait(1800);
  const committed = { scaleVar: rootScale(), percent: q('.btn-scale-value') ? q('.btn-scale-value').textContent : null };
  const closed = await closeSettings();
  await wait(800);
$sidebarRead
  return { preview, committed, settingsClosed: closed, ...side };
})()
"@

# 侧栏 + 写一次别的偏好：证明宿主的白名单读档会把 buttonScale 从文件里抹掉
$themeWriteProbe = @'
(async () => {
  await until('.btn-scale-range', 6000);
  await wait(500);
  const before = { scaleVar: rootScale(), percent: q('.btn-scale-value') ? q('.btn-scale-value').textContent : null };
  const light = qa('.settings-appearance .dsc-segmented__btn').find((el) => el.textContent === '浅色');
  if (light) light.click();
  await wait(2000);
  return {
    before,
    theme: document.documentElement.dataset.theme,
    dark: qa('.settings-appearance .dsc-segmented__btn').map((el) => el.textContent),
    scaleVar: rootScale(),
    percent: q('.btn-scale-value') ? q('.btn-scale-value').textContent : null,
    toastText: qa('.dsc-toast').map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
  };
})()
'@

# 插件页探针：拖到 150% 关面板，量插件页头部那两颗 30px 按钮
$pluginsDragProbe = @"
(async () => {
  await until('.btn-scale-range', 6000);
  await wait(800);
  const range = q('.btn-scale-range');
  for (const v of ['1.2', '1.4', '1.5']) { setRange(range, v); await wait(80); }
  range.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  await wait(1800);
  const committed = { scaleVar: rootScale(), percent: q('.btn-scale-value') ? q('.btn-scale-value').textContent : null };
  const closed = await closeSettings();
  await wait(900);
  const btns = qa('.plugins-actions .icon-btn');
  return {
    committed,
    settingsClosed: closed,
    scaleToken: token('--dsc-btn-scale'),
    pane: qa('.plugins-head h2').map((el) => el.textContent),
    pluginsBtns: btns.map(box),
    pluginsIcons: btns.map(svgBox),
    addBtn: box(q('.plugins-add')),
  };
})()
"@

$cases = [ordered]@{
  'slider-100'   = @{ button = ''; search = 'settings=general'; script = $sliderProbe }
  'slider-150'   = @{ button = ''; search = 'settings=general'; script = $dragProbe.Replace('__STEPS__', "['1.1', '1.3', '1.5']") }
  'clamp-bounds' = @{ button = ''; search = 'settings=general'; script = $clampProbe }
  'sidebar-100'  = @{ button = ''; search = 'reveal=1'; script = $sidebarProbe }
  # 拖滑杆 + 关面板 + 量侧栏要 5 秒以上，这一档单独把提前量放大（默认 9s/5s 不够）
  'sidebar-150'  = @{ button = ''; search = 'settings=general&reveal=1'; script = $sidebarDragProbe; delay = '20000'; lead = '17000' }
  'plugins-150'  = @{ button = ''; search = 'view=plugins&settings=general'; script = $pluginsDragProbe; delay = '16000'; lead = '13000' }
  'drag-130'     = @{ button = ''; search = 'settings=general'; script = $dragProbe.Replace('__STEPS__', "['1.05', '1.15', '1.22', '1.3']") }
  'restart-130'  = @{ button = '1.3'; search = 'settings=general'; script = $sliderProbe }
  # 存档里放着 1.30，这次改主题：宿主写回整份 ui，看 buttonScale 还在不在
  'theme-write'  = @{ button = '1.3'; search = 'settings=general'; script = $themeWriteProbe }
}

foreach ($name in $cases.Keys) {
  if ($Case -ne 'all' -and $Case -ne $name) { continue }
  $spec = $cases[$name]
  Set-Prefs $spec.button
  $before = Get-Content $settings -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 6 -Compress
  $png = Join-Path $shots "btn-size-$name.png"
  $log = Join-Path $shots "btn-size-$name.log"
  Remove-Item $png -Force -ErrorAction SilentlyContinue
  $env:DSC_DESKTOP_SHOT = $png
  $env:DSC_DESKTOP_SEARCH = $spec.search
  $env:DSC_DESKTOP_SHOT_EVAL = $helper + "`n" + $spec.script
  $env:DSC_DESKTOP_SHOT_DELAY = if ($spec.delay) { $spec.delay } else { '9000' }
  $env:DSC_DESKTOP_SHOT_EVAL_LEAD = if ($spec.lead) { $spec.lead } else { '5000' }

  Write-Output "=== $name（启动前存档：$before）==="
  Push-Location $desktop
  try {
    & $electron 'out\main\index.js' *>&1 | Out-File -FilePath $log -Encoding utf8
  } finally {
    Pop-Location
  }
  Select-String -Path $log -Pattern 'selfcheck' | ForEach-Object { '    ' + $_.Line }
  $after = Get-Content $settings -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 6 -Compress
  Write-Output "    跑完存档：$after"
}

Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SEARCH, Env:DSC_DESKTOP_SHOT_EVAL -ErrorAction SilentlyContinue
Remove-Item Env:DSC_DESKTOP_SHOT_TOPMOST -ErrorAction SilentlyContinue

# 真实 ~/.dsc 有没有被写到
$realAfter = Get-DscFingerprint
$diff = Compare-Object $realBefore $realAfter
if ($null -eq $diff) {
  Write-Output "真实 ~/.dsc 指纹一致：$($realBefore.Count) 个文件，一个都没动"
} else {
  Write-Output '真实 ~/.dsc 有变化（不该发生）：'
  $diff | ForEach-Object { "  $($_.SideIndicator) $($_.InputObject)" }
  # usage.jsonl 是正在跑的会话（本机 DSH 自己）每发一次模型请求就追加一行的文件：
  # 只有它变了、且最后一行是当前会话的 sid，就与自检无关。
  Write-Output '  usage.jsonl 末行（sid 是正在跑的会话就与自检无关）：'
  Get-Content (Join-Path $realDsc 'usage\usage.jsonl') -Tail 1 -ErrorAction SilentlyContinue | ForEach-Object { "    $_" }
}
