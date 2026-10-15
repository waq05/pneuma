/**
 * 手机档（≤860px / ≤560px）的壳布局探针（2026-10-15 报障批次）。
 *
 * 用户一次报四件事（手机远程页截图 + 一张桌面输入框）：
 *
 *   1. 手机上去掉三样：竖栏那颗**设置**、顶栏的**轨迹**页签、右上角**在资源管理器中打开**；
 *   2. 左侧那条竖栏整条去掉，只留「会话」与「插件」两颗，挂进顶栏
 *      （当天第二条反馈把「会话」挪到了**左上角**：拉出来的抽屉从左边出来，钮就该在左边）；
 *   3. 输入框加高（点它容易点空）、底栏那两排按钮摆整齐、两排都收矮；
 *   4. 桌面输入框也跟着加高（对齐 ZCode 的 `min-h-10` = 40px）。
 *   当天第三条反馈：进整页（点「插件」）之后**没有回程**——顶栏连「会话」一起被换掉了，
 *   桌面上那条常驻侧栏在手机档不存在，于是页头带（`[4]`）就是它的替身。
 *
 * 手机远程页伺服的是**同一份壳产物**，这一档全靠视口宽分辨（没有 UA、没有宿主标志），
 * 所以两侧都要钉：JS 侧认 `app.tsx` 的 `NARROW_QUERY`（与 CSS 同一个数），CSS 侧认
 * `styles.css` 那两条媒体查询。桌面窗口最小宽 960，永远碰不到这一档——凡「只在手机档
 * 生效」的东西，这里都要顺带证明它**没有**漏到桌面档（块外不许有同一条规则）。
 *
 * 十二组断言：
 *
 *   [1] 桌面基准：这几条改动一条都不许漏到桌面（窄栏、页签、打开组、初值兜底）
 *   [2] 手机：收起态整条侧栏不占位（`[data-rail='1']`）而窄栏不再画
 *   [3] 顶栏导航：会话（左上，拉抽屉）/ 插件（右上，整页）两颗，只在窄屏渲染
 *   [4] 整页模式的页头带：进页之后得有回程（回对话 + 开会话抽屉），进页时抽屉自动收起
 *   [5] 抽屉遮罩：三条件（窄屏 + 展开）、点它收起、z-index 压在侧栏之下、老内核兜底名单
 *   [6] 轨迹页签：桌面两颗；手机只在轨迹页上给一颗「← 对话」返回钮（三个入口都要有回头路）
 *   [7] 手机上收掉的两个桌面入口：`.ws-open`（原生桥）与页脚那颗「设置」（设置页手机版是崩的）
 *   [8] 输入框高度：`--dsc-input-box-h` 两处取值（桌面 40 / 手机 44）、只此一家
 *   [9] 手机底栏两行：右组整行占第二行、发送贴本行右缘、两行都收矮；点框内空白聚焦
 *   [10] 手机上那三颗旋钮（权限/模式/档位）的浮层贴住输入卡片、不探出屏幕
 *   [11] 样式门：新类名有规则 / 标记类不进 CSS / 撞名门 / 硬编码色 / 幽灵令牌
 *   [12] 负向自证：上面每台扫描器喂一段坏输入必须报红，真源码上不许恒真或恒假
 *
 * 运行：node scripts/ui-mobile-shell-test.mjs（读源码，不需要先编译）
 *
 * @module dsc/scripts/ui-mobile-shell-test
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')
// 本仓工作区是 CRLF：跨行文本钉一律先摊平（否则 `{\n  …` 这种写照永远匹配不上）。
const flat = (text) => text.replace(/\r\n/g, '\n')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
}

/** 取 `@media (max-width: Npx)` 里**含某段文字**的那一块（同一档可能不止一处）。 */
function mediaBlock(css, width, marker) {
  const all = [...css.matchAll(new RegExp(`@media \\(max-width: ${String(width)}px\\) \\{([\\s\\S]*?)\\n\\}`, 'g'))]
  return all.map((m) => m[1]).find((body) => body.includes(marker)) ?? null
}

/** 某个选择器是否有规则体（不吃「只出现在注释里」那种；缩进的规则也算——媒体查询里的规则是缩进的）。 */
function hasRule(css, selector) {
  return new RegExp(`(^|\\n)[ \\t]*${selector.replace(/[.\\[\]()>=']/g, '\\$&')}[\\s,{]`).test(css)
}

/** 取一段源码切片（从 `from` 第一次出现到 `to` 第一次出现之后）。 */
function sliceFrom(text, from, to) {
  const start = text.indexOf(from)
  if (start < 0) return ''
  const end = text.indexOf(to, start)
  return end < 0 ? text.slice(start) : text.slice(start, end + to.length)
}

/** 递归收集源码文件（只认 .ts/.tsx）。 */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) collect(full, out)
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

// ── 源码与样式（全部摊平）────────────────────────────────────────────────────
const app = flat(read('ui-shell/src/ui-layout/app.tsx'))
const composer = flat(read('ui-shell/src/plugins/composer/ui.tsx'))
const sessions = flat(read('ui-shell/src/plugins/sessions/ui.tsx'))
const styles = flat(read('ui-shell/src/styles.css'))
const views = flat(read('ui-shell/src/legacy/views.css'))

const block860 = mediaBlock(styles, 860, '.sidebar:not(.rail)')
const block560 = mediaBlock(styles, 560, '.composer-bar .bar-left')
/** `@supports not (inset: 0)` 那条老内核兜底块的块体（注释里提到标记名的那处没有 `{`，
 *  所以按规则体取不会认错）。 */
const insetFallback = /@supports not \(inset: 0\) \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ''
/** 去掉兜底块之后的 styles.css：兜底块里会**再点一次**遮罩类名（那不是第二条规则），
 *  「只在手机档」与「只定义一次」两条判据都要把它排除在外。 */
const stylesNoFallback = insetFallback === '' ? styles : styles.replace(insetFallback, '')
/** 860 块以外的那部分 styles.css（「只藏在手机档」的判据）。 */
const outside860 = block860 === null ? stylesNoFallback : stylesNoFallback.replace(block860, '')
const outside560 = block560 === null ? stylesNoFallback : stylesNoFallback.replace(block560, '')

/** 顶栏标题行那一段（左上「会话」钮 → 弹性填充 → 右上「插件」钮 → DockToggle）。 */
const topbarNav = sliceFrom(app, '<div className="topbar-title-row">', '<nav className="tabs"')
/** 「会话」那颗（左上角，标题之前）与「插件」那颗（右上）各自的切片。 */
const sessionsNav = sliceFrom(app, '<div className="topbar-title-row">', '<span className="title">')
const pluginsNav = sliceFrom(app, 'aria-label="插件"', 'DockToggle')
/** 整页模式那一支（页头带 + 页槽）。 */
const pageBranch = sliceFrom(app, '手机档的**页头带**', '<SlotOutlet slots={slots} slot={SLOT.page} />')
/** 轨迹那一段（`手机档不给这两颗页签` 那段注释到标题行的 `</div>`）。 */
const tabsNav = sliceFrom(app, '手机档不给这两颗页签', '</div>')
/** 手机档那一支（返回钮那一支自己，桌面两支不在里面）。 */
const tabsNarrow = sliceFrom(tabsNav, "{narrow ? (\n", ') : null')

// ── [1] 桌面基准 ─────────────────────────────────────────────────────────────
console.log('[1] 桌面基准：这批改动一条都不许漏到桌面')
{
  check('断点只有一个来源（NARROW_QUERY 与 CSS 同一个数）', app.includes("const NARROW_QUERY = '(max-width: 860px)'") && /@media \(max-width: 860px\)/.test(styles))
  check('首帧就量一次（懒初始化，手机上不闪那条 56px 窄栏）', app.includes('useState<boolean>(() => isNarrowViewport())'))
  check('侧栏收起态的初值带上窄屏兜底（存档里那份是桌面留的 false）', app.includes('readStoredFlag(PANEL_KEYS.sidebarCollapsed) || isNarrowViewport()'))
  check('跨进窄屏时同步 state（不只是 setSidebarCollapsed）', /setNarrow\(query\.matches\)/.test(app))
  check('桌面档窄栏照旧（`narrow` 才让它让位）', app.includes('{sidebarCollapsed && !narrow ? <SidebarRail'))
  check('窄栏那六颗的类名都还在（桌面还要用）', app.includes('rail-logo') && app.includes('rail-btn') && app.includes("'shell.session.new'") && app.includes("'shell.settings.open'"))
  check('数据属性 data-rail 的真源没换（还是 sidebarCollapsed）', app.includes("data-rail={sidebarCollapsed ? '1' : '0'}"))
  check('桌面档的两颗页签还在（对话 / 轨迹，带 role=tablist）', /<nav className="tabs" role="tablist"/.test(tabsNav) && tabsNav.includes('轨迹'))
  check('桌面档的轨迹页签仍是 aria-selected 驱动', tabsNav.includes('aria-selected={threadView === \'trace\'}'))
  // 插件那边一个字没动：打开组与页脚「设置」都还在（只是手机上被 CSS 藏起来）。
  check('`.ws-open` 那组仍在插件里渲染（打开组没删）', sessions.includes('ws-open-main') && sessions.includes('ws-open-caret'))
  check('侧栏页脚那颗「设置」也还在（手机上才藏）', sessions.includes('className="row row-btn"') && sessions.includes("'shell.settings.open'"))
  check('桌面档不渲染遮罩（遮罩的条件里有 narrow）', app.includes('{narrow && !sidebarCollapsed ? ('))
  check('桌面档不渲染那两颗钮（整组在 narrow 分支里）', topbarNav.includes('topbar-nav-btn') && !outside860.includes('.topbar-nav-btn'))
}

// ── [2] 手机：整条侧栏不占位 ──────────────────────────────────────────────────
console.log('[2] 手机：收起态整条侧栏不占位、窄栏不再画')
{
  check('≤860 那一档在（侧栏让位那条）', block860 !== null)
  check('收起态整条侧栏不占位（正文直接拿全宽）', block860 !== null && /\.app\[data-rail='1'\] > \.sidebar \{\s*\n\s*display: none/.test(block860))
  check('展开态仍是浮层（上面那条规则跟着它走）', block860 !== null && /\.sidebar:not\(\.rail\) \{[\s\S]*?position: absolute/.test(block860))
  check('窄栏不再渲染（收起态在手机上什么都不画）', app.includes('{sidebarCollapsed && !narrow ? <SidebarRail'))
  check('侧栏内容留着不卸载（用 display 藏，抽屉一拉状态还在）', !/sidebarCollapsed \? null : <div className="sidebar-slot"/.test(app) && app.includes('className="sidebar-slot"'))
  check('这两条只写在 860 档（桌面档不许被藏）', !hasRule(outside860, ".app[data-rail='1'] > .sidebar"))
}

// ── [3] 顶栏导航钮：会话在左上、插件在右上 ───────────────────────────────────
console.log('[3] 顶栏导航：会话（左上，拉抽屉）/ 插件（右上，整页）')
{
  check('两颗钮的标记类都在（topbar-nav-btn × 2）', (topbarNav.match(/topbar-nav-btn/g) ?? []).length === 2)
  // 位置口径（当天第二条反馈）：拉左侧抽屉的那颗必须在**左上**——点右上角却从左边冒出
  // 东西，位置与结果对不上；插件是整页跳转，留在右上。
  check('「会话」钮在标题**之前**（左上角，抽屉从哪出来钮就在哪边）', app.indexOf('aria-label="会话"') < app.indexOf('<span className="title">') && app.indexOf('aria-label="会话"') > app.indexOf('<div className="topbar-title-row">'))
  check('「插件」钮在弹性填充**之后**（右上角，挨着工作区打开组那一片）', app.indexOf('aria-label="插件"') > app.indexOf('<div className="drag-fill" />'))
  check('两颗都在顶栏标题行里（tabs 之前）', app.indexOf('topbar-title-row') < app.indexOf('topbar-nav-btn') && app.indexOf('topbar-nav-btn') < app.indexOf('<nav className="tabs"'))
  check('「会话」钮：点它拉出侧栏抽屉（toggleSidebar 就是真源）', sessionsNav.includes('onClick={toggleSidebar}'))
  check('「会话」钮：说清了它是什么（tip 是「会话」）', sessionsNav.includes('data-tip="会话"'))
  check('「会话」钮：图标是面板那颗（与桌面开合钮同一套语言）', sessionsNav.includes('<IconSidebar size={16} />'))
  check('插件钮：文案与 aria 齐（tip / label / pressed）', topbarNav.includes('data-tip="插件"') && topbarNav.includes('aria-label="插件"') && topbarNav.includes("aria-pressed={page === 'plugins'}"))
  check('插件钮：点它开插件中心，再点回正文（与窄栏那颗同一口径）', topbarNav.includes("setShellPage(page === 'plugins' ? null : 'plugins')"))
  check('插件钮：当前在插件页时带 on 态', /className=\{`icon-btn topbar-nav-btn\$\{page === 'plugins' \? ' on' : ''\}`\}/.test(topbarNav))
  check('插件钮：图标是拼图那颗', pluginsNav.includes('<IconPuzzle size={16} />'))
  check('两颗都是 icon-btn（几何跟全站图标钮同一份）', (topbarNav.match(/className=\{`icon-btn topbar-nav-btn|className="icon-btn topbar-nav-btn/g) ?? []).length === 2)
  // 各自在自己的 `{narrow ? ( … ) : null}` 守卫块里（桌面档一个字都不该漏出去）。
  // 每一处 `topbar-nav-btn`（会话 / 插件 / 页头带的返回与会话）都必须落在 `{narrow ? ( … ) : null}`
  // 守卫块里——桌面档一个字都不该漏出去。
  const narrowBlocks = [...app.matchAll(/\{narrow \? \(/g)].map((match) => sliceFrom(app.slice(match.index ?? 0), '{narrow ? (', ') : null'))
  const guarded = narrowBlocks.reduce((n, block) => n + (block.match(/topbar-nav-btn/g) ?? []).length, 0)
  const totalMarkers = (app.match(/topbar-nav-btn/g) ?? []).length
  check('顶栏钮的每一处都在 narrow 守卫块里（桌面档不会漏出去）', guarded === totalMarkers && totalMarkers >= 4, `${String(guarded)}/${String(totalMarkers)}，守卫块 ${String(narrowBlocks.length)} 个`)
  check('两颗各自单独一个 narrow 分支（左上那颗不跟右上那颗同生共死）', (app.match(/\{narrow \? \(/g) ?? []).length >= 3)
}

// ── [4] 整页模式的页头带（当天第三条反馈：进页后没有回程）────────────────────
console.log('[4] 整页模式：手机档得有回程带')
{
  check('页头带只在窄屏渲染（桌面侧栏常驻，那边不需要）', /\) : \(\s*\n\s*<>\s*\n\s*\{\/\* 手机档的\*\*页头带\*\*/.test(app) && app.includes('{narrow ? (\n                <div className="page-strip">'))
  check('页头带与页槽同在一支（兄弟关系，页槽照旧挂在 .main 里）', app.indexOf('page-strip') < app.indexOf('<SlotOutlet slots={slots} slot={SLOT.page} />'))
  check('左边是「返回对话」：图标 + aria + 行为（setShellPage(null)）', pageBranch.includes('aria-label="返回对话"') && pageBranch.includes('data-tip="返回对话"') && pageBranch.includes('<IconChevronLeft size={16} />') && pageBranch.includes('setShellPage(null)'))
  check('中间报当前页名（进页之后知道自己在哪一页）', pageBranch.includes("{page === 'plugins' ? '插件' : '技能'}"))
  check('右边是开会话抽屉那颗（抽屉里的技能/插件入口也够得着）', pageBranch.includes('aria-label="会话"') && pageBranch.includes('onClick={toggleSidebar}'))
  check('那颗返回钮复用同一套标记类（几何由 .icon-btn 一份管）', (pageBranch.match(/className="icon-btn topbar-nav-btn"/g) ?? []).length === 2)
  check('CSS：页头带有规则体（新类名不许裸奔）', hasRule(styles, '.page-strip'))
  check('CSS：页名与顶栏标题同一档字', /\.page-strip \.title \{[\s\S]*?font-weight: 600/.test(styles) && /\.page-strip \.title \{[\s\S]*?font-size: var\(--dsc-fs-ui-lg\)/.test(styles))
  check('CSS：高度吃顶栏那同一个变量（不另写一个数）', /\.page-strip \{[\s\S]*?height: var\(--dsc-titlebar-h\)/.test(styles))
  check('CSS：下缘那条线与顶栏同款', /\.page-strip \{[\s\S]*?border-bottom: 1px solid var\(--dsc-stroke-3\)/.test(styles))
  // 抽屉里点「技能/插件」进整页时，抽屉必须自己让位（否则整页开在抽屉+遮罩后面，像没反应）。
  check('进整页时抽屉自动收起（只在窄屏）', /if \(narrow && page !== null\) setSidebarCollapsed\(true\)/.test(app))
}

// ── [5] 抽屉遮罩 ─────────────────────────────────────────────────────────────
console.log('[5] 抽屉遮罩：拉出来还关得掉')
{
  check('三条件：窄屏 + 展开（收起时不渲染）', app.includes('{narrow && !sidebarCollapsed ? (') && app.includes('<div className="sidebar-scrim"'))
  check('点它收起侧栏', app.includes('onClick={toggleSidebar}') && /className="sidebar-scrim" onClick=\{toggleSidebar\}/.test(app))
  check('它在 aside 之后、main 之前（压在正文上、压不住侧栏）', app.indexOf('</aside>') < app.indexOf('sidebar-scrim') && app.indexOf('sidebar-scrim') < app.indexOf('<div className="main">'))
  check('CSS：只写在 860 档', block860 !== null && block860.includes('.sidebar-scrim') && !hasRule(outside860, '.sidebar-scrim'))
  // 定位用 `inset: 0`（与另外五张遮罩同一形）；老内核那条兜底必须点在它身上——
  // 兜底块自己在产物里会被压缩器坑（见 `ui-legacy-compat-test` [3] 的产物门），
  // 所以这里只钉「名单里有它」。
  check('CSS：与另外五张遮罩同形（`inset: 0`）', block860 !== null && /\.sidebar-scrim \{[\s\S]*?inset: 0;/.test(block860))
  check('CSS：进了老内核那条兜底名单（老内核上它才盖得住整屏）', insetFallback.includes('.sidebar-scrim'))
  check('CSS：兜底块没被压成 inset（名单不是凑数的）', insetFallback.includes('width: 100%') && !insetFallback.includes('inset:'))
  check('CSS：底色与模糊走遮罩令牌（不只是「点得到」，还要看得见）', block860 !== null && /\.sidebar-scrim \{[\s\S]*?background: var\(--dsc-scrim\);/.test(block860) && /\.sidebar-scrim \{[\s\S]*?backdrop-filter: blur\(var\(--dsc-scrim-blur\)\);/.test(block860))
  check('CSS：z-index 39，压在侧栏（40）之下', block860 !== null && /\.sidebar-scrim \{[\s\S]*?z-index: 39;/.test(block860) && /\.sidebar:not\(\.rail\) \{[\s\S]*?z-index: 40;/.test(block860))
}

// ── [5] 轨迹页签 ─────────────────────────────────────────────────────────────
console.log('[6] 轨迹页签：桌面两颗，手机只留回头路')
{
  check('手机档那一支在（narrow 三元的第一支）', tabsNav.includes("threadView === 'trace'"))
  check('手机档只有轨迹页上才画（在对话页整行不渲染，36px 让给正文）', /narrow \? \(\s*\n\s*threadView === 'trace' \? \(/.test(app))
  check('回头路是「← 对话」：图标 + 文案', tabsNarrow.includes('<IconChevronLeft size={14} />') && tabsNarrow.includes('对话'))
  check('点它回对话页', tabsNarrow.includes("setThreadView('chat')"))
  check('它不是页签（手机档那一支里一次 role=tab 都没有）', tabsNarrow !== '' && !tabsNarrow.includes('role="tab"'))
  check('桌面档那两支仍是角色完整的页签（role=tab × 2）', (tabsNav.match(/role="tab"/g) ?? []).length === 2)
  check('IconChevronLeft 已登记在壳的图标 import 里（编译门）', /^\s*IconChevronLeft,$/m.test(app))
}

// ── [6] 手机上收掉的两个桌面入口 ─────────────────────────────────────────────
console.log('[7] 手机上收掉的：在资源管理器中打开 / 设置')
{
  check('`.ws-open` 在 860 档藏掉（手机没有原生桥，点了只弹错）', block860 !== null && /\.ws-open \{\s*\n\s*display: none/.test(block860))
  check('页脚那颗「设置」也在 860 档藏掉（手机上的设置页版式是崩的）', block860 !== null && /\.sidebar-footer \.row-btn \{\s*\n\s*display: none/.test(block860))
  check('这两条不在 860 档以外（桌面照旧看得见）', !hasRule(outside860, '.ws-open') && !hasRule(outside860, '.sidebar-footer .row-btn'))
  // 对账（防「藏了个不存在的东西」的僵尸规则）：两个选择器在 legacy 里真的还挂着规则。
  check('对账：`.ws-open` 在 legacy 里确实有规则', hasRule(views, '.ws-open'))
  check('对账：`.sidebar-footer .row-btn` 在 legacy 里确实有规则', hasRule(views, '.sidebar-footer .row-btn'))
  check('对账：两处都真的由插件渲染出来（不是死类名）', sessions.includes('ws-open') && sessions.includes('row row-btn'))
}

// ── [7] 输入框高度 ───────────────────────────────────────────────────────────
console.log('[8] 输入框高度：桌面 40、手机 44，只此一家')
{
  check(':root 里有 --dsc-input-box-h: 40px（ZCode 的 min-h-10 同款）', /:root \{[\s\S]*?--dsc-input-box-h: 40px;/.test(styles))
  check('文字区吃这条令牌（min-height）', /\.composer textarea \{[\s\S]*?min-height: var\(--dsc-input-box-h/.test(views))
  check('手机上放宽到 44（点得中）', block560 !== null && /--dsc-input-box-h: 44px;/.test(block560))
  check('两个取值各只有一处（没有第三处散写）', (styles.match(/--dsc-input-box-h:/g) ?? []).length === 2 && !views.includes('--dsc-input-box-h:'))
  check('没有硬编码：textarea 那条不是 min-height: 40px 写死', !/\.composer textarea \{[^{}]*min-height: \d+px/.test(views))
  check('自动增高的上限没动（长文仍在框内滚）', /\.composer textarea \{[\s\S]*?max-height: var\(--dsc-input-max-h\)/.test(views))
}

// ── [8] 手机底栏两行 + 点框内空白聚焦 ────────────────────────────────────────
console.log('[9] 手机底栏两行：右组整行、发送贴右缘、两行都收矮')
{
  check('≤560 那一档在（输入行那条）', block560 !== null)
  check('底栏仍允许换行（两行的前提）', block560 !== null && /\.composer-bar \{[\s\S]*?flex-wrap: wrap/.test(block560))
  check('行距收到 4（原 6）', block560 !== null && /\.composer-bar \{[\s\S]*?row-gap: 4px/.test(block560))
  check('底栏内距收到 2/8/6（原 2/8/8）', block560 !== null && /\.composer-bar \{[\s\S]*?padding: 2px 8px 6px/.test(block560))
  check('右组整行占第二行（flex-basis 100%，不再靠挤不挤得下撞运气）', block560 !== null && /\.composer-bar \.bar-right \{\s*\n\s*flex: 1 1 100%;\s*\n\s*margin-left: 0;/.test(block560))
  check('发送键贴第二行右缘（不再浮在两行之间）', block560 !== null && /\.composer-bar \.send-btn \{\s*\n\s*margin-left: auto;/.test(block560))
  check('发送键收矮到 32（跟第一行那排 28 的 chip 看着一样高）', block560 !== null && /--dsc-send: 32px;/.test(block560))
  check('这两条只在 560 档（桌面底栏仍是一行、发送仍在组尾）', !hasRule(outside560, '.composer-bar .send-btn'))
  check('既有两条不回归：两组仍可收缩、chip 里名字不竖排', block560 !== null && /\.composer-bar \.bar-left,\s*\n\s*\.composer-bar \.bar-right \{\s*\n\s*min-width: 0;/.test(block560) && /\.model-btn \{[\s\S]*?white-space: nowrap/.test(block560))
  check('输入区左右内距那条还在（窄屏收窄）', block560 !== null && /\.composer-zone \{\s*\n\s*padding: 0 12px 8px;/.test(block560))

  const guard = "target.closest('button, textarea, input, .model-pop, .pop-mask')"
  check('点框内空白 → 聚焦文字区（那一指点空不再落空）', composer.includes('onClick={(event) => {') && composer.includes('area.current?.focus()'))
  check('守卫：命中按钮/输入框/浮层时不抢焦点', composer.includes(guard))
  check('守卫注释里说明了为什么（菜单刚点开就被收掉）', composer.includes('抢焦点会把刚点开的菜单收掉'))
}

// ── [10] 三颗旋钮的浮层在手机上贴输入卡片 ─────────────────────────────────────
console.log('[10] 手机上权限/模式/档位三颗的浮层：贴住输入卡片，不探出屏幕')
{
  // 报障（2026-10-15，手机截图）：点「标准模式」那张浮层，行文字只剩尾字。量出来是
  // 300px 的面板右缘对齐 chip、而 chip 排在行中间 → 面板左缘跑到屏幕外（430px 实测 x=-65）。
  const sheetSpots = [...composer.matchAll(/model-anchor model-anchor-sheet/g)].map((match) => match.index ?? -1)
  const popAt = (name) => composer.indexOf(name)
  check('三颗旋钮的锚点各挂一次 sheet 类（不是同一处挂三遍）', sheetSpots.length === 3)
  check(
    '三处 sheet 与三张浮层一一对应（权限 → 模式 → 档位，顺序不错位）',
    sheetSpots[0] < popAt('policy-pop') &&
      sheetSpots[1] > popAt('policy-pop') &&
      sheetSpots[1] < popAt('preset-pop') &&
      sheetSpots[2] > popAt('preset-pop') &&
      sheetSpots[2] < popAt('effort-pop'),
    JSON.stringify({ sheetSpots, pops: [popAt('policy-pop'), popAt('preset-pop'), popAt('effort-pop')] }),
  )
  check('模型那颗的锚点**没**挂（它有自己一套窄面板 + 悬浮飞出）', (composer.match(/className="model-anchor"/g) ?? []).length === 2)
  check('CSS：锚点交回输入卡片（position: static）', block560 !== null && /\.composer-bar \.model-anchor-sheet \{[\s\S]*?position: static;/.test(block560))
  check(
    'CSS：面板左右各留 8px、宽度跟着卡片走',
    block560 !== null && /\.composer \.composer-bar \.model-anchor-sheet > \.model-pop \{[\s\S]*?left: 8px;[\s\S]*?right: 8px;[\s\S]*?width: auto;/.test(block560),
  )
  check('CSS：只写在 560 档（桌面照旧锚在各自 chip 上）', !hasRule(outside560, '.composer-bar .model-anchor-sheet'))
  // 特异性对账：legacy 里那条权限面板的左对齐是 4 个类（`.composer-bar .bar-left .model-pop.policy-pop`），
  // 比三个类高一级——光靠 `width: auto` 只赢一半（权限那张会变成「左缘贴卡片、宽度按内容缩」，
  // 走查实测 x=13/宽 233，与旁边两颗不齐）。所以这条也凑到 4 个类，靠 styles.css 在 views.css
  // 之后取胜（与 `[data-rail-hidden]` 同一套办法）。
  check('legacy 那条 4 类的权限左对齐还在（对账：说明确实要压）', /\.composer-bar \.bar-left \.model-pop\.policy-pop \{/.test(views))
  check('这条也是 4 个类（与 legacy 那条同档，靠源码序胜——注释里写明了）', /\.composer \.composer-bar \.model-anchor-sheet > \.model-pop \{/.test(block560 ?? ''))
  check('模型菜单没被这条扫到（它的宽度规则仍是自己那条）', !/model-anchor-sheet[^}]*model-picker/.test(styles))
}

// ── [11] 样式门 ──────────────────────────────────────────────────────────────
console.log('[11] 样式门：新类名、撞名、硬编码色、幽灵令牌')
{
  const NEW_CSS_CLASSES = ['sidebar-scrim']
  check('新类名都有规则体', NEW_CSS_CLASSES.every((name) => hasRule(styles, `.${name}`)), NEW_CSS_CLASSES.filter((n) => !hasRule(styles, `.${n}`)).join(','))
  // `topbar-nav-btn` 是**标记类**（探针与走查认它），几何全靠 `.icon-btn`：所以它必须只在 JSX 里。
  check('标记类不进 CSS（几何只由 .icon-btn 一份管）', !hasRule(styles, '.topbar-nav-btn') && !hasRule(views, '.topbar-nav-btn'))

  // 撞名门：新类名不许在 legacy 四份 CSS 里出现过（上一版吃过这个亏：`.model-row` 撞上
  // 设置页同名类，行静默竖排）。styles.css 是它自己的家，所以只扫 legacy 那四份。
  const legacyCss = ['views', 'tokens', 'base', 'primitives'].map((n) => flat(read(`ui-shell/src/legacy/${n}.css`))).join('\n')
  const collideLegacy = NEW_CSS_CLASSES.concat('topbar-nav-btn').filter((name) => new RegExp(`\\.${name}[\\s,{:.]`).test(legacyCss))
  check('不撞 legacy 里的既有类名', collideLegacy.length === 0, collideLegacy.join(','))
  check('新类名在 styles.css 里只定义一次（不留第二份漂移）', (stylesNoFallback.match(/\.sidebar-scrim[ \t]*\{/g) ?? []).length === 1)
  const shellFiles = collect(join(root, 'ui-shell/src')).filter((f) => !f.endsWith('ui-layout\\app.tsx') && !f.endsWith('ui-layout/app.tsx'))
  const collideFiles = []
  for (const file of shellFiles) {
    const text = flat(readFileSync(file, 'utf8'))
    for (const name of NEW_CSS_CLASSES.concat('topbar-nav-btn')) if (text.includes(name)) collideFiles.push(`${file.slice(root.length)}=${name}`)
  }
  check('壳内别的源码里也没有同名类（只有 app.tsx 用）', collideFiles.length === 0, collideFiles.slice(0, 3).join(','))

  // 硬编码色：新类名的规则体里不许出现色值（hermes 口径：颜色一律走令牌）。
  const hardcodedColors = (css, classNames) => {
    const hits = []
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (match[1] ?? '').trim().split('\n').pop()?.trim() ?? ''
      if (selector.startsWith('@')) continue
      if (!classNames.some((name) => selector.includes(`.${name}`))) continue
      if (/(#[0-9a-fA-F]{3,8}\b|rgba?\()/.test(match[2] ?? '')) hits.push(selector)
    }
    return hits
  }
  check('新类名的规则体里没有硬编码色', hardcodedColors(styles, NEW_CSS_CLASSES).length === 0, hardcodedColors(styles, NEW_CSS_CLASSES).join(','))

  // 幽灵令牌：新样式块里每个 var(--dsc-*) 都要在五份 CSS 的并集里有定义（拼错会静默透明）。
  const tokenTable = ['views', 'tokens', 'base', 'primitives'].map((n) => flat(read(`ui-shell/src/legacy/${n}.css`))).join('\n')
  const ghostScan = (slice) =>
    [...slice.matchAll(/var\((--dsc-[a-z0-9-]+)/g)]
      .map((match) => match[1])
      .filter((token, index, all) => all.indexOf(token) === index)
      .filter((token) => !`${styles}\n${tokenTable}`.includes(`${token}:`))
  const newBlocks = [block860 ?? '', block560 ?? ''].join('\n')
  check('新样式块里没有幽灵令牌（拼错的 var 会静默透明）', ghostScan(newBlocks).length === 0, ghostScan(newBlocks).join(','))
  // 那两块里没有 `var()` 用法（藏掉的几条都是 display: none，覆写的两个是令牌**定义**），
  // 所以换一台对准定义：块内只允许覆写那两个高度值，名字必须与 `:root` 里那份对得上。
  const ALLOWED_DEFS = ['--dsc-input-box-h', '--dsc-send']
  const defs = [...newBlocks.matchAll(/(--dsc-[a-z0-9-]+):/g)].map((match) => match[1])
  check('新块里只覆写那两个高度令牌（拼错的名字会静默失效）', defs.length > 0 && defs.every((token) => ALLOWED_DEFS.includes(token)), defs.join(','))
  check('覆写的名字在 :root 里都有出处（不是凭空冒出来的）', defs.every((token) => new RegExp(`${token}:`).test(styles)), defs.join(','))
  check('负向：块内写一个拼错的令牌名会被同一台扫描器抓到', !["--dsc-sendd"].every((token) => ALLOWED_DEFS.includes(token)))
}

// ── [12] 负向自证 ────────────────────────────────────────────────────────────
console.log('[12] 负向自证：这些扫描器不是空转的')
{
  check('负向：mediaBlock 取不到标记时给 null', mediaBlock(styles, 560, '.不存在的标记') === null)
  check('负向：hasRule 不会被「类名只出现在注释里」骗过', hasRule('/* .sidebar-scrim 删了 */\n', '.sidebar-scrim') === false)
  check('负向：hasRule 抓到真规则', hasRule('\n.sidebar-scrim {\n  z-index: 39;\n}', '.sidebar-scrim'))

  const hardcodedColors = (css, classNames) => {
    const hits = []
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (match[1] ?? '').trim().split('\n').pop()?.trim() ?? ''
      if (selector.startsWith('@')) continue
      if (!classNames.some((name) => selector.includes(`.${name}`))) continue
      if (/(#[0-9a-fA-F]{3,8}\b|rgba?\()/.test(match[2] ?? '')) hits.push(selector)
    }
    return hits
  }
  check('负向：假 CSS 里的硬编码色会被抓到', hardcodedColors('.sidebar-scrim { background: #000; }', ['sidebar-scrim']).length === 1)
  check('负向：这套色值扫描器在真 CSS 上确实什么都没抓到（不恒真）', hardcodedColors(styles, ['sidebar-scrim']).length === 0)

  const ghostScan = (slice, table) =>
    [...slice.matchAll(/var\((--dsc-[a-z0-9-]+)/g)]
      .map((match) => match[1])
      .filter((token, index, all) => all.indexOf(token) === index)
      .filter((token) => !table.includes(`${token}:`))
  check('负向：拼错的令牌会被差集扫出来', ghostScan('.x { background: var(--dsc-bg-popoverr); }', '--dsc-bg-popover: #000;').length === 1)

  const collide = (css, names) => names.filter((name) => new RegExp(`\\.${name}[\\s,{:.]`).test(css))
  check('负向：撞名门喂一段同名假 CSS 会报红', collide('\n.sidebar-scrim { z-index: 39; }', ['sidebar-scrim']).length === 1)

  // 「只在手机档生效」那台检查器：规则写到 860 块外面必须被抓到。
  const outsideCheck = (css) => {
    const b = mediaBlock(css, 860, '.sidebar:not(.rail)')
    const rest = b === null ? css : css.replace(b, '')
    return hasRule(rest, '.ws-open')
  }
  check('负向：把 `.ws-open { display: none }` 挪到 860 块外，会被「只藏在手机档」抓到', outsideCheck('@media (max-width: 860px) {\n  .sidebar:not(.rail) {\n    z-index: 40;\n  }\n}\n.ws-open {\n  display: none;\n}'))
  check('负向：真源码上同一台检查器给假（桌面档没被藏）', outsideCheck(styles) === false)

  const guardOf = (text) => text.includes('target.closest(') && text.includes("'button, textarea, input, .model-pop, .pop-mask'")
  check('负向：守卫里漏掉 `button`（点按钮会去抢焦点、把刚开的菜单收掉）会被抓到', guardOf("target.closest('textarea, .model-pop')") === false)
  check('负向：真源码上守卫是完整的', guardOf(composer))

  check('负向：两颗钮的「只在窄屏渲染」检查器抓得住漏出来的实现', !sliceFrom('const x = <button className="icon-btn topbar-nav-btn" />', '{narrow ? (', ') : null}').includes('topbar-nav-btn'))
  check('负向：真源码上那两颗确实在 narrow 分支里', topbarNav.includes('topbar-nav-btn'))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
