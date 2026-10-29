# 默认列宽读数：不预置任何宽度，看「没拖过」时正文列有多宽。
#
# 会话数据用 ui-seed.mjs 造（两轮消息），所以量到的是有消息时的列宽，
# 不是空会话那条放宽的 720px。窗口用默认 1440×940（临时 HOME，没有窗口记忆）。
#
# 用法：pwsh -NoProfile -File thread-width-shot.ps1            # 开发态（electron + out/main）
#       pwsh -NoProfile -File thread-width-shot.ps1 -Packaged # 打包件（desktop/dist/win-unpacked/Pneuma.exe）
# 产物：desktop/shots/thread-width.png（读数在 stderr 的「预跑脚本完成」那行）
param([switch]$Packaged)

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$tw = 'D:\dsc\desktop\shots'
$twElectron = Join-Path $tw '..\node_modules\electron\dist\electron.exe'
$twEntry = Join-Path $tw '..\out\main\index.js'
$twHome = Join-Path $tw 'ui-home'
# -Packaged 时直接跑装好的 exe（不再把 out/main/index.js 当参数传）。
$twExe = if ($Packaged) { Join-Path $tw '..\dist\win-unpacked\Pneuma.exe' } else { $twElectron }
$twArgs = if ($Packaged) { @() } else { @($twEntry) }

$twEval = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await pred(); if (v) return v; await wait(120); }
  return null;
};
(async () => {
  const app = await waitFor(() => document.querySelector('.app'), 25000);
  if (app === null) return { error: '界面没起来', body: document.body.innerText.slice(0, 200) };
  await wait(3000);
  const measure = () => {
    const inner = document.querySelector('.chat-inner');
    const bar = document.querySelector('.composer-bar');
    const style = inner === null ? null : getComputedStyle(inner);
    return {
      chatInnerWidth: inner === null ? null : Math.round(inner.getBoundingClientRect().width),
      chatInnerMaxWidth: style === null ? null : style.maxWidth,
      composerWidth: bar === null ? null : Math.round(bar.getBoundingClientRect().width),
    };
  };
  // 先量空会话（首屏 720px），再点开种子里的那条会话，量「有消息时」的默认列宽。
  const emptyState = document.querySelector('.thread-main-empty') !== null;
  const emptyWidth = emptyState ? measure().chatInnerWidth : null;
  const row = await waitFor(() => document.querySelector('.sess-item'), 8000);
  if (row !== null) {
    row.click();
    await waitFor(() => document.querySelector('.thread-main-empty') === null, 8000);
    await wait(2000);
  }
  const out = {
    win: [window.innerWidth, window.innerHeight],
    emptyState,
    emptyWidth,
    withMessages: measure(),
    rootVar: getComputedStyle(document.documentElement).getPropertyValue('--dsc-thread-max').trim(),
    bodyFont: getComputedStyle(document.body).fontSize,
    localStorageThread: window.localStorage.getItem('dsc.threadWidth'),
    href: location.href,
  };
  return out;
})()
'@

node (Join-Path $tw 'ui-seed.mjs') | Out-Null

try {
  $env:DSC_DESKTOP_USER_DATA = Join-Path $twHome 'electron-userdata'
  $env:USERPROFILE = $twHome
  $env:HOME = $twHome
  $env:DSC_HOME = Join-Path $twHome '.dsc'
  $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
  $env:DSC_DESKTOP_SHOT = Join-Path $tw 'thread-width.png'
  $env:DSC_DESKTOP_SHOT_DELAY = '40000'
  $env:DSC_DESKTOP_SHOT_EVAL_LEAD = '14000'
  $env:DSC_DESKTOP_SHOT_EVAL = $twEval
  Remove-Item Env:DSC_DESKTOP_SEARCH, Env:DSC_RESUME_SESSION -ErrorAction SilentlyContinue

  $twOut = Join-Path $tw 'thread-width.out.log'
  $twErr = Join-Path $tw 'thread-width.err.log'
  Remove-Item -LiteralPath $twOut, $twErr -ErrorAction SilentlyContinue

  $twProc = Start-Process -FilePath $twExe -ArgumentList $twArgs -PassThru -RedirectStandardOutput $twOut -RedirectStandardError $twErr
  $twDeadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $twDeadline) {
    if ($twProc.HasExited) { break }
    if (Test-Path -LiteralPath $twErr) {
      $hit = Select-String -LiteralPath $twErr -Pattern '已写出|截图超时|截图失败' -ErrorAction SilentlyContinue
      if ($null -ne $hit) { Write-Output ('  ' + $hit[0].Line); break }
    }
    Start-Sleep -Milliseconds 400
  }
  & taskkill /PID $twProc.Id /T /F 2>&1 | Out-Null
  Start-Sleep -Milliseconds 600
  if (Test-Path -LiteralPath $twErr) {
    Select-String -LiteralPath $twErr -Pattern '预跑脚本完成|预跑脚本失败' -ErrorAction SilentlyContinue |
      ForEach-Object { '  ' + $_.Line }
  }
} finally {
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_SEARCH,
    Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_USER_DATA, Env:DSC_HOME -ErrorAction SilentlyContinue
}
