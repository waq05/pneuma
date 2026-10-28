# 自检：设置 → 模式 面板与输入框那颗模式旋钮。
#
# 三种取景：panel（卡片列表，内置/自定义两组）、editor（点开「新建模式」的就地表单）、
# composer（输入框下方那颗旋钮与它的弹出面板）。
# 走 ?settings=presets 钩子直接开设置到「模式」分区；自定义模式先塞一个进隔离 HOME，
# 所以自定义那一组不是空的。
#
# 用法：desktop\shots\presets-shots.ps1 [-Case dark|light] [-View panel|editor|composer]
param(
  [ValidateSet('dark', 'light')][string]$Case = 'dark',
  [ValidateSet('panel', 'editor', 'composer')][string]$View = 'panel'
)

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$shots = 'D:\dsc\desktop\shots'
$electron = Join-Path $shots '..\node_modules\.bin\electron.cmd'
$seedHome = Join-Path $shots 'presets-home'

# 隔离 HOME：预置一个自定义模式，面板里「自定义」那一组才有东西可看
$presetDir = Join-Path $seedHome '.dsc\presets'
New-Item -ItemType Directory -Force -Path $presetDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $seedHome 'AppData\Roaming') | Out-Null
@'
---
name: review
label: 代码审查模式
description: 只读地找漏洞与测试缺口，每条结论给「文件名:行号」
tools: read, glob, grep, bash
drop: tool-rules
---

你专门找问题，不夸方案。先列出这个方案成立的隐含假设，逐条问「如果不成立会怎样」，
再找反例：现有代码里有没有冲突的地方、边界条件、失败路径。
每条问题给出证据（文件名:行号）与严重程度；没发现问题就明说你查过哪里。
'@ | Set-Content -Encoding utf8 (Join-Path $presetDir 'review.md')

$env:DSC_DESKTOP_USER_DATA = Join-Path $shots 'presets-udata'
$env:USERPROFILE = $seedHome
$env:DSC_HOME = Join-Path $seedHome '.dsc'
$env:DSC_DESKTOP_SHOT_TOPMOST = '1'
$env:DSC_DESKTOP_SEARCH = $(if ($View -eq 'composer') { '' } else { 'settings=presets' })
$env:DSC_DESKTOP_SHOT = Join-Path $shots "presets-$View-$Case.png"
$env:DSC_DESKTOP_SHOT_DELAY = '9000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '4000'

$eval = @'
(async () => {
  document.documentElement.style.setProperty('--dsc-dur', '0ms');
  if ('__LIGHT__' === '1') document.documentElement.dataset.theme = 'light';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el === null || el === undefined ? '' : (el.textContent || '').trim());
  const rect = (el) => { if (el === null || el === undefined) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };

  if ('__VIEW__' === 'composer') {
    await wait(600);
    const chips = Array.from(document.querySelectorAll('.model-btn'));
    const chip = chips.find((el) => text(el).includes('模式'));
    (chip || chips[0])?.click();
    await wait(400);
    const items = Array.from(document.querySelectorAll('.preset-pop .pop-item'));
    return {
      view: 'composer',
      chips: chips.map((el) => text(el)),
      chipCount: chips.length,
      chipRect: chips.length > 0 ? rect(chips[0]) : null,
      popItems: items.map((el) => text(el)),
      popWidth: rect(document.querySelector('.preset-pop')).w,
    };
  }

  await wait(1400);
  if ('__VIEW__' === 'editor') {
    // 点自定义那张卡的「编辑」：它的工牌最全（白名单、去掉的段、正文都有），
    // 拍出来的表单才是填满的样子（「新建模式」的空表单看不出工具多选）。
    const card = Array.from(document.querySelectorAll('.preset-card')).find((el) => text(el.querySelector('.preset-name')).includes('review'));
    const edit = Array.from((card || document).querySelectorAll('button')).find((el) => text(el) === '编辑');
    edit?.click();
    await wait(500);
    // 表单长在卡片列表末尾（就地表单，不弹窗），得滚进视野才拍得到
    document.querySelector('.preset-form')?.scrollIntoView({ block: 'center', behavior: 'instant' });
    await wait(300);
  }
  const cards = Array.from(document.querySelectorAll('.preset-card'));
  const groups = Array.from(document.querySelectorAll('.presets .models-head')).map((el) => text(el));
  const active = document.querySelector('.preset-card.on');
  const form = document.querySelector('.preset-form');
  const raw = document.querySelector('.preset-raw');
  return {
    view: '__VIEW__',
    cards: cards.map((el) => ({
      name: text(el.querySelector('.preset-name')),
      badges: Array.from(el.querySelectorAll('.preset-badge')).map((b) => text(b)),
      current: el.classList.contains('on'),
      rect: rect(el),
    })),
    groups,
    cardCount: cards.length,
    activeName: text(active?.querySelector('.preset-name')),
    intro: text(document.querySelector('.preset-intro')).slice(0, 60),
    toolBoxes: document.querySelectorAll('.preset-tool-grid .preset-tool').length,
    dropBoxes: document.querySelectorAll('.preset-drop-list .preset-tool').length,
    formOpen: form !== null,
    formTitle: text(form?.querySelector('.provider-form-title')),
    formInputs: document.querySelectorAll('.preset-form .setting-input').length,
    promptBox: rect(document.querySelector('.preset-prompt')),
    rawOpen: raw !== null,
    navActive: text(document.querySelector('.settings-nav-item.on')),
  };
})()
'@
$env:DSC_DESKTOP_SHOT_EVAL = $eval.Replace('__LIGHT__', $(if ($Case -eq 'light') { '1' } else { '0' })).Replace('__VIEW__', $View)

$log = Join-Path $shots "presets-$View-$Case.log"
$entry = Join-Path $shots '..\out\main\index.js'
& $electron $entry *>&1 | Out-File -FilePath $log -Encoding utf8
Select-String -Path $log -Pattern '预跑脚本' | ForEach-Object { $_.Line }
