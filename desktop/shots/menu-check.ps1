# 侧栏菜单修复走查（0.6.41）：两个用户报障的端到端验证。
#
#   ① 会话右键菜单超宽：右键会话行，量 .sess-ctx-menu 的宽——修复前 inline left
#      与 .row-menu 遗留的 right: 4px 并存把容器横向拉满（≈ 视口宽 − left），
#      修复后应收缩到内容宽（< 300px）。
#   ② 底部工作区「···」菜单被裁：点最后一个工作区行的「更多操作」，量菜单
#      rect——修复前 absolute 就地展开、被滚动区 overflow 裁掉；修复后 fixed 贴
#      按钮、底部放不下翻到按钮上方，应完整落在视口内（bottom ≤ innerHeight）。
#
# 复用 sound-home 种子（有真实会话行），无假端点——菜单是纯前端交互。
# 用法（先在 desktop/ 跑 `pnpm run build`）：
#   pwsh -NoProfile -File menu-check.ps1

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$mc = 'D:\dsc\desktop\shots'
$mcElectron = Join-Path $mc '..\node_modules\electron\dist\electron.exe'
$mcEntry = Join-Path $mc '..\out\main\index.js'
$mcHome = Join-Path $mc 'sound-home'

$mcEval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = await pred(); if (v) return v; await wait(120); }
    return null;
  };
  const started = Date.now();
  try {
    const row = await waitFor(() => document.querySelector('.sess-item'), 20000);
    if (row === null) return { case: 'menu-check', error: '会话行没找到', ms: Date.now() - started };

    // ① 会话行右键 → 量菜单宽
    const rowRect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: rowRect.left + 40, clientY: rowRect.top + 10,
    }));
    const ctx = await waitFor(() => document.querySelector('.sess-ctx-menu'), 3000);
    if (ctx === null) return { case: 'menu-check', error: '右键菜单没弹出', ms: Date.now() - started };
    await wait(200);
    const ctxRect = ctx.getBoundingClientRect();
    const ctxWidth = Math.round(ctxRect.width);
    const ctxInViewport = ctxRect.right <= window.innerWidth && ctxRect.bottom <= window.innerHeight && ctxRect.top >= 0;
    document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(200);

    // ② 最后一个工作区行的「···」→ 底部场景量菜单位置
    // 先把侧栏滚到底，让目标行真正贴到视口底部（复现「工作区在最底下」）
    const scroller = document.querySelector('.sidebar-scroll');
    if (scroller !== null) { scroller.scrollTop = scroller.scrollHeight; await wait(400); }
    const moreBtns = Array.from(document.querySelectorAll('.group-row [data-tip="更多操作"]'));
    if (moreBtns.length === 0) return { case: 'menu-check', error: '更多操作按钮没找到', ctxWidth, ms: Date.now() - started };
    const last = moreBtns[moreBtns.length - 1];
    last.scrollIntoView({ block: 'nearest' });
    // 「···」按钮平时随 .row-actions 隐藏（hover / focus-within / shot-reveal 才显示），
    // 隐藏元素的 rect 全 0——加 shot-reveal 钩子类让按钮组常驻（与真实用户 hover
    // 后点击等价），再量坐标。
    document.body.classList.add('shot-reveal');
    await wait(300);
    const btnRect = last.getBoundingClientRect();
    if (btnRect.bottom === 0 && btnRect.top === 0) {
      return { case: 'menu-check', error: '按钮仍不可见（rect 全 0）', ctxWidth, ms: Date.now() - started };
    }
    const spaceBelow = Math.round(window.innerHeight - btnRect.bottom);
    last.click();
    const opened = await waitFor(() => document.querySelector('.group-row .row-menu'), 3000);
    if (opened === null) return { case: 'menu-check', error: '更多菜单没弹出', ctxWidth, spaceBelow, ms: Date.now() - started };
    await wait(200);
    const mRect = opened.getBoundingClientRect();
    const moreWidth = Math.round(mRect.width);
    const moreBottom = Math.round(mRect.bottom);
    const moreTop = Math.round(mRect.top);
    const downOk = moreBottom <= window.innerHeight + 1 && moreTop >= 0 && moreTop === Math.round(btnRect.bottom) + 6;
    document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(200);

    // ③ 贴底翻转分支：真实内容不足一屏、窗口又有 640 下限，构造不出真实贴底。
    //    给按钮实例 patch 一个「贴视口底缘」的假 rect——React 的翻转判定
    //    （spaceBelow）与菜单的 CSS bottom 都从这一份 rect 推导，自洽；真实
    //    innerHeight 不动，菜单就真渲染在「贴底按钮上方」的位置。
    last.getBoundingClientRect = () => ({
      top: window.innerHeight - 60, bottom: window.innerHeight,
      left: 100, right: 132, width: 32, height: 60,
      x: 100, y: window.innerHeight - 60, toJSON: () => ({}),
    });
    last.click();
    const flipped = await waitFor(() => document.querySelector('.group-row .row-menu'), 3000);
    if (flipped === null) return { case: 'menu-check', error: '翻转场景菜单没弹出', ctxWidth, downOk, ms: Date.now() - started };
    await wait(200);
    const fRect = flipped.getBoundingClientRect();
    const flipBottom = Math.round(fRect.bottom);
    const flipTop = Math.round(fRect.top);
    document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const anchorTop = Math.round(window.innerHeight - 60);
    return {
      case: 'menu-check',
      ctxWidth, ctxInViewport,
      btnTop: Math.round(btnRect.top), btnBottom: Math.round(btnRect.bottom),
      spaceBelow, moreWidth, moreBottom, moreTop,
      downOk, flipTop, flipBottom, anchorTop,
      flipOk: flipBottom === anchorTop - 6 && flipTop >= 0 && fRect.right <= window.innerWidth && fRect.bottom <= window.innerHeight + 1,
      innerHeight: window.innerHeight,
      ms: Date.now() - started,
    };
  } catch (error) {
    return { case: 'menu-check', error: String(error), ms: Date.now() - started };
  }
})()
'@

$env:DSC_DESKTOP_USER_DATA = Join-Path $mcHome 'electron-userdata'
$env:USERPROFILE = $mcHome
$env:HOME = $mcHome
$env:SOUND_FAKE_KEY = 'e2e-fake-key'
$env:DSC_DESKTOP_SHOT = Join-Path $mc 'menu-check.png'
$env:DSC_DESKTOP_SHOT_DELAY = '9000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '6000'
$env:DSC_DESKTOP_SHOT_EVAL = $mcEval
Remove-Item Env:DSC_DESKTOP_SHOT_TOPMOST -ErrorAction SilentlyContinue
Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue

$outLog = Join-Path $mc 'menu-check.out.log'
$errLog = Join-Path $mc 'menu-check.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $mcElectron -ArgumentList $mcEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
$deadline = (Get-Date).AddSeconds(50)
$seen = ''
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) { break }
  if (Test-Path -LiteralPath $errLog) {
    $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|截图失败|页面加载失败' -ErrorAction SilentlyContinue
    if ($null -ne $hit) { $seen = $hit[0].Line; break }
  }
  Start-Sleep -Milliseconds 800
}
& taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
Start-Sleep -Milliseconds 600
Write-Output ("electron 已收工：{0}" -f ($seen -replace '\s+$', ''))
Select-String -LiteralPath $errLog -Pattern '预跑脚本完成|预跑脚本失败' -ErrorAction SilentlyContinue |
  ForEach-Object { '  ' + $_.Line }

Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
  Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_USER_DATA, Env:SOUND_FAKE_KEY -ErrorAction SilentlyContinue
Write-Output '走查完成'
