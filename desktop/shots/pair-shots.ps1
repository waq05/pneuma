# 自检：「连接手机」弹窗（PairModal）——二维码、配对码、可扫地址、倒计时、重新生成；
# 以及「手机连不上」那两种引导态（只监听本机 / 远程服务没跑）。
#
# 走 ?pair=1 截图钩子：直接开设置到「远程控制」并自动点一次「连接手机」，
# 那条动作会真去宿主要一张配对码（隔离 HOME，写的是 pair-home 里的 pending.json）。
# 断言看四件事：①弹窗结构在不在；②二维码真画出来了（img 的 src 是 data:image/png，
# 且尺寸就是 220）——`-Case blocked` 时这一步反过来，要看的是引导块与那颗按钮；
# ③样式生效（.pair-card 有内边距与宽度、.pair-qr 有卡片底色）；④引导态不许再画二维码。
#
# 2026-11-12 报障：局域网开关关着时二维码里是 127.0.0.1，手机扫完只会报「网页暂时无法打开」。
# 所以这里先把隔离 HOME 的偏好写死：`blocked` 用「只听本机」，其余两个用「允许局域网访问」，
# 端口都取 17399，免得与正在跑的宿主抢 17321 的主控位（抢不到就变成「服务没在跑」那一态）。
param([ValidateSet('dark', 'light', 'blocked')][string]$Case = 'dark')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$home2 = Join-Path $shots 'pair-home'

New-Item -ItemType Directory -Force -Path (Join-Path $home2 '.dsc') | Out-Null
@{
  remote = @{
    enabled = $true
    port = 17399
    lan = ($Case -ne 'blocked')
    push = $false
    notifyWebhook = ''
  }
} | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $home2 '.dsc\settings.json') -Encoding utf8

$env:DSC_DESKTOP_USER_DATA = Join-Path $shots 'pair-udata'
$env:USERPROFILE = $home2
$env:DSC_HOME = Join-Path $home2 '.dsc'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SEARCH = 'pair=1'
$env:DSC_DESKTOP_SHOT = Join-Path $shots "pair-01-$Case.png"
$env:DSC_DESKTOP_SHOT_DELAY = '9000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '3500'

$env:DSC_DESKTOP_SHOT_EVAL = @'
(() => {
  document.documentElement.style.setProperty('--dsc-dur', '0ms');
  if ('__LIGHT__' === '1') document.documentElement.dataset.theme = 'light';
  const card = document.querySelector('.pair-card');
  const img = document.querySelector('.pair-qr-img');
  const code = document.querySelector('.pair-code');
  const count = document.querySelector('.pair-count');
  const url = document.querySelector('.pair-url .mono');
  const qrBox = document.querySelector('.pair-qr');
  const guideTitle = document.querySelector('.pair-qr-guide-title');
  const guideButton = document.querySelector('.pair-qr-guide button');
  const buttons = Array.from(document.querySelectorAll('.pair-actions button')).map((b) => b.textContent);
  const copyBtns = document.querySelectorAll('.pair-card .text-btn').length;
  const cs = card ? getComputedStyle(card) : null;
  const qs = qrBox ? getComputedStyle(qrBox) : null;
  const r = img ? img.getBoundingClientRect() : null;
  const raw = code ? String(code.textContent).replace(/\s+/g, '') : '';
  return {
    modal: card !== null,
    qrSrc: img ? String(img.getAttribute('src')).slice(0, 22) : null,
    qrBox: r ? [Math.round(r.width), Math.round(r.height)] : null,
    code: raw,
    codeLen: raw.length,
    codeIsAlnum: /^[A-Z0-9]{8}$/.test(raw),
    count: count ? count.textContent.replace(/\s+/g, ' ').trim() : null,
    urlTail: url ? String(url.textContent).slice(-14) : null,
    copyButtons: copyBtns,
    actions: buttons,
    cardDisplay: cs ? cs.display : null,
    cardPadding: cs ? cs.paddingTop : null,
    cardWidth: cs ? cs.width : null,
    qrBackground: qs ? qs.backgroundColor : null,
    qrRadius: qs ? qs.borderTopLeftRadius : null,
    /* 引导态（未允许局域网 / 服务没在跑）：标题、按钮文案，以及「有没有偷偷画码」 */
    guideTitle: guideTitle ? String(guideTitle.textContent).trim() : null,
    guideButton: guideButton ? String(guideButton.textContent).trim() : null,
  };
})()
'@
$env:DSC_DESKTOP_SHOT_EVAL = $env:DSC_DESKTOP_SHOT_EVAL.Replace('__LIGHT__', $(if ($Case -eq 'light') { '1' } else { '0' }))

$log = Join-Path $shots "pair-$Case.log"
# 应用入口用绝对路径：脚本从仓库根跑（pwsh -File desktop/shots/pair-shots.ps1），
# 相对路径 'out\main\index.js' 会解析到仓库根下不存在的位置（step-shots.ps1 同款写法）。
$entry = Join-Path $shots '..\out\main\index.js'
& $electron $entry *>&1 | Out-File -FilePath $log -Encoding utf8
Select-String -Path $log -Pattern '预跑脚本' | ForEach-Object { $_.Line }
