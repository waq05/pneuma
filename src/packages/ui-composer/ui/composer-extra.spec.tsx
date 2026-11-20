/**
 * 输入区（`ui-composer/ui/ui.tsx` 的 ComposerBox）补测：模型选择、思考档位、附件上传/拖放/
 * 粘贴/灯箱、`/` 命令面板、排队发送与插话、失败重试。
 *
 * 与 `composer.spec.tsx` 的分工：那一份只钉「输入与发送/打断」主干；这一份铺真实交互的
 * 其余入口，每条都断言**回传参数或 DOM 状态**，不写 smoke。
 *
 * 假通道比 composer.spec 多三样：`listModels` / `listUiCommands` 的清单、`submit` 的可控
 * 失败次数，以及一条假 `XMLHttpRequest`（附件的上传进度与回包都走它）。
 *
 * @module dsc-ui-composer/ui/composer-extra.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

/** ComposerBox 不直接导出：照壳装载插件那条路，收下 `shell.composer` 的登记。 */
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
  if (found === undefined) throw new Error('composer 插件没有把输入区登记进 shell.composer')
  return found.component as ComponentType
}

const ComposerBox = composerBox()

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

/** `/` 命令清单的一行（字段与宿主 `UiCommandView` 同形）。 */
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
  /** `submit` 前几次失败（失败次数用完后成功）。 */
  submitFailures?: number
  /** `steerQueued` 的回话（false = 宿主说没赶上）。 */
  steerResult?: boolean
  sessionPath?: string
}

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
}

let sessionSeq = 0

function harnessOf(options: HarnessOptions = {}): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  let submitFailures = options.submitFailures ?? 0
  sessionSeq += 1
  const snapshot = {
    sessions: [],
    queued: options.queued ?? [],
    notices: options.notices ?? [],
    status: {
      cwd: 'C:/repo',
      sessionPath: options.sessionPath ?? `C:/repo/session-${String(sessionSeq)}.jsonl`,
      turnState: options.turnState ?? 'idle',
      inboxCount: options.inboxCount ?? 0,
      model: options.model ?? '',
      provider: options.provider ?? '',
      effort: options.effort ?? 'default',
    },
    surfaces: {
      permissionPresets: { options: [], current: 'custom' },
      git: { repo: false, branch: '', detached: false, dirtyFileCount: 0 },
    },
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
    invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      if (method === 'submit' && submitFailures > 0) {
        submitFailures -= 1
        return Promise.reject(new Error('宿主断线了'))
      }
      if (method === 'listModels') return Promise.resolve((options.models ?? []) as unknown as T)
      if (method === 'listUiCommands') return Promise.resolve((options.commands ?? []) as unknown as T)
      if (method === 'steerQueued') return Promise.resolve((options.steerResult ?? true) as unknown as T)
      return Promise.resolve({ ok: true } as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

const mount = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <ComposerBox />
    </RuntimeProvider>,
  )

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

const textareaOf = (container: HTMLElement): HTMLTextAreaElement =>
  container.querySelector('textarea') as HTMLTextAreaElement
const composerOf = (container: HTMLElement): HTMLElement =>
  container.querySelector('.composer') as HTMLElement
const sendOf = (container: HTMLElement): HTMLButtonElement =>
  container.querySelector('.send-btn:not(.stop)') as HTMLButtonElement
const attachNames = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('.attach-name')).map((node) => node.textContent ?? '')

/** 换输入框内容并给出光标位置：`commandQuery` 要靠 caret 判断「还在打命令名」。 */
function type(input: HTMLTextAreaElement, value: string, caret: number = value.length): void {
  fireEvent.change(input, { target: { value, selectionStart: caret, selectionEnd: caret } })
}

/** 假上传回包：一个通用文件的元数据（宿主 `/api/attachments` 的形状）。 */
const FILE_META = {
  sha: 'sha-file-1',
  kind: 'file',
  name: 'notes.txt',
  mime: 'text/plain',
  bytes: 5,
  url: '/api/attachments/sha-file-1',
  path: '/tmp/sha-file-1',
}

const IMAGE_META = {
  sha: 'sha-image-1',
  kind: 'image',
  name: 'pic.png',
  mime: 'image/png',
  bytes: 3,
  url: '/api/attachments/sha-image-1',
  path: '/tmp/sha-image-1',
}

interface UploadBehavior {
  /** `manual` = `send()` 之后不回调，测试自己决定何时完成。 */
  mode: 'auto' | 'manual'
  meta: Record<string, unknown>
  /** auto 模式下调用 `onerror`（网络中断）。 */
  fail?: boolean
}

let uploadBehavior: UploadBehavior = { mode: 'auto', meta: FILE_META }

/** 被附件上传调用的假 XHR：记录 open/send，按行为回包（不必真连网）。 */
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
    if (uploadBehavior.mode === 'manual') return
    setTimeout(() => {
      if (uploadBehavior.fail === true) {
        this.onerror?.()
        return
      }
      this.upload.onprogress?.({ lengthComputable: true, total: 10, loaded: 7 })
      this.status = 200
      this.responseText = JSON.stringify({ ok: true, attachment: uploadBehavior.meta })
      this.onload?.()
    }, 0)
  }
}

/** jsdom 没有 `URL.createObjectURL`（附件预览用它），补一对可断言的桩。 */
const createObjectUrl = vi.fn(() => 'blob:fake-preview')
const revokeObjectUrl = vi.fn()

beforeEach(() => {
  localStorage.clear()
  uploadBehavior = { mode: 'auto', meta: FILE_META }
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
  // jsdom 的 Element 没有 scrollIntoView：模型菜单展开时会把当前项滚进视野。
  Element.prototype.scrollIntoView = () => undefined
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  createObjectUrl.mockClear()
  revokeObjectUrl.mockClear()
})

describe('模型与思考档位', () => {
  test('chip 读模型与档位；两行卡进模型菜单，悬浮端点出二级、点模型回传 setModel', async () => {
    const harness = harnessOf({
      model: 'm1',
      provider: 'p1',
      effort: 'low',
      models: [
        choice('p1', '端点一', 'm1'),
        choice('p1', '端点一', 'm1-mini', { modalities: ['text'] }),
        choice('p2', '端点二', 'm2'),
      ],
    })
    const { container } = mount(harness)
    await waitFor(() => {
      expect(container.querySelector('.composer-model-chip')?.getAttribute('data-composer-model')).toBe('p1/m1')
    })
    const chip = container.querySelector('.composer-model-chip') as HTMLButtonElement
    expect(chip.textContent).toContain('m1')
    expect(chip.textContent).toContain('低')
    expect(chip.getAttribute('data-composer-effort')).toBe('low')
    // 多端点时 chip 带端点前缀。
    expect(chip.textContent).toContain('端点一/')

    fireEvent.click(chip)
    const sheet = container.querySelector('.model-sheet') as HTMLElement
    expect(sheet).not.toBeNull()
    const rows = Array.from(sheet.querySelectorAll('[data-sheet-row]'))
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('m1')
    expect(rows[1]!.textContent).toContain('低')

    // 根页第一行 → 模型二级菜单：一级两个端点。
    fireEvent.click(rows[0]!)
    await flush()
    const picker = container.querySelector('.model-picker') as HTMLElement
    expect(picker).not.toBeNull()
    const providers = Array.from(picker.querySelectorAll('.provider-row'))
    expect(providers.map((node) => node.textContent)).toEqual([
      expect.stringContaining('端点一'),
      expect.stringContaining('端点二'),
    ])

    // 悬浮（或点）端点二 → 飞出卡画该端点下的模型。
    fireEvent.mouseEnter(providers[1]!)
    await flush()
    const flyout = container.querySelector('.model-flyout') as HTMLElement
    expect(flyout).not.toBeNull()
    expect(flyout.textContent).toContain('m2')

    const modelRow = within(flyout).getByText('m2').closest('button') as HTMLButtonElement
    fireEvent.click(modelRow)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setModel', args: ['p2/m2'] })
    expect(container.querySelector('.model-picker')).toBeNull()
  })

  test('根页第二行进档位滑杆：方向键落一档，回传 setEffort 并先写乐观值', async () => {
    const harness = harnessOf({
      model: 'm1',
      provider: 'p1',
      effort: 'low',
      models: [choice('p1', '端点一', 'm1')],
    })
    const { container } = mount(harness)
    await waitFor(() => {
      expect(container.querySelector('.composer-model-chip')?.getAttribute('data-composer-model')).toBe('p1/m1')
    })
    fireEvent.click(container.querySelector('.composer-model-chip') as HTMLButtonElement)
    const rows = Array.from(container.querySelectorAll('.model-sheet [data-sheet-row]'))
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[1]!)
    await flush()

    const track = container.querySelector('[data-effort-track]') as HTMLElement
    expect(track).not.toBeNull()
    // levels = 关 / 低 / 高 / 最大；当前「低」，右键落到「高」。
    fireEvent.keyDown(track, { key: 'ArrowRight' })
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setEffort', args: ['high', true] })
    expect(container.querySelector('.composer-model-chip')?.getAttribute('data-composer-effort')).toBe('high')
  })
})

describe('附件', () => {
  test('拖入一个通用文件：显示文件名/体积，发送时进 submit 的 files 列并清空附件', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })

    fireEvent.drop(composerOf(container), { dataTransfer: { files: [file], types: ['Files'] } })
    await waitFor(() => {
      expect(attachNames(container)).toEqual(['notes.txt'])
    })
    expect(container.querySelector('.attach-bytes')?.textContent).toBe('5 B')
    expect(createObjectUrl).toHaveBeenCalledTimes(1)
    // 上传成功后本地预览地址要释放，卡片改用宿主引用。
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:fake-preview')

    // 附件上传是异步的：卡片先出现、发送按钮要等上传回执才可用；直接点会被 disabled 挡掉，
    // Windows runner 上偶发（上传回执比断言慢一拍）。先等按钮可用再点。
    await waitFor(() => expect(sendOf(container).disabled).toBe(false))
    fireEvent.click(sendOf(container))
    await waitFor(() => {
      expect(harness.calls.some((call) => call.method === 'submit')).toBe(true)
    })
    const submit = harness.calls.find((call) => call.method === 'submit')!
    expect(submit.args).toEqual([
      '',
      [],
      [
        {
          sha: 'sha-file-1',
          kind: 'file',
          name: 'notes.txt',
          mime: 'text/plain',
          bytes: 5,
          path: '/tmp/sha-file-1',
        },
      ],
    ])
    await waitFor(() => {
      expect(container.querySelectorAll('.attach-item')).toHaveLength(0)
    })
  })

  test('当前模型不支持图片：图片被拒收，输入框下方给一句可照着做的提示', async () => {
    const harness = harnessOf({
      model: 'm1',
      provider: 'p1',
      models: [choice('p1', '端点一', 'm1', { modalities: ['text'] })],
    })
    const { container } = mount(harness)
    await waitFor(() => {
      expect(container.querySelector('.composer-model-chip')?.getAttribute('data-composer-model')).toBe('p1/m1')
    })
    const image = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' })
    fireEvent.drop(composerOf(container), { dataTransfer: { files: [image], types: ['Files'] } })
    await flush()
    expect(container.querySelectorAll('.attach-item')).toHaveLength(0)
    expect(container.querySelector('.shell-composer-fault')?.textContent).toContain('当前模型不支持图片')
    expect(FakeXhr.created).toHaveLength(0)
  })

  test('拖拽进入/离开给高亮标记，非文件拖拽不留标记', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const composer = composerOf(container)

    fireEvent.dragEnter(composer, { dataTransfer: { types: ['text/plain'] } })
    expect(composer.hasAttribute('data-drag')).toBe(false)

    fireEvent.dragEnter(composer, { dataTransfer: { types: ['Files'] } })
    expect(composer.getAttribute('data-drag')).toBe('1')
    fireEvent.dragLeave(composer, { relatedTarget: null })
    expect(composer.hasAttribute('data-drag')).toBe(false)
  })

  test('粘贴截图/文件也走同一条附件路径', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const file = new File(['clip'], 'clip.txt', { type: 'text/plain' })
    fireEvent.paste(composerOf(container), { clipboardData: { files: [file] } })
    await waitFor(() => {
      expect(attachNames(container)).toEqual(['clip.txt'])
    })
    expect(FakeXhr.created).toHaveLength(1)
    expect(FakeXhr.created[0]!.url).toContain('/api/attachments?name=clip.txt')
  })

  test('上传没完成时发送被拦下；空输入退格摘掉最后一条附件并释放预览地址', async () => {
    uploadBehavior = { mode: 'manual', meta: FILE_META }
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    fireEvent.drop(composerOf(container), { dataTransfer: { files: [file], types: ['Files'] } })
    await waitFor(() => {
      expect(container.querySelector('.attach-item')?.getAttribute('data-uploading')).toBe('1')
    })

    type(textareaOf(container), '上传中也要发')
    fireEvent.click(sendOf(container))
    await flush()
    expect(container.querySelector('.shell-composer-fault')?.textContent).toContain('附件还在上传')
    expect(harness.calls.some((call) => call.method === 'submit')).toBe(false)

    type(textareaOf(container), '')
    fireEvent.keyDown(textareaOf(container), { key: 'Backspace' })
    await flush()
    expect(container.querySelectorAll('.attach-item')).toHaveLength(0)
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:fake-preview')
  })

  test('图片附件点缩略图开灯箱，Esc 关闭；移除钮把卡片摘掉', async () => {
    uploadBehavior = { mode: 'auto', meta: IMAGE_META }
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const image = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' })
    fireEvent.drop(composerOf(container), { dataTransfer: { files: [image], types: ['Files'] } })
    await waitFor(() => {
      expect(container.querySelector('.attach-zoom')).not.toBeNull()
      expect(container.querySelector('.attach-item')?.hasAttribute('data-uploading')).toBe(false)
    })
    const imageNode = container.querySelector('.attach-thumb img') as HTMLImageElement
    expect(imageNode.getAttribute('src')).toBe('/api/attachments/sha-image-1')
    expect(imageNode.getAttribute('alt')).toBe('pic.png')

    fireEvent.click(container.querySelector('.attach-zoom') as HTMLButtonElement)
    const dialog = document.querySelector('.img-lightbox') as HTMLElement
    expect(dialog).not.toBeNull()
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('/api/attachments/sha-image-1')

    fireEvent.keyDown(window, { key: 'Escape' })
    await flush()
    expect(document.querySelector('.img-lightbox')).toBeNull()

    fireEvent.click(container.querySelector('.attach-remove') as HTMLButtonElement)
    await flush()
    expect(container.querySelectorAll('.attach-item')).toHaveLength(0)
  })
})

describe('斜杠命令面板', () => {
  const commands = [
    command('status', { label: '状态' }),
    command('review', { args: '<关注点>', description: '审查改动', input: { hint: '写一句审查关注点' } }),
    command('new', { duringTask: 'deny' }),
  ]

  test('输入 / 打开并过滤候选；↑↓ 换行、Tab 补全进输入框', async () => {
    const harness = harnessOf({ commands })
    const { container } = mount(harness)
    await flush()
    const input = textareaOf(container)

    type(input, '/', 1)
    await waitFor(() => {
      expect(container.querySelectorAll('.slash-item[role="option"]')).toHaveLength(3)
    })
    expect(harness.calls.filter((call) => call.method === 'listUiCommands')).toHaveLength(1)

    type(input, '/re', 3)
    await waitFor(() => {
      const rows = Array.from(container.querySelectorAll('.slash-item[role="option"]'))
      expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('审查改动')])
    })

    // 回到完整清单，用方向键换到第二行（review），Tab 采纳。
    type(input, '/', 1)
    await waitFor(() => {
      expect(container.querySelectorAll('.slash-item[role="option"]')).toHaveLength(3)
    })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const rows = Array.from(container.querySelectorAll('.slash-item[role="option"]'))
    expect(rows[1]!.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(input, { key: 'Tab' })
    await flush()
    expect(input.value).toBe('/review ')
    expect(container.querySelector('.slash-pop')).toBeNull()
  })

  test('Esc 收起面板；同一个前缀不再自动弹出', async () => {
    const harness = harnessOf({ commands })
    const { container } = mount(harness)
    await flush()
    const input = textareaOf(container)
    type(input, '/', 1)
    await waitFor(() => {
      expect(container.querySelectorAll('.slash-item[role="option"]')).toHaveLength(3)
    })

    fireEvent.keyDown(input, { key: 'Escape' })
    await flush()
    expect(container.querySelector('.slash-pop')).toBeNull()

    type(input, '/', 1)
    await flush()
    expect(container.querySelector('.slash-pop')).toBeNull()
  })

  test('面板开着时回车先采纳高亮项再执行，不把半截命令当消息发出去', async () => {
    const harness = harnessOf({ commands })
    const { container } = mount(harness)
    await flush()
    const input = textareaOf(container)
    type(input, '/sta', 4)
    await waitFor(() => {
      expect(container.querySelectorAll('.slash-item[role="option"]')).toHaveLength(1)
    })

    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(harness.calls).toContainEqual({ method: 'runUiCommand', args: ['/status'] })
    expect(harness.calls.some((call) => call.method === 'submit')).toBe(false)
    expect(input.value).toBe('')
  })

  test('要收输入的命令只补全并给提示，不执行；再回车才带着参数跑', async () => {
    const harness = harnessOf({ commands })
    const { container } = mount(harness)
    await flush()
    const input = textareaOf(container)
    type(input, '/review', 7)
    await waitFor(() => {
      expect(container.querySelectorAll('.slash-item[role="option"]')).toHaveLength(1)
    })

    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(harness.calls.some((call) => call.method === 'runUiCommand')).toBe(false)
    expect(harness.calls.some((call) => call.method === 'submit')).toBe(false)
    expect(input.value).toBe('/review ')
    expect(container.querySelector('.shell-composer-hint')?.textContent).toBe('写一句审查关注点')

    type(input, '/review 只看鉴权', 20)
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(harness.calls).toContainEqual({ method: 'runUiCommand', args: ['/review 只看鉴权'] })
  })
})

describe('排队、插话与重试', () => {
  test('回合进行中仍有「排队发送」钮：点它只提交消息，不插话', async () => {
    const harness = harnessOf({ turnState: 'streaming' })
    const { container } = mount(harness)
    await flush()
    type(textareaOf(container), '这一轮结束后发')
    const send = sendOf(container)
    expect(send.getAttribute('aria-label')).toBe('排队发送')
    fireEvent.click(send)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'submit', args: ['这一轮结束后发'] })
    expect(harness.calls.some((call) => call.method === 'steerQueued')).toBe(false)
    expect(textareaOf(container).value).toBe('')
  })

  test('Ctrl+Enter 插话：队列下标按收件箱条数算，宿主没赶上写在输入框下方', async () => {
    const harness = harnessOf({
      turnState: 'streaming',
      inboxCount: 3,
      queued: [
        { index: 0, text: '第一条' },
        { index: 1, text: '第二条' },
      ],
      notices: [{ index: 2, text: '一条机器通知' }],
      steerResult: false,
    })
    const { container } = mount(harness)
    await flush()
    const input = textareaOf(container)
    type(input, '插一句')
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    await waitFor(() => {
      expect(harness.calls.some((call) => call.method === 'steerQueued')).toBe(true)
    })
    expect(harness.calls).toContainEqual({ method: 'submit', args: ['插一句'] })
    // 下标 = 提交那一刻收件箱里已有的条数（2 条排队 + 1 条通知）。
    expect(harness.calls).toContainEqual({ method: 'steerQueued', args: [3] })
    await waitFor(() => {
      expect(container.querySelector('.shell-composer-fault')?.textContent).toContain('插话没赶上')
    })
  })

  test('发送失败后正文保留；再点一次发送成功，错误行清掉', async () => {
    const harness = harnessOf({ submitFailures: 1 })
    const { container } = mount(harness)
    await flush()
    const input = textareaOf(container)
    type(input, '重试一次')
    fireEvent.click(sendOf(container))
    await waitFor(() => {
      expect(container.querySelector('.shell-composer-fault')?.textContent).toContain('宿主断线了')
    })
    expect(input.value).toBe('重试一次')

    fireEvent.click(sendOf(container))
    await waitFor(() => {
      expect(input.value).toBe('')
    })
    expect(container.querySelector('.shell-composer-fault')).toBeNull()
    expect(harness.calls.filter((call) => call.method === 'submit')).toHaveLength(2)
  })
})

describe('快捷键提示与插入钮', () => {
  test('发送钮的提示写明 Enter、插入钮写明 /；空输入时「+」插入 /，有字时不覆盖', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const send = sendOf(container)
    expect(send.getAttribute('aria-label')).toBe('发送')
    expect(send.getAttribute('data-tip')).toBe('发送，快捷键 Enter')

    const insert = container.querySelector('.bar-left .icon-btn') as HTMLButtonElement
    expect(insert.getAttribute('aria-label')).toBe('插入指令')
    expect(insert.getAttribute('data-tip')).toBe('插入指令（/）')

    fireEvent.click(insert)
    await flush()
    expect(textareaOf(container).value).toBe('/')

    type(textareaOf(container), 'abc')
    fireEvent.click(insert)
    await flush()
    expect(textareaOf(container).value).toBe('abc')
  })
})
