# 侧栏优化自检截图：品牌行的 DESKTOP 徽标、会话行右键菜单（含「复制会话 ID」）、
# 图标按钮放大的前后对比。
#
# 四个用例：
#   icons  侧栏列表（?reveal=1 让 hover 才出现的行按钮常驻）+ 实测各处图标按钮的
#          宽高与图标尺寸，用来做放大前后对照；
#   menu   在某条会话行上派发 contextmenu，拍「···」菜单；
#   copy   切到归档区，在归档行的右键菜单里点「复制会话 ID」，拍 Toast，
#          并把系统剪贴板读回来核对写进去的是不是会话 uuid。
#
# 隔离：DSC_DESKTOP_USER_DATA 换独立 userData，USERPROFILE/HOME 指向
# shots\btn-home，真实 ~/.dsc 零写入。
#
# 用法（在 desktop 目录下跑）：pwsh -File shots\btn-shots.ps1 -Case icons -Theme dark
param(
  [ValidateSet('icons', 'menu', 'copy', 'viewmenu')][string]$Case = 'icons',
  [ValidateSet('dark', 'light')][string]$Theme = 'dark',
  # 输出文件名里的可选中缀（before / after），默认空
  [string]$Tag = ''
)

$ErrorActionPreference = 'Stop'
# 带着 ELECTRON_RUN_AS_NODE 启动会被当成纯 Node 直接退出，什么都拍不到
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$home2 = Join-Path $shots 'btn-home'

$env:DSC_DESKTOP_USER_DATA = Join-Path $shots 'btn-udata'
$env:USERPROFILE = $home2
$env:HOME = $home2
$env:DSC_HOME = Join-Path $home2 '.dsc'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SHOT = Join-Path $shots "btn-$Case$Tag-$Theme.png"

# 每档的「截图时刻 / 预跑脚本提前量」：copy 要在截图前 ~1.5s 才按下复制，
# 好让 2.2s 的 Toast 正好留在画面里。
switch ($Case) {
  'icons' { $delay = 9000; $lead = 5000 }
  'menu' { $delay = 10000; $lead = 6000 }
  'copy' { $delay = 17000; $lead = 13000 }
  'viewmenu' { $delay = 9000; $lead = 5500 }
}
$env:DSC_DESKTOP_SHOT_DELAY = "$delay"
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = "$lead"

# ?reveal=1 让只在 hover 时出现的行内按钮常驻（App.tsx 的截图钩子）
if ($Case -eq 'icons') { $env:DSC_DESKTOP_SEARCH = 'reveal=1' }
else { Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue }

$script:iconsEval = @'
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const root = document.documentElement;
  root.dataset.theme = '__THEME__';
  root.style.setProperty('--dsc-dur', '0ms');
  // 拟真 hover 态：光标在自动化里放不准，所以把 .sess-item:hover 那几条规则
  // （行底色、时间让位、按钮组常驻）就地复现一遍，看到的就是真悬停的样子。
  const st = document.createElement('style');
  st.textContent = '.sess-item.__h{background:var(--dsc-row-hover-bg);color:var(--dsc-text-secondary)}' +
    '.sess-item.__h>.when{display:none}' +
    '.sess-item.__h .row-actions{display:inline-flex}' +
    '.group-row.__h{background:var(--dsc-row-hover-bg)}' +
    '.group-row.__h .row-tail .count{display:none}' +
    '.group-row.__h .row-tail .row-actions{display:inline-flex}';
  document.head.append(st);
  // 会话列表是宿主异步送来的，等第一行画出来再量
  let row = null;
  for (let i = 0; i < 30 && row === null; i++) {
    row = document.querySelector('.sess-item');
    if (row === null) await sleep(200);
  }
  const groupRow = document.querySelector('.group-row');
  if (row) row.classList.add('__h');
  if (groupRow) groupRow.classList.add('__h');
  await sleep(250);
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
  const svgBox = (el) => { const s = el ? el.querySelector('svg') : null; if (!s) return null; const r = s.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
  const header = document.querySelector('.sidebar-header');
  const railToggle = document.querySelector('.sidebar-header .rail-toggle');
  const headBtn = document.querySelector('.head-actions .icon-btn');
  const rowBtns = row ? Array.from(row.querySelectorAll('.row-actions .icon-btn')) : [];
  const tail = groupRow ? groupRow.querySelector('.row-tail .row-actions') : null;
  const tailBtns = tail ? Array.from(tail.querySelectorAll('.icon-btn')) : [];
  const menuItem = document.querySelector('.menu-item');
  // 密度回归：标准密度下行高只有 26px，28px 的按钮会不会把行撑破
  const origDensity = root.dataset.density;
  root.dataset.density = 'standard';
  await sleep(200);
  const stdRow = box(row);
  const stdBtn = box(rowBtns[0]);
  const stdGroup = box(groupRow);
  root.dataset.density = origDensity;
  root.dataset.theme = '__THEME__';
  return {
    case: 'icons',
    theme: root.dataset.theme,
    density: root.dataset.density,
    // 【1】品牌行：徽标应为 0 个，品牌图标与「Muse Code」文字都还在
    badgeCount: document.querySelectorAll('.sidebar-header .badge').length,
    headerText: header ? header.textContent.replace(/\s+/g, ' ').trim() : null,
    headerImgs: header ? header.querySelectorAll('img').length : -1,
    brand: header && header.querySelector('.brand') ? header.querySelector('.brand').textContent : null,
    // 【3】各处图标按钮的 hit area 与图标尺寸
    railToggle: box(railToggle),
    railToggleIcon: svgBox(railToggle),
    headBtn: box(headBtn),
    headBtnIcon: svgBox(headBtn),
    rowBtns: rowBtns.map(box),
    rowIcons: rowBtns.map(svgBox),
    rowActions: box(row ? row.querySelector('.row-actions') : null),
    tailBtns: tailBtns.map(box),
    sessRowH: box(row),
    groupRowH: box(groupRow),
    iconBtnCss: (() => { const b = rowBtns[0] || headBtn; if (!b) return null; const cs = getComputedStyle(b); return { w: cs.width, h: cs.height }; })(),
    menuItemH: box(menuItem),
    stdDensityRow: stdRow,
    stdDensityBtn: stdBtn,
    stdDensityGroupRow: stdGroup
  };
})()
'@

$script:menuEval = @'
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const root = document.documentElement;
  root.dataset.theme = '__THEME__';
  root.style.setProperty('--dsc-dur', '0ms');
  // 会话列表是宿主异步送来的，等它画出来再右键（冷启动时可能要等一两秒）
  const waitFor = async (fn) => { for (let i = 0; i < 30; i++) { const v = fn(); if (v) return v; await sleep(200); } return null; };
  const row = await waitFor(() =>
    Array.from(document.querySelectorAll('.sess-item')).find((el) => !el.classList.contains('archived')) ||
    document.querySelector('.sess-item'));
  const rows = Array.from(document.querySelectorAll('.sess-item'));
  let rowTitle = '';
  let tip = '';
  if (row) {
    rowTitle = row.querySelector('.title') ? row.querySelector('.title').textContent : '';
    tip = row.getAttribute('data-tip') || '';
    // 真右键：React 的 onContextMenu 挂在根容器上，冒泡的 contextmenu 事件就能触发
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, button: 2 }));
  }
  await sleep(700);
  const items = Array.from(document.querySelectorAll('.row-menu .menu-item'));
  const iconBox = (el) => { const s = el ? el.querySelector('svg') : null; if (!s) return null; const r = s.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
  const copyBtn = items.find((el) => el.textContent.includes('复制会话 ID'));
  root.dataset.theme = '__THEME__';
  return {
    case: 'menu',
    theme: root.dataset.theme,
    sessRows: rows.length,
    rowTitle: rowTitle,
    tip: tip,
    menuOpen: document.querySelectorAll('.row-menu').length,
    menuTexts: items.map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
    copyItemFound: copyBtn !== undefined,
    copyIcon: iconBox(copyBtn),
    menuItemBox: items.length > 0 ? (() => { const r = items[0].getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })() : null
  };
})()
'@

$script:copyEval = @'
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const root = document.documentElement;
  root.dataset.theme = '__THEME__';
  root.style.setProperty('--dsc-dur', '0ms');
  // 剪贴板写入留个副本，万一 readText 被权限挡住也能核对写进去的是什么
  let copied = null;
  try {
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text) => { copied = text; return orig(text); };
  } catch (e) { /* 包装不上就只靠 readText 与系统剪贴板 */ }
  // 走真实的界面路径切到归档区（点「视图选项 → 仅显示已归档」）：
  // 界面偏好是 App 的 state，绕过去直接调 setUiPrefs 只会落盘、列表不会重画。
  const pickView = async (label) => {
    let btn = null;
    for (let i = 0; i < 30 && btn === null; i++) {
      btn = Array.from(document.querySelectorAll('.head-actions .icon-btn'))
        .find((el) => (el.getAttribute('data-tip') || '').startsWith('视图选项'));
      if (btn === null) await sleep(200);
    }
    if (!btn) return '找不到视图选项按钮';
    btn.click();
    await sleep(500);
    const item = Array.from(document.querySelectorAll('.row-menu .menu-item'))
      .find((el) => el.textContent.includes(label));
    if (!item) return '菜单里没有「' + label + '」';
    item.click();
    await sleep(900);
    return 'ok';
  };
  const switchResult = await pickView('仅显示已归档');
  // 归档工作区不是当前目录，默认是折叠的：点箭头把它的会话行放出来
  if (document.querySelectorAll('.sess-item.archived').length === 0) {
    const twisty = document.querySelector('.group-row .twisty');
    if (twisty) { twisty.click(); await sleep(800); }
  }
  const rows = Array.from(document.querySelectorAll('.sess-item.archived'));
  const row = rows[0] || document.querySelector('.sess-item');
  let rowTitle = '';
  if (row) {
    rowTitle = row.querySelector('.title') ? row.querySelector('.title').textContent : '';
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, button: 2 }));
  }
  await sleep(800);
  const items = Array.from(document.querySelectorAll('.row-menu .menu-item'));
  const menuTexts = items.map((el) => el.textContent.replace(/\s+/g, ' ').trim());
  const copyBtn = items.find((el) => el.textContent.includes('复制会话 ID'));
  // 等到离截图 ~1.8s 的那一刻再按：Toast 只停 2.2s，正好卡在画面里
  await sleep(8200);
  if (copyBtn) copyBtn.click();
  await sleep(400);
  let clip = null;
  let clipErr = '';
  try { clip = await navigator.clipboard.readText(); } catch (e) { clipErr = String(e); }
  root.dataset.theme = '__THEME__';
  return {
    case: 'copy',
    theme: root.dataset.theme,
    switchResult: switchResult,
    archivedRows: rows.length,
    rowTitle: rowTitle,
    menuTexts: menuTexts,
    copyItemFound: copyBtn !== undefined,
    wroteToClipboard: copied,
    readBack: clip,
    readErr: clipErr,
    toast: (() => { const t = document.querySelector('.dsc-toast__text'); return t ? t.textContent : null; })(),
    toasts: document.querySelectorAll('.dsc-toast').length
  };
})()
'@

$script:viewEval = @'
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const root = document.documentElement;
  root.dataset.theme = '__THEME__';
  root.style.setProperty('--dsc-dur', '0ms');
  let btn = null;
  for (let i = 0; i < 30 && btn === null; i++) {
    btn = document.querySelector('[data-tip^="视图选项"]');
    if (btn === null) await sleep(200);
  }
  if (btn) btn.click();
  await sleep(700);
  const items = Array.from(document.querySelectorAll('.view-menu .menu-item'));
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
  const checks = Array.from(document.querySelectorAll('.view-menu .menu-check'));
  root.dataset.theme = '__THEME__';
  return {
    case: 'viewmenu',
    theme: root.dataset.theme,
    menuOpen: document.querySelectorAll('.view-menu').length,
    menuTexts: items.map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
    firstItem: box(items[0]),
    checkCells: checks.map(box),
    // 勾选图标有没有被 15px 的列挤出格子
    checkOverflow: checks.map((el) => { const s = el.querySelector('svg'); if (!s) return 0; return +(s.getBoundingClientRect().right - el.getBoundingClientRect().right).toFixed(1); })
  };
})()
'@

$eval = switch ($Case) { 'icons' { $script:iconsEval } 'menu' { $script:menuEval } 'copy' { $script:copyEval } 'viewmenu' { $script:viewEval } }
$env:DSC_DESKTOP_SHOT_EVAL = $eval.Replace('__THEME__', $Theme)

$log = Join-Path $shots "btn-$Case$Tag-$Theme.log"
& $electron 'out\main\index.js' *>&1 | Out-File -FilePath $log -Encoding utf8
Select-String -Path $log -Pattern 'selfcheck' | ForEach-Object { $_.Line }

if ($Case -eq 'copy') {
  $clip = ''
  try { $clip = (Get-Clipboard -Raw) } catch { $clip = "读取失败：$($_.Exception.Message)" }
  Write-Output "系统剪贴板内容：[$clip]"
  $uuidOk = $clip -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  Write-Output "uuid 格式：$uuidOk"
  Write-Output "不带路径分隔符：$(-not ($clip.Contains('\') -or $clip.Contains('/')))"
  $hit = Get-ChildItem -Path (Join-Path $home2 '.dsc\sessions') -Recurse -Filter "$clip.jsonl" -ErrorAction SilentlyContinue
  Write-Output "对应的会话文件：$(if ($hit) { $hit.FullName } else { '没找到' })"
}
