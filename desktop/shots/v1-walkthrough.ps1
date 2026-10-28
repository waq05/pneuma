# V1 实机走查（0.6.37 欠账回销）：假模型端点端到端跑通三条逻辑已有单测/探针的链路。
#
#   ① T21 侧栏状态点两档——回合跑起来 = working，工具审批挂起 = awaiting-approval，回合结束点消失
#   ② T16 标题生成——首个回合正常结束后自动出「E2E」前缀标题（假端点应答标题小请求）
#   ③ /export 落盘提示——斜杠命令导出 markdown，右下角出「已导出 N 条消息 → 路径」toast，文件真实落盘
#
# 隔离与指纹照 ui-fix-shots.ps1 同一套：HOME/USERPROFILE 指到 shots/ui-home（ui-seed.mjs 种子，
# 端点指向本机假服务 18960），真实 ~/.dsc 跑前跑后做「文件数 + 聚合 SHA256」比对。
# 假端点 v1-fake-server.mjs 按请求形状分三类应答（工具调用 / 工具收尾 / 标题）。
#
# 用法（先在 desktop/ 跑 `pnpm run build`）：
#   pwsh -NoProfile -File v1-walkthrough.ps1

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$vt = 'D:\dsc\desktop\shots'
$vtElectron = Join-Path $vt '..\node_modules\electron\dist\electron.exe'
$vtEntry = Join-Path $vt '..\out\main\index.js'
$vtHome = Join-Path $vt 'ui-home'
$vtRealDsc = Join-Path $env:USERPROFILE '.dsc'

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

$vtEvalHead = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await pred(); if (v) return v; await wait(120); }
  return null;
};
const text = (el) => (el === null || el === undefined ? null : el.textContent.trim());
const all = (sel) => Array.from(document.querySelectorAll(sel));
const composerBox = () => document.querySelector('.composer textarea');
/** React 受控 textarea 的赋值：原生 setter + input 事件。 */
const setVal = (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
'@

$vtEval = @'
(async () => {
  const started = Date.now();
  const seen = [];
  const dotNow = () => {
    const d = document.querySelector('.sess-item .session-dot');
    if (d === null) return null;
    const st = d.classList.contains('awaiting-approval') ? 'awaiting-approval' : d.classList.contains('working') ? 'working' : 'other';
    if (!seen.includes(st)) seen.push(st);
    return st;
  };
  // 状态点窗口可能只有几百毫秒，60ms 采样兜住
  const sampler = setInterval(dotNow, 60);
  try {
    const composer = await waitFor(() => composerBox(), 20000);
    if (composer === null) return { case: 'v1-e2e', error: 'composer 没找到', ms: Date.now() - started };
    const clickSend = async () => {
      const btn = await waitFor(() => {
        const b = document.querySelector('.composer .send-btn');
        return b !== null && !b.disabled ? b : null;
      }, 8000);
      if (btn === null) return null;
      btn.click();
      return true;
    };
    // ① 发起回合 → 状态点 working → 假端点回 write 工具调用 → 审批挂起 awaiting-approval
    setVal(composer, '帮我在绝对路径写一个探测文件。');
    if (await clickSend() === null) return { case: 'v1-e2e', error: '发送按钮不可用', ms: Date.now() - started };
    const approval = await waitFor(() => document.querySelector('.approval'), 30000);
    await wait(500);
    const waitingDot = dotNow();
    const approvalTool = text(approval === null ? null : approval.querySelector('.tool-name'));
    if (approval === null) return { case: 'v1-e2e', error: '审批卡没出现', seen, waitingDot, ms: Date.now() - started };
    // ② 这次允许 → 工具落盘 → 收尾文本 → 回合结束状态点消失
    const allow = all('.approval-actions button.btn').find((b) => !b.className.includes('danger'));
    if (allow === undefined) return { case: 'v1-e2e', error: '允许按钮没找到', seen, waitingDot, ms: Date.now() - started };
    allow.click();
    const dotGone = await waitFor(() => document.querySelector('.sess-item .session-dot') === null, 30000);
    const replyShown = await waitFor(() => document.body.textContent.indexOf('文件已写好') >= 0, 8000);
    // ③ T16：回合 completed 后标题小请求 → 侧栏出「E2E」前缀自动标题
    const titleText = await waitFor(() => {
      const found = all('.sess-item .title').map(text).find((x) => x !== null && x.indexOf('E2E') === 0);
      return found === undefined ? null : found;
    }, 25000);
    // ④ /export → markdown 落盘 + 线程里的系统条目提示（runCommand 的 notice 走 transcript.system，
    //    不是 toast——0.6.37 首轮实测 toast 恒空、提示以 .entry-system 居中行出现）
    setVal(composer, '/export D:/dsc/desktop/shots/ui-home/e2e-out/walkthrough-export.md');
    await wait(120);
    if (await clickSend() === null) return { case: 'v1-e2e', error: '第二次发送按钮不可用', seen, waitingDot, dotGone, ms: Date.now() - started };
    const toast = await waitFor(() => {
      const found = all('.entry-system').map(text).find((x) => x !== null && x.indexOf('已导出') === 0);
      return found === undefined ? null : found;
    }, 12000);
    return {
      case: 'v1-e2e',
      ms: Date.now() - started,
      theme: document.documentElement.dataset.theme,
      seen, waitingDot, approvalTool, dotGone, replyShown, titleText, toast,
      sidebarRows: all('.sess-item').map((el) => ({ cls: el.className, t: text(el.querySelector('.title')) })),
      groupHeads: all('.group-row').map(text),
      statesOk: seen.includes('working') && seen.includes('awaiting-approval'),
      waitingOk: waitingDot === 'awaiting-approval' && approvalTool === 'write',
      resolvedOk: dotGone === true && replyShown === true,
      titleOk: titleText !== null,
      exportOk: toast !== null && toast.indexOf('→') > 0,
    };
  } finally {
    clearInterval(sampler);
  }
})()
'@

Write-Output '=== 真实 ~/.dsc 跑前指纹 ==='
$vtBefore = Get-DirFingerprint $vtRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 清单聚合 {2} · 内容聚合 {3}" -f $vtBefore.Count, $vtBefore.Locked, $vtBefore.Digest, $vtBefore.ContentDigest)

node (Join-Path $vt 'ui-seed.mjs') | Out-Null

# 权限模式换「自动编辑」：工作区内写自动放行、工作区外写走审批卡（readonly 档根本不弹卡，
# 0.6.37 首轮走查实测 write 被策略面当场拒）。探测文件因此要落在工作区外——用真实 %TEMP%。
$vtTarget = (Join-Path $env:TEMP 'dsc-v1-walkthrough\probe.md') -replace '\\', '/'
$vtSettingsPath = Join-Path $vtHome '.dsc\settings.json'
$vtSettings = Get-Content -LiteralPath $vtSettingsPath -Raw
Set-Content -LiteralPath $vtSettingsPath -Value $vtSettings.Replace('"defaultPolicy": "readonly"', '"defaultPolicy": "auto-edit"') -Encoding utf8
Remove-Item -LiteralPath ([System.IO.Path]::GetDirectoryName($vtTarget)) -Recurse -Force -ErrorAction SilentlyContinue
# 必须在假端点启动前设：服务从这个变量读 write 工具的落盘目标
$env:DSC_V1_PROBE_TARGET = $vtTarget

# 假端点先起，端口就绪再拉应用
$vtServerLog = Join-Path $vt 'v1-server.out.log'
Remove-Item -LiteralPath $vtServerLog -ErrorAction SilentlyContinue
$vtServer = Start-Process -FilePath 'node' -ArgumentList (Join-Path $vt 'v1-fake-server.mjs') -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $vtServerLog -RedirectStandardError (Join-Path $vt 'v1-server.err.log')
$vtUp = $false
for ($i = 0; $i -lt 40; $i++) {
  $cli = New-Object System.Net.Sockets.TcpClient
  try {
    $cli.Connect('127.0.0.1', 18960)
    $vtUp = $true
    break
  } catch {
    Start-Sleep -Milliseconds 250
  } finally {
    $cli.Dispose()
  }
}
if (-not $vtUp) {
  Stop-Process -Id $vtServer.Id -Force -ErrorAction SilentlyContinue
  throw '假端点 127.0.0.1:18960 没起来'
}
Write-Output '假端点已就绪（127.0.0.1:18960）'

try {
  $env:DSC_DESKTOP_USER_DATA = Join-Path $vtHome 'electron-userdata'
  $env:USERPROFILE = $vtHome
  $env:HOME = $vtHome
  $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
  # 种子 config.yaml 的 apiKeyEnv：不设它 provider 不注册，应用会报「没有可用端点」
  $env:UI_FAKE_KEY = 'e2e-fake-key'
  $env:DSC_DESKTOP_SHOT = Join-Path $vt 'v1-e2e.png'
  $env:DSC_DESKTOP_SHOT_DELAY = '150000'
  $env:DSC_DESKTOP_SHOT_EVAL_LEAD = '135000'
  $env:DSC_DESKTOP_SHOT_EVAL = ($vtEvalHead + $vtEval)
  Remove-Item Env:DSC_DESKTOP_SEARCH, Env:DSC_RESUME_SESSION -ErrorAction SilentlyContinue

  $vtOutLog = Join-Path $vt 'v1-e2e.out.log'
  $vtErrLog = Join-Path $vt 'v1-e2e.err.log'
  Remove-Item -LiteralPath $vtOutLog, $vtErrLog -ErrorAction SilentlyContinue
  Write-Output '=== v1-e2e（隔离目录 + 假模型端点）==='

  $vtProc = Start-Process -FilePath $vtElectron -ArgumentList $vtEntry -PassThru -RedirectStandardOutput $vtOutLog -RedirectStandardError $vtErrLog
  $vtDeadline = (Get-Date).AddSeconds(230)
  $vtSeen = ''
  while ((Get-Date) -lt $vtDeadline) {
    if ($vtProc.HasExited) { break }
    if (Test-Path -LiteralPath $vtErrLog) {
      $hit = Select-String -LiteralPath $vtErrLog -Pattern '已写出|截图超时|截图失败|页面加载失败' -ErrorAction SilentlyContinue
      if ($null -ne $hit) { $vtSeen = $hit[0].Line; break }
    }
    Start-Sleep -Milliseconds 800
  }
  & taskkill /PID $vtProc.Id /T /F 2>&1 | Out-Null
  Start-Sleep -Milliseconds 600
  Write-Output ("  electron 已收工：{0}" -f ($vtSeen -replace '\s+$', ''))

  if (Test-Path -LiteralPath $vtErrLog) {
    Select-String -LiteralPath $vtErrLog -Pattern '预跑脚本完成|预跑脚本失败' -ErrorAction SilentlyContinue |
      ForEach-Object { '  ' + $_.Line }
  }
} finally {
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_SEARCH,
    Env:DSC_RESUME_SESSION, Env:DSC_DESKTOP_USER_DATA, Env:UI_FAKE_KEY, Env:DSC_V1_PROBE_TARGET -ErrorAction SilentlyContinue
  Stop-Process -Id $vtServer.Id -Force -ErrorAction SilentlyContinue
}

Write-Output '=== 落盘对账 ==='
$vtProbe = Join-Path $env:TEMP 'dsc-v1-walkthrough\probe.md'
$vtExported = Join-Path $vtHome 'e2e-out\walkthrough-export.md'
$vtProbeExists = Test-Path -LiteralPath $vtProbe
Write-Output ("探测文件（write 工具落盘，工作区外 $vtTarget）：{0}" -f $vtProbeExists)
if ($vtProbeExists) { Write-Output ("  内容：{0}" -f ((Get-Content -LiteralPath $vtProbe -Raw) -replace "`n", '⏎')) }
$vtExportExists = Test-Path -LiteralPath $vtExported
Write-Output ("导出文件（/export 落盘）：{0}（{1} 字节）" -f $vtExportExists, (Get-Item -LiteralPath $vtExported -ErrorAction SilentlyContinue).Length)
$vtSrvLog = Join-Path $vtHome 'e2e-server-log.jsonl'
if (Test-Path -LiteralPath $vtSrvLog) {
  Write-Output '假端点收到的请求类型（按顺序）：'
  Get-Content -LiteralPath $vtSrvLog | ForEach-Object { '  ' + ($_ | ConvertFrom-Json).kind }
}
# 探测文件在真 Temp 里，看完就收走
Remove-Item -LiteralPath ([System.IO.Path]::GetDirectoryName($vtProbe)) -Recurse -Force -ErrorAction SilentlyContinue

Write-Output '=== 真实 ~/.dsc 跑后指纹 ==='
$vtAfter = Get-DirFingerprint $vtRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 清单聚合 {2} · 内容聚合 {3}" -f $vtAfter.Count, $vtAfter.Locked, $vtAfter.Digest, $vtAfter.ContentDigest)
$vtDiff = Compare-Object -ReferenceObject $vtBefore.Lines -DifferenceObject $vtAfter.Lines
if ($null -eq $vtDiff) {
  Write-Output '差异行：无（逐文件哈希完全一致）'
} else {
  Write-Output ("差异行：{0} 条" -f @($vtDiff).Count)
  $vtDiff | Select-Object -First 10 | ForEach-Object { '  ' + $_.SideIndicator + ' ' + $_.InputObject }
}
Write-Output ("文件数一致：{0}；内容聚合一致：{1}" -f ($vtBefore.Count -eq $vtAfter.Count), ($vtBefore.ContentDigest -eq $vtAfter.ContentDigest))
Write-Output '全部完成'
