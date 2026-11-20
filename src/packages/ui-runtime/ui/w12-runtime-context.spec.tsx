/**
 * 运行时上下文补盲（`packages/ui-runtime/ui/runtime-context.tsx`）：
 * 四个 `useSyncExternalStore` hook 的服务端快照取值（`useHostSnapshot` / 连接状态 /
 * 宿主身份 / 宿主异常），以及没有 Provider 时的报错。
 *
 * 通道用可控替身：getSnapshot / getStatus / getHello / getHostError 各给一份值，
 * hook 本身真跑（不是断言「函数被调过」）。
 *
 * @module dsc/packages/ui-runtime/ui/w12-runtime-context.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { HostSnapshot } from '@dsc/ui-core'
import {
  RuntimeProvider,
  useChannelStatus,
  useHostError,
  useHostHello,
  useHostSnapshot,
} from './runtime-context.js'
import type { HostChannel, HostHello } from './host-channel.js'

const statusFixture = { sessionId: 's-1' }
const snapshot = { status: statusFixture, entries: [] } as unknown as HostSnapshot
const hello = { protocol: 1, host: { platform: 'web' } } as unknown as HostHello

/** 造一个只读通道：四个 getter 各返回给定值。 */
function fakeChannel(): HostChannel {
  return {
    getSnapshot: () => snapshot,
    getHello: () => hello,
    getStatus: () => 'open',
    getHostError: () => '造帧失败',
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (() => Promise.resolve(undefined)) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
}

/** `HostSnapshot.status` 在契约里是开放对象；用例按自己摆的夹具收窄后再读。 */
const statusOf = (value: HostSnapshot | null): string =>
  (value?.status as typeof statusFixture | undefined)?.sessionId ?? ''

/** 一个把四个 hook 的返回值都摊到 DOM 里的探针。 */
function Probe(): ReactNode {
  const current = useHostSnapshot()
  const status = useChannelStatus()
  const identity = useHostHello()
  const error = useHostError()
  return (
    <div>
      <span data-testid="snapshot">{current === null ? 'null' : statusOf(current)}</span>
      <span data-testid="status">{status}</span>
      <span data-testid="hello">{identity === null ? 'null' : 'hello'}</span>
      <span data-testid="error">{error ?? 'null'}</span>
    </div>
  )
}

afterEach(() => {
  cleanup()
})

describe('RuntimeProvider 下的四个 hook', () => {
  test('快照 / 连接状态 / 握手身份 / 宿主异常都从通道读', () => {
    const { getByTestId } = render(
      <RuntimeProvider channel={fakeChannel()}>
        <Probe />
      </RuntimeProvider>,
    )
    expect(getByTestId('snapshot').textContent).toBe('s-1')
    expect(getByTestId('status').textContent).toBe('open')
    expect(getByTestId('hello').textContent).toBe('hello')
    expect(getByTestId('error').textContent).toBe('造帧失败')
  })

  test('没有 Provider：useHostChannel 直接抛，不静默降级成空值', () => {
    // React 会把渲染期的错误交给 console.error 再重抛；这里只钉「确实抛了」。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => render(<Probe />)).toThrow(/RuntimeProvider/)
    spy.mockRestore()
  })
})
