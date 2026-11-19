/**
 * 输入区的第四批补测：已有 spec 没走到的错误路径与会话切换分支。
 *
 * 覆盖点（对应 `ui.tsx` 的缺口行）：
 *   - 「模式胶囊打开」跨组件收浮层（`shell.preset.open` 窗口事件）；
 *   - 草稿的「空归属」早退与换会话换草稿（`carryDraft` 那条 effect）；
 *   - `runUiCommand` 的两种失败文案（宿主协议拒绝 vs 其它原因）；
 *   - `interrupt` reject、`listUiCommands` 不可用、插话没赶上；
 *   - 视频附件抽帧：逐帧上传成功与单帧失败不挡消息；
 *   - 分支菜单的打开回调（开这一张时收掉输入区其它浮层）。
 *
 * @module dsc-ui-composer/ui/w11-branches.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

const attachmentsMock = vi.hoisted(() => ({ upload: vi.fn(), frames: vi.fn() }))

vi.mock('./attachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./attachments.js')>()
  return {
    ...actual,
    uploadFile: attachmentsMock.upload,
    extractVideoFrames: attachmentsMock.frames,
  }
})

/** 收下 `shell.composer` 的输入区登记（与壳装载插件同一条路）。 */
function composerBox(): ComponentType {
  const registered: Array<{ slot: string; id: string; component: unknown }> = []
  const fakeUi = {
    slots: {
      register: (slot: string, options: { id?: string }, component: unknown): void => {
        registered.push({ slot, id: options.id ?? '', component })
      },
      declare: (): void => undefined,
      registerFactory: (): void => undefined,
      seat: (): undefined => undefined,
    },
    provide: (): void => undefined,
    consume(): undefined {
      return undefined
    },
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  const found = registered.find((item) => item.slot === 'shell.composer' && item.id === 'composer.box')
  if (found === undefined) throw new Error('composer 插件没有登记输入区')
  return found.component as ComponentType
}

const ComposerBox = composerBox()

interface SnapshotStatus {
  cwd: string
  sessionPath: string
  sessionId: string
  sessionUnsaved: boolean
  turnState: string
  inboxCount: number
  model: string
  provider: string
  effort: string
}

interface Harness {
  channel: HostChannel
  status: SnapshotStatus
  calls: Array<{ method: string; args: unknown[] }>
  notify(): void
  reply(method: string, value: unknown | (() => unknown)): void
}

/** 假通道：状态可变 + 订阅可通知；invoke 按方法名查应答表（Error = reject）。 */
function harnessOf(options: { sessionPath?: string } = {}): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const subscribers = new Set<() => void>()
  const replies = new Map<string, unknown | (() => unknown)>()
  const status: SnapshotStatus = {
    cwd: 'C:/repo',
    sessionPath: options.sessionPath ?? 'C:/repo/a.jsonl',
    sessionId: 's1',
    sessionUnsaved: false,
    turnState: 'idle',
    inboxCount: 0,
    model: 'deepseek-chat',
    provider: 'deepseek',
    effort: 'default',
  }
  const snapshot = {
    sessions: [],
    queued: [],
    notices: [],
    status,
    surfaces: {
      permissionPresets: {
        current: 'read',
        defaultName: 'read',
        options: [{ name: 'read', label: '只读', description: '只能读', builtin: true }],
      },
      preset: { current: 'standard', defaultName: 'standard', options: [], droppable: [] },
      git: { repo: true, branch: 'main', detached: false, dirtyFileCount: 0 },
    },
  } as unknown as HostSnapshot

  const invoke = <T,>(method: string, args: unknown[] = []): Promise<T> => {
    calls.push({ method, args })
    if (method === 'listUiCommands') {
      const reply = replies.get(method)
      if (reply instanceof Error) return Promise.reject(reply) as Promise<T>
      return Promise.resolve((reply ?? []) as T)
    }
    if (method === 'listModels') {
      return Promise.resolve((replies.get(method) ?? [
        {
          value: 'deepseek/deepseek-chat',
          provider: 'deepseek',
          providerDisplayName: 'DeepSeek',
          model: 'deepseek-chat',
          description: 'chat',
          contextWindow: 128_000,
          thinkingLevels: ['off', 'high'],
          modalities: ['text', 'image'],
        },
      ]) as T)
    }
    if (method === 'dock' && args[0] === 'git-branches') {
      return Promise.resolve({ current: 'main', detached: false, branches: [{ name: 'main', current: true }] } as T)
    }
    const reply = replies.get(method)
    if (reply instanceof Error) return Promise.reject(reply) as Promise<T>
    if (typeof reply === 'function') {
      try {
        return Promise.resolve((reply as () => unknown)() as T)
      } catch (error) {
        return Promise.reject(error) as Promise<T>
      }
    }
    return Promise.resolve((reply ?? { ok: true }) as T)
  }

  const channel: HostChannel = {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: (listener) => {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    },
    invoke: invoke as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return {
    channel,
    status,
    calls,
    notify: () => {
      for (const listener of [...subscribers]) listener()
    },
    reply: (method, value) => {
      replies.set(method, value)
    },
  }
}

const mount = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <ComposerBox />
    </RuntimeProvider>,
  )

const textareaOf = (container: HTMLElement): HTMLTextAreaElement =>
  container.querySelector('textarea') as HTMLTextAreaElement

const type = (input: HTMLTextAreaElement, value: string): void => {
  fireEvent.change(input, { target: { value, selectionStart: value.length, selectionEnd: value.length } })
}

/** 让落在微任务里的 invoke 回包有机会跑完。 */
const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

beforeEach(() => {
  attachmentsMock.upload.mockReset()
  attachmentsMock.frames.mockReset()
  attachmentsMock.upload.mockResolvedValue({ url: '/api/attachments/x', path: '/tmp/x', sha: 's', kind: 'file', name: 'x', mime: 'x', bytes: 1 })
  attachmentsMock.frames.mockResolvedValue([new Blob(['f1']), new Blob(['f2'])])
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    callback(0)
    return 0
  })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:preview' })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined })
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ── 跨组件浮层互斥 ──────────────────────────────────────────────────────────

describe('命令清单不可用的第一拍（模块级缓存未建立时）', () => {
  test('命令清单取不到：菜单整轮不可用并给一句人话', async () => {
    const harness = harnessOf()
    harness.reply('listUiCommands', new Error('没有这条通道'))
    const { container } = mount(harness)
    type(textareaOf(container), '/')
    await waitFor(() => expect(container.querySelector('.shell-composer-fault')?.textContent).toContain('当前宿主没接'))
  })
})

describe('模式胶囊打开时收掉输入区浮层（shell.preset.open）', () => {
  test('权限菜单开着 → 事件到达后收起', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await waitFor(() => expect(container.querySelector('.model-anchor-sheet .model-btn')).not.toBeNull())
    fireEvent.click(container.querySelector('.model-anchor-sheet .model-btn') as HTMLElement)
    await waitFor(() => expect(container.querySelector('.policy-pop')).not.toBeNull())
    act(() => {
      window.dispatchEvent(new CustomEvent('shell.preset.open'))
    })
    expect(container.querySelector('.policy-pop')).toBeNull()
  })

  test('分支菜单开着 → 事件到达后收起（开这一张也会收掉别的）', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await waitFor(() => expect(container.querySelector('.git-btn')).not.toBeNull())
    fireEvent.click(container.querySelector('.git-btn') as HTMLElement)
    await waitFor(() => expect(container.querySelector('.git-pop')).not.toBeNull())
    act(() => {
      window.dispatchEvent(new CustomEvent('shell.preset.open'))
    })
    expect(container.querySelector('.git-pop')).toBeNull()
  })
})

// ── 草稿归属与会话切换 ──────────────────────────────────────────────────────

describe('草稿：空归属早退与换会话换草稿', () => {
  test('没有会话路径：正文照常可打，不往存档里写（key 为空）', async () => {
    const harness = harnessOf({ sessionPath: '' })
    const view = mount(harness)
    const input = textareaOf(view.container)
    type(input, '无归属草稿')
    expect(input.value).toBe('无归属草稿')
    view.unmount()
    // 重挂时同样从空归属早退：不会捡回上一份（本来就是空的）。
    const again = mount(harnessOf({ sessionPath: '' }))
    expect(textareaOf(again.container).value).toBe('')
  })

  test('切会话：旧草稿存下、新会话空白；切回来原样捡回', async () => {
    const harness = harnessOf({ sessionPath: 'C:/repo/a.jsonl' })
    const { container } = mount(harness)
    type(textareaOf(container), 'A 的草稿')

    await act(async () => {
      harness.status.sessionPath = 'C:/repo/b.jsonl'
      harness.notify()
    })
    expect(textareaOf(container).value).toBe('')

    type(textareaOf(container), 'B 的草稿')
    await act(async () => {
      harness.status.sessionPath = 'C:/repo/a.jsonl'
      harness.notify()
    })
    expect(textareaOf(container).value).toBe('A 的草稿')
  })
})

// ── 命令派发与打断的失败路径 ────────────────────────────────────────────────

describe('写路径的失败文案', () => {
  test('runUiCommand 被宿主拒绝（协议不允许）：换成可照着做的那句', async () => {
    const harness = harnessOf()
    harness.reply('runUiCommand', new Error('协议不允许调用的方法：runUiCommand'))
    const { container } = mount(harness)
    type(textareaOf(container), '/status')
    fireEvent.keyDown(textareaOf(container), { key: 'Enter' })
    await waitFor(() => expect(container.querySelector('.shell-composer-fault')?.textContent).toContain('当前宿主没有接上这条通道'))
    expect(harness.calls.some((entry) => entry.method === 'runUiCommand')).toBe(true)
  })

  test('runUiCommand 的其它失败：原因原样显示', async () => {
    const harness = harnessOf()
    harness.reply('runUiCommand', new Error('宿主内部错误'))
    const { container } = mount(harness)
    type(textareaOf(container), '/status')
    fireEvent.keyDown(textareaOf(container), { key: 'Enter' })
    await waitFor(() => expect(container.querySelector('.shell-composer-fault')?.textContent).toBe('宿主内部错误'))
  })

  test('打断失败：原因写进输入框下方', async () => {
    const harness = harnessOf()
    harness.status.turnState = 'running'
    harness.reply('interrupt', new Error('停不下来'))
    const { container } = mount(harness)
    await waitFor(() => expect(container.querySelector('.send-btn.stop')).not.toBeNull())
    fireEvent.click(container.querySelector('.send-btn.stop') as HTMLElement)
    await waitFor(() => expect(container.querySelector('.shell-composer-fault')?.textContent).toBe('停不下来'))
  })

  test('插话没赶上：宿主回 false 时说明这条会自己发出去', async () => {
    const harness = harnessOf()
    harness.status.turnState = 'running'
    harness.status.inboxCount = 1
    harness.reply('steerQueued', false)
    const { container } = mount(harness)
    type(textareaOf(container), '插一句')
    fireEvent.keyDown(textareaOf(container), { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(container.querySelector('.shell-composer-fault')?.textContent).toContain('插话没赶上'))
    expect(harness.calls.some((entry) => entry.method === 'steerQueued')).toBe(true)
    expect(harness.calls.some((entry) => entry.method === 'submit')).toBe(true)
  })
})

// ── 视频附件抽帧 ────────────────────────────────────────────────────────────

describe('视频附件：抽帧上传与单帧失败', () => {
  test('视频上传后抽两帧：成功一帧、失败一帧，整条消息照常可发', async () => {
    const harness = harnessOf()
    let uploads = 0
    attachmentsMock.upload.mockImplementation(async () => {
      uploads += 1
      if (uploads === 1) return { url: '/api/video', path: '/tmp/video', sha: 'v', kind: 'video', name: 'v.mp4', mime: 'video/mp4', bytes: 9 }
      if (uploads === 2) return { url: '/api/frame-1', path: '/tmp/f1', sha: 'f1', kind: 'image', name: 'f1.png', mime: 'image/png', bytes: 1 }
      throw new Error('第二帧传不上去')
    })
    const { container } = mount(harness)
    const file = new File(['video-bytes'], 'clip.mp4', { type: 'video/mp4' })
    fireEvent.paste(container.querySelector('.composer') as HTMLElement, { clipboardData: { files: [file] } })
    await waitFor(() => expect(container.querySelector('.attach-hint')).not.toBeNull(), { timeout: 3_000 })
    expect(attachmentsMock.frames).toHaveBeenCalled()
    expect(container.querySelector('.attach-hint')?.textContent).toContain('1')
    expect(container.querySelector('.attach-name')?.textContent).toContain('clip.mp4')
    expect(container.querySelector('.shell-composer-fault')).toBeNull()
    // 只发图视频不写字也算能发：发送钮此时应当可用。
    await flush()
    expect((container.querySelector('.send-btn:not(.stop)') as HTMLButtonElement).disabled).toBe(false)
  })
})
