# 按钮大小跨重启持久化（宿主读档白名单已放行 ui.buttonScale）的自检截图与取证。
#
# 背景：上一批只在渲染层做了按钮大小滑杆，而宿主的读档是白名单制（src/core/prefs.ts 的
# readPrefs 只挑认得的字段），ui.buttonScale 会被丢掉：冷启动回落 100%，改一次主题
# （宿主写回整份 ui）就直接把这一项从存档里抹掉。这一批宿主放行后，本脚本重验：
#   cold-130          存档里放着 buttonScale=1.3 → 冷启动读回 1.3（.icon-btn 33.8px、滑杆 130%）
#   theme-light       改一次主题（深→浅）→ 宿主重写 ui 段后，buttonScale 还在不在文件里
#   cold-after-theme  拿上一步跑完的存档再冷启动一次，看 1.3 是否还活着（主题变浅色）
#   drag-130          滑杆拖到 130% 松手 → 宿主落盘 → 回执是「已保存外观设置」
#   cold-after-drag   拿上一步落盘的存档冷启动，读回 1.3
#   dock-100/130      Dock 四颗纯文字按钮（‹ › ✕ ↑）的字形跟 --dsc-btn-scale 走，布局不动
#
# 隔离：临时 USERPROFILE/HOME + DSC_HOME + 独立 DSC_DESKTOP_USER_DATA，会话数据从
# shots\btn-home 拷进临时沙箱（拷完把 .last-session 指到沙箱里的副本），宿主只往沙箱写；
# 真实 ~/.dsc 跑完做一次指纹比对，证明一个字节都没动。
#
# 用例之间有顺序依赖：cold-after-theme 吃 theme-light 跑完的存档，cold-after-drag 吃
# drag-130 跑完的存档。所以 -Case all 才是完整链路，单独跑后两个只证明「当前文件里的值」。
#
# 用法（在 desktop 目录下跑）：
#   pwsh -NoProfile -File shots\btn2-persist-shots.ps1
#   pwsh -NoProfile -File shots\btn2-persist-shots.ps1 -Case cold-130

param([string]$Case = 'all')

$ErrorActionPreference = 'Stop'
# 带着 ELECTRON_RUN_AS_NODE 启动会被当成纯 Node 直接退出，什么都拍不到
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$desktop = 'D:\dsc\desktop'
$shots = Join-Path $desktop 'shots'
$electron = Join-Path $desktop 'node_modules\.bin\electron.cmd'
$realDsc = Join-Path $env:USERPROFILE '.dsc'
$realSettings = Join-Path $realDsc 'settings.json'

$sandbox = Join-Path $env:TEMP 'dsc-btn2-shot'
$sandboxHome = Join-Path $sandbox 'home'
$hostDsc = Join-Path $sandboxHome '.dsc'
# 活动工作区的会话（宿主拿 .last-session 复原它，Dock 与侧栏才有内容）
$resume = Join-Path $hostDsc 'sessions\C-Users-waq\eae52707-2f2b-4e07-a230-c7b30a597796.jsonl'
$settings = Join-Path $hostDsc 'settings.json'

Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $sandboxHome, (Join-Path $sandbox 'udata') | Out-Null
Copy-Item (Join-Path $shots 'btn-home\.dsc') $hostDsc -Recurse -Force
Set-Content -Path (Join-Path $hostDsc '.last-session') -Value $resume -Encoding utf8NoBOM

# 真实 ~/.dsc 的指纹（路径|大小|写入时刻），跑完比对；settings.json 单独记一份，
# 证明桌面端/宿主没往真实存档里写。
function Get-DscFingerprint {
  Get-ChildItem $realDsc -Recurse -File -Force -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    ForEach-Object { "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" }
}
function Get-OneFingerprint([string]$path) {
  if (-not (Test-Path $path)) { return '(不存在)' }
  $f = Get-Item $path -Force
  "$($f.FullName)|$($f.Length)|$($f.LastWriteTimeUtc.Ticks)"
}
$realBefore = Get-DscFingerprint
$realSettingsBefore = Get-OneFingerprint $realSettings

$env:USERPROFILE = $sandboxHome
$env:HOME = $sandboxHome
$env:DSC_HOME = $hostDsc
$env:DSC_DESKTOP_USER_DATA = Join-Path $sandbox 'udata'
# 截屏要窗口真的被合成过：不 show() 时 capturePage 会抛 UnknownVizError
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
Remove-Item Env:DSC_RESUME_SESSION -ErrorAction SilentlyContinue

# 沙箱里的偏好存档：固定深色/浅色 + 标准密度（行高 28px，正好是按钮的基准档）。
# $buttonJson 传空串 = 整项不写，用来证明「存档里没这一项」回落 100%。
function Set-Prefs([string]$buttonJson, [string]$themeMode) {
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
    "themeMode": "$themeMode",
    "fontSize": 1,
    "density": "standard"
  }
}
"@
  Set-Content -Path $settings -Value $body -Encoding utf8NoBOM
}

# 存档里那两项的读数（余下的字段不打印，输出才看得清）
function Read-PrefState {
  if (-not (Test-Path $settings)) { return '(存档不存在)' }
  $doc = Get-Content $settings -Raw | ConvertFrom-Json
  $has = $doc.ui.PSObject.Properties.Name -contains 'buttonScale'
  $button = if ($has) { $doc.ui.buttonScale } else { '(缺这一项)' }
  "themeMode=$($doc.ui.themeMode) buttonScale=$button"
}

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
const px = (el, prop) => (el ? getComputedStyle(el)[prop] : null);
// React 对受控 input 做值追踪，必须走原生 setter 才能让它收到 change
const setRange = (el, v) => { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); };
const rowOf = (label) => qa('.settings-appearance .setting-row').find((r) => r.querySelector('.setting-label') && r.querySelector('.setting-label').textContent === label);
const btnRow = () => rowOf('按钮大小');
const percent = () => { const v = btnRow() ? btnRow().querySelector('.btn-scale-value') : null; return v ? v.textContent : null; };
const toasts = () => qa('.dsc-toast').map((t) => t.textContent.replace(/\s+/g, ' ').trim());
const overflowX = () => document.documentElement.scrollWidth - window.innerWidth;
// 冷启动读数：滑杆位置、百分比、根变量、设置页那颗 26px 图标按钮（1.3 档应为 33.8px）
const readBoot = () => ({
  theme: document.documentElement.dataset.theme,
  scaleVar: rootScale(),
  scaleToken: token('--dsc-btn-scale'),
  rangeValue: btnRow() && btnRow().querySelector('.btn-scale-range') ? btnRow().querySelector('.btn-scale-range').value : null,
  percent: percent(),
  closeBtn: box(q('.settings-head .icon-btn')),
  closeIcon: svgBox(q('.settings-head .icon-btn')),
  overflowX: overflowX(),
});
'@

# 冷启动读数探针
$bootProbe = @'
(async () => {
  await until('.btn-scale-range', 8000);
  await wait(600);
  return readBoot();
})()
'@

# 改主题探针：深色 → 浅色，看宿主写回整份 ui 之后按钮倍率还在不在
$themeProbe = @'
(async () => {
  await until('.btn-scale-range', 8000);
  await wait(600);
  const before = readBoot();
  const light = qa('.settings-appearance .dsc-segmented__btn').find((el) => el.textContent === '浅色');
  if (light) light.click();
  await wait(2500);
  return { before, after: readBoot(), toastText: toasts() };
})()
'@

# 拖动探针：连续改值 → 松手落盘，看即时预览、落盘后的值、回执文案
$dragProbe = @'
(async () => {
  await until('.btn-scale-range', 8000);
  await wait(600);
  const range = btnRow().querySelector('.btn-scale-range');
  for (const v of ['1.05', '1.15', '1.22', '1.3']) { setRange(range, v); await wait(80); }
  const midDrag = { scaleVar: rootScale(), percent: percent(), closeBtn: box(q('.settings-head .icon-btn')) };
  range.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  await wait(2500);
  return { midDrag, ...readBoot(), toastText: toasts() };
})()
'@

# Dock 探针：打开面板 → 文件页量「上一级 ↑」与预览头部「✕」。
# 这三颗（还有浏览器页的 ‹ ›）都是纯文字按钮：字形跟 --dsc-btn-scale 走，按钮框早就跟
# 着走了。文件页刚挂载那一帧量出来是 0×0（父容器还在换内容），所以这里先轮询到真的有
# 盒子再量，并连采 4 次看它稳不稳（截图那一帧就是第 4 次采样之后的状态）。
$dockProbe = @'
(async () => {
  await wait(1500);
  const toggle = q('.dock-toggle');
  if (toggle) toggle.click();
  await until('.dock-tabs', 8000);
  await wait(1000);
  const tabs = () => qa('.dock-tabs button');
  const activeTab = () => { const el = tabs().find((b) => b.className.includes('on')); return el ? el.textContent : null; };
  const glyph = (el) => ({ box: box(el), fontSize: px(el, 'fontSize'), lineHeight: px(el, 'lineHeight') });

  const filesTab = tabs().find((el) => el.textContent === '文件');
  if (filesTab) filesTab.click();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const bar = q('.files-bar');
    if (bar && bar.getBoundingClientRect().height > 0) break;
    await wait(200);
  }
  await wait(1200);

  // 预览头部的 ✕ 要双击一个文件才画出来（单击只在目录行上做进入）；点不到就算 null
  let previewClose = null;
  const fileRow = qa('.file-row').find((row) => row.querySelector('.file-icon') && row.querySelector('.file-icon').textContent === '·');
  if (fileRow) {
    fileRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await until('.file-preview-head .icon-btn', 5000);
    await wait(600);
    previewClose = glyph(q('.file-preview-head .icon-btn'));
  }

  const read = () => {
    const up = q('.files-bar .icon-btn');
    const bar = q('.files-bar');
    return {
      activeTab: activeTab(),
      dockOpen: !!q('.dock'),
      filesBarH: bar ? +bar.getBoundingClientRect().height.toFixed(1) : null,
      filesUp: glyph(up),
    };
  };
  const samples = [];
  for (let i = 0; i < 4; i++) { samples.push(read()); await wait(1000); }

  return {
    scaleVar: rootScale(),
    scaleToken: token('--dsc-btn-scale'),
    bodyFont: token('--dsc-fs-body'),
    dockW: box(q('.dock')),
    fileRows: qa('.file-row').length,
    previewClose,
    samples,
    overflowX: overflowX(),
  };
})()
'@

$cases = [ordered]@{
  # 存档放着 1.3，冷启动读回来必须是 1.3（上一批就是这一步回落成 100%）
  'cold-130'         = @{ button = '1.3'; theme = 'dark'; search = 'settings=general'; script = $bootProbe; delay = '14000'; lead = '10000' }
  # 同一份存档（1.3 + 深色）改一次主题：宿主写回整份 ui，buttonScale 不能被抹掉
  'theme-light'      = @{ button = '1.3'; theme = 'dark'; search = 'settings=general'; script = $themeProbe; delay = '16000'; lead = '11000' }
  # 吃上一步跑完的存档（浅色 + 1.3）再冷启动
  'cold-after-theme' = @{ reuse = $true; search = 'settings=general'; script = $bootProbe; delay = '14000'; lead = '10000' }
  # 从「存档没这一项」（100%）出发拖到 130% 松手：走一遍真实写入链路
  'drag-130'         = @{ button = ''; theme = 'dark'; search = 'settings=general'; script = $dragProbe; delay = '16000'; lead = '11000' }
  # 吃 drag-130 跑完的存档冷启动
  'cold-after-drag'  = @{ reuse = $true; search = 'settings=general'; script = $bootProbe; delay = '14000'; lead = '10000' }
  # Dock 纯文字按钮的字形：100% 与 130% 各量一次，面板宽高与横向溢出一起量。
  # 截图紧跟在探针之后（探针约 9s，4s 起跑、18s 截图），免得自检窗口置顶期间被别处
  # 的点击带到别的标签页去——数字取证以探针的读数为准，截图只是同帧的样子。
  'dock-100'         = @{ button = ''; theme = 'dark'; search = ''; chat = $true; script = $dockProbe; delay = '18000'; lead = '14000' }
  'dock-130'         = @{ button = '1.3'; theme = 'dark'; search = ''; chat = $true; script = $dockProbe; delay = '18000'; lead = '14000' }
}

foreach ($name in $cases.Keys) {
  if ($Case -ne 'all' -and $Case -ne $name) { continue }
  $spec = $cases[$name]
  if ($spec.reuse) {
    # 吃掉上一个用例跑完留下的存档；单独跑这一档时先确认文件里真有 1.3
    Write-Output "=== $name（沿用上一步的存档：$(Read-PrefState)）==="
    $live = (Get-Content $settings -Raw | ConvertFrom-Json).ui.buttonScale
    if ($live -ne 1.3) { Write-Output "    ⚠ 存档里的 buttonScale 是 $live，不是 1.3：这一档依赖上一个用例，请按顺序跑" }
  } else {
    Set-Prefs $spec.button $spec.theme
    Write-Output "=== $name（启动前存档：$(Read-PrefState)）==="
  }

  $png = Join-Path $shots "btn2-$name.png"
  $log = Join-Path $shots "btn2-$name.log"
  Remove-Item $png -Force -ErrorAction SilentlyContinue
  $env:DSC_DESKTOP_SHOT = $png
  $env:DSC_DESKTOP_SEARCH = $spec.search
  if ($spec.chat) { $env:DSC_RESUME_SESSION = $resume } else { Remove-Item Env:DSC_RESUME_SESSION -ErrorAction SilentlyContinue }
  $env:DSC_DESKTOP_SHOT_EVAL = $helper + "`n" + $spec.script
  $env:DSC_DESKTOP_SHOT_DELAY = $spec.delay
  $env:DSC_DESKTOP_SHOT_EVAL_LEAD = $spec.lead

  Push-Location $desktop
  try {
    & $electron 'out\main\index.js' *>&1 | Out-File -FilePath $log -Encoding utf8
  } finally {
    Pop-Location
  }
  Select-String -Path $log -Pattern 'selfcheck' | ForEach-Object { '    ' + $_.Line }
  Write-Output "    跑完存档：$(Read-PrefState)"
}

Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SEARCH, Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST -ErrorAction SilentlyContinue

# 真实 ~/.dsc 有没有被写到
$realAfter = Get-DscFingerprint
$realSettingsAfter = Get-OneFingerprint $realSettings
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
if ($realSettingsBefore -eq $realSettingsAfter) {
  Write-Output "真实 ~/.dsc\settings.json 指纹一致（自检没往这里写）：$realSettingsAfter"
} else {
  Write-Output "真实 ~/.dsc\settings.json 变了（不该发生）：前 $realSettingsBefore → 后 $realSettingsAfter"
}
