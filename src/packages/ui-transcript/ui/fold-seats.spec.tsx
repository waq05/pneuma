/**
 * 两个折叠座位（`fold-seats.tsx` 的 RowSeat / StepGroupSeat）与 `useSearchableHidden` 的
 * 行为面（ui 层，真渲染）。
 *
 * 来源（缺口清单 B33 [3b] / [5]、B34 ui-fold-combo [3] 的「hidden 真挂上才调」那组源码
 * 顺序钉）：原探针在 seatsSrc 里数 `closeGroup()` 出现次数、验 onHidden 夹在 setAttribute
 * 与 removeAttribute 之间——那条时序本来就有**渲染层行为接缝**，这里真渲染出来验：
 *  - `hidden` 挂上那一拍才调 `onHidden` / 关组；展开那一拍（含放行）不调；
 *  - 焦点落在将要收起的子树里时先放行（不藏）——键盘用户的地板不被抽掉；
 *  - `beforematch`（浏览器查找命中）把这一层放出来；
 *  - 关组只有 turnHidden 一处入口的行为后果：`onTurnClosed`（清存档）与 `onTurnHidden`
 *    （抹成员存档）都只在真挂上 `hidden` 的那一拍发生。
 *
 * 动画期（fold-motion 的批次末帧）在 jsdom 没有布局接缝（量高恒 0，全部走同步提交分支），
 * 逐帧顺序仍留探针；这份钉的是同步提交路径上的时机与判据。
 *
 * @module dsc-ui-transcript/ui/fold-seats.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { clearFold, hasFold, writeFold } from './fold-state.js'
import { FoldResetContext } from './fold-hook.js'
import { RowSeat, StepGroupSeat } from './fold-seats.js'
import type { StepGroup } from './process-groups.js'

afterEach(() => {
  cleanup()
  clearFold('fsspec:row')
  clearFold('fsspec:member')
  clearFold('fsspec:group')
})

/** 造一个已定稿的组（字段够 StepGroupSeat / StepGroupRow 用）。 */
const groupOf = (over: Partial<StepGroup> = {}): StepGroup =>
  ({
    roundIndex: 0,
    seq: 0,
    startIndex: 1,
    endIndex: 2,
    size: 2,
    members: [1, 2],
    counts: [{ kind: 'commands', count: 2 }],
    failures: 0,
    closed: true,
    ...over,
  }) as StepGroup

describe('RowSeat：hidden 的挂 / 摘时机（B33 [3b] 行为化）', () => {
  test('hidden=true 挂上 until-found、翻回 false 摘掉；属性只在真需要时增删', () => {
    writeFold('fsspec:row', false) // 造一份手动存档（收起），观察挂 hidden 那一拍它被抹掉
    const { container, rerender } = render(
      <RowSeat hidden={false} onReveal={() => undefined} roundIndex={0} foldStoreKey="fsspec:row">
        <div>正文</div>
      </RowSeat>,
    )
    expect(container.querySelector('.entry-row[hidden]')).toBeNull()
    expect(hasFold('fsspec:row')).toBe(true)
    rerender(
      <RowSeat hidden={true} onReveal={() => undefined} roundIndex={0} foldStoreKey="fsspec:row">
        <div>正文</div>
      </RowSeat>,
    )
    expect((container.querySelector('.entry-row') as HTMLElement).getAttribute('hidden')).toBe('until-found')
    // onHidden 只在真挂上 hidden 的那一拍跑：抹存档与挂属性是同一拍的事。
    expect(hasFold('fsspec:row')).toBe(false)
    // 展开那一拍：属性摘掉、存档不会复写回去（复位不是用户的选择）。
    rerender(
      <RowSeat hidden={false} onReveal={() => undefined} roundIndex={0} foldStoreKey="fsspec:row">
        <div>正文</div>
      </RowSeat>,
    )
    expect(container.querySelector('.entry-row[hidden]')).toBeNull()
    expect(hasFold('fsspec:row')).toBe(false)
  })

  test('真挂上 hidden 那一拍抹掉这一行的展开存档并推进复位代次（onHidden 的另一半）', () => {
    writeFold('fsspec:row', true)
    let bumps = 0
    const reset = {
      subscribe: (): (() => void) => () => undefined,
      getSnapshot: () => bumps,
    }
    const owner = { ...reset, bump: (): void => {
      bumps += 1
    } }
    const { rerender } = render(
      <FoldResetContext.Provider value={owner}>
        <RowSeat hidden={false} onReveal={() => undefined} roundIndex={0} foldStoreKey="fsspec:row">
          <div>正文</div>
        </RowSeat>
      </FoldResetContext.Provider>,
    )
    expect(hasFold('fsspec:row')).toBe(true)
    rerender(
      <FoldResetContext.Provider value={owner}>
        <RowSeat hidden={true} onReveal={() => undefined} roundIndex={0} foldStoreKey="fsspec:row">
          <div>正文</div>
        </RowSeat>
      </FoldResetContext.Provider>,
    )
    // 存档抹掉了（收起整轮不是用户的手动选择）；代次推进让已挂载的行当场回默认态。
    expect(hasFold('fsspec:row')).toBe(false)
    expect(bumps).toBe(1)
  })

  test('焦点落在将收起的子树里：先放行（不藏）——自动收起不抽键盘用户脚下的地板', () => {
    const reveal = vi.fn()
    const { container } = render(
      <RowSeat hidden={true} onReveal={reveal} roundIndex={0}>
        <button type="button">里面</button>
      </RowSeat>,
    )
    ;(container.querySelector('button') as HTMLElement).focus()
    // hidden 变化的 effect 在挂载已跑过一轮（此时焦点不在里面）；触发一次重新判定。
    const { rerender } = render(
      <RowSeat hidden={false} onReveal={reveal} roundIndex={0}>
        <button type="button">里面</button>
      </RowSeat>,
      { container },
    )
    ;(container.querySelector('button') as HTMLElement).focus()
    rerender(
      <RowSeat hidden={true} onReveal={reveal} roundIndex={0}>
        <button type="button">里面</button>
      </RowSeat>,
    )
    expect(reveal).toHaveBeenCalled()
    expect(container.querySelector('.entry-row[hidden]')).toBeNull()
  })

  test('beforematch（Ctrl+F 命中）把这一层放出来', () => {
    const reveal = vi.fn()
    const { container } = render(
      <RowSeat hidden={true} onReveal={reveal} roundIndex={0}>
        <div>被藏的正文</div>
      </RowSeat>,
    )
    expect(container.querySelector('.entry-row[hidden]')).toBeTruthy()
    container.querySelector('.entry-row')?.dispatchEvent(new Event('beforematch'))
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  test('data-round 写轮序号（刻度条按它做命中测试）', () => {
    const { container } = render(
      <RowSeat hidden={false} onReveal={() => undefined} roundIndex={4}>
        <div>正文</div>
      </RowSeat>,
    )
    expect((container.querySelector('.entry-row') as HTMLElement).getAttribute('data-round')).toBe('4')
  })
})

describe('StepGroupSeat：关组只有 turnHidden 一处入口（B33 [3b] 的批次级判定）', () => {
  test('整轮收起真挂上 hidden 的那一拍：关组 + 清这组存档 + 抹成员存档 + 推代次，顺序一次到位', () => {
    const onTurnHidden = vi.fn()
    const onTurnClosed = vi.fn()
    const onToggle = vi.fn()
    writeFold('fsspec:member', true)
    writeFold('fsspec:group', true)
    const { container, rerender } = render(
      <StepGroupSeat
        group={groupOf()}
        turnCollapsed={false}
        open={true}
        showDetail={false}
        onToggle={onToggle}
        onRevealTurn={() => undefined}
        onTurnHidden={onTurnHidden}
        onTurnClosed={onTurnClosed}
      >
        <div>组体</div>
      </StepGroupSeat>,
    )
    // 展开中的整轮翻成收起：组座位在 hidden 真挂上的那一拍关组。
    rerender(
      <StepGroupSeat
        group={groupOf()}
        turnCollapsed={true}
        open={true}
        showDetail={false}
        onToggle={onToggle}
        onRevealTurn={() => undefined}
        onTurnHidden={onTurnHidden}
        onTurnClosed={onTurnClosed}
      >
        <div>组体</div>
      </StepGroupSeat>,
    )
    const seat = container.querySelector('.step-seat') as HTMLElement
    expect(seat.getAttribute('hidden')).toBe('until-found')
    // 关组 / 抹成员存档都只在这一拍发生（hidden 真挂上，不是「应该收起」）。
    expect(onTurnClosed).toHaveBeenCalledTimes(1) // 这组自己的存档清掉（复位成兜底，不写「手动收起」）
    expect(onTurnHidden).toHaveBeenCalledTimes(1) // 调用方抹组内行的展开存档（render 层的事， spy 收调用即验时机）
    // 收起态稳定下来（再来一帧 turnCollapsed 仍 true）：幂等，不重复关。
    rerender(
      <StepGroupSeat
        group={groupOf()}
        turnCollapsed={true}
        open={true}
        showDetail={false}
        onToggle={onToggle}
        onRevealTurn={() => undefined}
        onTurnHidden={onTurnHidden}
        onTurnClosed={onTurnClosed}
      >
        <div>组体</div>
      </StepGroupSeat>,
    )
    expect(onTurnClosed).toHaveBeenCalledTimes(1)
    expect(onTurnHidden).toHaveBeenCalledTimes(1)
  })

  test('这一组自己收起（open=false）只藏组体，组头永远看得见', () => {
    const { container } = render(
      <StepGroupSeat
        group={groupOf()}
        turnCollapsed={false}
        open={false}
        showDetail={false}
        onToggle={() => undefined}
        onRevealTurn={() => undefined}
        onTurnHidden={() => undefined}
        onTurnClosed={() => undefined}
      >
        <div>组体</div>
      </StepGroupSeat>,
    )
    expect((container.querySelector('.step-seat') as HTMLElement).hasAttribute('hidden')).toBe(false)
    expect((container.querySelector('.step-body') as HTMLElement).getAttribute('hidden')).toBe('until-found')
    expect(container.querySelector('.step-fold')).toBeTruthy()
  })

  test('组头点击开合（focus 先落组头再开合——键盘用户不丢位置）', () => {
    const onToggle = vi.fn()
    const { container } = render(
      <StepGroupSeat
        group={groupOf()}
        turnCollapsed={false}
        open={false}
        showDetail={false}
        onToggle={onToggle}
        onRevealTurn={() => undefined}
        onTurnHidden={() => undefined}
        onTurnClosed={() => undefined}
      >
        <div>组体</div>
      </StepGroupSeat>,
    )
    const head = container.querySelector('.step-fold') as HTMLElement
    fireEvent.click(head)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(head)
  })

  test('组体的 beforematch（命中正文里的具体一行）把组展开', () => {
    const onToggle = vi.fn()
    const { container } = render(
      <StepGroupSeat
        group={groupOf()}
        turnCollapsed={false}
        open={false}
        showDetail={false}
        onToggle={onToggle}
        onRevealTurn={() => undefined}
        onTurnHidden={() => undefined}
        onTurnClosed={() => undefined}
      >
        <div>组体正文</div>
      </StepGroupSeat>,
    )
    container.querySelector('.step-body')?.dispatchEvent(new Event('beforematch'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  test('跑动中的组头带实时详情（showDetail 档位），收口的组只报聚合（ui-step-group-live [5] 渲染侧）', () => {
    const running = groupOf({ closed: false, running: 'commands', runningDetail: 'pnpm build' })
    const settled = groupOf()
    const open = render(
      <StepGroupSeat
        group={running}
        turnCollapsed={false}
        open={false}
        showDetail={true}
        onToggle={() => undefined}
        onRevealTurn={() => undefined}
        onTurnHidden={() => undefined}
        onTurnClosed={() => undefined}
      >
        <div>组体</div>
      </StepGroupSeat>,
    )
    const head = open.container.querySelector('.step-fold') as HTMLElement
    expect(head.getAttribute('data-step-detail')).toBe('pnpm build')
    // 同一组收口后（closed=true）：详情收走，只有聚合标题。
    const closed = render(
      <StepGroupSeat
        group={settled}
        turnCollapsed={false}
        open={false}
        showDetail={true}
        onToggle={() => undefined}
        onRevealTurn={() => undefined}
        onTurnHidden={() => undefined}
        onTurnClosed={() => undefined}
      >
        <div>组体</div>
      </StepGroupSeat>,
    )
    expect((closed.container.querySelector('.step-fold') as HTMLElement).hasAttribute('data-step-detail')).toBe(false)
  })

  test('紧凑档（showDetail=false）即使跑动中也不带实时详情', () => {
    const running = groupOf({ closed: false, running: 'commands', runningDetail: 'pnpm build' })
    const { container } = render(
      <StepGroupSeat
        group={running}
        turnCollapsed={false}
        open={false}
        showDetail={false}
        onToggle={() => undefined}
        onRevealTurn={() => undefined}
        onTurnHidden={() => undefined}
        onTurnClosed={() => undefined}
      >
        <div>组体</div>
      </StepGroupSeat>,
    )
    expect((container.querySelector('.step-fold') as HTMLElement).hasAttribute('data-step-detail')).toBe(false)
  })
})
