# 第八批专项自检（2026-10-12；2026-10-13 状态面板重做后同步改断言；2026-10-13 补
# Git/计划两区断言与「任务条 / 团队钮已撤」的去重断言）：对话流的三处修补 +
# 两根输入旋钮 + 状态面板（同一壳收展 / 聚焦窗口 / 已结束目录 / 分区折叠 / 七分区）。
#
# 分五段（一条 eval 里跑完）：
#   A. 历史重放：整轮展开后阶段组的「N 项 + 常显箭头」；组体收起时**真的**收起来（高度 0）；
#      思考块收起时正文不在 DOM 里（点开→正文出现→再点→消失）。
#   B. 输入区两根旋钮：模式（权限）菜单四项、点一项能切（旋钮文案跟着变）；
#      预设菜单能开且**输入框还在**（上一批点它是整块崩掉、输入框消失）。
#   C. 假端点实跑一轮（慢速长思考 + todo_write + read）：直播中的思考块点收起后
#      **保持收起**且 DOM 节点身份不变（这就是「流式抽搐 + 关不掉」两条的回归判据）。
#   D. 状态面板：进程读数 1/3、三条胶囊行（≤6 条不折叠）；收工的队友折成
#      「已结束 · 1 ›」一行，点它打开团队面板；分区点标题能收起 / 展开（体高 0）；
#      「收起为胶囊」与点胶囊回来走的是**同一棵 DOM**（data-expanded 0↔1）；
#      本轮补：Git 工具区（种子 ws-c 起成真 git 仓库：一处追加 + 一个未跟踪文件）、
#      计划区（种子里一份计划，默认收起→点开→列出→收回）、去重（.task-dock / .team-btn
#      不在，清空清单钮搬进进程区）。
#   E. 第二轮（假端点把清单换成八项）：>6 条启用聚焦窗口——前后各一个折叠桶、
#      窗口 3 条且含进行中项；悬停前桶出预览卡（整桶 4 条）。
#
# 隔离：USERPROFILE/HOME + DSC_DESKTOP_STATE + DSC_DESKTOP_USER_DATA 全钉在隔离目录；
# 跑前跑后对真实 ~/.dsc 做「文件数 + 内容聚合 SHA256」比对。
#
# 用法：pwsh -NoProfile -File ui-batch8-check.ps1（宿主 lib 与壳产物需已构建：
#       pnpm run build + pnpm run build:ui + desktop 的 pnpm run build）

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$swShots = 'D:\dsc\desktop\shots'
# 默认跑 dev 形态（electron.exe + out/main/index.js）。设 DSC_CHECK_EXE 指到打包好的 exe
# 时改成直接跑那份包（不传入口参数）——验证「用户双击快捷方式启动的那个包」里的界面产物
# 确实是新的（打包会按 prepare-runtime.mjs 把整个 lib/ 拷进 resources/dsc-core）。
$swElectron = if ($env:DSC_CHECK_EXE) { $env:DSC_CHECK_EXE } else { Join-Path $swShots '..\node_modules\electron\dist\electron.exe' }
$swEntry = if ($env:DSC_CHECK_ENTRY) { $env:DSC_CHECK_ENTRY } elseif ($env:DSC_CHECK_EXE) { '' } else { Join-Path $swShots '..\out\main\index.js' }
$swTag = if ($env:DSC_CHECK_TAG) { $env:DSC_CHECK_TAG } else { 'batch8' }
$swHome = Join-Path $swShots 'batch8-home'
$swDsc = Join-Path $swHome '.dsc'
$swRealDsc = Join-Path $env:USERPROFILE '.dsc'
$swWsC = Join-Path $swHome 'ws-c'
$swPort = 18928
$swFake = Join-Path $swShots '_batch8-fake-llm.mjs'

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

$swRealBefore = if (Test-Path -LiteralPath $swRealDsc) { Get-DirFingerprint $swRealDsc } else { $null }

# ── 种子：一个工作区 + 一条定稿会话（工具与思考齐全，供分组与思考块的历史重放）────────
Remove-Item -Recurse -Force -LiteralPath $swHome -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $swDsc, $swWsC, (Join-Path $swHome 'AppData\Roaming') | Out-Null

Set-Content -LiteralPath (Join-Path $swWsC 'marker-ws-c.txt') -Value 'ws' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $swWsC 'readme.txt') -Value "第一行：这是第八批自检的工作区说明。`n第二行：假端点会读这个文件一次。" -Encoding UTF8

# ws-c 起成一个**真 git 仓库**（状态面板「Git 工具」区与计划目录的读数都按它来）：
# 一次提交后追加一行 readme、留一个未跟踪文件——种子态读数是「+2 −0 / 脏 2」
# （追加的那 1 行 + 未跟踪文件按内容行数算的 1 行；未跟踪文件也进 dirtyFileCount）。
# `.dsc/` 在 .gitignore 里，免得计划种子把「脏文件数」这个确定数搅掉。
# core.autocrlf 显式关掉：让提交与工作区逐字节一致，增删行数才是确定数。
Push-Location -LiteralPath $swWsC
try {
  git init --quiet
  git config core.autocrlf false
  git config user.email selfcheck@local
  git config user.name selfcheck
  Set-Content -LiteralPath (Join-Path $swWsC '.gitignore') -Value '.dsc/' -Encoding UTF8
  git add . | Out-Null
  git commit --quiet -m 'seed'
  Add-Content -LiteralPath (Join-Path $swWsC 'readme.txt') -Value '第三行：这条是自检加的改动。' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $swWsC 'dirty-new.txt') -Value 'untracked' -Encoding UTF8
} finally {
  Pop-Location
}
# 计划目录种子（第 12 轮改口径：面板「计划」区读会话账、不扫盘）：
#   - 账里那条计划（会话 jsonl 里的 plans 状态条目，见下面的 $swLines）指向这份落盘文件；
#   - 「旧计划」那份只在工作区里、不在账里——面板不该列出它（扫盘方案会漏出去的证据）。
New-Item -ItemType Directory -Force -Path (Join-Path $swWsC '.dsc\plans') | Out-Null
Set-Content -LiteralPath (Join-Path $swWsC '.dsc\plans\20260101-0100-自检计划.md') -Encoding utf8NoBOM -Value "# 自检计划甲`n`n第一条：这是自检种下的计划文件。"
Set-Content -LiteralPath (Join-Path $swWsC '.dsc\plans\20251231-2300-旧计划.md') -Encoding utf8NoBOM -Value "# 不该出现的旧计划`n`n更早留下的，不属于任何会话。"

$swKeyC = ($swWsC -replace '[:\\/]+', '-')
New-Item -ItemType Directory -Force -Path (Join-Path $swDsc "sessions\$swKeyC") | Out-Null

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$swUuid1 = 'd8888888-9999-aaaa-bbbb-cccccccccccc'
$swMarker = ($swWsC -replace '\\', '\\')

Set-Content -LiteralPath (Join-Path $swDsc 'config.yaml') -Encoding utf8NoBOM -Value @"
# 自检专用配置：一个指向本机假端点的 provider（不联网、不花钱）
default:
  provider: fake
  model: fake-flow
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:$swPort/v1
    apiKeyEnv: DSC_FAKE_KEY
    models:
      - id: fake-flow
        name: Fake Flow
        contextWindow: 128000
        maxTokens: 4096
"@
$env:DSC_FAKE_KEY = 'sk-selfcheck-fake'

$swLines = New-Object System.Collections.Generic.List[string]
$swLines.Add("{""type"":""meta"",""id"":""$swUuid1"",""cwd"":""$swMarker"",""createdAt"":$now}")
$swLines.Add("{""type"":""user"",""text"":""第八批自检第一轮：先说思路，再读文件。"",""ts"":$($now + 1000)}")
$swLines.Add("{""type"":""assistant"",""text"":"""",""reasoning"":""先想清楚要做什么。\n\n再看工作区。"",""ts"":$($now + 1500)}")
$swLines.Add("{""type"":""assistant"",""text"":"""",""toolCalls"":[{""id"":""b1"",""name"":""read"",""arguments"":""{\""path\"":\""marker-ws-c.txt\""}""}],""ts"":$($now + 2000)}")
$swLines.Add("{""type"":""tool"",""callId"":""b1"",""name"":""read"",""text"":""ws 一行"",""ts"":$($now + 2200)}")
$swLines.Add("{""type"":""assistant"",""text"":""第一轮答完了。"",""ts"":$($now + 3000)}")
$swLines.Add("{""type"":""user"",""text"":""第八批自检第二轮：再想一次。"",""ts"":$($now + 4000)}")
$swLines.Add("{""type"":""assistant"",""text"":"""",""reasoning"":""这一轮只需要一句话。\n\n那就直接说。"",""ts"":$($now + 4500)}")
$swLines.Add("{""type"":""assistant"",""text"":""第二轮也答完了。"",""ts"":$($now + 5500)}")
# 计划账（面板「计划」区按会话读它；file 双写反斜杠是 JSON 转义，$swMarker 已是双写形态）：
$swLines.Add("{""type"":""state"",""id"":""plans"",""payload"":{""items"":[{""file"":""$swMarker\\.dsc\\plans\\20260101-0100-自检计划.md"",""title"":""自检计划甲"",""at"":$($now - 3600000),""decision"":""approved""}]}}")
$swFile = Join-Path $swDsc "sessions\$swKeyC\$swUuid1.jsonl"
Set-Content -LiteralPath $swFile -Encoding utf8NoBOM -Value ($swLines -join "`n")

# 会话索引与桌面记忆：**两份都得写**——不写 meta.json 宿主不会把这条会话列进侧栏
# （启动时会按索引重写它，种子的 jsonl 就成了孤儿）；不写 desktop.json 的 lastCwd，
# 宿主会以隔离 HOME 当工作目录起，侧栏里连 ws-c 这个分组都没有。
Set-Content -LiteralPath (Join-Path $swDsc 'sessions\meta.json') -Encoding UTF8 -Value (@{
  version = 1
  sessions = @{ $swUuid1 = @{ title = '第八批自检会话' } }
} | ConvertTo-Json -Depth 4)

Set-Content -LiteralPath (Join-Path $swDsc 'desktop.json') -Encoding UTF8 -Value (@{
  lastCwd = $swWsC
  recentCwds = @($swWsC)
  ui = 'shell'
} | ConvertTo-Json -Depth 4)

# 官方插件「子智能体」**默认是关的**（kernel 清单里 defaultDisabled: true）：不打开它，
# `listTeammates` 恒为空表，名册、顶栏那颗下拉、状态面板的智能体节全都不出现
# （自检第二版就卡在这儿）。条目树里显式 disabled=false 才算打开。
Set-Content -LiteralPath (Join-Path $swDsc 'plugins.json') -Encoding UTF8 -Value (@{
  version = 1
  entries = @(@{ file = 'subagent'; disabled = $false })
} | ConvertTo-Json -Depth 4)

# ── 种子：一个「已收工」的队友（状态面板的智能体节与右栏页签就靠它）──────────────────
# 名册在 ~/.dsc/team/roster.json；运行记录必须落在 teammateRoot（~/.dsc/sessions/.teammates）
# 之下，否则 peekTranscript 会按「这里只能看队友的运行记录」拒掉——那条守卫是在的，种子要合规。
$swMateRoot = Join-Path $swDsc 'sessions\.teammates\ws-c-seed'
New-Item -ItemType Directory -Force -Path $swMateRoot, (Join-Path $swDsc 'team') | Out-Null
$swMateFile = Join-Path $swMateRoot 'e8888888-1111-2222-3333-444444444444.jsonl'
$swMateLines = New-Object System.Collections.Generic.List[string]
$swMateLines.Add("{""type"":""meta"",""id"":""e8888888-1111-2222-3333-444444444444"",""cwd"":""$swMarker"",""createdAt"":$now}")
$swMateLines.Add("{""type"":""user"",""text"":""看一眼 readme.txt 有几行。"",""ts"":$($now + 1000)}")
$swMateLines.Add("{""type"":""assistant"",""text"":"""",""reasoning"":""先读文件。\n\n再数行。"",""ts"":$($now + 1500)}")
$swMateLines.Add("{""type"":""assistant"",""text"":"""",""toolCalls"":[{""id"":""m1"",""name"":""read"",""arguments"":""{\""path\"":\""readme.txt\""}""}],""ts"":$($now + 2000)}")
$swMateLines.Add("{""type"":""tool"",""callId"":""m1"",""name"":""read"",""text"":""第一行：这是第八批自检的工作区说明。"",""ts"":$($now + 2200)}")
$swMateLines.Add("{""type"":""assistant"",""text"":""两行。"",""ts"":$($now + 3000)}")
Set-Content -LiteralPath $swMateFile -Encoding utf8NoBOM -Value ($swMateLines -join "`n")

$swMateFileJs = ($swMateFile -replace '\\', '\\')
$swRoster = @"
{
  "teammates": [
    {
      "name": "reader-1",
      "role": "reader",
      "state": "idle",
      "task": "看一眼 readme.txt 有几行",
      "file": "$swMateFileJs",
      "cwd": "$swMarker",
      "parent": "lead",
      "depth": 1,
      "rounds": 1,
      "startedAt": $($now + 1000),
      "finishedAt": $($now + 3000),
      "sessionId": "$swUuid1"
    }
  ]
}
"@
Set-Content -LiteralPath (Join-Path $swDsc 'team\roster.json') -Encoding utf8NoBOM -Value $swRoster

$swEval = @'
(async () => {
  // 硬截止：整段脚本必须在截图前收工（截图时刻一到进程就退，没返回的读数全丢）。
  const startedAt = Date.now();
  const hardDeadline = startedAt + 72000;
  const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, hardDeadline - Date.now()))));
  const waitFor = async (pred, ms) => {
    const until = Math.min(Date.now() + ms, hardDeadline);
    while (Date.now() < until) { const v = pred(); if (v !== null && v !== false && v !== undefined) return v; await wait(120); }
    return null;
  };
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const text = (el) => el === null || el === undefined ? null : (el.textContent ?? '').trim();
  const setInput = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const rowHeight = (el) => el === null ? null : Math.round(el.getBoundingClientRect().height);
  const out = { case: 'batch8' };
  await waitFor(() => { const root = q('#root'); return root !== null && root.children.length > 0; }, 30000);
  await wait(2000);

  // 侧栏诊断（种子会话找不到时看它：分组叫什么、会话行叫什么）。
  out.side = {
    groups: qa('.group-row').map((g) => text(g)),
    items: qa('.sess-item').map((r) => text(r)).slice(0, 6),
    sidebar: (q('.sidebar')?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 300),
  };

  // ── 打开种子会话 ────────────────────────────────────────────────────────────
  let row = qa('.sess-item').find((r) => (r.textContent ?? '').includes('第八批自检会话'));
  if (row === undefined) {
    const group = qa('.group-row').find((g) => (g.textContent ?? '').includes('ws-c'));
    if (group !== undefined) { group.click(); }
    await wait(500);
    row = await waitFor(() => qa('.sess-item').find((r) => (r.textContent ?? '').includes('第八批自检会话')) ?? null, 8000);
  }
  if (row !== undefined && row !== null) { row.click(); }
  await waitFor(() => q('.turn-seat') !== null, 15000);
  await wait(1000);
  out.opened = q('.turn-seat') !== null;
  out.openedDetail = {
    seats: qa('.turn-seat').length,
    rows: qa('.entry-row').length,
    welcome: q('.welcome') !== null,
    sessOn: qa('.sess-item.on').map((r) => text(r)),
    title: text(q('.topbar-title-row')),
  };
  window.__batch8Stage = 'open';

  // ── A. 阶段组：明面开合（N 项 + 常显箭头）与「收起是真的收起」────────────────
  window.__batch8Stage = 'A';
  // 定稿轮默认收成一行「用时 X」：先把整轮放出来，组头才看得见。
  const folds = qa('.turn-fold').filter((b) => b.disabled === false && b.getAttribute('data-open') === null);
  for (const fold of folds) { fold.click(); await wait(250); }
  await wait(600);
  // 只认**看得见**的组头（收起来的座位里也有组头，量它的高度永远是 0，那是假证据）。
  const groupHeads = qa('.step-fold').filter((h) => h.getBoundingClientRect().height > 0);
  const firstHead = groupHeads.at(-1);
  let firstBody = null;
  if (firstHead !== undefined) { firstBody = firstHead.parentElement?.querySelector('.step-body') ?? null; }
  out.group = {
    heads: groupHeads.length,
    counts: groupHeads.map((h) => text(h.querySelector('.step-fold-count'))),
    chevrons: qa('.step-fold [data-step-chevron]').length,
    openFlags: groupHeads.map((h) => h.getAttribute('data-open')),
    closedBodies: qa('.step-body[hidden]').length,
    firstHidden: firstBody === null ? null : firstBody.hasAttribute('hidden'),
    firstHeight: rowHeight(firstBody),
  };
  // 点第一个组头 → 组体出现（高度 > 0）；再点 → 回到 0。
  if (firstHead !== undefined) {
    firstHead.click();
    await wait(400);
    const opened = firstHead.parentElement?.querySelector('.step-body') ?? null;
    out.groupAfterOpen = { open: firstHead.getAttribute('data-open'), height: rowHeight(opened), hidden: opened === null ? null : opened.hasAttribute('hidden'), scroll: opened === null ? null : opened.scrollHeight, kids: opened === null ? null : opened.children.length, maxH: opened === null ? null : getComputedStyle(opened).maxHeight };
    firstHead.click();
    await wait(400);
    const reclosed = firstHead.parentElement?.querySelector('.step-body') ?? null;
    out.groupAfterClose = { open: firstHead.getAttribute('data-open'), height: rowHeight(reclosed), hidden: reclosed === null ? null : reclosed.hasAttribute('hidden') };
  }

  // ── A2. 思考块：收起时正文不该在 DOM 里 ─────────────────────────────────────
  const thinkHeads = qa('.think-head');
  const firstThink = thinkHeads.at(-1);
  const thinkBlock = firstThink === undefined ? null : firstThink.closest('.think-block');
  out.think = {
    blocks: qa('.think-block').length,
    bodies: qa('.think-block .think-body').length,
    summary: text(thinkBlock === null ? null : thinkBlock.querySelector('.think-summary-text')),
  };
  if (firstThink !== undefined) {
    firstThink.click();
    const opened = await waitFor(() => (thinkBlock !== null && thinkBlock.querySelector('.think-body') !== null ? thinkBlock.querySelector('.think-body') : null), 3000);
    out.thinkAfterOpen = { hasBody: opened !== null, chars: opened === null ? 0 : (opened.textContent ?? '').trim().length };
    firstThink.click();
    await wait(300);
    out.thinkAfterClose = { hasBody: thinkBlock !== null && thinkBlock.querySelector('.think-body') !== null };
  }

  // ── A3. 组员只铺一遍（0.6.67「一条思考栏出现两次」）+ 编辑卡展开体不摊原始 JSON ──
  //   种子的第二轮就是「思考 + write」两员的组：带 bug 的版本会在组体之外**再单独铺
  //   一条**一样的思考栏，所以那一个座位里的 .think-block 会变成 2。
  const seat0 = q('.turn-seat[data-round-seat="0"]');
  if (seat0 !== null) {
    const head0 = seat0.querySelector('.step-fold');
    if (head0 !== null && head0.getAttribute('data-open') !== '1') { head0.click(); }
    await wait(300);
    out.roundOne = {
      thinkRows: seat0.querySelectorAll('.think-block').length,
      toolRows: seat0.querySelectorAll('.entry.tool-card').length,
      groupSize: head0 === null ? null : text(head0.querySelector('.step-fold-count')),
      groupMembers: head0 === null || head0.parentElement === null ? null : head0.parentElement.querySelectorAll('.entry-row').length,
      standalone: seat0.querySelectorAll('.entry-row').length,
    };
  }

  // ── B. 输入区两根旋钮 ───────────────────────────────────────────────────────
  window.__batch8Stage = 'B';
  const area = q('.composer textarea');
  const anchors = qa('.composer .bar-left .model-anchor');
  const policyBtn = anchors[0]?.querySelector('.model-btn') ?? null;
  const presetBtn = anchors[1]?.querySelector('.model-btn') ?? null;
  out.knobs = {
    textarea: area !== null,
    policyLabel: text(policyBtn),
    presetLabel: text(presetBtn),
    policyTip: policyBtn === null ? null : policyBtn.getAttribute('data-tip'),
  };
  if (policyBtn !== null) { policyBtn.click(); }
  await waitFor(() => q('.policy-pop'), 4000);
  out.policyMenu = {
    open: q('.policy-pop') !== null,
    items: qa('.policy-pop .pop-item').map((b) => text(b.querySelector('.name'))),
    checked: text(q('.policy-pop .pop-item.on .name')),
    textareaStill: q('.composer textarea') !== null,
  };
  // 点一颗**非当前档**（当前档那颗是 disabled，点了什么都不会发生——第一版自检点的
  // 「自动编辑」恰好是当前档，读数里 popGone=false 就是这么来的）。先切到另一档看旋钮跟不跟手，
  // 再切回「工作区可写」（后面那一轮要写 todo_write，读档不放行写工具；档名 2026-10-14
  // 收敛成「只读 / 工作区可写 / 完全访问」+「AI 复核」轴之后，「自动编辑」这个名字已经不存在了
  // ——脚本里留着旧名会点空，档位停在只读，写那一轮被拦，后面 6 条断言连锁红）。
  const other = qa('.policy-pop .pop-item').find((b) => b.disabled === false);
  const otherLabel = other === undefined ? null : text(other.querySelector('.name'));
  if (other !== undefined) { other.click(); }
  await wait(1200);
  out.policyAfterPick = {
    picked: otherLabel,
    popGone: q('.policy-pop') === null,
    label: text(qa('.composer .bar-left .model-anchor')[0]?.querySelector('.model-btn') ?? null),
  };
  const backBtn = qa('.composer .bar-left .model-anchor')[0]?.querySelector('.model-btn') ?? null;
  if (backBtn !== null) { backBtn.click(); }
  await waitFor(() => q('.policy-pop'), 4000);
  const autoEdit = qa('.policy-pop .pop-item').find((b) => (b.textContent ?? '').includes('工作区可写'));
  if (autoEdit !== undefined && autoEdit.disabled === false) { autoEdit.click(); }
  await wait(1200);
  out.policyBack = {
    popGone: q('.policy-pop') === null,
    label: text(qa('.composer .bar-left .model-anchor')[0]?.querySelector('.model-btn') ?? null),
  };

  if (presetBtn !== null) { presetBtn.click(); }
  await waitFor(() => q('.preset-pop'), 4000);
  out.presetMenu = {
    open: q('.preset-pop') !== null,
    items: qa('.preset-pop .pop-item').map((b) => text(b.querySelector('.name'))),
    currentDisabled: qa('.preset-pop .pop-item.on').every((b) => b.disabled === true),
    badges: qa('.preset-pop .pop-badge').map((b) => text(b)),
    textareaStill: q('.composer textarea') !== null,
    mask: q('.preset-pop') === null ? null : document.querySelector('.pop-mask') !== null,
  };
  const mask = q('.preset-pop') === null ? null : document.querySelector('.pop-mask');
  if (mask !== null) { mask.click(); }
  await wait(300);

  // ── C. 实跑一轮：直播思考块**默认收起**，点开后流式期间不许被打回 ────────────────
  //   （0.6.67 报障「思考完毕闪屏折叠」的修法：跑动中不再替用户展开——参考实现 dsh 的
  //   ReasoningRow 一律以收起态起步，running 只改折叠行右边那句预览的取法。）
  window.__batch8Stage = 'C';
  const live0 = q('.composer textarea');
  if (live0 !== null) {
    setInput(live0, '第八批自检实跑轮：慢慢想，我想看直播里的思考块。');
    await wait(200);
    const send = q('.bar-right .send-btn:not(.stop)');
    if (send !== null) { send.click(); }
  }
  const liveBlock = await waitFor(() => q('.think-block.live'), 30000);
  out.live = {
    appeared: liveBlock !== null,
    startsCollapsed: liveBlock !== null && liveBlock.querySelector('.think-body') === null,
    expanded: liveBlock === null ? null : liveBlock.querySelector('.think-head')?.getAttribute('aria-expanded'),
  };
  if (liveBlock !== null) {
    // 打一个只有这个 DOM 节点认得的标记：React 重挂会把节点换掉，标记跟着没。
    liveBlock.__b8tag = 'kept';
    // 用户主动点开：接下来的三口 delta 不许把它打回收起。
    const head = liveBlock.querySelector('.think-head');
    if (head !== null) { head.click(); }
    await wait(300);
    const afterClick = q('.think-block.live');
    out.liveAfterOpen = {
      sameNode: afterClick !== null && afterClick.__b8tag === 'kept',
      hasBody: afterClick !== null && afterClick.querySelector('.think-body') !== null,
    };
    // 直播还在推（假端点每 700ms 一口）：等三拍再看，展开态没有被重挂打回收起。
    await wait(1900);
    const later = q('.think-block.live');
    out.liveStillOpen = {
      sameNode: later !== null && later.__b8tag === 'kept',
      hasBody: later !== null && later.querySelector('.think-body') !== null,
      summary: text(later === null ? null : later.querySelector('.think-summary-text')),
    };
    // 再点一次要能收起（两态都在）。
    const head2 = later === null ? null : later.querySelector('.think-head');
    if (head2 !== null) { head2.click(); }
    await wait(600);
    out.liveRecollapse = { hasBody: (q('.think-block.live')?.querySelector('.think-body') ?? null) !== null };
  }
  const turnDone = await waitFor(() => q('.bar-right .send-btn.stop') === null, 45000);
  out.turnDone = turnDone !== null;
  await wait(1500);

  // ── A4. 写前预览卡片（②）+ 编辑卡的展开体（④）——C 段那一轮落了「自检写入.md」────
  //   预览是宿主 file-review 守卫发的 dsc/notice：壳认出那段横幅后画成左对齐卡片
  //   （0.6.67 之前它走 `.entry-system` 的居中一行，几十行 diff 居中成一坨）。
  const review = q('.entry-review');
  out.review = {
    cards: qa('.entry-review').length,
    align: review === null ? null : getComputedStyle(review).textAlign,
    lines: review === null ? 0 : review.querySelectorAll('[data-kind]').length,
    head: text(review === null ? null : review.querySelector('.entry-review-head')),
    centeredLeftovers: qa('.entry-system').filter((el) => (el.textContent ?? '').includes('改动前预览')).length,
  };
  const writeCard = qa('.entry.tool-card').find((card) => (card.querySelector('.tool-head')?.textContent ?? '').includes('自检写入'));
  if (writeCard !== undefined) {
    const head = writeCard.querySelector('.tool-head');
    if (head !== null) { head.click(); }
    await wait(400);
    const body = writeCard.querySelector('.tool-body');
    out.writeCard = {
      found: true,
      changeBlock: body === null ? null : body.querySelector('[data-tc-change]') !== null,
      changeTitle: text(body === null ? null : body.querySelector('.tc-intended-title')),
      argFields: body === null ? null : body.querySelectorAll('.arg-field').length,
      rawArgs: body === null ? null : body.querySelector('.args:not(.arg-fields)') !== null,
      result: body === null ? null : text(body.querySelector('.result'))?.slice(0, 40) ?? null,
    };
    if (head !== null) { head.click(); }
    await wait(200);
  } else {
    out.writeCard = { found: false };
  }

  // ── D. 状态面板（同一壳收展 / 进程 / 智能体已结束目录 / 分区折叠）────────────
  window.__batch8Stage = 'D';
  let shell = await waitFor(() => q('.sp'), 8000);
  // 自动档在窄宿主里收成胶囊：点一下切到面板态（那颗胶囊的语义就是「点我展开」）。
  if ((shell?.getAttribute('data-expanded') ?? '0') === '0') {
    q('[data-sp-mini]')?.click();
    shell = await waitFor(() => (q('.sp')?.getAttribute('data-expanded') === '1' ? q('.sp') : null), 4000);
  }
  out.headerSub = text(q('.sub-btn'));
  // 视图标记：截图时刻窗口在不在那条会话上（曾经出现过「截到欢迎页」的怪象，标出切换时点）。
  const viewNow = () => ({
    welcome: q('.welcome') !== null,
    title: text(q('.topbar-title-row')),
    active: qa('.sess-item.active').map((r) => text(r)),
    panel: q('.sp') !== null,
    panelExpanded: q('.sp')?.getAttribute('data-expanded') ?? null,
  });
  out.viewAtD = viewNow();
  out.status = {
    present: q('.sp') !== null,
    mode: q('.sp')?.getAttribute('data-display-mode') ?? null,
    expanded: q('.sp')?.getAttribute('data-expanded') ?? null,
    progress: text(q('.sp [data-sp-progress]')),
    progressAttr: q('.sp [data-sp-progress]')?.getAttribute('data-sp-progress') ?? null,
    todoRows: qa('.sp .sp-row[data-status]').length,
    todoTexts: qa('.sp .sp-row[data-status] .sp-row-text').map((s) => text(s)),
    agentRows: qa('.sp .sp-row-agent').length,
  };
  // 去重读数（本轮）：标题栏「智能体团队」钮与输入框上方任务条都该没了；「清空清单」
  // 搬进了进程区（任务条撤掉时那颗钮不能跟着丢）。
  out.dedup = {
    taskDock: q('.task-dock') !== null,
    taskClear: q('.task-clear') !== null,
    teamBtn: q('.team-btn') !== null,
    subBtn: text(q('.sub-btn')),
    clearBtn: q('.sp [data-sp-clear]') !== null,
  };
  // Git 工具区：种子 ws-c 是真 git 仓库（追加一行 + 一个未跟踪文件）——读数应当是
  // 分支名、种子态「+2 −0」（readme 追加 1 行 + 未跟踪文件按行数 1）、「2 个文件」。
  // Git 读数是本地轮询（有改动 12 秒一拍）：**开面板那一刻读到的可能是上一拍的值**，
  // 所以这里读两次——`delta/changes` 是第一眼（用户看到的），`settled*` 是隔一个轮询档
  // 之后的收敛值。C 段那一轮往 ws-c 写了「自检写入.md」（3 行），收敛值应当是
  // 「+5 −0」/「3 个文件」；第一眼读到「+2 −0」/「2」说明那一拍还没跟上（不是数据错）。
  const gitRow = await waitFor(() => q('.sp [data-sp-git-changes]'), 15000);
  const gitRead = () => ({
    delta: q('.sp [data-sp-git-delta]')?.getAttribute('data-sp-git-delta') ?? null,
    changes: q('.sp [data-sp-git-changes]')?.getAttribute('data-sp-git-changes') ?? null,
    deltaText: text(q('.sp [data-sp-git-delta]')),
  });
  const gitFirst = gitRead();
  // 收敛用了多久：0.5 秒级就变说明是「回合收工催拍」生效；等到 8-12 秒才变说明是 12 秒
  // 那一档轮询干的（催拍没生效）。这个数只印出来做诊断，不当断言（时序会随机器忙闲飘）。
  const gitT0 = Date.now();
  let gitSettled = gitFirst;
  let gitSettledAfterMs = null;
  while (Date.now() - gitT0 < 15000) {
    await wait(400);
    gitSettled = gitRead();
    if (gitSettled.delta === '5/0' && gitSettled.changes === '3') {
      gitSettledAfterMs = Date.now() - gitT0;
      break;
    }
  }
  out.gitSection = {
    present: q('.sp [data-sp-section="git"]') !== null,
    branch: q('.sp [data-sp-git-branch]')?.getAttribute('data-sp-git-branch') ?? null,
    ...gitFirst,
    settledDelta: gitSettled.delta,
    settledChanges: gitSettled.changes,
    settledDeltaText: gitSettled.deltaText,
    settledAfterMs: gitSettledAfterMs,
  };
  // 计划区（默认收起）：点标题展开 → 列出种子里那份计划；读完收回去，别影响后面的读数。
  const planHead = () => q('.sp [data-sp-section-trigger="plan"]');
  const planHeight = () => q('.sp [data-sp-section-scroll="plan"]')?.getBoundingClientRect().height ?? -1;
  planHead()?.click();
  await waitFor(() => (planHeight() > 0 ? true : null), 3000);
  out.planSection = {
    trail: text(q('.sp [data-sp-section="plan"] .sp-section-trail')),
    plans: qa('.sp [data-sp-plan]').map((b) => ({ file: b.getAttribute('data-sp-plan'), title: text(b.querySelector('.sp-row-text')) })),
    height: planHeight(),
  };
  planHead()?.click();
  await wait(300);
  // 智能体节默认收起：点标题展开，看内嵌的「已结束 · N ›」目录行（收工的队友不再铺在列表里）。
  const agentBody = () => q('.sp [data-sp-section-scroll="agent"]');
  const agentHead = () => q('.sp [data-sp-section-trigger="agent"]');
  const bodyHeight = () => agentBody()?.getBoundingClientRect().height ?? -1;
  agentHead()?.click();
  await waitFor(() => (bodyHeight() > 0 ? true : null), 3000);
  const endedRow = await waitFor(() => q('.sp [data-sp-ended]'), 4000);
  out.agentSection = {
    endedText: text(endedRow),
    endedCount: endedRow?.getAttribute('data-sp-ended') ?? null,
    runningRows: qa('.sp .sp-row-agent').length,
    expandedHeight: bodyHeight(),
  };
  if (endedRow !== null) { endedRow.click(); }
  await wait(1200);
  out.teamPanel = {
    open: q('.settings.team-panel') !== null,
    names: qa('.settings.team-panel .tm-name').map((n) => text(n)),
    bodyChars: (q('.settings.team-panel')?.textContent ?? '').trim().length,
  };
  q('.settings.team-panel .icon-btn')?.click();
  await waitFor(() => (q('.settings.team-panel') === null ? true : null), 3000);
  // 团队面板带一张**全屏遮罩**（`.settings-mask`）：它还在的话后面每一次点击都打在遮罩上，
  // 表现是「分区折叠点了没反应」「第二轮发不出去」（第十五批连吃三次）。这里先把它等掉，
  // 等不掉就点一次遮罩，并把结果当读数报出来——遮罩没散是**上游**故障，别让它伪装成
  // 折叠坏了。
  if (q('.settings-mask') !== null) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(300);
  }
  if (q('.settings-mask') !== null) { q('.settings-mask')?.click(); }
  const maskGone = await waitFor(() => (q('.settings-mask') === null ? true : null), 3000);
  out.mask = { gone: maskGone !== null };
  // 分区折叠：智能体节再点一次收起（体高 0），点回来再展开。
  agentHead()?.click();
  const collapsedReached = await waitFor(() => (q('.sp [data-sp-section="agent"]')?.getAttribute('data-sp-open') === '0' ? true : null), 3000);
  out.sectionFold = { collapsed: collapsedReached !== null, collapsedHeight: bodyHeight() };
  agentHead()?.click();
  const reopenedReached = await waitFor(() => (bodyHeight() > 0 ? true : null), 3000);
  out.sectionFold.reopened = reopenedReached !== null;
  out.sectionFold.reopenedHeight = bodyHeight();
  // 同一壳收展：点「收起为胶囊」→ data-expanded=0 且胶囊有读数；点胶囊再展开。
  q('.sp-toolbar .sp-icon-btn[aria-label="收起为胶囊"]')?.click();
  await wait(450);
  out.capsule = {
    collapsed: q('.sp')?.getAttribute('data-expanded') === '0',
    text: text(q('[data-sp-mini]')),
  };
  q('[data-sp-mini]')?.click();
  await wait(450);
  out.capsule.reopened = q('.sp')?.getAttribute('data-expanded') === '1';
  out.viewAfterD = viewNow();

  // ── E. 进程聚焦窗口（第二轮的 8 项清单）+ 折叠桶预览卡 ───────────────────────
  window.__batch8Stage = 'E';
  // 发消息之前确认没有遮罩：点击打在遮罩上是「第二轮没跑起来」的头号原因（见 D 段注释）。
  if (q('.settings-mask') !== null) { q('.settings-mask')?.click(); await wait(400); }
  const live2 = q('.composer textarea');
  if (live2 !== null) {
    setInput(live2, '把清单扩成八项，中途那项标进行中。');
    await wait(200);
    const send2 = q('.bar-right .send-btn:not(.stop)');
    if (send2 !== null) { send2.click(); }
  }
  const bigProgress = await waitFor(
    () => (q('.sp [data-sp-progress]')?.getAttribute('data-sp-progress') === '4/8' ? true : null),
    45000,
  );
  await wait(600);
  out.focus = {
    progressAttr: q('.sp [data-sp-progress]')?.getAttribute('data-sp-progress') ?? null,
    reached: bigProgress !== null,
    folderCount: qa('.sp [data-sp-fold]').length,
    precedingFold: text(q('.sp [data-sp-fold="preceding"]')),
    followingFold: text(q('.sp [data-sp-fold="following"]')),
    focusRows: qa('.sp [data-sp-section="todo"] .sp-section-scroll .sp-row').map((r) => ({
      status: r.getAttribute('data-status'),
      text: text(r.querySelector('.sp-row-text')),
    })),
  };
  // 悬停折叠桶（合成 mouseover，relatedTarget 为空即「从外部进入」）→ 过开卡延迟 → 预览卡。
  const fold = q('.sp [data-sp-fold="preceding"]');
  if (fold !== null) {
    fold.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
  }
  const card = await waitFor(() => q('.sp-card'), 3000);
  out.preview = {
    present: card !== null,
    head: text(card?.querySelector('.sp-card-head')),
    rows: qa('.sp-card .sp-row').length,
  };
  // ── F. 工具卡点路径 → 右侧文件预览（read 卡上的 readme.txt）────────────────────
  window.__batch8Stage = 'F';
  const openPath = await waitFor(() => q('.tool-head [data-tc-open]'), 4000);
  out.toolPath = {
    present: openPath !== null,
    abs: openPath?.getAttribute('data-tc-open') ?? null,
    text: text(openPath),
    // 诊断：查不到路径钮时，看一眼盘面上到底有几张卡、几张有 tool-head（区分「卡没画」
    // 与「卡画了但路径钮没渲染」）。
    heads: qa('.tool-head').length,
    cards: qa('.entry.tool-card').length,
    seats: qa('.turn-seat').length,
    firstSeat: q('.turn-seat')?.getAttribute('data-round-seat') ?? null,
  };
  if (openPath !== null) {
    openPath.click();
  }
  const previewHead = await waitFor(() => {
    const head = q('.file-preview-path');
    return head !== null && (head.textContent ?? '').trim() !== '' ? head : null;
  }, 5000);
  out.previewPane = {
    path: text(previewHead),
    chars: (q('.file-preview-body')?.textContent ?? '').trim().length,
    chips: qa('.dock-chip .dock-chip-label').map((c) => text(c)),
    onChips: qa('.dock-chip.on .dock-chip-label').map((c) => text(c)),
    panes: qa('.dock-pane').length,
    tabBodies: qa('.dock-tab-body').length,
    bodyText: (q('.dock-tab-body')?.textContent ?? '').slice(0, 140),
    addTab: q('.dock-add') !== null,
  };
  // 关掉预览页签 + 收起侧栏：布局回原样，别把右侧栏的空位带进截图。
  const closeChip = q('.dock-chip.on .dock-chip-close') ?? q('.dock-chip .dock-chip-close');
  if (closeChip !== null) { closeChip.click(); }
  await wait(400);
  q('[aria-label="收起侧边栏"]')?.click();
  await wait(400);
  out.previewPane.closed = q('.file-preview-path') === null;
  out.previewPane.chipsAfter = qa('.dock-chip .dock-chip-label').map((c) => text(c));
  // 视图标记：截图时刻窗口在不在那条会话上（见 D 段的 viewNow）。
  out.viewAtEvalEnd = viewNow();
  await wait(6000);
  out.viewAfterIdle = viewNow();

  out.ms = Date.now() - startedAt;
  return out;
})().catch((error) => ({
  case: 'batch8',
  error: String(error && error.message ? error.message : error),
  stage: window.__batch8Stage ?? null,
}))
'@

# ── 起假端点 ───────────────────────────────────────────────────────────────────
$swFakeOut = Join-Path $swShots 'ui-batch8-fake.out.log'
$swFakeErr = Join-Path $swShots 'ui-batch8-fake.err.log'
Remove-Item -LiteralPath $swFakeOut, $swFakeErr -ErrorAction SilentlyContinue
$swFakeProc = Start-Process -FilePath 'node' -ArgumentList $swFake, "$swPort" -PassThru -RedirectStandardOutput $swFakeOut -RedirectStandardError $swFakeErr
$swFakeReady = $false
$swFakeWait = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $swFakeWait) {
  if ((Test-Path -LiteralPath $swFakeOut) -and (Select-String -LiteralPath $swFakeOut -Pattern '监听' -Quiet -ErrorAction SilentlyContinue)) { $swFakeReady = $true; break }
  if ($swFakeProc.HasExited) { break }
  Start-Sleep -Milliseconds 200
}
if (-not $swFakeReady) { Write-Output '  WARN  假端点没在 10 秒内就绪（实跑段会失败）' }

$env:USERPROFILE = $swHome
$env:HOME = $swHome
$env:DSC_DESKTOP_USER_DATA = Join-Path $swHome 'electron-userdata'
$env:DSC_DESKTOP_STATE = Join-Path $swDsc 'desktop.json'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SHOT = Join-Path $swShots "ui-$swTag.png"
# 时序：eval 在上屏后 (DELAY − LEAD) 处开跑，窗口就是 LEAD。本批把 LEAD 从 78s 抬到 96s：
# 加了两段（A3 组员/编辑卡 + C 段点开再推三拍）之后实测 evals 逼近 78s，机器一忙就被截断，
# 表现是「预跑脚本返回了读数」失败而 errLog 里既没「完成」也没「失败」（第十五批连吃两次）。
# DELAY − LEAD 仍是 22s 的上屏静置窗。
$env:DSC_DESKTOP_SHOT_DELAY = '205000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '183000'
$env:DSC_DESKTOP_SHOT_EVAL = $swEval
Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue
Remove-Item Env:DSC_UI_QUERY -ErrorAction SilentlyContinue

$outLog = Join-Path $swShots "ui-$swTag.out.log"
$errLog = Join-Path $swShots "ui-$swTag.err.log"
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue

try {
  $swArgs = if ($swEntry -ne '') { @($swEntry) } else { @() }
  $swProc = Start-Process -FilePath $swElectron -ArgumentList $swArgs -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $swDeadline = (Get-Date).AddSeconds(220)
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
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_SHOT_TOPMOST, Env:DSC_DESKTOP_USER_DATA,
    Env:DSC_DESKTOP_STATE -ErrorAction SilentlyContinue
  if ($null -ne $swFakeProc -and -not $swFakeProc.HasExited) {
    & taskkill /PID $swFakeProc.Id /T /F 2>&1 | Out-Null
  }
}

if (Test-Path -LiteralPath $errLog) {
  Select-String -LiteralPath $errLog -Pattern '预跑脚本失败|页面加载失败|截图失败|渲染时出错' | ForEach-Object { '  ' + $_.Line.Trim() }
}

# ── 断言 ───────────────────────────────────────────────────────────────────────
$swFail = 0
$swTotal = 0
function Check($Name, $Ok, $Detail = '') {
  $script:swTotal += 1
  if ($Ok) { Write-Output "  PASS  $Name" }
  else { $script:swFail += 1; Write-Output "  FAIL  $Name$(if ($Detail -ne '') { " — $Detail" })" }
}

$swJson = $null
if (Test-Path -LiteralPath $errLog) {
  $line = Select-String -LiteralPath $errLog -Pattern '预跑脚本完成：' | Select-Object -Last 1
  if ($null -ne $line) {
    $marker = '预跑脚本完成：'
    $raw = $line.Line.Substring($line.Line.IndexOf($marker) + $marker.Length).Trim()
    try { $swJson = $raw | ConvertFrom-Json } catch { $swJson = $null }
  }
}
Check '预跑脚本返回了读数' ($null -ne $swJson)
if ($null -ne $swJson) {
  if ($null -ne $swJson.error) { Write-Output "  （读数里带错误：$($swJson.error)，阶段 $($swJson.stage)）" }

  # A 阶段组
  Write-Output "  （侧栏诊断：groups=[$($swJson.side.groups -join ' / ')] items=[$($swJson.side.items -join ' / ')]）"
  Write-Output "  （打开诊断：$($swJson.openedDetail | ConvertTo-Json -Compress)）"
  Check '打开会话后有两轮座位' ($swJson.opened -eq $true)
  Check '阶段组头在位（可见的≥1 组）' ($swJson.group.heads -ge 1) ("heads=$($swJson.group.heads)")
  Check '每个组头都带「N 项」读数' ($swJson.group.counts.Count -eq $swJson.group.heads -and ($swJson.group.counts -join ',') -match '^\d+ 项(,\d+ 项)*$') ($swJson.group.counts -join ',')
  Check '箭头常显（每组一颗，不再靠悬停换出来）' ($swJson.group.chevrons -eq $swJson.group.heads) ("chevrons=$($swJson.group.chevrons) heads=$($swJson.group.heads)")
  Check '定稿轮的组头默认收起（data-open 缺席）' (($swJson.group.openFlags | Where-Object { $_ -ne $null }).Count -eq 0) ($swJson.group.openFlags -join ',')
  Check '收起的组体挂了 hidden' ($swJson.group.firstHidden -eq 'True' -or $swJson.group.firstHidden -eq $true) ("hidden=$($swJson.group.firstHidden)")
  Check '收起的组体高度真的是 0（不再是「收起来了却还摊着」）' ($swJson.group.firstHeight -eq 0) ("h=$($swJson.group.firstHeight)")
  Check '点组头 → 展开（data-open + 高度 > 0）' ($swJson.groupAfterOpen.open -eq '1' -and $swJson.groupAfterOpen.height -gt 0) ("open=$($swJson.groupAfterOpen.open) h=$($swJson.groupAfterOpen.height)")
  Check '再点一次 → 收起（高度回到 0）' ($swJson.groupAfterClose.open -eq $null -and $swJson.groupAfterClose.height -eq 0) ("open=$($swJson.groupAfterClose.open) h=$($swJson.groupAfterClose.height)")

  # A2 思考块
  Check '定稿思考块默认收起：正文不在 DOM 里' ($swJson.think.bodies -eq 0) ("bodies=$($swJson.think.bodies) blocks=$($swJson.think.blocks)")
  Check '思考块有折叠态摘要' (($swJson.think.summary ?? '') -ne '') ($swJson.think.summary)
  Check '点思考行 → 正文出现且有内容' ($swJson.thinkAfterOpen.hasBody -eq $true -and $swJson.thinkAfterOpen.chars -gt 0) ("chars=$($swJson.thinkAfterOpen.chars)")
  Check '再点一次 → 思考正文消失（关得掉）' ($swJson.thinkAfterClose.hasBody -eq $false)

  # B 两根旋钮
  Check '输入框在（两根旋钮之前）' ($swJson.knobs.textarea -eq $true)
  Check '权限旋钮显示当前档位' (($swJson.knobs.policyLabel ?? '') -ne '') ($swJson.knobs.policyLabel)
  Check '打开权限菜单：四项' ($swJson.policyMenu.open -eq $true -and $swJson.policyMenu.items.Count -eq 4) ($swJson.policyMenu.items -join ',')
  Check '权限菜单开着时输入框还在（上一批这里是整块崩掉）' ($swJson.policyMenu.textareaStill -eq $true)
  Check '点一颗非当前档 → 菜单关、旋钮文案跟着变' ($swJson.policyAfterPick.popGone -eq $true -and $swJson.policyAfterPick.label -eq $swJson.policyAfterPick.picked) ("picked=$($swJson.policyAfterPick.picked) label=$($swJson.policyAfterPick.label)")
  Check '再切回「工作区可写」也跟手（写工具那一轮要靠它放行）' ($swJson.policyBack.popGone -eq $true -and $swJson.policyBack.label -match '工作区可写') ("label=$($swJson.policyBack.label)")
  Check '打开预设菜单：有清单、输入框还在' ($swJson.presetMenu.open -eq $true -and $swJson.presetMenu.items.Count -ge 1 -and $swJson.presetMenu.textareaStill -eq $true) ($swJson.presetMenu.items -join ',')
  Check '预设菜单里当前档不可点（已选无需再选）' ($swJson.presetMenu.currentDisabled -eq $true)

  # A4 写前预览卡片 + 编辑卡
  Check '写前预览画成卡片（不再居中一行）' ($swJson.review.cards -ge 1 -and $swJson.review.align -eq 'start' -and $swJson.review.centeredLeftovers -eq 0) ("cards=$($swJson.review.cards) align=$($swJson.review.align) centered=$($swJson.review.centeredLeftovers)")
  Check '预览卡片逐行分类（hunk / 增 / 删 / 上下文）' ($swJson.review.lines -ge 3) ("lines=$($swJson.review.lines)")
  Check '编辑卡落在对话流里' ($swJson.writeCard.found -eq $true)
  Check '编辑卡展开体给「这次改动」diff' ($swJson.writeCard.changeBlock -eq $true -and $swJson.writeCard.changeTitle -eq '这次改动') ("title=$($swJson.writeCard.changeTitle)")
  Check '编辑卡的参数是一行一字段（不是原始 JSON）' ($swJson.writeCard.argFields -ge 2 -and $swJson.writeCard.rawArgs -eq $false) ("fields=$($swJson.writeCard.argFields) raw=$($swJson.writeCard.rawArgs)")

  # C 直播中的思考块
  Check '实跑一轮：直播思考块出现' ($swJson.live.appeared -eq $true)
  Check '直播思考块默认收起（跑动中不替用户展开）' ($swJson.live.startsCollapsed -eq $true -and $swJson.live.expanded -eq 'false') ("collapsed=$($swJson.live.startsCollapsed) expanded=$($swJson.live.expanded)")
  Check '点开后正文出现（两态都在）' ($swJson.liveAfterOpen.hasBody -eq $true)
  Check '展开后又被推了三拍：仍然是同一个 DOM 节点（每口 delta 不再重挂）' ($swJson.liveStillOpen.sameNode -eq $true)
  Check '三拍之后展开态还在（用户点开过的不被重挂打回收起）' ($swJson.liveStillOpen.hasBody -eq $true)
  Check '直播中的摘要跟着长（不是首行冻住）' (($swJson.liveStillOpen.summary ?? '') -ne '') ($swJson.liveStillOpen.summary)
  Check '再点一次收得掉' ($swJson.liveRecollapse.hasBody -eq $false)
  Check '实跑回合结束' ($swJson.turnDone -eq $true)

  # A3 组员只铺一遍（第 0 轮是种子里唯一的两员组：思考 + read）
  Check '两员组：思考栏恰好一条、工具卡恰好一张（组员不再被单独铺一遍）' ($swJson.roundOne.thinkRows -eq 1 -and $swJson.roundOne.toolRows -eq 1) ("think=$($swJson.roundOne.thinkRows) tool=$($swJson.roundOne.toolRows)")
  Check '组头「2 项」= 组体里两行（读数与实际一致）' ($swJson.roundOne.groupSize -eq '2 项' -and $swJson.roundOne.groupMembers -eq 2) ("size=$($swJson.roundOne.groupSize) members=$($swJson.roundOne.groupMembers)")
  Check '这一轮总行数 = 题面 + 整轮开关 + 组体两行 + 正文（5 行，没有被多铺的行）' ($swJson.roundOne.standalone -eq 5) ("rows=$($swJson.roundOne.standalone)")

  # D 状态面板（同一壳收展 / 进程 / 已结束目录 / 分区折叠）
  Write-Output "  （状态诊断：$($swJson.status | ConvertTo-Json -Compress)）"
  Check '状态面板在位且已展开（自动档窄宿主时自检先点了胶囊）' ($swJson.status.present -eq $true -and $swJson.status.expanded -eq '1') ("mode=$($swJson.status.mode) expanded=$($swJson.status.expanded)")
  Check '进度读数 = 1/3（todo_write 立的三项里一条已完成）' ($swJson.status.progressAttr -eq '1/3') ("=$($swJson.status.progressAttr)")
  Check '任务节列出三条胶囊行（≤6 条不折叠）' ($swJson.status.todoRows -eq 3) ("rows=$($swJson.status.todoRows)")
  Write-Output "  （队友诊断：顶栏子智能体钮=[$($swJson.headerSub)]）"
  Check '智能体节不列收工的队友（running 为 0）' ($swJson.status.agentRows -eq 0) ("rows=$($swJson.status.agentRows)")
  Check '收工的队友折成「已结束 · 1 ›」目录行' ($swJson.agentSection.endedCount -eq '1' -and $swJson.agentSection.endedText -like '*已结束*') ("text=$($swJson.agentSection.endedText)")
  Check '点已结束行 → 团队面板打开并列出 reader-1' ($swJson.teamPanel.open -eq $true -and ($swJson.teamPanel.names -contains 'reader-1')) ("names=$($swJson.teamPanel.names -join ',') chars=$($swJson.teamPanel.bodyChars)")
  Check '团队面板的全屏遮罩已散去（后面所有点击都靠它）' ($swJson.mask.gone -eq $true)
  Check '分区折叠：点智能体标题收起（data-sp-open=0），再点开' ($swJson.sectionFold.collapsed -eq $true -and $swJson.sectionFold.reopened -eq $true) ("collapsedH=$($swJson.sectionFold.collapsedHeight) openH=$($swJson.sectionFold.reopenedHeight) 首展=$($swJson.agentSection.expandedHeight)")
  Check '同一壳收展：收起成胶囊（data-expanded=0）且胶囊有读数' ($swJson.capsule.collapsed -eq $true -and ($swJson.capsule.text ?? '') -ne '') ("text=$($swJson.capsule.text)")
  Check '点胶囊能展开回来（同一棵 DOM，不重挂）' ($swJson.capsule.reopened -eq $true)

  # D2 去重 + 本轮补的两区（Git 工具 / 计划）
  Write-Output "  （去重诊断：$($swJson.dedup | ConvertTo-Json -Compress)）"
  Write-Output "  （Git 诊断：$($swJson.gitSection | ConvertTo-Json -Compress)）"
  Write-Output "  （计划诊断：$($swJson.planSection | ConvertTo-Json -Compress -Depth 4)）"
  Check '任务条已撤（输入框上方不再有 .task-dock / .task-clear）' ($swJson.dedup.taskDock -eq $false -and $swJson.dedup.taskClear -eq $false)
  Check '标题栏团队钮已撤（.team-btn 不在；子智能体下拉还在）' ($swJson.dedup.teamBtn -eq $false -and ($swJson.dedup.subBtn ?? '') -ne '') ("subBtn=$($swJson.dedup.subBtn)")
  Check '「清空清单」搬进了进程区（任务条撤掉不丢动作）' ($swJson.dedup.clearBtn -eq $true)
  Check 'Git 工具区在位（种子 ws-c 是真 git 仓库）' ($swJson.gitSection.present -eq $true)
  Check 'Git 分支行是真分支名（不是「(无提交)」）' (($swJson.gitSection.branch ?? '') -match '^(master|main)$') ("branch=$($swJson.gitSection.branch)")
  Check 'Git 更改读数 +5 −0（种子两处 + 实跑写的「自检写入.md」3 行）' ($swJson.gitSection.settledDelta -eq '5/0') ("settled=$($swJson.gitSection.settledDelta) first=$($swJson.gitSection.delta) text=$($swJson.gitSection.settledDeltaText)")
  Check 'Git 脏文件数 = 3（改一个 + 未跟踪两个：种子一个 + 实跑写的一个）' ($swJson.gitSection.settledChanges -eq '3') ("settled=$($swJson.gitSection.settledChanges) first=$($swJson.gitSection.changes)")
  Check '实跑那一轮确实把文件写进了 ws-c（读数不是凭空长出来的）' (Test-Path -LiteralPath (Join-Path $swWsC '自检写入.md')) ("ws-c 里没有自检写入.md")
  Check '第一眼读数不晚于一个轮询档（12s 内收敛到同一组数）' ($swJson.gitSection.settledDelta -eq '5/0' -and $swJson.gitSection.settledChanges -eq '3') ("first=$($swJson.gitSection.delta)/$($swJson.gitSection.changes) settled=$($swJson.gitSection.settledDelta)/$($swJson.gitSection.settledChanges)")
  Check '计划区列出会话账里的计划（1 份 + 标题来账）' ($swJson.planSection.trail -match '1 份' -and ($swJson.planSection.plans | Where-Object { $_.title -eq '自检计划甲' }).Count -eq 1) ("trail=$($swJson.planSection.trail) plans=$($swJson.planSection.plans.title -join ',')")
  Check '工作区里不在账里的旧计划文件不进目录（面板不扫盘）' (($swJson.planSection.plans | Where-Object { $_.title -like '*旧计划*' }).Count -eq 0 -and ($swJson.planSection.plans | ForEach-Object { $_.file }) -notcontains '20251231-2300') ("plans=$($swJson.planSection.plans.title -join ',')")

  # E 进程聚焦窗口 + 折叠桶预览卡（第二轮的 8 项清单）
  Write-Output "  （聚焦诊断：$($swJson.focus | ConvertTo-Json -Compress -Depth 4)）"
  Check '第二轮清单到位（进度 4/8）' ($swJson.focus.reached -eq $true -and $swJson.focus.progressAttr -eq '4/8') ("=$($swJson.focus.progressAttr)")
  Check '>6 条启用聚焦窗口：前后各一个折叠桶、窗口 3 条' ($swJson.focus.folderCount -eq 2 -and $swJson.focus.focusRows.Count -eq 3) ("folders=$($swJson.focus.folderCount) focus=$($swJson.focus.focusRows.Count)")
  Check '前桶全办完 → 「已完成 4 项」；后桶全待办 → 「待处理 1 项」' ($swJson.focus.precedingFold -eq '已完成 4 项' -and $swJson.focus.followingFold -eq '待处理 1 项') ("pre=[$($swJson.focus.precedingFold)] fol=[$($swJson.focus.followingFold)]")
  Check '窗口含进行中项（当前那一条不会被挤出可视区）' (($swJson.focus.focusRows | Where-Object { $_.status -eq 'in_progress' }).Count -eq 1) (($swJson.focus.focusRows | ForEach-Object { $_.status }) -join ',')
  Check '悬停折叠桶 → 预览卡打开并列出整桶 4 条' ($swJson.preview.present -eq $true -and $swJson.preview.rows -eq 4 -and $swJson.preview.head -eq '已完成 4 项') ("head=[$($swJson.preview.head)] rows=$($swJson.preview.rows)")

  # F 工具卡点路径 → 右侧文件预览（read 卡上的 readme.txt）
  Write-Output "  （工具卡路径诊断：$($swJson.toolPath | ConvertTo-Json -Compress)）"
  Write-Output "  （预览页签诊断：$($swJson.previewPane | ConvertTo-Json -Compress -Depth 4)）"
  Check 'read 工具卡上有可点路径（data-tc-open 指向工作区里的文件）' ($swJson.toolPath.present -eq $true -and ($swJson.toolPath.abs ?? '') -match 'marker-ws-c\.txt$') ("abs=$($swJson.toolPath.abs) text=$($swJson.toolPath.text)")
  Check '点路径 → 右侧预览页签打开且是当前页签（头行显示该文件、内容读到）' (($swJson.previewPane.path ?? '') -match 'marker-ws-c' -and $swJson.previewPane.chars -gt 0 -and ($swJson.previewPane.onChips -join ',') -match 'marker-ws-c') ("path=$($swJson.previewPane.path) chars=$($swJson.previewPane.chars) on=$($swJson.previewPane.onChips -join ',')")
  Check '关掉预览页签能收回去（页签条只剩开始页）' ($swJson.previewPane.closed -eq $true -and ($swJson.previewPane.chipsAfter -join ',') -notmatch 'marker-ws-c') ("closed=$($swJson.previewPane.closed) after=$($swJson.previewPane.chipsAfter -join ',')")
}

Check "截图落盘（ui-$swTag.png）" (Test-Path -LiteralPath (Join-Path $swShots "ui-$swTag.png"))

if ($null -ne $swRealBefore) {
  $swRealAfter = Get-DirFingerprint $swRealDsc
  Check '真实 ~/.dsc 文件数与内容指纹不变' ($swRealAfter.Count -eq $swRealBefore.Count -and $swRealAfter.ContentDigest -eq $swRealBefore.ContentDigest) ("before=$($swRealBefore.Count)/$($swRealBefore.ContentDigest.Substring(0,8)) after=$($swRealAfter.Count)/$($swRealAfter.ContentDigest.Substring(0,8))")
}

Write-Output ''
Write-Output "第八批自检：$($swTotal - $swFail)/$swTotal 通过"
if ($swFail -gt 0) { exit 1 }
