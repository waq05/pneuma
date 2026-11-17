/**
 * 行体的两层分工与节点级槽（`render.tsx` 的 RowBody / builtinRowBody）的渲染段
 * （ui 层，真渲染）。
 *
 * 来源：`scripts/ui-node-slot-test.mjs` 第 [2][3][5] 段（缺口清单 B36「ui-node-slot 主体」
 * 里**有运行期接缝**的三段；[1] 的 declare module 契约与 [4] 的两处装配登记是编译期
 * 声明，运行期没有对应物，不硬迁——槽名常量已迁 `node-slots.spec.ts`）：
 *   - [2] 兜底走 `renderSlot` 的**第三个参数**，不许写成 `??` 硬判——`renderSlot` 返回的
 *     是渲染出口的元素、永远不是 null，`??` 判不出「链上没人」。行为化：弃权替身把
 *     第三参原样渲染回来，内置行体出现；同时断言第三参真的被交了出来（写成 `?? builtin`
 *     的老写法，替身收到的第三参就是 undefined，这里当场红）。
 *   - [3] RowBody 的两层：没有槽上下文时直接画内置行体（不能拿返回 null 的空函数顶替，
 *     否则子代理流白屏）；槽在位时整行交由 `transcript.node` 选举；thinking 分支走
 *     `transcript.reasoning.body` 选举、tool 分支保持 `?? <ToolRow>` 的旧兜底。
 *   - [5] ThinkRow 展开区优先画外面给的 body（`body ?? 原件`）——原探针钉的是
 *     `{body ?? <div className="think-text">{entry.text}</div>}` 那行 JSX 文本。
 *
 * 为什么这份能存在：RowBody / ThinkRow / builtinRowBody 的判定全是运行期分支，
 * 槽渲染函数由替身扮演（生产里由壳的槽位系统注入）。
 *
 * @module dsc-ui-transcript/ui/row-body-slots.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { TranscriptEntry } from '@dsc/ui'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { RowBody } from './render.js'
import { ThinkRow } from './rows/think-row.js'
import { ThinkText } from './rows/think-text.js'
import { TRANSCRIPT_NODE_SLOT, TRANSCRIPT_REASONING_BODY_SLOT, TOOLVIEW_SLOT, type Row, type ToolViewRender } from './shared.js'

/** ThinkRow 展开时会 new ResizeObserver（jsdom 没有）：量高逻辑在这层测试里不重要，给个空桩。 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

let seq = 0
/** 造一行（entry 由用例给，其余靠缺省）。 */
const rowOf = (entry: TranscriptEntry, stable = `r0:${entry.kind}:${String(seq)}`): Row =>
  ({ entry, live: false, at: (seq += 1), stable }) as Row

interface SlotCall {
  slot: string
  owner: Record<string, unknown>
  fallback: ReactNode | undefined
}

/** 槽渲染替身：记录每次调用，行为由用例给（认领 / 弃权返回 fallback / 返回 null）。 */
function stubRenderSlot(behavior: (call: SlotCall) => ReactNode): { renderSlot: ToolViewRender; calls: SlotCall[] } {
  const calls: SlotCall[] = []
  const renderSlot = ((slot: string, owner: Record<string, unknown> = {}, fallback?: ReactNode): ReactNode => {
    const call: SlotCall = { slot, owner, fallback }
    calls.push(call)
    return behavior(call)
  }) as unknown as ToolViewRender
  return { renderSlot, calls }
}

const textEntry = (text: string): TranscriptEntry => ({ kind: 'text', id: (seq += 1), text, ts: 1 }) as TranscriptEntry
const thinkEntry = (text: string): Extract<TranscriptEntry, { kind: 'thinking' }> =>
  ({ kind: 'thinking', id: (seq += 1), text }) as Extract<TranscriptEntry, { kind: 'thinking' }>
const toolEntry = (name: string, argsText: string): TranscriptEntry =>
  ({
    kind: 'tool', id: (seq += 1),
    call: { callId: `c${String(seq)}`, name, argsText, status: 'done' },
  }) as TranscriptEntry

/**
 * 测试替身宿主通道（工具卡骨架的「将做的改动」hook 无条件拿通道，本层不触那条路）。
 * 同 `tool-card-view.spec.tsx` 的 stubChannel。
 */
const stubChannel = (): HostChannel => ({
  getSnapshot: () => null,
  getHello: () => null,
  getStatus: () => 'closed',
  getHostError: () => null,
  getPluginsFrame: () => null,
  onPlugins: () => () => undefined,
  onAsk: () => () => undefined,
  subscribe: () => () => undefined,
  invoke: () => Promise.reject(new Error('测试不触发宿主调用')),
  reconnect: () => undefined,
  close: () => undefined,
})

describe('两层分工：没有槽上下文 / 槽在位（ui-node-slot [3] 行为化）', () => {
  test('renderSlot 缺席（团队页签把组件当值渲染）：直接画内置行体，不问槽', () => {
    const { container } = render(<RowBody row={rowOf(textEntry('正文一段'))} />)
    expect(container.querySelector('.entry-text')?.textContent).toContain('正文一段')
  })

  test('槽在位时整行交由 transcript.node 选举：认领者赢过内置行体', () => {
    const { renderSlot, calls } = stubRenderSlot((call) =>
      call.slot === TRANSCRIPT_NODE_SLOT ? <div data-node-claimed="1">插件认领的行体</div> : (call.fallback ?? null),
    )
    const row = rowOf(textEntry('正文一段'))
    const { container } = render(<RowBody row={row} renderSlot={renderSlot} />)
    expect(container.querySelector('[data-node-claimed]')).toBeTruthy()
    expect(container.querySelector('.entry-text')).toBeNull()
    // owner 把这一行的身份交了出去：插件拿得到条目、直播态、稳定身份与会话 id。
    const node = calls.find((call) => call.slot === TRANSCRIPT_NODE_SLOT)
    expect(node).toBeDefined()
    expect(node?.owner['stable']).toBe(row.stable)
    expect(node?.owner['entry']).toBe(row.entry)
  })
})

describe('兜底走 renderSlot 的第三个参数（ui-node-slot [2] 行为化）', () => {
  test('链上全体弃权：内置行体经 fallback 渲染回来，且 fallback 真的被交了出来', () => {
    // 弃权 = 把第三参原样渲染回去（壳的出口语义：永远不返回 null）。
    const { renderSlot, calls } = stubRenderSlot((call) => call.fallback ?? null)
    const { container } = render(<RowBody row={rowOf(textEntry('正文一段'))} renderSlot={renderSlot} />)
    // 内置行体出现（经兜底，而不是直出）。
    expect(container.querySelector('.entry-text')).toBeTruthy()
    // 反向钉：node 槽的调用必须带着 fallback 第三参——写成 `?? builtin` 的老写法，
    // 替身收到的第三参是 undefined，这条当场红。
    const node = calls.find((call) => call.slot === TRANSCRIPT_NODE_SLOT)
    expect(node?.fallback).toBeDefined()
  })
})

describe('thinking 分支走 transcript.reasoning.body 选举（ui-node-slot [3]）', () => {
  test('弃权时兜底就是 ThinkText（第三参交的是内置正文的元素）', async () => {
    const { renderSlot, calls } = stubRenderSlot((call) => call.fallback ?? null)
    const { container } = render(<RowBody row={rowOf(thinkEntry('思考一段'))} renderSlot={renderSlot} />)
    const body = calls.find((call) => call.slot === TRANSCRIPT_REASONING_BODY_SLOT)
    expect(body).toBeDefined()
    expect((body?.fallback as { type?: unknown })?.type).toBe(ThinkText)
    // owner 带着展开态存档键（`会话:行的稳定身份`）与直播态。
    expect(typeof body?.owner['storeKey']).toBe('string')
    expect(body?.owner['live']).toBe(false)
    // 弃权兜底画出来的是思考行（点击展开后正文就是 ThinkText）。
    fireEvent.click(container.querySelector('.think-head') as HTMLElement)
    expect(container.querySelector('.think-text')?.textContent).toContain('思考一段')
  })
})

describe('tool 分支保持旧兜底（ui-node-slot [3]）', () => {
  test('toolview 链弃权（返回 null）：落回内置工具卡——这一条兜底就是 `??`', () => {
    const { renderSlot, calls } = stubRenderSlot((call) => (call.slot === TOOLVIEW_SLOT ? null : (call.fallback ?? null)))
    const { container } = render(
      <RuntimeProvider channel={stubChannel()}>
        <RowBody row={rowOf(toolEntry('bash', '{"command":"ls"}'))} renderSlot={renderSlot} />
      </RuntimeProvider>,
    )
    // toolview 没人认领 → `renderSlot?.(TOOLVIEW_SLOT, …) ?? <ToolRow>` 落回工具卡。
    expect(container.querySelector('.tool-card')).toBeTruthy()
    // 分工的证据：toolview 的调用不带 fallback 第三参（旧兜底是 ??），node 槽的带。
    const toolview = calls.find((call) => call.slot === TOOLVIEW_SLOT)
    const node = calls.find((call) => call.slot === TRANSCRIPT_NODE_SLOT)
    expect(toolview?.fallback).toBeUndefined()
    expect(node?.fallback).toBeDefined()
  })
})

describe('ThinkRow 展开区优先画外面给的 body（ui-node-slot [5] 行为化）', () => {
  test('给了 body：展开区画外面那份，不再直吐原文', () => {
    const { container } = render(
      <ThinkRow
        entry={thinkEntry('原文正文')}
        live={false}
        storeKey="spec-body:1"
        body={<div data-given-body="1">外面给的排版</div>}
      />,
    )
    fireEvent.click(container.querySelector('.think-head') as HTMLElement)
    expect(container.querySelector('[data-given-body]')).toBeTruthy()
    expect(container.querySelector('.think-text')).toBeNull()
  })

  test('没给 body（undefined）：展开区落回内置的 .think-text 原件', () => {
    const { container } = render(<ThinkRow entry={thinkEntry('原文正文')} live={false} storeKey="spec-body:2" />)
    fireEvent.click(container.querySelector('.think-head') as HTMLElement)
    expect(container.querySelector('.think-text')?.textContent).toContain('原文正文')
    expect(container.querySelector('[data-given-body]')).toBeNull()
  })
})
