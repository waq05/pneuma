# composer 位置修复走查（0.6.42）：空会话居中、非空贴底、长内容内滚三断言。
#
#   ① 空态（thread-main-empty）：引导 + 输入框组垂直居中（组的几何中心 ≈ 视口中点）
#   ② 非空态：点侧栏会话行切到有内容的会话 → composer-zone 贴 thread-main 底缘
#   ③ 长内容：往 .chat-inner 注入假条目 → composer 纹丝不动（仍在底部）、.chat 自己滚
#
# 复用 sound-home（有历史会话）。用法（先在 desktop/ 跑 `pnpm run build`）：
#   pwsh -NoProfile -File composer-check.ps1

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$cc = 'D:\dsc\desktop\shots'
$ccElectron = Join-Path $cc '..\node_modules\electron\dist\electron.exe'
$ccEntry = Join-Path $cc '..\out\main\index.js'
$ccHome = Join-Path $cc 'sound-home'

$ccEval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = await pred(); if (v) return v; await wait(120); }
    return null;
  };
  const started = Date.now();
  try {
    await waitFor(() => document.querySelector('.composer-zone'), 20000);
    await wait(1000);
    const results = { case: 'composer-check', innerHeight: window.innerHeight };

    // ① 空态居中：组 = welcome 顶到 composer 底；中心点应对准视口中点（±40px）
    const emptyMain = document.querySelector('.thread-main');
    if (emptyMain === null) return { case: 'composer-check', error: 'thread-main 没找到', ms: Date.now() - started };
    const isEmpty = emptyMain.className.includes('thread-main-empty');
    if (isEmpty) {
      const welcome = document.querySelector('.welcome');
      const cz = document.querySelector('.composer-zone').getBoundingClientRect();
      const top = welcome === null ? cz.top : welcome.getBoundingClientRect().top;
      const center = (top + cz.bottom) / 2;
      const viewportCenter = window.innerHeight / 2;
      results.emptyState = {
        isEmpty,
        groupCenter: Math.round(center),
        viewportCenter: Math.round(viewportCenter),
        centeredOk: Math.abs(center - viewportCenter) <= 60,
      };
    } else {
      results.emptyState = { isEmpty, note: '启动即非空会话，空态跳过（切走再切回可复验）' };
    }

    // ② 非空贴底：点第一个会话行切过去，等 ChatView 挂载
    const row = document.querySelector('.sess-item');
    if (row === null) return { ...results, error: '会话行没找到', ms: Date.now() - started };
    row.click();
    const chatWrap = await waitFor(() => document.querySelector('.chat-wrap'), 8000);
    if (chatWrap === null) return { ...results, error: '切会话后 chat-wrap 没挂载', ms: Date.now() - started };
    await wait(800);
    const main = document.querySelector('.thread-main');
    const cz2 = document.querySelector('.composer-zone').getBoundingClientRect();
    const mainR = main.getBoundingClientRect();
    const chat = document.querySelector('.chat');
    results.activeState = {
      composerBottom: Math.round(cz2.bottom),
      mainBottom: Math.round(mainR.bottom),
      pinnedOk: Math.abs(cz2.bottom - mainR.bottom) <= 2,
      chatScrollsNatively: chat !== null && chat.scrollHeight > chat.clientHeight,
      chatOverflow: chat === null ? null : { sh: chat.scrollHeight, h: chat.clientHeight },
    };

    // ③ 长内容内滚：composer 纹丝不动，.chat 变可滚
    const before = Math.round(document.querySelector('.composer-zone').getBoundingClientRect().bottom);
    const inner = document.querySelector('.chat-inner');
    if (inner !== null) {
      for (let i = 0; i < 30; i += 1) {
        const ghost = document.createElement('div');
        ghost.dataset.diagFill = '1';
        ghost.style.height = '90px';
        ghost.textContent = 'diag';
        inner.appendChild(ghost);
      }
      await wait(300);
      const afterR = document.querySelector('.composer-zone').getBoundingClientRect();
      const chatAfter = document.querySelector('.chat');
      results.longContent = {
        composerBefore: before,
        composerAfter: Math.round(afterR.bottom),
        composerStable: Math.abs(Math.round(afterR.bottom) - before) <= 2,
        chatScrollHeight: chatAfter === null ? null : chatAfter.scrollHeight,
        chatClientHeight: chatAfter === null ? null : chatAfter.clientHeight,
      };
      Array.from(inner.querySelectorAll('[data-diag-fill]')).forEach((el) => el.remove());
    }
    return { ...results, ms: Date.now() - started };
  } catch (error) {
    return { case: 'composer-check', error: String(error), ms: Date.now() - started };
  }
})()
'@

$env:DSC_DESKTOP_USER_DATA = Join-Path $ccHome 'electron-userdata'
$env:USERPROFILE = $ccHome
$env:HOME = $ccHome
$env:SOUND_FAKE_KEY = 'e2e-fake-key'
$env:DSC_DESKTOP_SHOT = Join-Path $cc 'composer-check.png'
$env:DSC_DESKTOP_SHOT_DELAY = '30000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '15000'
$env:DSC_DESKTOP_SHOT_EVAL = $ccEval
Remove-Item Env:DSC_DESKTOP_SHOT_TOPMOST -ErrorAction SilentlyContinue
Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue

$outLog = Join-Path $cc 'composer-check.out.log'
$errLog = Join-Path $cc 'composer-check.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $ccElectron -ArgumentList $ccEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
$deadline = (Get-Date).AddSeconds(55)
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
