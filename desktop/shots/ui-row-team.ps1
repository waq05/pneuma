# 行操作与团队面板实机用例（0.6.39 配套）：
#   ui-row   会话行：行首前置图钉（悬浮浮出、点击置顶后常显染色）、行尾只剩归档一颗钮
#            （图钉/更多按钮退场）、右键唤起贴指针的操作菜单（dock 页签同款）
#   ui-team  智能体团队面板（?team=1 直开）：其它会话的队友两行、点「移除」→ 确认框 →
#            确认后行消失；跑完对账 roster.json 少一条、explorer-1.jsonl 连租约被删
#
# 隔离与指纹照 v1-walkthrough.ps1 同一套（真实 ~/.dsc 跑前跑后聚合 SHA256 比对）。
# 这两个用例不发模型请求，无需假端点。
#
# 用法（先在 desktop/ 跑 `pnpm run build`）：
#   pwsh -NoProfile -File ui-row-team.ps1

param([string]$Only = 'all')

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$urt = 'D:\dsc\desktop\shots'
$urtElectron = Join-Path $urt '..\node_modules\electron\dist\electron.exe'
$urtEntry = Join-Path $urt '..\out\main\index.js'
$urtHome = Join-Path $urt 'ui-home'
$urtRealDsc = Join-Path $env:USERPROFILE '.dsc'

function Get-DirFingerprint([string]$Path) {
  $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Sort-Object FullName)
  $lines = New-Object System.Collections.Generic.List[string]
  $locked = 0
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($Path.Length)
    $hash = 'LOCKED'
    try {
      $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash
    } catch {
      $locked += 1
    }
    $lines.Add("$rel|$($file.Length)|$hash")
  }
  $joined = [string]::Join("`n", $lines)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $digest = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($joined))).Replace('-', '').ToLowerInvariant()
  $contentJoined = [string]::Join("`n", ($lines | ForEach-Object { $parts = $_ -split '\|'; "$($parts[0])|$($parts[2])" }))
  $contentDigest = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($contentJoined))).Replace('-', '').ToLowerInvariant()
  return [pscustomobject]@{ Count = $files.Count; Digest = $digest; ContentDigest = $contentDigest; Locked = $locked; Lines = $lines }
}

$urtEvalHead = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await pred(); if (v) return v; await wait(120); }
  return null;
};
const text = (el) => (el === null || el === undefined ? null : el.textContent.trim());
const all = (sel) => Array.from(document.querySelectorAll(sel));
'@

$urtCases = [ordered]@{
  'ui-row' = @'
(async () => {
  const started = Date.now();
  const rows = await waitFor(() => (all('.sess-item').length >= 2 ? all('.sess-item') : null), 20000);
  if (rows === null) return { case: 'ui-row', error: '会话行不足两条', count: all('.sess-item').length, ms: Date.now() - started };
  await wait(500);
  // 行首前置图钉：每行一个 .lead-pin；行尾只剩一颗操作钮（归档），没有「更多」
  const actionCounts = rows.map((r) => r.querySelectorAll('.row-actions button').length);
  const leadPinCount = rows.filter((r) => r.querySelector('.lead-pin') !== null).length;
  const pinMarkLeft = all('.pin-mark').length;
  const pinHidden = rows.map((r) => { const p = r.querySelector('.lead-pin'); return p === null ? null : getComputedStyle(p).opacity; });
  // 点第二行的图钉 → 置顶：按钮常显染色（.pinned），行进置顶块
  const target = rows[1].querySelector('.lead-pin');
  if (target === null) return { case: 'ui-row', error: '第二行没有前置图钉', ms: Date.now() - started };
  target.click();
  const pinned = await waitFor(() => all('.sess-item').some((r) => r.querySelector('.lead-pin.pinned') !== null), 8000);
  // 右键第一行 → 贴指针的操作菜单（.sess-ctx-menu），项里有分叉与复制 ID
  const row0 = all('.sess-item')[0];
  row0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
  const ctxMenu = await waitFor(() => document.querySelector('.sess-ctx-menu'), 6000);
  const menuText = ctxMenu === null ? null : text(ctxMenu);
  const menuPos = ctxMenu === null ? null : ctxMenu.style.position;
  const backdrop = document.querySelector('.menu-backdrop');
  if (backdrop !== null) backdrop.click();
  await wait(200);
  const menuClosed = document.querySelector('.sess-ctx-menu') === null;
  return {
    case: 'ui-row',
    ms: Date.now() - started,
    theme: document.documentElement.dataset.theme,
    actionCounts, leadPinCount, pinMarkLeft, pinHidden, pinned, menuText, menuPos, menuClosed,
    rowOk: actionCounts.every((n) => n === 1) && leadPinCount === rows.length && pinMarkLeft === 0,
    pinOk: pinned === true,
    menuOk: ctxMenu !== null && menuPos === 'fixed' && (menuText ?? '').includes('分叉会话') && (menuText ?? '').includes('复制会话 ID') && menuClosed,
  };
})()
'@
  'ui-team' = @'
(async () => {
  const started = Date.now();
  // ?team=1 直接开面板；折叠组默认收起，先展开
  const panel = await waitFor(() => document.querySelector('.team-panel'), 15000);
  if (panel === null) return { case: 'ui-team', error: '团队面板没打开', ms: Date.now() - started };
  const toggle = await waitFor(() => document.querySelector('.team-others-toggle'), 8000);
  if (toggle === null) return { case: 'ui-team', error: '没有「其它会话的队友」组', ms: Date.now() - started };
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  const rows = await waitFor(() => (all('.team-others .team-row').length >= 2 ? all('.team-others .team-row') : null), 8000);
  if (rows === null) return { case: 'ui-team', error: '折叠组里不足两行', ms: Date.now() - started };
  const hasRemove = rows.map((r) => [...r.querySelectorAll('.team-acts button')].some((b) => text(b) === '移除'));
  // 点第一行（explorer-1）的移除 → 确认框 → 确认 → 行消失
  const firstRemove = [...rows[0].querySelectorAll('.team-acts button')].find((b) => text(b) === '移除');
  if (firstRemove === undefined) return { case: 'ui-team', error: '第一行没有移除按钮', ms: Date.now() - started };
  firstRemove.click();
  const confirmCard = await waitFor(() => document.querySelector('.dsc-confirm'), 6000);
  if (confirmCard === null) return { case: 'ui-team', error: '确认框没出现', ms: Date.now() - started };
  const confirmText = text(confirmCard.querySelector('.dsc-confirm__detail'));
  const proceed = confirmCard.querySelector('.dsc-confirm__actions .dsc-btn[data-variant="destructive"]');
  if (proceed === null) return { case: 'ui-team', error: '确认框没有破坏性确认钮', ms: Date.now() - started };
  proceed.click();
  const oneLeft = await waitFor(() => all('.team-others .team-row').length === 1, 10000);
  const confirmGone = await waitFor(() => document.querySelector('.dsc-confirm') === null, 6000);
  return {
    case: 'ui-team',
    ms: Date.now() - started,
    theme: document.documentElement.dataset.theme,
    rowCount: rows.length, hasRemove, confirmText,
    oneLeft, confirmGone,
    panelOk: rows.length === 2 && hasRemove.every((v) => v === true),
    removeOk: oneLeft === true && confirmGone === true && (confirmText ?? '').includes('运行记录'),
  };
})()
'@
}

Write-Output '=== 真实 ~/.dsc 跑前指纹 ==='
$urtBefore = Get-DirFingerprint $urtRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 清单聚合 {2} · 内容聚合 {3}" -f $urtBefore.Count, $urtBefore.Locked, $urtBefore.Digest, $urtBefore.ContentDigest)

node (Join-Path $urt 'ui-seed.mjs') | Out-Null
node (Join-Path $urt 'ui-row-team-seed.mjs') | Out-Null

# 会话文件清单（ui-team 用例的对账基准）
$urtRosterFile = Join-Path $urtHome '.dsc\team\roster.json'
$urtMateFile = Join-Path $urtHome '.dsc\sessions\.teammates\explorer-1.jsonl'

$urtSessions = Get-Content (Join-Path $urt 'ui-sessions.json') -Raw | ConvertFrom-Json

try {
  foreach ($name in $urtCases.Keys) {
    if ($Only -ne 'all' -and $Only -ne $name) { continue }

    $env:DSC_DESKTOP_USER_DATA = Join-Path $urtHome 'electron-userdata'
    $env:USERPROFILE = $urtHome
    $env:HOME = $urtHome
    $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
    $env:UI_FAKE_KEY = 'e2e-fake-key'
    if ($name -eq 'ui-row') {
      $env:DSC_RESUME_SESSION = $urtSessions.session
      Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue
    } else {
      Remove-Item Env:DSC_RESUME_SESSION -ErrorAction SilentlyContinue
      # 值不带 ?：主进程把它当 query 接到页面上（?team=1 直开面板）
      $env:DSC_DESKTOP_SEARCH = 'team=1'
    }
    $env:DSC_DESKTOP_SHOT = Join-Path $urt "$name.png"
    $env:DSC_DESKTOP_SHOT_DELAY = '60000'
    $env:DSC_DESKTOP_SHOT_EVAL_LEAD = '45000'
    $env:DSC_DESKTOP_SHOT_EVAL = ($urtEvalHead + $urtCases[$name])

    $outLog = Join-Path $urt "$name.out.log"
    $errLog = Join-Path $urt "$name.err.log"
    Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
    Write-Output "=== $name（隔离目录 $urtHome）==="

    $urtProc = Start-Process -FilePath $urtElectron -ArgumentList $urtEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $urtDeadline = (Get-Date).AddSeconds(140)
    $urtSeen = ''
    while ((Get-Date) -lt $urtDeadline) {
      if ($urtProc.HasExited) { break }
      if (Test-Path -LiteralPath $errLog) {
        $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|截图失败|页面加载失败' -ErrorAction SilentlyContinue
        if ($null -ne $hit) { $urtSeen = $hit[0].Line; break }
      }
      Start-Sleep -Milliseconds 500
    }
    & taskkill /PID $urtProc.Id /T /F 2>&1 | Out-Null
    Start-Sleep -Milliseconds 600
    Write-Output ("  electron 已收工：{0}" -f ($urtSeen -replace '\s+$', ''))

    if (Test-Path -LiteralPath $errLog) {
      Select-String -LiteralPath $errLog -Pattern '预跑脚本完成|预跑脚本失败' -ErrorAction SilentlyContinue |
        ForEach-Object { '  ' + $_.Line }
    }
  }
} finally {
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_SEARCH,
    Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_USER_DATA, Env:UI_FAKE_KEY -ErrorAction SilentlyContinue
}

Write-Output '=== 落盘对账 ==='
$urtRosterAfter = (Get-Content -LiteralPath $urtRosterFile -Raw | ConvertFrom-Json).teammates
Write-Output ("名册剩余条目：{0}（应为 1，且不含 explorer-1）" -f @($urtRosterAfter).Count)
$urtRosterAfter | ForEach-Object { "  - $($_.name)" }
Write-Output ("explorer-1 运行记录已删：{0}" -f (-not (Test-Path -LiteralPath $urtMateFile)))

Write-Output '=== 真实 ~/.dsc 跑后指纹 ==='
$urtAfter = Get-DirFingerprint $urtRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 清单聚合 {2} · 内容聚合 {3}" -f $urtAfter.Count, $urtAfter.Locked, $urtAfter.Digest, $urtAfter.ContentDigest)
$urtDiff = Compare-Object -ReferenceObject $urtBefore.Lines -DifferenceObject $urtAfter.Lines
if ($null -eq $urtDiff) {
  Write-Output '差异行：无（逐文件哈希完全一致）'
} else {
  Write-Output ("差异行：{0} 条" -f @($urtDiff).Count)
  $urtDiff | Select-Object -First 10 | ForEach-Object { '  ' + $_.SideIndicator + ' ' + $_.InputObject }
}
Write-Output '全部完成'
