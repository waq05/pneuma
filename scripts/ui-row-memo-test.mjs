/**
 * 行体「不重画」的保证在哪一层（差距清单 S2，2026-11-10 彻底方案）。
 *
 * 这一份是**改版**：上一版钉的是「给 `RowBody` 包一层带比较器的 `memo`」（`rowBodyUnchanged`），
 * 那是止血。彻底方案把那层比较器退役了——因为实测（60 轮 / 128 行 / 19 秒流式，同一台机器）：
 *   · 比较器只省掉**行体函数体**，座位壳（`RowSeat` 里的两个 hook）与元素对账照旧每帧各跑一遍；
 *   · 宿主每 50 帧发一次全量锚帧（`core/remote/frames.ts` 的 `FULL_ANCHOR_FRAMES`），
 *     那一帧每条 `entry` 都是新对象、内容一字不差 → 比较器集体失效，一次重画 115 行。
 * 现在「不重画」由三处共同保证：座位壳 `memo`（props 全稳定）+ 行体逐行订阅注册表
 * （`seat-store.ts` 的 `sameRow` 判等）+ 注册表只通知变了的那几格。
 *
 * **改前改后钉的是同一件事**：哪些东西变了才允许重画、比较的判据是什么、比较器不许吃整对象。
 * 逐条对应关系写在各段开头（[1]~[4] 与旧版同名段落一一对位），只换形态、不降强度。
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-row-memo-test.mjs
 *
 * @module dsc/scripts/ui-row-memo-test
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveUiHalf } from './_check-runner.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const UI = resolveUiHalf('transcript')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

/** 行体与座位壳就这两份（判等挪到了注册表：`seat-store.ts`）。 */
const src = read(`${UI}/render.tsx`)
const store = read(`${UI}/seat-store.ts`)
const uiSrc = read(`${UI}/ui.tsx`)
/** 「不该出现」的断言先剥注释：修法的注释里就引着旧写法，不剥会自己打脸。 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const storeCode = store.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** 从起点截到终点（找不到给空串）。 */
const between = (text, from, to) => {
  const at = text.indexOf(from)
  if (at === -1) return ''
  const end = text.indexOf(to, at + from.length)
  return text.slice(at, end === -1 ? text.length : end)
}

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

console.log('[1] 谁被 memo 住了：座位壳与行体入口，而不是行体函数本身')
{
  // 旧版钉「RowBody 包了 memo 且带比较器」。新版钉的是同一件事的两个落点：
  // 壳（每帧都会被父组件重建元素的那一层）和行体入口（订阅的快照稳定时不重渲染）。
  check('render.tsx 里用了 memo', code.includes('memo('))
  check('座位壳 SeatFrame 是 memo 的（每帧被父组件重建元素的那一层）', /export const SeatFrame = memo\(function SeatFrame\(/.test(code))
  check('行体入口 RowSlot 是 memo 的', /const RowSlot = memo\(function RowSlot\(/.test(code))
  check(
    '两个 memo 都用默认浅比较（不再手写第二个参数）',
    !/memo\(\s*SeatFrame\s*,/.test(code) && !/memo\(\s*\w+\s*,\s*\(?\s*previous/.test(code),
  )
  check('行体 RowBody 是普通导出函数（不再是 memo 包装）', /export function RowBody\(/.test(code) && !/export const RowBody = memo\(/.test(code))

  // 反向钉：旧写法不许回来——裸 memo 的浅比较在「Row 每帧新对象」面前必然失败，等于没加。
  check('没有裸的 memo(RowBody)', !/memo\(\s*RowBody\s*\)/.test(code))
  check('没有 memo(function RowBody（同样是裸 memo）', !/memo\(\s*function\s+RowBody\b/.test(code))
  check('止血那版的比较器已退役（rowBodyUnchanged 不再出现）', !code.includes('rowBodyUnchanged'))
  check('没有 memo(RowBodyBody) 这类中间层', !/memo\(\s*RowBodyBody\s*\)/.test(code))
  check('壳体不再自己渲染行体（只递座位键，行体自己去订阅）', code.includes('<RowSlot seatKey={props.seatKey}'))
}

console.log('[2] 判等比的是对的东西：entry 内容 / live / at / stable')
{
  // 旧版钉「比较器比 entry 引用 + live + renderSlot」。新版把判等搬进注册表：
  // entry 从「引用」升级成「引用或深度相等」，at / stable 也进判等（理由见 [3]）；
  // renderSlot 不再进判等——它不是行数据，走座位壳的 props 稳定性（默认浅比较覆盖它）。
  const at = storeCode.indexOf('export function sameRow')
  const tail = at === -1 ? '' : storeCode.slice(at)
  const end = tail.indexOf('\n}\n')
  const judge = tail.slice(0, end === -1 ? tail.length : end + 2)
  check('判等函数能从源码里切出来（切片非空）', judge.length > 0, String(judge.length))

  check('比一套「引用相同直接算没变」的短路', /if \(previous === next\) return true/.test(judge))
  check('比 entry：引用相同或内容深度相等', /previous\.entry === next\.entry \|\| sameContent\(previous\.entry, next\.entry\)/.test(judge))
  check('比 live（直播尾多一个光标与展开态）', /previous\.live !== next\.live/.test(judge))
  check('比 at（历史分页会让下标漂）', /previous\.at !== next\.at/.test(judge))
  check('比 stable（轮内身份）', /previous\.stable !== next\.stable/.test(judge))

  // 反向钉：拿整个 Row 对象去比等于永远不等——Row 每帧都是 rowOf 现造的字面量。
  // （`previous === next` 那条短路是合法的：同一个对象当然不用重画，但它不是判据的全部。）
  check(
    '没有把「整对象相同」当唯一判据',
    judge.includes('previous.stable !== next.stable') && judge.includes('previous.entry === next.entry'),
  )
  check('没有把 Row 序列化后比（JSON.stringify 在注册表里一次都没有）', !storeCode.includes('JSON.stringify'))
  // renderSlot 换了必须重画：它现在靠壳的 props 稳定性保证，所以要在壳的 props 里。
  const frameProps = between(code, 'export const SeatFrame = memo(function SeatFrame(props: {', '}): ReactNode {')
  check('renderSlot 仍是座位壳的 props（壳的默认浅比较会认它）', frameProps.includes('renderSlot?: ToolViewRender'))
}

console.log('[3] 判等键少一个都不行（旧版「不许比 at / stable」为什么反转了）')
{
  // 旧版说「不许拿 at / stable 当比较键」，理由是它们会让 memo 白失效。彻底方案里这两条
  // 反转了，而且必须反转：判等在这里的职责从「省一次重画」变成「这一行是不是还是这一行」。
  //   · at 不判等 → 历史分页 / 直播定稿让下标漂了，行体里留着的还是旧下标（折叠隐藏集合按它算）；
  //   · stable 不判等 → 两条不同的行被当成同一行，注册表会把内容串味。
  const at = storeCode.indexOf('export function sameRow')
  const tail = at === -1 ? '' : storeCode.slice(at)
  const judge = tail.slice(0, tail.indexOf('\n}\n') + 2)
  check('at 参与判等（不许被后人「优化」掉）', judge.includes('previous.at !== next.at'))
  check('stable 参与判等', judge.includes('previous.stable !== next.stable'))
  const keys = [...new Set(judge.match(/previous\.\w+/g) ?? [])].sort().join(',')
  check('判等由且只由这四样组成（stable / live / at / entry）', keys === 'previous.at,previous.entry,previous.live,previous.stable', keys)
  check('深度相等只认内容（sameContent 逐字段比，不看对象年龄）', storeCode.includes('export function sameContent'))
  check('全量锚帧那条路在注释里留了档（为什么深度相等是必需的）', store.includes('锚'))
}

console.log('[4] 注释写清了为什么（每帧 / 新对象 / 全量锚帧 / 两个阶段）')
{
  const bodyAt = store.indexOf('export function createSeatStore')
  const before = bodyAt === -1 ? '' : store.slice(0, bodyAt)
  const open = before.lastIndexOf('/**')
  const doc = open === -1 ? '' : before.slice(open)

  check('注册表上方有块注释', doc.startsWith('/**') && doc.includes('*/'), doc.slice(0, 40))
  check('注释里有「每帧」（讲清 buildSeats 每帧重跑）', store.includes('每帧'))
  check('注释里有「新对象」（讲清 Row 是现造的，所以裸 memo 没用）', store.includes('新对象'))
  check('注释里点名了对照的差距清单条目（S2）', store.includes('S2'))
  check('注释里写了全量锚帧（深度相等为什么必需）', store.includes('全量'))
  check('注释里写了 stage / commit 为什么分两个阶段', store.includes('layout effect') || store.includes('layout'))
  check('注释里写了「只通知变了的那几行」这条不变量', store.includes('只通知'))
  // 行体那一层也要说清「为什么它没有 memo、也不需要」。
  const rowDoc = between(src, '/**\n * 行体：先问节点级槽', 'export function RowBody(')
  check('行体上方的注释说清了「这一层没有 memo，也不需要」', rowDoc.includes('没有 memo') || rowDoc.includes('不需要'))
  check('行体注释点名了注册表（保证在别处）', rowDoc.includes('seat-store'))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
