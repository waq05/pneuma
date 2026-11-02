/**
 * `/review` 结论卡（`<review-findings>` 汇报）的确定性探针。
 *
 * 三段，全是不需要宿主与真模型的纯检查：
 *   1. **纯解析**——直读 `ui-shell/src/ui-primitives/review-findings.ts`（Node 的类型擦除，
 *      不用先 build）：包裹识别、teammate/state 属性、P0–P3 四档、位置 `path:line`、
 *      字段剥壳（加粗 / 反引号 / 列表前缀 / 全角冒号）、多行续写、解析不动的行不丢；
 *   2. **样式复用**——卡片只准用 `views.css` 里已有的那套类名与 `data-priority`，
 *      不许另起一套（否则 P0 徽标做出来也只是一块没人配色的文字）；
 *   3. **壳侧接线**——对话流确实把这条用户消息交给卡片渲染，基元包也确实导出了这两个模块。
 *
 * 运行：node scripts/ui-review-findings-test.mjs
 *
 * @module dsc/scripts/ui-review-findings-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { parseReviewFindings } = await import(
  new URL('../ui-shell/src/ui-primitives/review-findings.ts', import.meta.url).href
)

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/** 照宿主 `deliverReview` 的拼法造一份 findings 正文。 */
const wrap = (attrs, body) => `<review-findings ${attrs}>\n${body}\n</review-findings>`

console.log('findings 解析（parseReviewFindings）')

// ── 1. 没有被整体包裹就不是 findings ──
check('没被包裹的普通消息返回 null', parseReviewFindings('### [P0] 标题\n位置：a.ts:1') === null)
check('只有开标签（没闭合）返回 null', parseReviewFindings('<review-findings teammate="r">\n### [P0] x') === null)
check('空串返回 null', parseReviewFindings('') === null)

// ── 2. 属性与引言 ──
const sample = wrap(
  'teammate="reviewer-1" state="已完成"',
  [
    '整体看过一遍，改动集中在 /review 这条链上。',
    '',
    '### [P0] 取消之后记录还会被覆盖',
    '位置：src/plugins/subagent.ts:870',
    '说明：收工回调里无条件写 finished，取消的结论会被冲掉。',
    '续一句：这里要按 handle 比对。',
    '建议：给 finish 传队友名。',
    '### [P1] 路径没归一',
    '**位置**：`src/core/git-info.ts`：128',
    '- 建议：先归一化再比较。',
    '### [P7] 写错档位的一条',
    '说明：档位认不出也要把内容留住。',
  ].join('\n'),
)
const doc = parseReviewFindings(sample)
check('整体包裹的报告被认出', doc !== null)
check('读到 teammate 与 state', doc?.teammate === 'reviewer-1' && doc?.state === '已完成', JSON.stringify([doc?.teammate, doc?.state]))
check('三条条目按文档顺序', doc?.findings.length === 3, String(doc?.findings.length))
check('条目前的自由文字归 note', doc?.note.includes('整体看过一遍') === true, doc?.note ?? '')
check('P0–P3 四档解析成数字', JSON.stringify(doc?.findings.map((item) => item.priority)) === JSON.stringify([0, 1, undefined]), JSON.stringify(doc?.findings.map((item) => item.priority)))
check('认不出的档位记 undefined 但条目留着', doc?.findings[2]?.title === '写错档位的一条' && doc?.findings[2]?.priority === undefined)

// ── 3. 字段：位置 / 说明 / 建议 / 解析不动的行 ──
const first = doc?.findings[0]
check('位置解析成 path:line', first?.location?.path === 'src/plugins/subagent.ts' && first?.location?.line === 870, JSON.stringify(first?.location))
check('说明多行续写不丢', first?.detail.includes('无条件写 finished') === true && first?.detail.includes('按 handle 比对') === true, first?.detail)
check('建议单独成段', first?.suggestion === '给 finish 传队友名。', first?.suggestion)
const second = doc?.findings[1]
check('加粗 + 反引号 + 全角冒号的位置也认', second?.location?.path === 'src/core/git-info.ts' && second?.location?.line === 128, JSON.stringify(second?.location))
check('列表前缀的建议也认（`- 建议：`）', second?.suggestion === '先归一化再比较。', second?.suggestion)
check('标题里没有夹带方括号档位', first?.title === '取消之后记录还会被覆盖', first?.title)

// ── 4. 一条都没有：整段就是引言 ──
const clean = wrap('teammate="reviewer-2" state="已完成"', '没有发现问题。查了 git-info.ts 与 commands.ts。')
const cleanDoc = parseReviewFindings(clean)
check('没有条目时 findings 为空、正文进 note', cleanDoc?.findings.length === 0 && cleanDoc?.note.includes('没有发现问题') === true, cleanDoc?.note ?? '')

// ── 5. 建议里的续行不跑到说明里去 ──
const suggestDoc = parseReviewFindings(
  wrap('teammate="r"', ['### [P2] 一个边界', '建议：第一句。', '第二句也属于建议。'].join('\n')),
)
check('建议的续行仍在建议里', suggestDoc?.findings[0]?.suggestion === '第一句。 第二句也属于建议。', suggestDoc?.findings[0]?.suggestion)

console.log('\n样式与接线')

// ── 6. 卡片用现有类名与 data-priority 四档 ──
const card = read('ui-shell/src/ui-primitives/review-findings-card.tsx')
const classes = [
  'review-findings',
  'review-findings-head',
  'review-findings-title',
  'review-findings-state',
  'review-findings-note',
  'review-findings-list',
  'review-finding',
  'review-finding-head',
  'review-finding-badge',
  'review-finding-title',
  'review-finding-loc',
  'review-finding-detail',
  'review-finding-suggest',
]
const missing = classes.filter((name) => !card.includes(name))
check('卡片只用 views.css 里已有的那套类名', missing.length === 0, JSON.stringify(missing))
check('优先级写进 data-priority（P0–P3 徽标色靠它）', card.includes('data-priority') && card.includes('`P${String(priority)}`'))
const css = read('ui-shell/src/legacy/views.css')
check(
  '四档徽标色都在（含 P0 最高档）',
  ["data-priority='P0'", "data-priority='P1'", "data-priority='P2'", "data-priority='P3'"].every((selector) => css.includes(selector)),
)

// ── 7. 基元包导出 + 对话流接线 ──
const barrel = read('ui-shell/src/ui-primitives/index.ts')
check('基元包导出解析与卡片', barrel.includes("export * from './review-findings'") && barrel.includes("export * from './review-findings-card'"))
const userRow = read('ui-shell/src/plugins/transcript/rows/user-row.tsx')
check('对话流的用户消息先认 findings 再画气泡', userRow.includes('parseReviewFindings(entry.text)') && userRow.includes('<ReviewFindingsCard'))
check('只读出口（右栏队友记录）也画成卡', (userRow.match(/ReviewFindingsCard/g) ?? []).length >= 2)

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 项失败`)
process.exit(failures === 0 ? 0 : 1)
