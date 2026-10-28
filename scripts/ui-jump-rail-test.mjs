/**
 * 右侧回合刻度条「当前在第几轮」的探针（2026-10-28 报障）。
 *
 * 用户报的是：**会话里有子代理交互时，滑到底部右侧刻度高亮错位**。
 * 根因不在高亮算法本身，在锚点的来源：旧写法把 `.entry-user`（用户气泡）当锚点，
 * 「最新一轮」= 最后一个气泡所在的轮。而子代理汇报（`internal` 的 user 条目）在
 * `rows/user-row.tsx` 里渲染成一行触发行（`.entry-system`），**没有气泡**——
 * 于是那个轮永远拿不到锚点，贴底时读到的是上一个有人说话的轮，高亮就停在那儿。
 *
 * 现在两件事分开：
 *   - 「最新一轮是哪一轮」由轮清单给（`lastRound`），不从 DOM 里数；
 *   - 锚点按 `[data-round]` 收（每轮至少一条行带这个属性），同一轮去重留第一行。
 *
 * 三组断言：
 *   [1] 纯判定（`plugins/transcript/rail-window.ts`，零运行时依赖，Node 类型擦除直读）
 *   [2] 锚点去重（同一轮多行只留第一行，不许排序掩盖乱序）
 *   [3] 接线形态（`jump-rail.tsx`）：不再只认用户气泡、贴底取轮清单、隐藏行不当锚点
 *
 * 运行：node scripts/ui-jump-rail-test.mjs（读源码，不需要先编译）
 *
 * @module dsc/scripts/ui-jump-rail-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const rail = await import(
  new URL('../ui-shell/src/plugins/transcript/rail-window.ts', import.meta.url).href
)
const { dedupeByRound, pickCurrentRound } = rail

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')
// 本仓工作区是 CRLF：跨行文本钉一律先摊平。
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

console.log('[1] 纯判定：贴底取轮清单的最后一轮，不取最后一个锚点')
{
  // 用户报的那个现场：两轮，第二轮是子代理汇报（没有用户气泡）→ 锚点只到第 0 轮。
  const onlyHumanAnchor = [{ round: 0, top: 0 }]
  const bottom = pickCurrentRound({
    atBottom: true,
    lastRound: 1,
    hitRound: null,
    anchors: onlyHumanAnchor,
    probeTop: 0,
  })
  check('贴底 + 锚点只到第 0 轮 → 高亮最后一轮（第 1 轮）', bottom === 1, String(bottom))
  check(
    '旧写法会被抓到：拿锚点尾部当最新一轮时结果是 0',
    (onlyHumanAnchor.at(-1)?.round ?? -1) === 0,
    String(onlyHumanAnchor.at(-1)?.round),
  )

  const threeRounds = [{ round: 0, top: 0 }, { round: 2, top: 400 }]
  check(
    '贴底 → 给轮清单最后那一轮（哪怕最新一轮一个锚点都没有）',
    pickCurrentRound({ atBottom: true, lastRound: 2, hitRound: 0, anchors: threeRounds, probeTop: 0 }) === 2,
  )
  check(
    '贴底判定排在命中测试前面（底部那张卡不带 data-round，命中会落到上一轮）',
    pickCurrentRound({ atBottom: true, lastRound: 2, hitRound: 1, anchors: threeRounds, probeTop: 0 }) === 2,
  )
  check(
    '没有轮（lastRound = -1）时贴底不硬给 0',
    pickCurrentRound({ atBottom: true, lastRound: -1, hitRound: null, anchors: [], probeTop: 0 }) === -1,
  )
}

console.log('[2] 纯判定：不贴底时走命中测试与几何兜底')
{
  const anchors = [
    { round: 0, top: 0 },
    { round: 1, top: 800 },
    { round: 2, top: 1600 },
  ]
  check(
    '命中测试优先（探针线上是哪一轮就是哪一轮）',
    pickCurrentRound({ atBottom: false, lastRound: 2, hitRound: 1, anchors, probeTop: 850 }) === 1,
  )
  check(
    '没命中：取最后一个 top ≤ 探针线的锚点',
    pickCurrentRound({ atBottom: false, lastRound: 2, hitRound: null, anchors, probeTop: 1608 }) === 2,
  )
  check(
    '没命中且还在最顶上：高亮画出来的第一轮，而不是一枚都不亮',
    pickCurrentRound({ atBottom: false, lastRound: 2, hitRound: null, anchors, probeTop: 4 }) === 0,
  )
  check(
    '一枚锚点都没有又没贴底：给 -1（不亮，也不瞎猜）',
    pickCurrentRound({ atBottom: false, lastRound: 2, hitRound: null, anchors: [], probeTop: 0 }) === -1,
  )
  check(
    '探针线在最后一个锚点之后（滚过了下一轮起点）：取最后一个锚点',
    pickCurrentRound({ atBottom: false, lastRound: 2, hitRound: null, anchors, probeTop: 9999 }) === 2,
  )
}

console.log('[3] 锚点去重：同一轮多行只留第一行')
{
  const rows = [
    { round: 0, top: 0 },
    { round: 0, top: 60 },
    { round: 0, top: 120 },
    { round: 1, top: 300 },
    { round: 1, top: 360 },
  ]
  const anchors = dedupeByRound(rows)
  check('每轮一条', anchors.length === 2, String(anchors.length))
  check('留的是这一轮的第一行（离轮起点最近）', anchors[0].top === 0 && anchors[1].top === 300)
  check('顺序按输入（DOM）顺序，不重排', anchors.map((a) => a.round).join(',') === '0,1')
  check('空输入给空表', dedupeByRound([]).length === 0)
  check(
    '去重后仍能正确判轮（重复行不会把几何兜底带偏）',
    pickCurrentRound({ atBottom: false, lastRound: 1, hitRound: null, anchors, probeTop: 310 }) === 1,
  )
}

console.log('[4] 接线形态（ui-shell/src/plugins/transcript/jump-rail.tsx）')
{
  const src = flat(read('ui-shell/src/plugins/transcript/jump-rail.tsx'))
  check('判定从纯模块来（pickCurrentRound / dedupeByRound）', src.includes('pickCurrentRound(') && src.includes('dedupeByRound('))
  check('不再拿 .entry-user 当锚点（子代理那一轮没有气泡）', !src.includes("querySelectorAll<HTMLElement>('.entry-user')"))
  check('锚点按 [data-round] 收', src.includes("querySelectorAll<HTMLElement>('[data-round]')"))
  check('贴底的"最新一轮"取 props.rounds 的最后一轮', src.includes('lastRound: rounds.at(-1)?.round ?? -1'))
  check('隐藏行（整轮收起）不当锚点：跳过没有盒子的行', src.includes('getClientRects().length === 0'))
  check('旧的 readCurrent 不许回来', !src.includes('function readCurrent('))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
if (failures > 0) process.exitCode = 1
