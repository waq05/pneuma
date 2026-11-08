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
  groupSteps, stepGroupTitle, liveTitleOf, seatPlan, STEP_TITLE_SEPARATOR,
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
  // 2026-11-07 起这条分支多了一类成员（过程正文），条件排成了多行，正则跟着放宽到换行。
  check('分组器：思考与工具同组（不再遇思考就封组）', /entry\.kind === 'tool'\s*\|\|\s*entry\.kind === 'thinking'/.test(groups))
  check('分组器：system 是边界（不把错误提示裹进组体）', /if \(entry\.kind === 'system'\) \{\s*\n\s*flush\(true\)/.test(groups))
  check('小组按 members 结算，不再用下标区间铺组员', groups.includes('items.push({ kind: \'group\', group: head, members: head.members })'))
  check('分组器：定稿的轮照旧 flush(true)', /\} else \{\s*\n\s*\/\/ 定稿的轮[\s\S]{0,120}?flush\(true\)/.test(groups))
}


console.log('[6] 过程正文：调工具之前那句前言不封组（2026-11-07 报障）')
{
  // 模型在同一步里「说一句 + 调工具」：这句正文带 process 标记（adapter 在 tool/call 时补上）。
  const withNote = [
    entry('user', { text: '装一下' }),
    entry('thinking', { text: '先看现场。' }),
    entry('text', { text: '安装完成，启动做最后验证：', process: true }),
    tool('bash', 'done', { command: 'node app.js' }),
    entry('text', { text: '这次真的好了。' }),
  ]
  const grouping = groupSteps(
    withNote,
    [{ index: 0, startIndex: 0, endIndex: 4, startTs: 1, endTs: 9, answered: true }],
    () => false,
  )
  const group = grouping.groups[0]
  check('整段过程收成一组（前言不切组）', grouping.groups.length === 1, String(grouping.groups.length))
  check('组里收着思考 + 前言 + 工具三条', group?.size === 3, JSON.stringify(group?.members))
  check('成员按出现顺序：思考、前言、工具', group?.members.join(',') === '1,2,3', JSON.stringify(group?.members))
  check('真正文留在组外（照旧封组）', grouping.at.has(4) === false && grouping.headAt.has(4) === false)
  check('类别只数工具（前言不是一次调用）', group?.counts.reduce((sum, item) => sum + item.count, 0) === 1, JSON.stringify(group?.counts))

  // 不带标记的正文照旧是边界：模型只说话、没动手的那一步不该被并进上一组。
  const plainReply = [
    entry('user', { text: '说说看' }),
    entry('thinking', { text: '想想。' }),
    tool('read', 'done', { path: 'a.ts' }),
    entry('text', { text: '看完了，结论是……' }),
  ]
  const split = groupSteps(
    plainReply,
    [{ index: 0, startIndex: 0, endIndex: 3, startTs: 1, endTs: 9, answered: true }],
    () => false,
  )
  check('不带标记的正文仍然封组', split.groups.length === 1 && split.groups[0].members.join(',') === '1,2', JSON.stringify(split.groups.map((g) => g.members)))

  // 排布不变量照旧：每条行恰好出一次，前言只在组体里出现。
  const plan = seatPlan([1, 2, 3, 4], grouping)
  const flat = plan.flatMap((item) => (item.kind === 'group' ? item.members : [item.at]))
  check('每条行恰好出一次（前言不重复铺）', flat.join(',') === '1,2,3,4', flat.join(','))
  check('组头只出在第一条（思考行）上', plan.filter((item) => item.kind === 'group').length === 1)
}

console.log('[7] 源码钉：过程正文的标记与三处接线')
{
  const adapter = read('src/adapter/transcript.ts').replace(/\r\n/g, '\n')
  const groups = read('src/packages/ui-transcript/ui/process-groups.ts').replace(/\r\n/g, '\n')
  const render = read('src/packages/ui-transcript/ui/render.tsx').replace(/\r\n/g, '\n')
  const fold = read('src/packages/ui-transcript/ui/round-fold.tsx').replace(/\r\n/g, '\n')
  const views = read('src/packages/ui-renderer/ui/styles/legacy/views.css').replace(/\r\n/g, '\n')
  check('adapter：tool/call 时回标上一条正文', /wrote\.kind === 'text' && wrote\.process !== true[\s\S]{0,120}?process: true as const/.test(adapter))
  check('adapter：tool/prepare 时提前降级直播尾', /tail\.kind === 'text'\) tail\.process = true/.test(adapter))
  check('adapter：直播尾把标记带给条目', adapter.includes("segment.process === true ? { process: true as const } : {}"))
  check('分组器：带 process 的正文进组（不封组）', groups.includes('(entry.kind === \'text\' && entry.process === true)'))
  check('渲染：过程正文走 .entry-note（小字灰行）', render.includes("className={row.live ? 'entry-note live' : 'entry-note'}") && render.includes('data-process-note'))
  check('整轮折叠：「全部回复」档不再留下过程正文', fold.includes("keepReplies && entry.kind === 'text' && entry.process !== true"))
  check('样式：.entry-note 是小字 + 灰', /\.entry-note \{[^}]*font-size: var\(--dsc-fs-caption\)/.test(views) && /\.entry-note \{[^}]*color: var\(--dsc-text-tertiary\)/.test(views))
  // PTC 的卡内调用（2026-11-07）：事件带父指针、适配器收进父卡、卡里画嵌套行。
  const events = read('src/core/events.ts').replace(/\r\n/g, '\n')
  const contract = read('src/contract/transcript.ts').replace(/\r\n/g, '\n')
  const ptc = read('src/packages/ptc/index.ts').replace(/\r\n/g, '\n')
  const toolRow = read('src/packages/ui-transcript/ui/rows/tool-row.tsx').replace(/\r\n/g, '\n')
  // 对话页真的那张卡是 Factory 里的 ToolCard；rows/tool-row 只是没注册 Factory 时的兜底。
  // 实拍查出来的：第一版把嵌套行只加在兜底上，桌面里根本看不见（2026-11-07 真机跑出来的）。
  const toolCard = read('src/packages/ui-transcript/ui/tool-card/factory.tsx').replace(/\r\n/g, '\n')
  check('事件：tool/call 带 parentCallId', /type: 'tool\/call'; callId: string; name: string; args: string; parentCallId\?: string/.test(events))
  check('契约：工具卡带 subCalls', /subCalls\?: ToolCallView\[\]/.test(contract))
  check('PTC：子调用事件带上父指针', /parentCallId === undefined \? \{\} : \{ parentCallId \}/.test(ptc))
  check('PTC：run_code 把 runCtx.callId 交给脚本', ptc.includes('}, runCtx.callId)'))
  check('适配器：子调用挂进父卡（不 push 顶层条目）', /subCalls = \[\.\.\.\(parent\.call\.subCalls \?\? \[\]\), call\]/.test(adapter))
  check('工具卡：渲染卡内调用列表（对话页那张）', toolCard.includes('className="sub-calls"') && toolCard.includes("transcript.tool.subCallCount"))
  check('工具卡：兜底那条用同一份标记与清单（两处不许各画一遍）', toolRow.includes('<SubCallCount call={call} />') && toolRow.includes('<SubCallList call={call} />'))
  check('样式：卡内调用行有 .sub-call', /\.sub-call \{/.test(views))
}
console.log('[8] PTC 的卡内调用：子调用收进父卡、组头按子调用的类别数')
{
  const { Transcript } = await import(new URL('../src/adapter/transcript.ts', import.meta.url).href)
  const t = new Transcript()
  t.reduce({ type: 'user', text: '跑一下' })
  t.reduce({
    type: 'message',
    text: '先跑一段脚本：',
    reasoning: '想一下',
    toolCalls: [{ id: 'root', name: 'run_code', arguments: '{}' }],
  })
  t.reduce({ type: 'tool/call', callId: 'root', name: 'run_code', args: '{"code":"..."}' })
  t.reduce({ type: 'tool/call', callId: 'c1', name: 'grep', args: '{"pattern":"x"}', parentCallId: 'root' })
  t.reduce({ type: 'tool/call', callId: 'c2', name: 'bash', args: '{"command":"ls"}', parentCallId: 'root' })
  t.reduce({ type: 'tool/result', callId: 'c1', text: 'ok' })
  t.reduce({ type: 'tool/call', callId: 'orphan', name: 'read', args: '{"path":"a"}', parentCallId: 'nope' })
  t.reduce({ type: 'tool/result', callId: 'root', text: 'done' })
  const roots = t.entries.filter((item) => item.kind === 'tool')
  const root = roots.find((item) => item.call.callId === 'root')
  check('子调用不各自成为顶层行（父卡之外只有那条父卡与孤儿）', roots.length === 2, JSON.stringify(roots.map((r) => r.call.name)))
  check('父卡里收着两次子调用', root?.call.subCalls?.length === 2, JSON.stringify(root?.call.subCalls?.map((s) => s.name)))
  check('子调用的结果改的是父卡里那一格', root?.call.subCalls?.[0]?.status === 'done' && root?.call.subCalls?.[0]?.resultText === 'ok', JSON.stringify(root?.call.subCalls?.[0]))
  check('父卡自己的状态照常结算', root?.call.status === 'done', String(root?.call.status))
  check('父卡找不到时退回一条普通工具行（不吞调用）', roots.some((r) => r.call.callId === 'orphan' && r.call.status === 'done') === false && roots.some((r) => r.call.callId === 'orphan'))
  check('同一步的正文仍被标成过程正文', t.entries.some((item) => item.kind === 'text' && item.process === true))

  // 组头计数：子调用按自己的类别算（dsh 的 process-activity 口径）
  const entries = [
    entry('user', { text: '跑一下' }),
    entry('tool', {
      call: {
        callId: 'root',
        name: 'run_code',
        argsText: '{}',
        status: 'done',
        subCalls: [
          { callId: 'c1', name: 'grep', argsText: '{"pattern":"x"}', status: 'done' },
          { callId: 'c2', name: 'bash', argsText: '{"command":"ls"}', status: 'failed' },
        ],
      },
    }),
  ]
  const grouped = groupSteps(entries, [{ index: 0, startIndex: 0, endIndex: 1, startTs: 1, endTs: 9, answered: true }], () => false)
  const counts = Object.fromEntries((grouped.groups[0]?.counts ?? []).map((item) => [item.kind, item.count]))
  check('组头计数：父卡算「代码」一次', counts.code === 1, JSON.stringify(counts))
  check('组头计数：子调用各按自己类别', counts.search === 1 && counts.commands === 1, JSON.stringify(counts))
  check('失败数把子调用算进去', grouped.groups[0]?.failures === 1, String(grouped.groups[0]?.failures))

  // 实时详情：脚本里正在跑的那次子调用就是组头要报的「现在在干什么」
  const liveEntries = [
    entry('user', { text: '跑一下' }),
    entry('thinking', { text: '写一段脚本批量查。' }),
    entry('tool', {
      call: {
        callId: 'root',
        name: 'run_code',
        argsText: '{}',
        status: 'running',
        subCalls: [{ callId: 'c1', name: 'read', argsText: '{"file_path":"a.ts"}', status: 'running' }],
      },
    }),
  ]
  const live = groupSteps(liveEntries, [{ index: 0, startIndex: 0, endIndex: 2, startTs: 1, endTs: null, answered: true }], () => true)
  check('实时类别取正在跑的子调用（读文件）', live.groups[0]?.running === 'read', String(live.groups[0]?.running))
  check('实时详情取子调用的参数', live.groups[0]?.runningDetail === 'a.ts', String(live.groups[0]?.runningDetail))
}
console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
if (failures !== 0) process.exitCode = 1
