# composer 位置诊断（0.6.42 前置）：量 .thread-main/.chat-wrap/.chat/.composer-zone 的
# 真实布局（display/height/overflow/rect/scroll），确认滚动容器与输入框的实际位置行为。
# 复用 sound-home（有历史会话，非空态）。
#   pwsh -NoProfile -File composer-diag.ps1

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$cd0 = 'D:\dsc\desktop\shots'
$cd0Electron = Join-Path $cd0 '..\node_modules\electron\dist\electron.exe'
$cd0Entry = Join-Path $cd0 '..\out\main\index.js'
$cd0Home = Join-Path $cd0 'sound-home'

$cd0Eval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = await pred(); if (v) return v; await wait(120); }
    return null;
  };
  await waitFor(() => document.querySelector('.composer-zone'), 20000);
  await wait(800);
  const probe = (sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      display: cs.display, overflowY: cs.overflowY, flex: cs.flex,
      rectTop: Math.round(r.top), rectBottom: Math.round(r.bottom),
      offsetHeight: el.offsetHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop,
    };
  };
  // 布局探针：往 thread-main 里注入假内容模拟「非空会话」的三种内容量，
  // 量 composer-zone 的位置与滚动容器的行为（React 重渲染会抹掉注入节点）。
  const main = document.querySelector('.thread-main');
  // composer-zone 留在原地（它是量的主角）；只移走 Welcome/ChatView 等内容节点
  const savedChildren = Array.from(main.children).filter((el) => !el.classList.contains('composer-zone'));
  savedChildren.forEach((el) => el.remove());
  const composerZone = document.querySelector('.composer-zone');
  const fill = (n) => {
    Array.from(main.querySelectorAll('[data-diag-fill]')).forEach((el) => el.remove());
    for (let i = 0; i < n; i += 1) {
      const row = document.createElement('div');
      row.dataset.diagFill = '1';
      row.style.height = '90px';
      row.style.flex = 'none';
      main.insertBefore(row, composerZone);
    }
  };
  const snap = (tag) => {
    const chat = document.querySelector('.chat');
    const cz = document.querySelector('.composer-zone').getBoundingClientRect();
    return {
      tag,
      composerTop: Math.round(cz.top),
      composerBottom: Math.round(cz.bottom),
      composerPinned: Math.round(cz.bottom) <= window.innerHeight + 1,
      chatScroll: chat === null ? null : { sh: chat.scrollHeight, st: chat.scrollTop, h: chat.clientHeight },
      mainScroll: { sh: main.scrollHeight, st: main.scrollTop, h: main.clientHeight },
    };
  };
  const results = { case: 'composer-diag', innerHeight: window.innerHeight, welcomeOn: document.querySelector('.welcome') !== null };
  fill(1); await wait(250);
  results.short = snap('short-1row');
  fill(12); await wait(250);
  results.mid = snap('mid-12rows');
  fill(40); await wait(250);
  results.long = snap('long-40rows');
  const chat = document.querySelector('.chat');
  if (chat !== null) chat.scrollTop = chat.scrollHeight;
  await wait(250);
  results.longScrolled = snap('long-scrolled-bottom');
  savedChildren.forEach((el) => main.appendChild(el));
  Array.from(main.querySelectorAll('[data-diag-fill]')).forEach((el) => el.remove());
  return results;
})()
'@

$env:DSC_DESKTOP_USER_DATA = Join-Path $cd0Home 'electron-userdata'
$env:USERPROFILE = $cd0Home
$env:HOME = $cd0Home
$env:SOUND_FAKE_KEY = 'e2e-fake-key'
$env:DSC_DESKTOP_SHOT = Join-Path $cd0 'composer-diag.png'
$env:DSC_DESKTOP_SHOT_DELAY = '30000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '15000'
$env:DSC_DESKTOP_SHOT_EVAL = $cd0Eval
Remove-Item Env:DSC_DESKTOP_SHOT_TOPMOST -ErrorAction SilentlyContinue
Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue

$outLog = Join-Path $cd0 'composer-diag.out.log'
$errLog = Join-Path $cd0 'composer-diag.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $cd0Electron -ArgumentList $cd0Entry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
$deadline = (Get-Date).AddSeconds(40)
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
Write-Output '诊断完成'
