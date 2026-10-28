# 完成提醒走查（0.6.40）：提示音 + 后台系统通知两条设置链路的端到端验证。
#
#   ① 完成跳变 effect 真的跑：假端点跑一轮纯文本对话，回合结束时（窗口判成后台）
#      主进程创建真 toast —— stderr 出现 [selfcheck] 系统通知：…
#   ② 主进程 notify 链路：SHOT_EVAL 直调 window.dsc.notify 返回 true（第二次通知）
#   ③ Web Audio 环境可用：SHOT_EVAL 里 new AudioContext() 不抛
#   ④ 设置页三行新 UI：第二个实例 ?settings=general 截图目检
#
# 隔离照 v1-walkthrough 同一套：HOME/USERPROFILE 指到 shots/sound-home（静态种子），
# 真实 ~/.dsc 跑前跑后做「文件数 + 聚合 SHA256」比对。
# 「后台判定」不走真失焦：EVAL 里把 document.hasFocus patch 成 false，完成 effect
# 的 isBackgrounded() 即为真——比抢焦点可靠，也与真实场景（用户在别的窗口）同构。
#
# 用法（先在 desktop/ 跑 `pnpm run build`）：
#   pwsh -NoProfile -File sound-notify.ps1

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$vt = 'D:\dsc\desktop\shots'
$vtElectron = Join-Path $vt '..\node_modules\electron\dist\electron.exe'
$vtEntry = Join-Path $vt '..\out\main\index.js'
$vtHome = Join-Path $vt 'sound-home'
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

$vtEval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = await pred(); if (v) return v; await wait(120); }
    return null;
  };
  const started = Date.now();
  try {
    const composer = await waitFor(() => document.querySelector('.composer textarea'), 20000);
    if (composer === null) return { case: 'sound-notify', error: 'composer 没找到', ms: Date.now() - started };
    // 走查：把窗口判成后台，完成 effect 的 isBackgrounded() 为真，通知分支真的走主进程
    document.hasFocus = () => false;
    // ② 直调通知链路：主进程创建真 toast，stderr 应出现第二条 [selfcheck] 系统通知
    const notified = await window.dsc.notify({ title: '走查直调通知', body: '主进程 notify 链路' });
    // ③ Web Audio 环境冒烟（完成提示音的合成器依赖它）
    const acProbe = (() => { try { const ac = new AudioContext(); const ok = ac.state !== 'closed'; void ac.close(); return ok; } catch { return false; } })();
    // ① 发起一轮 → 假端点回纯文本 → 回合完成跳变 → effect 弹完成通知（第一条 [selfcheck]）
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(composer, '跑一轮提醒走查');
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(120);
    const btn = await waitFor(() => {
      const b = document.querySelector('.composer .send-btn');
      return b !== null && !b.disabled ? b : null;
    }, 8000);
    if (btn === null) return { case: 'sound-notify', error: '发送按钮不可用', notified, acProbe, ms: Date.now() - started };
    btn.click();
    const reply = await waitFor(() => document.body.textContent.indexOf('提醒走查完成') >= 0, 20000);
    await wait(2500); // 留给标题请求与完成跳变 effect
    return { case: 'sound-notify', notified, acProbe, replyOk: reply !== null, ms: Date.now() - started };
  } catch (error) {
    return { case: 'sound-notify', error: String(error), ms: Date.now() - started };
  }
})()
'@

Write-Output '=== 真实 ~/.dsc 跑前指纹 ==='
$vtBefore = Get-DirFingerprint $vtRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 清单聚合 {2} · 内容聚合 {3}" -f $vtBefore.Count, $vtBefore.Locked, $vtBefore.Digest, $vtBefore.ContentDigest)

# 假端点先起，端口就绪再拉应用
$vtServerLog = Join-Path $vt 'sound-server.out.log'
Remove-Item -LiteralPath $vtServerLog -ErrorAction SilentlyContinue
$vtServer = Start-Process -FilePath 'node' -ArgumentList (Join-Path $vt 'sound-fake-server.mjs') -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $vtServerLog -RedirectStandardError (Join-Path $vt 'sound-server.err.log')
$vtUp = $false
for ($i = 0; $i -lt 40; $i++) {
  $cli = New-Object System.Net.Sockets.TcpClient
  try {
    $cli.Connect('127.0.0.1', 18961)
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
  throw '假端点 127.0.0.1:18961 没起来'
}
Write-Output '假端点已就绪（127.0.0.1:18961）'

function Invoke-Instance([string]$Case, [string]$Search, [string]$Eval, [int]$DelayMs, [int]$LeadMs) {
  $env:DSC_DESKTOP_USER_DATA = Join-Path $vtHome 'electron-userdata'
  $env:USERPROFILE = $vtHome
  $env:HOME = $vtHome
  # 种子 config.yaml 的 apiKeyEnv：不设它 provider 不注册，应用会报「没有可用端点」
  $env:SOUND_FAKE_KEY = 'e2e-fake-key'
  $env:DSC_DESKTOP_SHOT = Join-Path $vt ("sound-{0}.png" -f $Case)
  $env:DSC_DESKTOP_SHOT_DELAY = [string]$DelayMs
  $env:DSC_DESKTOP_SHOT_EVAL_LEAD = [string]$LeadMs
  $env:DSC_DESKTOP_SHOT_EVAL = $Eval
  if ($Search -ne '') { $env:DSC_DESKTOP_SEARCH = $Search } else { Remove-Item Env:DSC_DESKTOP_SEARCH -ErrorAction SilentlyContinue }
  Remove-Item Env:DSC_DESKTOP_SHOT_TOPMOST -ErrorAction SilentlyContinue

  $outLog = Join-Path $vt ("sound-{0}.out.log" -f $Case)
  $errLog = Join-Path $vt ("sound-{0}.err.log" -f $Case)
  Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath $vtElectron -ArgumentList $vtEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $deadline = (Get-Date).AddMilliseconds($DelayMs + 40000)
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
  Write-Output ("  [{0}] electron 已收工：{1}" -f $Case, ($seen -replace '\s+$', ''))
  return $errLog
}

try {
  Write-Output '=== 实例 A：一轮对话 + 完成通知 ==='
  $errA = Invoke-Instance -Case 'e2e' -Search '' -Eval $vtEval -DelayMs 15000 -LeadMs 12000
  if (Test-Path -LiteralPath $errA) {
    Write-Output '  预跑脚本与自检日志：'
    Select-String -LiteralPath $errA -Pattern '预跑脚本完成|预跑脚本失败|系统通知' -ErrorAction SilentlyContinue |
      ForEach-Object { '    ' + $_.Line }
  }

  Write-Output '=== 实例 B：设置页三行新 UI（?settings=general）==='
  # 「任务完成提醒」组在通用分区末尾：截图前把内容区滚到底
  $evalB = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const body = await (async () => {
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      const el = document.querySelector('.settings-body');
      if (el !== null) return el;
      await wait(150);
    }
    return null;
  })();
  if (body === null) return { error: 'settings-body 没找到' };
  body.scrollTop = body.scrollHeight;
  await wait(300);
  const marks = Array.from(document.querySelectorAll('.settings-group-title')).map((el) => el.textContent.trim());
  return { scrolled: body.scrollTop > 0, marks };
})()
'@
  $errB = Invoke-Instance -Case 'settings' -Search 'settings=general' -Eval $evalB -DelayMs 7000 -LeadMs 4000

  Write-Output '=== 假端点请求对账 ==='
  $srvLog = Join-Path $vtHome 'server-log.jsonl'
  if (Test-Path -LiteralPath $srvLog) {
    Get-Content -LiteralPath $srvLog | ForEach-Object { '  ' + ($_ | ConvertFrom-Json).kind }
  } else {
    Write-Output '  （无请求——假端点没收到任何调用）'
  }
} finally {
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_SEARCH,
    Env:DSC_DESKTOP_USER_DATA, Env:SOUND_FAKE_KEY -ErrorAction SilentlyContinue
  Stop-Process -Id $vtServer.Id -Force -ErrorAction SilentlyContinue
}

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
