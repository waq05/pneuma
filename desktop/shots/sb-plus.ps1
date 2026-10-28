# 「在此新建会话」的功能自检：点非活动工作区行上的那枚「+」，
# 验证 (1) 工作目录真的切过去了、(2) 新会话落在那份隔离 home 的对应目录下。
# 宿主重启 + 建会话都在隔离 home 里发生，不碰用户的 ~/.dsc。
$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$home2 = Join-Path $shots 'sb-home'
$sessDir = Join-Path $home2 '.dsc\sessions\D-dsc'

$before = Get-ChildItem $sessDir -File | Select-Object -ExpandProperty Name
Write-Output "点之前 D-dsc 下的会话数=$($before.Count)"

$env:DSC_DESKTOP_USER_DATA = Join-Path $shots 'sb-udata'
$env:USERPROFILE = $home2
$env:DSC_HOME = Join-Path $home2 '.dsc'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_RESUME_SESSION = Join-Path $home2 '.dsc\sessions\D-dsc\ca1de16f-1aa7-4514-bddb-2ca1a9940795.jsonl'
$env:DSC_DESKTOP_SHOT = Join-Path $shots 'sb-04-plus-new.png'
$env:DSC_DESKTOP_SHOT_DELAY = '26000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '20000'

$env:DSC_DESKTOP_SHOT_EVAL = @'
(async () => {
  document.documentElement.style.setProperty('--dsc-dur', '0ms');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = () => Array.from(document.querySelectorAll('.group-row')).map((el) => el.querySelector('.dir').textContent + '=' + el.querySelector('.count').textContent);
  const snap = () => ({
    rows: rows(),
    active: (document.querySelector('.group-row.active .dir') || {}).textContent || '',
    cwd: (document.querySelector('.sidebar-footer .dir') || {}).textContent || '',
    // 会话 id 收在第一段的 title 里；新建会话没发消息前不落盘，所以只能看这个
    sid: ((document.querySelector('.seg-turn .ctx-trigger') || {}).title || '').match(/会话 (\w+)/)?.[1] || '',
    welcome: !!document.querySelector('.welcome'),
    title: (document.querySelector('.topbar .title') || {}).textContent || '',
    sidebarActive: Array.from(document.querySelectorAll('.sess-item.active .title')).map((el) => el.textContent),
  });
  await wait(2500);
  const before = snap();
  const target = Array.from(document.querySelectorAll('.group-row')).find((el) => el.querySelector('.dir').textContent === 'dsc');
  if (!target) return { error: '没找到 dsc 工作区行', before };
  const plus = target.querySelector('.row-tail .row-actions button');
  plus.click();
  await wait(15000);
  return { before, after: snap(), plusTitle: plus.title, clicked: true };
})()
'@

$log = Join-Path $shots 'sb-plus.log'
& $electron 'out\main\index.js' *>&1 | Out-File -FilePath $log -Encoding utf8
Select-String -Path $log -Pattern 'selfcheck' | ForEach-Object { $_.Line }

$after = Get-ChildItem $sessDir -File | Select-Object -ExpandProperty Name
$new = $after | Where-Object { $before -notcontains $_ }
Write-Output "点之后 D-dsc 下的会话数=$($after.Count)；新增：$($new -join ',')"
foreach ($n in $new) {
  $head = (Get-Content (Join-Path $sessDir $n) -First 1 | ConvertFrom-Json)
  Write-Output "新会话 $n 的 meta.cwd = $($head.cwd)（应为 D:\dsc）"
}
