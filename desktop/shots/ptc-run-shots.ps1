# PTC 实拍：一轮真对话里 run_code 卡压着几次 sdk 调用，把这张卡拍下来。
#
# 隔离：DSC_DESKTOP_USER_DATA 换掉 Electron 的 userData，USERPROFILE / HOME 换掉宿主的
# ~/.dsc —— 会话、配置、缓存全落在 desktop/shots/ptc-run-home 下。种子见 _ptc-run-seed.mjs
# （它把真实 ~/.dsc 的模型配置与模式文件复制进隔离目录，其余一概不复制）。
#
# 为什么用真模型：run_code 卡里那几行是模型自己写的脚本跑出来的。假端点能伪造事件，但
# 「模型会不会真的把三件事塞进一段脚本」这件事只有真跑才算数。
#
# 用法（先在 desktop/ 与根各跑一次 build）：
#   pwsh -NoProfile -File ptc-run-shots.ps1
#
# 证据：截图落在 shots/ptc-run.png；渲染层量到的读数打在 stderr 的「预跑脚本完成」那行 JSON 里。

param([int]$Delay = 300000, [int]$Lead = 279000)

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$ptcShots = 'D:\dsc\desktop\shots'
# 工作目录（仓库根）用算的，不写字面量：这个路径要交给 Start-Process，写错会直接起不来。
$ptcRoot = Split-Path (Split-Path $ptcShots -Parent) -Parent
$ptcElectron = Join-Path $ptcShots '..\node_modules\electron\dist\electron.exe'
$ptcEntry = Join-Path $ptcShots '..\out\main\index.js'
$ptcHome = Join-Path $ptcShots 'ptc-run-home'
$ptcRealProfile = $env:USERPROFILE
$ptcRealDsc = Join-Path $ptcRealProfile '.dsc'

# ── 真实 ~/.dsc 的指纹：只证「跑前跑后没多出/少掉/改掉文件」，不读内容 ──────────────
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
  return [pscustomobject]@{ Count = $files.Count; Digest = $digest; Locked = $locked; Lines = $lines }
}

$ptcEval = @'

(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = pred(); if (v) return v; await wait(150); }
    return null;
  };
  const chat = () => document.querySelector('.chat');
  const cards = () => Array.from(document.querySelectorAll('.tool-card'));
  const notes = () => Array.from(document.querySelectorAll('.entry-note'));
  const runCard = () => cards().find((el) => el.querySelector('.sub-call-count') !== null) ?? null;
  const freezeScroll = () => {
    const box = chat();
    if (box === null) return false;
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    if (desc === undefined || desc.get === undefined || desc.set === undefined) return false;
    const held = { value: desc.get.call(box) };
    window.__ptcAllow = false;
    Object.defineProperty(box, 'scrollTop', {
      configurable: true,
      get: () => held.value,
      set: (value) => { if (window.__ptcAllow === true) { held.value = value; desc.set.call(box, value); } },
    });
    return true;
  };
  const scrollTo = async (el, offset) => {
    const box = chat();
    for (let pass = 0; pass < 6; pass += 1) {
      const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top - offset;
      if (Math.abs(delta) < 2) break;
      window.__ptcAllow = true;
      box.scrollTop = Math.round(box.scrollTop + delta);
      await wait(220);
    }
    await wait(300);
  };

  const ready = await waitFor(() => document.querySelector('textarea') !== null, 60000);
  if (ready === null) return { case: 'ptc-live', error: '界面没画出来，找不到输入框' };
  await wait(2000);

  const PROMPT = '请用一次 run_code 脚本，在脚本里同时做三件事：1) 读 package.json；2) 读 README.md 的前 20 行；3) 数一下 src/packages/ptc/index.ts 有多少行。三件事都在同一段脚本里做完，然后一句话汇报结果，不要改动任何文件。';
  try {
    await window.dsc.invoke('submit', [PROMPT, undefined]);
  } catch (error) {
    return { case: 'ptc-live', error: '提交失败：' + String(error) };
  }

  // 第一等：卡上出现「N 次调用」——它由 subCalls 数据画出来，卡体合着也在，是子调用真的收到了父卡里的证据。
  // 谓词要交回**元素本身**：waitFor 放行的是真值，写成 `() => runCard() !== null` 只会拿回 true。
  const appeared = await waitFor(runCard, 240000);
  if (appeared === null) {
    return {
      case: 'ptc-live',
      submitted: true,
      error: '没等到卡内调用：这一轮模型没走 run_code，或子调用没挂进父卡',
      cards: cards().length,
      notes: notes().length,
      chatText: (chat() === null ? '' : chat().textContent).slice(0, 600),
    };
  }
  // 后面每一步都留一个 phase 记号：真机里脚本挂了，报回来的名字要能指出挂在哪一步。
  let phase = 'card-found'
  try {
  const during = {
    cardText: appeared.textContent.trim().slice(0, 160),
    subCallCount: (appeared.querySelector('.sub-call-count') ?? { textContent: '' }).textContent.trim(),
    status: appeared.className,
  };

  // 第二等：这一轮定稿（没有「进行中」状态行，也没有还在跑的工具卡）
  phase = 'settle'
  const settled = await waitFor(
    () => document.querySelector('.turn-status') === null && document.querySelector('.tool-card.status-running') === null,
    240000,
  );
  await wait(1200);

  // 定稿后整轮会自己收起，而截图要等到 300 秒才拍：这段时间里每 1.5 秒把「整轮 → 过程组 →
  // 工具卡」三层都按回打开态。前两次实拍都栽在这里——脚本放开以后整轮又折了回去，拍到的
  // 是收起后的那一屏（组头都没有，只剩最终回答）。
  phase = 'hold-open'
  let reopened = false
  let openedGroups = 0
  const openAll = () => {
    const toggle = Array.from(document.querySelectorAll('.turn-fold')).pop();
    if (toggle !== undefined && toggle.getAttribute('aria-expanded') !== 'true') {
      toggle.click();
      reopened = true;
    }
    for (const head of Array.from(document.querySelectorAll('.step-fold'))) {
      if (head.getAttribute('aria-expanded') === 'true') continue;
      head.click();
      openedGroups += 1;
    }
    const open = runCard();
    // 可点的是行首那一段文字（.tool-click），不是整条 .tool-head：后者在 Factory 那张卡上没有处理器。
    if (open !== null && !open.classList.contains('open')) {
      const clickable = open.querySelector('.tool-click') ?? open.querySelector('.tool-head');
      if (clickable !== null) clickable.click();
    }
  };
  await wait(600);
  openAll();
  const holdUntil = Date.now() + 200000;
  while (Date.now() < holdUntil) { await wait(1500); openAll(); }

  phase = 'find-card'
  const card = runCard();
  if (card === null) return { case: 'ptc-live', error: '展开整轮以后反倒找不到 run_code 卡' };
  openAll();
  await wait(900);

  phase = 'evidence'
  const group = document.querySelector('.step-fold');
  const subCalls = Array.from(card.querySelectorAll('.sub-call')).map((li) => ({
    verb: (li.querySelector('.sub-call-verb') ?? { textContent: '' }).textContent.trim(),
    summary: (li.querySelector('.sub-call-summary') ?? { textContent: '' }).textContent.trim(),
    status: (li.className.match(/status-(\S+)/) ?? ['', ''])[1],
    fontSize: Math.round(Number.parseFloat(getComputedStyle(li.querySelector('.sub-call-verb') ?? li).fontSize)),
  }));
  const verbs = Array.from(card.querySelectorAll('.sub-call-verb'));
  const noteStyle = notes().length === 0 ? null : {
    text: (notes()[0].textContent ?? '').trim().slice(0, 60),
    fontSize: Math.round(Number.parseFloat(getComputedStyle(notes()[0]).fontSize)),
  };

  // 摆好视角：卡顶对准聊天区顶部偏下一点，然后冻住滚动（ChatView 会贴底，会把这一屏冲掉）
  phase = 'scroll'
  if (chat() !== null) await scrollTo(card, 80);
  freezeScroll();
  await wait(400);

  return {
    case: 'ptc-live',
    settled: settled !== null,
    reopenedRound: reopened,
    openedGroups,
    during,
    cardOpen: card.classList.contains('open'),
    cardHeadText: (card.querySelector('.tool-head') ?? { textContent: '' }).textContent.trim().slice(0, 120),
    subCallCountText: (card.querySelector('.sub-call-count') ?? { textContent: '' }).textContent.trim(),
    subCalls,
    subCallVerbs: verbs.map((v) => v.textContent.trim()),
    subCallLabelsTitle: (card.querySelector('.label') ?? { textContent: '' }).textContent.trim(),
    group: group === null ? null : {
      label: (group.querySelector('.step-fold-label') ?? { textContent: '' }).textContent.trim(),
      counts: group.getAttribute('data-step-counts'),
      size: group.getAttribute('data-step-size'),
      open: group.getAttribute('aria-expanded'),
    },
    note: noteStyle,
    noteCount: notes().length,
    toolCards: cards().length,
    pass: subCalls.length >= 2,
  };
  } catch (error) {
    return {
      case: 'ptc-live',
      phase,
      error: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error),
      stack: String(error !== null && error !== undefined && error.stack !== undefined ? error.stack : '').slice(0, 600),
      cards: cards().length,
      notes: notes().length,
    };
  }
})()

'@

Write-Output '=== 真实 ~/.dsc 跑前指纹 ==='
$ptcBefore = Get-DirFingerprint $ptcRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 聚合 {2}" -f $ptcBefore.Count, $ptcBefore.Locked, $ptcBefore.Digest)

$env:DSC_DESKTOP_USER_DATA = Join-Path $ptcHome 'electron-userdata'
$env:USERPROFILE = $ptcHome
$env:HOME = $ptcHome
# 等响应头的时限这次不在这里设：种子的 config.yaml 里写了 `llm:` 段（connectTimeoutMs 180000 /
# streamIdleMs 300000 / retryAttempts 12）——那是 2026-11-07 新加的旋钮，实拍顺便验它。
# 默认 30 秒 + 5 次重试时，ptc 的大提示词打 opencode 那个网关会连挂五次（第一次实拍就是这样）。
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SHOT = Join-Path $ptcShots 'ptc-run.png'
$env:DSC_DESKTOP_SHOT_DELAY = [string]$Delay
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = [string]$Lead
$env:DSC_DESKTOP_SHOT_EVAL = $ptcEval

$ptcOutLog = Join-Path $ptcShots 'ptc-run.out.log'
$ptcErrLog = Join-Path $ptcShots 'ptc-run.err.log'
Remove-Item -LiteralPath $ptcOutLog, $ptcErrLog -ErrorAction SilentlyContinue

try {
  Write-Output ("=== PTC 实拍（隔离目录 {0}；截图 {1}ms 后拍） ===" -f $ptcHome, $Delay)
  $ptcProc = Start-Process -FilePath $ptcElectron -ArgumentList $ptcEntry -WorkingDirectory $ptcRoot -PassThru -RedirectStandardOutput $ptcOutLog -RedirectStandardError $ptcErrLog
  $ptcDeadline = (Get-Date).AddMilliseconds($Delay + 90000)
  $ptcSeen = ''
  while ((Get-Date) -lt $ptcDeadline) {
    if (Test-Path -LiteralPath $ptcErrLog) {
      $hit = Select-String -LiteralPath $ptcErrLog -Pattern '已写出|截图超时|页面加载失败|截图失败' -ErrorAction SilentlyContinue
      if ($null -ne $hit) { $ptcSeen = $hit[0].Line; break }
    }
    if ($ptcProc.HasExited) { break }
    Start-Sleep -Milliseconds 800
  }
  if (-not $ptcProc.HasExited) {
    & taskkill /PID $ptcProc.Id /T /F 2>&1 | Out-Null
    Start-Sleep -Milliseconds 600
  } else {
    & taskkill /PID $ptcProc.Id /T /F 2>&1 | Out-Null
  }
  Write-Output ("  electron 已收工：{0}" -f ($ptcSeen -replace 's+$', ''))
  if (Test-Path -LiteralPath $ptcErrLog) {
    Select-String -LiteralPath $ptcErrLog -Pattern '预跑脚本完成|预跑脚本失败|已写出|页面加载失败' |
      ForEach-Object { '  ' + $_.Line }
  }
} finally {
  # 隔离目录里有一份从真实 ~/.dsc 复制来的 credentials.yaml：跑完立刻删掉，别让它留在盘上。
  Remove-Item -LiteralPath (Join-Path $ptcHome '.dsc\credentials.yaml') -ErrorAction SilentlyContinue
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_USER_DATA -ErrorAction SilentlyContinue
}

Write-Output '=== 真实 ~/.dsc 跑后指纹 ==='
$ptcAfter = Get-DirFingerprint $ptcRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 聚合 {2}" -f $ptcAfter.Count, $ptcAfter.Locked, $ptcAfter.Digest)
$ptcDiff = Compare-Object -ReferenceObject $ptcBefore.Lines -DifferenceObject $ptcAfter.Lines
if ($null -eq $ptcDiff) {
  Write-Output '差异行：无（逐文件哈希完全一致）'
} else {
  Write-Output ("差异行：{0} 条" -f @($ptcDiff).Count)
  $ptcDiff | ForEach-Object { '  ' + $_.SideIndicator + ' ' + $_.InputObject }
}
Write-Output '全部完成'
