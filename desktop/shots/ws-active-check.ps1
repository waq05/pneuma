# 工作区图标 active 走查（0.6.43）：组行 active 跟选中会话所属组走（dsh containsCurrent）。
#
#   ① 跨组点会话：点非 active 组（C:\Users\waq 假会话）下的会话行 → 该组图标点亮
#   ② 新会话回落：点「新会话」→ activeSessionId 为 null → active 回落宿主 cwd 组
#      （宿主 cwd = 实际进程目录，走查里把它打印出来人工核对；若 cwd 组不在列表里，
#       没有任何组亮也算对——回落值没匹配到可见组）
#
# sound-home 里预先塞了一条 C-Users-waq 假会话（.dsc/sessions/C-Users-waq/，本走查的
# 固定依赖，保留别删——删了①就没有第二个组可点）。用法（先在 desktop/ 跑 `pnpm run build`）：
#   pwsh -NoProfile -File ws-active-check.ps1

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$wa = 'D:\dsc\desktop\shots'
$waElectron = Join-Path $wa '..\node_modules\electron\dist\electron.exe'
$waEntry = Join-Path $wa '..\out\main\index.js'
$waHome = Join-Path $wa 'sound-home'

$waEval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = await pred(); if (v) return v; await wait(120); }
    return null;
  };
  const started = Date.now();
  try {
    await waitFor(() => document.querySelector('.group-row'), 20000);
    await wait(1200);
    const groupName = (row) => row === null ? null : (row.querySelector('.dir')?.textContent ?? '').trim();
    const activeRow = () => document.querySelector('.group-row.active');
    const iconColor = (row) => row === null ? null : getComputedStyle(row.querySelector('.folder-icon')).color;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--dsc-accent').trim();
    const results = { case: 'ws-active-check' };

    const before = activeRow();
    results.initial = { group: groupName(before), icon: iconColor(before) };

    // ① 跨组点会话：找一个非 active 且有会话的组（收着就先展开），点它第一条会话
    const groups = [...document.querySelectorAll('.group')];
    let target = null;
    for (const g of groups) {
      const row = g.querySelector('.group-row');
      if (row === null || row.classList.contains('active')) continue;
      if (row.getAttribute('aria-expanded') === 'false') { row.click(); await wait(500); }
      const item = g.querySelector('.sess-item');
      if (item !== null) { target = { row, item }; break; }
    }
    if (target === null) return { ...results, error: '没有第二个带可见会话的组', ms: Date.now() - started };
    const targetName = groupName(target.row);
    target.item.click();
    const chatWrap = await waitFor(() => document.querySelector('.chat-wrap'), 8000);
    await wait(600);
    const now = activeRow();
    results.crossGroup = {
      clickedGroup: targetName,
      activeGroup: groupName(now),
      activeOk: groupName(now) === targetName,
      icon: iconColor(now),
      iconIsAccent: iconColor(now) !== null && accent !== '' && iconColor(now) === accent,
      chatMounted: chatWrap !== null,
    };

    // ② 新会话回落宿主 cwd：active 行消失（cwd 无组）或换成 cwd 组都算对，打印 tip 人工核对
    document.querySelector('.btn-new')?.click();
    await wait(1200);
    const fresh = activeRow();
    results.newSession = {
      activeGroup: groupName(fresh),
      cwdFromTip: fresh === null ? null : (fresh.getAttribute('data-tip') ?? '').split(' · ')[0],
      leftClickedGroup: groupName(fresh) !== targetName,
    };
    return { ...results, ms: Date.now() - started };
  } catch (error) {
    return { case: 'ws-active-check', error: String(error), ms: Date.now() - started };
  }
})()
'@

$env:DSC_DESKTOP_USER_DATA = Join-Path $waHome 'electron-userdata'
$env:USERPROFILE = $waHome
$env:HOME = $waHome
$env:SOUND_FAKE_KEY = 'e2e-fake-key'
$env:DSC_DESKTOP_SHOT = Join-Path $wa 'ws-active-check.png'
$env:DSC_DESKTOP_SHOT_DELAY = '30000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '15000'
$env:DSC_DESKTOP_SHOT_EVAL = $waEval
Remove-Item Env:DSC_DESKTOP_SHOT_TOPMOST -ErrorAction SilentlyContinue
Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue

$outLog = Join-Path $wa 'ws-active-check.out.log'
$errLog = Join-Path $wa 'ws-active-check.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $waElectron -ArgumentList $waEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
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
