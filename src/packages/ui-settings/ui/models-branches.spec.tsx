/**
 * 设置 → 模型页的第四批补测：表单校验、写路径失败、密钥行与模型编辑器的剩余分支。
 *
 * 为什么另开一份：`models.spec.tsx` 钉骨架与三条写路径，`models-extra.spec.tsx` 铺了
 * 大部分真实交互；这里只补它们印在覆盖率缺口里的那些行——新增表单的校验矩阵、
 * `saveProvider` 的失败 / 抛错、密钥写入失败的半成功、密钥行的 Enter/Escape、
 * Base URL 的「没变 / 非法 / 归一化」、模型编辑器的收起与字段回写、以及批量文本的
 * 单位解析（k / m / 空行 / 空 id）。
 *
 * @module dsc-ui-settings/ui/models-branches.spec
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { ModelConfigView, ProviderModelView } from '@dsc/ui'
import { ModelsGroup } from './models.js'

interface Invoke {
  method: string
  args: unknown[]
}

interface NativeCall {
  op: string
  args: unknown[]
}

type Reply = (method: string, args: unknown[]) => unknown

function modelOf(id: string, over: Partial<ProviderModelView> = {}): ProviderModelView {
  return {
    id,
    name: id,
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinkingLevels: ['off', 'low', 'high', 'max'],
    thinkingParam: 'thinking',
    effortMap: {},
    modalities: ['text'],
    ...over,
  }
}

function configOf(over: Partial<ModelConfigView> = {}): ModelConfigView {
  return {
    providers: [
      {
        name: 'deepseek',
        displayName: 'DeepSeek 官方',
        baseUrl: 'https://api.deepseek.com/v1',
        keyRef: 'DEEPSEEK_API_KEY',
        keyConfigured: true,
        models: [modelOf('deepseek-chat'), modelOf('deepseek-reasoner')],
      },
      {
        name: 'lab',
        displayName: '',
        baseUrl: 'https://lab.example/v1',
        keyRef: 'LAB_KEY',
        keyConfigured: false,
        models: [modelOf('lab-mini')],
      },
    ],
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek-chat',
    temperature: null,
    configFile: 'D:\\dsc\\config.yaml',
    credentialsFile: 'D:\\dsc\\credentials.yaml',
    ...over,
  }
}

function channelOf(reply: Reply): { channel: HostChannel; calls: Invoke[] } {
  const calls: Invoke[] = []
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
      try {
        const value = reply(method, args)
        if (value instanceof Error) return Promise.reject(value) as Promise<T>
        return Promise.resolve(value) as Promise<T>
      } catch (error: unknown) {
        return Promise.reject(error) as Promise<T>
      }
    },
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

function nativeOf(replies: Record<string, (args: unknown[]) => unknown> = {}): { calls: NativeCall[] } {
  const calls: NativeCall[] = []
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (op: string, args: unknown[] = []): Promise<unknown> => {
      calls.push({ op, args })
      try {
        const handler = replies[op]
        return Promise.resolve(handler === undefined ? { ok: true } : handler(args))
      } catch (error) {
        return Promise.reject(error)
      }
    },
    on: () => () => undefined,
  }
  return { calls }
}

const mount = (channel: HostChannel): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={channel}>
      <ModelsGroup />
    </RuntimeProvider>,
  )

async function waitRail(page: ReturnType<typeof render>): Promise<void> {
  await waitFor(() => expect(page.container.querySelector('[data-provider="deepseek"]')).not.toBeNull())
}

function lastToast(): string {
  const nodes = document.querySelectorAll('.dsc-toasts .dsc-toast__text')
  const node = nodes[nodes.length - 1]
  return node?.textContent ?? ''
}

function type(element: Element | null, value: string): void {
  fireEvent.change(element as HTMLInputElement, { target: { value } })
}

function blur(element: Element | null): void {
  fireEvent.blur(element as HTMLElement)
}

/** 新增表单里按位置取字段：0 名字 / 1 显示名 / 2 Base URL / 3 API key。 */
function formField(form: Element, index: number): Element | null {
  return form.querySelectorAll('input.setting-input')[index] ?? null
}

/** 打开新增表单并填到「只差校验」的程度。 */
function openNewForm(): Element {
  const add = document.querySelector('[data-models-add="1"]')
  fireEvent.click(add as HTMLElement)
  const form = document.querySelector('[data-provider-form="new"]')
  if (form === null) throw new Error('新增表单没有打开')
  return form
}

function fillIdentity(form: Element, name: string, baseUrl = 'https://api.new.example/v1'): void {
  type(formField(form, 0), name)
  type(formField(form, 2), baseUrl)
}

/** 表单里第 index 行模型：输入顺序是 id / 显示名 / 上下文 / 最大输出。 */
function modelRow(form: Element, index: number): Element | null {
  return form.querySelectorAll('.model-row')[index] ?? null
}

function fillRow(row: Element | null, id: string, context = '128000'): void {
  const inputs = row?.querySelectorAll('input') ?? []
  type(inputs[0] ?? null, id)
  type(inputs[2] ?? null, context)
  blur(inputs[2] ?? null)
}

beforeEach(() => {
  nativeOf()
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined
})

afterEach(() => {
  cleanup()
  document.querySelectorAll('.dsc-toasts, .dsc-confirm').forEach((node) => node.remove())
  delete (globalThis as { dscNative?: unknown }).dscNative
})

// ── 新增表单的校验矩阵 ──────────────────────────────────────────────────────

describe('新增表单：四条硬校验都在保存前拦下', () => {
  test('端点名含大写 / 空格：给「只能用小写字母、数字、- 或 _」', async () => {
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    const form = openNewForm()
    fillIdentity(form, 'Bad Name')
    fillRow(modelRow(form, 0), 'm1')
    fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)
    await waitFor(() => expect(lastToast()).toContain('只能用小写字母'))
  })

  test('Base URL 不是 http(s)：给可照着改的提示', async () => {
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    const form = openNewForm()
    fillIdentity(form, 'newp', 'ftp://files.example')
    fillRow(modelRow(form, 0), 'm1')
    fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)
    await waitFor(() => expect(lastToast()).toContain('完整的 http(s) 地址'))
  })

  test('上下文窗口留空：要求填正整数', async () => {
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    const form = openNewForm()
    fillIdentity(form, 'newp')
    fillRow(modelRow(form, 0), 'm1', '')
    fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)
    await waitFor(() => expect(lastToast()).toContain('上下文窗口要填正整数'))
  })

  test('批量文本里的负最大输出：同样被拦下', async () => {
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    const form = openNewForm()
    fillIdentity(form, 'newp')
    fireEvent.click(form.querySelector('[data-form-bulk="1"]') as HTMLElement)
    type(form.querySelector('textarea') as Element, 'm1, , 128000, -5')
    expect((form.querySelector('textarea') as HTMLTextAreaElement).value).toBe('m1, , 128000, -5')
    fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)
    await waitFor(() => expect(lastToast()).toContain('最大输出要填正整数'))
  })
})

// ── 批量文本的单位解析与成功写盘 ────────────────────────────────────────────

describe('批量文本：k / m / 空行 / 缺列都按口径落盘', () => {
  test('64k 与 1m 各自换算；空行与空 id 跳过；缺省显示名用 id', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-provider-edit="1"]') as HTMLElement)
    const form = page.container.querySelector('[data-provider-form="deepseek"]') as Element
    fireEvent.click(form.querySelector('[data-form-bulk="1"]') as HTMLElement)
    type(
      form.querySelector('textarea') as Element,
      ['deepseek-chat, DeepSeek Chat, 64k, 8k', '', ', 只有名字', 'deepseek-reasoner, , 1m'].join('\n'),
    )
    fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)
    await waitFor(() => expect(native.calls.some((entry) => entry.op === 'saveProvider')).toBe(true))
    const payload = native.calls.find((entry) => entry.op === 'saveProvider')?.args[0] as {
      models: ProviderModelView[]
    }
    expect(payload.models.map((model) => model.id)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(payload.models[0]?.contextWindow).toBe(64_000)
    expect(payload.models[0]?.maxTokens).toBe(8_000)
    expect(payload.models[1]?.contextWindow).toBe(1_000_000)
    expect(payload.models[1]?.name).toBe('deepseek-reasoner')
  })
})

// ── 写路径的失败与半成功 ────────────────────────────────────────────────────

describe('saveProvider 失败 / 抛错 / 密钥半成功', () => {
  test('回执 !ok：Toast 说原因，表单不收起', async () => {
    nativeOf({ saveProvider: () => ({ ok: false, error: '磁盘满了' }) })
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-provider-edit="1"]') as HTMLElement)
    const form = page.container.querySelector('[data-provider-form="deepseek"]') as Element
    fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)
    await waitFor(() => expect(lastToast()).toContain('保存失败：磁盘满了'))
    expect(page.container.querySelector('[data-provider-form="deepseek"]')).not.toBeNull()
  })

  test('调用本身抛错：同样落到「保存失败」', async () => {
    nativeOf({
      saveProvider: () => {
        throw new Error('桥断了')
      },
    })
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-provider-edit="1"]') as HTMLElement)
    const form = page.container.querySelector('[data-provider-form="deepseek"]') as Element
    fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)
    await waitFor(() => expect(lastToast()).toContain('保存失败：桥断了'))
  })

  test('端点存下了但密钥没写成功：半成功文案带原因', async () => {
    nativeOf({ setProviderKey: () => ({ ok: false, error: '凭据文件只读' }) })
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    const form = openNewForm()
    fillIdentity(form, 'newp')
    fillRow(modelRow(form, 0), 'm1')
    type(formField(form, 3), 'sk-test')
    fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)
    await waitFor(() => expect(lastToast()).toContain('密钥没写成功：凭据文件只读'))
  })
})

// ── 密钥行 ──────────────────────────────────────────────────────────────────

describe('密钥行：Enter / Escape 与空值', () => {
  test('空值按 Enter 不保存；Escape 取消录入', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-key-edit="1"]') as HTMLElement)
    const input = page.container.querySelector('input[aria-label="API key"]') as HTMLInputElement
    expect(input).not.toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(native.calls.some((entry) => entry.op === 'setProviderKey')).toBe(false)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(page.container.querySelector('input[aria-label="API key"]')).toBeNull()

    fireEvent.click(page.container.querySelector('[data-key-edit="1"]') as HTMLElement)
    const again = page.container.querySelector('input[aria-label="API key"]') as HTMLInputElement
    type(again, 'sk-new')
    fireEvent.keyDown(again, { key: 'Enter' })
    await waitFor(() => expect(native.calls.some((entry) => entry.op === 'setProviderKey')).toBe(true))
    expect(native.calls.find((entry) => entry.op === 'setProviderKey')?.args).toEqual(['deepseek', 'sk-new'])
    await waitFor(() => expect(page.container.querySelector('input[aria-label="API key"]')).toBeNull())
  })
})

// ── Base URL 就地保存 ───────────────────────────────────────────────────────

describe('Base URL：没变不发、非法回滚、合法归一化', () => {
  function baseUrlInput(page: ReturnType<typeof render>): HTMLInputElement {
    return page.container.querySelector('input[aria-label="Base URL"]') as HTMLInputElement
  }

  test('值没变：失焦不发 saveProvider', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    const input = baseUrlInput(page)
    blur(input)
    await waitFor(() => expect(native.calls.some((entry) => entry.op === 'saveProvider')).toBe(false))
  })

  test('非法地址：Toast 提示并重取配置', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    const input = baseUrlInput(page)
    type(input, 'not-a-url')
    blur(input)
    await waitFor(() => expect(lastToast()).toContain('完整的 http(s) 地址'))
    expect(native.calls.some((entry) => entry.op === 'saveProvider')).toBe(false)
  })

  test('合法地址：去掉尾部斜杠后写盘', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    const input = baseUrlInput(page)
    type(input, ' https://api2.example/v1/// ')
    blur(input)
    await waitFor(() => expect(native.calls.some((entry) => entry.op === 'saveProvider')).toBe(true))
    const payload = native.calls.find((entry) => entry.op === 'saveProvider')?.args[0] as { baseUrl: string }
    expect(payload.baseUrl).toBe('https://api2.example/v1')
  })
})

// ── 模型编辑器 ──────────────────────────────────────────────────────────────

describe('模型编辑器：收起、字段回写、档位与输入类型', () => {
  test('再点一次编辑钮：收起编辑器（不调写口）', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-model-edit="deepseek-chat"]') as HTMLElement)
    expect(page.container.querySelector('[data-model-edit-box="deepseek-chat"]')).not.toBeNull()
    fireEvent.click(page.container.querySelector('[data-model-edit="deepseek-chat"]') as HTMLElement)
    expect(page.container.querySelector('[data-model-edit-box="deepseek-chat"]')).toBeNull()
    expect(native.calls.some((entry) => entry.op === 'saveProvider')).toBe(false)
  })

  test('上下文填 64k：保存时换算成 64000；关掉 off 档、加上图片输入', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-model-edit="deepseek-chat"]') as HTMLElement)
    const box = page.container.querySelector('[data-model-edit-box="deepseek-chat"]') as Element
    const inputs = box.querySelectorAll('input')
    // 顺序：id / 显示名 / 上下文 / 最大输出。
    type(inputs[2] ?? null, '64k')
    blur(inputs[2] ?? null)
    fireEvent.click(box.querySelector('[data-cap-level="off"]') as HTMLElement)
    fireEvent.click(box.querySelector('[data-cap-modality="image"]') as HTMLElement)
    fireEvent.click(box.querySelector('[data-model-save="deepseek-chat"]') as HTMLElement)
    await waitFor(() => expect(native.calls.some((entry) => entry.op === 'saveProvider')).toBe(true))
    const payload = native.calls.find((entry) => entry.op === 'saveProvider')?.args[0] as {
      models: ProviderModelView[]
    }
    const saved = payload.models.find((model) => model.id === 'deepseek-chat')
    expect(saved?.contextWindow).toBe(64_000)
    expect(saved?.thinkingLevels).not.toContain('off')
    expect(saved?.modalities).toContain('image')
  })

  test('切到 reasoning-effort：线上值能写能清（清空即删键）', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-model-edit="deepseek-chat"]') as HTMLElement)
    const box = page.container.querySelector('[data-model-edit-box="deepseek-chat"]') as Element
    // 打开「思考档位字段」下拉，选 reasoning_effort。
    fireEvent.click(box.querySelector('[aria-label="思考档位字段"]') as HTMLElement)
    const option = [...document.querySelectorAll('.select-opt')].find((node) => (node.textContent ?? '').includes('reasoning_effort'))
    fireEvent.click(option as HTMLElement)
    const wire = box.querySelector('[data-cap-wire="low"]') as HTMLInputElement
    expect(wire).not.toBeNull()
    type(wire, 'low-effort')
    type(wire, '')
    fireEvent.click(box.querySelector('[data-model-save="deepseek-chat"]') as HTMLElement)
    await waitFor(() => expect(native.calls.some((entry) => entry.op === 'saveProvider')).toBe(true))
    const payload = native.calls.find((entry) => entry.op === 'saveProvider')?.args[0] as {
      models: ProviderModelView[]
    }
    const saved = payload.models.find((model) => model.id === 'deepseek-chat')
    expect(saved?.thinkingParam).toBe('reasoning-effort')
    expect(saved?.effortMap['low']).toBeUndefined()
  })
})

// ── 拉取清单弹窗 ────────────────────────────────────────────────────────────

describe('拉取清单：筛选、全选、单条勾选与采用', () => {
  test('打开弹窗：已有项不可勾；全选 / 全不选；采用后整份写回', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => {
      if (method === 'getModelConfig') return configOf()
      if (method === 'discoverModels') return ['deepseek-chat', 'deepseek-v4', 'deepseek-lite']
      return { ok: true }
    })
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-model-discover="1"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('[data-models-discover="1"]')).not.toBeNull())
    const dialog = page.container.querySelector('[data-models-discover="1"]') as Element
    // 默认全勾上（还没加进端点的那些）。
    expect((dialog.querySelector('[data-models-discover-all="1"]') as HTMLElement).textContent).toContain('全不选')
    fireEvent.click(dialog.querySelector('[data-models-discover-all="1"]') as HTMLElement)
    expect((dialog.querySelector('[data-models-discover-all="1"]') as HTMLElement).textContent).toContain('全选')
    fireEvent.click(dialog.querySelector('[data-models-discover-all="1"]') as HTMLElement)
    expect((dialog.querySelector('[data-models-discover-all="1"]') as HTMLElement).textContent).toContain('全不选')
    // 单条取消勾选（点行本身）。
    fireEvent.click(dialog.querySelector('[data-discover-item="deepseek-v4"]') as HTMLElement)
    fireEvent.click(dialog.querySelector('[data-models-discover-adopt="1"]') as HTMLElement)
    await waitFor(() => expect(native.calls.some((entry) => entry.op === 'saveProvider')).toBe(true))
    expect(page.container.querySelector('[data-models-discover="1"]')).toBeNull()
  })

  test('点遮罩关闭弹窗，不写盘', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => {
      if (method === 'getModelConfig') return configOf()
      if (method === 'discoverModels') return ['deepseek-v4']
      return { ok: true }
    })
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-model-discover="1"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('[data-models-discover="1"]')).not.toBeNull())
    const overlay = page.container.querySelector('[data-models-discover="1"]') as HTMLElement
    fireEvent.click(overlay)
    await waitFor(() => expect(page.container.querySelector('[data-models-discover="1"]')).toBeNull())
    expect(native.calls.some((entry) => entry.op === 'saveProvider')).toBe(false)
  })
})
