/**
 * 会话流的**排版契约**电池（带真彩 SGR；迁自 `scripts/tui-transcript-style-test.mjs`）：
 * 思考块怎么排、用户行怎么隔、状态栏几行，以及「行数估算 == 真实渲染」这条支撑滚动
 * 稳定性的不变量。
 *
 * ## FORCE_COLOR 必须在 import ink **之前**设
 *
 * chalk 在模块加载时探测一次色彩能力，之后不再变。本文件要在帧里读 SGR（斜体、暗淡、
 * 真彩 RGB、背景色块），必须让 ink/chalk 以「真彩终端」的形态加载。做法：模块**顶层**
 * 第一行设 `process.env.FORCE_COLOR = '3'`，随后所有牵 ink 的模块（ChatView / StatusBar /
 * TimelineRail / ink 本体）一律**动态 import**——顶层 await 保证装载顺序就是书写顺序。
 *
 * 为什么这在 Vitest 的 forks 池下依然成立：tui project 配的是 `pool: 'forks'`，每个测试
 * 文件一个独立子进程（默认 isolate）——本文件设置的环境变量不会漏进别的 spec，别的
 * spec 先加载的「无色 chalk」也不会污染本文件。若哪天改成线程池或关掉 isolate，这条
 * 前提就失效了，先改这里。
 *
 * ## 钉「估算 == 渲染」的原因
 *
 * 行滚动靠行高表，从没渲染过的条目只能估算；估算一旦与真实差得多，滚动就会「前几格
 * 不动、再滚一下弹回底部」（用户报障）。这里对每一种条目单独渲染一次，把真实行数与
 * `estimateLines` 对上——它是那条病根的回归门。
 *
 * 归 `tui` project（`src/packages/tui/**` + node + 假 stdout，直读 src，不走 lib）。
 *
 * @module dsc/packages/tui/app/chat-style.spec
 */
process.env.FORCE_COLOR = '3'

import { PassThrough } from 'node:stream'
import { createElement, useState } from 'react'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { TranscriptEntry } from '@pneuma/runtime/contract.js'
// 以下都是纯模块（不牵 ink 运行时），静态 import 安全。
import { absoluteTop, measuredHeight, type ClickEntry } from './click.js'
import { railGeometry, estimateLines } from './scroll-model.js'
import { mixHex, RAIL_COLOR } from './theme.js'
import { clearPointer, onGutter, publishPointer } from './pointer.js'
// 牵 ink 的模块：等 FORCE_COLOR 设好之后再加载（顶层 await 顺序执行）。
const { render, Box } = await import('ink')
const { Entry } = await import('./ChatView.js')
const { StatusBar } = await import('./StatusBar.js')
const { TimelineRail } = await import('./TimelineRail.js')

const WIDTH = 60
/** 终端列数：`MarkdownView` 自己按 `columns − 6` 算宽度，让盒宽与它一致（估算按盒宽算）。 */
const COLUMNS = WIDTH + 6

/** 把一件东西渲染成裸行（每行含 SGR 原文）。组件级一帧即稳，固定一拍足够。 */
async function renderLines(element: React.ReactElement, columns = COLUMNS, rows = 60): Promise<string[]> {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean }
  stdout.columns = columns
  stdout.rows = rows
  stdout.isTTY = false
  let text = ''
  stdout.on('data', (chunk: Buffer) => {
    text += String(chunk)
  })
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await new Promise((resolveTick) => setTimeout(resolveTick, 120))
  instance.unmount()
  const at = text.lastIndexOf('\x1b[2K')
  return (at < 0 ? text : text.slice(at))
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => line.replace(/^\x1b\[2K/, ''))
    .filter((line, index, all) => !(index === all.length - 1 && line === ''))
}

/** 去掉 SGR：判「这一行画了什么」用（几何与文案）。 */
const plain = (line: string) => line.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '').replace(/\s+$/, '')

const renderEntry = (entry: TranscriptEntry, expandThinking = false): Promise<string[]> =>
  renderLines(createElement(Box, { width: WIDTH }, createElement(Entry, { entry, streaming: false, expandThinking })))

interface MountedToggle {
  click: (col: number, row: number) => Promise<boolean>
  since: () => string
  contains: (needle: string) => boolean
  lastFrame: () => string[]
  regions: ClickEntry[]
  unmount: () => void
}

/**
 * 挂一个**常驻**的小宿主：展开集合与切换回调由一个 state 持有（与 App 同构），
 * `Entry` 登记点击区，直接调 `hit`（App 点击时也是这么问的：现量 top/height 再问）。
 * 帧从整段输出里取（非 TTY 下每帧整段追加，取尾部即最新帧）。
 */
async function mountToggle(entry: TranscriptEntry, columns = COLUMNS): Promise<MountedToggle> {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean }
  stdout.columns = columns
  stdout.rows = 60
  stdout.isTTY = false
  let text = ''
  stdout.on('data', (chunk: Buffer) => {
    text += String(chunk)
  })
  const regions: ClickEntry[] = []
  const register: (region: ClickEntry) => () => void = (region) => {
    regions.push(region)
    return () => {
      const index = regions.indexOf(region)
      if (index >= 0) regions.splice(index, 1)
    }
  }
  function Host(): React.ReactElement {
    const [open, setOpen] = useState(false)
    return createElement(
      Box,
      { width: WIDTH, flexDirection: 'column' },
      createElement(Entry, {
        entry,
        streaming: false,
        expandThinking: false,
        expandedTools: new Set(open ? [entry.id] : []),
        onToggleTool: (id: number) => setOpen((current) => (id === entry.id ? !current : current)),
        registerClick: register,
      }),
    )
  }
  const instance = render(createElement(Host), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await new Promise((resolveTick) => setTimeout(resolveTick, 180))
  let mark = 0
  const since = () => plain(text.slice(mark))
  const contains = (needle: string) => since().includes(needle)
  const lastFrame = () =>
    text
      .slice(text.lastIndexOf('\x1b[2K'))
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => plain(line.replace(/^\x1b\[2K/, '')))
  const click = async (col: number, row: number): Promise<boolean> => {
    mark = text.length
    const clicked = regions.some((region) => {
      const top = absoluteTop(region.node.current)
      const height = measuredHeight(region.node.current)
      if (top === null || height === null) return false
      return region.hit(col, row, top, height)
    })
    await new Promise((resolveTick) => setTimeout(resolveTick, 180))
    return clicked
  }
  return { click, since, contains, lastFrame, regions, unmount: () => instance.unmount() }
}

const LONG_RESULT = Array.from({ length: 14 }, (_, i) => `结果第 ${i} 行`).join('\n')
const LONG_THINK = Array.from({ length: 9 }, (_, i) => `第 ${i} 段推理`).join('\n')

afterAll(() => {
  clearPointer()
})

// ── [1] 思考块 ──────────────────────────────────────────────────────────────

describe('[1] 思考块：折叠态恒定 4 行（标签 + 3 行瀑布）', () => {
  const entry: TranscriptEntry = { kind: 'thinking', id: 1, text: LONG_THINK, durationMs: 4200 } as TranscriptEntry
  let folded: string[] = []

  beforeAll(async () => {
    folded = await renderEntry(entry)
  })

  test('折叠态 = 标签 + 恒定 3 行瀑布（块高与正文多长 / 框多宽都无关）', () => {
    expect(folded.length, JSON.stringify(folded.map(plain))).toBe(4)
  })

  test('标签在行首（无缩进）', () => {
    expect(plain(folded[0] ?? '').startsWith('⚓ 思考'), JSON.stringify(plain(folded[0] ?? ''))).toBe(true)
  })

  test('标签行是斜体 + 暗淡（照 dsh：只有标签斜体）', () => {
    expect((folded[0] ?? '').includes('\x1b[3m') && (folded[0] ?? '').includes('\x1b[2m'), JSON.stringify(folded[0])).toBe(true)
  })

  test('瀑布每行缩两格 + │ 引导', () => {
    expect(
      folded.slice(1).every((line) => plain(line).startsWith('  │ ')),
      JSON.stringify(folded.slice(1).map(plain)),
    ).toBe(true)
  })

  test('首行前缀 …（上面还有内容）、末行留的是最新那几段（从尾部截）', () => {
    expect(plain(folded[1] ?? '').startsWith('  │ …第 6 段推理'), JSON.stringify(plain(folded[1] ?? ''))).toBe(true)
    expect(plain(folded[3] ?? '').includes('第 8 段推理'), JSON.stringify(plain(folded[3] ?? ''))).toBe(true)
  })

  test('思考正文不斜体（不再是斜体长段）', () => {
    expect(folded.slice(1).every((line) => !line.includes('\x1b[3m')), JSON.stringify(folded[1])).toBe(true)
  })

  test('思考正文是暗淡色（终端没有字号，暗淡就是「小一号」）', () => {
    expect((folded[1] ?? '').includes('\x1b[2m'), JSON.stringify(folded[1])).toBe(true)
  })

  test('折叠态行数与估算一致', () => {
    expect(estimateLines(entry, WIDTH)).toBe(folded.length)
  })
})

describe('[1b] 思考块：展开态与两个恒高边界', () => {
  const entry: TranscriptEntry = { kind: 'thinking', id: 1, text: LONG_THINK, durationMs: 4200 } as TranscriptEntry

  test('展开态 = 标签 1 行 + 全文 9 行，估算一致', async () => {
    const expanded = await renderEntry(entry, true)
    expect(
      expanded.length === 10 && estimateLines(entry, WIDTH, { expandThinking: true }) === expanded.length,
      JSON.stringify([expanded.length, estimateLines(entry, WIDTH, { expandThinking: true })]),
    ).toBe(true)
  })

  test('短思考同样恒定 4 行（空行画 │ 而不是空串），估算一致', async () => {
    const short: TranscriptEntry = { kind: 'thinking', id: 8, text: '短一句' } as TranscriptEntry
    const shortLines = await renderEntry(short)
    expect(
      shortLines.length === 4 && estimateLines(short, WIDTH) === 4 && plain(shortLines[2] ?? '') === '  │',
      JSON.stringify(shortLines.map(plain)),
    ).toBe(true)
  })

  test('一整行超长（不换行的那种）也硬截成 4 行', async () => {
    const wide: TranscriptEntry = { kind: 'thinking', id: 9, text: '甲'.repeat(300) } as TranscriptEntry
    const wideLines = await renderEntry(wide)
    expect(wideLines.length === 4 && estimateLines(wide, WIDTH) === 4, JSON.stringify(wideLines.map(plain))).toBe(true)
  })

  test('流式 spinner 是呼吸色（品牌蓝 ↔ 冰蓝；蓝通道恒 ≥ 0xFE），流式标签报「思考中」', async () => {
    const streamed = await renderLines(
      createElement(
        Box,
        { width: WIDTH },
        createElement(Entry, { entry: { kind: 'thinking', id: 10, text: '推一下' } as TranscriptEntry, streaming: true, expandThinking: false }),
      ),
    )
    const rgb = /38;2;(\d+);(\d+);(\d+)/.exec(streamed[0] ?? '')
    expect(
      rgb !== null &&
        Number(rgb[1]) >= 0x4d &&
        Number(rgb[1]) <= 0x93 &&
        Number(rgb[2]) >= 0x6b &&
        Number(rgb[2]) <= 0xbe &&
        Number(rgb[3]) >= 0xfe,
      `读到 ${rgb === null ? '无色' : rgb.slice(1).join(',')}：${JSON.stringify(streamed[0])}`,
    ).toBe(true)
    expect(plain(streamed[0] ?? '').includes('思考中'), JSON.stringify(plain(streamed[0] ?? ''))).toBe(true)
  })
})

// ── [2] 用户消息 ────────────────────────────────────────────────────────────

describe('[2] 用户消息：前置空行 + 金色粗体题面，估算一致', () => {
  const entry: TranscriptEntry = { kind: 'user', id: 2, text: '你好，这是一句题面' } as TranscriptEntry
  let lines: string[] = []

  beforeAll(async () => {
    lines = await renderEntry(entry)
  })

  test('带上了前面那行空（共两行）', () => {
    expect(lines.length === 2 && plain(lines[0] ?? '') === '', JSON.stringify(lines.map(plain))).toBe(true)
  })

  test('题面行金色 + 粗体（dsh userPromptLabel）', () => {
    expect(
      plain(lines[1] ?? '').startsWith('❯ 你好') && (lines[1] ?? '').includes('\x1b[1m') && (lines[1] ?? '').includes('38;2;255;223;128'),
      JSON.stringify(lines[1]),
    ).toBe(true)
  })

  test('用户行行数与估算一致', () => {
    expect(estimateLines(entry, WIDTH)).toBe(lines.length)
  })

  test('队友汇报那条不占空行、只有一行', async () => {
    const internal: TranscriptEntry = { kind: 'user', id: 3, text: '汇报', internal: true } as TranscriptEntry
    const rendered = await renderEntry(internal)
    expect(
      rendered.length === 1 && estimateLines(internal, WIDTH) === 1,
      JSON.stringify(rendered.map(plain)),
    ).toBe(true)
  })
})

// ── [3] 工具卡 ──────────────────────────────────────────────────────────────

describe('[3] 工具卡：默认「调用 xx 工具」一行，点击展开参数与结果', () => {
  const entry: TranscriptEntry = {
    kind: 'tool',
    id: 4,
    call: { callId: 'c1', name: 'browser_look', argsText: '{"action":"snapshot"}', resultText: LONG_RESULT, status: 'done', durationMs: 1400 },
  } as TranscriptEntry
  let lines: string[] = []

  beforeAll(async () => {
    lines = await renderEntry(entry)
  })

  test('折叠态就是一行', () => {
    expect(lines.length, JSON.stringify(lines.map(plain))).toBe(1)
  })

  test('默认报「调用 xx 工具」+ 状态 + 耗时', () => {
    expect(plain(lines[0] ?? '')).toBe('⚙  调用 browser_look 工具 · ✓ 完成 · 1.4s')
  })

  test('图标与文字之间留两格（终端把 ⚙ 画成双宽字形时也挤不着）', () => {
    expect(plain(lines[0] ?? '').startsWith('⚙  调用'), JSON.stringify((plain(lines[0] ?? '')).slice(0, 10))).toBe(true)
  })

  test('折叠态不摊参数与结果（那两样点开才给）', () => {
    const head = plain(lines[0] ?? '')
    expect(head.includes('snapshot')).toBe(false)
    expect(lines.some((line) => line.includes('结果第 0 行'))).toBe(false)
  })

  test('折叠态行数与估算一致（1 行）', () => {
    expect(estimateLines(entry, WIDTH)).toBe(1)
  })

  test('没有结果时同样一行（估算与渲染都恒 1 行）', () => {
    const noResult: TranscriptEntry = {
      ...entry,
      id: 9,
      call: { ...(entry as { call: { resultText: string } }).call, resultText: '' },
    } as TranscriptEntry
    expect(estimateLines(noResult, WIDTH)).toBe(1)
  })
})

describe('[3b] 工具卡点击链路：真登记点击区 → 调命中判定 → 展开再点收回', () => {
  const entry: TranscriptEntry = {
    kind: 'tool',
    id: 4,
    call: { callId: 'c1', name: 'browser_look', argsText: '{"action":"snapshot"}', resultText: LONG_RESULT, status: 'done', durationMs: 1400 },
  } as TranscriptEntry

  test('登记 → 展开 → 点外不命中 → 再点收回', async () => {
    const card = await mountToggle(entry)
    try {
      expect(card.regions.length, String(card.regions.length)).toBe(1)
      expect(!card.contains('▸ {"action":"snapshot"}') && !card.contains('结果第 0 行')).toBe(true)

      const hitIn = await card.click(4, 0)
      expect(
        hitIn && card.contains('▸ {"action":"snapshot"}') && card.contains('↳ 结果第 0 行'),
        JSON.stringify(card.since()),
      ).toBe(true)

      // 点在卡片右侧之外（刻度栏那两列）：不命中、不展开
      const outside = await card.click(WIDTH + 2, 0)
      expect(!outside && !card.since().includes('↳ 结果第 0 行')).toBe(true)

      // 点在卡片上下之外的行：不命中
      expect(await card.click(4, 5)).toBe(false)

      const hitBack = await card.click(4, 0)
      expect(hitBack && !card.lastFrame().some((line) => line.includes('结果第 0 行')), JSON.stringify(card.lastFrame())).toBe(true)
    } finally {
      card.unmount()
    }
  })
})

// ── [4] 子代理卡 ────────────────────────────────────────────────────────────

describe('[4] 子代理卡：收工一行 / 跑动 4 行 / 有工具 5 行，估算逐一对齐', () => {
  const settled: TranscriptEntry = {
    kind: 'subagent',
    id: 6,
    sub: { name: 'mate-1', role: 'explorer', state: 'idle', task: '查资料', rounds: 3, toolCalls: 4, model: 'm', outputLines: ['一', '二', '三'] },
  } as TranscriptEntry

  test('收工后只有标题一行', async () => {
    const done = await renderEntry(settled)
    expect(done.length === 1 && estimateLines(settled, WIDTH) === 1, `实测 ${done.length}`).toBe(true)
  })

  test('跑动中（还没有工具在跑）= 标题 + 3 行瀑布', async () => {
    const working = { ...settled, id: 7, sub: { ...(settled as unknown as { sub: Record<string, unknown> }).sub, state: 'working' } } as TranscriptEntry
    const live = await renderEntry(working)
    expect(live.length === 4 && estimateLines(working, WIDTH) === 4, `实测 ${live.length}，估算 ${estimateLines(working, WIDTH)}`).toBe(true)
  })

  test('跑动中（有工具）= 标题 + 当前工具 + 3 行瀑布', async () => {
    const working = { ...settled, id: 7, sub: { ...(settled as unknown as { sub: Record<string, unknown> }).sub, state: 'working' } } as TranscriptEntry
    const withTool = {
      ...working,
      id: 9,
      sub: { ...(working as unknown as { sub: Record<string, unknown> }).sub, lastTool: { name: 'read', args: 'a.ts', status: 'running' } },
    } as TranscriptEntry
    const live2 = await renderEntry(withTool)
    expect(live2.length === 5 && estimateLines(withTool, WIDTH) === 5, `实测 ${live2.length}，估算 ${estimateLines(withTool, WIDTH)}`).toBe(true)
  })
})

// ── [5] 状态栏 ──────────────────────────────────────────────────────────────

describe('[5] 状态栏：一行、没有蓝色进度条与填充色块', () => {
  let bar: string[] = []

  beforeAll(async () => {
    // status / surfaces 只列状态栏要读的字段（探针同款），照 status-bar.spec.ts 的口径
    // 用一次显式类型转换收口（RuntimeSurfaces 的其余分区状态栏不读）。
    const status = {
      turnState: 'idle',
      model: 'test-model',
      effort: 'medium',
      usage: null,
      contextWindow: 1_000_000,
      contextUsed: 0,
      contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
      progress: { turns: 0, steps: 0 },
      sessionId: '/w/s.jsonl',
      cwd: '/w',
    }
    const surfaces = {
      pendingApproval: null,
      pendingQuestion: null,
      pendingPlan: null,
      goal: null,
      todos: { total: 0, done: 0, active: null },
      mode: { options: [{ id: 'build', label: '执行' }], current: 'build' },
      policy: { options: [{ id: 'default', label: '标准' }], current: 'default' },
    } as unknown as Parameters<typeof StatusBar>[0]['surfaces']
    bar = await renderLines(
      createElement(StatusBar, {
        status: status as unknown as Parameters<typeof StatusBar>[0]['status'],
        surfaces,
        subagents: [],
        queued: 0,
        config: { model: true, effort: false, cache: false, tokens: false, cost: false, mode: true, policy: true, ctx: true, cwd: true, session: false },
      }) as React.ReactElement,
      COLUMNS,
    )
  })

  test('状态栏只有一行', () => {
    expect(bar.length, JSON.stringify(bar.map(plain))).toBe(1)
  })

  test('那一行还是原来的字段行（状态 + 模型）', () => {
    expect(plain(bar[0] ?? '').includes('空闲') && plain(bar[0] ?? '').includes('test-model'), JSON.stringify(plain(bar[0] ?? ''))).toBe(true)
  })

  test('context 读数的长形式（x/y pct）不再出现在状态栏里', () => {
    expect(bar.some((line) => /\d+\/1\.0M/.test(plain(line))), JSON.stringify(bar.map(plain))).toBe(false)
  })

  test('没有任何填充背景色块（那条进度条靠 childless Box 的 backgroundColor 画）', () => {
    expect(bar.some((line) => /\x1b\[48[;0-9]*m/.test(line)), JSON.stringify(bar)).toBe(false)
  })
})

// ── [6] 呼吸色与刻度列悬停提亮 ──────────────────────────────────────────────

describe('[6] mixHex 与刻度列悬停提亮', () => {
  const hexToSgr = (hex: string): string => {
    const value = Number.parseInt(hex.replace('#', ''), 16)
    return `38;2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`
  }

  test('mixHex：两端原样、中点取平均、越界夹住、非 hex 原样返回', () => {
    expect(mixHex('#4D6BFE', '#93BEFF', 0).toLowerCase()).toBe('#4d6bfe')
    expect(mixHex('#4D6BFE', '#93BEFF', 1).toLowerCase()).toBe('#93beff')
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#000000', '#ffffff', 9)).toBe('#ffffff')
    expect(mixHex('#000000', '#ffffff', -3)).toBe('#000000')
    expect(mixHex('cyan', '#ffffff', 0.5)).toBe('cyan')
  })

  test('悬停那一行提亮到 active，别行仍是 idle', async () => {
    // 指针停在某一格刻度上 → 那一行提亮到 RAIL_COLOR.active（栏目顶行 = 帧第 0 行，
    // 指针的 1 基行号 = 列内行号 + 1；悬停第二格刻度，那里本来画 idle 短线，提亮才看得出来）
    const geometry = railGeometry({ turnCount: 3, activeIndex: 0, rows: 8 })
    const hoverRow = geometry.tickTop + 1
    publishPointer(5, hoverRow + 1, 8) // 列 5/8 落在刻度列（页边距 2 内）
    const hovered = await renderLines(createElement(TimelineRail, { geometry, onPickTurn: () => {} }), 8, 10)
    clearPointer()
    const idle = await renderLines(createElement(TimelineRail, { geometry, onPickTurn: () => {} }), 8, 10)
    expect(
      hovered[hoverRow]?.includes(hexToSgr(RAIL_COLOR.active)) === true,
      `第 ${hoverRow} 行应含 ${hexToSgr(RAIL_COLOR.active)}：${JSON.stringify(hovered.map(plain))}`,
    ).toBe(true)
    expect(
      idle[hoverRow]?.includes(hexToSgr(RAIL_COLOR.idle)) === true && !idle[hoverRow]?.includes(hexToSgr(RAIL_COLOR.active)),
      JSON.stringify(idle.map(plain)),
    ).toBe(true)
    expect(
      hovered[geometry.tickTop + 2]?.includes(hexToSgr(RAIL_COLOR.idle)) === true &&
        !hovered[geometry.tickTop + 2]?.includes(hexToSgr(RAIL_COLOR.active)),
      JSON.stringify([plain(hovered[geometry.tickTop + 2] ?? ''), plain(hovered[hoverRow] ?? '')]),
    ).toBe(true)
  })

  test('onGutter 与渲染用的列门槛一致（列 5/8 在下、列 4/8 在上）', () => {
    expect(onGutter(5, 8)).toBe(true)
    expect(onGutter(4, 8)).toBe(false)
  })
})
