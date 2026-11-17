# 技能页「市场」专项自检（2026-11-17）：用户报的三个问题的界面侧硬验收。
#
# 用**本地慢源**（scripts/_market-local-slow.mjs：/index.json 故意晚 800ms 才回，每次命中
# 往命中日志追加一行毫秒时间戳）跑真桌面壳，验的是「不联网」这件事在时序上真的成立，
# 而不是读源码猜（页面有 CSP，渲染进程读不到慢源的 /hits，所以读数走服务端日志 + PS 侧时间窗）：
#   ① 首次点「市场」tab 出条目（≤8s，本地源延迟 800ms），并停在市场列表截图；
#   ② 离开技能页再回来：点「市场」tab 到首条 .market-row 出现的耗时 ≤300ms，且 /index.json
#      命中次数前后一致（N2 === N1）——证明是客户端模块缓存命中，不是又一次网络；
#   ③ 市场 tab 按钮里没有 .count 徽章，「已安装」tab 按钮里还有（只删了市场那个）；
#   ④ 点 skills.sh chip：出现中性提示 .market-hint、没有 .settings-note.error 红条、
#      搜索输入框可见（焦点在它上面更好），且 /index.json 命中次数不变（点源没发请求）。
#
# 两次 electron 启动 = 两张截图（一次启动只能写一个 DSC_DESKTOP_SHOT 路径）：
#   Run 1 收尾停在市场列表 → out/skills-market-list.png
#   Run 2 收尾停在 skills.sh 搜索态 → out/skills-market-skillssh.png
#
# 隔离：USERPROFILE / HOME / DSC_DESKTOP_USER_DATA / DSC_DESKTOP_STATE 全钉在
# desktop/shots/skills-market-home；种子工作区也放在隔离 home 里，绝不碰用户真实目录。
# 跑前跑后对真实 ~/.dsc 做「文件数 + 内容聚合 SHA256」比对，任何一行差异都会 FAIL。
#
# 用法（先在 worktree 里出 desktop/out）：
#   pnpm --dir desktop build
#   pwsh -NoProfile -File desktop/shots/skills-market-check.ps1
# 退出码 0 = 全部断言通过；非零 = 有 FAIL（会逐条打印原因与读数）。

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# ── 路径：全部从本脚本所在的 worktree 推出来，不写死任何绝对路径 ────────────────
$swShots = $PSScriptRoot
$swElectron = Join-Path $swShots '..\node_modules\electron\dist\electron.exe'
$swEntry = Join-Path $swShots '..\out\main\index.js'
$swServerScript = Join-Path $swShots '..\..\scripts\_market-local-slow.mjs'
$swHome = Join-Path $swShots 'skills-market-home'
$swDsc = Join-Path $swHome '.dsc'
$swWork = Join-Path $swHome 'work'
$swLogDir = Join-Path $swHome 'logs'
$swOutDir = Join-Path $swShots 'out'
$swShot1 = Join-Path $swOutDir 'skills-market-list.png'
$swShot2 = Join-Path $swOutDir 'skills-market-skillssh.png'
# 慢源的命中日志：每打一次 /index.json 追加一行带毫秒时间戳。页面里有 CSP，渲染进程 fetch
# 不到这个回环端口（第一轮实测 hits 全是 null），所以命中次数改由 PS 侧读日志、按时间窗判。
$swHitsLog = Join-Path $swLogDir 'market-hits.jsonl'
$swMarketPort = 17461
# 真实用户的 ~/.dsc：必须在覆盖 USERPROFILE 之前取。
$swRealDsc = Join-Path $env:USERPROFILE '.dsc'

if (-not (Test-Path -LiteralPath $swElectron)) {
  throw "找不到 electron：$swElectron（desktop 依赖没装？）"
}
if (-not (Test-Path -LiteralPath $swEntry)) {
  throw "找不到桌面壳产物：$swEntry（先跑 pnpm --dir desktop build）"
}
if (-not (Test-Path -LiteralPath $swServerScript)) {
  throw "找不到本地慢源脚本：$swServerScript"
}

# ── 真实 ~/.dsc 指纹（照抄 ui-batch4-check.ps1：文件数 + 逐文件内容聚合 SHA256）────
function Get-DirFingerprint([string]$Path) {
  $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Sort-Object FullName)
  $lines = New-Object System.Collections.Generic.List[string]
  $locked = 0
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($Path.Length)
    $hash = 'LOCKED'
    try { $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash } catch { $locked += 1 }
    $lines.Add("$rel|$($file.Length)|$hash")
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $contentJoined = [string]::Join("`n", ($lines | ForEach-Object { $parts = $_ -split '\|'; "$($parts[0])|$($parts[2])" }))
  $contentDigest = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($contentJoined))).Replace('-', '').ToLowerInvariant()
  return [pscustomobject]@{ Count = $files.Count; ContentDigest = $contentDigest; Locked = $locked; Lines = $lines }
}

# ── 命中日志读数：慢源每打一次 /index.json 追加一行 { at, path } ────────────────
# 为什么不用页面里 fetch('/hits')：界面页有 CSP，渲染进程连不到这个回环端口（第一轮实测
# hits 全是 null）；服务端写日志、PS 侧按 eval 记下的毫秒时间窗数，才拿得到确定读数。
function Read-HitTimes([string]$Path) {
  $times = New-Object System.Collections.Generic.List[double]
  if (-not (Test-Path -LiteralPath $Path)) { return $times }
  foreach ($line in Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue) {
    if ($line.Trim() -eq '') { continue }
    try {
      $doc = $line | ConvertFrom-Json
      if ($null -ne $doc.at) { [void]$times.Add([double]$doc.at) }
    } catch {
      # 半行/坏行不算读数：宁可少算一次，也不让解析错误变成「命中为 0」
    }
  }
  return $times
}

# 时间戳 ≤ 某时刻的命中次数（「到这一刻为止一共联网几次」）。
function Count-HitsUpTo($Times, [double]$To) {
  return @($Times | Where-Object { $_ -le $To }).Count
}

# 时间窗内的命中次数（「这段操作里有没有联网」）。
function Count-HitsBetween($Times, [double]$From, [double]$To) {
  return @($Times | Where-Object { $_ -ge $From -and $_ -le $To }).Count
}

# ── 种子：隔离 home 里一个工作目录 + 一条会话 + desktop.json + 两条市场源 ────────
Remove-Item -Recurse -Force -LiteralPath $swHome -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $swDsc | Out-Null
New-Item -ItemType Directory -Force -Path $swWork, $swLogDir, $swOutDir | Out-Null
# 旧图先删：否则「截图存在且非空」会被上一轮留下的文件骗过（本轮就踩过这个坑）。
Remove-Item -LiteralPath $swShot1, $swShot2 -ErrorAction SilentlyContinue
# 命中日志也先删：N1/N2 必须是这次运行的读数。
Remove-Item -LiteralPath $swHitsLog -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $swHome 'AppData\Roaming') | Out-Null

# 会话目录名 = cwd 的 `[\\/:]+` → '-'（core/session.ts）。
$swKey = ($swWork -replace '[:\\/]+', '-')
New-Item -ItemType Directory -Force -Path (Join-Path $swDsc "sessions\$swKey") | Out-Null
$swUuid = 'c1111111-2222-3333-4444-555555555555'
$swNow = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$swSessionDir = Join-Path $swDsc "sessions\$swKey"
$swSessionLines = @(
  "{`"type`":`"meta`",`"id`":`"$swUuid`",`"cwd`":`"$($swWork -replace '\\', '\\')`",`"createdAt`":$swNow}",
  "{`"type`":`"user`",`"text`":`"自检样本会话：市场缓存验收`",`"ts`":$($swNow + 1000)}"
)
Set-Content -LiteralPath (Join-Path $swSessionDir "$swUuid.jsonl") -Value $swSessionLines -Encoding UTF8
$swSeedMeta = @{ version = 1; sessions = @{ $swUuid = @{ title = '市场缓存验收' } } } | ConvertTo-Json -Depth 4
Set-Content -LiteralPath (Join-Path $swDsc 'sessions\meta.json') -Value $swSeedMeta -Encoding UTF8

Set-Content -LiteralPath (Join-Path $swDsc 'desktop.json') -Encoding UTF8 -Value (@{
  lastCwd = $swWork
  recentCwds = @($swWork)
  ui = 'shell'
} | ConvertTo-Json -Depth 4)

# 市场源两条：本地慢源（首页第一个源，预取/首次打开都走它）+ skills.sh（搜索型源，点开不该发请求）。
# updateCheck 关掉：自检不该顺带向 GitHub 发一次真实更新检查（隔离只保证不写用户目录，保证不了不联网）。
Set-Content -LiteralPath (Join-Path $swDsc 'settings.json') -Encoding UTF8 -Value (@{
  updateCheck = 'off'
  marketSources = @(
    @{ name = '自检源'; url = "http://127.0.0.1:$swMarketPort/index.json" },
    @{ name = 'skills.sh'; url = 'https://skills.sh/api/search' }
  )
} | ConvertTo-Json -Depth 4)

# ── 页内脚本：Run 1（首次加载 + 二次打开耗时 + tab 计数）────────────────────────
$swEval1 = @'
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const value = pred(); if (value) return value; await wait(40); }
    return null;
  };
  const out = {};
  try {
    await waitFor(() => { const root = document.querySelector('#root'); return root !== null && root.children.length > 0; }, 25000);
    await wait(2200);
    const navItems = () => [...document.querySelectorAll('.sidebar-nav .nav-item')];
    const clickNav = (text) => {
      const item = navItems().find((button) => (button.textContent ?? '').includes(text));
      if (item === undefined) return false;
      item.click();
      return true;
    };
    const tabButtons = () => [...document.querySelectorAll('.skills-tabs button')];
    const tabByText = (text) => tabButtons().find((button) => (button.textContent ?? '').includes(text)) ?? null;

    out.navOpened = clickNav('技能');
    // 打不开技能页就别继续空等：直接带诊断返回，脚本在 PS 侧尽早报 FAIL（免得截图拍成对话页还看不出原因）。
    let skillsReady = await waitFor(() => document.querySelector('.skills') !== null, 4000);
    if (skillsReady === null) {
      clickNav('技能');
      skillsReady = await waitFor(() => document.querySelector('.skills') !== null, 2500);
    }
    out.skillsOpened = skillsReady !== null;
    if (!out.skillsOpened) {
      out.diag = {
        navTexts: [...document.querySelectorAll('.sidebar-nav .nav-item')].map((button) => (button.textContent ?? '').trim()),
        bootEntryIds: (globalThis.__DSC_BOOT__ && globalThis.__DSC_BOOT__.entries
          ? globalThis.__DSC_BOOT__.entries.map((entry) => entry.id)
          : null),
        bodyHead: (document.body.innerText ?? '').slice(0, 160),
      };
      return out;
    }
    await wait(300);
    out.tabTexts = tabButtons().map((button) => (button.textContent ?? '').trim());
    out.skillsRootFound = document.querySelector('.skills') !== null;

    // ③ 市场 tab 不该有计数徽章；已安装 tab 应该有
    const installedTab = tabByText('已安装');
    const marketTab = tabByText('市场');
    out.tabCounts = {
      installed: installedTab === null ? null : installedTab.querySelectorAll('.count').length,
      market: marketTab === null ? null : marketTab.querySelectorAll('.count').length,
      installedText: installedTab === null ? null : (installedTab.textContent ?? '').trim(),
      marketText: marketTab === null ? null : (marketTab.textContent ?? '').trim(),
      installedTabFound: installedTab !== null,
      marketTabFound: marketTab !== null,
    };

    // ① 首次进市场：本地慢源 800ms，客户端缓存若已被预取温过会更快——两种都允许，只要 ≤8s
    const firstStart = performance.now();
    if (marketTab !== null) marketTab.click();
    const firstRow = await waitFor(() => document.querySelector('.market-row'), 12000);
    out.firstOpenMs = Math.round(performance.now() - firstStart);
    out.t = { firstRowAt: Date.now() };
    out.firstRows = document.querySelectorAll('.market-row').length;
    out.firstRowText = firstRow === null ? null : (firstRow.textContent ?? '').trim();

    // ② 离开技能页（再点一次「技能」回对话页）再回来：缓存命中应秒开且不再打源
    clickNav('技能');
    await waitFor(() => document.querySelector('.skills') === null, 8000);
    await wait(600);
    clickNav('技能');
    await waitFor(() => document.querySelector('.skills') !== null, 10000);
    await wait(400);
    const secondStart = performance.now();
    out.t.secondOpenStart = Date.now();
    const marketTabAgain = tabByText('市场');
    if (marketTabAgain !== null) marketTabAgain.click();
    const secondRow = await waitFor(() => document.querySelector('.market-row'), 5000);
    out.secondOpenMs = secondRow === null ? null : Math.round(performance.now() - secondStart);
    out.t.secondRowAt = Date.now();
    out.secondRows = document.querySelectorAll('.market-row').length;
    out.secondRowText = secondRow === null ? null : (secondRow.textContent ?? '').trim();
    // 收尾就停在市场列表：Run 1 的截图拍这个态
    out.endPhase = 'market-list';
  } catch (error) {
    out.error = (error && error.message) || String(error);
  }
  return out;
})()
'@
$swEval1 = $swEval1.Replace('__PORT__', [string]$swMarketPort)

# ── 页内脚本：Run 2（点 skills.sh：中性提示 + 输入框 + 不发请求）────────────────
$swEval2 = @'
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const value = pred(); if (value) return value; await wait(40); }
    return null;
  };
  const out = {};
  try {
    await waitFor(() => { const root = document.querySelector('#root'); return root !== null && root.children.length > 0; }, 25000);
    await wait(2200);
    const navItems = () => [...document.querySelectorAll('.sidebar-nav .nav-item')];
    const clickNav = (text) => {
      const item = navItems().find((button) => (button.textContent ?? '').includes(text));
      if (item === undefined) return false;
      item.click();
      return true;
    };
    clickNav('技能');
    await waitFor(() => document.querySelector('.skills') !== null, 6000);
    await wait(300);
    const marketTab = [...document.querySelectorAll('.skills-tabs button')].find((button) => (button.textContent ?? '').includes('市场'));
    out.tabTexts = [...document.querySelectorAll('.skills-tabs button')].map((button) => (button.textContent ?? '').trim());
    out.skillsOpened = document.querySelector('.skills') !== null;
    if (!out.skillsOpened) {
      out.diag = {
        navTexts: [...document.querySelectorAll('.sidebar-nav .nav-item')].map((button) => (button.textContent ?? '').trim()),
        bodyHead: (document.body.innerText ?? '').slice(0, 160),
      };
      return out;
    }
    if (marketTab !== undefined) marketTab.click();
    const firstRow = await waitFor(() => document.querySelector('.market-row'), 12000);
    out.marketReady = firstRow !== null;
    out.marketRows = document.querySelectorAll('.market-row').length;
    out.t = { marketLoadedAt: Date.now() };

    // ④ 点 skills.sh chip：不该发请求，只出中性提示、把光标放进搜索框
    const chips = [...document.querySelectorAll('.market-sources .source-chip')];
    const chip = chips.find((button) => (button.textContent ?? '').trim() === 'skills.sh');
    out.chipLabels = chips.map((button) => (button.textContent ?? '').trim());
    out.chipFound = chip !== undefined;
    out.t.chipClickAt = Date.now();
    if (chip !== undefined) chip.click();
    await wait(600);
    const hint = document.querySelector('.market-hint');
    const errorBar = document.querySelector('.settings-note.error');
    const input = document.querySelector('.skills-search input');
    const rect = input === null ? null : input.getBoundingClientRect();
    const marketTabNow = [...document.querySelectorAll('.skills-tabs button')].find((button) => (button.textContent ?? '').includes('市场'));
    out.tabCount = marketTabNow === undefined ? null : marketTabNow.querySelectorAll('.count').length;
    out.skillssh = {
      chipFound: chip !== undefined,
      hintShown: hint !== null,
      hintText: hint === null ? null : (hint.textContent ?? '').trim(),
      errorBarShown: errorBar !== null,
      errorText: errorBar === null ? null : (errorBar.textContent ?? '').trim(),
      inputVisible: input !== null && rect !== null && rect.width > 0 && rect.height > 0,
      activeInSearch: input !== null && document.activeElement === input,
      placeholder: input === null ? null : input.getAttribute('placeholder'),
      rows: document.querySelectorAll('.market-row').length,
    };
    out.t.chipDoneAt = Date.now();
    out.endPhase = 'skillssh';

    // 截图前的稳定性采样：从点完 chip 到截图之间（约 20 秒）每 500ms 记一次「还停在 skills.sh 态吗」。
    // 为什么要有：本轮实测出现过「eval 里 .market-hint 明明在、截图却是对话页」——要么页面被谁
    // 切回对话页、要么 capturePage 拿到了旧帧。采样把这两种情况分开，读数留在 JSON 里。
    out.stability = [];
    for (let i = 0; i < 44; i += 1) {
      out.stability.push({
        at: Date.now(),
        skills: document.querySelector('.skills') !== null,
        hint: document.querySelector('.market-hint') !== null,
        rows: document.querySelectorAll('.market-row').length,
      });
      await wait(500);
    }
    out.finalState = out.stability[out.stability.length - 1];
    out.stabilityOk = out.stability.every((sample) => sample.skills && sample.hint);
  } catch (error) {
    out.error = (error && error.message) || String(error);
  }
  return out;
})()
'@
$swEval2 = $swEval2.Replace('__PORT__', [string]$swMarketPort)

# ── 启动一次桌面壳，等它写完截图 / 预跑脚本，返回 stderr 里的读数 JSON ──────────
function Invoke-ShotRun {
  param(
    [string]$Eval,
    [string]$Shot,
    [string]$Name,
    [int]$Lead,
    [int]$Delay
  )
  $env:DSC_DESKTOP_USER_DATA = Join-Path $swHome "electron-userdata-$Name"
  $env:USERPROFILE = $swHome
  $env:HOME = $swHome
  $env:DSC_DESKTOP_STATE = Join-Path $swDsc 'desktop.json'
  $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
  $env:DSC_DESKTOP_SHOT = $Shot
  $env:DSC_DESKTOP_SHOT_DELAY = [string]$Delay
  $env:DSC_DESKTOP_SHOT_EVAL_LEAD = [string]$Lead
  $env:DSC_DESKTOP_SHOT_EVAL = $Eval
  Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue
  Remove-Item Env:DSC_UI_QUERY -ErrorAction SilentlyContinue

  $outLog = Join-Path $swLogDir "$Name.out.log"
  $errLog = Join-Path $swLogDir "$Name.err.log"
  Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
  Write-Host ("── 启动 {0}：截图 {1}（eval 提前 {2}ms，截图延迟 {3}ms）" -f $Name, (Split-Path -Leaf $Shot), $Lead, $Delay)

  # 关掉 GPU 合成再开壳：这台机器的 GPU 合成不稳（本轮与上一轮都见过
  # `GPU state invalid after WaitForGetOffsetInRange` 与 `Current display surface not available
  #  for capture`），表现为 capturePage 偶尔拿到旧帧（DOM 已是市场列表、图还是对话页）。
  # 自检截图要的是「确定性的一帧」，软件合成足够，也免得把 GPU 抖动记成界面缺陷。
  $proc = Start-Process -FilePath $swElectron -ArgumentList @($swEntry, '--disable-gpu') -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $deadline = (Get-Date).AddSeconds([Math]::Ceiling($Delay / 1000) + 90)
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { break }
    if (Test-Path -LiteralPath $errLog) {
      $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|页面加载失败|截图失败|预跑脚本失败' -ErrorAction SilentlyContinue
      if ($null -ne $hit) { break }
    }
    Start-Sleep -Milliseconds 400
  }
  Start-Sleep -Milliseconds 900
  if (-not $proc.HasExited) {
    & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
    Start-Sleep -Milliseconds 500
  }
  if (Test-Path -LiteralPath $errLog) {
    Select-String -LiteralPath $errLog -Pattern '预跑脚本失败|页面加载失败|截图失败|截图超时' | ForEach-Object { '  ' + $_.Line.Trim() }
  }
  $json = $null
  if (Test-Path -LiteralPath $errLog) {
    $line = Select-String -LiteralPath $errLog -Pattern '预跑脚本完成：' | Select-Object -Last 1
    if ($null -ne $line) {
      $marker = '预跑脚本完成：'
      $raw = $line.Line.Substring($line.Line.IndexOf($marker) + $marker.Length).Trim()
      try { $json = $raw | ConvertFrom-Json } catch { $json = $null }
    }
  }
  return $json
}

# ── 一次运行带重试：宿主偶发起不来 / GPU 偶发拍不到，重试一次比整脚本报红干净 ──────
# 判据：既有预跑脚本读数、又有非空截图。两次都失败就把最后一次的读数原样交给断言层（它会 FAIL）。
function Invoke-ShotRunWithRetry {
  param(
    [string]$Eval,
    [string]$Shot,
    [string]$Name,
    [int]$Lead,
    [int]$Delay
  )
  $last = $null
  for ($attempt = 1; $attempt -le 2; $attempt += 1) {
    Remove-Item -LiteralPath $Shot -ErrorAction SilentlyContinue
    $last = Invoke-ShotRun -Eval $Eval -Shot $Shot -Name ("$Name-a$attempt") -Lead $Lead -Delay $Delay
    $shotOk = (Test-Path -LiteralPath $Shot) -and ((Get-Item -LiteralPath $Shot).Length -gt 10000)
    if ($null -ne $last -and $shotOk) { return $last }
    Write-Host ("  {0} 第 {1} 次没拿到读数或截图（json={2} shot={3}），2s 后重试" -f $Name, $attempt, ($null -ne $last), $shotOk)
    Start-Sleep -Milliseconds 2000
  }
  return $last
}

# ── 本地慢源 ────────────────────────────────────────────────────────────────────
$swServerLog = Join-Path $swLogDir 'market-server.log'
$swServerErr = Join-Path $swLogDir 'market-server.err.log'
$swServerProc = $null
$swR1 = $null
$swR2 = $null
$swBefore = $null
try {
  Write-Output '=== 真实 ~/.dsc 跑前指纹 ==='
  $swBefore = Get-DirFingerprint $swRealDsc
  Write-Output ("文件数 {0}（锁定 {1}）· 内容聚合 {2}" -f $swBefore.Count, $swBefore.Locked, $swBefore.ContentDigest)
  # 本次运行到底有没有往真实 home 写东西，另留三条「表征」证据（不依赖全量指纹，
  # 因为并行会话会写 audit/usage/checkpoints，全量指纹在不同步的环境里判不了）。
  $swRealDesktopPath = Join-Path $swRealDsc 'desktop.json'
  $swRealDesktopBefore = if (Test-Path -LiteralPath $swRealDesktopPath) { Get-Content -LiteralPath $swRealDesktopPath -Raw } else { $null }

  $swServerProc = Start-Process -FilePath 'node' -ArgumentList "$swServerScript $swMarketPort $swHitsLog" -PassThru -RedirectStandardOutput $swServerLog -RedirectStandardError $swServerErr
  $swServerReady = $false
  for ($i = 0; $i -lt 40; $i += 1) {
    try {
      $doc = Invoke-RestMethod -Uri "http://127.0.0.1:$swMarketPort/hits" -TimeoutSec 1
      if ($null -ne $doc) { $swServerReady = $true; break }
    } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $swServerReady) {
    if (Test-Path -LiteralPath $swServerErr) { Get-Content -LiteralPath $swServerErr | ForEach-Object { '  ' + $_ } }
    throw '本地慢源起不来（/hits 连不上）'
  }
  Write-Output ("本地慢源就绪：http://127.0.0.1:{0}/index.json" -f $swMarketPort)

  # Run 1：eval 在截图前 30s 开始跑、截图在 did-finish-load 后 55s —— eval 正常 ~8s，
  # 打不开技能页会 fail-fast（≤7s），所以 25s 余量足够，也不会把对话页拍进去。
  $swR1 = Invoke-ShotRunWithRetry -Eval $swEval1 -Shot $swShot1 -Name 'run1-market' -Lead 30000 -Delay 55000
  $swHits1 = @(Read-HitTimes $swHitsLog)
  # Run 2：点完 skills.sh chip 后在页面里采样 ~22s 直到截图前，确认截图拍的就是 skills.sh 态。
  $swR2 = Invoke-ShotRunWithRetry -Eval $swEval2 -Shot $swShot2 -Name 'run2-skillssh' -Lead 30000 -Delay 62000
  $swHits2 = @(Read-HitTimes $swHitsLog)
} finally {
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_USER_DATA,
    Env:DSC_DESKTOP_STATE, Env:USERPROFILE, Env:HOME -ErrorAction SilentlyContinue
  if ($null -ne $swServerProc -and -not $swServerProc.HasExited) {
    & taskkill /PID $swServerProc.Id /T /F 2>&1 | Out-Null
  }
}

# ── 断言 ───────────────────────────────────────────────────────────────────────
$swFail = 0
$swTotal = 0
function Check($Name, $Ok, $Detail = '') {
  $script:swTotal += 1
  if ($Ok) { Write-Output "  PASS  $Name" }
  else { $script:swFail += 1; Write-Output "  FAIL  $Name$(if ($Detail -ne '') { " — $Detail" })" }
}

Check 'Run 1 预跑脚本返回了读数' ($null -ne $swR1) ($swR1 | ConvertTo-Json -Compress)
if ($null -ne $swR1) {
  Check 'Run 1 没有脚本内异常' ($null -eq $swR1.error) ([string]$swR1.error)
  Check '点侧栏「技能」能打开技能页' ($swR1.navOpened -eq $true)
  Check '技能页真的渲染出来了（.skills 出现且停在技能页）' ($swR1.skillsOpened -eq $true) (($swR1.diag | ConvertTo-Json -Compress))
  Check '技能页两个 tab 都在（已安装 / 市场）' ($null -ne $swR1.tabCounts -and $swR1.tabCounts.installedTabFound -eq $true -and $swR1.tabCounts.marketTabFound -eq $true) ("tabTexts=" + ($swR1.tabTexts -join '|'))
  Check '市场 tab 按钮里没有 .count 计数徽章' ($null -ne $swR1.tabCounts -and $swR1.tabCounts.market -eq 0) (("tabTexts=" + ($swR1.tabTexts -join '|') + ' / ' + ($swR1.tabCounts | ConvertTo-Json -Compress)))
  Check '已安装 tab 按钮里仍有 .count（只删了市场那个）' ($null -ne $swR1.tabCounts -and $swR1.tabCounts.installed -ge 1) (("tabTexts=" + ($swR1.tabTexts -join '|') + ' / ' + ($swR1.tabCounts | ConvertTo-Json -Compress)))
  Check '首次点市场 tab 出条目（≤8000ms，本地源延迟 800ms）' ($null -ne $swR1.firstOpenMs -and $swR1.firstOpenMs -le 8000 -and $swR1.firstRows -ge 1) ("firstOpenMs=$($swR1.firstOpenMs) rows=$($swR1.firstRows)")
  Check '首条逻辑上是本地慢源的技能' ($null -ne $swR1.firstRowText -and ([string]$swR1.firstRowText).Contains('slow-skill')) ([string]$swR1.firstRowText)
  # 命中次数从慢源日志按 eval 记下的毫秒时间戳数：N1 = 首条出现前联网几次；N2 = 二次打开后
  # 累计几次；二次窗口内必须是 0。这样「缓存命中、没走网络」有服务端证据，不靠界面自述。
  $swT = if ($null -ne $swR1) { $swR1.t } else { $null }
  $swN1 = if ($null -ne $swT) { Count-HitsUpTo $swHits1 ([double]$swT.firstRowAt) } else { 0 }
  $swN2 = if ($null -ne $swT) { Count-HitsUpTo $swHits1 ([double]$swT.secondRowAt) } else { 0 }
  $swSecondWindow = if ($null -ne $swT) { Count-HitsBetween $swHits1 ([double]$swT.secondOpenStart - 20) ([double]$swT.secondRowAt + 20) } else { -1 }
  Check '首次加载确实打过源（N1 ≥ 1，后面的「不再联网」才有意义）' ($null -ne $swT -and $swN1 -ge 1) ("N1=$swN1 本次总命中=$($swHits1.Count) t=$($swT | ConvertTo-Json -Compress)")
  Check '离开技能页再回来：市场条目 ≤300ms 出现（客户端缓存命中）' ($null -ne $swR1.secondOpenMs -and $swR1.secondOpenMs -le 300) ("secondOpenMs=$($swR1.secondOpenMs) rows=$($swR1.secondRows)")
  Check '二次打开期间 /index.json 命中 0 次（N2 = N1，真的没走网络）' ($null -ne $swT -and $swN2 -eq $swN1 -and $swSecondWindow -eq 0) ("N1=$swN1 N2=$swN2 二次窗口内=$swSecondWindow")
  Write-Output ("  读数：首次 {0}ms / 二次 {1}ms / 命中 N1={2} N2={3}（二次窗口内 {4} 次）/ 本次总命中 {5}" -f $swR1.firstOpenMs, $swR1.secondOpenMs, $swN1, $swN2, $swSecondWindow, $swHits1.Count)
}
$swShot1Info = if (Test-Path -LiteralPath $swShot1) { Get-Item -LiteralPath $swShot1 } else { $null }
Check '截图 1（市场列表）存在且非空' ($null -ne $swShot1Info -and $swShot1Info.Length -gt 10000) ("$swShot1 -> $(if ($null -eq $swShot1Info) { '缺失' } else { $swShot1Info.Length.ToString() + ' 字节' })")

Check 'Run 2 预跑脚本返回了读数' ($null -ne $swR2) ($swR2 | ConvertTo-Json -Compress)
if ($null -ne $swR2) {
  Check 'Run 2 没有脚本内异常' ($null -eq $swR2.error) ([string]$swR2.error)
  Check 'Run 2 技能页真的打开了（.skills 出现）' ($swR2.skillsOpened -eq $true) (($swR2.diag | ConvertTo-Json -Compress))
  Check 'Run 2 市场列表先正常加载出来' ($swR2.marketReady -eq $true) ("rows=$($swR2.marketRows)")
  Check '源 chip 里有 skills.sh 与自检源' ($null -ne $swR2.chipLabels -and ($swR2.chipLabels -contains 'skills.sh') -and ($swR2.chipLabels -contains '自检源')) (($swR2.chipLabels -join ','))
  Check '点 skills.sh chip 后出现中性提示 .market-hint' ($null -ne $swR2.skillssh -and $swR2.skillssh.hintShown -eq $true) (($swR2.skillssh | ConvertTo-Json -Compress))
  Check '红条 .settings-note.error 不出现' ($null -ne $swR2.skillssh -and $swR2.skillssh.errorBarShown -eq $false) ([string]$swR2.skillssh.errorText)
  Check '搜索输入框可见（skills.sh 的取词入口保留）' ($null -ne $swR2.skillssh -and $swR2.skillssh.inputVisible -eq $true) ([string]$swR2.skillssh.placeholder)
  Check '点 skills.sh 后列表不再显示其它源的条目（点源没发请求、也没残留旧列表）' ($null -ne $swR2.skillssh -and $swR2.skillssh.rows -eq 0) ("rows=$($swR2.skillssh.rows)")
  $swT2 = if ($null -ne $swR2) { $swR2.t } else { $null }
  $swChipBefore = if ($null -ne $swT2) { Count-HitsUpTo $swHits2 ([double]$swT2.chipClickAt) } else { 0 }
  $swChipAfter = if ($null -ne $swT2) { Count-HitsUpTo $swHits2 ([double]$swT2.chipDoneAt) } else { -1 }
  $swChipWindow = if ($null -ne $swT2) { Count-HitsBetween $swHits2 ([double]$swT2.chipClickAt - 20) ([double]$swT2.chipDoneAt + 20) } else { -1 }
  Check '点 skills.sh chip 没有触发 /index.json（窗口内 0 次、前后读数一致）' ($null -ne $swT2 -and $swChipWindow -eq 0 -and $swChipAfter -eq $swChipBefore) ("before=$swChipBefore after=$swChipAfter 窗口内=$swChipWindow")
  Write-Output ("  读数：提示「{0}」/ 焦点在搜索框={1} / 命中 before={2} after={3}（点 chip 窗口内 {4} 次）" -f $swR2.skillssh.hintText, $swR2.skillssh.activeInSearch, $swChipBefore, $swChipAfter, $swChipWindow)
  Check 'Run 2 从点完 chip 到截图前一直停在 skills.sh 态（采样覆盖，页面没被切回对话页）' ($swR2.stabilityOk -eq $true -and $null -ne $swR2.finalState -and $swR2.finalState.skills -eq $true -and $swR2.finalState.hint -eq $true) ("samples=$(if ($null -eq $swR2.stability) { 0 } else { @($swR2.stability).Count }) final=$(if ($null -eq $swR2.finalState) { 'null' } else { $swR2.finalState | ConvertTo-Json -Compress })")
}
$swShot2Info = if (Test-Path -LiteralPath $swShot2) { Get-Item -LiteralPath $swShot2 } else { $null }
Check '截图 2（skills.sh 搜索态）存在且非空' ($null -ne $swShot2Info -and $swShot2Info.Length -gt 10000) ("$swShot2 -> $(if ($null -eq $swShot2Info) { '缺失' } else { $swShot2Info.Length.ToString() + ' 字节' })")

# ── 真实 ~/.dsc 零污染 ─────────────────────────────────────────────────────────
Write-Output '=== 真实 ~/.dsc 跑后指纹 ==='
$swAfter = Get-DirFingerprint $swRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 内容聚合 {2}" -f $swAfter.Count, $swAfter.Locked, $swAfter.ContentDigest)
$swDiff = Compare-Object -ReferenceObject $swBefore.Lines -DifferenceObject $swAfter.Lines
if ($null -eq $swDiff) { Write-Output '差异行：无（逐文件哈希完全一致）' }
else { Write-Output ("差异行：{0} 条" -f @($swDiff).Count); $swDiff | Select-Object -First 10 | ForEach-Object { '  ' + $_.SideIndicator + ' ' + $_.InputObject } }
Check '真实 ~/.dsc 零污染（文件数 + 内容聚合一致）' ($swBefore.Count -eq $swAfter.Count -and $swBefore.ContentDigest -eq $swAfter.ContentDigest)
$swRealExists = Test-Path -LiteralPath $swRealDsc
Check '真实 ~/.dsc 存在时确实扫到了文件（指纹不是空转）' ((-not $swRealExists) -or $swBefore.Count -ge 1) ("exists=$swRealExists count=$($swBefore.Count)")

# 全量指纹在「别的会话正在写真实 home」时判不了（audit.jsonl / usage / checkpoints 都会被写），
# 所以另钉三条「本次自检痕迹」：desktop.json 内容没变、真实 home 里没有隔离工作区的会话、
# 没有指向本地慢源（17461）的市场缓存。这三条过了，能证明本次运行没往真实 home 落东西。
$swRealDesktopAfter = if (Test-Path -LiteralPath $swRealDesktopPath) { Get-Content -LiteralPath $swRealDesktopPath -Raw } else { $null }
Check '真实 ~/.dsc/desktop.json 内容没被本次自检改动' ([string]$swRealDesktopBefore -eq [string]$swRealDesktopAfter) ("before=$(if ($null -eq $swRealDesktopBefore) { '缺失' } else { $swRealDesktopBefore.Length.ToString() + ' 字节' }) after=$(if ($null -eq $swRealDesktopAfter) { '缺失' } else { $swRealDesktopAfter.Length.ToString() + ' 字节' })")
$swTraceFiles = @(Get-ChildItem -LiteralPath $swRealDsc -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like '*skills-market-home*' })
Check '真实 ~/.dsc 里没有隔离工作区（skills-market-home）的会话痕迹' ($swTraceFiles.Count -eq 0) (($swTraceFiles | Select-Object -First 3 -ExpandProperty FullName) -join ' | ')
$swRealCacheDir = Join-Path $swRealDsc 'cache'
$swRealMarket = @(Get-ChildItem -LiteralPath $swRealCacheDir -File -Filter 'market-*.json' -ErrorAction SilentlyContinue | Where-Object { $null -ne (Select-String -LiteralPath $_.FullName -Pattern '127.0.0.1:17461' -SimpleMatch -ErrorAction SilentlyContinue) })
Check '真实 ~/.dsc/cache 里没有指向本地慢源（17461）的市场缓存' ($swRealMarket.Count -eq 0) (($swRealMarket | Select-Object -First 3 -ExpandProperty FullName) -join ' | ')

Write-Output ("截图输出目录：{0}" -f $swOutDir)
if ($swFail -eq 0) { Write-Output ("skills-market-check 完成：{0} 条断言全部通过" -f $swTotal) }
else { Write-Output ("skills-market-check 完成：{0}/{1} 条断言失败" -f $swFail, $swTotal); exit 1 }
exit 0
