/**
 * 文件预览（`ui-preview/ui/ui.tsx`）的分支补测（ui 层，真渲染）。
 *
 * 既有 `ui.spec.tsx` 覆盖空路径 / 读取中 / 读失败 / 图片 / 二进制 / 系统打开失败。
 * 这一份补它的分流其余各档：markdown / csv / 代码（含折行开关）、bytes 的 PDF 与表格、
 * 未知 mime、缺字段兜底、正文文件链接、补丁源（预览页签的改动视图与补丁页签）。
 *
 * @module dsc-ui-preview/ui/w11-branches.spec
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { dockSurface, dockTabMeta, setDockFileView, setDockPreview } from '@dsc/ui-dockkit'
import type { ChangedFileView, DockTabBodyProps, HostSnapshot, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

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

interface ReadResult {
  path: string
  kind: 'text' | 'image' | 'bytes' | 'binary'
  mime?: string
  base64?: string
  text?: string
  size?: number
  tooLarge: boolean
}

/** `fs-read` 的返回：主文件与 markdown 里相对图片分开答。 */
function harnessOf(read: (args: unknown[]) => Promise<unknown>): Harness {
  const calls: Invoke[] = []
  const channel: HostChannel = {
    getSnapshot: () => ({ status: { cwd: 'C:/repo', turnState: 'idle' } }) as unknown as HostSnapshot,
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

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''
const query = (root: HTMLElement, selector: string): HTMLElement => root.querySelector(selector) as HTMLElement

/** 与 locale/ui.zh.json 一致的几枚界面词（只用于按文本找按钮）。 */
const zhAdded = '新增'
const zhToPatch = '改动'
const zhToContent = '预览'

/** 从 dock 布局里按 kind + path 找页签 id（补丁源按页签 id 记账）。 */
function tabIdOf(kind: 'preview' | 'patch', path: string): string {
  for (const pane of dockSurface().panes) {
    for (const tab of pane.tabs) {
      if (tab.kind === kind && tab.path === path) return tab.id
    }
  }
  throw new Error(`dock 布局里没有 ${kind} 页签：${path}`)
}

const hunk = (newStart: number, newCount: number): ChangedFileView['hunks'][number] => ({
  oldStart: newStart,
  oldCount: newCount,
  newStart,
  newCount,
  lines: [],
})

const patchOf = (path: string, over: Partial<ChangedFileView> = {}): ChangedFileView => ({
  path,
  added: 3,
  removed: 1,
  hunks: [hunk(2, 2)],
  status: 'modified',
  ...over,
})

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  delete (globalThis as { dscNative?: unknown }).dscNative
  localStorage.clear()
})

describe('预览分流：文本各档', () => {
  test('markdown：按 cwd 裁相对路径，不出折行开关；相对图片走 fsRead', async () => {
    const main: ReadResult = {
      path: 'C:/repo/docs/readme.md',
      kind: 'text',
      text: '# 标题\n\n![图](pic.png)\n\n[打开代码](C:/repo/src/a.ts)',
      tooLarge: false,
    }
    const harness = harnessOf((args) => {
      const file = (args[1] as { file?: string } | undefined)?.file ?? ''
      if (file.endsWith('pic.png')) {
        return Promise.resolve({ kind: 'image', mime: 'image/png', base64: 'QUJD', tooLarge: false })
      }
      return Promise.resolve(main)
    })
    const { container } = mount(harness, PreviewTab, {
      id: 'md-tab',
      kind: 'preview',
      path: 'C:/repo/docs/readme.md',
    })
    await flush()

    expect(textOf(query(container, '.file-preview-path'))).toBe('docs/readme.md')
    expect(container.querySelector('.file-preview-wrap')).toBeNull()
    expect(textOf(query(container, '.file-preview-body'))).toContain('标题')
    // md 里的相对图片经 fsRead 转成 data URI。
    const image = container.querySelector('.file-preview-body img') as HTMLImageElement | null
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,QUJD')
    // 正文里的本地文件链接交给预览页签（registerFileLinkOpener 那条路）。
    const link = query(container, '.md-file-link')
    fireEvent.click(link)
    expect(tabIdOf('preview', 'C:/repo/src/a.ts')).toBeTruthy()
  })

  test('csv：走表格视图，不画折行开关；无扩展名的文本落到代码视图', async () => {
    const csv: ReadResult = {
      path: 'C:/repo/data.csv',
      kind: 'text',
      text: 'a,b\n1,2',
      tooLarge: false,
    }
    const withExt = mount(harnessOf(() => Promise.resolve(csv)), PreviewTab, {
      id: 'csv-tab',
      kind: 'preview',
      path: 'C:/repo/data.csv',
    })
    await flush()
    expect(withExt.container.querySelector('.file-preview-wrap')).toBeNull()
    expect(textOf(query(withExt.container, '.file-preview-body'))).toContain('解析中')
    cleanup()

    const noExt: ReadResult = { path: 'C:/repo/LICENSE', kind: 'text', text: 'hello', tooLarge: false }
    const plain = mount(harnessOf(() => Promise.resolve(noExt)), PreviewTab, {
      id: 'plain-tab',
      kind: 'preview',
      path: 'C:/repo/LICENSE',
    })
    await flush()
    expect(plain.container.querySelector('.file-code-plain')).not.toBeNull()
  })

  test('代码：头部折行开关默认开，点一下关并换提示；短路径不匹配 cwd 时原样显示', async () => {
    const code: ReadResult = { path: 'D:/other/a.ts', kind: 'text', text: 'const a = 1', tooLarge: false }
    const harness = harnessOf(() => Promise.resolve(code))
    const { container } = mount(harness, PreviewTab, { id: 'code-tab', kind: 'preview', path: 'D:/other/a.ts' })
    await flush()

    expect(textOf(query(container, '.file-preview-path'))).toBe('D:/other/a.ts')
    const wrap = query(container, '.file-preview-wrap')
    expect(wrap.getAttribute('aria-pressed')).toBe('true')
    const before = wrap.getAttribute('title')
    fireEvent.click(wrap)
    expect(wrap.getAttribute('aria-pressed')).toBe('false')
    expect(wrap.getAttribute('title')).not.toBe(before)
  })
})

describe('预览分流：二进制与 bytes', () => {
  test('图片缺 mime / base64：用 image/png 与空串兜底', async () => {
    const read: ReadResult = { path: 'C:/repo/x', kind: 'image', tooLarge: false }
    const { container } = mount(harnessOf(() => Promise.resolve(read)), PreviewTab, {
      id: 'img-tab',
      kind: 'preview',
      path: 'C:/repo/x',
    })
    await flush()
    expect((container.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe(
      'data:image/png;base64,',
    )
  })

  test('二进制缺 size：按 0 B 显示', async () => {
    const read: ReadResult = { path: 'C:/repo/blob', kind: 'binary', tooLarge: false }
    const { container } = mount(harnessOf(() => Promise.resolve(read)), PreviewTab, {
      id: 'bin-tab',
      kind: 'preview',
      path: 'C:/repo/blob',
    })
    await flush()
    expect(textOf(query(container, '.file-preview-empty'))).toContain('0 B')
  })

  test('bytes：PDF 走逐页视图；无 base64 的未知 mime 给占位，缺 mime 也有兜底文案', async () => {
    const pdf: ReadResult = {
      path: 'C:/repo/a.pdf',
      kind: 'bytes',
      mime: 'application/pdf',
      base64: 'JVBERi0=',
      tooLarge: false,
    }
    const pdfView = mount(harnessOf(() => Promise.resolve(pdf)), PreviewTab, {
      id: 'pdf-tab',
      kind: 'preview',
      path: 'C:/repo/a.pdf',
    })
    await flush()
    expect(pdfView.container.querySelector('.file-pdf')).not.toBeNull()
    cleanup()

    const unknown: ReadResult = {
      path: 'C:/repo/a.bin',
      kind: 'bytes',
      mime: 'application/octet-stream',
      tooLarge: false,
    }
    const placeholder = mount(harnessOf(() => Promise.resolve(unknown)), PreviewTab, {
      id: 'unknown-tab',
      kind: 'preview',
      path: 'C:/repo/a.bin',
    })
    await flush()
    expect(textOf(query(placeholder.container, '.file-preview-empty'))).toContain('application/octet-stream')
    cleanup()

    const noMime: ReadResult = { path: 'C:/repo/mystery', kind: 'bytes', tooLarge: false }
    const fallback = mount(harnessOf(() => Promise.resolve(noMime)), PreviewTab, {
      id: 'nomime-tab',
      kind: 'preview',
      path: 'C:/repo/mystery',
    })
    await flush()
    expect(textOf(query(fallback.container, '.file-preview-empty'))).toContain('未知')
  })

  test('bytes 非 PDF 且有 base64：走表格视图（解析中占位）', async () => {
    const xlsx: ReadResult = {
      path: 'C:/repo/book.xlsx',
      kind: 'bytes',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: 'AAAA',
      tooLarge: false,
    }
    const { container } = mount(harnessOf(() => Promise.resolve(xlsx)), PreviewTab, {
      id: 'xlsx-tab',
      kind: 'preview',
      path: 'C:/repo/book.xlsx',
    })
    await flush()
    expect(textOf(query(container, '.file-preview-body'))).toContain('解析中')
  })
})

describe('预览页签：改动视图', () => {
  test('挂补丁源时出增删计数与改动开关；切过去画 diff，再切回内容', async () => {
    const path = 'C:/repo/src/patched.ts'
    const patch = patchOf(path, {
      status: 'added',
      added: 5,
      removed: 0,
      truncated: true,
      hunks: [hunk(1, 0), hunk(3, 2)],
    })
    setDockFileView({ path, patch })
    const tabId = tabIdOf('preview', path)
    const read: ReadResult = { path, kind: 'text', text: 'const a = 1', tooLarge: false }
    const { container } = mount(harnessOf(() => Promise.resolve(read)), PreviewTab, {
      id: tabId,
      kind: 'preview',
      path,
    })
    await flush()

    expect(textOf(query(container, '.changes-added'))).toBe('+5')
    expect(textOf(query(container, '.changes-removed'))).toBe('-0')
    expect(textOf(query(container, '.diff-badge'))).toBe(zhAdded)
    const toggle = [...container.querySelectorAll('button')].find(
      (button) => textOf(button) === zhToPatch,
    ) as HTMLButtonElement
    fireEvent.click(toggle)
    expect(textOf(query(container, '.file-preview-body'))).not.toContain('解析中')
    expect(container.querySelector('.diff-note')).not.toBeNull()

    fireEvent.click([...container.querySelectorAll('button')].find((button) => textOf(button) === zhToContent)!)
    expect(container.querySelector('.diff-note')).toBeNull()
  })
})

describe('补丁页签', () => {
  test('有快照：增删计数、truncated 提示与 diff；「打开」开预览页签', async () => {
    const path = 'C:/repo/src/patch.ts'
    const patch = patchOf(path, { status: 'added', added: 2, removed: 0, truncated: true })
    setDockPreview({ path, patch })
    const tabId = tabIdOf('patch', path)
    const { container } = mount(harnessOf(() => Promise.resolve(null)), PatchTab!, { id: tabId, kind: 'patch', path })
    await flush()

    expect(textOf(query(container, '.changes-added'))).toBe('+2')
    expect(textOf(query(container, '.changes-removed'))).toBe('-0')
    expect(container.querySelector('.diff-badge')).not.toBeNull()
    expect(container.querySelector('.diff-note')).not.toBeNull()
    const open = [...container.querySelectorAll('button')].find((button) => textOf(button) === '打开')!
    fireEvent.click(open)
    expect(tabIdOf('preview', path)).toBeTruthy()
  })

  test('快照 present 但 truncated=false：不画截断提示；系统打开失败写人话', async () => {
    const path = 'C:/repo/src/clean.ts'
    const patch = patchOf(path, { status: 'modified', truncated: false })
    setDockPreview({ path, patch })
    const tabId = tabIdOf('patch', path)
    ;(globalThis as { dscNative?: unknown }).dscNative = {
      version: 1,
      call: (op: string): Promise<unknown> =>
        op === 'openPath' ? Promise.reject(new Error('no opener')) : Promise.resolve({ ok: true }),
      on: () => () => undefined,
    }
    const { container } = mount(harnessOf(() => Promise.resolve(null)), PatchTab!, { id: tabId, kind: 'patch', path })
    await flush()

    expect(container.querySelector('.diff-note')).toBeNull()
    expect(container.querySelector('.diff-badge')).toBeNull()
    const system = [...container.querySelectorAll('button')].find((button) => textOf(button) === '系统打开')!
    fireEvent.click(system)
    await flush()
    expect(textOf(query(container, '.tree-note'))).toContain('no opener')
  })
})
