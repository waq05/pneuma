/**
 * 轮折叠行的补盲（`packages/ui-transcript/ui/round-fold.tsx`）：
 * - `TurnFoldRow` 的键盘开合（Enter / 空格才算，其它键不响应）；
 * - `useFoldMemory` 的 `clear` / `clearPrefixes`：抹掉存档而不是写值，缺键时跳过。
 *
 * @module dsc/packages/ui-transcript/ui/w12-round-fold.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { RoundInfo } from './timing.js'
import { TurnFoldRow, useFoldMemory } from './round-fold.js'

afterEach(() => {
  cleanup()
})

const roundOf = (index: number): RoundInfo =>
  ({ index, startIndex: 0, endIndex: 1, startTs: 1, endTs: 2, answered: true }) as RoundInfo

describe('TurnFoldRow 的键盘开合', () => {
  test('Enter 与空格触发 onToggle，其它键不响应', () => {
    const onToggle = vi.fn()
    render(<TurnFoldRow open={false} round={roundOf(0)} disabled={false} endReason={undefined} onToggle={onToggle} />)
    const button = screen.getByRole('button')
    fireEvent.keyDown(button, { key: 'a' })
    expect(onToggle).not.toHaveBeenCalled()
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(onToggle).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(button, { key: ' ' })
    expect(onToggle).toHaveBeenCalledTimes(2)
  })
})

/** 把 hook 的四个方法交出来，测试里直接驱动。 */
function mountMemory(): {
  memory: ReturnType<typeof useFoldMemory>
} {
  let memory!: ReturnType<typeof useFoldMemory>
  function Probe(): ReactNode {
    memory = useFoldMemory()
    return null
  }
  render(<Probe />)
  return {
    get memory() {
      return memory
    },
  } as { memory: ReturnType<typeof useFoldMemory> }
}

describe('useFoldMemory：抹掉存档', () => {
  test('clear 抹掉已有键；没有的键跳过', () => {
    const harness = mountMemory()
    act(() => {
      harness.memory.set('sess:r1:a', true)
      harness.memory.set('sess:r1:b', false)
    })
    expect(harness.memory.open('sess:r1:a', false)).toBe(true)
    act(() => {
      harness.memory.clear(['sess:r1:a', 'sess:never'])
    })
    // 抹掉之后由兜底决定（这里兜底给 false）。
    expect(harness.memory.open('sess:r1:a', false)).toBe(false)
    // 其它键没被连带清掉。
    expect(harness.memory.open('sess:r1:b', true)).toBe(false)
  })

  test('clearPrefixes 按前缀抹掉一批，别的前缀不动', () => {
    const harness = mountMemory()
    act(() => {
      harness.memory.set('sess:r1:a', true)
      harness.memory.set('sess:step:r1:a', true)
      harness.memory.set('sess:r2:a', true)
    })
    act(() => {
      harness.memory.clearPrefixes(['sess:step:r1'])
    })
    expect(harness.memory.open('sess:step:r1:a', false)).toBe(false)
    // 前缀没命中的键不动（'sess:r1:a' 不以 'sess:step:r1' 开头）。
    expect(harness.memory.open('sess:r1:a', false)).toBe(true)
    // 再按另一条前缀抹：命中 r1 那批，r2 留着。
    act(() => {
      harness.memory.clearPrefixes(['sess:r1'])
    })
    expect(harness.memory.open('sess:r1:a', false)).toBe(false)
    expect(harness.memory.open('sess:r2:a', false)).toBe(true)
  })
})
