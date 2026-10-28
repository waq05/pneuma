# 界面形态切换自检（阶段 5.0 立起，5.6 扩成四用例）：证明开关与默认值真的决定宿主伺服哪份界面。
#
# 四个用例跑同一个构建产物，只差 DSC_UI_SHELL 与壳产物是否在场：
#   ui-default  无开关无档案 → 默认走壳（5.6 翻转 DEFAULT_UI_PROFILE 的验收证据）
#   ui-shell    DSC_UI_SHELL=1 → 强制壳（直通开关仍有效）
#   ui-legacy   DSC_UI_SHELL=0 → 显式退回旧渲染层 out/renderer（文档里是 /assets/index-*.js）
#   ui-fallback DSC_UI_SHELL=1 且壳产物目录被临时挪走 → 存在性闸退回旧渲染层（stderr 有「插件壳产物不存在」）
#
# 判定不看「绿不绿」，看三样证据：① stderr 的「界面形态=…，宿主伺服 …」那一行；
# ② stderr 的「窗口来自宿主界面服务 …」；③ 页面里真正加载的入口脚本名（预跑脚本回传）。
# 隔离照旧：DSC_DESKTOP_USER_DATA 换 userData、USERPROFILE/HOME 换掉宿主 ~/.dsc，
# 跑前跑后对真实 ~/.dsc 做「文件数 + 内容聚合 SHA256」比对。
#
# 用法（先在 desktop/ 跑 `pnpm run build`）：
#   pwsh -NoProfile -File ui-shell-switch.ps1

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$swShots = 'D:\dsc\desktop\shots'
$swElectron = Join-Path $swShots '..\node_modules\electron\dist\electron.exe'
$swEntry = Join-Path $swShots '..\out\main\index.js'
$swHome = Join-Path $swShots 'shell-switch-home'
$swRealDsc = Join-Path $env:USERPROFILE '.dsc'

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

$swEval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = pred(); if (v) return v; await wait(120); }
    return null;
  };
  await waitFor(() => {
    const root = document.querySelector('#root');
    return root !== null && root.children.length > 0;
  }, 20000);
  await wait(2000);
  const root = document.querySelector('#root');
  const scripts = Array.from(document.scripts).map((s) => s.src).filter(Boolean);
  const boot = globalThis.__DSC_BOOT__;
  const nativeLine = document.querySelector('.diag-line[data-native]');
  // ── 原生桥的终端试点（只有桌面窗口里有桥）──
  // 真的起一个 shell、喂一行、收输出、再关掉；顺带确认 dock 那几个 op 不在这条桥上。
  let terminal = null;
  let dockOnBridge = null;
  if (typeof globalThis.dscNative === 'object' && globalThis.dscNative !== null) {
    try {
      const spawned = await globalThis.dscNative.call('terminal', ['term-spawn', { cwd: '.', shell: 'pwsh' }]);
      const chunks = [];
      const off = globalThis.dscNative.on('dock-data', (data) => {
        if (data !== null && typeof data === 'object' && data.id === spawned.id) chunks.push(String(data.data));
      });
      await wait(900);
      await globalThis.dscNative.call('terminal', ['term-input', { id: spawned.id, data: 'echo dsc-native-term\r\n' }]);
      await wait(1800);
      await globalThis.dscNative.call('terminal', ['term-kill', { id: spawned.id }]);
      off();
      const text = chunks.join('');
      terminal = {
        id: spawned.id,
        shell: spawned.shell,
        bytes: text.length,
        echoed: text.indexOf('dsc-native-term') >= 0,
      };
    } catch (error) {
      terminal = { error: error && error.message ? error.message : String(error) };
    }
    try {
      await globalThis.dscNative.call('dock', ['fs-list', { dir: '.' }]);
      dockOnBridge = 'unexpected-ok';
    } catch (error) {
      dockOnBridge = error && error.message ? error.message : String(error);
    }
  }
  // ── 终端插件：点开工作区面板 → 头条切「终端」→ 启动一个 shell → 读面板自己的状态行 ──
  // 只在壳上跑（旧渲染层有它自己的 dock，标签与结构都不一样，探它不是这里的事）。
  let dock = null;
  if (document.querySelector('.slot-entry') !== null) {
    try {
      const chipsOf = () => Array.from(document.querySelectorAll('.dock-strip .dock-chip'));
      const chipByText = (text) => chipsOf().find((b) => (b.textContent ?? '').trim() === text);
      if (document.querySelector('.dock-strip') === null) {
        // 收起态：顶栏那颗总开合钮先点开（展开后它就不在了，由头条尾的收起钮接管）。
        const toggle = document.querySelector('.icon-btn.dock-toggle');
        if (toggle === null) { dock = { error: '顶栏没有工作区面板开合钮' }; }
        else { toggle.click(); await wait(500); }
      }
      if (dock === null) {
        const termChip = chipByText('终端');
        if (termChip === undefined) {
          dock = { error: '面板头条没有终端页签' };
        } else {
          termChip.click();
          await wait(700);
          const opened = document.querySelector('.dock .term-host .xterm') !== null;
          const noteOf = () => document.querySelector('.term-bar .shell-term-note[data-tone]');
          const startBtn = Array.from(document.querySelectorAll('.term-bar button')).find(
            (b) => (b.textContent ?? '').trim() === '启动',
          );
          if (startBtn !== undefined) startBtn.click();
          const ready = await waitFor(() => {
            const n = noteOf();
            return n !== null && /已就绪/.test(n.textContent ?? '') ? n : null;
          }, 9000);
          const readyText = ready === null ? null : ready.textContent.trim();
          const stopBtn = Array.from(document.querySelectorAll('.term-bar button')).find(
            (b) => (b.textContent ?? '').trim() === '结束',
          );
          if (stopBtn !== undefined) stopBtn.click();
          await wait(500);
          const afterStop = noteOf();
          dock = {
            chips: chipsOf().map((b) => (b.textContent ?? '').trim()),
            panelMounted: opened,
            xterm: document.querySelector('.term-host .xterm') !== null,
            ready: ready !== null,
            readyText,
            afterStop: afterStop === null ? null : afterStop.textContent.trim(),
            rows: document.querySelectorAll('.xterm-rows > div').length,
          };
        }
      }
    } catch (error) {
      dock = { error: error && error.message ? error.message : String(error) };
    }
  }
  // ── 文件面板：切「文件」页签 → 点一个文件 → 自动切到「预览」页签整块显示 ──
  // （点文件 → setDockPreview + setDockPanel('preview')，旧界面开 preview 页签的同款行为。）
  let files = null;
  if (document.querySelector('.slot-entry') !== null) {
    try {
      const chipByText = (text) =>
        Array.from(document.querySelectorAll('.dock-strip .dock-chip')).find((b) => (b.textContent ?? '').trim() === text);
      const fileChip = chipByText('文件');
      if (fileChip === undefined) {
        files = { error: '面板头条没有文件页签' };
      } else {
        fileChip.click();
        const rows = await waitFor(() => {
          const list = document.querySelectorAll('.files-list .file-row');
          return list.length > 0 ? list : null;
        }, 8000);
        const names = rows === null ? [] : Array.from(rows).map((r) => (r.querySelector('.file-name') ?? {}).textContent);
        // 挑一个**文本类**文件点开（目录点了只会展开；二进制的预览是占位）。
        const pick = rows === null ? null : Array.from(rows).find((r) => /\.(md|txt|json|ts|js|tsx|log)$/.test((r.querySelector('.file-name') ?? {}).textContent ?? ''));
        if (pick !== null && pick !== undefined) pick.click();
        const preview = await waitFor(() => document.querySelector('.file-preview-body'), 8000);
        files = {
          cwd: (document.querySelector('.files-cwd') ?? {}).textContent?.trim() ?? null,
          names,
          activeChip: Array.from(document.querySelectorAll('.dock-strip .dock-chip'))
            .filter((b) => b.classList.contains('on'))
            .map((b) => (b.textContent ?? '').trim()),
          previewPath: (document.querySelector('.file-preview-path') ?? {}).textContent?.trim() ?? null,
          previewLines: document.querySelectorAll('.file-code-plain .line').length,
          systemButtonEnabled: (document.querySelector('.file-preview-head button') ?? {}).disabled === false,
          note: preview === null ? '预览区没出现' : '',
        };
      }
    } catch (error) {
      files = { error: error && error.message ? error.message : String(error) };
    }
  }
  return {
    href: location.href,
    title: document.title,
    bootGlobal: typeof boot,
    bootEntries: boot && boot.entries ? boot.entries.length : -1,
    slotEntries: document.querySelectorAll('.slot-entry').length,
    rootChildren: root ? root.children.length : -1,
    scripts,
    looksLikeShell: scripts.some((s) => /\/app-[A-Za-z0-9_-]+\.js$/.test(s)),
    looksLikeLegacy: scripts.some((s) => /\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(s)),
    native: nativeLine === null
      ? null
      : {
          state: nativeLine.getAttribute('data-native'),
          probe: nativeLine.getAttribute('data-native-probe'),
          text: (nativeLine.textContent ?? '').trim(),
        },
    terminal,
    dockOnBridge,
    dock,
    files,
  };
})()
'@

Write-Output '=== 真实 ~/.dsc 跑前指纹 ==='
$swBefore = Get-DirFingerprint $swRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 内容聚合 {2}" -f $swBefore.Count, $swBefore.Locked, $swBefore.ContentDigest)

$swCases = [ordered]@{ 'ui-default' = '__unset__'; 'ui-shell' = '1'; 'ui-legacy' = '0'; 'ui-fallback' = '1' }
$swAssets = 'D:\dsc\lib\ui\assets'
$swAssetsAway = 'D:\dsc\lib\ui\assets.fallback-test'

try {
  foreach ($name in $swCases.Keys) {
    $env:DSC_DESKTOP_USER_DATA = Join-Path $swHome 'electron-userdata'
    $env:USERPROFILE = $swHome
    $env:HOME = $swHome
    $env:DSC_DESKTOP_SHOT_TOPMOST = '1'
    $env:DSC_DESKTOP_SHOT = Join-Path $swShots "$name.png"
    $env:DSC_DESKTOP_SHOT_DELAY = '22000'
    $env:DSC_DESKTOP_SHOT_EVAL_LEAD = '18000'
    $env:DSC_DESKTOP_SHOT_EVAL = $swEval
    # 诊断区在用户视野里默认不常显（旧界面没有这东西）；自检要读它的 DOM（原生桥读数），
    # 走 diag=1 强制常显——壳的读数面不变。
    $env:DSC_UI_QUERY = 'diag=1'
    if ($swCases[$name] -eq '__unset__') { Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue }
    else { $env:DSC_UI_SHELL = $swCases[$name] }

    # ui-fallback：把壳产物目录临时挪走，逼「profile=shell 但产物缺失」这条回落路。
    # finally 里一定挪回来；万一脚本被强杀中断，手动把 assets.fallback-test 改回 assets 即可。
    $swMoved = $false
    if ($name -eq 'ui-fallback') {
      if (Test-Path -LiteralPath $swAssets) { Rename-Item -LiteralPath $swAssets -NewName 'assets.fallback-test'; $swMoved = $true }
    }

    $outLog = Join-Path $swShots "$name.out.log"
    $errLog = Join-Path $swShots "$name.err.log"
    Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
    Write-Output "=== $name（DSC_UI_SHELL=$($swCases[$name])，隔离目录 $swHome）==="

    try {
      $swProc = Start-Process -FilePath $swElectron -ArgumentList $swEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
      $swDeadline = (Get-Date).AddSeconds(70)
      while ((Get-Date) -lt $swDeadline) {
        if (Test-Path -LiteralPath $errLog) {
          $hit = Select-String -LiteralPath $errLog -Pattern '已写出|截图超时|页面加载失败|截图失败' -ErrorAction SilentlyContinue
          if ($null -ne $hit) { break }
        }
        if ($swProc.HasExited) { break }
        Start-Sleep -Milliseconds 500
      }
      & taskkill /PID $swProc.Id /T /F 2>&1 | Out-Null
      Start-Sleep -Milliseconds 600
    } finally {
      if ($swMoved) { Rename-Item -LiteralPath $swAssetsAway -NewName 'assets' }
    }

    if (Test-Path -LiteralPath $errLog) {
      Select-String -LiteralPath $errLog -Pattern '界面形态=|插件壳产物不存在|窗口来自宿主界面服务|预跑脚本完成|预跑脚本失败|已写出|页面加载失败|截图失败' |
        ForEach-Object { '  ' + $_.Line.Trim() }
    }
  }
} finally {
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_USER_DATA,
    Env:DSC_UI_SHELL, Env:DSC_UI_QUERY -ErrorAction SilentlyContinue
}

Write-Output '=== 真实 ~/.dsc 跑后指纹 ==='
$swAfter = Get-DirFingerprint $swRealDsc
Write-Output ("文件数 {0}（锁定 {1}）· 内容聚合 {2}" -f $swAfter.Count, $swAfter.Locked, $swAfter.ContentDigest)
$swDiff = Compare-Object -ReferenceObject $swBefore.Lines -DifferenceObject $swAfter.Lines
if ($null -eq $swDiff) { Write-Output '差异行：无（逐文件哈希完全一致）' }
else { Write-Output ("差异行：{0} 条" -f @($swDiff).Count); $swDiff | Select-Object -First 10 | ForEach-Object { '  ' + $_.SideIndicator + ' ' + $_.InputObject } }
Write-Output ("文件数一致：{0}；内容聚合一致：{1}" -f ($swBefore.Count -eq $swAfter.Count), ($swBefore.ContentDigest -eq $swAfter.ContentDigest))
Write-Output '全部完成'
