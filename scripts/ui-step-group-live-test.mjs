/**
 * 阶段组「跑动中 / 已定稿」两态的探针（2026-11-06 报障的缺陷二）。
 *
 * 报障现场：设置页写着「标准 = 跑动中显示实时详情」，实际标准档与紧凑档逐像素相同。
 * 根因在 `process-groups.ts` 的尾组：它一律 `pending = []` 丢掉，`flush` 只会被 `flush(true)`
 * 调用，于是每个 StepGroup 都是 closed=true，而 `running` / `runningDetail` 只在 closed=false
 * 时写——实时详情永远是空的，`liveDetail` 这个档位开关没有任何可见效果。
 *
 * 修后的口径：
 *   - **跑动中的那一组**：closed=false，组头报「正在…」+ 实时详情（标准档），紧凑档没有详情；
 *   - **定稿之后的组**：照旧 closed=true，组头只报聚合类别与条数，两档完全相同。
 *
 * 这里跑的是产品源码（`process-groups.ts` 是纯逻辑，Node 直接 import），组头文案按
 * `step-group-row.tsx` 的取法拼出来（closed 走聚合、未闭走实时 + 详情），并另用源码钉把
 * 那条取法本身钉住——纯函数改了、渲染体的那一行改了，都会红。
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-step-group-live-test.mjs
 *
 * @module dsc/scripts/ui-step-group-live-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(root + rel, 'utf8')

const {
  groupSteps, stepGroupTitle, liveTitleOf, STEP_TITLE_SEPARATOR,
} = await import(new URL('../src/packages/ui-transcript/ui/process-groups.ts', import.meta.url).href)

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log('  ok  ' + name)
  } else {
    failures += 1
    console.log('FAIL  ' + name + (detail === undefined ? '' : '  <- ' + detail))
  }
}

/** 造一条条目：工具调用带 callId / 名字 / 参数 / 状态。 */
let seq = 0
const entry = (kind, extra = {}) => ({ kind, id: (seq += 1), ...extra })
const tool = (name, status, args = {}) =>
  entry('tool', { call: { callId: 'c' + seq, name, argsText: JSON.stringify(args), status } })

/**
 * 组头此刻的「一行字」：完全照 `step-group-row.tsx` 的取法——
 * 已结束按类别聚合，未结束按此刻在跑的那一类 + 档位允许的实时详情。
 *
 * @param group groupSteps 切出来的组
 * @param liveDetail 这一档要不要实时详情（PROCESS_FOLD_POLICIES 的 liveDetail）
 */
const headerText = (group, liveDetail) => {
  const closed = group.closed
  const live = liveTitleOf(group)
  const activity = closed ? group.counts[0]?.kind ?? 'thinking' : live.activity
  const label = stepGroupTitle(group.counts, closed, activity === 'thinking' ? undefined : activity, live.preparing)
  const detail = closed || !liveDetail ? '' : live.detail
  return detail === '' ? label : label + STEP_TITLE_SEPARATOR + detail
}

// ── 样张一：还在跑的一轮（两条工具，最后那条 bash 正在跑） ──────────────────────
const runningEntries = [
  entry('user', { text: '跑一下构建' }),
  entry('thinking', { text: '先读一眼配置。' }),
  tool('read', 'done', { path: 'package.json' }),
  tool('bash', 'running', { command: 'pnpm build' }),
]
const runningRounds = [{ index: 0, startIndex: 0, endIndex: 3, startTs: 1, endTs: null, answered: true }]
const running = groupSteps(runningEntries, runningRounds, () => true)

// ── 样张二：同一份内容，这一轮已定稿 ──────────────────────────────────────────
const settledEntries = runningEntries.map((item, at) =>
  at === 3 ? { ...item, call: { ...item.call, status: 'done', resultText: 'build ok' } } : item,
)
const settledRounds = [{ index: 0, startIndex: 0, endIndex: 3, startTs: 1, endTs: 9, answered: true }]
const settled = groupSteps(settledEntries, settledRounds, () => false)

console.log('[1] 跑动中：组是 open 的，实时类别与详情都在')
{
  check('跑动中的尾组成组（不再是 pending = [] 丢掉）', running.groups.length === 1, String(running.groups.length))
  const group = running.groups[0]
  check('这一组 closed = false', group !== undefined && group.closed === false, JSON.stringify(group?.closed))
  check('组里收着思考 + 两条工具（3 条成员）', group !== undefined && group.size === 3, JSON.stringify(group?.size))
  check('成员按出现顺序：思考在前、工具在后', group?.members.join(',') === '1,2,3', JSON.stringify(group?.members))
  check('类别计数只数工具（思考不占类别）', group?.counts.reduce((sum, item) => sum + item.count, 0) === 2, JSON.stringify(group?.counts))
  check('实时类别 = 命令（最后那条运行中的工具）', group?.running === 'commands', String(group?.running))
  check('实时详情 = 那条命令本身', group?.runningDetail === 'pnpm build', String(group?.runningDetail))
}

console.log('[2] 同一份「还在跑」：标准档与紧凑档的组头文案必须不同')
{
  const group = running.groups[0]
  const standard = headerText(group, true)
  const compact = headerText(group, false)
  check('标准档组头带实时详情', standard.includes('pnpm build') && standard.includes('正在运行命令'), standard)
  check('紧凑档组头只有类别（没有实时详情）', compact === '正在运行命令', compact)
  check('两档文案不同（缺陷二的核心断言）', standard !== compact, JSON.stringify({ standard, compact }))
}

console.log('[3] 同一份「已定稿」：两档必须完全相同，且照旧只报聚合')
{
  check('定稿后照旧切成一组', settled.groups.length === 1, String(settled.groups.length))
  const group = settled.groups[0]
  check('定稿的组 closed = true（行为一个字没变）', group?.closed === true)
  check('定稿的组不带实时类别', group?.running === undefined, String(group?.running))
  check('定稿的组不带实时详情', group?.runningDetail === undefined, String(group?.runningDetail))
  const standard = headerText(group, true)
  const compact = headerText(group, false)
  check('两档文案完全相同', standard === compact, JSON.stringify({ standard, compact }))
  check('文案是聚合类别（不再出现「正在」）', !standard.includes('正在') && standard.includes('已'), standard)
  check('聚合文案与 stepGroupTitle 的旧口径一致', standard === stepGroupTitle(group.counts, true), standard)
}

console.log('[4] 只有一条内容时不建组（一轮刚起步，唯一的行不该被组头收走）')
{
  const single = [
    entry('user', { text: '读一眼' }),
    tool('read', 'running', { path: 'a.ts' }),
  ]
  const grouping = groupSteps(
    single,
    [{ index: 0, startIndex: 0, endIndex: 1, startTs: 1, endTs: null, answered: true }],
    () => true,
  )
  check('单条运行中的工具不单独成组', grouping.groups.length === 0, String(grouping.groups.length))
  check('但它仍是一条可渲染的行（不在任何组里）', grouping.at.size === 0)

  // 一条思考 + 一次调用就必须成组：这是「想一句、调一次」最常见的节奏，也是用户报障里
  // 「每行平铺、没有『运行了代码』这一层」的根源。
  const thinkThenCall = [
    entry('user', { text: '跑一下' }),
    entry('thinking', { text: '先看看。' }),
    tool('bash', 'running', { command: 'pnpm build' }),
  ]
  const grouped = groupSteps(
    thinkThenCall,
    [{ index: 0, startIndex: 0, endIndex: 2, startTs: 1, endTs: null, answered: true }],
    () => true,
  )
  check('思考 + 调用两条就成组（不再按「工具条数」判）', grouped.groups.length === 1 && grouped.groups[0].size === 2, String(grouped.groups.length))
  check('组头画在第一条（思考行）的位置上', grouped.headAt.has(1) === true && grouped.headAt.has(2) === false)
}

console.log('[5] 源码钉：渲染体与分组器的接线')
{
  const row = read('src/packages/ui-transcript/ui/step-group-row.tsx').replace(/\r\n/g, '\n')
  const groups = read('src/packages/ui-transcript/ui/process-groups.ts').replace(/\r\n/g, '\n')
  check(
    '组头只在本组未收口、且这一档要详情时画实时详情',
    /const detail = closed \|\| !props\.showDetail \? '' : live\.detail/.test(row),
  )
  check('实时详情仍然单独占一行（data-shimmer）', /data-shimmer=\{detail\}/.test(row))
  check('详情走 data-step-detail（截图与探针的读数口）', row.includes('data-step-detail={detail === \'\' ? undefined : detail}'))
  check(
    '分组器：跑动中的尾组以 closed=false 收口',
    /if \(isRunning\(round\.index\)\) \{\s*\n\s*if \(pending\.length >= 2\) flush\(false\)/.test(groups),
  )
  check('分组器：思考与工具同组（不再遇思考就封组）', /entry\.kind === 'tool' \|\| entry\.kind === 'thinking'/.test(groups))
  check('分组器：system 是边界（不把错误提示裹进组体）', /if \(entry\.kind === 'system'\) \{\s*\n\s*flush\(true\)/.test(groups))
  check('小组按 members 结算，不再用下标区间铺组员', groups.includes('items.push({ kind: \'group\', group: head, members: head.members })'))
  check('分组器：定稿的轮照旧 flush(true)', /\} else \{\s*\n\s*\/\/ 定稿的轮[\s\S]{0,120}?flush\(true\)/.test(groups))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
if (failures !== 0) process.exitCode = 1
