/**
 * 输入框分支菜单的渲染断言（ui 层）。
 *
 * 来源：`scripts/ui-git-branch-test.mjs` 第 [2] 段里「branch-menu.tsx」的那一半（原探针读
 * `ui.tsx` / `branch-menu.tsx` 源码钉接线）。真渲染 `BranchMenu`（它本来就是导出的受控组件）
 * 之后，这些钉有行为等价物：
 *
 * - 「不是仓库时整行不画」→ `git.repo=false` 渲染出空（null），一个节点都没有；
 * - 「钮上显示分支名 + 箭头」→ 钮的文本里有分支名，aria-haspopup / aria-expanded 跟着开关走；
 * - 「菜单展开即重读清单（不复用上次的快照）」→ `open` 翻两次 true，`git-branches` 被调两次
 *   （假通道记数）；关掉再开不携带上一次的搜索词（组件自己清空输入框）；
 * - 「当前分支滚进视野」→ 清单到手后当前分支那行带 `data-branch-current="true"`（滚没滚进
 *   视口是布局行为，jsdom 没有布局——`scrollIntoView` 打桩接住调用即验到「确实滚的是它」）；
 * - 「切分支走 dock 的写类 op（过审批那一档）」→ 点一行分支，假通道收到
 *   `['git-checkout', { branch }]`，且带了 `HUMAN_WAIT_TIMEOUT_MS` 的长超时；
 * - 「菜单在等审批之前先收起」→ 点分支后 `onOpenChange(false)` 同步先被调；
 * - 「失败写进输入区下面那行 fault（不是静默）」→ `git-checkout` 拒绝且 git 原文是「改动会
 *   被覆盖」那一句时，`onFault` 收到的是补过「往哪儿走」的文案；别的失败原文照给。
 *
 * 第 [4] 段（desktop-dock 与 git 插件的实现位置）是宿主源码文本钉，属内核探针面——
 * op 分档的行为半边（读 / 写类、审批卡文案）已由 `git-branch.spec.ts` 真读宿主常量覆盖。
 *
 * @module dsc-ui-composer/ui/branch-menu.spec
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HUMAN_WAIT_TIMEOUT_MS, type GitSurface } from '@dsc/ui'
import type { HostChannel } from '@dsc/ui-runtime'
import { BranchMenu } from './branch-menu.js'

afterEach(cleanup)

/** jsdom 没有 `scrollIntoView`（清单到手后组件要滚当前分支那行）：全局打桩接住调用。 */
const scrollIntoView = vi.fn()
beforeEach(() => {
  scrollIntoView.mockClear()
  ;(Element.prototype as unknown as { scrollIntoView: (arg?: unknown) => void }).scrollIntoView = scrollIntoView
})

interface Recorded {
  method: string
  args: unknown[]
  options?: { timeoutMs?: number }
}

/** 假通道：`git-branches` 回清单，其余记下来按应答表走。 */
function fakeChannel(replies: Record<string, unknown> = {}): { channel: HostChannel; calls: Recorded[] } {
  const calls: Recorded[] = []
  const channel: HostChannel = {
    getSnapshot: () => null,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: <T,>(method: string, args: unknown[] = [], options?: { timeoutMs?: number }): Promise<T> => {
      calls.push({ method, args, options })
      // dock 的形状：invoke('dock', [op, args])——op 是 args[0] 的字符串。
      const op = typeof args[0] === 'string' ? args[0] : ''
      const reply = op === 'git-branches' ? { current: 'main', detached: false, branches: rows } : replies[op]
      if (reply === undefined) return Promise.resolve(null) as Promise<T>
      // Error 按失败应答处理（在这里才造 rejected promise，别让用例表里的 rejection 空等成 unhandled）。
      return (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)) as Promise<T>
    },
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

const rows = [
  { name: 'main', current: true },
  { name: 'feat/ui', current: false },
  { name: 'fix-bug', current: false },
]

const repo: GitSurface = { repo: true, branch: 'main', detached: false, dirtyFileCount: 0 }

/** 挂一次菜单（受控开关归用例；开关与 fault 都带 Mock 类型，用例里断言调用记录）。 */
interface MenuHarness {
  page: ReturnType<typeof render>
  open: (open: boolean) => void
  onOpenChange: ReturnType<typeof vi.fn<(next: boolean) => void>>
  onFault: ReturnType<typeof vi.fn<(text: string | null) => void>>
  rerender: (open: boolean) => void
}

function mount(over: Partial<Parameters<typeof BranchMenu>[0]> & { channel: HostChannel }): MenuHarness {
  const onOpenChange = vi.fn<(next: boolean) => void>()
  const onFault = vi.fn<(text: string | null) => void>()
  const props = { open: false, onOpenChange, git: repo, onFault, ...over }
  const page = render(<BranchMenu {...props} />)
  const rerender = (open: boolean): void => {
    page.rerender(<BranchMenu {...props} open={open} />)
  }
  return { page, open: (next) => onOpenChange(next), onOpenChange, onFault, rerender }
}

// ── 读数与开关 ────────────────────────────────────────────────────────────────

test('不是仓库：整行不画（连那颗钮都不出现）', () => {
  const page = mount({ channel: fakeChannel().channel, git: { repo: false, branch: '', detached: false, dirtyFileCount: 0 } })
  expect(page.page.container.querySelector('.composer-git')).toBeNull()
  expect(page.page.container.querySelector('.git-branch-name')).toBeNull()
})

test('钮上显示分支名 + 箭头；aria-expanded 跟着受控开关走', () => {
  const page = mount({ channel: fakeChannel().channel })
  const button = page.page.container.querySelector('.git-btn') as HTMLElement
  expect(button.querySelector('.git-branch-name')?.textContent).toBe('main')
  expect(button.getAttribute('aria-haspopup')).toBe('menu')
  expect(button.getAttribute('aria-expanded')).toBe('false')
  // 受控：点钮把开关翻给父组件，父不开菜单就还是不开。
  fireEvent.click(button)
  expect(page.onOpenChange).toHaveBeenCalledWith(true)
  expect(page.page.container.querySelector('.git-pop')).toBeNull()
})

// ── 清单：展开即重读 ──────────────────────────────────────────────────────────

test('菜单展开重读清单；关掉再开再读一次（不复用上次的快照）', async () => {
  const { channel, calls } = fakeChannel()
  const page = mount({ channel })
  page.rerender(true)
  await waitFor(() => expect(page.page.container.querySelector('[data-branch-current="true"]')).not.toBeNull())
  // 清单请求也走 `dock` 通道：op 是 args[0] 的字符串。
  const reads = (): number => calls.filter((call) => call.args[0] === 'git-branches').length
  expect(reads()).toBe(1)
  page.rerender(false)
  page.rerender(true)
  await waitFor(() => expect(reads()).toBe(2))
})

test('清单展开：当前分支那行带 data-branch-current，且被滚进视野', async () => {
  const page = mount({ channel: fakeChannel().channel, open: true })
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
  const current = page.page.container.querySelector('[data-branch-current="true"]') as HTMLElement
  expect(current?.textContent).toContain('main')
  expect(current.getAttribute('aria-checked')).toBe('true')
  // 滚的是当前分支那一行（`block: 'nearest'`：已在视野里就不动）。
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  expect(current.querySelector('.check')).not.toBeNull()
})

test('当前分支那颗钮禁用（自己切到自己不是动作）', async () => {
  const page = mount({ channel: fakeChannel().channel, open: true })
  await waitFor(() => expect(page.page.container.querySelector('[data-branch-current="true"]')).not.toBeNull())
  expect((page.page.container.querySelector('[data-branch-current="true"]') as HTMLButtonElement).disabled).toBe(true)
})

// ── 切分支：写类 op + 先收菜单 + 失败写 fault ─────────────────────────────────

test('点一行分支：git-checkout 带长超时发出，onOpenChange(false) 先于调用', async () => {
  const { channel, calls } = fakeChannel()
  const page = mount({ channel, open: true })
  await waitFor(() => expect(page.page.container.querySelector('[data-branch-current="true"]')).not.toBeNull())
  const order: string[] = []
  page.onOpenChange.mockImplementation(() => order.push('close'))
  const original = channel.invoke.bind(channel)
  const spy = vi.spyOn(channel, 'invoke').mockImplementation((method: string, args?: unknown[], options?: { timeoutMs?: number }) => {
    order.push('invoke')
    // 记账照旧（calls 的断言仍要成立），顺序先于 invoke 记下的是「close 已先行」。
    return original(method, args ?? [], options)
  })
  fireEvent.click(page.page.container.querySelectorAll('.git-branch-list .pop-item')[1] as HTMLElement)
  await waitFor(() => expect(order).toEqual(['close', 'invoke']))
  const checkout = calls.find((call) => call.args[0] === 'git-checkout')
  expect(checkout?.args[1]).toEqual({ branch: 'feat/ui' })
  expect(checkout?.options?.timeoutMs).toBe(HUMAN_WAIT_TIMEOUT_MS)
})

test('git 拒切换（改动会被覆盖）：fault 收到补过「往哪儿走」的文案；菜单已先收起', async () => {
  const GIT_SAYS = 'error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt'
  const { channel } = fakeChannel({ 'git-checkout': new Error(GIT_SAYS) })
  const page = mount({ channel, open: true })
  await waitFor(() => expect(page.page.container.querySelector('[data-branch-current="true"]')).not.toBeNull())
  fireEvent.click(page.page.container.querySelectorAll('.git-branch-list .pop-item')[1] as HTMLElement)
  // switchBranch 先 onFault(null) 清旧便条，失败回执是第二条——等那条非 null 的。
  await waitFor(() => expect(page.onFault.mock.calls.filter((call) => call[0] !== null)).toHaveLength(1))
  const fault = page.onFault.mock.calls.filter((call) => call[0] !== null)[0]?.[0] as string
  // 原文还在（用户要看 git 说了什么），补的那句也在（往哪儿走）。
  expect(fault).toContain('would be overwritten')
  expect(fault).toContain('提交或暂存')
  expect(page.onOpenChange).toHaveBeenCalledWith(false)
})

test('别的失败（分支名不合法那类）：原文照给，不误判成「改动会被覆盖」', async () => {
  const { channel } = fakeChannel({ 'git-checkout': new Error("fatal: 'bad name' is not a valid branch name") })
  const page = mount({ channel, open: true })
  await waitFor(() => expect(page.page.container.querySelector('[data-branch-current="true"]')).not.toBeNull())
  fireEvent.click(page.page.container.querySelectorAll('.git-branch-list .pop-item')[1] as HTMLElement)
  await waitFor(() => expect(page.onFault.mock.calls.filter((call) => call[0] !== null)).toHaveLength(1))
  expect(page.onFault.mock.calls.filter((call) => call[0] !== null)[0]?.[0]).toBe("fatal: 'bad name' is not a valid branch name")
})

// ── 新建分支 ──────────────────────────────────────────────────────────────────

test('新建分支：git-branch-create 带长超时发出；空名不发', async () => {
  const { channel, calls } = fakeChannel()
  const page = mount({ channel, open: true })
  await waitFor(() => expect(page.page.container.querySelector('[data-branch-current="true"]')).not.toBeNull())
  fireEvent.click(page.page.container.querySelector('.git-foot-btn') as HTMLElement)
  const input = page.page.container.querySelector('.git-create input') as HTMLInputElement
  // 空名：提交钮禁用，不发。
  expect(page.page.container.querySelector('.git-create button')).toHaveProperty('disabled', true)
  fireEvent.change(input, { target: { value: 'feat/new-thing' } })
  fireEvent.click(page.page.container.querySelector('.git-create button') as HTMLElement)
  await waitFor(() => expect(page.onOpenChange).toHaveBeenCalledWith(false))
  const create = calls.find((call) => call.args[0] === 'git-branch-create')
  expect(create?.args[1]).toEqual({ branch: 'feat/new-thing' })
  expect(create?.options?.timeoutMs).toBe(HUMAN_WAIT_TIMEOUT_MS)
})
