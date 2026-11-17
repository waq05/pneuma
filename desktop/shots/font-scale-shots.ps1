# 字号滑杆（设置 → 外观 → 字号）的自检截图与取证。
#
# 沙箱隔离：临时 USERPROFILE/HOME（宿主侧的 ~/.dsc 全部落到沙箱里）+ 独立
# DSC_DESKTOP_USER_DATA，真实 ~/.dsc 只被读取（会话文件是复制出来的），
# 跑完对真实目录再做一次指纹比对，证明自检没往里写任何东西。
#
# 每个用例先往沙箱的 settings.json 里写一份偏好存档（字号就是被测的那一项），
# 然后启动打包前的 Electron 跑一次、截图、退出。
#
# 用法：
#   pwsh -NoProfile -File font-scale-shots.ps1
#   pwsh -NoProfile -File font-scale-shots.ps1 -Case chat-085

param([string]$Case = 'all')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$desktop = Split-Path $PSScriptRoot -Parent
$shots = Join-Path $desktop 'shots'
$electron = Join-Path $desktop 'node_modules\.bin\electron.cmd'
$realDsc = Join-Path $env:USERPROFILE '.dsc'
$sourceSession = Join-Path $realDsc 'sessions\C-Windows-System32\c2b4d845-b210-475f-8791-81707338b592.jsonl'

$sandbox = Join-Path $env:TEMP 'dsc-fontscale-shot'
$sandboxHome = Join-Path $sandbox 'home'
$hostDsc = Join-Path $sandboxHome '.dsc'
$sessionDir = Join-Path $hostDsc 'sessions\C-Windows-System32'
$resume = Join-Path $sessionDir 'c2b4d845-b210-475f-8791-81707338b592.jsonl'
$settings = Join-Path $hostDsc 'settings.json'

Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $hostDsc, $sessionDir, (Join-Path $sandbox 'udata') | Out-Null
Copy-Item $sourceSession $resume -Force

# 真实 ~/.dsc 的指纹（路径|大小|写入时刻），跑完比对
function Get-DscFingerprint {
  Get-ChildItem $realDsc -Recurse -File -Force -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    ForEach-Object { "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" }
}
$realBefore = Get-DscFingerprint

# 沙箱里的偏好存档：只写一项字号，其余字段按缺省走（顺带证明残缺存档不会读崩）。
# 2026-11 起字号的真源是 `ui.textSizePx`（整数 px）；旧档只有 `ui.fontSize`（倍率），
# 所以留一个 -Legacy 开关专门验迁移路径。
function Set-Prefs([string]$fontJson, [switch]$Legacy, [string]$Extra = '') {
  $key = if ($Legacy) { 'fontSize' } else { 'textSizePx' }
  $body = @'
{
  "ui": { "__KEY__": __FONT____EXTRA__ }
}
'@
  $value = (($body -replace '__KEY__', $key) -replace '__FONT__', $fontJson) -replace '__EXTRA__', $Extra
  Set-Content -Path $settings -Value $value -Encoding utf8NoBOM
}

$env:USERPROFILE = $sandboxHome
$env:HOME = $sandboxHome
$env:DSC_DESKTOP_USER_DATA = Join-Path $sandbox 'udata'
$env:DSC_DESKTOP_SHOT_DELAY = '9000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '4500'
# 截屏要窗口真的被合成过：不 show() 时 capturePage 会抛 UnknownVizError
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'

# 各用例共用的小工具
$helper = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => document.querySelector(s);
const until = async (sel, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (q(sel)) return true; await wait(100); } return false; };
const rootScale = () => document.documentElement.style.getPropertyValue('--dsc-font-scale').trim();
const bodyToken = () => getComputedStyle(document.documentElement).getPropertyValue('--dsc-fs-body').trim();
'@

# 设置页探针：滑杆位置、px 读数、帮助文案
$sliderProbe = @'
(async () => {
  await until('.font-scale-range', 4000);
  await wait(400);
  const rows = Array.from(document.querySelectorAll('.settings-appearance .setting-row'));
  const fontRow = rows.find((r) => r.querySelector('.setting-label') && r.querySelector('.setting-label').textContent === '字号');
  const range = fontRow ? fontRow.querySelector('.font-scale-range') : null;
  const label = fontRow ? fontRow.querySelector('.font-scale-value') : null;
  const help = fontRow ? fontRow.querySelector('.setting-help') : null;
  const segsLeft = document.querySelectorAll('.settings-appearance .dsc-segmented').length;
  return {
    scaleVar: rootScale(),
    bodyToken: bodyToken(),
    rangeValue: range ? range.value : null,
    rangeMin: range ? range.min : null,
    rangeMax: range ? range.max : null,
    rangeStep: range ? range.step : null,
    rangeW: range ? Math.round(range.getBoundingClientRect().width) : null,
    sizeLabel: label ? label.textContent : null,
    helpText: help ? help.textContent.trim() : null,
    otherSegments: segsLeft,
    sections: document.querySelectorAll('.settings-nav-item').length,
  };
})()
'@

# 字体探针（2026-11）：两行输入框在不在、值是不是归一后的串、变量有没有真的落到根上
$fontProbe = @'
(async () => {
  await until('.font-scale-range', 1500);
  // 搜索参数没把设置页打开时自己点开：这条探针要看的是设置页里的两行字体，
  // 不能因为入口没开就交一堆 null（2026-11 实测 search=settings=general 偶尔落回首屏）。
  if (!document.querySelector('.settings-appearance')) {
    const gear = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '设置');
    if (gear) gear.click();
    await until('.settings-appearance', 4000);
    await wait(600);
  }
  const root = document.documentElement;
  const rows = Array.from(document.querySelectorAll('.settings-appearance .setting-row'));
  const rowOf = (label) => rows.find((r) => r.querySelector('.setting-label') && r.querySelector('.setting-label').textContent === label);
  const textRow = rowOf('正文字体');
  const codeRow = rowOf('代码字体');
  const bodyFont = getComputedStyle(document.body).fontFamily;
  return {
    textVar: root.style.getPropertyValue('--dsc-font-text'),
    codeVar: root.style.getPropertyValue('--dsc-font-code'),
    textInput: textRow && textRow.querySelector('.setting-input') ? textRow.querySelector('.setting-input').value : null,
    codeInput: codeRow && codeRow.querySelector('.setting-input') ? codeRow.querySelector('.setting-input').value : null,
    bodyFont,
    bodyFirst: bodyFont.split(',')[0].replace(/["']/g, '').trim(),
  };
})()
'@

# 对话区探针：正文字号、行高、列宽、有没有横向溢出
$chatProbe = @'
(async () => {
  await until('.entry-text .markdown', 4000);
  await wait(500);
  const md = q('.entry-text .markdown');
  const inner = q('.chat-inner');
  return {
    scaleVar: rootScale(),
    bodyToken: bodyToken(),
    mdFontSize: md ? getComputedStyle(md).fontSize : null,
    mdLineHeight: md ? getComputedStyle(md).lineHeight : null,
    entries: inner ? inner.children.length : 0,
    chatW: q('.chat') ? Math.round(q('.chat').getBoundingClientRect().width) : null,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    composerH: q('.composer') ? Math.round(q('.composer').getBoundingClientRect().height) : null,
  };
})()
'@

# 终端探针：Dock 里的 xterm 字号是不是跟着连续倍率走
$dockProbe = @'
(async () => {
  await wait(1500);
  const btn = q('.dock-toggle');
  if (btn) btn.click();
  await until('.xterm-rows', 5000);
  await wait(900);
  const rows = q('.xterm-rows');
  return {
    scaleVar: rootScale(),
    xtermFontSize: rows ? getComputedStyle(rows).fontSize : null,
    dockOpen: !!q('.dock'),
  };
})()
'@

# 拖动探针：连续改值再松手，看落盘的值与提示条数
$dragProbe = @'
(async () => {
  await until('.font-scale-range', 4000);
  await wait(400);
  const range = q('.font-scale-range');
  // React 会对受控 input 做值追踪，必须走原生 setter 才能让它收到 change
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  // 滑杆现在是整数 px（10–22），连续拖 15 → 18
  for (const v of ['15', '16', '17', '18']) {
    setter.call(range, v);
    range.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(60);
  }
  const midDrag = { scaleVar: rootScale(), label: q('.font-scale-value') ? q('.font-scale-value').textContent : null };
  range.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  await wait(1600);
  return {
    midDrag,
    scaleVar: rootScale(),
    rangeValue: range.value,
    sizeLabel: q('.font-scale-value') ? q('.font-scale-value').textContent : null,
    toastCount: document.querySelectorAll('.dsc-toast').length,
    toastText: Array.from(document.querySelectorAll('.dsc-toast')).map((t) => t.textContent),
  };
})()
'@

$cases = [ordered]@{
  # 设置页：滑杆本身（默认 14px）
  'slider-default' = @{ font = '14'; search = 'settings=general'; chat = $false; script = $sliderProbe }
  # 旧存档迁移：只有 ui.fontSize 的 'lg'，要变成 16px（0.92→13 / 1→14 / 1.12→16）
  'slider-migrate-lg' = @{ font = '"lg"'; legacy = $true; search = 'settings=general'; chat = $false; script = $sliderProbe }
  # 旧存档迁移：数字倍率 1.28 → 18px，跨重启保留
  'slider-migrate-128' = @{ font = '1.28'; legacy = $true; search = 'settings=general'; chat = $false; script = $sliderProbe }
  # 非法值不崩：认不出的字符串回落 14px
  'slider-bogus' = @{ font = '"huge"'; search = 'settings=general'; chat = $false; script = $sliderProbe }
  # 对话区：最小档（10px）
  'chat-min' = @{ font = '10'; search = ''; chat = $true; script = $chatProbe }
  # 对话区：最大档（22px）
  'chat-max' = @{ font = '22'; search = ''; chat = $true; script = $chatProbe }
  # 终端字号（Dock 里的 xterm）：同为两端，看它跟不跟派生倍率
  'dock-min' = @{ font = '10'; search = ''; chat = $true; script = $dockProbe }
  'dock-max' = @{ font = '22'; search = ''; chat = $true; script = $dockProbe }
  # 拖一次滑杆：连续 change → 松手落盘，落盘值要是 px 整数，提示只弹一条
  'drag-commit' = @{ font = '14'; search = 'settings=general'; chat = $false; script = $dragProbe }
  # 字体两项：存档写裸名字（不带引号），界面要归一成带引号并写到根变量上
  'fonts-custom' = @{
    font = '15'
    extra = ',"textFontFamily":"Noto Sans SC","codeFontFamily":"Consolas"'
    search = 'settings=general'
    chat = $false
    script = $fontProbe
  }
}

foreach ($name in $cases.Keys) {
  if ($Case -ne 'all' -and $Case -ne $name) { continue }
  $spec = $cases[$name]
  $extra = if ($spec.ContainsKey('extra')) { $spec.extra } else { '' }
  if ($spec.legacy) { Set-Prefs $spec.font -Legacy -Extra $extra } else { Set-Prefs $spec.font -Extra $extra }
  $png = Join-Path $shots "font-$name.png"
  $log = Join-Path $shots "font-$name.log"
  Remove-Item $png -Force -ErrorAction SilentlyContinue
  $env:DSC_DESKTOP_SHOT = $png
  $env:DSC_DESKTOP_SEARCH = $spec.search
  if ($spec.chat) { $env:DSC_RESUME_SESSION = $resume } else { Remove-Item Env:DSC_RESUME_SESSION -ErrorAction SilentlyContinue }
  $env:DSC_DESKTOP_SHOT_EVAL = $helper + "`n" + $spec.script

  Write-Output "=== $name（存档字号 = $($spec.font)$(if ($spec.legacy) { '（旧 fontSize 键）' } else { 'px' })）==="
  Push-Location $desktop
  try {
    & $electron 'out\main\index.js' *>&1 | Out-File -FilePath $log -Encoding utf8
  } finally {
    Pop-Location
  }
  Write-Output "    存档：$(Get-Content $settings -Raw | ConvertFrom-Json | ConvertTo-Json -Compress)"
  Select-String -Path $log -Pattern 'selfcheck|启动失败|错误' | ForEach-Object { '    ' + $_.Line } | Select-Object -First 6
}

Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SEARCH, Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST -ErrorAction SilentlyContinue

# 真实 ~/.dsc 有没有被写到
$realAfter = Get-DscFingerprint
$diff = Compare-Object $realBefore $realAfter
if ($null -eq $diff) {
  Write-Output "真实 ~/.dsc 指纹一致：$($realBefore.Count) 个文件，一个都没动"
} else {
  Write-Output '真实 ~/.dsc 有变化（不该发生）：'
  $diff | ForEach-Object { "  $($_.SideIndicator) $($_.InputObject)" }
}

