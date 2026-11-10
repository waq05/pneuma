/**
 * 行体 `memo` 的止血探针（差距清单 S2，2026-11-10）。
 *
 * 要解决的事：会话流式时每来一口 delta，`ui.tsx` 的 `useMemo(() => buildSeats(entries, live), …)`
 * 都会重跑（`live` 每帧新引用），于是**每一行的 `Row` 都是新对象**——整棵行树重画一遍，
 * 而其中 markdown 正文与思考正文的内容根本没变。
 *
 * 止血只在 `RowBody` 一层：给它包一个**带比较器**的 `memo`，比 `row.entry` 引用 + `row.live`
 * + `renderSlot` 三样。这一份探针钉的就是「这个比较器还在、比的还是对的东西」——
 * 后人把它改回裸 `memo(RowBody)`、或者顺手把 `row` 整个对象塞进比较器，都会当场变红。
 *
 * 四段（**只钉源码形态**：不在 Node 里跑 React，「memo 真能跳过重渲染」由主控真机量 commit）：
 *   [1] 包了 memo，而且带比较器（含反向钉：不许出现裸 memo）
 *   [2] 比较器比的是对的东西（entry 引用 / live / renderSlot，且不比 Row 对象本身）
 *   [3] 不许拿 at / stable 当比较键
 *   [4] 注释写清了为什么（每帧 / 新对象）
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-row-memo-test.mjs
 *
 * @module dsc/scripts/ui-row-memo-test
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveUiHalf, root } from './_check-runner.mjs'

const UI = resolveUiHalf('transcript')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

/** 行体入口就这一份（`RowBodyBody` 在它里面，比较器紧跟在后面）。 */
const src = read(`${UI}/render.tsx`)
/** 「不该出现」的断言先剥注释：修法自己的注释里就引着旧写法，不剥会自己打脸。 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

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

console.log('[1] 包了 memo，而且带比较器')
{
  check('render.tsx 里确实用了 memo', code.includes('memo('))
  check('比较器有名字（rowBodyUnchanged）', code.includes('rowBodyUnchanged'))
  check(
    '导出形状是 `export const RowBody = memo(`',
    /export const RowBody = memo\(/.test(code),
  )
  check(
    '比较器真的作为第二个参数递进去了（不是只定义不用）',
    /memo\(\s*RowBodyBody\s*,\s*rowBodyUnchanged\s*\)/.test(code),
  )
  check(
    '原来那个函数体改成了内部实现 RowBodyBody（不再是 export function RowBody）',
    /function RowBodyBody\(\{ row, renderSlot \}/.test(code) && !/export function RowBody\(/.test(code),
  )

  // 反向钉：不带比较器的 memo 正是这个 bug 的原样（Row 每帧新对象 → 浅比较必失败 → 等于没加）。
  check('没有裸的 memo(RowBody)', !/memo\(\s*RowBody\s*\)/.test(code))
  check('没有 memo(function RowBody（同样是裸 memo）', !/memo\(\s*function\s+RowBody\b/.test(code))
  check('没有两参数的 memo 写成默认比较（第二参不是 undefined）', !/memo\(\s*RowBodyBody\s*\)/.test(code))
}

console.log('[2] 比较器比的是对的东西')
{
  const at = code.indexOf('function rowBodyUnchanged')
  const tail = at === -1 ? '' : code.slice(at)
  const end = tail.indexOf('\n}\n')
  const comparator = tail.slice(0, end === -1 ? tail.length : end + 2)
  check('比较器能从源码里切出来（切片非空）', comparator.length > 0, String(comparator.length))

  check('比 row.entry 的引用', /previous\.row\.entry === next\.row\.entry/.test(comparator))
  check('比 row.live（直播尾多一个光标与展开态）', /previous\.row\.live === next\.row\.live/.test(comparator))
  check('比 renderSlot 的引用（壳给的渲染函数）', /previous\.renderSlot === next\.renderSlot/.test(comparator))

  // 反向钉：拿整个 Row 对象去比等于永远不等——Row 每帧都是 rowOf 现造的字面量。
  check('没有 previous.row === next.row（比整个 Row 对象 = 永远 false）', !/previous\.row === next\.row(?![.\w])/.test(comparator))
  check('没有把 row 整个对象丢进比较（深层比较写法也不行）', !/JSON\.stringify\(\s*previous\.row\s*\)/.test(comparator))
}

console.log('[3] 不许拿 at / stable 当比较键')
{
  const at = code.indexOf('function rowBodyUnchanged')
  const tail = at === -1 ? '' : code.slice(at)
  const end = tail.indexOf('\n}\n')
  const comparator = tail.slice(0, end === -1 ? tail.length : end + 2)

  // at 会随历史分页漂：把它当比较键，翻一页历史就让所有 memo 集体失效。
  // stable 与 entry 同源（条目一样就一定一样）：比它只是多算一遍，白让 memo 失效。
  check('比较器里不出现 row.at', !/\.row\.at\b/.test(comparator))
  check('比较器里不出现 row.stable', !/\.row\.stable\b/.test(comparator))
  check('比较器只由这三样拼成（没有第四个比较键混进来）', (comparator.match(/===/g) ?? []).length === 3, String((comparator.match(/===/g) ?? []).length))
}

console.log('[4] 注释写清了为什么')
{
  const bodyAt = src.indexOf('function RowBodyBody')
  const before = bodyAt === -1 ? '' : src.slice(0, bodyAt)
  const open = before.lastIndexOf('/**')
  const doc = open === -1 ? '' : before.slice(open)

  check('函数上方有块注释', doc.startsWith('/**') && doc.includes('*/'), doc.slice(0, 40))
  check('注释里有「每帧」（讲清 buildSeats 每帧重跑）', doc.includes('每帧'))
  check('注释里有「新对象」（讲清 Row 是现造的，所以裸 memo 没用）', doc.includes('新对象'))
  check('注释里点名了对照的差距清单条目（S2）', doc.includes('S2'))
  check('注释里写了为什么不比 at / stable', doc.includes('row.at') && doc.includes('row.stable'))
  check('注释里写了 context 会穿透 memo（切会话不用额外处理）', doc.includes('context') && doc.includes('穿透'))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
