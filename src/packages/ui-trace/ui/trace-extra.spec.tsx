/**
 * 执行轨迹页（`ui-trace/ui/ui.tsx`）的渲染与交互段（ui 层，真渲染）。
 *
 * 既有 spec 只压包清单/发布契约与「写前预览」一条旁路。这一份补主干：空态、轮次统计与
 * 展开折叠、时间概览条（有宽度的工具条 vs 只画刻度的步骤）、搜索过滤、检查器开合与参数
 * 格式化、压缩区段与四类轮级事件、直播尾合并、用户消息附件与放大浮层、工具行 Factory
 * 缺席时的兜底。假通道只提供快照（轨迹页不 invoke），`renderFactorySlot` 用定义缺席的
 * 兜底路径，正好把 `TraceToolRow` 这条保险丝也压到。
 *
 * @module dsc-ui-trace/ui/trace-extra.spec
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, TranscriptEntry, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

/** TraceView 不直接导出：照生产壳装载插件那条路，从 apply 的登记里收下它。 */
function traceComponent(): ComponentType<Record<string, unknown>> {
  const registered: Array<{ slot: string; component: unknown }> = []
  const fakeUi = {
    slots: {
      register: (slot: string, _options: unknown, component: unknown): void => {
        registered.push({ slot, component })
      },
      declare: (): void => undefined,
      registerFactory: (): void => undefined,
    },
    provide: (): void => undefined,
    consume: (): undefined => undefined,
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  const found = registered[0]
  if (found === undefined) throw new Error('trace 插件没有登记组件')
  return found.component as ComponentType<Record<string, unknown>>
}

const TraceView = traceComponent()

/** 条目 id 从 1 起；测试里按 id 断言 DOM 的属性。 */
const BASE = 1_767_240_000_000

const user = (id: number, text: string, extra: Partial<Extract<TranscriptEntry, { kind: 'user' }>> = {}): TranscriptEntry =>
  ({ kind: 'user', id, text, ts: BASE, ...extra }) as TranscriptEntry

const tool = (
  id: number,
  patch: Partial<Extract<TranscriptEntry, { kind: 'tool' }>['call']> = {},
  extra: Partial<Extract<TranscriptEntry, { kind: 'tool' }>> = {},
): TranscriptEntry =>
  ({
    kind: 'tool',
    id,
    ts: BASE + 3000,
    call: {
      callId: `call-${String(id)}`,
      name: 'read',
      argsText: '{"path":"a.ts"}',
      resultText: '文件内容',
      status: 'done',
      startedAt: BASE + 1000,
      durationMs: 2000,
      ...patch,
    },
    ...extra,
  }) as TranscriptEntry

/** 快照：轨迹页只读 entries / liveEntries / status。 */
function snapshotOf(
  entries: TranscriptEntry[],
  options: { live?: TranscriptEntry[]; usage?: { inputTokens: number; outputTokens: number } } = {},
): HostSnapshot {
  return {
    entries,
    liveEntries: options.live ?? [],
    status: {
      cwd: 'D:/demo',
      sessionPath: 'D:/demo/demo.jsonl',
      sessionId: 'uuid-trace',
      turnState: 'idle',
      ...(options.usage === undefined ? {} : { usage: options.usage }),
    },
  } as unknown as HostSnapshot
}

/** 假通道：快照固定，不 invoke。 */
function channelOf(snapshot: HostSnapshot): HostChannel {
  return {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (() => Promise.reject(new Error('轨迹页不该 invoke'))) as unknown as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
}

/** `transcript.tool-card` 定义缺席时走 fallback（D2 的保险丝）。 */
const renderFactorySlot = ((_name: string, _input: unknown, options?: { fallback?: ReactNode }): ReactNode =>
  options?.fallback ?? null) as never

function renderTrace(snapshot: HostSnapshot): ReturnType<typeof render> {
  return render(
    <RuntimeProvider channel={channelOf(snapshot)}>
      <TraceView renderFactorySlot={renderFactorySlot} />
    </RuntimeProvider>,
  )
}

const textOf = (element: Element | null): string => element?.textContent ?? ''

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('空态与轮次表', () => {
  test('没有任何条目：只画空态，不画时间条与轮次', () => {
    const { container } = renderTrace(snapshotOf([]))
    expect(textOf(container.querySelector('.trace-empty'))).toContain('本会话还没有执行轨迹')
    expect(container.querySelector('.trace-round')).toBeNull()
    expect(container.querySelector('.trace-timeline')).toBeNull()
  })

  test('统计、默认只展开最新一轮、轮头摘要与整轮用量都按真值画', () => {
    const { container } = renderTrace(
      snapshotOf(
        [
          user(1, '先读文件'),
          tool(2),
          user(3, '再跑命令'),
          tool(4, { name: 'bash', argsText: '{"command":"ls"}', startedAt: BASE + 6000, durationMs: 500 }, {
            ts: BASE + 7000,
            usage: { inputTokens: 1200, outputTokens: 300 },
          }),
        ],
        { usage: { inputTokens: 2000, outputTokens: 1000 } },
      ),
    )

    expect(textOf(container.querySelector('.trace-stats'))).toContain('2 轮')
    expect(textOf(container.querySelector('.trace-stats'))).toContain('2 次工具调用')
    expect(textOf(container.querySelector('.trace-stats'))).toContain('3K tok')

    const rounds = [...container.querySelectorAll('.trace-round')] as HTMLElement[]
    expect(rounds).toHaveLength(2)
    // 最新一轮默认展开，旧的那轮保持折叠。
    expect(rounds[0]!.className).not.toContain('open')
    expect(rounds[1]!.className).toContain('open')
    expect(rounds[0]!.querySelector('.round-head')?.getAttribute('aria-expanded')).toBe('false')
    expect(rounds[1]!.querySelector('.round-head')?.getAttribute('aria-expanded')).toBe('true')
    expect(textOf(rounds[0]!.querySelector('.round-meta'))).toBe('1 步 · 1 次工具')
    // 整轮用量只落在这轮最后一条带用量的步骤上：轮头与那一行各显示一次。
    expect(textOf(rounds[1]!.querySelector('.round-tok'))).toBe('1.5K tok')
    expect(textOf(rounds[1]!.querySelector('.tmeta-tok'))).toBe('1.5K tok')
    expect(rounds[0]!.querySelector('.tmeta-tok')).toBeNull()

    // 点轮头展开第一轮，再点一次折回。
    const firstHead = rounds[0]!.querySelector('.round-head') as HTMLElement
    fireEvent.click(firstHead)
    expect(rounds[0]!.className).toContain('open')
    expect(rounds[0]!.querySelectorAll('.trace-step')).toHaveLength(1)
    fireEvent.click(firstHead)
    expect(rounds[0]!.className).not.toContain('open')

    // 全部展开 ⇄ 全部折叠。
    const toggleAll = (): HTMLElement => container.querySelector('.trace-toggle-all') as HTMLElement
    expect(toggleAll().textContent).toBe('全部展开')
    fireEvent.click(toggleAll())
    expect(container.querySelectorAll('.trace-round.open')).toHaveLength(2)
    expect(toggleAll().textContent).toBe('全部折叠')
    fireEvent.click(toggleAll())
    expect(container.querySelectorAll('.trace-round.open')).toHaveLength(0)
  })

  test('时间条：有 durationMs 的工具画有宽度的条，其余只画起点刻度；轮次边界单独画', () => {
    const { container } = renderTrace(
      snapshotOf([
        user(1, '开始'),
        tool(2),
        { kind: 'thinking', id: 3, text: '想一想', ts: BASE + 4000 } as TranscriptEntry,
      ]),
    )
    const bar = container.querySelector('[data-trace-mark="2"]') as HTMLElement
    expect(bar.className).toContain('ttl-bar')
    expect(bar.getAttribute('data-duration')).toBe('2000')
    // 思考没有耗时：只画刻度，宽度为 0（不许虚构）。
    const tick = container.querySelector('[data-trace-mark="3"]') as HTMLElement
    expect(tick.className).toContain('ttl-tick')
    expect(container.querySelector('[data-trace-boundary="0"]')).not.toBeNull()
    expect(container.querySelector('[data-trace-track]')?.getAttribute('data-projectable')).toBe('1')
    // 起点 BASE、终点 BASE+4000 → 跨度 4.0s。
    expect(textOf(container.querySelector('.ttl-range'))).toContain('4.0s')
  })

  test('老会话没有时间戳：时间条退化成一句说明，行内不画时刻/耗时', () => {
    const { container } = renderTrace(
      snapshotOf([
        { kind: 'user', id: 1, text: '老会话' } as TranscriptEntry,
        { kind: 'thinking', id: 2, text: '没有时间戳的思考' } as TranscriptEntry,
      ]),
    )
    expect(container.querySelector('[data-trace-timeline="empty"]')).not.toBeNull()
    expect(textOf(container.querySelector('.ttl-note'))).toContain('时间条不画')
    expect(container.querySelector('.trace-round')).not.toBeNull()
    expect(container.querySelector('.tmeta-clock')).toBeNull()
    expect(container.querySelector('.tmeta-dur')).toBeNull()
  })
})

describe('搜索', () => {
  const searchSnapshot = (): HostSnapshot =>
    snapshotOf([
      user(1, '第一轮'),
      tool(2, { name: 'read', argsText: '{"path":"alpha.ts"}' }),
      user(3, '第二轮'),
      tool(4, { name: 'bash', argsText: '{"command":"echo beta"}' }),
    ])

  test('命中轮强制展开、未命中轮不画；命中行高亮并给出计数', () => {
    const { container } = renderTrace(searchSnapshot())
    const input = container.querySelector('.trace-search-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'alpha' } })

    expect(container.querySelectorAll('.trace-round')).toHaveLength(1)
    const round = container.querySelector('.trace-round') as HTMLElement
    expect(round.getAttribute('data-trace-round')).toBe('0')
    // 搜到了却在折着的轮里看不见是不行的：命中轮强制展开。
    expect(round.className).toContain('open')
    const step = container.querySelector('[data-trace-step="2"]') as HTMLElement
    expect(step.className).toContain('is-search-hit')
    expect(step.getAttribute('data-search-hit')).toBe('1')
    expect(textOf(container.querySelector('[data-trace-search-count]'))).toContain('搜索命中 1 步')
  })

  test('零命中给空态；Esc 与清空钮都能退出搜索', () => {
    const { container } = renderTrace(searchSnapshot())
    const input = container.querySelector('.trace-search-input') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(container.querySelectorAll('.trace-round')).toHaveLength(0)
    expect(textOf(container.querySelector('[data-trace-search-empty]'))).toContain('没有匹配「zzz」的步骤')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('')
    expect(container.querySelectorAll('.trace-round')).toHaveLength(2)
    expect(container.querySelector('[data-trace-search-empty]')).toBeNull()

    fireEvent.change(input, { target: { value: 'beta' } })
    expect(container.querySelectorAll('.trace-round')).toHaveLength(1)
    fireEvent.click(container.querySelector('[data-trace-search-clear]') as HTMLElement)
    expect(input.value).toBe('')
    expect(container.querySelectorAll('.trace-round')).toHaveLength(2)
  })
})

describe('检查器', () => {
  test('点行打开：输入/输出/计时/用量按真值画；遮罩、×、Esc 三种关法都生效', () => {
    const { container } = renderTrace(
      snapshotOf([
        user(1, '打开它'),
        tool(2, {}, { usage: { inputTokens: 1000, outputTokens: 500 } }),
      ]),
    )
    const step = container.querySelector('[data-trace-step="2"]') as HTMLElement
    fireEvent.click(step)
    let inspector = container.querySelector('.trace-inspector') as HTMLElement
    expect(inspector).not.toBeNull()
    expect(inspector.getAttribute('data-kind')).toBe('tool')
    expect(textOf(inspector.querySelector('.ti-kind'))).toBe('工具调用')
    expect(textOf(inspector.querySelector('.ti-title'))).toBe('read · 第 1 轮')
    const labels = [...inspector.querySelectorAll('.ti-label')].map((element) => element.textContent)
    expect(labels).toEqual(expect.arrayContaining(['输入', '输出', '计时', '用量']))
    expect(textOf(inspector.querySelector('[data-trace-code="result"]'))).toBe('文件内容')
    expect(textOf(inspector.querySelector('[data-trace-fact="耗时"] dd'))).toBe('2.0s')
    expect(textOf(inspector.querySelector('[data-trace-fact="发起时刻"] dd'))).not.toBe('未记录')
    expect(textOf(inspector.querySelector('[data-trace-fact="输入"] dd'))).toBe('1K tok')
    expect(textOf(inspector.querySelector('[data-trace-fact="合计"] dd'))).toBe('1.5K tok')

    // 遮罩关闭。
    fireEvent.click(container.querySelector('.trace-scrim') as HTMLElement)
    expect(container.querySelector('.trace-inspector')).toBeNull()

    // 行内「打开检查器」钮 + × 关闭。
    fireEvent.click(container.querySelector('.tmeta-open') as HTMLElement)
    inspector = container.querySelector('.trace-inspector') as HTMLElement
    expect(inspector).not.toBeNull()
    fireEvent.click(inspector.querySelector('.ti-close') as HTMLElement)
    expect(container.querySelector('.trace-inspector')).toBeNull()

    // Esc 关闭。
    fireEvent.click(container.querySelector('.tmeta-open') as HTMLElement)
    inspector = container.querySelector('.trace-inspector') as HTMLElement
    fireEvent.keyDown(inspector, { key: 'Escape' })
    expect(container.querySelector('.trace-inspector')).toBeNull()
  })

  test('参数 JSON 默认可格式化；切回原文后显示的就是模型真正发出的那串', () => {
    const raw = '{"path":"a.ts","limit":10}'
    const { container } = renderTrace(snapshotOf([user(1, '看参数'), tool(2, { argsText: raw })]))
    fireEvent.click(container.querySelector('[data-trace-step="2"]') as HTMLElement)

    const code = (): HTMLElement => container.querySelector('[data-trace-code="args"]') as HTMLElement
    const toggle = (): HTMLElement => container.querySelector('[data-trace-format-toggle="args"]') as HTMLElement
    expect(code().getAttribute('data-formatted')).toBe('1')
    expect(code().textContent).toContain('\n')
    expect(toggle().getAttribute('data-state')).toBe('pretty')

    fireEvent.click(toggle())
    expect(toggle().getAttribute('data-state')).toBe('raw')
    expect(code().getAttribute('data-formatted')).toBe('0')
    expect(code().textContent).toBe(raw)

    fireEvent.click(toggle())
    expect(code().getAttribute('data-formatted')).toBe('1')
  })

  test('工具卡内部（.tool-head）与按钮不抢点击：划选/点卡内控件不会误开检查器', () => {
    const { container } = renderTrace(snapshotOf([user(1, '点工具卡'), tool(2)]))
    fireEvent.click(container.querySelector('[data-trace-step="2"] .tool-head') as HTMLElement)
    expect(container.querySelector('.trace-inspector')).toBeNull()
    fireEvent.click(container.querySelector('[data-trace-open]') as HTMLElement)
    expect(container.querySelector('.trace-inspector')).not.toBeNull()
  })

  test('用户消息：正文、附件计数与缩略图；点图开放大浮层，点浮层关闭', () => {
    const images = ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB']
    const { container } = renderTrace(
      snapshotOf([user(1, '带两张图', { images })]),
    )
    expect(textOf(container.querySelector('.round-attach'))).toBe('2 张附件')
    expect(textOf(container.querySelector('.round-none'))).toBe('无工具调用与系统事件')

    fireEvent.click(container.querySelector('.round-open') as HTMLElement)
    const inspector = container.querySelector('.trace-inspector') as HTMLElement
    expect(inspector.getAttribute('data-kind')).toBe('user')
    expect(textOf(inspector.querySelector('.ti-title'))).toBe('第 1 轮')
    expect(textOf(inspector.querySelector('[data-trace-code="user-text"]'))).toBe('带两张图')
    expect(container.querySelectorAll('.ti-shot')).toHaveLength(2)
    // 用户条目没有用量：这一节写「未记录」，不编数。
    expect(textOf(container.querySelector('[data-trace-fact="用量"]'))).toBe('')

    fireEvent.click(container.querySelector('[data-trace-shot="0"]') as HTMLElement)
    const lightbox = container.querySelector('.trace-lightbox') as HTMLElement
    expect(lightbox).not.toBeNull()
    expect((lightbox.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe(images[0])
    fireEvent.click(lightbox)
    expect(container.querySelector('.trace-lightbox')).toBeNull()
  })
})

describe('压缩区段、轮级事件与兜底渲染', () => {
  test('压缩落点插成独立区段；四类轮级事件各有自己的行；正文与文件改动条目不进轨迹', () => {
    const { container } = renderTrace(
      snapshotOf([
        user(1, '压缩前'),
        { kind: 'system', id: 2, text: '压缩通知', ts: BASE + 500, compaction: { count: 2 } } as TranscriptEntry,
        tool(3, { startedAt: BASE + 600, durationMs: 200 }, { ts: BASE + 1000 }),
        { kind: 'turn-end', id: 4, reason: 'aborted', ts: BASE + 1100 } as TranscriptEntry,
        { kind: 'turn-max-tokens', id: 5, ts: BASE + 1200 } as TranscriptEntry,
        { kind: 'model-retry', id: 6, attempt: 2, ts: BASE + 1300 } as TranscriptEntry,
        {
          kind: 'subagent',
          id: 7,
          ts: BASE + 1400,
          sub: { name: 'reader-1', role: '调研', task: '读一圈代码', state: 'working', rounds: 1, toolCalls: 2 },
        } as TranscriptEntry,
        { kind: 'text', id: 8, text: '这段正文不该进轨迹', ts: BASE + 1500 } as TranscriptEntry,
        { kind: 'changes', id: 9, ts: BASE + 1600 } as unknown as TranscriptEntry,
      ]),
    )

    const compact = container.querySelector('.trace-compact') as HTMLElement
    expect(compact.getAttribute('data-trace-compaction')).toBe('2')
    expect(textOf(compact)).toContain('已压缩历史 · 第 2 次')
    // 压缩前的用户轮 + 压缩后另起的无用户轮。
    expect(container.querySelectorAll('.trace-round')).toHaveLength(2)
    const after = container.querySelector('[data-trace-round="1"]') as HTMLElement
    expect(after.querySelector('.round-user')).toBeNull()
    expect(after.className).toContain('open')
    const text = container.textContent ?? ''
    expect(text).toContain('已停止')
    expect(text).toContain('达到长度上限')
    expect(text).toContain('模型重试（第 2 次）')
    // 子代理行的正文只画名字与状态，任务原文在 data-tip（悬停看全文）。
    const subagentRow = container.querySelector('.trace-event[data-tip="读一圈代码"]') as HTMLElement
    expect(subagentRow).not.toBeNull()
    expect(textOf(subagentRow.querySelector('.event-text'))).toBe('reader-1')
    expect(textOf(subagentRow.querySelector('.event-state'))).toBe('working')
    expect(text).not.toContain('这段正文不该进轨迹')
  })

  test('直播尾并进同一份轨迹：跑动中的工具算一步、也算一次工具调用', () => {
    const { container } = renderTrace(
      snapshotOf([user(1, '跑起来')], {
        live: [
          {
            kind: 'tool',
            id: 99,
            call: { callId: 'live-1', name: 'bash', argsText: '{"command":"pnpm test"}', status: 'running' },
          } as TranscriptEntry,
        ],
      }),
    )
    expect(textOf(container.querySelector('.trace-stats'))).toContain('1 次工具调用')
    const step = container.querySelector('[data-trace-step="99"]') as HTMLElement
    expect(step).not.toBeNull()
    expect(step.getAttribute('data-status')).toBe('running')
  })

  test('思考摘要按 90 字截断并带省略号，展开 details 看全文；工具行 Factory 缺席时落兜底行', () => {
    const long = `${'观'.repeat(120)}尾巴`
    const { container } = renderTrace(
      snapshotOf([
        user(1, '看过程'),
        { kind: 'thinking', id: 2, text: long, ts: BASE + 500 } as TranscriptEntry,
        tool(3, { name: 'read', argsText: '{"path":"a.ts"}' }),
      ]),
    )
    const preview = container.querySelector('.th-preview') as HTMLElement
    expect(preview.textContent?.endsWith('…')).toBe(true)
    expect(preview.textContent).toHaveLength(91)
    // details 里的正文是全文（摘要只用于折叠态）。
    expect(textOf(container.querySelector('.trace-think .body'))).toBe(long)

    // Factory 定义缺席（热重装那一帧）：轨迹页仍画一行「状态点 + 工具名 + 参数摘要」。
    const fallback = container.querySelector('.entry.tool-card[data-fallback="trace-tool"]') as HTMLElement
    expect(fallback).not.toBeNull()
    expect(textOf(fallback)).toContain('· read')
    expect(textOf(fallback)).toContain('a.ts')
  })
})
