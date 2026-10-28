# 状态栏前两段详情卡的截图：把焦点放到那一段的触发按钮上（键盘聚焦与悬停
# 走的是同一条 :focus-within/:hover 显示规则），并把卡的几何与文案读回来核对。
# 焦点会被输入区 autoFocus 抢走，所以脚本在截图前反复抢回来（hermes 那套踩过的坑）。
param([ValidateSet('turn', 'tokens')][string]$Which = 'turn')

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
$env:DSC_DESKTOP_SHOT = Join-Path $shots "sb-03-card-$Which.png"
$env:DSC_DESKTOP_SHOT_DELAY = '14000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '8000'

$sel = if ($Which -eq 'turn') { '.seg-turn .ctx-trigger' } else { '.seg-tokens .ctx-trigger' }
$env:DSC_DESKTOP_SHOT_EVAL = @"
(async () => {
  document.documentElement.style.setProperty('--dsc-dur', '0ms');
  const q = (s) => document.querySelector(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // 反复抢焦点，一直抢到截图那一刻（循环不提前结束：宿主推快照会重挂输入区，
  // 输入区的 autoFocus 会把焦点抢回去，焦点一丢卡就没了）
  for (let i = 0; i < 80; i++) { const t = q('$sel'); if (t) t.focus(); await wait(250); }
  const seg = q('$sel');
  const card = seg ? seg.parentElement.querySelector('.ctx-card') : null;
  const cs = card ? getComputedStyle(card) : null;
  const rows = card ? Array.from(card.querySelectorAll('.ctx-row')).map((r) => r.textContent.trim()) : [];
  return {
    visible: cs ? cs.visibility + '/' + cs.opacity : 'no card',
    radius: cs ? cs.borderRadius : '',
    shadow: cs ? cs.boxShadow.replace(/\s+/g, ' ').slice(0, 60) : '',
    head: card ? card.querySelector('.ctx-head').textContent.trim() : '',
    rows: rows,
    rule: card ? card.querySelectorAll('.ctx-rule').length : 0,
    size: card ? (() => { const r = card.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), l: +r.left.toFixed(1) }; })() : null,
    segments: Array.from(document.querySelectorAll('.statusbar .segment')).map((el) => el.textContent.trim().slice(0, 30)),
  };
})()
"@

$log = Join-Path $shots "sb-cards-$Which.log"
& $electron 'out\main\index.js' *>&1 | Out-File -FilePath $log -Encoding utf8
Select-String -Path $log -Pattern 'selfcheck' | ForEach-Object { $_.Line }
