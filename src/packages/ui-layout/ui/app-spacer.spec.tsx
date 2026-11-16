/**
 * 会话区底部占位的**位置**（`ui-layout/ui/app.tsx`）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-turn-spacer-test.mjs` 第 [1][2] 段（缺口清单 B37）。原探针用下标比较
 * 钉「占位是 `.chat` 的最后一个子元素、在 `.chat-inner` 之后」；这里直接渲染 App 查 DOM：
 * 占位挂在 `.chat` 里、紧跟在 `.chat-inner` 之后、是最后一个子元素、`aria-hidden` 为真。
 *
 * 第 [2] 段的反向钉（transcript 的 `ui.tsx` 不画占位）在
 * `ui-transcript/ui/turn-spacer.spec.tsx`——那里真渲染消息流，断言占位不在它里面。
 *
 * @module dsc-ui-layout/ui/app-spacer.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { SlotRegistry, type UiBootGraph } from '@dsc/ui-core'
import type { HostSnapshot } from '@dsc/ui'
import { App } from './app.js'

/** 空启动图：本组只看布局骨架。 */
const emptyBoot = (): UiBootGraph =>
  ({
    rev: 'r0',
    entries: [],
    batches: [],
    host: { name: 'Pneuma', version: '0.0.0-test' },
  }) as unknown as UiBootGraph

/** 空快照 + 只答 getUiPrefs 的假通道（App 挂载时会问一次偏好）。 */
function makeChannel(): HostChannel {
  const snapshot = {
    entries: [],
    liveEntries: [],
    status: { cwd: 'D:/demo', turnState: 'idle' },
  } as unknown as HostSnapshot
  return {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string): Promise<T> =>
      (method === 'getUiPrefs' ? Promise.resolve({}) : Promise.resolve({})) as Promise<T>) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
}

beforeEach(() => {
  // App 挂载时用 matchMedia 判窄屏；jsdom 没有。
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  }))
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('底部占位挂在 .chat 里、.chat-inner 之后', () => {
  test('占位是 .chat 的最后一个子元素，紧跟 .chat-inner，aria-hidden 为真', () => {
    const slots = new SlotRegistry()
    const { container } = render(
      <RuntimeProvider channel={makeChannel()}>
        <App
          slots={slots as unknown as Parameters<typeof App>[0]['slots']}
          boot={emptyBoot()}
          serviceRegistry={new (class { names(): string[] { return [] } })() as unknown as Parameters<typeof App>[0]['serviceRegistry']}
          session={null}
          hmr={null}
          bootError={null}
          allowedModules={[]}
        />
      </RuntimeProvider>,
    )
    const chat = container.querySelector('.chat')
    expect(chat).toBeTruthy()
    const children = [...(chat as HTMLElement).children]
    const names = children.map((node) => node.className)
    expect(names).toContain('chat-inner')
    expect(names[names.length - 1]).toBe('turn-spacer')
    const spacer = children[children.length - 1] as HTMLElement
    expect(spacer.hasAttribute('data-chat-turn-spacer')).toBe(true)
    expect(spacer.getAttribute('aria-hidden')).toBe('true')
    // 紧跟在列之后：两者之间没有别的元素。
    expect(children.indexOf(spacer)).toBe(children.findIndex((node) => node.className === 'chat-inner') + 1)
  })
})
