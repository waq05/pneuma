# 自检：设置面板的版式（对齐 dsh：左标题+说明 / 右控件 / 行间发丝线）。
#
# 走 ?settings=general 钩子直接开设置到「通用」分区（那里六种字段都有），
# 量四件事：①行间有 0.5px 分隔线、最后一行没有；②说明文字在左栏（.setting-text）里；
# ③控件靠右（控件右缘贴着行右缘）；④导航选中项有抬升底色与 1px 描边。
param([ValidateSet('dark', 'light')][string]$Case = 'dark')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$home2 = Join-Path $shots 'settings-home'

$env:DSC_DESKTOP_USER_DATA = Join-Path $shots 'settings-udata'
$env:USERPROFILE = $home2
$env:DSC_HOME = Join-Path $home2 '.dsc'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SEARCH = 'settings=general'
$env:DSC_DESKTOP_SHOT = Join-Path $shots "settings-01-$Case.png"
$env:DSC_DESKTOP_SHOT_DELAY = '9000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '3500'

$env:DSC_DESKTOP_SHOT_EVAL = @'
(() => {
  document.documentElement.style.setProperty('--dsc-dur', '0ms');
  if ('__LIGHT__' === '1') document.documentElement.dataset.theme = 'light';
  const px = (v) => Number.parseFloat(v) || 0;
  const rows = Array.from(document.querySelectorAll('.settings-fields .setting-row'));
  const first = rows[0] ?? null;
  const last = rows[rows.length - 1] ?? null;
  const styleOf = (el) => (el === null ? null : getComputedStyle(el));
  const lineOf = (el) => {
    const cs = styleOf(el);
    if (cs === null) return null;
    return { width: cs.borderBottomWidth, style: cs.borderBottomStyle, color: cs.borderBottomColor };
  };
  // 控件右缘与行右缘的距离：靠右对齐时应该接近行自己的右内边距（2px）
  const rightGap = (row) => {
    const control = row.querySelector('.setting-control, .setting-info');
    if (control === null) return null;
    return Math.round(row.getBoundingClientRect().right - control.getBoundingClientRect().right);
  };
  const activeNav = document.querySelector('.settings-nav-item.on');
  const navStyle = styleOf(activeNav);
  const helpRows = rows.filter((row) => row.querySelector('.setting-text .setting-help') !== null).length;
  const helpInControl = rows.filter((row) => row.querySelector('.setting-control .setting-help') !== null).length;
  return {
    rowCount: rows.length,
    firstLine: lineOf(first),
    lastLine: lineOf(last),
    lastHasNoLine: last === null || px(getComputedStyle(last).borderBottomWidth) === 0,
    helpRows,
    helpInControl,
    rightGaps: rows.map(rightGap).slice(0, 6),
    nav: activeNav === null ? null : { text: activeNav.textContent, background: navStyle.backgroundColor, shadow: navStyle.boxShadow },
    groupTitle: document.querySelector('.settings-group-title')?.textContent ?? null,
    headLine: lineOf(document.querySelector('.settings-head')),
    theme: document.documentElement.dataset.theme,
  };
})()
'@
$env:DSC_DESKTOP_SHOT_EVAL = $env:DSC_DESKTOP_SHOT_EVAL.Replace('__LIGHT__', $(if ($Case -eq 'light') { '1' } else { '0' }))

$log = Join-Path $shots "settings-$Case.log"
$entry = Join-Path $shots '..\out\main\index.js'
& $electron $entry *>&1 | Out-File -FilePath $log -Encoding utf8
Select-String -Path $log -Pattern '预跑脚本' | ForEach-Object { $_.Line }
