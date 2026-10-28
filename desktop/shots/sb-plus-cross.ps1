# 「在此新建会话」跨工作区自检：先从 D:\dsc 切回 C:\Windows\System32，
# 再点 dsc 行上的「+」，验证「先切目录、切过来之后才建会话」这条链路真的成立。
$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$home2 = Join-Path $shots 'sb-home'

$env:DSC_DESKTOP_USER_DATA = Join-Path $shots 'sb-udata'
$env:USERPROFILE = $home2
$env:DSC_HOME = Join-Path $home2 '.dsc'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_RESUME_SESSION = Join-Path $home2 '.dsc\sessions\D-dsc\ca1de16f-1aa7-4514-bddb-2ca1a9940795.jsonl'
$env:DSC_DESKTOP_SHOT = Join-Path $shots 'sb-05-plus-cross.png'
$env:DSC_DESKTOP_SHOT_DELAY = '42000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '36000'

$env:DSC_DESKTOP_SHOT_EVAL = @'
(async () => {
  document.documentElement.style.setProperty('--dsc-dur', '0ms');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rowOf = (name) => Array.from(document.querySelectorAll('.group-row')).find((el) => el.querySelector('.dir').textContent === name);
  const snap = () => ({
    active: (document.querySelector('.group-row.active .dir') || {}).textContent || '',
    cwd: (document.querySelector('.sidebar-footer .dir') || {}).textContent || '',
    sid: ((document.querySelector('.seg-turn .ctx-trigger') || {}).title || '').match(/会话 (\w+)/)?.[1] || '',
    welcome: !!document.querySelector('.welcome'),
    title: (document.querySelector('.topbar .title') || {}).textContent || '',
    rows: Array.from(document.querySelectorAll('.group-row')).map((el) => el.querySelector('.dir').textContent + '=' + el.querySelector('.count').textContent),
  });
  await wait(2500);
  const start = snap();
  // 1) 点 System32 那一行 = 切工作区（宿主重启），等它切完
  rowOf('System32').click();
  await wait(9000);
  const switched = snap();
  // 2) 再点 dsc 行上的「+」：应当先切回 D:\dsc，切过来之后才建新会话
  const plus = rowOf('dsc').querySelector('.row-tail .row-actions button');
  plus.click();
  await wait(14000);
  return { start: start, afterSwitchToSystem32: switched, afterPlus: snap(), plusTitle: plus.title };
})()
'@

$log = Join-Path $shots 'sb-plus-cross.log'
& $electron 'out\main\index.js' *>&1 | Out-File -FilePath $log -Encoding utf8
Select-String -Path $log -Pattern 'selfcheck' | ForEach-Object { $_.Line }
