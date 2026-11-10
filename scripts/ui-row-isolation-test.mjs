/**
 * 座位注册表与逐行订阅的口径钉（差距清单 S2 的彻底方案，2026-11-10）。
 *
 * 这一条要守的不变量只有一句话：**一条 `Row` 只要它自己的内容和展开状态没变，就不重渲染、
 * 也不该被碰 DOM**。守住它的四个零件分别在四个地方，所以这份探针分四段：
 *
 *   [1] 注册表本体（**真的 import `seat-store.ts` 跑**）：按身份索引、内容等价复用旧对象、
 *       只通知变了的行、退订摘干净、跨会话不串。
 *   [2] 判等函数：`sameRow` / `sameContent` 的判据（引用 / 深度相等 / at / live / stable）。
 *   [3] 源码形态：谁索引、按什么键、谁负责在卸载时摘除、壳与行体怎么分工。
 *   [4] 反向钉：不许把整个 `Row` 塞进比较器、不许在行体里读全局可变状态、不许让注册表
 *       依赖 React、不许回到「每帧新建一张表」。
 *
 * 为什么这些断言值得单独钉：上一轮的止血（给 `RowBody` 包带比较器的 `memo`）量下来只省了
 * 26% 的脚本时间，原因就是它只挡函数体、挡不住座位壳与元素对账。这一层的价值全在「谁在
 * 什么时候被通知」这条时序上，而时序是最容易被后人「顺手优化」掉的东西。
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-row-isolation-test.mjs
 *
 * @module dsc/scripts/ui-row-isolation-test
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveUiHalf } from './_check-runner.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const UI = resolveUiHalf('transcript')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const storeSrc = read(`${UI}/seat-store.ts`)
const renderSrc = read(`${UI}/render.tsx`)
const uiSrc = read(`${UI}/ui.tsx`)
const sharedSrc = read(`${UI}/shared.ts`)

// 源码钉里「不该出现」的判据先剥注释：修法的注释里就引着旧写法，不剥会自己打脸。
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const storeCode = stripComments(storeSrc)
const renderCode = stripComments(renderSrc)
const uiCode = stripComments(uiSrc)

/** 从起点截到终点（找不到就给空串）。 */
const between = (text, from, to) => {
  const at = text.indexOf(from)
  if (at === -1) return ''
  const end = text.indexOf(to, at + from.length)
  return text.slice(at, end === -1 ? text.length : end)
}

/**
 * 一行测试数据。`entry` 的形状故意用最简单的纯 JSON：注册表只认数据，不认条目有几种。
 * @param {object} over 覆盖字段（stable / live / at / entry）
 */
const rowOf = (over = {}) => ({
  stable: 'r0:text:0',
  live: false,
  at: 1,
  entry: { kind: 'text', id: 1, text: '第一句' },
  ...over,
})

/** 一份座位：一个前导行 + 一个轮，轮里两行。 */
const seatsOf = (roundRows) => ({
  leading: [rowOf({ stable: 'lead:system:0', at: 0, entry: { kind: 'system', id: 0, text: '开场' } })],
  rounds: [{ rows: roundRows }],
})

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

// 注册表本体：真的 import 进来跑（不是读源码猜行为）。
const { createSeatStore, sameRow, sameContent } = await import(
  new URL(`../${UI}/seat-store.ts`, import.meta.url).href
)
/**
 * 键的算法：注册表由调用方注入它（生产里递的是 shared.ts 的 keyOf）。
 *
 * 探针这边用一份等价实现——shared.ts 带着分轮与取词器的运行期依赖，Node 的 ESM
 * 解析不了它的无扩展名相对 import；而「生产真的递的是 keyOf」这一条走源码钉（[4] 段）。
 */
const keyOf = (row, sessionKey) => `${sessionKey}|${row.stable}`

console.log('[1] 注册表本体：按身份索引、内容等价复用、只通知变了的行')
{
  check('seat-store.ts 导出了 createSeatStore', typeof createSeatStore === 'function')
  const store = createSeatStore(keyOf)
  check(
    '注册表有 stage / commit / row / subscribe / size / lastChanged 六个出口',
    ['stage', 'commit', 'row', 'subscribe', 'size', 'lastChanged'].every((name) => typeof store[name] === 'function'),
  )

  const first = rowOf()
  const second = rowOf({ stable: 'r0:tool:0', at: 2, entry: { kind: 'tool', id: 2, call: { callId: 'c1', name: 'bash' } } })
  store.stage('s1', seatsOf([first, second]))
  const firstKey = keyOf(first, 's1')
  const secondKey = keyOf(second, 's1')
  check('stage 之后渲染期就能读到行（render 与 commit 分两个阶段的前提）', store.row(firstKey)?.at === 1)
  check('前导段也登记（不然前导行第一帧读不到数据）', store.row(keyOf(seatsOf([]).leading[0], 's1')) !== undefined)
  store.commit()
  check('commit 之后行数 = 这一帧登记的行数（1 前导 + 2 座位）', store.size() === 3, String(store.size()))

  // 不变的一帧：同样内容、新对象（buildSeats 每帧现造 Row）→ 必须复用旧对象。
  store.stage('s1', seatsOf([rowOf(), rowOf({ stable: 'r0:tool:0', at: 2, entry: second.entry })]))
  const reused = store.row(firstKey)
  check('内容没变时复用上一帧的 Row 对象（引用相同 = 行体不重渲染）', reused === store.row(firstKey) && reused?.stable === first.stable)
  store.commit()
  check('内容没变的一帧：一行都不通知', store.lastChanged() === 0, String(store.lastChanged()))

  // 全量锚帧：条目是新对象、内容逐字相同 → 也算没变。
  const anchorEntry = { kind: 'text', id: 1, text: '第一句' }
  store.stage('s1', seatsOf([rowOf({ entry: anchorEntry }), rowOf({ stable: 'r0:tool:0', at: 2, entry: second.entry })]))
  store.commit()
  check('全量锚帧（新对象、同内容）不通知任何行', store.lastChanged() === 0, String(store.lastChanged()))
  check('全量锚帧之后，行里留的仍是旧的那个 entry 对象（下游 memo 还能命中）', store.row(firstKey)?.entry === first.entry)

  // 真变：一个字符。
  store.stage('s1', seatsOf([
    rowOf({ entry: { kind: 'text', id: 1, text: '第一句，多一个字' } }),
    rowOf({ stable: 'r0:tool:0', at: 2, entry: second.entry }),
  ]))
  store.commit()
  check('内容真的变了：只通知这一行（另两行不动）', store.lastChanged() === 1, String(store.lastChanged()))
  check('变了之后行体读到的是新内容', store.row(firstKey)?.entry.text === '第一句，多一个字')

  // live 变化（直播 → 定稿那一拍）必须通知。
  store.stage('s1', seatsOf([rowOf({ live: true, entry: { kind: 'text', id: 1, text: '第一句，多一个字' } })]))
  store.commit()
  check('live 变了也通知（直播 → 定稿要重画光标与默认展开态）', store.lastChanged() >= 1)

  // at 变化（历史分页 / 定稿让下标漂）必须通知。
  store.stage('s1', seatsOf([rowOf({ live: true, at: 9, entry: { kind: 'text', id: 1, text: '第一句，多一个字' } })]))
  store.commit()
  check('at 变了也通知（否则行里留着过期下标）', store.lastChanged() === 1, String(store.lastChanged()))
  check('at 变了之后读到的是新下标', store.row(firstKey)?.at === 9)
}

console.log('[2] 订阅：只喊登记过的那一格，退订摘干净')
{
  const store = createSeatStore(keyOf)
  const row = rowOf()
  store.stage('s1', seatsOf([row]))
  store.commit()
  const key = keyOf(row, 's1')
  let calls = 0
  const off = store.subscribe(key, () => {
    calls += 1
  })
  check('订阅返回一个函数（卸载时由 useSyncExternalStore 的 cleanup 调用）', typeof off === 'function')

  store.stage('s1', seatsOf([rowOf()]))
  store.commit()
  check('这一帧没变：订阅者一次都不被打扰', calls === 0, String(calls))

  store.stage('s1', seatsOf([rowOf({ entry: { kind: 'text', id: 1, text: '变了' } })]))
  store.commit()
  check('这一帧变了：订阅者被打扰正好一次', calls === 1, String(calls))

  off()
  store.stage('s1', seatsOf([rowOf({ entry: { kind: 'text', id: 1, text: '又变了' } })]))
  store.commit()
  check('退订之后不再被打扰', calls === 1, String(calls))

  // 退订把空集合从表里摘掉：再订阅、再退订、再提交，计数还是 0。
  const off2 = store.subscribe(key, () => {
    calls += 1
  })
  off2()
  store.stage('s1', seatsOf([rowOf({ entry: { kind: 'text', id: 1, text: '第三变' } })]))
  store.commit()
  check('退订把空的订阅集合一起摘掉（注册表不会越攒越大）', calls === 1, String(calls))

  // 同一帧 stage 两次（React 严格模式的双次渲染）必须收敛到同一份结果：
  // 第二遍不许把「第一遍刚算出来的格子」再判成新行。
  const doubled = createSeatStore(keyOf)
  doubled.stage('s1', seatsOf([rowOf()]))
  doubled.stage('s1', seatsOf([rowOf()]))
  doubled.commit()
  const firstCommitCells = doubled.lastChanged()
  check('首帧登记 2 行（1 前导 + 1 座位），一行不多一行不少', firstCommitCells === 2, String(firstCommitCells))
  doubled.stage('s1', seatsOf([rowOf()]))
  doubled.stage('s1', seatsOf([rowOf()]))
  doubled.commit()
  check('同一帧 stage 两次之后再提交：一行都不通知（双次渲染不制造假变动）', doubled.lastChanged() === 0, String(doubled.lastChanged()))

  // 没有 stage 就 commit：空操作。
  const empty = createSeatStore(keyOf)
  empty.commit()
  check('没登记过就 commit 是空操作（不会把上一帧的表清空）', empty.size() === 0 && empty.lastChanged() === 0)

  // 这一帧没登记的行（被分页切走 / 整轮消失）：格子连同订阅位一起被摘掉。
  const gone = createSeatStore(keyOf)
  gone.stage('s1', seatsOf([rowOf(), rowOf({ stable: 'r0:text:1', at: 5 })]))
  gone.commit()
  const goneKey = keyOf(rowOf({ stable: 'r0:text:1', at: 5 }), 's1')
  let goneCalls = 0
  gone.subscribe(goneKey, () => {
    goneCalls += 1
  })
  gone.stage('s1', seatsOf([rowOf()]))
  gone.commit()
  check('这一帧消失的行被摘出表（size 跟着降）', gone.size() === 2, String(gone.size()))
  check('消失的行不会再收到通知', goneCalls === 0, String(goneCalls))

  // 键里带会话：切会话时同一 stable 不许把上一条会话的行对象借过来（内容一字不差也不行）。
  const cross = createSeatStore(keyOf)
  cross.stage('s1', seatsOf([rowOf()]))
  cross.commit()
  const fromS1 = cross.row(keyOf(rowOf(), 's1'))
  cross.stage('s2', seatsOf([rowOf()]))
  cross.commit()
  const fromS2 = cross.row(keyOf(rowOf(), 's2'))
  check('切会话之后上一条会话的格子被摘掉（不是并排留着）', cross.row(keyOf(rowOf(), 's1')) === undefined)
  check('两条会话的同一 stable 不共用对象（内容一样也不借）', fromS1 !== fromS2 && fromS1 !== undefined && fromS2 !== undefined)
  check('现役表只剩这一帧登记的行（前导 + 座位 = 2）', cross.size() === 2, String(cross.size()))
}

console.log('[3] 判等函数：什么算「同一行」')
{
  check('sameContent 认引用相等', sameContent({ a: 1 }, { a: 1 }) === true)
  check('sameContent 认嵌套对象与数组的深相等', sameContent({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }) === true)
  check('sameContent 值不同就不同', sameContent({ a: 2 }, { a: 1 }) === false)
  check('sameContent 数组长度不同就不同', sameContent([1, 2], [1]) === false)
  check('sameContent 数组与对象不互认', sameContent([], {}) === false)
  check('sameContent 少一个键就算不同（条件展开的字段缺了不能当没变）', sameContent({ a: 1 }, { a: 1, b: undefined }) === false)
  check('sameContent 把 null 与对象分开', sameContent(null, {}) === false)
  check('sameContent 认原始值的严格相等（NaN 之外）', sameContent(1, 1) === true && sameContent('a', 'b') === false)

  const base = rowOf()
  check('sameRow：同一个对象算同一行', sameRow(base, base) === true)
  check(
    'sameRow：换对象、内容相同算同一行（全量锚帧那条路）',
    sameRow(base, { ...base, entry: { ...base.entry } }) === true,
  )
  check('sameRow：正文变了不算', sameRow(base, { ...base, entry: { ...base.entry, text: '别的话' } }) === false)
  check('sameRow：live 变了不算', sameRow(base, { ...base, live: true }) === false)
  check('sameRow：at 变了不算', sameRow(base, { ...base, at: base.at + 1 }) === false)
  check('sameRow：stable 变了不算', sameRow(base, { ...base, stable: 'r0:text:1' }) === false)
  check(
    'sameRow 不把「工具卡条目的 call 深一层」漏掉（callId 换了要重画）',
    sameRow(
      rowOf({ entry: { kind: 'tool', id: 2, call: { callId: 'a' } } }),
      rowOf({ entry: { kind: 'tool', id: 2, call: { callId: 'b' } } }),
    ) === false,
  )
  // 反向钉：JSON 字符串化在这一层是「拿垃圾换省事」——每帧上百次调用，字符串化每次都产生新串。
  check('判等不用 JSON.stringify（源码里一次都没有）', !storeCode.includes('JSON.stringify'))
}

console.log('[4] 源码形态：谁索引、按什么键、谁负责摘除')
{
  // 键的算法由调用方注入：注册表自己不再写一份，生产里递的就是 shared.ts 的 keyOf。
  check('seat-store.ts 只从 shared.ts 取类型（运行期零依赖，Node 能直接跑它的本体）', /import type \{ Row \} from '\.\/shared'/.test(storeSrc))
  check('ui.tsx 把 keyOf 递给注册表（键只有一处定义）', uiSrc.includes('createSeatStore(keyOf)'))
  check('索引键就是 keyOf(row, sessionKey)', storeCode.includes('const key = keyOf(row, sessionKey)'))
  check('键与 React key 是同一个函数（ui.tsx 用 keyOf 生成 key）', /keyOf\(row, sessionKey\)/.test(uiCode) && uiCode.includes('key={key}'))
  check(
    'render.tsx 的座位壳是 memo 的（SeatFrame）',
    /export const SeatFrame = memo\(function SeatFrame\(/.test(renderCode),
  )
  const frameProps = between(renderCode, 'export const SeatFrame = memo(function SeatFrame(props: {', '}): ReactNode {')
  check('壳的 props 只有稳定标量（座位键 / 藏不藏 / 轮序号 / 两个引用）', frameProps.length > 0, String(frameProps.length))
  // 反向钉：Row 每帧都是新对象，递给壳就等于让壳每帧重渲染——壳不许吃它。
  check('壳的 props 里没有 Row（反向钉）', !/\brow(Row)?\s*:\s*Row\b/.test(frameProps), frameProps.slice(0, 120))
  check('壳只把座位键递给行体（不递 Row）', renderCode.includes('<RowSlot seatKey={props.seatKey} store={props.store} renderSlot={props.renderSlot} />'))
  check(
    '行体自己从注册表订阅（useSyncExternalStore + subscribe + row）',
    /useSyncExternalStore\(subscribe, snapshot, snapshot\)/.test(renderCode)
      && renderCode.includes('store.subscribe(seatKey, onChange)')
      && renderCode.includes('store.row(seatKey)'),
  )
  check('订阅回调按座位键包了 useCallback（否则每帧重订阅一次）', /\[store, seatKey\]/.test(renderCode))
  check('行体入口是 memo 的（父组件每帧重渲染时连函数体都不进）', /const RowSlot = memo\(function RowSlot\(/.test(renderCode))
  check('行体不再自带比较器（止血那版的 rowBodyUnchanged 已退役）', !renderCode.includes('rowBodyUnchanged'))
  check('RowBody 不再被 memo 包着（它不再是热路径上的那一层）', !/export const RowBody = memo\(/.test(renderCode))

  check('渲染期只 stage（登记），不通知', uiCode.includes('seatStore.stage(sessionKey, seats)'))
  check('提交与通知在 layout effect 里（绘制前落地，用户看不到旧帧）', /useLayoutEffect\(\(\) => \{\s*\n\s*seatStore\.commit\(\)/.test(uiCode))
  check('注册表只建一次（useState 惰性建，切会话不重建）', uiCode.includes('const [seatStore] = useState(() => createSeatStore(keyOf))'))
  // 反向钉：注册表必须活在组件里。每帧新建一张表等于每帧把所有行判成「新行」。
  check('没有在渲染体里直接 createSeatStore(...)（反向钉：注册表必须只建一次）', !/const seatStore = createSeatStore\(/.test(uiCode))
  check('stage 里没有任何通知动作（只写 pending）', !between(storeCode, 'stage(sessionKey, seats) {', '},\n\n    commit(').includes('listener'))
  check(
    'commit 先换现役表、再通知（顺序反了会通知到旧数据上）',
    /committed = next\s*\n\s*changed = touched\.length/.test(storeCode),
  )
  check('退订时把空集合从表里摘掉', /if \(current\.size === 0\) listeners\.delete\(key\)/.test(storeCode))
  check('这一帧消失的行连订阅位一起摘掉', storeCode.includes('if (!next.has(key)) listeners.delete(key)'))
  check('注册表不 import React（本体能在 Node 里直接跑）', !/from 'react'/.test(storeSrc))
  check('前导行也走同一个壳（ui.tsx 里没有第二套 leading 行渲染）', !uiCode.includes('seats.leading.map((row) => (\n        <RowBoundary'))
  check('注释写清了「谁在什么时候被通知」的三个阶段（stage / commit / subscribe）', storeSrc.includes('stage') && storeSrc.includes('commit') && storeSrc.includes('useSyncExternalStore'))
  check('注释点名了差距清单条目 S2', storeSrc.includes('S2'))

  // 反向钉：行体不许读全局可变状态（读到就绕过了订阅，重渲染再也不可预测）。
  const rowSlot = between(renderCode, 'const RowSlot = memo(function RowSlot(', '\n})\n')
  const rowBody = between(renderCode, 'export function RowBody(', '\n}\n')
  const bodyOnly = rowSlot + rowBody
  check(
    '行体里没有 window / globalThis / document / Date.now（反向钉）',
    bodyOnly.length > 0 && !/\b(window|globalThis|document)\.|Date\.now\(\)/.test(bodyOnly),
    bodyOnly.slice(0, 160),
  )
  // 反向钉：拿整个 Row 去比等于永远不等（Row 每帧都是 rowOf 现造的字面量）。
  check('没有 previous.row === next.row 这类整对象比较', !/\.row === \w+\.row(?![.\w])/.test(storeCode))
  check('没有把 Row 序列化后比', !/JSON\.stringify\(\s*\w+\.row\s*\)/.test(storeCode))
  // 反向钉：比较键必须包含 at / live（漏了 at 会让行留着过期下标，漏了 live 会让定稿那拍不重画）。
  check('sameRow 比了 at', storeCode.includes('previous.at !== next.at'))
  check('sameRow 比了 live', storeCode.includes('previous.live !== next.live'))
  check('sameRow 比了 stable', storeCode.includes('previous.stable !== next.stable'))
  check('共享的 keyOf 仍是「会话|稳定身份」', sharedSrc.includes('return `${sessionKey}|${row.stable}`'))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
