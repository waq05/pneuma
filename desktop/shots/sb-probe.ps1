# 侧栏/状态栏优化的自检截图脚本（探针 + 悬停两趟）。
#
# 隔离：DSC_DESKTOP_USER_DATA 换到 shots\sb-udata，USERPROFILE/DSC_HOME 换到
# shots\sb-home，所以宿主读写的 ~/.dsc 是那一份副本，不碰用户自己的数据。
#
# 用法：pwsh -NoProfile -File sb-probe.ps1 -Run probe
#       pwsh -NoProfile -File sb-probe.ps1 -Run hover   # 悬停态（徽标 + 浮层）
param([string]$Run = 'probe')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$home2 = Join-Path $shots 'sb-home'
$session = Join-Path $home2 '.dsc\sessions\D-dsc\ca1de16f-1aa7-4514-bddb-2ca1a9940795.jsonl'

$env:DSC_DESKTOP_USER_DATA = Join-Path $shots 'sb-udata'
$env:USERPROFILE = $home2
$env:DSC_HOME = Join-Path $home2 '.dsc'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_RESUME_SESSION = $session
Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue

# 截图前在渲染层跑：量徽标 x 坐标（浮层出现前后）。
# 浮层显现用与 :hover 完全同源的 .__h 覆盖类（只提 opacity/visibility，
# 与真 hover 的差异仅此一项，布局一模一样），所以量的就是 hover 的几何。
# hover 那一趟量完把类留在行上，好让截图拍到这个状态。
$Measure = @'
document.documentElement.style.setProperty('--dsc-dur', '0ms');
const LEAVE = __LEAVE__;
// 与 styles.css 追加区里那两条悬停规则同源的覆盖：布局与真 hover 完全一致
const st = document.createElement('style');
st.textContent = '.sidebar .group-row.__h{background:var(--dsc-row-hover-bg)}' +
  '.sidebar .group-row.__h .row-tail .row-actions{opacity:1;visibility:visible}';
document.head.append(st);
const row = document.querySelector('.group-row');
if (!row) return { error: 'no group row' };
const badge = row.querySelector('.count');
const acts = row.querySelector('.row-tail .row-actions');
const box = (el) => { const r = el.getBoundingClientRect(); return { l: +r.left.toFixed(2), r: +r.right.toFixed(2), t: +r.top.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }; };
const rowBox = box(row);
const before = box(badge);
const hidden = getComputedStyle(acts).visibility + '/' + getComputedStyle(acts).opacity;
row.classList.add('__h');
const after = box(badge);
const actsBox = box(acts);
const shown = getComputedStyle(acts).visibility + '/' + getComputedStyle(acts).opacity;
if (!LEAVE) row.classList.remove('__h');
return {
  dpr: devicePixelRatio,
  frame: { dw: outerWidth - innerWidth, dh: outerHeight - innerHeight },
  inner: { w: innerWidth, h: innerHeight },
  badgeBefore: before, badgeAfter: after, sameX: before.l === after.l,
  rowBox: rowBox, dir: row.querySelector('.dir').textContent,
  acts: { hidden: hidden, shown: shown, box: actsBox },
  buttons: Array.from(acts.querySelectorAll('button')).map((b) => (b.title || b.dataset.tip || '') + '|' + b.querySelector('svg')?.outerHTML.slice(0, 40)),
  target: { x: +(rowBox.r - 30).toFixed(1), y: +(rowBox.t + rowBox.h / 2).toFixed(1) },
  hoveredNow: Array.from(document.querySelectorAll('.group-row:hover')).map((el) => el.querySelector('.dir').textContent),
  statusSegments: Array.from(document.querySelectorAll('.statusbar .segment')).map((el) => el.textContent.trim()),
};
'@

if ($Run -eq 'probe') {
  $env:DSC_DESKTOP_SHOT = Join-Path $shots 'sb-01-rest.png'
  $env:DSC_DESKTOP_SHOT_DELAY = '8000'
  $env:DSC_DESKTOP_SHOT_EVAL_LEAD = '1500'
  $env:DSC_DESKTOP_SHOT_EVAL = "(() => { " + $Measure.Replace('__LEAVE__', 'false') + " })()"
} else {
  # 真 hover 那一趟：等到窗口起来再移动系统光标，留够时间让截图拍在悬停态上
  $env:DSC_DESKTOP_SHOT = Join-Path $shots 'sb-02-hover.png'
  $env:DSC_DESKTOP_SHOT_DELAY = '24000'
  $env:DSC_DESKTOP_SHOT_EVAL_LEAD = '5000'
  $env:DSC_DESKTOP_SHOT_EVAL = "(() => { " + $Measure.Replace('__LEAVE__', 'true') + " })()"
}

$log = Join-Path $shots "sb-$Run.log"
& $electron 'out\main\index.js' *>&1 | Out-File -FilePath $log -Encoding utf8
Select-String -Path $log -Pattern 'selfcheck' | ForEach-Object { $_.Line }
