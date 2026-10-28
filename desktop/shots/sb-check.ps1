# 补充自检：深色主题下悬浮层的观感，以及 ?reveal=1 截图钩子能不能把
# 追加区那条浮层规则点亮（钩子规则写在追加区里，压过了文件顶部那条旧规则）。
param([ValidateSet('dark', 'reveal')][string]$Case = 'dark')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$home2 = Join-Path $shots 'sb-home'

$env:DSC_DESKTOP_USER_DATA = Join-Path $shots 'sb-udata'
$env:USERPROFILE = $home2
$env:DSC_HOME = Join-Path $home2 '.dsc'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_RESUME_SESSION = Join-Path $home2 '.dsc\sessions\D-dsc\ca1de16f-1aa7-4514-bddb-2ca1a9940795.jsonl'
$env:DSC_DESKTOP_SHOT = Join-Path $shots "sb-06-$Case.png"
$env:DSC_DESKTOP_SHOT_DELAY = '10000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '2500'

if ($Case -eq 'reveal') { $env:DSC_DESKTOP_SEARCH = 'reveal=1' } else { Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue }

$env:DSC_DESKTOP_SHOT_EVAL = @'
(() => {
  document.documentElement.style.setProperty('--dsc-dur', '0ms');
  if ('__DARK__' === '1') document.documentElement.dataset.theme = 'dark';
  // 与 styles.css 追加区那两条悬停规则同源的覆盖（截图钩子之外的就地版本）
  const st = document.createElement('style');
  st.textContent = '.sidebar .group-row.__h{background:var(--dsc-row-hover-bg)}' +
    '.sidebar .group-row.__h .row-tail .row-actions{opacity:1;visibility:visible}';
  document.head.append(st);
  const rows = Array.from(document.querySelectorAll('.group-row'));
  if ('__DARK__' === '1' && rows[0]) rows[0].classList.add('__h');
  const acts = (el) => { const a = el.querySelector('.row-tail .row-actions'); const cs = getComputedStyle(a); const r = a.getBoundingClientRect(); return { vis: cs.visibility + '/' + cs.opacity, bg: cs.backgroundColor + ' + ' + cs.backgroundImage.slice(0, 40), l: +r.left.toFixed(1), w: +r.width.toFixed(1) }; };
  return {
    theme: document.documentElement.dataset.theme,
    cls: document.body.className,
    first: acts(rows[0]),
    second: acts(rows[1]),
    hovered: document.querySelectorAll('.group-row:hover').length,
  };
})()
'@
$env:DSC_DESKTOP_SHOT_EVAL = $env:DSC_DESKTOP_SHOT_EVAL.Replace('__DARK__', $(if ($Case -eq 'dark') { '1' } else { '0' }))

$log = Join-Path $shots "sb-$Case.log"
& $electron 'out\main\index.js' *>&1 | Out-File -FilePath $log -Encoding utf8
Select-String -Path $log -Pattern 'selfcheck' | ForEach-Object { $_.Line }
