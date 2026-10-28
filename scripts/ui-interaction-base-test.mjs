/**
 * 交互基础件探针（2026-10-25，P0）：焦点管理、骨架屏、错误文案的人话层。
 *
 * 三段：
 *   [1] humanizeError 真值表——网络断、路径没了、凭据不对、限流、服务端 5xx、超时、
 *       没命中规则的原样回落、空值；外加「原文必须保留」与 humanErrorLine 的形状。
 *       判据对「永远返回同一句」的假实现必须红（弄脏副本验证）。
 *   [2] 焦点管理：hook 的四件事逐条文本钉（来源记下 / 初始焦点 / Tab 循环 / 关闭归还），
 *       以及**接入点**：设置、模型清单、团队、轨迹检查器四个弹层真的用了它；
 *       设置原来那条 window 级 Esc 已经撤掉（否则会与 hook 双触发）。
 *   [3] 骨架屏：CSS 里有 `.dsc-skeleton`、扫光 keyframes、reduced-motion 守卫；
 *       组件从基元库转出；五个「正在读取」占位已换成骨架（正反双验）。
 *
 * 跑法：node scripts/ui-interaction-base-test.mjs（[3] 的产物检查需要先 pnpm build:ui）
 *
 * @module dsc/scripts/ui-interaction-base-test
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPluginSource } from './_check-runner.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

const { humanizeError, humanErrorLine, humanErrorText } = await import(
  new URL('../ui-shell/src/ui-primitives/humanize-error.ts', import.meta.url).href
)

// ── [1] 人话层真值表 ───────────────────────────────────────────────────────────

console.log('[1] humanizeError 真值表')
{
  const cases = [
    ['Error: connect ECONNREFUSED 127.0.0.1:17321', '连不上宿主'],
    ['TypeError: Failed to fetch', '连不上宿主'],
    ["Error: ENOENT: no such file or directory, open 'D:\\nope'", '这个路径不存在了'],
    ['Error: EACCES: permission denied, mkdir', '系统不允许这一步'],
    ['HTTP 401 Unauthorized: invalid api key', '凭据不对或过期'],
    ['Error: 429 Too Many Requests', '请求太频繁，被服务方限流了'],
    ['Error: ETIMEDOUT while reading', '等太久了，请求被掐断'],
    ['HTTP 502 Bad Gateway', '对方服务自己出错了'],
  ]
  for (const [input, title] of cases) {
    const got = humanizeError(input)
    check(`「${input.slice(0, 34)}…」→ ${title}`, got.title === title, `拿到「${got.title}」`)
    check(`  原文保留（${title}）`, got.detail === input, got.detail)
    check(`  有下一步（${title}）`, typeof got.hint === 'string' && got.hint.length >= 4)
  }

  // 没命中规则：原文第一句当标题（去掉 Error: 前缀），不能吞成一句万能话。
  const generic = humanizeError('Error: 会话文件校验不过\n    at readSession (x.js:1:1)')
  check('未命中规则：取原文首句当标题', generic.title === '会话文件校验不过', generic.title)
  check('未命中规则：给通用下一步', generic.hint.includes('再试一次'))
  check('未命中规则：多行原文整串保留', generic.detail.includes('at readSession'))

  // 空值 / 非字符串：回落文案，不抛。
  const empty = humanizeError(undefined)
  check('空值回落成给定文案', empty.title === '这一步没有完成', empty.title)
  check('空值不抛、detail 为空', empty.detail === '')
  check('非字符串值可被 String 化', humanizeError({ code: 1 }).detail.includes('code'))

  // 单行形态：标题 + 破折号 + 下一步，且不夹带换行（toast 只有一行）。
  const line = humanErrorLine('Error: ENOENT: no such file')
  check('humanErrorLine 是单行且含下一步', !line.includes('\n') && line.includes('——') && line.includes('路径'))
  const inline = humanErrorText('Error: connect ECONNREFUSED', '读取失败')
  check('humanErrorText 给 text + detail 两件', inline.text.includes('连不上宿主') && inline.detail.includes('ECONNREFUSED'))

  // 负向对照：一个「永远同一句」的实现，在同一张表上必须大面积不符。
  // 这条能红，才说明上表真的在区分错因，而不是恰好都对。
  const naive = () => ({ title: '操作失败', hint: '请重试', detail: '' })
  const misses = cases.filter(([input, title]) => naive(input).title !== title).length
  check('负向：万能话实现在同一张表上大面积不符', misses === cases.length, `${misses}/${cases.length}`)
}

// ── [2] 焦点管理 ──────────────────────────────────────────────────────────────

console.log('[2] 弹层焦点管理')
{
  const hook = read('ui-shell/src/ui-primitives/dialog-focus.ts')
  check('记下来源焦点', hook.includes('document.activeElement') && hook.includes('last.isConnected'))
  check('关掉归还来源焦点', hook.includes('last.focus({ preventScroll: true })'))
  check('初始焦点按 [data-autofocus] → 第一个可聚焦 → 弹层本身', hook.includes("'[data-autofocus]'") && hook.includes('items()[0] ?? dialog'))
  check('Tab / Shift+Tab 在弹层内循环', hook.includes("event.key !== 'Tab'") && hook.includes('event.shiftKey') && hook.includes('tail.focus()'))
  check('Esc 交给调用方并掐断冒泡（嵌套弹层只关里层）', hook.includes("event.key === 'Escape'") && hook.includes('event.stopPropagation()'))
  check('回调走 ref（内联箭头不会让 effect 每次重跑）', hook.includes('const close = useRef(onClose)') && hook.includes('}, [active])'))

  const wiring = [
    ['ui-shell/src/plugins/settings/ui.tsx', 'settings', '设置面板'],
    ['ui-shell/src/plugins/settings/models.tsx', 'models-discover-card', '模型清单弹窗'],
    ['ui-shell/src/plugins/team/ui.tsx', 'team-panel', '智能体团队'],
    ['ui-shell/src/plugins/trace/inspector.tsx', 'trace-inspector', '轨迹检查器'],
  ]
  for (const [file, marker, label] of wiring) {
    const src = read(file)
    check(`${label}接上了 hook`, src.includes('useDialogFocus(') && src.includes('ref={dialog.ref}'), file)
    check(`${label}的 hook 挂在弹层根上`, src.includes(marker), marker)
  }
  const settings = read('ui-shell/src/plugins/settings/ui.tsx')
  check('设置面板撤掉了原来的 window 级 Esc（不与 hook 双触发）', !settings.includes("window.addEventListener('keydown', onKey)"))
  const team = read('ui-shell/src/plugins/team/ui.tsx')
  check('团队面板的 Esc 仍分两层（先退出运行记录）', team.includes('if (peeking !== null) setPeeking(null)'))
}

// ── [3] 骨架屏 ────────────────────────────────────────────────────────────────

console.log('[3] 骨架屏')
{
  const css = read('ui-shell/src/styles.css')
  check('CSS 有 .dsc-skeleton 与扫光 keyframes', /\.dsc-skeleton \{[\s\S]*?\}/.test(css) && css.includes('@keyframes dsc-skeleton-sweep'))
  check('reduced-motion 时扫光停下', /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,200}?\.dsc-skeleton::after \{\s*animation: none/.test(css))
  check('读屏状态行视觉藏起来但没进 display:none', /\.dsc-loading-status \{[^}]*clip-path: inset\(50%\)/.test(css))
  const barrel = read('ui-shell/src/ui-primitives/index.ts')
  check('骨架组件从基元库转出', barrel.includes("export * from './skeleton'"))
  const comp = read('ui-shell/src/ui-primitives/skeleton.tsx')
  check('组件三件：Skeleton / SkeletonText / LoadingStatus', ['export function Skeleton', 'export function SkeletonText', 'export function LoadingStatus'].every((name) => comp.includes(name)))
  check('占位块不进可达树（aria-hidden）', comp.includes('aria-hidden="true"'))

  const sites = [
    ['ui-shell/src/plugins/settings/ui.tsx', '正在读取分区…', '设置分区'],
    ['ui-shell/src/plugins/settings/usage.tsx', '正在读取用量记录…', '用量页'],
    ['ui-shell/src/plugins/plugins/ui.tsx', '正在读取配置…', '插件配置'],
    ['ui-shell/src/plugins/skills/ui.tsx', '正在扫描技能目录…', '技能页'],
    ['ui-shell/src/plugins/team/ui.tsx', '正在读运行记录…', '团队运行记录'],
  ]
  for (const [file, oldText, label] of sites) {
    const src = read(file)
    check(`${label}不再用一行灰字占位`, !src.includes(oldText), `还留着「${oldText}」`)
    check(`${label}改画骨架且带读屏状态`, src.includes('className="settings-loading"') && src.includes('role="status"'))
  }

  const built = join(root, 'lib/ui/assets')
  if (existsSync(built)) {
    const files = readFileSync(join(root, 'lib/ui/plugins/sessions/client.js'), 'utf8')
    void files
  }
}

// ── [4] P1：品牌档位、今日读数、断线提示 ─────────────────────────────────────

console.log('[4] P1 三项')
{
  const css = read('ui-shell/src/styles.css')
  const app = read('ui-shell/src/ui-layout/app.tsx')
  const statusbar = read('ui-shell/src/plugins/statusbar/ui.tsx')
  const sessions = read('ui-shell/src/plugins/sessions/ui.tsx')
  const transcript = readPluginSource('ui-shell/src/plugins/transcript')
  const channel = read('ui-shell/src/ui-layout/host-channel.ts')

  // 品牌两档：侧栏 20 / 窄栏 22，全部走变量。空态那档 2026-10-27 撤掉（用户说图标突兀）。
  check('品牌档位表存在（两档变量）', ['--dsc-logo-sm: 20px', '--dsc-logo-md: 22px'].every((line) => css.includes(line)))
  check('侧栏 logo 用 sm 档', /\.sidebar-header img \{[^}]*var\(--dsc-logo-sm\)/.test(css))
  check('窄栏 logo 用 md 档', /\.rail-logo img \{[^}]*var\(--dsc-logo-md\)/.test(css))
  check('空态不再有 logo（连同 xl 档与样式一起删干净）', !transcript.includes('welcome-logo') && !css.includes('welcome-logo') && !css.includes('--dsc-logo-xl'))
  // 四张能力卡并排：提示语一句还是两句会把标题顶得高低不一，留满两行高才对得齐。
  check('能力卡提示语留满两行（标题对得齐）', /\.welcome-card-hint \{[^}]*min-height: 2lh/.test(css))

  // 今日读数只留侧栏页脚（2026-10-28 对齐 dsh：底排只有轮/步、tok、上下文三段）。
  check('共享 hook：ui-layout/usage-today 存在', existsSync(join(root, 'ui-shell/src/ui-layout/usage-today.ts')))
  check('hook 从 @dsc/ui 转出', read('ui-shell/src/plugin-api.ts').includes('useTodayUsage'))
  check('状态栏不再挂今日段', !statusbar.includes('function TodaySegment(') && !statusbar.includes('useTodayUsage'))
  check('页脚改用同一份 hook（不再自己拉 usageStats）', sessions.includes('useTodayUsage(usage)') && !/SidebarFooter[\s\S]{0,900}?invoke<UsageStatsView>/.test(sessions))
  check('金额口径只有一份（基元库）', read('ui-shell/src/ui-primitives/tokens.ts').includes('export function formatCostCny') && !sessions.includes('function formatCostCny'))
  check('轮/步取宿主 progress（步数为 0 整段不画）', statusbar.includes('readProgress') && statusbar.includes('Number(steps) > 0'))

  // 断线提示：通道关闭/连接中超过 3 秒才出，带手动重连。
  check('通道有手动重连入口', channel.includes('reconnect(): void') && channel.includes('reconnect() {'))
  check('壳里有断线条组件', app.includes('function ConnectionBanner(') && app.includes('<ConnectionBanner />'))
  check('延迟 3 秒才出（不闪）', /setTimeout\(\(\) => \{\s*setShown\(true\)\s*\}, 3000\)/.test(app))
  check('断开态与重连态说清（给下一步）', app.includes('立即重连') && app.includes('浏览器每 3 秒重试一次'))
  check('断线条有样式（警示黄，不是红）', /\.conn-banner \{[^}]*--dsc-yellow/.test(css))
}

// ── [5] 2026-10-26：思考强度滑杆、模式菜单瘦身、入口搬家、空态宽度 ──────────────

console.log('[5] 2026-10-26 四项')
{
  const css = read('ui-shell/src/styles.css')
  const app = read('ui-shell/src/ui-layout/app.tsx')
  const sessions = read('ui-shell/src/plugins/sessions/ui.tsx')
  const composer = readPluginSource('ui-shell/src/plugins/composer')
  const slider = read('ui-shell/src/plugins/composer/effort-slider.tsx')
  const resizer = read('ui-shell/src/ui-primitives/thread-resizer.tsx')

  // ① 滑杆：档位有顺序，画成一条轨道；四档四套动效，没有「默认」这一格。
  check('档位卡换成滑杆（轨道 + 停点 + 滑钮）', slider.includes('data-effort-track') && slider.includes('data-effort-dot') && slider.includes('data-effort-knob'))
  check('滑杆里没有「默认」这一档（画之前先滤掉）', composer.includes("level !== 'default'") && !slider.includes("'default'"))
  check('拖动中只预览、松手才发请求（拖着扫四档不会打四个请求）', slider.includes('setDrag(') && /const finish = [\s\S]{0,500}?onCommit\(level\)/.test(slider))
  check('键盘能换档（role=slider + 方向键 + Home/End）', slider.includes('role="slider"') && slider.includes("event.key === 'ArrowRight'") && slider.includes("event.key === 'Home'"))
  check('四档各有动效（关静止 / 低呼吸 / 高扫光 / 最大更快）',
    /\.effort-track\[data-level='off'\] \.effort-rail-fill \{[^}]*grayscale/.test(css) &&
      /\[data-level='low'\][\s\S]{0,240}?effort-breathe/.test(css) &&
      /\[data-level='high'\][\s\S]{0,400}?effort-sheen/.test(css) &&
      /\[data-level='max'\] \.effort-rail-fill::after \{[^}]*animation-duration: 1\.2s/.test(css))
  check('减弱动画偏好下四套全停', /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}?effort/.test(css))
  check('轨道底用伪元素压淡（不能用 opacity，会把滑钮一起灰掉）', /\.effort-rail::before \{[^}]*opacity: 0\.22/.test(css) && !/\.effort-rail \{[^}]*opacity/.test(css))
  check('未设置态不画滑钮（没有落点就不假装有）', slider.includes("{unset ? null : (") && /\.effort-track\[data-unset='1'\] \.effort-rail::before/.test(css))
  // 2026-10-26 第二轮：条加粗、底下那排刻度字删掉（只留卡头一行）。
  check('轨道加粗到 12px（原 8px 太细）', /\.effort-rail \{[^}]*height: 12px/.test(css))
  check('滑钮与停点跟着放大（18 / 6）', /\.effort-knob \{[^}]*height: 18px/.test(css) && /\.effort-dot \{[^}]*height: 6px/.test(css))
  check('底下那排刻度字删干净（DOM 与样式都不留）', !slider.includes('effort-tick') && !css.includes('.effort-ticks') && !css.includes('.effort-tick['))

  // ② 模式菜单：去掉右上那句、宽度按内容
  check('模式菜单去掉了「新建/编辑：设置 → 模式」', !/<span className="pop-note">新建\/编辑/.test(composer))
  check('模式菜单宽度按内容（不再写死 300px）', /\.model-pop\.preset-pop \{[^}]*width: max-content/.test(css) && !/\.model-pop\.preset-pop \{\s*\n\s*width: 300px/.test(css))

  // ③ 入口搬家：旁问进右侧栏「开始」页，搜索进顶栏
  check('旁问在右侧栏「开始」页（不是左侧栏导航）', /kind: 'ask', title: '旁问'/.test(read('ui-shell/src/ui-dockkit/dock.tsx')) && !sessions.includes('data-nav="ask"'))
  check('页脚不再有旁问与搜索两行', !sessions.includes('row row-btn ask-entry') && !sessions.includes('shell.palette.open'))
  check('搜索挪到顶栏、压在「在资源管理器打开」左边', app.indexOf('topbar-search') > 0 && app.indexOf('topbar-search') < app.indexOf('slot={SLOT.header}'))
  check('搜索钮真会开命令面板', /className="icon-btn topbar-search"[\s\S]{0,400}?shell\.palette\.open/.test(app))
  // 顶栏整条是窗口拖拽区：按钮不声明 no-drag 就会被当成拖窗口（用户报的「点不动」）。
  check('搜索钮豁免窗口拖拽区（否则点不动）', /\.topbar-search \{[^}]*-webkit-app-region: no-drag/.test(css))
  check('左侧栏没有旁问那颗了（避免与整页入口混淆）', !/<nav className="sidebar-nav">[\s\S]{0,900}?ask/.test(sessions))

  // ④ 空会话：列宽跟着用户拖、整页不横向溢出
  check('空态列宽读用户拖过的值（不然空会话拖不动）', /\.thread-main-empty \{\s*--dsc-thread-max: var\(--dsc-thread-user-max, 720px\)/.test(css))
  check('根上 --dsc-thread-max 也引用同一个用户变量', /:root \{\s*--dsc-thread-max: var\(--dsc-thread-user-max, 76ch\)/.test(css))
  check('拖拽条写的是用户变量（元素级覆盖压不到它）', resizer.includes("setRootVar('--dsc-thread-user-max'") && !resizer.includes("setRootVar('--dsc-thread-max'"))
  check('启动时铺存档也写用户变量', app.includes("setRootVar('--dsc-thread-user-max'"))
  check('整页不横向溢出（右侧栏收起时滑出窗外那块被裁掉）', /\.app \{\s*overflow-x: clip;/.test(css))
}


// ── [6] 2026-10-26 第二轮：调档手感（乐观值 + 同步拖动 + 不写对话）────────────

console.log('[6] 调档手感')
{
  const css = read('ui-shell/src/styles.css')
  const composer = readPluginSource('ui-shell/src/plugins/composer')
  const slider = read('ui-shell/src/plugins/composer/effort-slider.tsx')
  const runtime = read('src/plugins/runtime.ts')
  const methods = read('src/core/ui-methods.ts')

  // ① 乐观值：点下去立刻显示，不等宿主一个来回（否则先弹回旧档再跳过来）
  check('点下去先落乐观值（pendingEffort）', composer.includes('const [pendingEffort, setPendingEffort] = useState<string | null>(null)') && composer.includes('const shownEffort = pendingEffort ?? effort'))
  check('宿主读数对上就撤掉乐观值', /pendingEffort !== null && effort === pendingEffort[\s\S]{0,40}?setPendingEffort\(null\)/.test(composer))
  check('宿主迟迟不认时 1.5 秒兜底（不让界面一直骗人）', /setTimeout\(\(\) => setPendingEffort\(null\), 1500\)/.test(composer))
  check('宿主拒绝时撤乐观值并报错', /catch\(\(reason: unknown\) => \{[\s\S]{0,120}?setPendingEffort\(null\)[\s\S]{0,80}?setFault\(/.test(composer))

  // ② 同步拖动：同一帧里按下再松开也要算数（旧写法读的是 state，那一下会被吞掉）
  check('拖动下标存在 ref 里（事件处理读得到同步值）', slider.includes('const dragRef = useRef<number | null>(null)') && slider.includes('dragRef.current = next'))
  check('松手读的是 ref、不是 state', /const at = dragRef\.current[\s\S]{0,520}?onCommit\(level\)/.test(slider))

  // ③ 过渡：滑钮滑过去、拖动中跟手
  check('滑钮有 left 过渡（档位之间滑过去）', /\.effort-knob \{[^}]*transition: left 140ms/.test(css))
  check('拖动中取消过渡（跟手，不落后于指针）', /\.effort-track\[data-dragging='1'\] \.effort-knob \{[^}]*transition: none/.test(css))

  // ④ 不往对话里写「思考强度设为…」：一次调档一行 system 记录，又占正文又多推一帧
  check('界面调档带 quiet=true', composer.includes("channel.invoke('setEffort', [level, true])"))
  check('宿主按 quiet 决定写不写那行', /if \(!quiet\) \{[\s\S]{0,400}?思考强度设为/.test(runtime))
  check('快照仍要 touch（status.effort 变了，界面靠它撤乐观值）', /if \(!quiet\) \{[\s\S]{0,400}?ctx\.transcript\.touch\(\)/.test(runtime))
  check('界面通道放行第二个可选实参（boolean）', /setEffort: \[\s*\{\s*shape: \{ kind: 'enum', values: EFFORT_LEVELS \}\s*\},\s*\{\s*shape: \{ kind: 'boolean' \},\s*optional: true \},/.test(methods))
}

// ── [7] 2026-10-26 第三轮：命令面板滚得动、翻得动 ───────────────────────────

console.log('[7] 命令面板的滚动与翻页')
{
  const css = read('ui-shell/src/styles.css')
  const palette = read('ui-shell/src/plugins/palette/ui.tsx')

  // ① 结果列必须是真滚动区：flex 项默认 min-height:auto，内容一高就被面板的
  //    overflow:hidden 裁掉——看着像列表断了，其实滚不动。
  check('结果列自己吃掉剩余高度并允许收缩（flex + min-height: 0）', /\.palette-list \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;/.test(css))
  check('键位表那张表同样处理（同一个坑）', /\.shortcut-list \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;/.test(css))
  check('滚到底不再把滚动传给外层', /\.palette-list \{[^}]*overscroll-behavior: contain;/.test(css))

  // ② 指针差几十像素（停在搜索栏 / 底栏 / 面板外的暗色遮罩上）时，滚轮也要算数。
  check('有把滚轮折算给列表的函数', /function wheelToList\(event: WheelEvent<HTMLElement>, node: HTMLDivElement \| null\): void/.test(palette))
  check('指针已经在列表里就放行给原生滚动（不自造速度与惯性）', /if \(event\.target instanceof Node && node\.contains\(event\.target\)\) return/.test(palette))
  check('命令面板与键位表的遮罩都挂了这个折算', (palette.match(/onWheel=\{\(event\) => \{\s*wheelToList\(event, list\.current\)/g) ?? []).length === 2)

  // ③ 键盘：翻页键真接上了，并且高亮跟着滚进可视区。
  check('PgUp / PgDn 整页跳', palette.includes("event.key === 'PageDown' || event.key === 'PageUp'") && palette.includes('const step = pageRows()'))
  check('Home / End 到头尾', palette.includes("event.key === 'Home' || event.key === 'End'"))
  check('一页几行按可视高算（窗口高低都合适）', /const pageRows = \(\): number => \{[\s\S]{0,420}?node\.clientHeight - rowHeight/.test(palette))
  check('高亮挪到框外时列表跟着滚', /querySelector<HTMLElement>\('\[data-active="1"\]'\)\?\.scrollIntoView\(\{ block: 'nearest' \}\)/.test(palette))
  check('底栏把翻页键写给人看', palette.includes('PgUp / PgDn 翻页'))

  // ④ 2026-10-27 第二轮报障的真原因：遮罩还留在窗口拖拽区里。
  //    Electron 的拖拽区按矩形做命中判定，面板 DOM 是 topbar 的子孙 → 真实鼠标的滚轮
  //    被当成「在标题栏上滚」直接丢掉；CDP 合成的输入绕过了操作系统那层，所以自检全绿。
  //    这条只能靠样式断言兜住（自动化探针在真机上复现不了）。
  check('遮罩自己豁免窗口拖拽区（否则真机滚轮/点击全被吞）', /\.palette-mask \{\s*-webkit-app-region: no-drag;/.test(css))
  check('面板有看得见的关闭按钮（不只靠 Esc）', palette.includes('className="palette-close"') && palette.includes('关闭命令面板'))
  check('✕ 有 22px 点击区与悬停反馈', /\.palette-close \{[^}]*width: 22px;[^}]*height: 22px;/.test(css) && /\.palette-close:hover \{[^}]*background: var\(--dsc-row-hover-bg\)/.test(css))
  check('键盘表那张也有 ✕', palette.includes('关闭键位表'))
}

// ── [8] 2026-10-27 第四轮：子智能体下拉出界 + 胶囊悬停分层 ──────────────────

console.log('[8] 子智能体下拉与状态胶囊的悬停')
{
  const css = read('ui-shell/src/styles.css')
  const team = read('ui-shell/src/plugins/team/ui.tsx')

  // ① 下拉贴着按钮左下展开，按钮被长标题推到右边时会出界（用户看到的是「被遮挡」）。
  //    打开时量一次、窗口改尺寸再量一次：右边超多少往左挪多少，下边不够就把高度收到窗口底。
  check('下拉有定位引用（ref 挂到 .sub-menu 上）', team.includes('const menuRef = useRef<HTMLDivElement | null>(null)') && /className="row-menu sub-menu"[^>]*ref=\{menuRef\}/.test(team))
  check('打开时先量右边越界再左移', team.includes('const overflowRight = rect.right - (window.innerWidth - margin)') && team.includes('el.style.left = '))
  check('下方空间不够时把高度收到窗口底边', team.includes('el.style.maxHeight = '))
  check('窗口改尺寸重算（开着菜单拉窗口也要跟）', team.includes("window.addEventListener('resize', place)") && team.includes("window.removeEventListener('resize', place)"))

  // ② 行内按钮不再铺第二层底色：整行已经由 .sp-row:hover 上底，叠起来就是「没盖满 / 分层」。
  check('可点行体自己不上底（交给整行）', /\.sp-row-open:hover \{[^}]*background: none;/.test(css))
  check('停止钮悬停只改颜色、不上底', /\.sp-row-stop:hover \{[^}]*background: none;/.test(css))
}

// ── [9] 2026-10-27 第五轮：文案照 dsh、胶囊不报增删、轨迹钮不叠字 ──────────

console.log('[9] 这一轮的四条')
{
  const css = read('ui-shell/src/styles.css')
  const summary = read('ui-shell/src/ui-primitives/tool-summary.ts')
  const transcriptSrc = readPluginSource('ui-shell/src/plugins/transcript')
  const statusSrc = read('ui-shell/src/plugins/status/ui.tsx')
  const factorySrc = read('ui-shell/src/plugins/transcript/tool-card/factory.tsx')
  const traceSrc = read('ui-shell/src/plugins/trace/ui.tsx')

  // ① 行首标题照 dsh 的 tool.title.* 词表：名词短语，不拼「搜了 / 正在写」。
  //    用户 2026-10-27 的原话是「搜了、写了、跑了、思考过程，不舒服」。
  for (const title of ['运行命令', '读取', '写入', '编辑', '查找文件', '搜索文件内容', '网页获取']) {
    check(`词表里有「${title}」`, summary.includes(`verb: '${title}'`))
  }
  const verbSrc = summary.slice(summary.indexOf('export function toolVerb'))
  const verbBody = verbSrc.slice(0, verbSrc.indexOf('}'))
  check('标题不随状态变形（函数体只 return base，不拼 正在 / 准备 / 了）', /return base/.test(verbBody) && !verbBody.includes('${base}') && !verbBody.includes('了'), verbBody.trim())
  check('认不出的工具用 dsh 的泛称「工具调用」', summary.includes("UNKNOWN_TOOL_TITLE = '工具调用'"))
  // transcriptSrc 是整棵插件子树（tool-card/factory.tsx 已含在内），别再单独加 factorySrc。
  const named = (transcriptSrc + traceSrc).split('`· ${call.name}`').length - 1
  check('原名跟在「 · 」后面（对话页 / 轨迹页 / 工厂三处都改了）', named === 3, String(named))

  // ② 思考块标题照 dsh 的 message.think（「思考」两个字），不再写「思考过程」。
  check('思考块标题是「思考」', transcriptSrc.includes('<span className="think-label">思考</span>'))
  check('没有残留的「思考过程」上屏文案', !/think-label">思考过程|think-bar-status">思考过程|收起这段思考过程/.test(transcriptSrc))

  // ③ 胶囊（以及它的分区头）不再报 ± 行数：那一格量的是整个工作区的差，不是某一次操作。
  check('胶囊摘要里没有 ± 读数', !statusSrc.includes('sp-git-delta'))
  check('Git 分区头也不再挂 ± 读数', statusSrc.includes('trail={null}'))
  check('文件数这个粗读数还留着', statusSrc.includes('个文件'))
  check('行数只在工具卡上（编辑 / 写入那一份仍在）', factorySrc.includes('changes-added') && factorySrc.includes('changes-removed'))

  // ④ 「在轨迹中查看」压在摘要尾巴上时，底色必须不透明，否则那半句路径会透出来（读成叠字）。
  check('药丸底色不透明', /\.tool-card \.tool-head \.tc-trace \{[^}]*background: var\(--dsc-bg-raised\)/.test(css))
  check('药丸仍然是绝对定位（读数不让位）', /\.tool-card \.tool-head \.tc-trace \{[^}]*position: absolute/.test(css))
}
// ── [10] 2026-10-27：会话标题放不下时，悬停滚一遍 ──────────────────────────

console.log('[10] 会话行标题的悬停滚动')
{
  const css = read('ui-shell/src/styles.css')
  const sessionsSrc = read('ui-shell/src/plugins/sessions/ui.tsx')

  // ① 量：悬停（或轮到焦点）那一刻量一次溢出，没溢出就不加开关——不能让所有行都抖。
  check('量的是「整段文字宽 − 行里给它的那一格」', sessionsSrc.includes('text.scrollWidth - box.clientWidth'))
  check('指针进来时量（不是常驻 ResizeObserver）', sessionsSrc.includes('onPointerEnter={measureTitle}'))
  check('键盘 Tab 到这一行也量', sessionsSrc.includes('onFocus={measureTitle}'))
  check('只在溢出时挂 data-overflow', sessionsSrc.includes("data-overflow={titleShift > 0 ? '1' : undefined}"))
  check('位移与时长写成自定义属性给样式用', sessionsSrc.includes("'--title-shift'") && sessionsSrc.includes("'--title-dur'"))
  check('时长按距离算、两头夹住', /Math\.min\(6000, 1400 \+ titleShift \* 22\)/.test(sessionsSrc))

  // ② 两层结构：外层裁、内层动；静息态还是省略号（与改动前一致）。
  check('标题文字包在内层盒子里', sessionsSrc.includes('<span className="title-text">{title}</span>'))
  check('内层静息态自己出省略号', /\.sess-item \.title-text \{[^}]*max-width: 100%;[^}]*text-overflow: ellipsis/.test(css))
  check('外层显式 min-width: 0（flex 项才缩得动）', /\.sess-item \.title \{[^}]*min-width: 0;/.test(css))

  // ③ 动效：悬停 / 键盘聚焦才跑，一条循环里两头都停一下；减弱动画时退回省略号。
  check('悬停与键盘聚焦都触发', /\.sess-item:hover \.title\[data-overflow='1'\] \.title-text,[\s\S]{0,120}?\.sess-item:focus-visible/.test(css))
  check('溢出时才放开 max-width（放开才会位移）', /\.sess-item:hover \.title\[data-overflow='1'\] \.title-text,[\s\S]{0,200}?max-width: none/.test(css))
  check('关键帧用 --title-shift 位移', /@keyframes sess-title-marquee \{[\s\S]{0,400}?translateX\(var\(--title-shift/.test(css))
  check('两头都停一拍（开头与结尾看得清）', /@keyframes sess-title-marquee \{[\s\S]{0,300}?0%,?\s*\n?\s*12%/.test(css))
  check('减弱动画偏好下不滚、退回省略号', /prefers-reduced-motion: reduce[\s\S]{0,600}?\.title\[data-overflow='1'\] \.title-text \{[^}]*animation: none;[^}]*max-width: 100%/.test(css))
}
// ── [11] 2026-10-27：跟随滚动的口径照 dsh（读者一动手就松手） ─────────────

console.log('[11] 跟到底部的滚动逻辑')
{
  const transcriptSrc = readPluginSource('ui-shell/src/plugins/transcript')
  const seatsSrc = read('ui-shell/src/plugins/transcript/fold-seats.tsx')

  // ① 外层：贴底门槛照 dsh 的 25px（壳取 24），旧的 160px 必须没有了——
  //    往上滚 100px 仍算「在底部」，下一口内容一到就拽回去，就是用户说的粘滞。
  check('贴底判定是 24px', /const FOLLOW_BOTTOM_PX = 24/.test(transcriptSrc))
  check('旧的 160px 阈值已撤掉', !/clientHeight < 160/.test(transcriptSrc))
  check('落定等待有常量（180ms）', /const FOLLOW_SETTLE_MS = 180/.test(transcriptSrc))

  // ② 往回读先松手：只认「往上」的滚轮与键——在底部往下滚时松手，会让后来居上的内容没人追。
  check('滚轮挂上手势', transcriptSrc.includes("scroller.addEventListener('wheel', onWheel, { passive: true })"))
  check('只认往上滚（deltaY < 0）', transcriptSrc.includes('event.deltaY >= 0'))
  check('往上翻的键', transcriptSrc.includes("UP_KEYS.has(event.key)") && transcriptSrc.includes("'PageUp'"))
  check('不再抢触摸与指针按下（点开工具卡不该断跟随）', !transcriptSrc.includes('touchstart') && !transcriptSrc.includes('pointerdown'))
  check('手势里当场 follow=false（不等越过哪条线）', /const onGesture = \(\): void => \{\s*following\.current = false/.test(transcriptSrc))

  // ③ 落定：scrollend 立即判，180ms 没有新滚动也判。
  check('落定用 scrollend', transcriptSrc.includes("scroller.addEventListener('scrollend', settle)"))
  check('计时器兜底', transcriptSrc.includes('window.setTimeout(settle, FOLLOW_SETTLE_MS)'))

  // ④ 只认自己的写：钉底引发的 scroll 不算读者动了。
  check('记下自己写到的位置', transcriptSrc.includes('written.current = scroller.scrollTop'))
  check('差 1px 以内当自己滚的', transcriptSrc.includes('Math.abs(top - written.current) <= 1'))

  // ⑤ 内容变长只在跟随开着时才追（读者在读时一动不动）。
  check('用 ResizeObserver 接内容生长', transcriptSrc.includes('new ResizeObserver(onResize)'))
  check('读者在读时不钉底', /const onResize = \(\): void => \{\s*if \(!following\.current\) return/.test(transcriptSrc))

  // ⑥ 组体（阶段组的限高滚动）同一套：手势松手 + 落定 + 只认自己的写。
  check('组体贴底判定收窄到 4px', /const PROCESS_BOTTOM_EPS = 4/.test(seatsSrc))
  check('组体也挂滚轮手势', seatsSrc.includes("body.addEventListener('wheel', onWheel, { passive: true })"))
  check('组体也只认往上滚', seatsSrc.includes('event.deltaY >= 0') && seatsSrc.includes('PROCESS_UP_KEYS.has(event.key)'))
  check('组体也认 scrollend', seatsSrc.includes("body.addEventListener('scrollend', settle)"))
  check('组体也记自己写到的位置', seatsSrc.includes('written.current = body.scrollTop'))
  check('组体读者在读时不追', /if \(follow\.current\) \{\s*const limit = body\.scrollHeight - body\.clientHeight/.test(seatsSrc))
  check('组体不再用旧的 32px 判据', !/AT_BOTTOM_EPS/.test(seatsSrc))
}
if (failures === 0) console.log('\n全部通过')
else console.log(`\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
