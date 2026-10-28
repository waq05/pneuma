# 视觉打磨的自检截图脚本（只读用户数据：恢复已有会话；窗口记忆不动，因为自检走 app.exit）。
#
# 用法：
#   pwsh -NoProfile -File hermes-shots.ps1 -Case chat-light -Variant both
#   pwsh -NoProfile -File hermes-shots.ps1 -Case all -Variant after
#
# before 变体怎么来的：同一轮里把被我改掉的旧 CSS 注入回页面（见 $OldCss），
# 所以前后两张的会话、滚动位置、窗口尺寸完全一致，差别只有这次改的那些规则。
# 会话流里被删掉的那行「会话 x · 模型 y」由 JS 补回去（$BeforeFill）。

param(
  [string]$Case = 'all',
  [ValidateSet('before', 'after', 'both')][string]$Variant = 'both'
)

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$sessions = 'C:\Users\waq\.dsc\sessions'
$env:DSC_DESKTOP_USER_DATA = Join-Path $shots 'hermes-udata'
$env:DSC_DESKTOP_SHOT_DELAY = '8500'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '5500'
# 截屏要窗口真的被合成过：不 show() 时 capturePage 会抛 UnknownVizError。
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'

# ── 改动前的样式（只列这次被我替换掉的旧值）────────────────────────────────
$OldCss = @'
.btn-new{justify-content:center;gap:8px;margin:8px 10px 6px;min-height:38px;padding:4px 10px;
  border-radius:var(--dsc-r-overlay);background:var(--dsc-fill-quaternary);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsc-stroke-2) 60%,transparent);
  font-size:var(--dsc-fs-ui-lg);font-weight:500}
.btn-new svg{color:var(--dsc-text-secondary)}
.sidebar{border-right:1px solid color-mix(in srgb,var(--dsc-base) 7.5%,transparent)}
.topbar{border-bottom:1px solid color-mix(in srgb,var(--dsc-base) 7.5%,transparent)}
.statusbar{padding:3px 20px 5px}
.row-menu{border-radius:var(--dsc-r-icon);background:var(--dsc-bg-card);
  box-shadow:var(--dsc-shadow-float);backdrop-filter:none}
.menu-item{padding:6px 8px;border-radius:var(--dsc-r-row)}
.menu-item:hover{background:var(--dsc-row-hover-bg)}
.model-pop{border-radius:14px}
.settings{border-radius:var(--dsc-r-block)}
.settings-mask{background:rgb(0 0 0/55%);backdrop-filter:none}
.settings-nav-item.on{background:var(--dsc-fill-secondary)}
.switch::after{background:#fff;box-shadow:none}
.switch{box-shadow:none}
.statusbar .ctx-trigger:focus-visible{outline:1px solid var(--dsc-accent);outline-offset:1px;box-shadow:none}
.effort-btn{transition:all 100ms cubic-bezier(.4,0,.2,1)}
.mode-btn.mode-explore{color:#4a9eff}
.completions .item{border-radius:0;transition:none}
'@

# 改动前消息流末尾那行居中的「会话 x · 模型 y」（宿主写的，这次被界面过滤掉）
$BeforeFill = @'
const __chat = document.querySelector('.chat-inner');
const __welcome = document.querySelector('.welcome');
const __model = (document.querySelector('.model-btn .model-name') || {}).textContent || 'hy3-a';
if (__chat) { const d = document.createElement('div'); d.className = 'entry-system'; d.textContent = `会话 c2b4d845 · 模型 ${__model}/${__model}`; __chat.append(d); }
if (__welcome) { const d = document.createElement('div'); d.className = 'welcome-note'; d.textContent = `会话 bec0d54b · 模型 ${__model}/${__model}`; __welcome.append(d); }
'@

# 每个用例共用的前置：停掉过渡（截图不抓中间态）、注入 before 用的旧样式、按用例改主题
$Head = @'
document.documentElement.style.setProperty('--dsc-dur', '0ms');
const __st = document.createElement('style');
__st.textContent = window.__css || '';
document.head.append(__st);
if (window.__theme) document.documentElement.dataset.theme = window.__theme;
const q = (s) => document.querySelector(s);
const all = (s) => Array.from(document.querySelectorAll(s));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
'@

$cases = [ordered]@{
  # 浅色 · 有内容的会话（对齐 chk-chat-light.png）
  'chat-light' = @{
    theme   = 'light'
    query   = 'reveal=1'
    session = Join-Path $sessions 'C-Windows-System32\c2b4d845-b210-475f-8791-81707338b592.jsonl'
    script  = @'
(async () => {
  await wait(1500);
  return { theme: document.documentElement.dataset.theme, entries: document.querySelectorAll('.chat-inner > *').length };
})()
'@
  }
  # 深色 · 短会话 + 上下文卡（对齐 chk-card-dark.png）
  'chat-dark' = @{
    theme   = 'dark'
    query   = ''
    session = Join-Path $sessions 'C-Windows-System32\3984ad6e-08aa-458e-aeea-3bc53433b2c6.jsonl'
    script  = @'
(async () => {
  await wait(1500);
  const t = q('.ctx-trigger'); if (t) t.focus();
  // 截图前一瞬再点一次焦点：宿主推一次快照就会重挂输入区，autoFocus 会把焦点抢回 textarea，
  // 焦点环和上下文卡就都没了（第一版就是这么拍丢的）。
  await wait(3300);
  const again = q('.ctx-trigger'); if (again) again.focus();
  await wait(600);
  return { theme: document.documentElement.dataset.theme, ctx: q('.ctx-card') ? getComputedStyle(q('.ctx-card')).borderRadius : null, ring: again ? getComputedStyle(again).boxShadow : null, fv: again ? again.matches(':focus-visible') : null };
})()
'@
  }
  # 浅色 · 欢迎页 + 侧栏（对齐 chk-light.png）
  'welcome-light' = @{
    theme   = 'light'
    query   = ''
    session = Join-Path $env:TEMP 'dsc-hermes-shot\empty-session.jsonl'
    script  = @'
(async () => {
  await wait(1500);
  return { theme: document.documentElement.dataset.theme, welcome: !!q('.welcome'), notes: document.querySelectorAll('.welcome-note').length };
})()
'@
  }
  # 浅色 · 侧栏会话行的「⋯」菜单（看两套菜单的长相有没有并成一套）
  'menu-light' = @{
    theme   = 'light'
    query   = 'reveal=1'
    session = Join-Path $sessions 'C-Windows-System32\c2b4d845-b210-475f-8791-81707338b592.jsonl'
    script  = @'
(async () => {
  await wait(1500);
  const row = q('.sess-item');
  if (row) {
    row.click();
    await wait(700);
    const acts = document.querySelectorAll('.sess-item .row-actions .icon-btn');
    if (acts.length > 0) acts[acts.length - 1].click();
  }
  await wait(500);
  const menu = q('.row-menu');
  const item = q('.menu-item');
  return { theme: document.documentElement.dataset.theme, menu: menu ? { radius: getComputedStyle(menu).borderRadius, shadow: getComputedStyle(menu).boxShadow.slice(0, 28) } : null, item: item ? { pad: getComputedStyle(item).padding, radius: getComputedStyle(item).borderRadius } : null };
})()
'@
  }
  # 浅色 · 设置面板：对话框圆角 + 遮罩三处是不是一个值
  'settings-light' = @{
    theme   = 'light'
    query   = ''
    session = Join-Path $sessions 'D-dsc\d78f775e-3ec8-4bec-8577-f10c9936c335.jsonl'
    script  = @'
(async () => {
  await wait(1500);
  const btn = Array.from(document.querySelectorAll('.nav-item, .sidebar-footer .row-btn')).find((b) => b.textContent.indexOf('设置') >= 0);
  if (btn) btn.click();
  await wait(900);
  const dialog = q('.settings');
  const mask = q('.settings-mask');
  return { theme: document.documentElement.dataset.theme, dialog: dialog ? getComputedStyle(dialog).borderRadius : null, mask: mask ? getComputedStyle(mask).backgroundColor + ' / ' + getComputedStyle(mask).backdropFilter : null };
})()
'@
  }
}

# 空会话文件：让欢迎页拍得出来（不给用户目录里添新会话）
$emptyPath = Join-Path $env:TEMP 'dsc-hermes-shot\empty-session.jsonl'
New-Item -ItemType Directory -Force -Path (Split-Path $emptyPath) | Out-Null
$meta = '{"type":"meta","id":"00000000-0000-4000-8000-000000000000","cwd":"C:\\\\Windows\\\\System32","createdAt":' +
  [string][long]([datetime]::UtcNow - [datetime]'1970-01-01').TotalMilliseconds + '}'
Set-Content -Path $emptyPath -Value $meta -Encoding utf8NoBOM

foreach ($name in $cases.Keys) {
  if ($Case -ne 'all' -and $Case -ne $name) { continue }
  $spec = $cases[$name]
  foreach ($v in @('after', 'before')) {
    if ($Variant -ne 'both' -and $Variant -ne $v) { continue }
    $css = if ($v -eq 'before') { $OldCss } else { '' }
    $fill = if ($v -eq 'before') { $BeforeFill } else { '' }
    $png = Join-Path $shots "hermes-$name-$v.png"
    $log = Join-Path $shots "hermes-$name-$v.log"
    $env:DSC_DESKTOP_SHOT = $png
    $env:DSC_DESKTOP_SEARCH = $spec.query
    $env:DSC_RESUME_SESSION = $spec.session
    $env:DSC_DESKTOP_SHOT_EVAL = "window.__css = " + ($css | ConvertTo-Json -Compress) +
      ";`nwindow.__theme = " + ($spec.theme | ConvertTo-Json -Compress) + ";`n" + $Head + "`n" + $fill + "`n" + $spec.script
    Write-Output "=== $name / $v ==="
    & $electron 'out\main\index.js' *>&1 | Out-File -FilePath $log -Encoding utf8
    Select-String -Path $log -Pattern 'selfcheck' | ForEach-Object { '  ' + $_.Line } | Select-Object -First 8
  }
}

Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SEARCH, Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST -ErrorAction SilentlyContinue
Write-Output '全部完成'
