/**
 * TUI 底部状态栏的帧断言（迁自 `scripts/statusbar-test.mjs`）。
 *
 * ## 为什么这一层要单独测
 *
 * 状态栏是「一眼读数」的地方：段的显隐、分隔符、数据缺席时整段消失、窄终端按优先级丢段。
 * 这些都不是纯函数能验的——要真渲一帧、剥掉 ANSI 再读文本。
 *
 * 覆盖四组：
 *
 *   ① 出厂默认只画出厂开的段（model / cache / cost / policy / ctx / cwd）· ` · ` 分隔 ·
 *      审阅者是本人时权限段不带复核后缀；
 *   ② 开关全开 / 单独关掉；
 *   ③ 数据缺席整段缺席（usage=null / cost 与 cwd 为 undefined）；
 *   ④ 窄终端按优先级整段丢弃，状态点与模型永不丢；外加子代理芯片（含同排两枚的点击命中
 *      几何）与排队条数。
 *
 * ## 跑法
 *
 * ink 在 node 里渲，靠假 stdout（PassThrough）拿帧。帧取「最后一次清行之后」那一段再剥
 * ANSI——这版 ink 没有 `lastFrame`，固定 sleep 在慢机器上会读到半帧，所以等输出长度连续
 * 几拍不变再收。
 *
 * 归 `tui` project（`src/packages/tui/**` + node 环境 + 假 stdout）。props 全部手工给：
 * `RuntimeSurfaces` 只填状态栏真正读到的几个分区，其余按「整套插件没装」省略——这在本
 * 文件里是刻意的，状态栏对缺省分区的读法就是这条要验的降级面。
 *
 * @module dsc/packages/tui/app/status-bar.spec
 */
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { afterAll, describe, expect, test } from 'vitest'
import type {
  RuntimeSnapshot,
  RuntimeSurfaces,
  StatusBarPrefsView,
  StatusView,
} from '@pneuma/runtime/contract.js'
import { DEFAULT_STATUS_BAR_PREFS } from '@pneuma/runtime/contract.js'
import { StatusBar, shortId } from './StatusBar.js'
import { absoluteTop, measuredSpan, type ClickEntry, type RegisterClick } from './click.js'

/** 会话路径：会话段的短 id 从这里取。 */
const SESSION_ID = '/w/ab12cd34-5678.jsonl'

/** StatusView 手工底座：contextWindow 1M、ctx 1.2%、五段分段、DeepSeek 价目下的费用。 */
const STATUS: StatusView = {
  turnState: 'idle',
  model: 'deepseek-v3.2',
  effort: 'default',
  usage: { inputTokens: 9500, outputTokens: 1200, cacheHitTokens: 8000, cacheMissTokens: 1500 },
  contextWindow: 1_000_000,
  contextUsed: 12_000,
  contextSegments: { system: 3000, prompt: 2000, assistant: 4000, thinking: 1000, tools: 2000 },
  progress: { turns: 0, steps: 0 },
  cost: { total: 0.04, peakNow: true },
  sessionId: SESSION_ID,
  cwd: 'D:\\dsc\\src',
}

/**
 * 状态栏真正读到的分区。`RuntimeSurfaces` 的其余分区（git / 预设 / 后台作业…）状态栏
 * 不读，这里按「插件没装」的形态省略，用一次显式断言类型转换收口。
 */
const SURFACES = {
  pendingApproval: null,
  pendingQuestion: null,
  pendingPlan: null,
  goal: null,
  todos: { total: 0, done: 0, active: null },
  mode: { options: [{ id: 'build', label: '执行', hint: '' }], current: 'build' },
  // 0.6.68 起权限投影多一根正交轴：reviewer（「要问的事」先给谁看）+ reviewerOptions。
  // 状态栏读 surfaces.policy.reviewer 决定要不要在权限段后面缀「·AI 复核」。
  policy: {
    options: [{ id: 'auto-edit', label: '自动编辑', hint: '' }],
    current: 'auto-edit',
    reviewer: 'user',
    reviewerOptions: [
      { id: 'user', label: '本人审阅', hint: '' },
      { id: 'auto-review', label: 'AI 复核', hint: '' },
    ],
  },
} as unknown as RuntimeSurfaces

/** 假 stdout：`useStdout()` 读的就是这份的 columns。 */
const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean }
stdout.columns = 110
stdout.rows = 10
stdout.isTTY = false
/** 累计输出（每次 renderBar 清空）。 */
let output = ''
stdout.on('data', (chunk: Buffer) => {
  output += String(chunk)
})

/** 当前渲染实例（下一次 renderBar 先卸掉它）。 */
let instance: ReturnType<typeof render> | null = null

/** 剥掉 ANSI 与光标控制序列。 */
function clean(frame: string): string {
  return frame.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
}

/** 等这一帧写完：输出长度连续几拍不再变（最少等 120ms，慢一点也够 ink 出一帧）。 */
async function settleFrame(): Promise<void> {
  const startedAt = Date.now()
  const deadline = startedAt + 2_000
  let previous = -1
  let stable = 0
  while (Date.now() < deadline) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
    if (output.length === previous) stable += 1
    else {
      stable = 0
      previous = output.length
    }
    if (Date.now() - startedAt >= 120 && stable >= 3) return
  }
}

/** renderBar 的参数。 */
interface RenderBarOptions {
  columns?: number
  config?: StatusBarPrefsView
  status?: StatusView
  surfaces?: RuntimeSurfaces
  subagents?: RuntimeSnapshot['subagents']
  queued?: number
  registerClick?: RegisterClick
  onOpenAgent?: (sessionPath: string) => void
}

/** 渲一帧 StatusBar：columns 决定丢段预算，config 决定段显隐。 */
async function renderBar(options: RenderBarOptions = {}): Promise<string> {
  const {
    columns = 110,
    config = DEFAULT_STATUS_BAR_PREFS,
    status = STATUS,
    surfaces = SURFACES,
    subagents = [],
    queued = 0,
    registerClick,
    onOpenAgent,
  } = options
  instance?.unmount()
  output = ''
  stdout.columns = columns
  instance = render(
    createElement(StatusBar, { status, surfaces, subagents, queued, config, registerClick, onOpenAgent }),
    // useStdout 读的就是这份 stdout 的 columns——必须传外面这份（列宽在这儿改）。
    { stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
  )
  await settleFrame()
  const at = output.lastIndexOf('\x1b[2K')
  return clean(at >= 0 ? output.slice(at) : output)
}

afterAll(() => {
  instance?.unmount()
})

/** 全开那一组开关（出厂关的四段也打开）。 */
const ALL_ON: StatusBarPrefsView = {
  ...DEFAULT_STATUS_BAR_PREFS,
  effort: true,
  tokens: true,
  mode: true,
  session: true,
}

describe('① 宽终端 + 出厂默认：开的段在，关的段不在', () => {
  test('状态点与状态词在', async () => {
    expect(await renderBar()).toContain('● 空闲')
  })

  test('模型段在（出厂开）', async () => {
    expect(await renderBar()).toContain('deepseek-v3.2')
  })

  test('缓存段在（出厂开）', async () => {
    expect(await renderBar()).toContain('缓存84%')
  })

  test('费用段在（出厂开）', async () => {
    expect(await renderBar()).toContain('≈¥0.04 峰')
  })

  test('权限段在（出厂开）', async () => {
    expect(await renderBar()).toContain('权限 自动编辑')
  })

  test('ctx 段在（出厂开）', async () => {
    expect(await renderBar()).toContain('ctx 1.2%')
  })

  test('cwd 段在（出厂开）', async () => {
    expect(await renderBar()).toContain('dsc/src')
  })

  test('effort 段出厂关', async () => {
    expect(await renderBar()).not.toContain('effort')
  })

  test('tok 段出厂关', async () => {
    expect(await renderBar()).not.toContain('tok 9.5k')
  })

  test('模式段出厂关', async () => {
    expect(await renderBar()).not.toContain('模式 执行')
  })

  test('会话段出厂关', async () => {
    expect(await renderBar()).not.toContain('会话 ab12cd34')
  })

  test('段间 · 分隔', async () => {
    expect(await renderBar()).toContain(' · ')
  })

  test('审阅者是本人时权限段不带复核后缀', async () => {
    expect(await renderBar()).not.toContain('AI 复核')
  })
})

describe('①b 审阅者那根轴（0.6.68）', () => {
  /** 换一个审阅者（其余分区不动）：状态栏只读 policy.reviewer。 */
  function surfacesWithReviewer(reviewer: 'user' | 'auto-review'): RuntimeSurfaces {
    return {
      ...(SURFACES as unknown as Record<string, unknown>),
      policy: { ...SURFACES.policy, reviewer },
    } as unknown as RuntimeSurfaces
  }

  test('auto-review 时权限段缀「·AI 复核」', async () => {
    expect(await renderBar({ surfaces: surfacesWithReviewer('auto-review') })).toContain('权限 自动编辑·AI 复核')
  })

  test('auto-review 时其余段照旧', async () => {
    const frame = await renderBar({ surfaces: surfacesWithReviewer('auto-review') })
    expect(frame).toContain('● 空闲')
    expect(frame).toContain('deepseek-v3.2')
  })
})

describe('② 开关全开：四段出厂关的全部出现', () => {
  test('effort 段打开后出现', async () => {
    expect(await renderBar({ columns: 160, config: ALL_ON })).toContain('effort default')
  })

  test('tok 段打开后出现', async () => {
    expect(await renderBar({ columns: 160, config: ALL_ON })).toContain('tok 9.5k↑ 1.2k↓')
  })

  test('模式段打开后出现', async () => {
    expect(await renderBar({ columns: 160, config: ALL_ON })).toContain('模式 执行')
  })

  test('会话段打开后出现', async () => {
    expect(await renderBar({ columns: 160, config: ALL_ON })).toContain(`会话 ${shortId(SESSION_ID)}`)
  })
})

describe('③ 开关关掉：出厂开的段也能关掉', () => {
  test('费用段关掉整段缺席', async () => {
    expect(await renderBar({ config: { ...DEFAULT_STATUS_BAR_PREFS, cost: false, cwd: false } })).not.toContain('≈¥')
  })

  test('cwd 段关掉整段缺席', async () => {
    expect(await renderBar({ config: { ...DEFAULT_STATUS_BAR_PREFS, cost: false, cwd: false } })).not.toContain('dsc/src')
  })

  test('其余段不受影响', async () => {
    const frame = await renderBar({ config: { ...DEFAULT_STATUS_BAR_PREFS, cost: false, cwd: false } })
    expect(frame).toContain('缓存84%')
    expect(frame).toContain('ctx 1.2%')
  })
})

describe('④ 数据缺席整段缺席：无 usage、无 cost、无 cwd', () => {
  /** 三样数据都缺的底座。 */
  const noData: StatusView = { ...STATUS, usage: null, cost: undefined, cwd: undefined }

  test('usage 缺时缓存段缺席', async () => {
    expect(await renderBar({ status: noData })).not.toContain('缓存')
  })

  test('usage 缺时 tok 段缺席（即便开关开着）', async () => {
    expect(await renderBar({ status: noData })).not.toContain('tok')
  })

  test('cost 缺时费用段缺席', async () => {
    expect(await renderBar({ status: noData })).not.toContain('≈¥')
  })

  test('cwd 缺时目录段缺席', async () => {
    expect(await renderBar({ status: noData })).not.toContain('dsc')
  })

  test('模型与状态点仍在', async () => {
    const frame = await renderBar({ status: noData })
    expect(frame).toContain('● 空闲')
    expect(frame).toContain('deepseek-v3.2')
  })
})

describe('⑤ 子代理芯片（0.6.65 起只收当前会话还在干活的队友）', () => {
  test('干活队友芯片渲染（◐ + 短 id）', async () => {
    expect(await renderBar({ subagents: [{ sessionPath: '/w/7b5cc3a9-1111.jsonl', state: 'working' }] })).toContain(
      '◐ 7b5cc3a9',
    )
  })

  test('待审批队友芯片渲染（⚠）', async () => {
    expect(
      await renderBar({ subagents: [{ sessionPath: '/w/7b5cc3a9-1111.jsonl', state: 'awaiting-approval' }] }),
    ).toContain('⚠ 7b5cc3a9')
  })

  test('没有干活队友就没有芯片（收工 / 切会话即消失）', async () => {
    const frame = await renderBar({ subagents: [] })
    expect(frame).not.toContain('◐')
    expect(frame).not.toContain('7b5cc3a9')
  })
})

describe('⑤b chip 点击命中几何（0.6.66）：按列区分同排多枚 chip', () => {
  /** 两枚同排 chip 的点击区（只收宽度像 chip 的那几个）。 */
  async function chipGeometry(): Promise<{
    chips: ClickEntry[]
    spans: Array<{ left: number; width: number } | null>
    tops: Array<number | null>
  }> {
    const clicks: ClickEntry[] = []
    const registerClick: RegisterClick = (entry) => {
      clicks.push(entry)
      return () => {}
    }
    await renderBar({
      columns: 160,
      subagents: [
        { sessionPath: '/w/11111111-aaaa.jsonl', state: 'working' },
        { sessionPath: '/w/22222222-bbbb.jsonl', state: 'working' },
      ],
      registerClick,
      onOpenAgent: () => {},
    })
    const chips = clicks.filter((entry) => {
      const span = measuredSpan(entry.node.current)
      const top = absoluteTop(entry.node.current)
      return span !== null && top !== null && span.width > 0 && span.width < 40
    })
    return { chips, spans: chips.map((entry) => measuredSpan(entry.node.current)), tops: chips.map((entry) => absoluteTop(entry.node.current)) }
  }

  /** 把可空几何收成数字；量不出来就让用例红（不是静默跳过）。 */
  function required(value: number | null | undefined, what: string): number {
    if (typeof value !== 'number') throw new Error(`${what} 量不出来（拿到 ${String(value)}）`)
    return value
  }

  test('两枚 chip 各登记了一个点击区', async () => {
    expect((await chipGeometry()).chips).toHaveLength(2)
  })

  test('点第二枚 chip 只命中第二枚', async () => {
    const { chips, spans, tops } = await chipGeometry()
    const col = required(spans[1]?.left, '第二枚 chip 的 left') + 1
    const row = required(tops[1], '第二枚 chip 的 top')
    const first = chips[0]
    const second = chips[1]
    if (first === undefined || second === undefined) throw new Error('只登记到一个 chip')
    expect(second.hit(col, row, row, 1)).toBe(true)
    expect(first.hit(col, row, row, 1)).toBe(false)
  })

  test('点空白列谁都不命中', async () => {
    const { chips, spans, tops } = await chipGeometry()
    if (chips.length !== 2) throw new Error(`只登记到 ${String(chips.length)} 个 chip`)
    const outside = required(spans[0]?.left, '第一枚 chip 的 left') - 2
    chips.forEach((entry, index) => {
      const top = required(tops[index], `第 ${String(index + 1)} 个 chip 的 top`)
      expect(entry.hit(outside, top, top, 1)).toBe(false)
    })
  })

  test('点第一枚 chip 命中第一枚', async () => {
    const { chips, spans, tops } = await chipGeometry()
    const top0 = required(tops[0], '第一枚 chip 的 top')
    const top1 = required(tops[1], '第二枚 chip 的 top')
    const insideFirst = required(spans[0]?.left, '第一枚 chip 的 left') + 1
    const first = chips[0]
    const second = chips[1]
    if (first === undefined || second === undefined) throw new Error('只登记到一个 chip')
    expect(first.hit(insideFirst, top0, top0, 1)).toBe(true)
    expect(second.hit(insideFirst, top1, top1, 1)).toBe(false)
  })
})

describe('⑤c 排队中的输入（0.6.67）', () => {
  test('排队段在（⌛ + 条数）', async () => {
    expect(await renderBar({ queued: 2 })).toContain('⌛ 排队 2 条')
  })

  test('没有排队输入就没有这一段', async () => {
    expect(await renderBar({ queued: 0 })).not.toContain('排队')
  })
})

describe('⑥ 窄终端丢段：tokens（优先级 0）先丢，session 次之；状态点与模型永不丢', () => {
  /** 46 列 + 全开 + 一枚干活 chip 的那一帧。 */
  async function narrowFrame(): Promise<string> {
    return renderBar({
      columns: 46,
      config: ALL_ON,
      subagents: [{ sessionPath: '/w/7b5cc3a9-1111.jsonl', state: 'working' }],
    })
  }

  test('窄终端 tokens 整段先丢', async () => {
    expect(await narrowFrame()).not.toContain('tok 9.5k')
  })

  test('窄终端 session 段被丢', async () => {
    expect(await narrowFrame()).not.toContain('会话 ab12cd34')
  })

  test('窄终端费用被丢', async () => {
    expect(await narrowFrame()).not.toContain('≈¥0.04')
  })

  test('窄终端队友芯片被丢（priority 8，先于 cwd）', async () => {
    expect(await narrowFrame()).not.toContain('7b5cc3a9')
  })

  test('窄终端状态点永不丢', async () => {
    expect(await narrowFrame()).toContain('● 空闲')
  })

  test('窄终端模型永不丢', async () => {
    expect(await narrowFrame()).toContain('deepseek-v3.2')
  })

  test('窄终端没有逐段省略号垃圾', async () => {
    expect(await narrowFrame()).not.toContain('……')
  })
})

describe('⑦ 极窄（30 列）：可丢的全丢光，只剩状态点 + 模型', () => {
  test('极窄只剩状态点与模型', async () => {
    const frame = await renderBar({ columns: 30 })
    expect(frame).toContain('● 空闲')
    expect(frame).toContain('deepseek-v3.2')
  })

  test('极窄 cwd 也被丢', async () => {
    expect(await renderBar({ columns: 30 })).not.toContain('dsc/src')
  })
})
