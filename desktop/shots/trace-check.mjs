/**
 * 「轨迹页对标 dsh 改版」的只读探针。
 *
 * 为什么要有它：这次改版把一大半行为放在构建产物里（时间条、检查器、压缩区段、行内元信息、
 * 尾部跟随），肉眼只能看见其中一屏。这个脚本把「产物里必须出现什么、必须以什么口径出现」
 * 写成断言，构建完跑一次就能回答「五件事是不是真的进了包」。
 *
 * 只读：全程 readFileSync + readdirSync，不写任何文件、不碰 ~/.dsc、不启动 Electron。
 * 断言分七组：契约字段 → 轮次表与压缩区段 → 行内元信息 → 检查器 → 时间条（含诚实口径）
 * → 尾部跟随 → 布局与样式纪律。
 *
 * 用法（在仓库根目录 build 过之后）：
 *   node desktop/shots/trace-check.mjs
 * 退出码：0 = 全部通过；1 = 有断言没过（逐条打印失败原因与实测片段）。
 *
 * @module desktop/shots/trace-check
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, '..')
const rootDir = join(desktopDir, '..')

/** 取某个目录下扩展名匹配的**全部**文件（产物带内容哈希不能写死文件名；分包也不能只看一个）。 */
function allFiles(dir, ext) {
  const names = readdirSync(dir).filter((name) => name.endsWith(ext))
  if (names.length === 0) throw new Error(`${dir} 里没有 ${ext} 文件，先跑 desktop 的 build`)
  return names.map((name) => readFileSync(join(dir, name), 'utf8'))
}

const rendererDir = join(desktopDir, 'out', 'renderer', 'assets')
// js 产物是多分包的（入口 + 懒加载页各一个 chunk），断言要扫全部——只读「字典序第一个」
// 会读到错误的 chunk，报出与源码对不上的假失败（2026-10-02 实测翻过车）。
const js = allFiles(rendererDir, '.js').join('\n')
const css = allFiles(rendererDir, '.css').join('\n')
const contractDts = readFileSync(join(rootDir, 'lib', 'contract.d.ts'), 'utf8')

/** 渲染层源码（诚实口径这类「怎么写的」只能在源码上看，压缩后的 bundle 看不出来）。 */
const readSource = (name) => readFileSync(join(desktopDir, 'src', 'renderer', name), 'utf8')
const viewSrc = readSource('TraceView.tsx')
const timelineSrc = readSource('TraceTimeline.tsx')
const inspectorSrc = readSource('TraceInspector.tsx')
const formatSrc = readSource('trace-format.ts')
const appSrc = readSource('App.tsx')
const chatSrc = readSource('ChatView.tsx')

/** 把样式表拆成「选择器 → 声明块」的清单；先去掉注释，免得注释里提到的类名被当成规则。 */
function cssRules(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = re.exec(clean)) !== null) {
    rules.push({ selector: match[1].replace(/\s+/g, ' ').trim(), body: match[2].replace(/\s+/g, ' ').trim() })
  }
  return rules
}

const rules = cssRules(css)
const ruleOf = (selector) => rules.find((rule) => rule.selector === selector)
const rulesLike = (needle) => rules.filter((rule) => rule.selector.includes(needle))
const familyBody = (needle) => rulesLike(needle).map((rule) => `${rule.selector} { ${rule.body} }`).join(' ')

/** 在一个选择器族的声明里找某条声明（值用子串比对，容忍写法差异）。 */
function hasDeclIn(needle, property, valuePart) {
  const re = new RegExp(`${property}\\s*:\\s*[^;]*${valuePart}`)
  return rulesLike(needle).some((rule) => re.test(rule.body))
}
const hasDecl = (selector, property, valuePart) => {
  const rule = ruleOf(selector)
  if (rule === undefined) return false
  return new RegExp(`${property}\\s*:\\s*[^;]*${valuePart}`).test(rule.body)
}

const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok: ok === true, detail: String(detail ?? '') })
}
/** 按序找一段子串（断言两段代码的先后关系时用）。 */
const at = (needle) => js.indexOf(needle)

// ── 1) 宿主补的字段真的到了渲染层手里 ─────────────────────────────────────────────
{
  check('契约：ToolCallView 带 startedAt', /startedAt\?: number/.test(contractDts))
  check('契约：ToolCallView 带 durationMs', /durationMs\?: number/.test(contractDts))
  check('契约：user / system 条目带 compaction', (contractDts.match(/compaction\?: CompactionMark/g) ?? []).length >= 2)
  check('契约：CompactionMark 的 count 是 1 基次数', /export interface CompactionMark \{[\s\S]{0,200}count: number/.test(contractDts))
  // 产物里这两个字段名必须字面在位：时间条与行内读数的唯一数据来源
  check('产物：js 里读 startedAt', js.includes('startedAt'), js.match(/.{0,40}startedAt.{0,40}/)?.[0])
  check('产物：js 里读 durationMs', js.includes('durationMs'), js.match(/.{0,40}durationMs.{0,40}/)?.[0])
  check('产物：js 里读 compaction', js.includes('compaction'))
}

// ── 2) 轮次记录表 + 压缩区段行 ───────────────────────────────────────────────────
{
  check('轮次表：轮头与轮次钩子还在（data-trace-round / round-head）', js.includes('data-trace-round') && js.includes('round-head'))
  check('轮次表：每轮统计仍是「N 步 · M 次工具」', /步 · /.test(js))
  check('轮次表：轮头带轮序号钩子 data-round-index', js.includes('data-round-index'))
  check('轮次表：用户消息摘要仍在轮头（round-user）', js.includes('round-user'))
  check('轮次表：带图的消息在轮头给一个附件数小标', js.includes('round-attach') && js.includes(' 张附件'))
  check('轮次表：行有 data-trace-step 钩子（探针与聚焦都认它）', js.includes('data-trace-step'))

  // 压缩区段：只认字段、不做文本匹配
  check('压缩区段：产物里有 data-trace-compaction 钩子', js.includes('data-trace-compaction'))
  check('压缩区段：文案是「已压缩历史 · 第 N 次」', js.includes('已压缩历史 · 第 '))
  check('压缩区段：渲染层读 entry.compaction（不是文本匹配）', /compaction !== undefined/.test(formatSrc) || /compaction !== undefined/.test(viewSrc), formatSrc.match(/const compaction[^\n]*/)?.[0])
  check(
    '压缩区段：识别处没有任何正文文本匹配（不出现 SUMMARY_BANNER / 摘要前缀）',
    !formatSrc.includes('SUMMARY_BANNER') && !viewSrc.includes('SUMMARY_BANNER') && !inspectorSrc.includes('SUMMARY_BANNER'),
  )
  check('压缩区段：CSS 有 .trace-compact 分隔行', ruleOf('.trace-compact') !== undefined)
  check('压缩区段：分隔行是「两侧等长线 + 中间标签」', hasDecl('.trace-compact-rule', 'flex', '1') && ruleOf('.trace-compact-tag') !== undefined, familyBody('.trace-compact'))
  check('压缩区段：居中风格用了分隔线（标签是胶囊 + 描边）', hasDecl('.trace-compact-tag', 'border-radius', 'dsc-r-pill'), ruleOf('.trace-compact-tag')?.body)
  check('压缩区段：明显区别于普通步骤（步骤行是左竖线 + 圆点）', ruleOf('.round-steps .step::before') !== undefined)
}

// ── 3) 行内元信息：时刻 / 工具耗时 / 用量 / 失败被拒的红字 ────────────────────────
{
  check('行内元信息：右侧一列（trace-meta）', js.includes('trace-meta') && hasDecl('.trace-meta', 'display', 'flex'))
  check(
    '行内元信息：时刻用 HH:mm（复用对话页的 formatClock 口径）',
    js.includes('tmeta-clock') && viewSrc.includes('formatClock(step.ts ?? null)'),
    viewSrc.match(/const clock = [^\n]*/)?.[0],
  )
  check('行内元信息：耗时格只在有 durationMs 时才画', js.includes('tmeta-dur') && /duration !== null/.test(viewSrc), viewSrc.match(/const duration[^\n]*/)?.[0])
  check('行内元信息：耗时格式是 4.2s / 1m03s 那一档', formatSrc.includes('toFixed(1)}s') && formatSrc.includes('m${pad(seconds)}s'), formatSrc.match(/if \(tenths < 60\)[^\n]*/)?.[0])
  check('行内元信息：用量格只为真值那一条画', js.includes('tmeta-tok') && viewSrc.includes('roundUsageOwnTotal'))
  check('行内元信息：用量文案是「N tok」', / tok/.test(js))
  check(
    '行内元信息：失败 / 被拒走语义色（红 68% / 黄 74%，与工具卡同一套配方）',
    hasDeclIn(".trace-step[data-status='failed'] .tmeta-dur", 'color', 'dsc-red') &&
      hasDeclIn(".trace-step[data-status='rejected'] .tmeta-dur", 'color', 'dsc-yellow'),
    familyBody('[data-status'),
  )
  check('行内元信息：不重复工具卡的状态词（行内没有第二个「失败/已拒绝」文案）', !/tmeta-status/.test(viewSrc) && !/tmeta-status/.test(css))
  check('行内元信息：打开检查器的入口是一个真按钮', js.includes('tmeta-open') && hasDecl('.tmeta-open', 'width', 'dsc-ctl-sm'))
}

// ── 4) 检查器 ───────────────────────────────────────────────────────────────────
{
  check('检查器：面板与遮罩都在（trace-inspector / trace-scrim）', js.includes('trace-inspector') && js.includes('trace-scrim'))
  check('检查器：面板是右侧贴边滑出', hasDecl('.trace-inspector', 'position', 'absolute') && hasDecl('.trace-inspector', 'right', '0'), ruleOf('.trace-inspector')?.body)
  check('检查器：有关门动效（动画或过渡至少一条）', hasDecl('.trace-inspector', 'animation', 'trace-slide-in'))
  check('检查器：遮罩底色走 --dsc-scrim 令牌', hasDecl('.trace-scrim', 'background', 'dsc-scrim'))
  check('检查器：关闭方式一 = 右上角 ×', js.includes('data-trace-inspector-close') && js.includes('关闭检查器'))
  check('检查器：关闭方式二 = 点遮罩', /data-trace-scrim/.test(js) && viewSrc.includes('onClick={closeInspector}'))
  check('检查器：Esc 也能关', inspectorSrc.includes("event.key !== 'Escape'"))
  check('检查器：输入区给原文（argsText）', js.includes('data-trace-code') && inspectorSrc.includes('entry.call.argsText'))
  check('检查器：有「格式化」开关，且只在能解析时给出', js.includes('data-trace-format-toggle') && js.includes('格式化') && inspectorSrc.includes('pretty.formatted &&'))
  check('检查器：格式化 = JSON.parse 得成就美化，不得就原样', formatSrc.includes('JSON.stringify(JSON.parse(text), null, 2)') && /catch \{[\s\S]{0,80}return \{ text, formatted: false \}/.test(formatSrc))
  check('检查器：输出区也优先美化', inspectorSrc.includes('<Block text={entry.call.resultText} marker="result" />'))
  check('检查器：思考全文区', js.includes('思考全文') && js.includes('data-trace-code'))
  check('检查器：计时区给发起时刻与耗时，缺就「未记录」', inspectorSrc.includes('发起时刻') && inspectorSrc.includes("?? '未记录'") && js.includes('未记录'))
  check('检查器：用量区给输入 / 输出 / 合计', inspectorSrc.includes('输入') && inspectorSrc.includes('输出') && inspectorSrc.includes('合计'))
  check('检查器：复制参数的按钮在（复制的是原文）', js.includes('data-trace-copy-args') && js.includes('复制参数') && inspectorSrc.includes('navigator.clipboard.writeText(argsText)'))
  check('检查器：复制后给一条 toast 回执', js.includes('已复制参数原文') && inspectorSrc.includes('toastOk('))
  // 附件区：复用对话页现成的图片渲染通道
  check('检查器：附件区给出缩略图网格', js.includes('data-trace-attachments') && js.includes('data-trace-shot'))
  check('检查器：缩略图复用 .entry-user-images 图片通道', inspectorSrc.includes('entry-user-images') && ruleOf('.entry-user-images img') !== undefined, ruleOf('.entry-user-images img')?.body)
  check('检查器：点缩略图进放大浮层', js.includes('trace-lightbox') && inspectorSrc.includes('onZoom(url)'))
  check('检查器：浮层盖住整窗且可点任意处关闭', hasDecl('.trace-lightbox', 'position', 'fixed') && hasDecl('.trace-lightbox', 'z-index', 'dsc-z-modal'))
  check('检查器：用户条目也进检查器（轮头的 round-open）', js.includes('round-open') && js.includes('查看这条用户消息与附件'))
  check('检查器：没有附件时给一句说明而不是空白', js.includes('这条消息没有附件'))
}

// ── 5) 时间概览条（含诚实口径） ──────────────────────────────────────────────────
{
  check('时间条：组件与轨道在（trace-timeline / ttl-track）', js.includes('trace-timeline') && js.includes('ttl-track'))
  check('时间条：固定在记录表上方（sticky + 不参与压缩）', hasDecl('.trace-timeline', 'position', 'sticky') && hasDecl('.trace-timeline', 'flex', 'none'))
  check('时间条：高度落在 36~48px 档（44px × 密度）', hasDecl('.trace-timeline', 'height', '44px'), ruleOf('.trace-timeline')?.body)
  // 2026-10-29 报障「时间轴和信息重叠」：两块原来各写 sticky top: 0，滚动之后钉在同一行。
  check(
    '表头：概览条与工具栏一起吸附（.trace-head sticky），工具栏不再各自钉顶点',
    hasDecl('.trace-head', 'position', 'sticky') && !hasDecl('.trace-stats', 'position', 'sticky'),
    ruleOf('.trace-stats')?.body,
  )
  check('表头：吸附块有不透明底（滚过去的行不许透字）', hasDecl('.trace-head', 'background', 'dsc-bg-page'))
  check('时间条：有宽度的条（ttl-bar）与只画起点的刻度（ttl-tick）分两种', js.includes('ttl-bar') && js.includes('ttl-tick'))
  check('时间条：轮次边界画分隔刻度（ttl-sep）', js.includes('ttl-sep') && js.includes('data-trace-boundary'))
  check('时间条：悬停提示与 500ms 延迟', js.includes('ttl-tip') && /HOVER_DELAY_MS = 500/.test(timelineSrc))
  check('时间条：提示里给精确时刻与耗时', timelineSrc.includes('formatClockSeconds') && timelineSrc.includes('耗时 ${'))
  check('时间条：拖选区间（ttl-sel + data-trace-selection）', js.includes('ttl-sel') && js.includes('data-trace-selection'))
  check('时间条：右键也能清除区间', timelineSrc.includes('onContextMenu'))
  check('时间条：这一轮不做滚轮缩放 / 平移（组件里没有 wheel 处理）', !timelineSrc.includes('onWheel') && !timelineSrc.includes("addEventListener('wheel'"))

  // 诚实口径 1：只有 durationMs 才产生宽度
  const tickBranch = timelineSrc.slice(timelineSrc.indexOf('mark.end === null ? ('), timelineSrc.indexOf(') : ('))
  const barBranch = timelineSrc.slice(timelineSrc.indexOf(') : ('), timelineSrc.indexOf('{range !== null &&'))
  check('诚实口径：没有终点（拿不到 durationMs）的分支只画刻度、不带任何 width', tickBranch.includes('ttl-tick') && !tickBranch.includes('width'), tickBranch.replace(/\s+/g, ' ').slice(0, 160))
  check('诚实口径：有宽度的分支宽度只从 mark.end 推出来（百分比差）', barBranch.includes('ttl-bar') && barBranch.includes('width') && barBranch.includes('percent(mark.end) - percent(mark.start)'), barBranch.replace(/\s+/g, ' ').slice(0, 200))
  // data-marks 只是给探针看的条数读数，不是分母；把它摘掉再看有没有别处拿条数做除法。
  const timelineNoCount = timelineSrc.replace(/data-marks=\{String\(props\.marks\.length\)\}/, '')
  check(
    '诚实口径：没有「总时长 ÷ 条数」这类虚构摊平（源码里不出现 marks.length 做分母）',
    !/\/\s*[^\n/]{0,40}marks\.length/.test(timelineNoCount) && !/marks\.length\s*\//.test(timelineNoCount),
    timelineNoCount.match(/[^\n]*marks\.length[^\n]*/)?.[0] ?? '（除 data-marks 读数外没有别处引用条数）',
  )
  check('诚实口径：起点时刻优先 startedAt，缺才退回 ts（工具）', formatSrc.includes('const start = startedAt ?? ts'), formatSrc.match(/const start = [^\n]*/)?.[0])
  check('诚实口径：终点只在 startedAt + durationMs 都在时才算', formatSrc.includes('startedAt !== undefined && durationMs !== undefined'))
  check('诚实口径：一个时间戳都没有时干脆不画时间条', js.includes('本会话没有记录时间戳') && timelineSrc.includes('is-empty'))
  check('诚实口径：running 不编耗时（耗时文案的唯一来源是 call.durationMs）', /const duration = step\.kind === 'tool' \? formatTraceDuration\(step\.call\.durationMs \?\? null\)/.test(viewSrc), viewSrc.match(/const duration = [^\n]*/)?.[0])
  check('诚实口径：跨度投影用 (t − 首条) / 总时长', timelineSrc.includes('(ts - props.spanStart) / span'), timelineSrc.match(/const ratio = [^\n]*/)?.[0])
}

// ── 6) 尾部跟随 ─────────────────────────────────────────────────────────────────
{
  check('尾部跟随：默认贴底（entries 变化时钉到底）', viewSrc.includes('element.scrollTop = element.scrollHeight'))
  check('尾部跟随：只在 still following 时钉底', /if \(element === null \|\| !followRef\.current\) return/.test(viewSrc))
  check('尾部跟随：有 followRef 与 autoTopRef 两位（不把自己的钉底误判成用户滚离）', viewSrc.includes('followRef') && viewSrc.includes('autoTopRef'))
  check('尾部跟随：上滚暂停用 120px、恢复用贴底档 32px（滞回）', viewSrc.includes('TRACE_PAUSE_EPS = 120') && viewSrc.includes('AT_BOTTOM_EPS'))
  check('尾部跟随：不弹任何按钮（组件里没有回到底部那颗钮）', !viewSrc.includes('回到底部') && !viewSrc.includes('chat-to-bottom') && !css.includes('trace-to-bottom'))
  check('尾部跟随：滚回底部附近自动恢复', /if \(away <= AT_BOTTOM_EPS\) followRef\.current = true/.test(viewSrc))
}

// ── 7) 布局与样式纪律 ───────────────────────────────────────────────────────────
{
  check('纪律：TraceView 的 props 签名没变（entries + status）', /export function TraceView\(props: \{\s*entries: TranscriptEntry\[\]\s*status: StatusView\s*\}/.test(viewSrc), viewSrc.slice(0, 0))
  check('纪律：App.tsx 的调用点一行没动', appSrc.includes('<TraceView entries={snapshot.entries as TranscriptEntry[]} status={snapshot.status} />'))
  check('纪律：对话页没被牵连（ChatView 里没有任何轨迹页的挂点）', !chatSrc.includes('trace-timeline') && !chatSrc.includes('trace-inspector') && !chatSrc.includes('trace-compact'))
  check('纪律：轨迹页外层新增 .trace-page 一层（检查器的定位上下文）', hasDecl('.trace-page', 'position', 'relative') && js.includes('trace-page'))

  // 新分段只走令牌：不写死十六进制、不直写 rgb()/hsl()
  const sectionStart = css.indexOf('轨迹页对标 dsh 改版')
  const section = sectionStart < 0 ? '' : css.slice(sectionStart)
  const hexes = section.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  check('纪律：新分段里没有写死的十六进制颜色', hexes.length === 0, hexes.join(' '))
  const literals = section.match(/\b(rgb|rgba|hsl|hsla)\(/g) ?? []
  check('纪律：新分段里没有直写 rgb()/hsl()', literals.length === 0, literals.join(' '))
  check(
    '纪律：新分段用的是现有令牌（字号 / 文字 / 描边 / 圆角四族都在用）',
    /--dsc-fs-/.test(section) && /--dsc-text-/.test(section) && /--dsc-stroke-/.test(section) && /--dsc-r-/.test(section),
  )
  check('纪律：新分段有独立标题（轨迹页对标 dsh 改版）', sectionStart >= 0)
  // 追加区哨兵（styles.css 末尾那行注释）：新段追加后必须把它挪回文件末尾，
  // 所以它应当永远落在产物 css 的最后 10% 里——比钉死某个历史段的占比耐用。
  const sentinelStart = css.lastIndexOf('追加区：')
  check(
    '纪律：新分段在样式表末尾（追加，不改旧段）',
    sentinelStart > css.length * 0.9,
    `追加区哨兵起点占比 ${(sentinelStart / css.length).toFixed(3)}`,
  )
}

// ── 打印 ────────────────────────────────────────────────────────────────────────
const passed = checks.filter((entry) => entry.ok).length
const failed = checks.filter((entry) => !entry.ok)
process.stdout.write(`[trace-check] 产物：\n  css+js ${rendererDir}（全部分包）\n  源  ${join(desktopDir, 'src', 'renderer')}\n`)
for (const entry of checks) {
  process.stdout.write(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}\n`)
  if (!entry.ok && entry.detail !== '') process.stdout.write(`      实测：${entry.detail}\n`)
}
process.stdout.write(`[trace-check] 断言 ${String(checks.length)} 条，通过 ${String(passed)} 条，失败 ${String(failed.length)} 条\n`)
process.exit(failed.length === 0 ? 0 : 1)
