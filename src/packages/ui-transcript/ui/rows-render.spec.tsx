/**
 * 行渲染骨架（`render.tsx` 的 RowBody / RowBoundary / SeatFrame）的渲染段（ui 层，真渲染）。
 *
 * 来源（缺口清单 B33 / B34，此前留守在探针里的「渲染接线」段）：
 * - `scripts/ui-transcript-render-test.mjs` 第 [3b]：思考行与工具卡的**展开态存档键用
 *   行的稳定身份**（`会话id:row.stable`，不再用直播期会漂的 entry.id / row.at）。原探针
 *   钉的是 render.tsx 里的模板串文本；这里行为化：真渲染一行 → 点开 → 存档落在那个键上。
 * - `scripts/ui-step-group-live-test.mjs` 第 [7] 渲染侧：过程正文走 `.entry-note`
 *   （小字灰行），带 `data-process-note` 标记。
 * - `scripts/ui-compaction-row-test.mjs` 第 [2] 的前半：system 分支**先**判压缩标记——
 *   行为化是「带 compaction 的 system 画分隔行，不把取证正文当普通灰字再画一遍」。
 * - `scripts/ui-row-isolation-test.mjs` 第 [4] 里能行为化的部分：座位壳（SeatFrame）
 *   与行体的订阅链——stage 之后第一帧就读得到数据、内容变了只通知那一行、props 没变
 *   的壳整帧重渲染时行体跟着跳过（renderSlot 计数）。原探针的 memo 形态钉
 *   （「谁被 memo」「props 里有没有 Row」）是类型/结构面，没有渲染层行为接缝，不迁。
 * - RowBoundary 的两条行为承诺（坏行显示原因不拖垮整条流、条目更新清错误再试）。
 *
 * @module dsc-ui-transcript/ui/rows-render.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Component, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { TranscriptEntry } from '@dsc/ui'
import { RuntimeProvider } from '@dsc/ui-runtime'
import { ShellCwdContext, ShellSessionContext, keyOf, type Row, type ToolViewRender } from './shared.js'
import { createSeatStore } from './seat-store.js'
import { clearFold, hasFold } from './fold-state.js'
import { RowBody, RowBoundary, SeatFrame } from './render.js'
import type { HostChannel } from '@dsc/ui-runtime'

/** 测试替身宿主通道（ToolCardView 的 intended hook 拿通道但不发调用）。 */
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

/** RowBody / SeatFrame 内部的 ToolRow 展开体不量高，无需桩；这里只挡意外（jsdom 无 ResizeObserver）。 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)

afterEach(() => {
  cleanup()
  clearFold('rrspec:think')
  clearFold('rrspec:tool')
  clearFold('rrspec:prompt')
})

let seq = 0
/** 造一条条目（kind + 该分支用得着的字段）。 */
const entryOf = (kind: TranscriptEntry['kind'], extra: object = {}): TranscriptEntry =>
  ({ kind, id: (seq += 1), ...extra }) as TranscriptEntry

/** 把条目包成一行（live / at / stable 由调用方挑）。 */
const rowOf = (entry: TranscriptEntry, over: Partial<Row> = {}): Row =>
  ({ entry, live: false, at: 1, stable: 'r0:text:0', ...over }) as Row

describe('内置行体按 kind 分流（RowBody）', () => {
  test('正文：markdown 进 .entry-text；直播行带 live 类', () => {
    const { container, rerender } = render(<RowBody row={rowOf(entryOf('text', { text: '**粗体**正文' }))} />)
    expect(container.querySelector('.entry-text strong')?.textContent).toBe('粗体')
    rerender(<RowBody row={rowOf(entryOf('text', { text: '直播中' }), { live: true })} />)
    expect((container.querySelector('.entry-text') as HTMLElement).classList.contains('live')).toBe(true)
  })

  test('过程正文（调工具前的前言）走 .entry-note + data-process-note（ui-step-group-live [7] 渲染侧）', () => {
    const { container } = render(
      <RowBody row={rowOf(entryOf('text', { text: '安装完成，启动做最后验证：', process: true }))} />,
    )
    const note = container.querySelector('[data-process-note]')
    expect(note).toBeTruthy()
    expect((note as HTMLElement).classList.contains('entry-note')).toBe(true)
    // 不是正文那套排场（.entry-text）。
    expect(container.querySelector('.entry-text')).toBeNull()
  })

  test('用户消息画气泡；internal 条目画唤醒卡（不冒充人打的字）', () => {
    const { container, rerender } = render(<RowBody row={rowOf(entryOf('user', { text: '帮我看看' }))} />)
    expect(container.querySelector('.user-turn')).toBeTruthy()
    rerender(<RowBody row={rowOf(entryOf('user', { text: '后台作业 job-1 成功完成。', internal: true }))} />)
    expect(container.querySelector('[data-internal="1"]')).toBeTruthy()
    expect(container.querySelector('.user-turn')).toBeNull()
  })

  test('压缩落点的 system 画分隔行，取证正文不再当灰字铺一遍（ui-compaction-row [2]）', () => {
    const { container } = render(
      <RowBody row={rowOf(entryOf('system', { text: '上下文接近模型上限，已自动压缩历史', compaction: { count: 2 } }))} />,
    )
    expect(container.querySelector('.entry-compaction')).toBeTruthy()
    expect((container.querySelector('.entry-compaction') as HTMLElement).getAttribute('data-compaction-count')).toBe('2')
    // 正文不画：对话流里读者要的是「这里断过」，不是再读一遍通知全文。
    expect(container.textContent).not.toContain('上下文接近模型上限')
    expect(container.querySelector('.entry-system')).toBeNull()
  })

  test('普通 system 通知仍是灰行；命令输出走左对齐等宽块', () => {
    const { container, rerender } = render(<RowBody row={rowOf(entryOf('system', { text: '这一轮被中断' }))} />)
    expect(container.querySelector('.entry-system')?.textContent).toBe('这一轮被中断')
    rerender(<RowBody row={rowOf(entryOf('system', { text: '/help 的十几行输出', command: true }))} />)
    expect(container.querySelector('.entry-system-command')).toBeTruthy()
  })

  test('正常收尾的 turn-end 不上屏；中断 / 跑挂显出一句', () => {
    const { container, rerender } = render(<RowBody row={rowOf(entryOf('turn-end', { reason: 'completed' }))} />)
    expect(container.firstChild).toBeNull()
    rerender(<RowBody row={rowOf(entryOf('turn-end', { reason: 'aborted' }))} />)
    expect(container.querySelector('.entry-system')).toBeTruthy()
    rerender(<RowBody row={rowOf(entryOf('turn-end', { reason: 'failed' }))} />)
    expect(container.querySelector('.entry-system')).toBeTruthy()
  })

  test('不上屏的条目（changes / turnDiff）返回空——它们聚合成轮尾卡', () => {
    const { container } = render(<RowBody row={rowOf(entryOf('changes', { file: { path: 'a.ts' } }))} />)
    expect(container.firstChild).toBeNull()
  })

  test('宿主加了新种类时显式说一句（不静悄悄少一块）', () => {
    const { container } = render(<RowBody row={rowOf({ kind: 'brand-new-kind', id: 1 } as unknown as TranscriptEntry)} />)
    const row = container.querySelector('.entry-system')
    expect(row).toBeTruthy()
    expect((row as HTMLElement).textContent).toContain('brand-new-kind')
  })
})

describe('展开态存档键用行的稳定身份（B33 [3b] 行为化）', () => {
  test('思考行：点开落在 `会话id:row.stable`，直播 → 定稿换 id 不换键', () => {
    const row = rowOf(entryOf('thinking', { text: '存档键的思考' }), { stable: 'r0:thinking:0' })
    const { container } = render(
      <ShellSessionContext.Provider value="sess1">
        <RowBody row={row} />
      </ShellSessionContext.Provider>,
    )
    expect(hasFold('sess1:r0:thinking:0')).toBe(false)
    fireEvent.click(container.querySelector('.think-head') as HTMLElement)
    // 键就是「会话 + 稳定身份」：条目 id（哪怕从负数换成正数）不参与。
    expect(hasFold('sess1:r0:thinking:0')).toBe(true)
    expect(hasFold('sess1:r0:thinking:1')).toBe(false)
  })

  test('工具卡同理：键取 callId 派生的稳定身份，不是 row.at', () => {
    const row = rowOf(
      entryOf('tool', { call: { callId: 'call-9', name: 'bash', argsText: '{"command":"ls"}', status: 'done' } }),
      { stable: 'r0:call:call-9', at: 7 },
    )
    const { container } = render(
      <RuntimeProvider channel={stubChannel()}>
        <ShellSessionContext.Provider value="sess1">
          <RowBody row={row} />
        </ShellSessionContext.Provider>
      </RuntimeProvider>,
    )
    fireEvent.click(container.querySelector('.tool-click') as HTMLElement)
    expect(hasFold('sess1:r0:call:call-9')).toBe(true)
    expect(hasFold('sess1:7')).toBe(false)
  })

  test('没有会话 id 时键以空串打头（宿主还没接上那一瞬也存得住）', () => {
    const row = rowOf(entryOf('thinking', { text: '没会话的思考' }), { stable: 'r0:thinking:0' })
    const { container } = render(<RowBody row={row} />)
    fireEvent.click(container.querySelector('.think-head') as HTMLElement)
    expect(hasFold(':r0:thinking:0')).toBe(true)
  })
})

describe('RowBoundary：行级错误边界', () => {
  /** 说崩就崩的子树（边界测试的受控故障源）。 */
  class Thrower extends Component<{ fail: boolean }, {}> {
    render(): ReactNode {
      if (this.props.fail) throw new Error('boom')
      return <div data-testid="fine">好的</div>
    }
  }

  test('一行渲染崩了显示原因，不把外层拖垮', () => {
    const entry = entryOf('text', { text: '占位' })
    const { container } = render(
      <RowBoundary entry={entry}>
        <Thrower fail={true} />
      </RowBoundary>,
    )
    const failed = container.querySelector('.entry-system')
    expect(failed).toBeTruthy()
    expect((failed as HTMLElement).textContent).toContain('boom')
  })

  test('条目更新时清掉错误再试一次（工具卡从跑动到完成是同一个条目换数据）', () => {
    const first = entryOf('text', { text: '第一版' })
    const second = entryOf('text', { text: '第二版' })
    const { container, rerender } = render(
      <RowBoundary entry={first}>
        <Thrower fail={true} />
      </RowBoundary>,
    )
    expect(container.querySelector('.entry-system')).toBeTruthy()
    // 同一层子树、条目换了新对象：边界清错误，子树重新挂出来。
    rerender(
      <RowBoundary entry={second}>
        <Thrower fail={false} />
      </RowBoundary>,
    )
    expect(container.querySelector('.entry-system')).toBeNull()
    expect(container.querySelector('[data-testid="fine"]')).toBeTruthy()
  })
})

describe('座位壳与行体的订阅链（ui-row-isolation [4] 的行为面）', () => {
  /** 一个前导行 + 一轮一行的座位数据。 */
  const stageOne = (store: ReturnType<typeof createSeatStore>, row: Row, sessionKey = 'sess1'): void => {
    store.stage(sessionKey, {
      leading: [],
      rounds: [{ rows: [row] }],
    })
  }

  test('stage 之后第一帧就读得到数据（新挂载的行不会先画一帧空）', () => {
    const store = createSeatStore(keyOf)
    const row = rowOf(entryOf('text', { text: '首帧就有' }))
    stageOne(store, row)
    const { container } = render(
      <SeatFrame
        seatKey={keyOf(row, 'sess1')}
        hidden={false}
        roundIndex={0}
        onReveal={() => undefined}
        store={store}
        renderSlot={undefined}
      />,
    )
    expect(container.textContent).toContain('首帧就有')
  })

  test('内容变了只重渲染那一行（renderSlot 计数）；没变的帧行体一次都不进', () => {
    const store = createSeatStore(keyOf)
    // vi.fn 本体留着数调用；递给 SeatFrame 时按槽渲染的口径断言。
    const renderSlot = vi.fn((_slot: unknown, _owner: unknown, fallback: ReactNode) => fallback)
    const row = rowOf(entryOf('text', { text: '第一版' }))
    stageOne(store, row)
    act(() => {
      store.commit()
    })
    const { rerender } = render(
      <SeatFrame
        seatKey={keyOf(row, 'sess1')}
        hidden={false}
        roundIndex={0}
        onReveal={() => undefined}
        store={store}
        renderSlot={renderSlot as unknown as ToolViewRender}
      />,
    )
    const afterMount = renderSlot.mock.calls.length
    // 父级整帧重渲染（props 一个没变：壳是 memo 的，行体连函数体都不进）。
    rerender(
      <SeatFrame
        seatKey={keyOf(row, 'sess1')}
        hidden={false}
        roundIndex={0}
        onReveal={() => undefined}
        store={store}
        renderSlot={renderSlot as unknown as ToolViewRender}
      />,
    )
    expect(renderSlot.mock.calls.length).toBe(afterMount)
    // 全量锚帧（新对象、同内容）：注册表复用旧 Row → 快照不变 → 行体仍不重渲染。
    // 全量锚帧：宿主每 50 帧发一次，条目是新对象但内容逐字相同（id 一致）——必须算没变。
    stageOne(store, rowOf({ ...row.entry }, { stable: 'r0:text:0' }))
    act(() => {
      store.commit()
    })
    expect(renderSlot.mock.calls.length).toBe(afterMount)
    // 内容真的变了：注册表只通知这一格，行体重渲染恰好一次。
    stageOne(store, rowOf(entryOf('text', { text: '第二版' }), { stable: 'r0:text:0' }))
    act(() => {
      store.commit()
    })
    expect(renderSlot.mock.calls.length).toBe(afterMount + 1)
  })

  test('hidden 真盒子：收起的行挂 hidden="until-found"（Ctrl+F 命中的落点）', () => {
    const store = createSeatStore(keyOf)
    const row = rowOf(entryOf('text', { text: '被藏的一行' }))
    stageOne(store, row)
    const { container } = render(
      <SeatFrame
        seatKey={keyOf(row, 'sess1')}
        hidden={true}
        roundIndex={3}
        onReveal={() => undefined}
        store={store}
        renderSlot={undefined}
      />,
    )
    const box = container.querySelector('.entry-row') as HTMLElement
    expect(box.getAttribute('hidden')).toBe('until-found')
    expect(box.getAttribute('data-round')).toBe('3')
  })

  test('这一帧没登记的行（被分页切走）：行体读不到数据，画空', () => {
    const store = createSeatStore(keyOf)
    const row = rowOf(entryOf('text', { text: '将被切走的行' }))
    stageOne(store, row)
    store.commit()
    // 下一帧没有它：格子连订阅位一起被摘掉（seat-store.spec 钉过），行体拿 undefined。
    store.stage('sess1', { leading: [], rounds: [{ rows: [] }] })
    store.commit()
    const { container } = render(
      <SeatFrame
        seatKey={keyOf(row, 'sess1')}
        hidden={false}
        roundIndex={0}
        onReveal={() => undefined}
        store={store}
        renderSlot={undefined}
      />,
    )
    expect(container.querySelector('.entry-row')).toBeTruthy()
    expect(container.textContent).not.toContain('将被切走的行')
  })
})

describe('cwd 的 context 注入面', () => {
  test('ShellCwdContext 从这里递进正文行（相对路径链接按会话工作目录拼）', () => {
    const { container } = render(
      <ShellCwdContext.Provider value="D:/workdir">
        <RowBody row={rowOf(entryOf('text', { text: '看 [readme.md](readme.md)' }))} />
      </ShellCwdContext.Provider>,
    )
    // 相对路径没登记 opener 时画成平文本（不点出空 href）——cwd 的行为面在
    // think-text.spec 里带着 opener 验过，这里只钉「正文行也吃同一个 context」。
    expect(container.querySelector('.entry-text')).toBeTruthy()
  })
})
