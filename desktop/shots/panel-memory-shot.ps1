# 面板宽度回灌截图/读数：把 settings.json 里预置一份宽度，看真界面首帧用的是不是它。
#
# 复现的是用户报障那条路：宿主换端口 → localStorage 是空的 → 宽度只能从 settings.json 来。
# 这里直接把 localStorage 当空的（每台机器首次运行就是这样），只靠 settings.json 里预置的
# ui.panelWidths 看侧栏与右侧栏有没有落在预置值上。
#
# 用法：pwsh -NoProfile -File panel-memory-shot.ps1
# 产物：desktop/shots/panel-memory.png（读数在 stderr 的「预跑脚本完成」那行）
$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$pm = 'D:\dsc\desktop\shots'
$pmElectron = Join-Path $pm '..\node_modules\electron\dist\electron.exe'
$pmEntry = Join-Path $pm '..\out\main\index.js'
$pmHome = Join-Path $pm 'ui-home'

$pmEval = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await pred(); if (v) return v; await wait(120); }
  return null;
};
(async () => {
  const app = await waitFor(() => document.querySelector('.app'), 25000);
  if (app === null) return { error: '界面没起来', body: document.body.innerText.slice(0, 200) };
  await wait(2500);
  const aside = document.querySelector('aside.sidebar');
  const dock = document.querySelector('.dock');
  const out = {
    sidebar: aside === null ? null : Math.round(aside.getBoundingClientRect().width),
    dock: dock === null ? null : Math.round(dock.getBoundingClientRect().width),
    sidebarVar: getComputedStyle(document.documentElement).getPropertyValue('--dsc-sidebar-w').trim(),
    localStorageSidebar: window.localStorage.getItem('dsc.sidebarWidth'),
    localStorageDock: window.localStorage.getItem('dsc.dockWidth'),
    href: location.href,
  };
  return out;
})()
'@

node (Join-Path $pm 'ui-seed.mjs') | Out-Null

# 预置一份几何（模拟「上次拖过、宿主已经写过 settings.json」）。
$pmSettings = Join-Path $pmHome '.dsc\settings.json'
$pmJson = Get-Content -LiteralPath $pmSettings -Raw | ConvertFrom-Json
if ($null -eq $pmJson.ui) { $pmJson | Add-Member -NotePropertyName ui -NotePropertyValue ([pscustomobject]@{}) }
$pmJson.ui | Add-Member -NotePropertyName panelWidths -NotePropertyValue ([pscustomobject]@{ sidebar = 320; dock = 640 }) -Force
$pmJson | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $pmSettings -Encoding utf8

try {
  $env:DSC_DESKTOP_USER_DATA = Join-Path $pmHome 'electron-userdata'
  $env:USERPROFILE = $pmHome
  $env:HOME = $pmHome
  # 主进程与宿主都认这一个：两边读同一份 settings.json（主题与面板几何都要它）。
  $env:DSC_HOME = Join-Path $pmHome '.dsc'
  $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
  $env:DSC_DESKTOP_SHOT = Join-Path $pm 'panel-memory.png'
  $env:DSC_DESKTOP_SHOT_DELAY = '40000'
  $env:DSC_DESKTOP_SHOT_EVAL_LEAD = '14000'
  $env:DSC_DESKTOP_SHOT_EVAL = $pmEval
  Remove-Item Env:DSC_DESKTOP_SEARCH, Env:DSC_RESUME_SESSION -ErrorAction SilentlyContinue

  $pmOut = Join-Path $pm 'panel-memory.out.log'
  $pmErr = Join-Path $pm 'panel-memory.err.log'
  Remove-Item -LiteralPath $pmOut, $pmErr -ErrorAction SilentlyContinue

  $pmProc = Start-Process -FilePath $pmElectron -ArgumentList $pmEntry -PassThru -RedirectStandardOutput $pmOut -RedirectStandardError $pmErr
  $pmDeadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $pmDeadline) {
    if ($pmProc.HasExited) { break }
    if (Test-Path -LiteralPath $pmErr) {
      $hit = Select-String -LiteralPath $pmErr -Pattern '已写出|截图超时|截图失败' -ErrorAction SilentlyContinue
      if ($null -ne $hit) { Write-Output ('  ' + $hit[0].Line); break }
    }
    Start-Sleep -Milliseconds 400
  }
  & taskkill /PID $pmProc.Id /T /F 2>&1 | Out-Null
  Start-Sleep -Milliseconds 600
  if (Test-Path -LiteralPath $pmErr) {
    Select-String -LiteralPath $pmErr -Pattern '预跑脚本完成|预跑脚本失败' -ErrorAction SilentlyContinue |
      ForEach-Object { '  ' + $_.Line }
  }
} finally {
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_SEARCH,
    Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_USER_DATA, Env:DSC_HOME -ErrorAction SilentlyContinue
}
