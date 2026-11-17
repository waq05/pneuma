/**
 * 文件预览（`ui-preview/ui/ui.tsx`）的渲染与交互段（ui 层，真渲染）。
 *
 * 预览页签不直接导出：照壳装载插件那条路 `apply` 一次，再从页签报名表里取回
 * `preview` / `patch` 两种页签体。这里钉的是「没有路径不读盘、读取中与结果的分流、
 * 读失败写成人话、相对路径按 cwd 裁、系统打开走原生桥并回报失败」。
 *
 * 刻意避开 markdown / 代码 / PDF 那几条重渲染分支：它们的行为落在 `@dsc/ui` 的
 * 平台组件上，本文件的账是预览页签自己的分流与状态。
 *
 * @module dsc-ui-preview/ui/ui.spec
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { dockTabMeta } from '@dsc/ui-dockkit'
import type { DockTabBodyProps, HostSnapshot, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

/** 插件 `apply` 会把两种页签报名进壳的报名表；测试结束一起退掉，不留给别的用例。 */
const offPlugin = plugin.apply({} as UiPluginApi) as () => void

const PreviewTab = dockTabMeta('preview')?.component
const PatchTab = dockTabMeta('patch')?.component
if (PreviewTab === undefined || PatchTab === undefined) {
  throw new Error('preview 插件没有报名 preview / patch 两种页签')
}

afterAll(() => {
  offPlugin()
})

interface Invoke {
  method: string
  args: unknown[]
}

interface Harness {
  channel: HostChannel
  calls: Invoke[]
}

/** `fs-read` 回来的一份结果（只列本 spec 用到的字段）。 */
interface ReadResult {
  path: string
  kind: 'text' | 'image' | 'bytes' | 'binary'
  mime?: string
  base64?: string
  text?: string
  size?: number
  tooLarge: boolean
}

/**
 * 假宿主：只有 `dock` 的 `fs-read` 有语义，记录每次调用的方法名与实参。
 * `read` 直接返回 Promise，测试可以给一个待决 promise 来观察「读取中」。
 */
function harnessOf(read: (args: unknown[]) => Promise<unknown>): Harness {
  const calls: Invoke[] = []
  const channel: HostChannel = {
    getSnapshot: () =>
      ({ status: { cwd: 'C:/repo', turnState: 'idle' } }) as unknown as HostSnapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      if (method === 'dock') return read(args) as Promise<T>
      return Promise.resolve({} as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

const tab = (path?: string): DockTabBodyProps['tab'] => ({
  id: 'tab-1',
  kind: 'preview',
  ...(path === undefined ? {} : { path }),
})

const mount = (
  harness: Harness,
  Component: NonNullable<typeof PreviewTab>,
  bodyTab: DockTabBodyProps['tab'],
): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <Component tab={bodyTab} active expanded />
    </RuntimeProvider>,
  )

/** 让挂载后的 invoke `.then` 落地。 */
const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''

/** 一个可控 promise：先看到「读取中」，再手动给结果。 */
function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((fulfil) => {
    resolve = fulfil
  })
  return { promise, resolve }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  delete (globalThis as { dscNative?: unknown }).dscNative
  localStorage.clear()
})

describe('预览页签：空态、加载与错误', () => {
  test('页签没有路径：给可操作的说明，不向宿主发读请求', () => {
    const harness = harnessOf(() => Promise.resolve(null))
    const { container } = mount(harness, PreviewTab, tab())

    expect(textOf(container.querySelector('.file-preview-empty'))).toContain('这张预览页签没有文件路径')
    expect(harness.calls).toHaveLength(0)
  })

  test('等待读盘时显示「读取中」；结果过大按大小给占位，读请求带 { file }', async () => {
    const result = deferred()
    const harness = harnessOf(() => result.promise)
    const { container } = mount(harness, PreviewTab, tab('C:/repo/big.bin'))

    expect(textOf(container.querySelector('.file-preview-empty'))).toContain('读取中')
    expect(harness.calls).toEqual([{ method: 'dock', args: ['fs-read', { file: 'C:/repo/big.bin' }] }])

    await act(async () => {
      result.resolve({ path: 'C:/repo/big.bin', kind: 'binary', size: 10 * 1024 * 1024, tooLarge: true })
      await Promise.resolve()
    })

    const empty = container.querySelector('.file-preview-empty')
    expect(textOf(empty)).toContain('文件过大')
    expect(textOf(empty)).toContain('10 MB')
    expect(textOf(container.querySelector('.file-preview-body'))).not.toContain('读取中')
  })

  test('读失败：原因写在树的提示条里，不再显示「读取中」', async () => {
    const harness = harnessOf(() => Promise.reject(new Error('EACCES')))
    const { container } = mount(harness, PreviewTab, tab('C:/repo/secret.txt'))
    await flush()

    expect(textOf(container.querySelector('.tree-note'))).toContain('读文件失败：EACCES')
    expect(container.querySelector('.file-preview-empty')).toBeNull()
  })
})

describe('预览页签：分流与原生打开', () => {
  test('图片按 data URI 画出来；路径按 cwd 裁成相对路径，无原生桥时系统打开禁用', async () => {
    const read: ReadResult = {
      path: 'C:/repo/pic.png',
      kind: 'image',
      mime: 'image/png',
      base64: 'QUJD',
      size: 3,
      tooLarge: false,
    }
    const harness = harnessOf(() => Promise.resolve(read))
    const { container } = mount(harness, PreviewTab, tab('C:/repo/pic.png'))
    await flush()

    const image = container.querySelector('.file-preview-img img') as HTMLImageElement
    expect(image.getAttribute('src')).toBe('data:image/png;base64,QUJD')
    expect(image.getAttribute('alt')).toBe('C:/repo/pic.png')
    expect(textOf(container.querySelector('.file-preview-path'))).toContain('pic.png')

    const system = [...container.querySelectorAll('button')].find(
      (button) => textOf(button) === '系统打开',
    ) as HTMLButtonElement
    expect(system.disabled).toBe(true)
  })

  test('二进制文件给大小占位，不带「折行」开关', async () => {
    const harness = harnessOf(() =>
      Promise.resolve({ path: 'C:/repo/blob.bin', kind: 'binary', size: 42, tooLarge: false }),
    )
    const { container } = mount(harness, PreviewTab, tab('C:/repo/blob.bin'))
    await flush()

    expect(textOf(container.querySelector('.file-preview-empty'))).toBe('二进制文件（42 B），暂不支持预览。')
    expect(container.querySelector('.file-preview-wrap')).toBeNull()
  })

  test('有原生桥时点「系统打开」调 openPath；失败把原因写进提示条', async () => {
    const nativeCalls: Array<{ op: string; args: unknown[] }> = []
    ;(globalThis as { dscNative?: unknown }).dscNative = {
      version: 1,
      call: (op: string, args: unknown[] = []): Promise<unknown> => {
        nativeCalls.push({ op, args })
        return Promise.reject(new Error('no opener'))
      },
      on: () => () => undefined,
    }
    const harness = harnessOf(() =>
      Promise.resolve({ path: 'C:/repo/blob.bin', kind: 'binary', size: 7, tooLarge: false }),
    )
    const { container } = mount(harness, PreviewTab, tab('C:/repo/blob.bin'))
    await flush()

    const system = [...container.querySelectorAll('button')].find(
      (button) => textOf(button) === '系统打开',
    ) as HTMLButtonElement
    expect(system.disabled).toBe(false)
    fireEvent.click(system)
    await flush()

    expect(nativeCalls).toEqual([{ op: 'openPath', args: ['C:/repo/blob.bin'] }])
    expect(textOf(container.querySelector('.tree-note'))).toContain('打不开：no opener')
  })
})

describe('补丁页签：无路径与快照过期', () => {
  test('补丁页签没有路径：给补丁专属的空态文案', () => {
    const harness = harnessOf(() => Promise.resolve(null))
    const { container } = mount(harness, PatchTab, { id: 'patch-1', kind: 'patch' })

    expect(textOf(container.querySelector('.file-preview-empty'))).toContain('这张补丁页签没有文件路径')
  })

  test('快照只在内存，取不到时说明已过期并给「打开」出口', () => {
    const harness = harnessOf(() => Promise.resolve(null))
    const { container } = mount(harness, PatchTab, tab('C:/repo/src/a.ts'))

    expect(textOf(container.querySelector('.file-preview-empty'))).toContain('这份补丁已经不在了')
    const open = [...container.querySelectorAll('button')].find((button) => textOf(button) === '打开')
    expect(open).not.toBeUndefined()
  })
})
