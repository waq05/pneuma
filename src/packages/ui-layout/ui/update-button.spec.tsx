/**
 * 品牌行「更新」按钮（`update-button.tsx`）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-update-button-test.mjs` 整条（缺口清单 B37）。原探针钉 `update-button.tsx`
 * 的源码文本、`app.tsx` 的 `<UpdateButton />` 位置与产物；这里真渲染组件 + 假原生桥：
 * - 只有 `available` 才出现；浏览器 / 远程（没有桥）整块不渲染；
 * - 挂载时问一次 `checkUpdate`，同时订阅 `update-status` / `update-progress`（两种取数都要）；
 * - 点下去走 `installUpdate`，下载进度画百分比，失败退回可点并把原因挂上；
 * - 卸载时两条订阅都退掉。
 *
 * 不迁的：「挂在品牌行 Pneuma 右边、收起钮左边」是 `app.tsx` 的 JSX 顺序文本钉（渲染整屏
 * 才能验，收益低于成本）；第 [6] 段产物审计与第 [7] 段 CSS（`no-drag` / 令牌）归产物批与
 * shots。第 [5] 段设置页「关于」的立即更新入口是另一个组件，行为在设置侧，未在本批白名单。
 *
 * @module dsc-ui-layout/ui/update-button.spec
 */
import { afterEach, describe, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { UpdateButton } from './update-button.js'

type UpdateButtonComponent = typeof UpdateButton

interface Bridge {
  calls: { op: string; args: unknown[] }[]
  emit(event: string, data: unknown): void
  offs: Record<string, number>
}

/** 装一座假原生桥（桌面窗口 preload 暴露的形状）。 */
function installBridge(replies: Record<string, () => Promise<unknown>> = {}): Bridge {
  const listeners = new Map<string, (data: unknown) => void>()
  const offs: Record<string, number> = {}
  const calls: { op: string; args: unknown[] }[] = []
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (op: string, args: unknown[] = []) => {
      calls.push({ op, args })
      return (replies[op] ?? (() => Promise.resolve({ ok: true })))()
    },
    on: (event: string, listener: (data: unknown) => void) => {
      listeners.set(event, listener)
      return () => {
        offs[event] = (offs[event] ?? 0) + 1
      }
    },
  }
  return {
    calls,
    offs,
    emit(event, data) {
      listeners.get(event)?.(data)
    },
  }
}

/** 组件从模块里 import；`useHostNative` 每次调用都重读全局，所以桥可以在 import 前后装。 */
async function loadButton(): Promise<UpdateButtonComponent> {
  return (await import('./update-button.js')).UpdateButton
}

const query = (container: HTMLElement): HTMLButtonElement | null =>
  container.querySelector('.update-btn') as HTMLButtonElement | null

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

afterEach(() => {
  cleanup()
  delete (globalThis as { dscNative?: unknown }).dscNative
})

describe('只有真有新版才出现（[1][2]）', () => {
  test('没有原生桥（浏览器 / 远程页）整块不渲染，也不问 checkUpdate', async () => {
    const UpdateButton = await loadButton()
    const { container } = render(<UpdateButton />)
    await flush()
    expect(query(container)).toBeNull()
  })

  test('桥在但状态不是 available：不出现', async () => {
    const bridge = installBridge({ checkUpdate: () => Promise.resolve({ status: 'latest' }) })
    const UpdateButton = await loadButton()
    const { container } = render(<UpdateButton />)
    await flush()
    expect(query(container)).toBeNull()
    expect(bridge.calls.some((call) => call.op === 'checkUpdate')).toBe(true)
  })

  test('available：按钮出现，带版本号与「更新」文案', async () => {
    installBridge({ checkUpdate: () => Promise.resolve({ status: 'available', version: '1.2.3', size: 2_500_000 }) })
    const UpdateButton = await loadButton()
    const { container } = render(<UpdateButton />)
    await flush()
    const button = query(container)
    expect(button).toBeTruthy()
    expect(button?.getAttribute('data-update-version')).toBe('1.2.3')
    expect(button?.textContent).toBe('更新')
    expect(button?.getAttribute('title')).toContain('1.2.3')
    expect(button?.getAttribute('title')).toContain('2.4 MB')
  })
})

describe('两种取数都要：问一次 + 订阅（[3]）', () => {
  test('挂载时问过一次；之后 update-status 推来 available 也能出现', async () => {
    const bridge = installBridge({ checkUpdate: () => Promise.resolve({ status: 'latest' }) })
    const UpdateButton = await loadButton()
    const { container } = render(<UpdateButton />)
    await flush()
    expect(query(container)).toBeNull()
    await act(async () => {
      bridge.emit('update-status', { status: 'available', version: '9.9.9' })
      await Promise.resolve()
    })
    expect(query(container)?.getAttribute('data-update-version')).toBe('9.9.9')
  })

  test('卸载时两条订阅都退掉', async () => {
    const bridge = installBridge({ checkUpdate: () => Promise.resolve({ status: 'latest' }) })
    const UpdateButton = await loadButton()
    const { unmount } = render(<UpdateButton />)
    await flush()
    unmount()
    expect(bridge.offs['update-status']).toBe(1)
    expect(bridge.offs['update-progress']).toBe(1)
  })
})

describe('点击走 installUpdate 并画进度（[4]）', () => {
  test('点下去：调 installUpdate、按钮禁用、先显示「更新中」，进度到了画百分比', async () => {
    let resolveInstall: (value: unknown) => void = () => undefined
    const bridge = installBridge({
      checkUpdate: () => Promise.resolve({ status: 'available', version: '1.2.3' }),
      installUpdate: () =>
        new Promise((resolve) => {
          resolveInstall = resolve
        }),
    })
    const UpdateButton = await loadButton()
    const { container } = render(<UpdateButton />)
    await flush()
    const button = query(container) as HTMLButtonElement
    await act(async () => {
      fireEvent.click(button)
      await Promise.resolve()
    })
    expect(bridge.calls.some((call) => call.op === 'installUpdate')).toBe(true)
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('更新中')
    await act(async () => {
      bridge.emit('update-progress', { received: 42, total: 100, percent: 42 })
      await Promise.resolve()
    })
    expect(button.textContent).toBe('42%')
    await act(async () => {
      resolveInstall({ ok: true })
      await Promise.resolve()
    })
  })

  test('失败退回可点，并把原因挂到 title 上（不静默）', async () => {
    installBridge({
      checkUpdate: () => Promise.resolve({ status: 'available', version: '1.2.3' }),
      installUpdate: () => Promise.resolve({ ok: false, error: '下载失败：网络断了' }),
    })
    const UpdateButton = await loadButton()
    const { container } = render(<UpdateButton />)
    await flush()
    const button = query(container) as HTMLButtonElement
    await act(async () => {
      fireEvent.click(button)
      await Promise.resolve()
    })
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('更新')
    expect(button.getAttribute('title')).toBe('下载失败：网络断了')
  })
})
