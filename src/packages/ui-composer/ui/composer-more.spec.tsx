/**
 * 输入区（`ui.tsx` 及其兄弟组件）的第三批补测（ui 层，真渲染）。
 *
 * 与已有三份的分工：
 * - `composer.spec.tsx` 钉输入 / 发送 / 打断主干；
 * - `composer-extra.spec.tsx` 钉模型菜单、附件上传、命令面板、排队发送；
 * - 这一份只补它们**没走到**的分支：
 *   - 排队条（`QueueDock`）的折叠、编辑、撤回、插话与两种失败回执；
 *   - 待投递通知条（`NoticeStrip`）四类标记文本的压行；
 *   - 顶栏模式胶囊（`PresetChip`）的默认 / 有问题徽标、写口与跨组件收浮层；
 *   - 权限预设菜单的原生桥两态（桥缺席 / 桥在）与空清单；
 *   - 模型 chip 的「清单里没有当前模型」、单端点扁铺、空清单、无可切档位；
 *   - 档位滑杆的 End / 指针拖动 / 写入失败；
 *   - `/` 命令面板的加载态、回合中禁用标记与空结果；`@` 提及面板的加载 / 补全 / 空态；
 *   - 输入历史的上下键、`composerDraft` 服务口、拖拽目标的细节；
 *   - 上传网络失败、图片格式拒收、超过 20 张时的截断提示。
 *
 * 假通道沿用 composer-extra 的形状：`invoke` 按方法名路由，附件上传走一条假 XHR。
 *
 * @module dsc-ui-composer/ui/composer-more.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

interface Provided {
  [name: string]: unknown
}

interface Registered {
  slot: string
  id: string
  component: unknown
}

/** 照壳装载插件那条路收下四个登记；`provide` 的口子也一并记下（composerDraft）。 */
function capture(): { slots: Map<string, ComponentType>; provided: Provided } {
  const registered: Registered[] = []
  const provided: Provided = {}
  const fakeUi = {
    slots: {
      register: (slot: string, options: { id?: string }, component: unknown): void => {
        registered.push({ slot, id: options.id ?? '', component })
      },
      declare: (): void => undefined,
      registerFactory: (): void => undefined,
      seat: (): undefined => undefined,
    },
    provide: (name: string, value: unknown): void => {
      provided[name] = value
    },
    consume(): undefined {
      return undefined
    },
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  const slots = new Map<string, ComponentType>()
  for (const item of registered) {
    if (item.slot === 'shell.composer' || item.slot === 'shell.header.lead') {
      slots.set(item.id, item.component as ComponentType)
    }
  }
  return { slots, provided }
}

const { slots, provided } = capture()
const ComposerBox = slots.get('composer.box') as ComponentType
const QueueDock = slots.get('composer.queue') as ComponentType
const NoticeStrip = slots.get('composer.notices') as ComponentType
const PresetChip = slots.get('composer.preset') as ComponentType

/** 模型清单的一行（字段与宿主 `ModelChoiceView` 同形）。 */
function choice(
  provider: string,
  displayName: string,
  model: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    value: `${provider}/${model}`,
    provider,
    providerDisplayName: displayName,
    model,
    description: `${displayName} · ${model}`,
    contextWindow: 128_000,
    thinkingLevels: ['off', 'low', 'high', 'max'],
    modalities: ['text', 'image'],
    ...overrides,
  }
}

/** `/` 命令清单的一行。 */
function command(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, args: '', description: `${name} 的说明`, duringTask: 'allow', ...overrides }
}

interface HarnessOptions {
  turnState?: string
  inboxCount?: number
  queued?: Array<{ index: number; text: string; images?: string[] }>
  notices?: Array<{ index: number; text: string }>
  model?: string
  provider?: string
  effort?: string
  models?: unknown[]
  commands?: unknown[]
  /** `/` 清单挂起：测试自己 resolve，用来断言加载态。 */
  commandsPending?: boolean
  /** 命令清单按前缀的过滤结果由 `commands` 决定；false = invoke reject。 */
  commandChannelDown?: boolean
  permissionPresets?: Record<string, unknown>
  preset?: Record<string, unknown>
  /** 编辑 / 撤回 / 插话的结果：false = 宿主说没做到；`error` = 调用本身 rejection。 */
  editResult?: boolean | Error
  removeResult?: boolean | Error
  steerResult?: boolean | Error
  setEffortError?: Error
  /** 工作区根与文件：`@` 补全用。 */
  roots?: Array<{ path: string; main?: boolean }>
  files?: Record<string, string[]>
}

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
  resolveCommands: ((list: unknown[]) => void) | null
}

let sessionSeq = 0

function harnessOf(options: HarnessOptions = {}): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  sessionSeq += 1
  const harness: Harness = { channel: undefined as unknown as HostChannel, calls, resolveCommands: null }
  const snapshot = {
    sessions: [],
    queued: options.queued ?? [],
    notices: options.notices ?? [],
    status: {
      cwd: 'C:/repo',
      sessionPath: `C:/repo/more-${String(sessionSeq)}.jsonl`,
      turnState: options.turnState ?? 'idle',
      inboxCount: options.inboxCount ?? 0,
      model: options.model ?? '',
      provider: options.provider ?? '',
      effort: options.effort ?? 'default',
    },
    surfaces: {
      permissionPresets: options.permissionPresets ?? { options: [], current: 'custom' },
      ...(options.preset === undefined ? {} : { preset: options.preset }),
      git: { repo: false, branch: '', detached: false, dirtyFileCount: 0 },
    },
  } as unknown as HostSnapshot

  const settle = (value: boolean | Error | undefined): Promise<boolean> => {
    if (value instanceof Error) return Promise.reject(value)
    return Promise.resolve(value ?? true)
  }

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
      calls.push({ method, args })
      if (method === 'listModels') return Promise.resolve((options.models ?? []) as unknown as T)
      if (method === 'listUiCommands') {
        if (options.commandChannelDown === true) return Promise.reject(new Error('通道没接')) as Promise<T>
        if (options.commandsPending === true) {
          return new Promise<T>((resolve) => {
            harness.resolveCommands = (list) => {
              resolve(list as unknown as T)
            }
          })
        }
        return Promise.resolve((options.commands ?? []) as unknown as T)
      }
      if (method === 'editQueued') return settle(options.editResult) as Promise<T>
      if (method === 'removeQueued') return settle(options.removeResult) as Promise<T>
      if (method === 'steerQueued') return settle(options.steerResult) as Promise<T>
      if (method === 'setEffort' && options.setEffortError !== undefined) {
        return Promise.reject(options.setEffortError) as Promise<T>
      }
      if (method === 'dock') {
        const op = args[0]
        if (op === 'fs-roots') {
          const roots = options.roots ?? [{ path: 'C:/repo', main: true }]
          return Promise.resolve({ cwd: 'C:/repo', roots } as unknown as T)
        }
        if (op === 'fs-list') {
          const request = args[1] as { dir?: string } | undefined
          const dir = request?.dir ?? '.'
          const entries = (options.files?.[dir] ?? []).map((name) => ({ name, dir: false }))
          return Promise.resolve({ entries } as unknown as T)
        }
      }
      return Promise.resolve({ ok: true } as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  harness.channel = channel
  return harness
}

const mount = (harness: Harness, component: ComponentType): ReturnType<typeof render> => {
  const Component = component
  return render(
    <RuntimeProvider channel={harness.channel}>
      <Component />
    </RuntimeProvider>,
  )
}

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })

const textareaOf = (container: HTMLElement): HTMLTextAreaElement =>
  container.querySelector('textarea') as HTMLTextAreaElement
const composerOf = (container: HTMLElement): HTMLElement =>
  container.querySelector('.composer') as HTMLElement
const sendOf = (container: HTMLElement): HTMLButtonElement =>
  container.querySelector('.send-btn:not(.stop)') as HTMLButtonElement

/** 换输入框内容并给出光标位置（`commandQuery` / `tokenBefore` 都读 caret）。 */
function type(input: HTMLTextAreaElement, value: string, caret: number = value.length): void {
  fireEvent.change(input, { target: { value, selectionStart: caret, selectionEnd: caret } })
}

/** 假上传回包。 */
const FILE_META = {
  sha: 'sha-file',
  kind: 'file',
  name: 'notes.txt',
  mime: 'text/plain',
  bytes: 5,
  url: '/api/attachments/sha-file',
  path: '/tmp/sha-file',
}

const IMAGE_META = {
  sha: 'sha-image',
  kind: 'image',
  name: 'pic.png',
  mime: 'image/png',
  bytes: 3,
  url: '/api/attachments/sha-image',
  path: '/tmp/sha-image',
}

let uploadMeta: Record<string, unknown> = FILE_META
let uploadFails = false

/** 假 XHR：`send()` 后异步回包（网络失败可切换）。 */
class FakeXhr {
  static created: FakeXhr[] = []
  method = ''
  url = ''
  status = 200
  responseText = ''
  responseType = ''
  upload = {
    onprogress: null as ((event: { lengthComputable: boolean; total: number; loaded: number }) => void) | null,
  }

  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onabort: (() => void) | null = null

  constructor() {
    FakeXhr.created.push(this)
  }

  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }

  send(): void {
    setTimeout(() => {
      if (uploadFails) {
        this.onerror?.()
        return
      }
      this.upload.onprogress?.({ lengthComputable: true, total: 10, loaded: 7 })
      this.status = 200
      this.responseText = JSON.stringify({ ok: true, attachment: uploadMeta })
      this.onload?.()
    }, 0)
  }
}

const createObjectUrl = vi.fn(() => 'blob:preview')
const revokeObjectUrl = vi.fn()

beforeEach(() => {
  localStorage.clear()
  uploadMeta = FILE_META
  uploadFails = false
  FakeXhr.created = []
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  vi.stubGlobal('createImageBitmap', async () => ({ width: 64, height: 64, close: () => undefined }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    callback(0)
    return 0
  })
  if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
    vi.stubGlobal('CSS', { escape: (value: string) => value })
  }
  // jsdom 没有 PointerEvent / DragEvent：补成 MouseEvent 的子类，构造参数（button /
  // clientX / relatedTarget）才会真的落到事件对象上。
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent !== 'function') {
    vi.stubGlobal('PointerEvent', class extends MouseEvent {})
  }
  if (typeof (globalThis as { DragEvent?: unknown }).DragEvent !== 'function') {
    vi.stubGlobal('DragEvent', class extends MouseEvent {})
  }
  Element.prototype.setPointerCapture = () => undefined
  Element.prototype.releasePointerCapture = () => undefined
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.scrollIntoView = () => undefined
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  createObjectUrl.mockClear()
  revokeObjectUrl.mockClear()
  delete (globalThis as { dscNative?: unknown }).dscNative
})

/** 桌面窗口的原生桥。 */
function fakeNative(
  call: (op: string, args: unknown[]) => Promise<unknown>,
): Array<{ op: string; args: unknown[] }> {
  const calls: Array<{ op: string; args: unknown[] }> = []
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (op: string, args: unknown[] = []) => {
      calls.push({ op, args })
      return call(op, args)
    },
    on: () => () => undefined,
  }
  return calls
}

// ── 排队条 ────────────────────────────────────────────────────────────────

describe('排队消息条', () => {
  test('单条：没有折叠头，行首带队列图标、正文压成一行、图片徽标写张数', async () => {
    const harness = harnessOf({
      queued: [{ index: 0, text: '第一条\n  消息   内容', images: ['a', 'b'] }],
    })
    const { container } = mount(harness, QueueDock)
    await flush()
    expect(container.querySelector('.queue-head')).toBeNull()
    expect(container.querySelector('.queue-lead')).not.toBeNull()
    expect(container.querySelector('.queue-text')?.textContent).toBe('第一条 消息 内容')
    expect(container.querySelector('.queue-text')?.getAttribute('data-tip')).toBe('第一条\n  消息   内容')
    expect(container.querySelector('.queue-badge')?.textContent).toBe('+2 图')
    expect(container.querySelector('.queue-badge')?.getAttribute('data-tip')).toBe('随这条一起排队的 2 张图')
  })

  test('多条：默认折叠只露头行；点头行展开，再点收起；超长正文截到 200 字', async () => {
    const long = '字'.repeat(201)
    const harness = harnessOf({
      queued: [
        { index: 0, text: long },
        { index: 1, text: '第二条' },
      ],
    })
    const { container } = mount(harness, QueueDock)
    await flush()
    const head = container.querySelector('.queue-head') as HTMLButtonElement
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(head.textContent).toContain('2 条排队消息')
    expect(container.querySelectorAll('.queue-row')).toHaveLength(0)

    fireEvent.click(head)
    await flush()
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelectorAll('.queue-row')).toHaveLength(2)
    expect(container.querySelector('.queue-text')?.textContent).toBe(`${'字'.repeat(200)}…`)

    fireEvent.click(head)
    await flush()
    expect(container.querySelectorAll('.queue-row')).toHaveLength(0)
  })

  test('编辑：回车保存把下标与新正文交给宿主，成功后退出编辑态；空值不让保存', async () => {
    const harness = harnessOf({ queued: [{ index: 7, text: '旧正文' }] })
    const { container } = mount(harness, QueueDock)
    await flush()
    fireEvent.click(container.querySelector('[aria-label="编辑排队消息"]') as HTMLButtonElement)
    await flush()
    const box = container.querySelector('.queue-edit-box') as HTMLTextAreaElement
    const save = (): HTMLButtonElement => {
      const buttons = [...container.querySelectorAll('.queue-act')] as HTMLButtonElement[]
      return buttons.find((button) => button.getAttribute('aria-label') === '保存排队消息') as HTMLButtonElement
    }
    expect(box.value).toBe('旧正文')
    fireEvent.change(box, { target: { value: '   ' } })
    expect(save().disabled).toBe(true)

    fireEvent.change(box, { target: { value: '  新正文  ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(harness.calls).toContainEqual({ method: 'editQueued', args: [7, '新正文'] }))
    await waitFor(() => expect(container.querySelector('.queue-edit-box')).toBeNull())
  })

  test('编辑失败分两种：宿主说没做到与调用本身出错，回执文字不同；Esc 取消不写', async () => {
    const rejected = harnessOf({ queued: [{ index: 0, text: '一' }], editResult: false })
    const first = mount(rejected, QueueDock)
    await flush()
    fireEvent.click(first.container.querySelector('[aria-label="编辑排队消息"]') as HTMLButtonElement)
    await flush()
    const boxOne = first.container.querySelector('.queue-edit-box') as HTMLTextAreaElement
    fireEvent.change(boxOne, { target: { value: '改一下' } })
    fireEvent.keyDown(boxOne, { key: 'Enter' })
    await waitFor(() => expect(first.container.querySelector('.shell-composer-fault')?.textContent).toBe('编辑失败：这条已经开始发送了'))
    expect(first.container.querySelector('.queue-edit-box')).not.toBeNull()
    fireEvent.keyDown(boxOne, { key: 'Escape' })
    await flush()
    expect(first.container.querySelector('.queue-edit-box')).toBeNull()
    cleanup()

    const broken = harnessOf({ queued: [{ index: 0, text: '一' }], editResult: new Error('通道断了') })
    const second = mount(broken, QueueDock)
    await flush()
    fireEvent.click(second.container.querySelector('[aria-label="编辑排队消息"]') as HTMLButtonElement)
    await flush()
    const boxTwo = second.container.querySelector('.queue-edit-box') as HTMLTextAreaElement
    fireEvent.change(boxTwo, { target: { value: '改一下' } })
    fireEvent.keyDown(boxTwo, { key: 'Enter' })
    await waitFor(() => expect(second.container.querySelector('.shell-composer-fault')?.textContent).toBe('编辑失败：通道断了'))
  })

  test('撤回：宿主说没做到给具体解释；插话先确认，取消不调宿主，确认后没生效也解释', async () => {
    const harness = harnessOf({
      queued: [{ index: 2, text: '一' }],
      turnState: 'streaming',
      removeResult: false,
      steerResult: false,
    })
    const { container } = mount(harness, QueueDock)
    await flush()
    fireEvent.click(container.querySelector('[aria-label="撤回排队消息"]') as HTMLButtonElement)
    await waitFor(() => expect(container.querySelector('.shell-composer-fault')?.textContent).toBe('撤掉失败：这条已经开始发送了'))

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(container.querySelector('[aria-label="插话发送"]') as HTMLButtonElement)
    await flush()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0]?.[0]).toContain('排在它前面的 2 条会立刻作为新一轮发出')
    expect(harness.calls.some((call) => call.method === 'steerQueued')).toBe(false)

    confirm.mockReturnValue(true)
    fireEvent.click(container.querySelector('[aria-label="插话发送"]') as HTMLButtonElement)
    await waitFor(() => expect(harness.calls).toContainEqual({ method: 'steerQueued', args: [2] }))
    await waitFor(() => expect(container.querySelector('.shell-composer-fault')?.textContent).toBe('插话未生效：这一轮刚结束，排队消息会自动发出'))
  })

  test('回合空闲时插话钮禁用；队列空了整块不渲染', async () => {
    const idle = harnessOf({ queued: [{ index: 0, text: '一' }], turnState: 'idle' })
    const { container } = mount(idle, QueueDock)
    await flush()
    const steer = container.querySelector('[aria-label="插话发送"]') as HTMLButtonElement
    expect(steer.disabled).toBe(true)
    expect(steer.getAttribute('data-tip')).toBe('这一轮已经结束，排队消息会自动发出')
    cleanup()

    const empty = harnessOf({ queued: [] })
    const second = mount(empty, QueueDock)
    await flush()
    expect(second.container.querySelector('.queue-dock')).toBeNull()
  })
})

// ── 待投递通知 ────────────────────────────────────────────────────────────

describe('待投递通知条', () => {
  test('四类机器通知各压成一句人话：队友汇报 / 审查 findings / 队友传话 / 认不出的兜底', async () => {
    const harness = harnessOf({
      notices: [
        { index: 0, text: '<teammate-report from="小明" state="完成">派给它的任务：x\n它的汇报：改了 A</teammate-report>' },
        { index: 1, text: '<review-findings teammate="审查员" state="完成">发现两处</review-findings>' },
        { index: 2, text: '<message from="user">看到请回</message>' },
        { index: 3, text: '一条普通提醒 <tag>x</tag>' },
      ],
    })
    const { container } = mount(harness, NoticeStrip)
    await flush()
    const labels = [...container.querySelectorAll('.notice-label')].map((node) => node.textContent)
    expect(labels).toEqual([
      '队友 小明 完成，汇报了，本步结束会交给模型',
      '审查队友 审查员 完成，交回了 findings，本步结束会交给模型',
      '队友 传来一条消息，本步结束会交给模型',
      '有一条待投递通知，本步结束会交给模型',
    ])
    const details = [...container.querySelectorAll('.notice-detail')].map((node) => node.textContent)
    expect(details).toEqual(['改了 A', '发现两处', '看到请回', '一条普通提醒 x'])
    // 没有 detail 时悬浮说明回落 label 本身。
    const emptyDetail = harnessOf({ notices: [{ index: 0, text: '<message from="user"></message>' }] })
    cleanup()
    const second = mount(emptyDetail, NoticeStrip)
    await flush()
    expect(second.container.querySelector('.notice-detail')).toBeNull()
    expect(second.container.querySelector('.notice-label')?.getAttribute('data-tip')).toBe('队友 传来一条消息，本步结束会交给模型')
  })

  test('没有通知时整块不渲染', async () => {
    const { container } = mount(harnessOf({ notices: [] }), NoticeStrip)
    await flush()
    expect(container.querySelector('.notice-strip')).toBeNull()
  })
})

// ── 模式胶囊（顶栏）────────────────────────────────────────────────────────

describe('模式胶囊', () => {
  const surface = {
    current: 'fast',
    defaultName: 'review',
    options: [
      { name: 'fast', label: '快速', description: '少绕弯', builtin: true },
      { name: 'review', label: '审查', description: '专找问题', problem: '工具缺失', builtin: false },
    ],
    droppable: [],
  }

  test('菜单带默认 / 有问题徽标，当前档禁用打勾；点另一档走 usePreset 并回执', async () => {
    const harness = harnessOf({ preset: surface })
    const { container } = mount(harness, PresetChip)
    await flush()
    const chip = container.querySelector('.preset-chip') as HTMLButtonElement
    expect(chip.textContent).toContain('快速')
    fireEvent.click(chip)
    const menu = container.querySelector('.preset-pop') as HTMLElement
    expect(menu).not.toBeNull()
    const rows = [...menu.querySelectorAll('.pop-item')] as HTMLButtonElement[]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.disabled).toBe(true)
    expect(rows[0]?.getAttribute('aria-checked')).toBe('true')
    expect(rows[1]?.textContent).toContain('默认')
    expect(rows[1]?.textContent).toContain('有问题')
    expect(rows[1]?.getAttribute('title')).toBe('工具缺失')

    fireEvent.click(rows[1] as HTMLButtonElement)
    await waitFor(() => expect(harness.calls).toContainEqual({ method: 'usePreset', args: ['review'] }))
    expect(container.querySelector('.preset-pop')).toBeNull()
    await waitFor(() => expect(document.querySelector('.dsc-toasts')?.textContent).toContain('已切到「审查」模式'))
  })

  test('打开时广播 shell.preset.open；Esc 与点遮罩各能关一次；空清单给「清单没取到」', async () => {
    const opened = vi.fn()
    window.addEventListener('shell.preset.open', opened)
    const harness = harnessOf({ preset: surface })
    const { container } = mount(harness, PresetChip)
    await flush()
    fireEvent.click(container.querySelector('.preset-chip') as HTMLButtonElement)
    expect(opened).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    await flush()
    expect(container.querySelector('.preset-pop')).toBeNull()

    fireEvent.click(container.querySelector('.preset-chip') as HTMLButtonElement)
    fireEvent.click(container.querySelector('.pop-mask') as HTMLElement)
    await flush()
    expect(container.querySelector('.preset-pop')).toBeNull()
    window.removeEventListener('shell.preset.open', opened)
    cleanup()

    const empty = harnessOf({
      preset: { current: 'custom', defaultName: '', options: [], droppable: [] },
    })
    const second = mount(empty, PresetChip)
    await flush()
    fireEvent.click(second.container.querySelector('.preset-chip') as HTMLButtonElement)
    expect(second.container.querySelector('.preset-pop .pop-item')?.textContent).toBe('清单没取到')
  })
})

// ── 权限预设 ──────────────────────────────────────────────────────────────

describe('权限预设菜单', () => {
  const presets = {
    current: 'workspace',
    defaultName: 'workspace',
    options: [
      { name: 'workspace', label: '工作区可写', description: '只能改工作区', builtin: true },
      { name: 'readonly', label: '只读', description: '不能写文件', builtin: true },
    ],
  }

  test('当前档禁用打勾；空清单给「清单没取到」', async () => {
    const harness = harnessOf({ permissionPresets: presets })
    const { container } = mount(harness, ComposerBox)
    await flush()
    const button = container.querySelector('button[aria-label^="权限预设"]') as HTMLButtonElement
    expect(button.getAttribute('aria-label')).toBe('权限预设：工作区可写')
    fireEvent.click(button)
    const menu = container.querySelector('.policy-pop') as HTMLElement
    const rows = [...menu.querySelectorAll('[role="menuitemradio"]')] as HTMLButtonElement[]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.disabled).toBe(true)
    expect(rows[0]?.getAttribute('aria-checked')).toBe('true')
    expect(rows[1]?.getAttribute('aria-checked')).toBe('false')
    cleanup()

    const empty = harnessOf({
      permissionPresets: { current: 'custom', defaultName: '', options: [] },
    })
    const second = mount(empty, ComposerBox)
    await flush()
    fireEvent.click(second.container.querySelector('button[aria-label^="权限预设"]') as HTMLButtonElement)
    expect(second.container.querySelector('.policy-pop .pop-item')?.textContent).toBe('清单没取到')
  })

  test('没有原生桥：点非当前档给「只在桌面窗口可用」，一次桥调用都不发生', async () => {
    const harness = harnessOf({ permissionPresets: presets })
    const { container } = mount(harness, ComposerBox)
    await flush()
    fireEvent.click(container.querySelector('button[aria-label^="权限预设"]') as HTMLButtonElement)
    const rows = [...container.querySelectorAll('.policy-pop [role="menuitemradio"]')] as HTMLButtonElement[]
    fireEvent.click(rows[1] as HTMLButtonElement)
    await waitFor(() => expect(container.querySelector('.shell-composer-fault')?.textContent).toContain('切权限预设只在桌面窗口可用'))
  })

  test('有原生桥：usePermissionPreset 收到预设名并回执；桥拒绝时把原因写在输入框下方', async () => {
    const calls = fakeNative(() => Promise.resolve({ ok: true }))
    const harness = harnessOf({ permissionPresets: presets })
    const { container } = mount(harness, ComposerBox)
    await flush()
    fireEvent.click(container.querySelector('button[aria-label^="权限预设"]') as HTMLButtonElement)
    let rows = [...container.querySelectorAll('.policy-pop [role="menuitemradio"]')] as HTMLButtonElement[]
    fireEvent.click(rows[1] as HTMLButtonElement)
    await waitFor(() => expect(calls).toContainEqual({ op: 'usePermissionPreset', args: ['readonly'] }))
    await waitFor(() => expect(document.querySelector('.dsc-toasts')?.textContent).toContain('权限预设已切到「只读」'))
    cleanup()

    fakeNative((op) => (op === 'usePermissionPreset' ? Promise.reject(new Error('宿主拒绝')) : Promise.resolve({ ok: true })))
    const broken = harnessOf({ permissionPresets: presets })
    const second = mount(broken, ComposerBox)
    await flush()
    fireEvent.click(second.container.querySelector('button[aria-label^="权限预设"]') as HTMLButtonElement)
    rows = [...second.container.querySelectorAll('.policy-pop [role="menuitemradio"]')] as HTMLButtonElement[]
    fireEvent.click(rows[1] as HTMLButtonElement)
    await waitFor(() => expect(second.container.querySelector('.shell-composer-fault')?.textContent).toBe('切权限预设失败：宿主拒绝'))
  })
})

// ── 模型菜单与档位 ────────────────────────────────────────────────────────

describe('模型菜单的剩余分支', () => {
  test('当前模型不在清单：菜单里明说；档位页给兜底说明；点「管理模型」广播设置跳转', async () => {
    const harness = harnessOf({
      model: 'gone',
      provider: 'p1',
      models: [choice('p1', '端点一', 'm1')],
    })
    const { container } = mount(harness, ComposerBox)
    await waitFor(() => expect(container.querySelector('.composer-model-chip')?.getAttribute('data-composer-model')).toBe('gone'))
    fireEvent.click(container.querySelector('.composer-model-chip') as HTMLButtonElement)
    const rows = [...container.querySelectorAll('.model-sheet [data-sheet-row]')] as HTMLButtonElement[]
    fireEvent.click(rows[0] as HTMLButtonElement)
    await flush()
    expect(container.querySelector('[data-model-unknown="true"]')?.textContent).toBe('当前：gone —— 清单里没有这个模型')

    const opened = vi.fn()
    window.addEventListener('shell.settings.open', opened)
    fireEvent.click(container.querySelector('[data-model-manage]') as HTMLButtonElement)
    expect(opened).toHaveBeenCalledTimes(1)
    expect((opened.mock.calls[0]?.[0] as CustomEvent<{ section: string }>).detail.section).toBe('models')
    window.removeEventListener('shell.settings.open', opened)

    fireEvent.click(container.querySelector('.composer-model-chip') as HTMLButtonElement)
    const sheetRows = [...container.querySelectorAll('.model-sheet [data-sheet-row]')] as HTMLButtonElement[]
    fireEvent.click(sheetRows[1] as HTMLButtonElement)
    await flush()
    expect(container.querySelector('.effort-note')?.textContent).toBe('模型不在清单里，列的是它声明的全部档位')
  })

  test('单端点直接扁铺模型：能力徽标与上下文都在；「返回」翻回根页', async () => {
    const harness = harnessOf({
      model: 'm1',
      provider: 'p1',
      models: [
        choice('p1', '端点一', 'm1', { modalities: ['text', 'image', 'video'] }),
        choice('p1', '端点一', 'm2', { contextWindow: 256_000 }),
      ],
    })
    const { container } = mount(harness, ComposerBox)
    await waitFor(() => expect(container.querySelector('.composer-model-chip')?.getAttribute('data-composer-model')).toBe('p1/m1'))
    fireEvent.click(container.querySelector('.composer-model-chip') as HTMLButtonElement)
    fireEvent.click(container.querySelector('.model-sheet [data-sheet-row]') as HTMLButtonElement)
    await flush()
    const panel = container.querySelector('.model-picker') as HTMLElement
    expect(panel.classList.contains('flat')).toBe(true)
    const rows = [...panel.querySelectorAll('.model-picker-row')] as HTMLButtonElement[]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('图')
    expect(rows[0]?.textContent).toContain('视频')
    expect(rows[0]?.textContent).toContain('128k')
    expect(rows[1]?.textContent).toContain('256k')

    fireEvent.click(panel.querySelector('.model-pane-back') as HTMLButtonElement)
    await flush()
    expect(container.querySelector('.model-sheet')).not.toBeNull()
  })

  test('清单为空：chip 写「未知模型」，模型页给「清单没取到」', async () => {
    const harness = harnessOf({ models: [] })
    const { container } = mount(harness, ComposerBox)
    await flush()
    expect(container.querySelector('.composer-model-chip')?.textContent).toContain('未知模型')
    fireEvent.click(container.querySelector('.composer-model-chip') as HTMLButtonElement)
    fireEvent.click(container.querySelector('.model-sheet [data-sheet-row]') as HTMLButtonElement)
    await flush()
    expect(container.querySelector('.model-picker .pop-item')?.textContent).toBe('清单没取到')
  })

  test('模型没有可切档位：根页第二行是静态行，不画滑杆', async () => {
    const harness = harnessOf({
      model: 'm1',
      provider: 'p1',
      models: [choice('p1', '端点一', 'm1', { thinkingLevels: [] })],
    })
    const { container } = mount(harness, ComposerBox)
    await waitFor(() => expect(container.querySelector('.composer-model-chip')?.getAttribute('data-composer-model')).toBe('p1/m1'))
    fireEvent.click(container.querySelector('.composer-model-chip') as HTMLButtonElement)
    expect(container.querySelectorAll('.model-sheet [data-sheet-row]')).toHaveLength(1)
    const fixed = container.querySelector('.model-sheet-row.static') as HTMLElement
    expect(fixed.textContent).toContain('推理等级')
    expect(fixed.textContent).toContain('默认')
    expect(fixed.getAttribute('title')).toContain('这个模型没有可切换的档位')
  })

  test('档位滑杆：End 落最后一档、Home 落第一档、指针按下抬起按横坐标落档', async () => {
    const harness = harnessOf({
      model: 'm1',
      provider: 'p1',
      effort: 'low',
      models: [choice('p1', '端点一', 'm1')],
    })
    const { container } = mount(harness, ComposerBox)
    await waitFor(() => expect(container.querySelector('.composer-model-chip')?.getAttribute('data-composer-model')).toBe('p1/m1'))
    fireEvent.click(container.querySelector('.composer-model-chip') as HTMLButtonElement)
    const rows = [...container.querySelectorAll('.model-sheet [data-sheet-row]')] as HTMLButtonElement[]
    fireEvent.click(rows[1] as HTMLButtonElement)
    await flush()
    const track = container.querySelector('[data-effort-track]') as HTMLElement
    fireEvent.keyDown(track, { key: 'End' })
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setEffort', args: ['max', true] })

    fireEvent.keyDown(track, { key: 'Home' })
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setEffort', args: ['off', true] })

    // jsdom 没有布局：轨道 rect 宽 0 → indexAt 落第一档。
    fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 10 })
    expect(track.getAttribute('data-dragging')).toBe('1')
    fireEvent.pointerUp(track, { button: 0, pointerId: 1, clientX: 10 })
    await flush()
    // 指针落点仍是第一档（Home 已经落过），同一个档位不重复发。
    expect(harness.calls.filter((call) => call.method === 'setEffort')).toHaveLength(2)
  })

  test('调档失败：乐观值撤掉，原因写进输入框下方', async () => {
    const harness = harnessOf({
      model: 'm1',
      provider: 'p1',
      effort: 'low',
      models: [choice('p1', '端点一', 'm1')],
      setEffortError: new Error('宿主不认这一档'),
    })
    const { container } = mount(harness, ComposerBox)
    await waitFor(() => expect(container.querySelector('.composer-model-chip')?.getAttribute('data-composer-effort')).toBe('low'))
    fireEvent.click(container.querySelector('.composer-model-chip') as HTMLButtonElement)
    const rows = [...container.querySelectorAll('.model-sheet [data-sheet-row]')] as HTMLButtonElement[]
    fireEvent.click(rows[1] as HTMLButtonElement)
    await flush()
    fireEvent.keyDown(container.querySelector('[data-effort-track]') as HTMLElement, { key: 'End' })
    await waitFor(() => expect(container.querySelector('.shell-composer-fault')?.textContent).toBe('宿主不认这一档'))
    expect(container.querySelector('.composer-model-chip')?.getAttribute('data-composer-effort')).toBe('low')
  })
})

// ── 命令面板与 @ 提及 ──────────────────────────────────────────────────────

describe('斜杠命令面板的剩余分支', () => {
  test('首次打开先给加载态；清单到手后过滤、回合中禁用标记、Esc 同前缀不再弹', async () => {
    const commands = [
      command('status'),
      command('review', { description: '审查改动', input: { hint: '写关注点' } }),
      command('new', { duringTask: 'deny' }),
    ]
    const harness = harnessOf({ commandsPending: true, turnState: 'streaming' })
    const { container } = mount(harness, ComposerBox)
    await flush()
    const input = textareaOf(container)
    type(input, '/', 1)
    await waitFor(() => expect(container.querySelector('.slash-item[data-loading="1"]')).not.toBeNull())
    expect(container.querySelector('.slash-item[data-loading="1"]')?.textContent).toBe('正在读取命令清单…')

    harness.resolveCommands?.(commands)
    await waitFor(() => expect(container.querySelectorAll('.slash-item[role="option"]')).toHaveLength(3))
    const rows = [...container.querySelectorAll('.slash-item[role="option"]')] as HTMLButtonElement[]
    const off = rows.find((row) => row.textContent?.includes('/new')) as HTMLButtonElement
    expect(off.classList.contains('off')).toBe(true)
    expect(off.textContent).toContain('回合中不可用')

    type(input, '/zzz', 4)
    await waitFor(() => expect(container.querySelector('.slash-item[data-empty="1"]')?.textContent).toBe('没有匹配的命令'))

    type(input, '/', 1)
    await waitFor(() => expect(container.querySelectorAll('.slash-item[role="option"]')).toHaveLength(3))
    fireEvent.keyDown(input, { key: 'Escape' })
    await flush()
    expect(container.querySelector('.slash-pop')).toBeNull()
    type(input, '/', 1)
    await flush()
    expect(container.querySelector('.slash-pop')).toBeNull()
  })

  test('mousedown 采纳候选优先于输入框失焦', async () => {
    // 上一条用例已经把清单缓存到模块里；这里直接复用同一批命令。
    const harness = harnessOf({ commands: [command('status'), command('review', { args: '<关注点>' })] })
    const { container } = mount(harness, ComposerBox)
    await flush()
    const input = textareaOf(container)
    type(input, '/re', 3)
    await waitFor(() => expect(container.querySelectorAll('.slash-item[role="option"]')).toHaveLength(1))
    fireEvent.mouseDown(container.querySelector('.slash-item[role="option"]') as HTMLButtonElement)
    await flush()
    expect(input.value).toBe('/review')
    expect(container.querySelector('.slash-pop')).toBeNull()
  })
})

describe('@ 文件提及面板', () => {
  test('输入 @ 先给加载态；候选按文件名排序；↓ + Tab 补全为相对路径；空结果与 Esc 同 token 不再弹', async () => {
    const harness = harnessOf({
      roots: [{ path: 'C:/repo', main: true }],
      files: { '.': ['README.md', 'src'] },
    })
    // 目录条目与文件条目分开（scanRoot 只在目录里递归）。
    harness.channel.invoke = (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      harness.calls.push({ method, args })
      if (method === 'listModels') return Promise.resolve([] as unknown as T)
      if (method === 'dock') {
        if (args[0] === 'fs-roots') return Promise.resolve({ cwd: 'C:/repo', roots: [{ path: 'C:/repo', main: true }] } as unknown as T)
        const dir = (args[1] as { dir?: string } | undefined)?.dir ?? '.'
        if (dir === '.') {
          return Promise.resolve({ entries: [{ name: 'README.md', dir: false }, { name: 'src', dir: true }] } as unknown as T)
        }
        return Promise.resolve({ entries: [{ name: 'app.ts', dir: false }] } as unknown as T)
      }
      return Promise.resolve({ ok: true } as T)
    }) as HostChannel['invoke']

    const { container } = mount(harness, ComposerBox)
    await flush()
    const input = textareaOf(container)
    type(input, '@', 1)
    // 根集合那一问还没回来：此刻面板就是加载态（随后才被候选替换）。
    expect(container.querySelector('.mention-item[data-loading="1"]')?.textContent).toBe('正在读取工作区文件…')
    await waitFor(() => {
      const rows = [...container.querySelectorAll('.mention-item[role="option"]')]
      expect(rows.map((row) => row.textContent)).toEqual(['README.md', 'src/app.ts'])
    })

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Tab' })
    await flush()
    expect(input.value).toBe('@src/app.ts ')

    type(input, '@zzz', 4)
    await waitFor(() => expect(container.querySelector('.mention-item[data-empty="1"]')?.textContent).toBe('没有匹配的文件'))
    fireEvent.keyDown(input, { key: 'Escape' })
    await flush()
    expect(container.querySelector('.mention-pop')).toBeNull()
    type(input, '@zzz', 4)
    await flush()
    expect(container.querySelector('.mention-pop')).toBeNull()
  })
})

// ── 输入历史 / 服务口 / 拖拽 ───────────────────────────────────────────────

describe('输入历史与服务口', () => {
  test('↑ 从草稿末条往回翻，↓ 前进，翻过末条回到空草稿；非空正文且没在翻历史时 ↑ 不抢', async () => {
    const harness = harnessOf()
    const { container } = mount(harness, ComposerBox)
    await flush()
    const input = textareaOf(container)
    for (const value of ['第一条', '第二条']) {
      type(input, value)
      fireEvent.keyDown(input, { key: 'Enter' })
      await flush()
    }
    type(input, '正在写')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    await flush()
    expect(input.value).toBe('正在写')

    type(input, '')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    await flush()
    expect(input.value).toBe('第二条')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    await flush()
    expect(input.value).toBe('第一条')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    await flush()
    expect(input.value).toBe('第一条')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await flush()
    expect(input.value).toBe('第二条')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await flush()
    expect(input.value).toBe('')
  })

  test('composerDraft 服务往输入框写字并聚焦、光标落在末尾', async () => {
    const harness = harnessOf()
    const { container } = mount(harness, ComposerBox)
    await flush()
    const service = provided['composerDraft'] as { insert(text: string): void }
    act(() => {
      service.insert('从能力卡写进来')
    })
    const input = textareaOf(container)
    expect(input.value).toBe('从能力卡写进来')
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe('从能力卡写进来'.length)
  })
})

describe('拖拽的细节', () => {
  test('非文件拖拽不亮；文件拖拽亮；离开到子节点不算离开；离开到外部才灭；空 drop / 空 paste 不清空', async () => {
    const harness = harnessOf()
    const { container } = mount(harness, ComposerBox)
    await flush()
    const composer = composerOf(container)
    fireEvent.dragEnter(composer, { dataTransfer: { types: ['text/plain'] } })
    expect(composer.hasAttribute('data-drag')).toBe(false)

    fireEvent.dragOver(composer, { dataTransfer: { types: ['Files'] } })
    expect(composer.getAttribute('data-drag')).toBe('1')

    fireEvent.dragLeave(composer, { relatedTarget: textareaOf(container) })
    expect(composer.getAttribute('data-drag')).toBe('1')

    fireEvent.dragLeave(composer, { relatedTarget: null })
    expect(composer.hasAttribute('data-drag')).toBe(false)

    fireEvent.drop(composer, { dataTransfer: { files: [], types: [] } })
    fireEvent.paste(composer, { clipboardData: { files: [] } })
    await flush()
    expect(container.querySelectorAll('.attach-item')).toHaveLength(0)
    expect(FakeXhr.created).toHaveLength(0)
  })
})

// ── 附件失败的边界 ─────────────────────────────────────────────────────────

describe('附件的失败边界', () => {
  test('上传网络中断：占位摘掉、预览地址释放、原因写在输入框下方', async () => {
    uploadFails = true
    const harness = harnessOf()
    const { container } = mount(harness, ComposerBox)
    await flush()
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    fireEvent.drop(composerOf(container), { dataTransfer: { files: [file], types: ['Files'] } })
    await waitFor(() => expect(container.querySelector('.shell-composer-fault')?.textContent).toContain('上传失败：网络连接中断'))
    expect(container.querySelectorAll('.attach-item')).toHaveLength(0)
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:preview')
  })

  test('图片格式不支持：拒收、不进占位、不发上传，原因可照着做', async () => {
    const harness = harnessOf({
      model: 'm1',
      provider: 'p1',
      models: [choice('p1', '端点一', 'm1')],
    })
    const { container } = mount(harness, ComposerBox)
    await waitFor(() => expect(container.querySelector('.composer-model-chip')?.getAttribute('data-composer-model')).toBe('p1/m1'))
    const file = new File([new Uint8Array([1, 2, 3])], 'bad.bmp', { type: 'image/bmp' })
    fireEvent.drop(composerOf(container), { dataTransfer: { files: [file], types: ['Files'] } })
    await waitFor(() => expect(container.querySelector('.shell-composer-fault')?.textContent).toContain('仅支持 PNG、JPG、WebP、GIF'))
    expect(container.querySelectorAll('.attach-item')).toHaveLength(0)
    expect(FakeXhr.created).toHaveLength(0)
  })

  test('超过 20 张图：只提交前 20 张，输入框下方说明丢了几张', async () => {
    uploadMeta = IMAGE_META
    const harness = harnessOf({
      model: 'm1',
      provider: 'p1',
      models: [choice('p1', '端点一', 'm1')],
    })
    const { container } = mount(harness, ComposerBox)
    await waitFor(() => expect(container.querySelector('.composer-model-chip')?.getAttribute('data-composer-model')).toBe('p1/m1'))
    const composer = composerOf(container)
    for (let index = 0; index < 21; index += 1) {
      const file = new File([new Uint8Array([1, 2, 3])], `pic-${String(index)}.png`, { type: 'image/png' })
      fireEvent.drop(composer, { dataTransfer: { files: [file], types: ['Files'] } })
    }
    await waitFor(() => expect(container.querySelectorAll('.attach-item')).toHaveLength(21))
    await waitFor(() => expect(container.querySelectorAll('.attach-item[data-uploading]')).toHaveLength(0))
    fireEvent.click(sendOf(container))
    await waitFor(() => expect(harness.calls.some((call) => call.method === 'submit')).toBe(true))
    const submit = harness.calls.find((call) => call.method === 'submit')!
    expect((submit.args[1] as string[])).toHaveLength(20)
    expect(container.querySelector('.shell-composer-fault')?.textContent).toBe('图片最多 20 张，已发送前 20 张（1 张未发送）')
  })
})
