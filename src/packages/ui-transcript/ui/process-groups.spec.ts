/**
 * 阶段分组与座位排布的纯函数层（ui 层）。
 *
 * 来源：
 * - `scripts/ui-transcript-render-test.mjs` 第 [1] 段（0.6.67 报障「组员被渲染两次」的不变量）、
 *   第 [7]④ 段（新分轮产物喂进 seatPlan 的回归闸）、第 [8] 段的失败数口径；
 * - `scripts/ui-step-group-live-test.mjs` 第 [1]–[4] 段（跑动中 / 已定稿两态）、第 [6] 段
 *   （过程正文不封组）、第 [8] 段后半（组头按 PTC 子调用的类别计数）。
 *
 * 为什么是行为测试而不是文本钉：`process-groups.ts` 只 import 取词器与字典（零 React），
 * `groupSteps` / `seatPlan` / `stepGroupTitle` 的真跑结果就是被测行为。原探针里钉渲染体
 * 接线（`step-group-row.tsx`、`render.tsx` 的取法文本）的断言不迁——改个引号就假红，
 * 那条路要真渲染组件（见交付报告的缺口清单，归组件渲染批）。
 *
 * 组头文案的拼法在 spec 里照 `step-group-row.tsx` 转录成 `headerText` 辅助：closed 走聚合、
 * 未闭走实时类别 + 档位允许的详情。它转录的是「取法」而非源码文本——分组器改了行为、
 * 这里的两档文案断言照样会红。
 *
 * @module dsc-ui-transcript/ui/process-groups.spec
 */
import { describe, expect, test } from 'vitest'
import type { TranscriptEntry } from '@dsc/ui'
import type { RoundInfo } from './timing.js'
import type { StepGroup } from './process-groups.js'
import { splitRounds } from './rounds.js'
import {
  groupSteps,
  joinLiveDetail,
  liveTitleOf,
  liveToolDetail,
  preparingToolDetail,
  seatPlan,
  STEP_TITLE_SEPARATOR,
  stepGroupTitle,
} from './process-groups.js'

/** 造一条条目（探针只喂分组用得着的字段，其余成员由各 kind 分支自己补）。 */
let seq = 0
const entry = (kind: TranscriptEntry['kind'], extra: object = {}): TranscriptEntry =>
  ({ kind, id: (seq += 1), ...extra }) as TranscriptEntry

/** 造一次工具调用（callId 递增，名字 / 状态 / 参数由用例挑）。 */
const tool = (name: string, status: string, args: Record<string, string> = {}): TranscriptEntry =>
  entry('tool', { call: { callId: `c${String(seq)}`, name, argsText: JSON.stringify(args), status } })

/** 造一轮：下标闭区间 [startIndex, endIndex]，默认已作答。 */
const round = (index: number, startIndex: number, endIndex: number, endTs: number | null = 2): RoundInfo =>
  ({ index, startIndex, endIndex, startTs: 1, endTs, answered: true })

/** 把 seatPlan 的产物摊平成「每条行出现的下标序列」（组按 members 展开）。 */
const flatten = (items: ReturnType<typeof seatPlan>): number[] =>
  items.flatMap((item) => (item.kind === 'group' ? [...item.members] : [item.at]))

// ── seatPlan：每条行恰好出现一次（0.6.67「组员被渲染两次」的不变量） ─────────────

describe('seatPlan：每条行恰好出现一次', () => {
  // 一轮：[user, thinking, tool, text, thinking, tool]。定稿正文是唯一的组边界，
  // 所以切成两个各装「一条思考 + 一次调用」的组，外加一条独立的正文档位。
  const entries = [
    entry('user', { text: '题面' }),
    entry('thinking', { text: '想一' }),
    tool('read', 'done'),
    entry('text', { text: '第一段答' }),
    entry('thinking', { text: '想二' }),
    tool('write', 'done'),
  ]
  const rounds = [round(0, 0, 5)]
  const grouping = groupSteps(entries, rounds, () => false)

  test('分组器切出两个组', () => {
    expect(grouping.groups).toHaveLength(2)
  })

  test('每组装着思考与工具两条', () => {
    expect(grouping.groups.every((group) => group.size === 2 && group.members.length === 2)).toBe(true)
  })

  test('思考行也在组里（不再是组外的独立行）', () => {
    expect(grouping.at.has(1)).toBe(true)
    expect(grouping.at.has(4)).toBe(true)
  })

  test('每条行恰好出现一次、顺序即出现顺序', () => {
    const ats = [1, 2, 3, 4, 5]
    const seen = flatten(seatPlan(ats, grouping))
    expect(seen).toEqual(ats)
  })

  test('两个组块 + 一条单独行（正文），单独成行的是正文', () => {
    const items = seatPlan([1, 2, 3, 4, 5], grouping)
    const groups = items.filter((item) => item.kind === 'group')
    const rows = items.filter((item) => item.kind === 'row')
    expect(groups).toHaveLength(2)
    expect(rows).toHaveLength(1)
    expect(rows.every((item) => item.kind === 'row' && item.at === 3)).toBe(true)
  })

  test('组员绝不出现在 row 项里（组体铺过就不再单独铺）', () => {
    const items = seatPlan([1, 2, 3, 4, 5], grouping)
    expect(items.filter((item) => item.kind === 'row').every((item) => item.kind !== 'row' || !grouping.at.has(item.at))).toBe(true)
  })

  test('组块带全成员（升序）', () => {
    const items = seatPlan([1, 2, 3, 4, 5], grouping)
    expect(
      items
        .filter((item) => item.kind === 'group')
        .every((item) => item.kind === 'group' && JSON.stringify(item.members) === JSON.stringify([...item.members].sort((a, b) => a - b))),
    ).toBe(true)
  })

  test('空表进空表出', () => {
    expect(seatPlan([], grouping)).toHaveLength(0)
  })

  test('没有分组的轮（detailed 档的运行中轮）全出 row 项', () => {
    const running = groupSteps(entries, rounds, () => true, true)
    expect(running.groups).toHaveLength(0)
    expect(seatPlan([1, 2, 3, 4, 5], running).every((item) => item.kind === 'row')).toBe(true)
  })
})

describe('组边界', () => {
  test('一条思考 + 一次调用就是一个组（不再拆散）', () => {
    // 2026-11-07 撤掉「一条不成组」的放平：想一句、调一次就是一个完整阶段，
    // 放平会把这层结构摊回平铺——那正是用户报障时看到的画面。
    const single = groupSteps(
      [entry('user', { text: '题面' }), entry('thinking', { text: '想' }), tool('read', 'done')],
      [round(0, 0, 2)],
      () => false,
    )
    expect(single.groups).toHaveLength(1)
    expect(single.groups[0]?.members.join(',')).toBe('1,2')
  })

  test('system 不进组，且把前后的工具切成两组', () => {
    // system 自己不进组，也不许被组员区间连带收进去（那是「错误提示被折叠」的来源）。
    const withSystem = groupSteps(
      [
        entry('user', { text: '题面' }),
        tool('read', 'done'),
        entry('system', { text: '出错了' }),
        tool('read', 'done'),
      ],
      [round(0, 0, 3)],
      () => false,
    )
    expect(withSystem.groups).toHaveLength(2)
    expect(withSystem.groups.every((group) => group.members.length === 1)).toBe(true)
    const systemSeat = seatPlan([1, 2, 3], withSystem)
    expect(systemSeat.some((item) => item.kind === 'row' && item.at === 2)).toBe(true)
  })
})

// ── 跑动中 / 已定稿两态（2026-11-06 报障的缺陷二） ─────────────────────────────

describe('跑动中的尾组', () => {
  // 样张：还在跑的一轮（两条工具，最后那条 bash 正在跑）。
  const runningEntries = [
    entry('user', { text: '跑一下构建' }),
    entry('thinking', { text: '先读一眼配置。' }),
    tool('read', 'done', { path: 'package.json' }),
    tool('bash', 'running', { command: 'pnpm build' }),
  ]
  const running = groupSteps(runningEntries, [round(0, 0, 3, null)], () => true)
  const group = running.groups[0] as StepGroup

  test('跑动中的尾组成组（不再是 pending = [] 丢掉）', () => {
    expect(running.groups).toHaveLength(1)
  })

  test('这一组 closed = false，组里收着思考 + 两条工具', () => {
    expect(group.closed).toBe(false)
    expect(group.size).toBe(3)
  })

  test('成员按出现顺序：思考在前、工具在后', () => {
    expect(group.members.join(',')).toBe('1,2,3')
  })

  test('类别计数只数工具（思考不占类别）', () => {
    expect(group.counts.reduce((sum, item) => sum + item.count, 0)).toBe(2)
  })

  test('实时类别与详情 = 最后那条运行中的命令', () => {
    expect(group.running).toBe('commands')
    expect(group.runningDetail).toBe('pnpm build')
  })
})

describe('组头两档文案（照 step-group-row 的取法转录）', () => {
  /**
   * 组头此刻的「一行字」：完全照 `step-group-row.tsx` 的取法——
   * 已结束按类别聚合，未结束按此刻在跑的那一类 + 档位允许的实时详情。
   */
  const headerText = (group: StepGroup, liveDetail: boolean): string => {
    const closed = group.closed
    const live = liveTitleOf(group)
    const activity = closed ? group.counts[0]?.kind ?? 'thinking' : live.activity
    const label = stepGroupTitle(group.counts, closed, activity === 'thinking' ? undefined : activity, live.preparing)
    return joinLiveDetail(label, closed || !liveDetail ? '' : live.detail)
  }

  const runningEntries = [
    entry('user', { text: '跑一下构建' }),
    entry('thinking', { text: '先读一眼配置。' }),
    tool('read', 'done', { path: 'package.json' }),
    tool('bash', 'running', { command: 'pnpm build' }),
  ]
  const running = groupSteps(runningEntries, [round(0, 0, 3, null)], () => true)
  const runningGroup = running.groups[0] as StepGroup

  // 同一份内容，这一轮已定稿。
  const settledEntries = runningEntries.map((item, at): TranscriptEntry => {
    if (at !== 3 || item.kind !== 'tool') return item
    return { ...item, call: { ...item.call, status: 'done', resultText: 'build ok' } }
  })
  const settled = groupSteps(settledEntries, [round(0, 0, 3, 9)], () => false)
  const settledGroup = settled.groups[0] as StepGroup

  test('跑动中：标准档组头带实时详情，紧凑档只有类别，两档不同', () => {
    const standard = headerText(runningGroup, true)
    const compact = headerText(runningGroup, false)
    expect(standard).toContain('pnpm build')
    expect(standard).toContain('正在运行命令')
    expect(compact).toBe('正在运行命令')
    expect(standard).not.toBe(compact)
  })

  test('定稿：closed = true，不带实时类别与详情，两档完全相同', () => {
    expect(settledGroup.closed).toBe(true)
    expect(settledGroup.running).toBeUndefined()
    expect(settledGroup.runningDetail).toBeUndefined()
    const standard = headerText(settledGroup, true)
    const compact = headerText(settledGroup, false)
    expect(standard).toBe(compact)
    expect(standard).not.toContain('正在')
    // 聚合文案与 stepGroupTitle 的旧口径一致。
    expect(standard).toBe(stepGroupTitle(settledGroup.counts, true))
  })
})

describe('一条也成组（2026-11-10 对齐 dsh：首条过程节点就建组）', () => {
  test('单条运行中的工具也成组，组头画在它自己身上', () => {
    const grouping = groupSteps(
      [entry('user', { text: '读一眼' }), tool('read', 'running', { path: 'a.ts' })],
      [round(0, 0, 1, null)],
      () => true,
    )
    expect(grouping.groups).toHaveLength(1)
    expect(grouping.groups[0]?.members.join(',')).toBe('1')
    expect(grouping.headAt.has(1)).toBe(true)
    expect(grouping.at.get(1)).toBeDefined()
  })

  test('思考 + 调用两条就成组，组头画在第一条（思考行）上', () => {
    const grouped = groupSteps(
      [
        entry('user', { text: '跑一下' }),
        entry('thinking', { text: '先看看。' }),
        tool('bash', 'running', { command: 'pnpm build' }),
      ],
      [round(0, 0, 2, null)],
      () => true,
    )
    expect(grouped.groups).toHaveLength(1)
    expect(grouped.groups[0]?.size).toBe(2)
    expect(grouped.headAt.has(1)).toBe(true)
    expect(grouped.headAt.has(2)).toBe(false)
  })
})

// ── 过程正文：调工具之前那句前言不封组（2026-11-07 报障） ───────────────────────

describe('过程正文（entry.process）', () => {
  test('整段过程收成一组：思考 + 前言 + 工具，真正文留在组外', () => {
    // 模型在同一步里「说一句 + 调工具」：这句正文带 process 标记（adapter 在 tool/call 时补上）。
    const grouping = groupSteps(
      [
        entry('user', { text: '装一下' }),
        entry('thinking', { text: '先看现场。' }),
        entry('text', { text: '安装完成，启动做最后验证：', process: true }),
        tool('bash', 'done', { command: 'node app.js' }),
        entry('text', { text: '这次真的好了。' }),
      ],
      [round(0, 0, 4, 9)],
      () => false,
    )
    const group = grouping.groups[0] as StepGroup
    expect(grouping.groups).toHaveLength(1)
    expect(group.size).toBe(3)
    expect(group.members.join(',')).toBe('1,2,3')
    expect(grouping.at.has(4)).toBe(false)
    expect(grouping.headAt.has(4)).toBe(false)
    // 类别只数工具（前言不是一次调用）。
    expect(group.counts.reduce((sum, item) => sum + item.count, 0)).toBe(1)
  })

  test('不带标记的正文照旧封组（只说话、没动手的那一步不并进上一组）', () => {
    const split = groupSteps(
      [
        entry('user', { text: '说说看' }),
        entry('thinking', { text: '想想。' }),
        tool('read', 'done', { path: 'a.ts' }),
        entry('text', { text: '看完了，结论是……' }),
      ],
      [round(0, 0, 3, 9)],
      () => false,
    )
    expect(split.groups).toHaveLength(1)
    expect(split.groups[0]?.members.join(',')).toBe('1,2')
  })

  test('排布不变量照旧：每条行恰好出一次，组头只出在第一条上', () => {
    const grouping = groupSteps(
      [
        entry('user', { text: '装一下' }),
        entry('thinking', { text: '先看现场。' }),
        entry('text', { text: '安装完成，启动做最后验证：', process: true }),
        tool('bash', 'done', { command: 'node app.js' }),
        entry('text', { text: '这次真的好了。' }),
      ],
      [round(0, 0, 4, 9)],
      () => false,
    )
    const plan = seatPlan([1, 2, 3, 4], grouping)
    expect(flatten(plan).join(',')).toBe('1,2,3,4')
    expect(plan.filter((item) => item.kind === 'group')).toHaveLength(1)
    expect(plan.filter((item) => item.kind === 'group').every((item) => item.kind === 'group' && item.group.members[0] === 1)).toBe(true)
  })
})

// ── 失败数口径（对照 codex 的活动流：不点开也能读到结果） ──────────────────────

describe('组头失败数', () => {
  test('只算 failed（rejected 是用户拒绝，不是跑挂）', () => {
    const grouping = groupSteps(
      [
        entry('user', { text: '题面' }),
        entry('thinking', { text: '想' }),
        tool('bash', 'failed'),
        tool('read', 'done'),
        tool('bash', 'rejected'),
        entry('text', { text: '答完' }),
      ],
      [round(0, 0, 5, 9)],
      () => false,
    )
    expect(grouping.groups[0]?.failures).toBe(1)
  })
})

// ── PTC 的卡内调用：组头按子调用的类别数（dsh 的 process-activity 口径） ────────

describe('组头计数与实时详情（PTC 子调用）', () => {
  test('父卡算「代码」一次，子调用各按自己类别，失败数把子调用算进去', () => {
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
    const grouping = groupSteps(entries, [round(0, 0, 1, 9)], () => false)
    const counts = Object.fromEntries((grouping.groups[0]?.counts ?? []).map((item) => [item.kind, item.count]))
    expect(counts.code).toBe(1)
    expect(counts.search).toBe(1)
    expect(counts.commands).toBe(1)
    expect(grouping.groups[0]?.failures).toBe(1)
  })

  test('实时类别与详情取正在跑的那次子调用', () => {
    const entries = [
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
    const live = groupSteps(entries, [round(0, 0, 2, null)], () => true)
    expect(live.groups[0]?.running).toBe('read')
    expect(live.groups[0]?.runningDetail).toBe('a.ts')
  })
})

// ── 回归闸：新分轮产物喂进 seatPlan 后不变量仍成立 ─────────────────────────────

describe('seatPlan 对新分轮产物的回归闸', () => {
  test('steering + internal 的分轮产物喂进 seatPlan 后每条行仍恰好一次', () => {
    // 宿主 subagent 插件造出来的队友汇报正文形状（steering + internal 的插话）。
    // 完整链路照渲染层走：splitRounds 切轮 → groupSteps 吃它的轮划分 → seatPlan 排布。
    const teammateBody =
      '<teammate-report from="mate-1" role="coder" state="已完成">\n派给它的任务：改个 bug\n它的汇报：\n搞定了\n</teammate-report>'
    const midSteer = [
      entry('user', { text: 'A', ts: 1 }),
      entry('text', { text: 'r1', ts: 2 }),
      entry('user', { text: teammateBody, steering: true, internal: true, ts: 3 }),
      entry('text', { text: 'r2', ts: 4 }),
    ]
    const split = splitRounds(midSteer)
    const grouping = groupSteps(midSteer, split.rounds, () => false)
    const ats = split.seats.flatMap((seat) => seat.indices.slice(1))
    const seen = flatten(seatPlan(ats, grouping))
    expect(seen).toEqual(ats)
  })
})

// STEP_TITLE_SEPARATOR 被两档文案断言间接消费；显式引用一次，保证它是组头拼法的真分隔符。
test('组头的分隔符照 dsh 原样（类别与详情两段各带空格）', () => {
  expect(joinLiveDetail('正在运行命令', 'pnpm build')).toBe(`正在运行命令${STEP_TITLE_SEPARATOR}pnpm build`)
  expect(joinLiveDetail('正在运行命令', '')).toBe('正在运行命令')
})

// ── 直播尾补全（2026-11-18）：思考内容与准备中的半截参数 ──────────────────────

describe('没有跑着的工具时：组头摘录正在流式的思考（2026-11-18 补回）', () => {
  /** 直播尾的条目是负 id（adapter 的 liveEntries），定稿后才换成正 id。 */
  const liveThink = (text: string): TranscriptEntry => ({ kind: 'thinking', id: -(seq += 1), text })
  const headerText = (group: StepGroup, liveDetail: boolean): string => {
    const live = liveTitleOf(group)
    const label = stepGroupTitle(group.counts, group.closed, undefined, live.preparing)
    return joinLiveDetail(label, group.closed || !liveDetail ? '' : live.detail)
  }

  test('只有直播思考也成组，详情取最后一段非空思考', () => {
    const entries = [
      entry('user', { text: '看看日志' }),
      liveThink('先确认日志在哪。\n\n现在读一下最近那段崩溃记录，看是哪个依赖。'),
    ]
    const group = groupSteps(entries, [round(0, 0, 1, null)], () => true).groups[0] as StepGroup
    expect(group.running).toBeUndefined()
    expect(group.runningDetail).toBe('现在读一下最近那段崩溃记录，看是哪个依赖。')
  })

  test('标准档组头 = 正在分析请求 · 思考内容；紧凑档不带详情', () => {
    const entries = [entry('user', { text: '看看' }), liveThink('先跑一下测试。')]
    const group = groupSteps(entries, [round(0, 0, 1, null)], () => true).groups[0] as StepGroup
    expect(headerText(group, true)).toBe(`正在分析请求${STEP_TITLE_SEPARATOR}先跑一下测试。`)
    expect(headerText(group, false)).toBe('正在分析请求')
  })

  test('最后一段是空白时取前面的段落', () => {
    const entries = [entry('user', { text: '看看' }), liveThink('先用 grep 找入口。\n\n   \n')]
    const group = groupSteps(entries, [round(0, 0, 1, null)], () => true).groups[0] as StepGroup
    expect(group.runningDetail).toBe('先用 grep 找入口。')
  })

  test('定稿的思考不摘进组头详情（dsh 也只认运行中的助手步）', () => {
    const entries = [entry('user', { text: '看看' }), entry('thinking', { text: '这条已经想完了。' })]
    const group = groupSteps(entries, [round(0, 0, 1)], () => false).groups[0] as StepGroup
    expect(group.runningDetail).toBeUndefined()
  })

  test('多条思考里取最近那条直播的', () => {
    const entries = [
      entry('user', { text: '看看' }),
      entry('thinking', { text: '上一段已经想完。' }),
      liveThink('当前这段：先跑一下测试。'),
    ]
    const group = groupSteps(entries, [round(0, 0, 2, null)], () => true).groups[0] as StepGroup
    expect(group.runningDetail).toBe('当前这段：先跑一下测试。')
  })
})

describe('准备中：组头从半截 JSON 里读参数前缀（2026-11-18 新增）', () => {
  test('半截命令：值未闭合也能读', () => {
    expect(preparingToolDetail('{"command":"pnpm bu')).toBe('pnpm bu')
  })

  test('半截命令：值已闭合、后面的键还在流', () => {
    expect(preparingToolDetail('{"command":"pnpm build","timeout":')).toBe('pnpm build')
  })

  test('转义换行折成空格；转义写一半就停住（不猜）', () => {
    expect(preparingToolDetail('{"command":"echo a\\nb"}')).toBe('echo a b')
    expect(preparingToolDetail('{"command":"echo \\')).toBe('echo')
  })

  test('一个可读字段都没有时不给假详情', () => {
    expect(preparingToolDetail('{"timeout":30')).toBe('')
    expect(preparingToolDetail('')).toBe('')
  })

  test('参数已到齐时与派发后的取法一致', () => {
    expect(preparingToolDetail('{"file_path":"a.ts"}')).toBe('a.ts')
  })

  test('嵌套对象里的同名字段不算顶层字段', () => {
    expect(preparingToolDetail('{"options":{"command":"nested"},"timeout":')).toBe('')
  })

  test('值里出现的「"command":」字样不算键', () => {
    expect(preparingToolDetail('{"description":"say \\"command\\": \\"evil\\"","timeout":')).toBe('say "command": "evil"')
  })

  test('重复键取最后一个（与 JSON.parse 一致）', () => {
    expect(preparingToolDetail('{"command":"old","command":"new"}')).toBe('new')
  })

  test('半个代理项被裁掉，完整的代理对原样保留', () => {
    expect(preparingToolDetail('{"command":"x\\ud83d')).toBe('x')
    expect(preparingToolDetail('{"command":"x\\ud83d\\ude00"}')).toBe('x😀')
  })

  test('派发之后半截 JSON 仍退回工具名（老口径不变）', () => {
    expect(liveToolDetail('bash', '{"command":"pnpm bu')).toBe('bash')
  })

  test('组头：准备中的详情来自 argsPreview', () => {
    const entries: TranscriptEntry[] = [
      entry('user', { text: '跑一下' }),
      entry('tool', {
        id: -(seq += 1),
        call: { callId: '', name: 'bash', argsText: '', argsPreview: '{"command":"pnpm bu', status: 'preparing' },
      }),
    ]
    const group = groupSteps(entries, [round(0, 0, 1, null)], () => true).groups[0] as StepGroup
    expect(group.running).toBe('commands')
    expect(group.preparing).toBe(true)
    expect(group.runningDetail).toBe('pnpm bu')
    expect(stepGroupTitle(group.counts, false, 'commands', true)).toContain('准备运行命令')
  })

  test('通用类别：还没参数时退回工具名，参数到了就用参数', () => {
    const make = (argsPreview: string): TranscriptEntry[] => [
      entry('user', { text: '试试' }),
      entry('tool', {
        id: -(seq += 1),
        call: { callId: '', name: 'some_tool', argsText: '', argsPreview, status: 'preparing' },
      }),
    ]
    const empty = groupSteps(make(''), [round(0, 0, 1, null)], () => true).groups[0] as StepGroup
    const filled = groupSteps(make('{"title":"核对入口"'), [round(0, 0, 1, null)], () => true).groups[0] as StepGroup
    expect(empty.runningDetail).toBe('some_tool')
    expect(filled.runningDetail).toBe('核对入口')
  })
})
