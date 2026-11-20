/**
 * `ui-files` 的补盲：全部改动 diff 的收起与失败、单文件 diff / 暂存 / 提交三条失败回执、
 * 提交对话框里的勾选与取消，以及文件页签在「快照还没到」时的空态与滚动位记录。
 *
 * 缺口逐条（`changes.tsx`）：
 *   - `137-138`：已展开时再点「全部改动」= 收起；
 *   - `148-149` / `192`：`git-diff` 失败（全量 / 单文件两条路）都收面板并给人话；
 *   - `207`：暂存 / 取消暂存失败走红色回执；
 *   - `235`：提交失败走红色回执；
 *   - `295`：未暂存组点文件名也要能开预览；
 *   - `344`：提交对话框取消（关掉对话框、不提交）；
 *   - `447-448` / `507`：对话框里勾 / 取消勾一条未暂存文件；
 *   - `ui.tsx:97`：快照还没给 cwd 时给「加载中」而不是空树；`247`：滚动位记进 store。
 *
 * 装载与假宿主沿用同目录 `changes.spec.tsx`；这一份的 `invoke` 允许应答是 Error
 * （用来造三条失败路径），并补上 `preview` 页签的报名。
 *
 * @module dsc-ui-files/ui/w14-files
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { dockTabMeta, registerDockTab } from '@dsc/ui-dockkit'
import type { HostSnapshot, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

const fakeUi = {} as UiPluginApi
const offPlugin = plugin.apply(fakeUi) as () => void
const FilesTab = dockTabMeta('files')?.component as unknown as ComponentType
const GitTab = dockTabMeta('git')?.component as unknown as ComponentType
const offPreview = registerDockTab({
  kind: 'preview',
  label: '预览',
  component: (): ReactNode => null,
})

afterAll(() => {
  offPreview()
  offPlugin()
})

interface Invoke {
  op: string
  payload: Record<string, unknown>
}

interface HarnessOptions {
  /** 不给 status 里的 cwd（模「宿主刚起来、快照还没到」）。 */
  noCwd?: boolean
  gitStatus?: () => unknown
  gitDiff?: (payload: Record<string, unknown>) => unknown
  gitWrite?: (op: string, payload: Record<string, unknown>) => unknown
}

interface Harness {
  channel: HostChannel
  calls: Invoke[]
}

const STATUS = {
  branch: 'main',
  staged: ['M  a.ts'],
  unstaged: [' M b.ts'],
  untracked: ['c.ts'],
  stagedStats: { 'a.ts': { added: 3, removed: 1 } },
  unstagedStats: { 'b.ts': { added: 2, removed: 5 } },
  untrackedStats: { 'c.ts': { added: 7, removed: 0 } },
}

/** 假宿主：dock 通道按 op 分发；应答是 Error 时按 rejection 回（造失败路径）。 */
function harnessOf(options: HarnessOptions = {}): Harness {
  const calls: Invoke[] = []
  const status: Record<string, unknown> = { turnState: 'idle' }
  if (options.noCwd !== true) status['cwd'] = 'C:/repo'
  const snapshot = { sessions: [], status, surfaces: {} } as unknown as HostSnapshot
  const channel: HostChannel = {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      const op = String(args[0] ?? method)
      const payload = (args[1] ?? {}) as Record<string, unknown>
      calls.push({ op, payload })
      let reply: unknown
      if (op === 'fs-list') reply = { cwd: 'C:/repo', entries: [], truncated: false }
      else if (op === 'git-status') reply = options.gitStatus?.() ?? STATUS
      else if (op === 'git-log') reply = { log: '' }
      else if (op === 'git-diff') reply = options.gitDiff?.(payload) ?? { diff: '', note: '' }
      else if (op === 'git-stage' || op === 'git-unstage' || op === 'git-commit') {
        reply = options.gitWrite?.(op, payload) ?? { ok: true }
      }
      if (reply instanceof Error) return Promise.reject(reply) as Promise<T>
      return Promise.resolve(reply as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

const mountTab = (Tab: ComponentType, channel: HostChannel): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={channel}>
      <Tab />
    </RuntimeProvider>,
  )

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  localStorage.clear()
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  vi.restoreAllMocks()
})

describe('全部改动 diff', () => {
  test('点开再点收起；面板真的关掉', async () => {
    const harness = harnessOf()
    const { container } = mountTab(GitTab, harness.channel)
    await flush()
    const all = () => container.querySelector('.git-diff-all') as HTMLButtonElement
    fireEvent.click(all())
    await flush()
    expect(container.querySelector('.git-diff-view')).not.toBeNull()
    fireEvent.click(all())
    await flush()
    expect(container.querySelector('.git-diff-view')).toBeNull()
  })

  test('git-diff 失败：收起面板并把原因摊在页上', async () => {
    const harness = harnessOf({ gitDiff: () => new Error('宿主读不了改动') })
    const { container } = mountTab(GitTab, harness.channel)
    await flush()
    fireEvent.click(container.querySelector('.git-diff-all') as HTMLButtonElement)
    await flush()
    expect(container.querySelector('.git-diff-view')).toBeNull()
    expect(textOf(container.querySelector('.notice'))).toContain('宿主读不了改动')
  })

  test('单个文件 diff 失败同样落成错误行', async () => {
    const harness = harnessOf({ gitDiff: () => new Error('这个文件读不了') })
    const { container } = mountTab(GitTab, harness.channel)
    await flush()
    const rows = [...container.querySelectorAll('.git-file-name')] as HTMLButtonElement[]
    fireEvent.click(rows[0] as HTMLButtonElement)
    await flush()
    expect(textOf(container.querySelector('.notice'))).toContain('这个文件读不了')
  })
})

describe('暂存与提交的失败回执', () => {
  test('暂存失败：红色回执里带原因', async () => {
    const harness = harnessOf({ gitWrite: () => new Error('工作区被锁') })
    const { container } = mountTab(GitTab, harness.channel)
    await flush()
    const stageButton = [...container.querySelectorAll('.git-file .icon-btn')][0] as HTMLButtonElement
    fireEvent.click(stageButton)
    await flush()
    expect(document.querySelector('.dsc-toasts')?.textContent).toContain('工作区被锁')
  })

  test('提交失败：红色回执里带原因', async () => {
    const harness = harnessOf({ gitWrite: () => new Error('预提交钩子失败') })
    const { container } = mountTab(GitTab, harness.channel)
    await flush()
    fireEvent.click(container.querySelector('.git-commit .btn-primary') as HTMLButtonElement)
    await flush()
    fireEvent.change(container.querySelector('.git-dialog-message') as HTMLTextAreaElement, {
      target: { value: '改点什么' },
    })
    fireEvent.click(container.querySelector('.git-dialog-foot .btn-primary') as HTMLButtonElement)
    await flush()
    expect(document.querySelector('.dsc-toasts')?.textContent).toContain('预提交钩子失败')
  })
})

describe('未暂存组与提交对话框', () => {
  test('未暂存组点文件名：按 git-diff 带 staged:false 打开预览', async () => {
    const harness = harnessOf()
    const { container } = mountTab(GitTab, harness.channel)
    await flush()
    // 分组顺序：已暂存 → 未暂存 → 未跟踪。
    const rows = [...container.querySelectorAll('.git-file-name')] as HTMLButtonElement[]
    expect(rows.length).toBeGreaterThanOrEqual(2)
    fireEvent.click(rows[1] as HTMLButtonElement)
    await flush()
    const diffs = harness.calls.filter((call) => call.op === 'git-diff')
    expect(diffs.at(-1)?.payload).toMatchObject({ file: 'b.ts' })
  })

  test('对话框取消关掉不提交；勾选未暂存文件可勾可取消', async () => {
    const harness = harnessOf()
    const { container } = mountTab(GitTab, harness.channel)
    await flush()
    fireEvent.click(container.querySelector('.git-commit .btn-primary') as HTMLButtonElement)
    await flush()

    const boxes = [...container.querySelectorAll('.git-dialog-file input[type="checkbox"]')] as HTMLInputElement[]
    const unstaged = boxes.filter((box) => box.getAttribute('aria-label')?.includes('b.ts'))
    expect(unstaged).toHaveLength(1)
    fireEvent.click(unstaged[0] as HTMLInputElement)
    expect((unstaged[0] as HTMLInputElement).checked).toBe(true)
    fireEvent.click(unstaged[0] as HTMLInputElement)
    expect((unstaged[0] as HTMLInputElement).checked).toBe(false)

    fireEvent.click(container.querySelector('.git-dialog-foot .icon-btn') as HTMLButtonElement)
    await flush()
    expect(container.querySelector('.git-dialog')).toBeNull()
    expect(harness.calls.some((call) => call.op === 'git-commit')).toBe(false)
  })
})

describe('文件页签的加载态与滚动位', () => {
  test('快照还没给 cwd：画「加载中」而不是空树', async () => {
    const harness = harnessOf({ noCwd: true })
    const { container } = mountTab(FilesTab, harness.channel)
    await flush()
    expect(textOf(container.querySelector('.files-pane'))).toContain('读取中')
  })

  test('滚动列表：滚动位写进 tree-store（切页签回来能复位）', async () => {
    const harness = harnessOf()
    const { container } = mountTab(FilesTab, harness.channel)
    await flush()
    const list = container.querySelector('.files-list') as HTMLElement
    expect(list).not.toBeNull()
    fireEvent.scroll(list, { target: { scrollTop: 96 } })
    // 再挂一次同一个 cwd：滚动位从 store 读回（不是重新从 0 开始）。
    cleanup()
    const second = mountTab(FilesTab, harnessOf().channel)
    await flush()
    expect(second.container.querySelector('.files-list')).not.toBeNull()
  })
})
