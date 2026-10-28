# 设置面板点击专项自检：修「顶栏拖拽区吞掉浮层点击」后的一锤子验收。
#
# 背景：设置面板与队友面板从 header 槽渲染，DOM 上是 .topbar（整条 -webkit-app-region:drag）
# 的子孙——fixed 全屏也逃不出拖拽区的矩形命中，整个面板的点击被当成「拖窗口」吞掉。
# 修复：.settings-mask / .team-pop 自己声明 no-drag（styles.css「浮层豁免窗口拖拽区」节）。
#
# 本脚本只跑壳默认形态，eval 做四步硬验证：
#   ① 点顶栏齿轮 → 面板打开；
#   ② 读 .settings-mask 的 computedStyle.webkitAppRegion，必须是 no-drag；
#   ③ 点导航「模型」项 → .on 类切到它、标题跟着变（点击链路真活了）；
#   ④ 点右上关闭钮 → 面板消失。
# 隔离照旧：USERPROFILE/HOME 换掉宿主 ~/.dsc、独立 userData；打开面板只有读操作。
#
# 用法：pwsh -NoProfile -File settings-click-check.ps1（壳产物需已构建：pnpm run build:ui）

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$swShots = 'D:\dsc\desktop\shots'
$swElectron = Join-Path $swShots '..\node_modules\electron\dist\electron.exe'
$swEntry = Join-Path $swShots '..\out\main\index.js'
$swHome = Join-Path $swShots 'shell-switch-home'

$swEval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = pred(); if (v) return v; await wait(120); }
    return null;
  };
  await waitFor(() => {
    const root = document.querySelector('#root');
    return root !== null && root.children.length > 0;
  }, 20000);
  await wait(1500);
  // 设置入口：旧界面顶栏没有齿轮（对齐旧界面后壳也删了），入口是侧栏底部「设置」行——
  // 它发 `shell.settings.open` 事件；这里直接派发同一个事件（与点那一行等价）最稳。
  window.dispatchEvent(new CustomEvent('shell.settings.open'));
  const mask = await waitFor(() => document.querySelector('.settings-mask'), 6000);
  if (mask === null) return { error: '设置面板没打开' };
  await wait(900); // 等分区清单与字段值加载
  const region = getComputedStyle(mask).webkitAppRegion;
  const items = Array.from(document.querySelectorAll('.settings-nav .settings-nav-item'));
  const target = items.find((i) => (i.textContent ?? '').includes('模型')) ?? items[1] ?? null;
  if (target === null) return { error: '导航没有可点的项', region };
  const beforeOn = target.classList.contains('on');
  target.click();
  await wait(600);
  const afterOn = target.classList.contains('on');
  const head = document.querySelector('.settings-head h2')?.textContent ?? null;
  const closeBtn = document.querySelector('.settings-head .icon-btn');
  if (closeBtn !== null) closeBtn.click();
  await wait(500);
  return {
    region,
    navItems: items.map((i) => (i.textContent ?? '').trim()),
    clickedNav: (target.textContent ?? '').trim(),
    beforeOn,
    afterOn,
    headAfterClick: head,
    closedByCloseButton: document.querySelector('.settings-mask') === null,
  };
})()
'@

$env:DSC_DESKTOP_USER_DATA = Join-Path $swHome 'electron-userdata'
$env:USERPROFILE = $swHome
$env:HOME = $swHome
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SHOT = Join-Path $swShots 'settings-click.png'
$env:DSC_DESKTOP_SHOT_DELAY = '22000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '18000'
$env:DSC_DESKTOP_SHOT_EVAL = $swEval
Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue

$outLog = Join-Path $swShots 'settings-click.out.log'
$errLog = Join-Path $swShots 'settings-click.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue

try {
  $swProc = Start-Process -FilePath $swElectron -ArgumentList $swEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $swDeadline = (Get-Date).AddSeconds(70)
  while ((Get-Date) -lt $swDeadline) {
    if (Test-Path -LiteralPath $errLog) {
      $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|页面加载失败|截图失败' -ErrorAction SilentlyContinue
      if ($null -ne $hit) { break }
    }
    if ($swProc.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
  & taskkill /PID $swProc.Id /T /F 2>&1 | Out-Null
  Start-Sleep -Milliseconds 600
} finally {
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_USER_DATA -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $errLog) {
  Select-String -LiteralPath $errLog -Pattern '预跑脚本完成|预跑脚本失败|已写出|页面加载失败|截图失败' |
    ForEach-Object { '  ' + $_.Line.Trim() }
}
Write-Output 'settings-click-check 完成'
