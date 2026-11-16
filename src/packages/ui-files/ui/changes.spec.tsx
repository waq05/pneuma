/**
 * 文件 / Git 页签（`ui-files/ui/ui.tsx` 与 `changes.tsx`）的渲染与交互段（ui 层，真渲染）。
 *
 * 覆盖三块：
 * - 文件树：根层懒加载、目录展开才拉下一层（收起再展开走缓存）、空 / 失败 / 截断三种人话、
 *   刷新重拉已展开层、滚动位从 store 恢复、点文件按绝对路径开预览页签；
 * - 变更面板：挂载即取 git-status / git-log、三分组与增删统计、分组折叠、点文件回传
 *   git-diff 并按分组带 staged、宿主给 note 时不画空 diff、错误态、全部改动 diff 的分段
 *   与关闭、暂存 / 取消暂存带审批长超时、提交对话框的文件清单与提交参数；
 * - tree-store（纯模块）：按 cwd 分树、不可变替换与订阅广播、展开集、needsLoad、
 *   自然序排序、滚动位不广播。
 *
 * 树与 dock 布局都是模块级状态：每个用例用**不同的 cwd / 路径**隔离，避免互相串台。
 *
 * @module dsc-ui-files/ui/changes.spec
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { dockSurface, dockTabMeta, registerDockTab } from '@dsc/ui-dockkit'
import { HUMAN_WAIT_TIMEOUT_MS, joinPath, type HostSnapshot, type UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'
import {
  getTree,
  needsLoad,
  orderEntries,
  setLevel,
  setScrollTop,
  subscribe,
  toggleExpanded,
  type TreeEntry,
} from './tree-store.js'
import type { ReactNode } from 'react'

/** 照壳装载插件那条路：apply 把 files / git 两种页签登记进报名表。 */
const fakeUi = {} as UiPluginApi
const offPlugin = plugin.apply(fakeUi)
const FilesTab = dockTabMeta('files')?.component as unknown as ComponentType
const GitTab = dockTabMeta('git')?.component as unknown as ComponentType
/** 预览页签：点文件/点改动行要它才会真开页签（壳里由预览插件报名）。 */
const offPreview = registerDockTab({ kind: 'preview', label: '预览', component: (): ReactNode => null })

afterAll(() => {
  offPreview()
  offPlugin()
})

interface Invoke {
  op: string
  payload: Record<string, unknown>
  options: unknown
}

interface HarnessOptions {
  cwd?: string
  fsList?: (dir: string, payload: Record<string, unknown>) => unknown
  gitStatus?: () => unknown
  gitLog?: () => unknown
  gitDiff?: (payload: Record<string, unknown>) => unknown
  gitWrite?: (op: string, payload: Record<string, unknown>) => unknown
}

interface Harness {
  channel: HostChannel
  calls: Invoke[]
  cwd: string
}

/** 假宿主：只认 dock 通道，按 op 分发到用例给的应答；每次调用都记账。 */
function harnessOf(options: HarnessOptions = {}): Harness {
  const calls: Invoke[] = []
  const cwd = options.cwd ?? 'C:/repo'
  const snapshot = {
    sessions: [],
    status: { cwd, turnState: 'idle' },
    surfaces: {},
  } as unknown as HostSnapshot
  const channel: HostChannel = {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string, args: unknown[] = [], invokeOptions?: unknown): Promise<T> => {
      const op = String(args[0] ?? method)
      const payload = (args[1] ?? {}) as Record<string, unknown>
      calls.push({ op, payload, options: invokeOptions })
      let reply: unknown
      if (op === 'fs-list') {
        reply = options.fsList?.(String(payload['dir']), payload) ?? { cwd, entries: [], truncated: false }
      } else if (op === 'git-status') {
        reply = options.gitStatus?.() ?? { branch: 'main', staged: [], unstaged: [], untracked: [] }
      } else if (op === 'git-log') {
        reply = options.gitLog?.() ?? { log: '' }
      } else if (op === 'git-diff') {
        reply = options.gitDiff?.(payload) ?? { diff: '', note: '' }
      } else if (op === 'git-stage' || op === 'git-unstage' || op === 'git-commit') {
        reply = options.gitWrite?.(op, payload) ?? { ok: true }
      }
      return Promise.resolve(reply as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls, cwd }
}

const mountTab = (Tab: ComponentType, channel: HostChannel): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={channel}>
      <Tab />
    </RuntimeProvider>,
  )

/** 让挂载期的一串 promise 落地（refresh 里 status / log 两条链，落定后还有提交后的重读）。 */
const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''

const methodsOf = (calls: Invoke[], op: string): Invoke[] => calls.filter((call) => call.op === op)

/** dock 布局里某一类页签的路径（点文件应当按绝对路径开预览页签）。 */
const dockPathsOf = (kind: string): string[] =>
  dockSurface().panes.flatMap((pane) =>
    pane.tabs.filter((tab) => tab.kind === kind).map((tab) => tab.path ?? ''),
  )

const FILE_ENTRIES: TreeEntry[] = [
  { name: 'src', dir: true, size: 0 },
  { name: 'file10.txt', dir: false, size: 2048 },
  { name: 'file2.txt', dir: false, size: 10 },
]

const STATUS = {
  branch: 'main',
  staged: ['M  a.ts'],
  unstaged: [' M b.ts'],
  untracked: ['c.ts'],
  stagedStats: { 'a.ts': { added: 3, removed: 1 } },
  unstagedStats: { 'b.ts': { added: 2, removed: 5 } },
  untrackedStats: { 'c.ts': { added: 7, removed: 0 } },
}

const ONE_FILE_DIFF = [
  'diff --git a/a.ts b/a.ts',
  'index 111..222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,1 +1,2 @@',
  '-old',
  '+new',
  '+more',
].join('\n')

const ALL_DIFF = [
  'diff --git a/src/x.ts b/src/x.ts',
  '@@ -1,2 +1,3 @@',
  ' keep',
  '-old',
  '+new',
  '+extra',
  'diff --git a/y.ts b/y.ts',
  '@@ -1,1 +1,1 @@',
  '-a',
  '+b',
].join('\n')

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('变更面板：加载、分组与统计', () => {
  test('挂载即取状态与历史；三分组、增删数与提交区按回包画', async () => {
    const harness = harnessOf({
      gitStatus: () => STATUS,
      gitLog: () => ({ log: 'abc1234\t阿奇\t2026-11-01\tfeat: 面板' }),
    })
    const { container } = mountTab(GitTab, harness.channel)

    // 回包前是加载态，不是空面板。
    expect(textOf(container.querySelector('.trace-empty'))).toContain('读取中')

    await flush()
    expect(methodsOf(harness.calls, 'git-status')[0]?.payload).toEqual({ stats: true })
    expect(methodsOf(harness.calls, 'git-log')).toHaveLength(1)

    expect(textOf(container.querySelector('.git-branch .round-no'))).toBe('main')
    expect(textOf(container.querySelector('.git-count'))).toContain('3 处更改')

    const groups = [...container.querySelectorAll('.git-group')]
    expect(groups).toHaveLength(3)
    expect(textOf(groups[0])).toContain('已暂存（1）')
    expect(textOf(groups[1])).toContain('未暂存（1）')
    expect(textOf(groups[2])).toContain('未跟踪（1）')

    // 行上写的是原始 status 行；统计按剥掉前缀后的路径查。
    const stagedRow = groups[0]?.querySelector('.git-file') as HTMLElement
    expect(textOf(stagedRow.querySelector('.git-file-name'))).toBe('M  a.ts')
    expect(textOf(stagedRow.querySelector('.changes-added'))).toBe('+3')
    expect(textOf(stagedRow.querySelector('.changes-removed'))).toBe('−1')

    expect(textOf(container.querySelector('.git-commit-hint'))).toContain('已暂存 1 个文件')
    expect((container.querySelector('.git-commit .btn-primary') as HTMLButtonElement).disabled).toBe(false)

    const logRow = container.querySelector('.git-log-row') as HTMLElement
    expect(textOf(logRow.querySelector('code'))).toBe('abc1234')
    expect(textOf(logRow.querySelector('.git-log-msg'))).toBe('feat: 面板')
    expect(textOf(logRow.querySelector('.git-log-meta'))).toContain('阿奇 · 2026-11-01')
  })

  test('分组可折叠：点组头收起该组行，再点展开', async () => {
    const harness = harnessOf({ gitStatus: () => ({ ...STATUS, untracked: [] }) })
    const { container } = mountTab(GitTab, harness.channel)
    await flush()

    expect(container.querySelectorAll('.git-file')).toHaveLength(2)
    const head = container.querySelector('.git-group-head') as HTMLElement
    fireEvent.click(head)
    expect(container.querySelectorAll('.git-file')).toHaveLength(1)
    fireEvent.click(head)
    expect(container.querySelectorAll('.git-file')).toHaveLength(2)
  })

  test('错误态：git-status 失败给原因与非仓库提示；git-log 失败不画历史', async () => {
    const harness = harnessOf({
      gitStatus: () => Promise.reject(new Error('fatal: not a git repository')),
      gitLog: () => Promise.reject(new Error('log failed')),
    })
    const { container } = mountTab(GitTab, harness.channel)
    await flush()

    expect(textOf(container.querySelector('.notice'))).toContain('fatal: not a git repository')
    expect(textOf(container.querySelector('.trace-empty'))).toContain('此目录不是 git 仓库')
    expect(container.querySelector('.git-log')).toBeNull()
    // 错误态没有可点的刷新钮（只有一句说明）——重试靠重挂面板。
    expect(container.querySelector('[aria-label="刷新状态"]')).toBeNull()
  })
})

describe('变更面板：点文件与差异视图', () => {
  test('点已暂存文件按 staged 回传 git-diff，并按绝对路径开预览页签', async () => {
    const harness = harnessOf({
      cwd: 'C:/proj3',
      gitStatus: () => STATUS,
      gitDiff: () => ({ diff: ONE_FILE_DIFF, note: '' }),
    })
    const { container } = mountTab(GitTab, harness.channel)
    await flush()

    fireEvent.click(container.querySelector('.git-group .git-file-name') as HTMLElement)
    await flush()

    expect(methodsOf(harness.calls, 'git-diff').at(-1)?.payload).toEqual({ file: 'a.ts', staged: true })
    expect(dockPathsOf('preview')).toContain('C:/proj3/a.ts')
  })

  test('宿主合成不出 diff（note）：说明上屏，仍开预览页签而不是空 diff', async () => {
    const harness = harnessOf({
      cwd: 'C:/proj4',
      gitStatus: () => ({ branch: 'main', staged: [], unstaged: [], untracked: ['c.ts'] }),
      gitDiff: () => ({ diff: '', note: '二进制文件，无法显示 diff' }),
    })
    const { container } = mountTab(GitTab, harness.channel)
    await flush()

    fireEvent.click(container.querySelector('.git-file-name') as HTMLElement)
    await flush()

    // 未跟踪组不给 staged。
    expect(methodsOf(harness.calls, 'git-diff').at(-1)?.payload).toEqual({ file: 'c.ts' })
    expect(textOf(container.querySelector('.notice'))).toContain('二进制文件，无法显示 diff')
    expect(dockPathsOf('preview')).toContain('C:/proj4/c.ts')
  })

  test('全部改动：展开拉 git-diff，按文件分段画路径与增删数，× 收起', async () => {
    const harness = harnessOf({
      gitStatus: () => STATUS,
      gitDiff: () => ({ diff: ALL_DIFF, note: '' }),
    })
    const { container } = mountTab(GitTab, harness.channel)
    await flush()

    fireEvent.click(container.querySelector('.git-diff-all') as HTMLElement)
    // 回包前先画加载态。
    expect(textOf(container.querySelector('.git-diff-view .trace-empty'))).toContain('读取中')
    await flush()

    expect(methodsOf(harness.calls, 'git-diff').at(-1)?.payload).toEqual({})
    expect(textOf(container.querySelector('.git-diff-title'))).toBe('全部未提交改动')
    const sections = [...container.querySelectorAll('.git-diff-file')]
    expect(sections).toHaveLength(2)
    expect(textOf(sections[0]?.querySelector('.git-diff-path'))).toBe('src/x.ts')
    expect(textOf(sections[0]?.querySelector('.changes-added'))).toBe('+2')
    expect(textOf(sections[0]?.querySelector('.changes-removed'))).toBe('-1')
    expect(textOf(sections[1]?.querySelector('.git-diff-path'))).toBe('y.ts')

    fireEvent.click(container.querySelector('[aria-label="关闭 diff 视图"]') as HTMLElement)
    expect(container.querySelector('.git-diff-view')).toBeNull()
  })
})

describe('变更面板：写类操作', () => {
  test('暂存 / 取消暂存回传 files，并带审批长超时；成功后重读状态', async () => {
    const harness = harnessOf({ gitStatus: () => STATUS })
    const { container } = mountTab(GitTab, harness.channel)
    await flush()

    fireEvent.click(container.querySelector('[aria-label="暂存 b.ts"]') as HTMLElement)
    await flush()
    const staged = methodsOf(harness.calls, 'git-stage').at(-1)
    expect(staged?.payload).toEqual({ files: ['b.ts'] })
    expect(staged?.options).toEqual({ timeoutMs: HUMAN_WAIT_TIMEOUT_MS })
    // 成功后 refresh：git-status 被再读一次。
    expect(methodsOf(harness.calls, 'git-status')).toHaveLength(2)

    fireEvent.click(container.querySelector('[aria-label="取消暂存 a.ts"]') as HTMLElement)
    await flush()
    const unstaged = methodsOf(harness.calls, 'git-unstage').at(-1)
    expect(unstaged?.payload).toEqual({ files: ['a.ts'] })
    expect(unstaged?.options).toEqual({ timeoutMs: HUMAN_WAIT_TIMEOUT_MS })
  })

  test('提交对话框：已暂存恒选中、可勾选未暂存；提交带 paths，成功后关闭并重读', async () => {
    const harness = harnessOf({ gitStatus: () => STATUS })
    const { container } = mountTab(GitTab, harness.channel)
    await flush()

    fireEvent.click(container.querySelector('.git-commit .btn-primary') as HTMLElement)
    const dialog = container.querySelector('.git-dialog') as HTMLElement
    expect(dialog.getAttribute('aria-label')).toBe('提交')

    const stagedBox = dialog.querySelector('.git-dialog-file input[type="checkbox"]') as HTMLInputElement
    expect(stagedBox.checked).toBe(true)
    expect(stagedBox.disabled).toBe(true)
    const include = dialog.querySelector('.git-dialog-include input') as HTMLInputElement
    expect(include.disabled).toBe(false)
    expect(textOf(dialog.querySelector('.git-dialog-include'))).toContain('包含未暂存（1）')

    const submit = () => dialog.querySelector('.btn-primary') as HTMLButtonElement
    expect(submit().disabled).toBe(true)
    fireEvent.change(dialog.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value: 'feat: 面板提交' },
    })
    // 只有已暂存文件时也能提交。
    expect(submit().disabled).toBe(false)

    fireEvent.click(include)
    const unstagedBox = dialog.querySelector('[aria-label="包含 b.ts"]') as HTMLInputElement
    expect(unstagedBox.checked).toBe(true)

    fireEvent.click(submit())
    await flush()
    const commit = methodsOf(harness.calls, 'git-commit').at(-1)
    expect(commit?.payload).toEqual({ message: 'feat: 面板提交', paths: ['b.ts'] })
    expect(commit?.options).toEqual({ timeoutMs: HUMAN_WAIT_TIMEOUT_MS })
    expect(container.querySelector('.git-dialog')).toBeNull()
    expect(methodsOf(harness.calls, 'git-status')).toHaveLength(2)
  })
})

describe('tree-store（纯模块）', () => {
  test('按 cwd 分树、引用稳定；写入不可变替换并广播订阅者', () => {
    const cwd = 'C:/store/one'
    const tree = getTree(cwd)
    expect(getTree(cwd)).toBe(tree)
    expect(tree.expanded).toEqual([cwd])
    expect(tree.scrollTop).toBe(0)

    let notified = 0
    const off = subscribe(() => {
      notified += 1
    })
    setLevel(cwd, cwd, { kind: 'ready', entries: FILE_ENTRIES, truncated: false })
    off()

    expect(notified).toBe(1)
    const next = getTree(cwd)
    expect(next).not.toBe(tree)
    expect(tree.levels[cwd]).toBeUndefined()
    expect(needsLoad(cwd, cwd)).toBe(false)
    expect(needsLoad(cwd, 'C:/store/one/missing')).toBe(true)

    setLevel(cwd, 'C:/store/one/bad', { kind: 'failed', message: 'EACCES' })
    expect(needsLoad(cwd, 'C:/store/one/bad')).toBe(true)
  })

  test('展开集可增删；滚动位写入不广播', () => {
    const cwd = 'C:/store/two'
    let notified = 0
    const off = subscribe(() => {
      notified += 1
    })

    toggleExpanded(cwd, 'C:/store/two/src')
    expect(getTree(cwd).expanded).toContain('C:/store/two/src')
    expect(notified).toBe(1)

    toggleExpanded(cwd, 'C:/store/two/src')
    expect(getTree(cwd).expanded).not.toContain('C:/store/two/src')
    expect(notified).toBe(2)

    setScrollTop(cwd, 240)
    expect(getTree(cwd).scrollTop).toBe(240)
    expect(notified).toBe(2)
    off()
  })

  test('目录在前、数字按值、大小写不敏感', () => {
    const entries: TreeEntry[] = [
      { name: 'B.ts', dir: false, size: 1 },
      { name: 'a.ts', dir: false, size: 1 },
      { name: 'c2', dir: true, size: 0 },
      { name: 'c10', dir: true, size: 0 },
      { name: 'A.ts', dir: false, size: 1 },
    ]
    expect(orderEntries(entries).map((entry) => entry.name)).toEqual([
      'c2',
      'c10',
      'a.ts',
      'A.ts',
      'B.ts',
    ])
  })
})

describe('文件树', () => {
  test('根层先 loading；回包后目录在前、数字按值，根行写「工作区根目录」', async () => {
    const cwd = 'C:/tree/ten'
    const harness = harnessOf({
      cwd,
      fsList: (dir) => ({ cwd: dir, entries: FILE_ENTRIES, truncated: false }),
    })
    const { container } = mountTab(FilesTab, harness.channel)

    expect(container.querySelector('[data-tree-note="loading"]')).not.toBeNull()
    await flush()

    expect(methodsOf(harness.calls, 'fs-list')[0]?.payload).toEqual({ dir: cwd })
    expect(textOf(container.querySelector('.files-cwd'))).toBe('工作区根目录')
    const names = [
      ...container.querySelectorAll(
        '.files-list > .file-row .file-name, .files-list > .tree-item > .file-row .file-name',
      ),
    ].map(textOf)
    expect(names).toEqual(['src', 'file2.txt', 'file10.txt'])
    expect(container.querySelectorAll('[data-tree-entry="file"] .file-size').length).toBe(2)
    expect(container.querySelector('[data-tree-entry="file"]')?.getAttribute('title')).toBe(
      joinPath(cwd, 'file2.txt'),
    )
  })

  test('目录展开才拉下一层；收起再展开走缓存，不重复请求', async () => {
    const cwd = 'C:/tree/eleven'
    const harness = harnessOf({
      cwd,
      fsList: (dir) =>
        dir === cwd
          ? { cwd, entries: [{ name: 'src', dir: true, size: 0 }], truncated: false }
          : { cwd: dir, entries: [{ name: 'index.ts', dir: false, size: 12 }], truncated: false },
    })
    const { container } = mountTab(FilesTab, harness.channel)
    await flush()

    const childCalls = () =>
      harness.calls.filter((call) => call.payload['dir'] === joinPath(cwd, 'src')).length
    expect(childCalls()).toBe(0)

    const dirRow = container.querySelector('[data-tree-entry="directory"] .file-row') as HTMLElement
    fireEvent.click(dirRow)
    await flush()

    expect(dirRow.getAttribute('aria-expanded')).toBe('true')
    expect(childCalls()).toBe(1)
    expect(textOf(container.querySelector('[data-tree-entry="file"]'))).toContain('index.ts')

    fireEvent.click(dirRow)
    expect(container.querySelector('[data-tree-entry="file"]')).toBeNull()
    fireEvent.click(dirRow)
    await flush()
    expect(textOf(container.querySelector('[data-tree-entry="file"]'))).toContain('index.ts')
    expect(childCalls()).toBe(1)
  })

  test('空目录 / 读取失败 / 截断各给人话', async () => {
    const empty = harnessOf({
      cwd: 'C:/tree/empty',
      fsList: (dir) => ({ cwd: dir, entries: [], truncated: false }),
    })
    const emptyView = mountTab(FilesTab, empty.channel)
    await flush()
    expect(textOf(emptyView.container.querySelector('[data-tree-note="empty"]'))).toBe('（空目录）')

    const failed = harnessOf({
      cwd: 'C:/tree/failed',
      fsList: () => Promise.reject(new Error('EACCES 拒绝访问')),
    })
    const failedView = mountTab(FilesTab, failed.channel)
    await flush()
    expect(textOf(failedView.container.querySelector('[data-tree-note="failed"]'))).toContain('EACCES')

    const truncated = harnessOf({
      cwd: 'C:/tree/truncated',
      fsList: (dir) => ({ cwd: dir, entries: FILE_ENTRIES, truncated: true }),
    })
    const truncatedView = mountTab(FilesTab, truncated.channel)
    await flush()
    expect(textOf(truncatedView.container.querySelector('[data-tree-note="truncated"]'))).toBe(
      '条目过多，已截断显示',
    )
    expect(truncatedView.container.querySelectorAll('[data-tree-entry]').length).toBeGreaterThan(0)
  })

  test('刷新重拉根层与已展开层；滚动位从 store 恢复', async () => {
    const cwd = 'C:/tree/twelve'
    const harness = harnessOf({
      cwd,
      fsList: (dir) =>
        dir === cwd
          ? { cwd, entries: [{ name: 'src', dir: true, size: 0 }], truncated: false }
          : { cwd: dir, entries: [{ name: 'index.ts', dir: false, size: 1 }], truncated: false },
    })
    setScrollTop(cwd, 120)
    const { container } = mountTab(FilesTab, harness.channel)
    await flush()
    expect((container.querySelector('.files-list') as HTMLElement).scrollTop).toBe(120)

    fireEvent.click(container.querySelector('[data-tree-entry="directory"] .file-row') as HTMLElement)
    await flush()
    const countOf = (dir: string) =>
      harness.calls.filter((call) => call.payload['dir'] === dir).length
    expect(countOf(cwd)).toBe(1)
    expect(countOf(joinPath(cwd, 'src'))).toBe(1)

    fireEvent.click(container.querySelector('[aria-label="刷新文件树"]') as HTMLElement)
    await flush()
    expect(countOf(cwd)).toBe(2)
    expect(countOf(joinPath(cwd, 'src'))).toBe(2)
  })

  test('点文件按绝对路径开预览页签，并点亮当前行', async () => {
    const cwd = 'C:/tree/thirteen'
    const harness = harnessOf({
      cwd,
      fsList: (dir) => ({
        cwd: dir,
        entries: [{ name: 'a.ts', dir: false, size: 3 }],
        truncated: false,
      }),
    })
    const { container } = mountTab(FilesTab, harness.channel)
    await flush()

    const row = container.querySelector('[data-tree-entry="file"]') as HTMLElement
    fireEvent.click(row)
    await flush()

    expect(dockPathsOf('preview')).toContain(joinPath(cwd, 'a.ts'))
    expect(row.className).toContain('on')
  })
})
