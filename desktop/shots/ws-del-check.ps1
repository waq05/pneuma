# 删除工作区走查（0.6.45）：组菜单「删除工作区」对空组也出现，确认框分「有会话/无会话」两档文案。
#
# 无污染约束（同 ws-add-check）：
#   - 不走 switchCwd / 不确认删除——确认框只点「取消」。点确认会调 dsc:remove-recent-cwd，
#     而主进程 desktop.json（lastCwd/recentCwds）走 Electron os.homedir()，落在真实 HOME
#     不吃 USERPROFILE 覆盖（0.6.44 实测污染过一次已还原）。归档会话写的是 sound-home
#     隔离库无害，但没必要，一律取消收场。
#   - 本实例会镜像真实 desktop.json 的 recentCwds 为空组（只读），正好当空组测试样本。
#
# 断言：
#   ① 空组（0 会话）的 ··· 菜单里有「删除工作区」，且没有「归档这 N 个会话」；
#      确认框标题「删除工作区「…」？」、说明含「还没有会话」
#   ② 有会话组的菜单同样是「删除工作区」；确认框说明含「全部归档」与「恢复」
#   ③ 两个确认框都点「取消」收场，弹层关闭；最后把空组菜单留着打开供截图目检
#
# 用法（先在 desktop/ 跑 `pnpm run build`）：
#   pwsh -NoProfile -File ws-del-check.ps1

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
  const results = { case: 'ws-del-check' };
  try {
    await waitFor(() => document.querySelector('.group-row'), 20000);
    await wait(800);

    const rows = () => [...document.querySelectorAll('.group-row')];
    const itemCount = (row) => {
      const m = (row.getAttribute('data-tip') || '').match(/· (\d+) 个会话/);
      return m === null ? -1 : Number(m[1]);
    };
    const dirName = (row) => { const el = row.querySelector('.dir'); return el === null ? null : el.textContent; };
    const openMenu = async (row) => {
      const more = row.querySelector('.icon-btn[data-tip="更多操作"]');
      if (more === null) return null;
      more.click();
      return await waitFor(() => document.querySelector('.row-menu'), 3000);
    };
    const menuItems = () => [...document.querySelectorAll('.row-menu .menu-item')].map((el) => el.textContent.trim());
    const clickDelete = () => {
      const item = [...document.querySelectorAll('.row-menu .menu-item')].find((el) => el.textContent.trim() === '删除工作区');
      if (item === undefined) return false;
      item.click();
      return true;
    };
    const readAndCancel = async () => {
      const dlg = await waitFor(() => document.querySelector('.dsc-confirm'), 3000);
      if (dlg === null) return null;
      const titleEl = dlg.querySelector('.dsc-confirm__title');
      const detailEl = dlg.querySelector('.dsc-confirm__detail');
      const title = titleEl === null ? '' : titleEl.textContent;
      const detail = detailEl === null ? '' : detailEl.textContent;
      const cancel = [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === '取消');
      if (cancel !== undefined) cancel.click();
      const gone = await waitFor(() => (document.querySelector('.dsc-confirm') === null ? true : null), 3000);
      return { title, detail, closed: gone === true };
    };

    // ① 空组：菜单有「删除工作区」、没有「归档这 N 个会话」；确认框说「还没有会话」
    const emptyRow = rows().find((row) => itemCount(row) === 0);
    if (emptyRow === undefined) { results.error = '没有空组可测（recentCwds 空目录组缺失）'; return { ...results, ms: Date.now() - started }; }
    results.empty = { name: dirName(emptyRow) };
    if (await openMenu(emptyRow) === null) { results.error = '空组菜单没打开'; return { ...results, ms: Date.now() - started }; }
    results.empty.menu = menuItems();
    results.empty.hasDelete = results.empty.menu.includes('删除工作区');
    results.empty.noArchiveAll = !results.empty.menu.some((t) => t.startsWith('归档这'));
    if (!clickDelete()) { results.error = '空组菜单里没有「删除工作区」'; return { ...results, ms: Date.now() - started }; }
    results.empty.dialog = await readAndCancel();

    // ② 有会话组：确认框说清「全部归档、可恢复」
    const fullRow = rows().find((row) => itemCount(row) > 0);
    if (fullRow === undefined) { results.error = '没有含会话的组可测'; return { ...results, ms: Date.now() - started }; }
    results.full = { name: dirName(fullRow), count: itemCount(fullRow) };
    if (await openMenu(fullRow) === null) { results.error = '有会话组的菜单没打开'; return { ...results, ms: Date.now() - started }; }
    results.full.menu = menuItems();
    if (!clickDelete()) { results.error = '有会话组菜单里没有「删除工作区」'; return { ...results, ms: Date.now() - started }; }
    results.full.dialog = await readAndCancel();

    // ③ 收尾把空组菜单留着打开，截图里能看到「删除工作区」项
    results.finalMenuOpen = (await openMenu(emptyRow)) !== null;
    return { ...results, ms: Date.now() - started };
  } catch (error) {
    return { ...results, error: String(error), ms: Date.now() - started };
  }
})()
'@

$env:DSC_DESKTOP_USER_DATA = Join-Path $waHome 'electron-userdata'
$env:USERPROFILE = $waHome
$env:HOME = $waHome
$env:SOUND_FAKE_KEY = 'e2e-fake-key'
$env:DSC_DESKTOP_SHOT = Join-Path $wa 'ws-del-check.png'
$env:DSC_DESKTOP_SHOT_DELAY = '30000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '15000'
$env:DSC_DESKTOP_SHOT_EVAL = $waEval
Remove-Item Env:DSC_DESKTOP_SHOT_TOPMOST -ErrorAction SilentlyContinue
Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue

$outLog = Join-Path $wa 'ws-del-check.out.log'
$errLog = Join-Path $wa 'ws-del-check.err.log'
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
