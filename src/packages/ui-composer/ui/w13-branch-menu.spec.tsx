/**
 * 输入框分支菜单的失败面与零散交互补测（ui 层，真渲染）。
 *
 * 既有 `branch-menu.spec.tsx` 走的是「读到了、切成功了」的主路径。这一份只补它没碰的边角：
 *
 *  - 清单请求失败：`onFault` 收到「读取分支列表失败」文案，清单回到 null（菜单显示「正在读取」），
 *    且这条回执不被 `alive` 早退吞掉；
 *  - 新建分支失败：`onFault` 收到通道报的原文（组件不再包一层）；
 *  - 点遮罩关菜单（`onOpenChange(false)`）；搜索框输入筛行；新建输入框按 Esc 收起这一格。
 *
 * @module dsc-ui-composer/ui/w13-branch-menu.spec
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { GitSurface } from '@dsc/ui'
import type { HostChannel } from '@dsc/ui-runtime'
import { BranchMenu } from './branch-menu.js'

afterEach(cleanup)

/** jsdom 没有 `scrollIntoView`：清单到手后组件要滚当前分支，桩掉接住。 */
beforeEach(() => {
  ;(Element.prototype as unknown as { scrollIntoView: (arg?: unknown) => void }).scrollIntoView = vi.fn()
})

const rows = [
  { name: 'main', current: true },
  { name: 'feat/ui', current: false },
  { name: 'fix-bug', current: false },
]

const repo: GitSurface = { repo: true, branch: 'main', detached: false, dirtyFileCount: 0 }

interface Call {
  method: string
  args: unknown[]
}

/** 假通道：按 op 给应答；`Error` 按拒绝处理（契约与既有 spec 一致）。 */
function fakeChannel(replies: Record<string, unknown>): { channel: HostChannel; calls: Call[] } {
  const calls: Call[] = []
  const channel: HostChannel = {
    getSnapshot: () => null,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: <T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      const op = typeof args[0] === 'string' ? args[0] : ''
      const reply = replies[op]
      if (reply === undefined) return Promise.resolve(null) as Promise<T>
      return (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)) as Promise<T>
    },
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

interface Harness {
  page: ReturnType<typeof render>
  onOpenChange: ReturnType<typeof vi.fn<(next: boolean) => void>>
  onFault: ReturnType<typeof vi.fn<(text: string | null) => void>>
}

function mount(channel: HostChannel, open = true): Harness {
  const onOpenChange = vi.fn<(next: boolean) => void>()
  const onFault = vi.fn<(text: string | null) => void>()
  const page = render(<BranchMenu open={open} onOpenChange={onOpenChange} git={repo} channel={channel} onFault={onFault} />)
  return { page, onOpenChange, onFault }
}

test('清单请求失败：fault 收到「读取失败」文案，菜单回到「正在读取」而不是空白', async () => {
  const { channel } = fakeChannel({ 'git-branches': new Error('通道断了') })
  const { page, onFault } = mount(channel)
  await waitFor(() => expect(onFault.mock.calls.filter((call) => call[0] !== null)).toHaveLength(1))
  const fault = onFault.mock.calls.filter((call) => call[0] !== null)[0]?.[0] as string
  expect(fault).toContain('读分支清单失败')
  expect(fault).toContain('通道断了')
  // 清单为 null：菜单里仍是加载提示，没有画出行。
  expect(page.container.querySelector('.git-branch-list .pop-item')?.textContent).toBe('正在读取分支…')
})

test('新建分支失败：fault 收到通道原文（实例错误走 message）', async () => {
  const { channel } = fakeChannel({ 'git-branch-create': new Error('branch exists') })
  const { page, onFault } = mount(channel)
  await waitFor(() => expect(page.container.querySelector('.git-foot-btn')).not.toBeNull())
  fireEvent.click(page.container.querySelector('.git-foot-btn') as HTMLElement)
  const input = page.container.querySelector('.git-create input') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'feat/dup' } })
  fireEvent.click(page.container.querySelector('.git-create button') as HTMLElement)
  await waitFor(() => expect(onFault).toHaveBeenCalledWith('branch exists'))
  // 失败时不收这一格（输入还在，用户可改名再来）。
  expect(page.container.querySelector('.git-create input')).not.toBeNull()
})

test('点遮罩关菜单；搜索框输入按内容筛行；搜索无匹配给空态', async () => {
  const { channel } = fakeChannel({ 'git-branches': { current: 'main', detached: false, branches: rows } })
  const { page, onOpenChange } = mount(channel)
  await waitFor(() => expect(page.container.querySelector('[data-branch-current="true"]')).not.toBeNull())

  const search = page.container.querySelector('.git-search input') as HTMLInputElement
  fireEvent.change(search, { target: { value: 'ui' } })
  const visible = [...page.container.querySelectorAll('.git-branch-list .pop-item')].map((node) => node.textContent)
  expect(visible).toHaveLength(1)
  expect(visible[0]).toContain('feat/ui')

  fireEvent.change(search, { target: { value: 'zzz' } })
  expect(page.container.querySelector('.git-branch-list .pop-item')?.textContent).toBe('没有匹配的分支')

  fireEvent.click(page.container.querySelector('.pop-mask') as HTMLElement)
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

test('新建输入框按 Esc 收起这一格（不提交、不关整张菜单）', async () => {
  const { channel } = fakeChannel({ 'git-branches': { current: 'main', detached: false, branches: rows } })
  const { page, onOpenChange } = mount(channel)
  await waitFor(() => expect(page.container.querySelector('.git-foot-btn')).not.toBeNull())
  fireEvent.click(page.container.querySelector('.git-foot-btn') as HTMLElement)
  const input = page.container.querySelector('.git-create input') as HTMLInputElement
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(page.container.querySelector('.git-create input')).toBeNull()
  expect(page.container.querySelector('.git-foot-btn')).not.toBeNull()
  // Esc 只收这一格，不关菜单。
  expect(onOpenChange).not.toHaveBeenCalled()
})
