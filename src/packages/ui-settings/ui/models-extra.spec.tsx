/**
 * 设置 → 模型页的第二批交互断言（ui 层，真渲染）。
 *
 * `models.spec.tsx` 钉的是骨架、字段钩子与三条写路径；这一份补「真实用户会走、但第一批
 * 没走」的分支：
 *
 * - 读面：加载失败、没有任何端点、只读档（没有原生桥）、端点空模型清单；
 * - 表单：新增 / 改名、名字与地址校验、重复端点名、空清单 / 重复模型 id、多行增删、
 *   批量文本进出；
 * - 模型编辑器：token 输入归一化与非法回退、思考档位勾选顺序、输入模态、档位字段与
 *   线上值；
 * - 写路径：单模型新增 / 删除（含默认模型搬家与最后一个模型）、删端点、密钥写入 / 清除、
 *   Base URL 就地保存（合法与非法）；
 * - 连接测试：成功结论、失败结论、请求根本没发出去（reject）；
 * - 拉取清单：过滤、全选 / 全不选、已有项不可选、采用后整份写回、关闭；
 * - 默认端点 / 默认模型下拉：切端点写第一个模型、无密钥端点不给选模型、写失败回执；
 * - 刷新按钮与左栏新增伪条目。
 *
 * 口径与第一批一致：假通道 + 假原生桥，断言落在可见文本、DOM 状态与桥收到的
 * `op` / 参数上；不写只 render 不检查的 smoke。
 *
 * @module dsc-ui-settings/ui/models-extra.spec
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { ConnectionTestView, ModelConfigView, ProviderDraft, ProviderModelView } from '@dsc/ui'
import { ModelsGroup } from './models.js'

// ── 假宿主与假桥 ───────────────────────────────────────────────────────────────

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

/** 两个端点：deepseek 已配 key 且是默认，lab 没配 key；另可按用例覆盖。 */
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

/** 假通道：按 `reply(method, args)` 给应答；返回 Error 表示 reject。 */
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

/** 假原生桥；`replies` 里没写的 op 一律回 `{ ok: true }`。 */
function nativeOf(replies: Record<string, (args: unknown[]) => unknown> = {}): { calls: NativeCall[] } {
  const calls: NativeCall[] = []
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (op: string, args: unknown[] = []): Promise<unknown> => {
      calls.push({ op, args })
      try {
        const handler = replies[op]
        return Promise.resolve(handler === undefined ? { ok: true } : handler(args))
      } catch (error: unknown) {
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

async function answerConfirm(accept: boolean): Promise<void> {
  await waitFor(() => expect(document.querySelector('.dsc-confirm')).not.toBeNull())
  const buttons = document.querySelectorAll('.dsc-confirm__actions button')
  fireEvent.click(buttons[accept ? 1 : 0] as HTMLElement)
}

/** 新增表单里按位置取字段：0 名字 / 1 显示名 / 2 Base URL / 3 API key。 */
function formField(form: Element, index: number): Element | null {
  return form.querySelectorAll('input.setting-input')[index] ?? null
}

/** 往新增表单填一份能过校验的草稿。 */
function fillNewProvider(
  form: Element,
  fields: { name: string; baseUrl: string; modelId: string; context?: string },
): void {
  type(formField(form, 0), fields.name)
  type(formField(form, 2), fields.baseUrl)
  const row = form.querySelector('.model-row')
  if (row === null) throw new Error('新增表单里没有模型行')
  const inputs = row.querySelectorAll('input')
  type(inputs[0] ?? null, fields.modelId)
  type(inputs[2] ?? null, fields.context ?? '128000')
  blur(inputs[2] ?? null)
}

/** 打开一个 Select（触发钮），并点它浮层里文字匹配的那一项。 */
function chooseSelectOption(ariaLabel: string, text: string): void {
  const trigger = document.querySelector(`[aria-label="${ariaLabel}"]`)
  if (trigger === null) throw new Error(`找不到下拉：${ariaLabel}`)
  fireEvent.click(trigger)
  const options = [...document.querySelectorAll('.select-opt')]
  const target = options.find((option) => (option.textContent ?? '').includes(text))
  if (target === undefined) throw new Error(`下拉 ${ariaLabel} 里没有「${text}」`)
  fireEvent.click(target)
}

beforeEach(() => {
  nativeOf()
  // jsdom 没有 scrollIntoView；Select 打开浮层后会把高亮项滚进视口（真实浏览器行为）。
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined
})

afterEach(() => {
  cleanup()
  document.querySelectorAll('.dsc-toasts, .dsc-confirm').forEach((node) => node.remove())
  delete (globalThis as { dscNative?: unknown }).dscNative
})

// ── 读面：加载失败 / 空配置 / 只读档 / 空模型清单 ──────────────────────────────

describe('读面', () => {
  test('读取配置失败：Toast 说清原因，页面停在加载态而不是白屏', async () => {
    const { channel } = channelOf((method) =>
      method === 'getModelConfig' ? new Error('boom') : { ok: true },
    )
    const page = mount(channel)
    await waitFor(() => expect(lastToast()).toContain('读取模型配置失败：boom'))
    expect(page.container.querySelector('.settings-empty')?.textContent).toContain('正在读取模型配置')
  })

  test('一个端点都没有：左栏空态、右栏空态、默认端点下拉写着「暂无端点」', async () => {
    const { channel } = channelOf((method) =>
      method === 'getModelConfig'
        ? configOf({ providers: [], defaultProvider: '', defaultModel: '' })
        : { ok: true },
    )
    const page = mount(channel)
    await waitFor(() => expect(page.container.querySelector('.models-rail-empty')).not.toBeNull())
    expect(page.container.querySelector('.models-rail-empty')?.textContent).toContain('还没有端点')
    expect(page.container.querySelector('.models-detail-empty-title')?.textContent).toBe('还没有端点')
    expect(document.querySelector('[aria-label="默认端点"]')?.textContent).toContain('暂无端点')
    // 左栏的「添加端点」还在；点开之后左栏出现新增伪条目。
    fireEvent.click(page.container.querySelector('[data-models-add="1"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('[data-provider-form="new"]')).not.toBeNull())
    expect(page.container.querySelector('[data-provider="__new__"]')?.textContent).toContain('新增端点')
    fireEvent.click(page.container.querySelector('[data-provider-form="new"] .pane-form-actions .btn-ghost') as HTMLElement)
    expect(page.container.querySelector('[data-provider-form="new"]')).toBeNull()
    expect(page.container.querySelector('[data-provider="__new__"]')).toBeNull()
  })

  test('没有原生桥：整页只读，增删改按钮不画，测试连接与拉取清单仍可点', async () => {
    delete (globalThis as { dscNative?: unknown }).dscNative
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)

    expect(page.container.querySelector('[data-models-readonly="1"]')?.textContent).toContain('只能在桌面窗口里操作')
    expect(page.container.querySelector('[data-models-add="1"]')).toBeNull()
    expect(page.container.querySelector('[data-provider-edit="1"]')).toBeNull()
    expect(page.container.querySelector('[data-provider-remove="1"]')).toBeNull()
    expect(page.container.querySelector('[data-model-edit="deepseek-chat"]')).toBeNull()
    expect(page.container.querySelector('[data-model-remove="deepseek-chat"]')).toBeNull()
    expect(page.container.querySelector('[data-key-edit="1"]')).toBeNull()
    expect(page.container.querySelector('[data-model-add="1"]')).toBeNull()
    // 走界面通道的两个动作不受影响。
    expect(page.container.querySelector('[data-model-discover="1"]')).not.toBeNull()
    expect(page.container.querySelector('[data-probe-model="deepseek-chat"]')).not.toBeNull()
  })

  test('端点没有模型：清单给可操作的空态，模型计数是 0', async () => {
    const config = configOf()
    config.providers[0] = { ...config.providers[0]!, models: [] }
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? config : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    expect(page.container.querySelector('.model-list-empty')?.textContent).toContain('这个端点还没有模型')
    expect(page.container.querySelector('.model-block-head .count')?.textContent).toBe('0')
  })
})

// ── 端点表单 ───────────────────────────────────────────────────────────────────

describe('端点表单', () => {
  test('左栏切走再切回来，没保存的端点草稿还在（编辑中标记也留着）', async () => {
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)

    fireEvent.click(page.container.querySelector('[data-provider-edit="1"]') as HTMLElement)
    const form = page.container.querySelector('[data-provider-form="deepseek"]') as HTMLElement
    type(formField(form, 1), 'DS 改')
    expect(page.container.querySelector('[data-provider="deepseek"] .models-rail-editing')).not.toBeNull()

    fireEvent.click(page.container.querySelector('[data-provider="lab"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('.provider-title-name')?.textContent).toBe('lab'))
    expect(page.container.querySelector('[data-provider-form="deepseek"]')).toBeNull()

    fireEvent.click(page.container.querySelector('[data-provider="deepseek"]') as HTMLElement)
    const again = page.container.querySelector('[data-provider-form="deepseek"]') as HTMLElement
    expect((formField(again, 1) as HTMLInputElement).value).toBe('DS 改')
  })

  test('改名保存：走 saveProvider，oldName 指原端点，名字与显示名都去掉首尾空白', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)

    fireEvent.click(page.container.querySelector('[data-provider-edit="1"]') as HTMLElement)
    const form = page.container.querySelector('[data-provider-form="deepseek"]') as HTMLElement
    type(formField(form, 0), 'deepseek2')
    type(formField(form, 1), '  DeepSeek 2  ')
    fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)

    await waitFor(() => expect(native.calls.length).toBe(1))
    expect(native.calls[0]?.op).toBe('saveProvider')
    const payload = native.calls[0]?.args[0] as ProviderDraft
    expect(payload.oldName).toBe('deepseek')
    expect(payload.name).toBe('deepseek2')
    expect(payload.displayName).toBe('DeepSeek 2')
    await waitFor(() => expect(lastToast()).toContain('端点已保存'))
  })

  test('端点名为空 / 与已有端点重名：提交被拦，桥一次都不调', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-models-add="1"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('[data-provider-form="new"]')).not.toBeNull())

    fireEvent.click(page.container.querySelector('[data-provider-save="1"]') as HTMLElement)
    await waitFor(() => expect(lastToast()).toContain('端点名不能为空'))

    const form = page.container.querySelector('[data-provider-form="new"]') as HTMLElement
    fillNewProvider(form, { name: 'lab', baseUrl: 'https://x.example/v1', modelId: 'm' })
    fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)
    await waitFor(() => expect(lastToast()).toContain('已经有一个叫 lab 的端点了'))
    expect(native.calls, '校验不过不得写桥').toHaveLength(0)
  })

  test('Base URL 不是 http(s)：提交被拦并当面说清格式', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-models-add="1"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('[data-provider-form="new"]')).not.toBeNull())
    const form = page.container.querySelector('[data-provider-form="new"]') as HTMLElement
    fillNewProvider(form, { name: 'newp', baseUrl: 'api.example.com/v1', modelId: 'm' })
    fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)
    await waitFor(() => expect(lastToast()).toContain('Base URL 要写成完整的 http(s) 地址'))
    expect(native.calls).toHaveLength(0)
  })

  test('空清单：批量文本清空后提交被拦（宿主同样拒收没有模型的端点）', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-models-add="1"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('[data-provider-form="new"]')).not.toBeNull())
    const form = page.container.querySelector('[data-provider-form="new"]') as HTMLElement

    // 批量文本清空 = 一个模型都没有。
    fireEvent.click(form.querySelector('[data-form-bulk="1"]') as HTMLElement)
    fireEvent.change(form.querySelector('textarea') as HTMLTextAreaElement, { target: { value: '' } })
    type(formField(form, 0), 'emptyprov')
    type(formField(form, 2), 'https://x.example/v1')
    fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)
    await waitFor(() => expect(lastToast()).toContain('至少要有一个模型'))
    expect(native.calls, '校验不过不得写桥').toHaveLength(0)

    // 回到表格：空文本把模型行清空，表单给出「还没有模型」的下一步说明。
    fireEvent.click(form.querySelector('[data-form-bulk="1"]') as HTMLElement)
    expect(form.querySelectorAll('.model-row')).toHaveLength(0)
    expect(form.querySelector('.model-rows-empty')?.textContent).toContain('这个端点还没有模型')
  })

  test('模型行增删：只有一个模型时不给删钮，加一行后出现；批量文本进出同步两种录入口径', async () => {
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-models-add="1"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('[data-provider-form="new"]')).not.toBeNull())
    const form = page.container.querySelector('[data-provider-form="new"]') as HTMLElement

    expect(form.querySelectorAll('.model-row')).toHaveLength(1)
    expect(form.querySelector('[data-model-remove-row="1"]')).toBeNull()

    fireEvent.click(form.querySelector('[data-form-model-add="1"]') as HTMLElement)
    expect(form.querySelectorAll('.model-row')).toHaveLength(2)
    expect(form.querySelectorAll('[data-model-remove-row="1"]')).toHaveLength(2)

    fireEvent.click(form.querySelector('[data-model-remove-row="1"]') as HTMLElement)
    expect(form.querySelectorAll('.model-row')).toHaveLength(1)

    // 切到批量文本、写两行、再切回表格：表格应变成两行。
    fireEvent.click(form.querySelector('[data-form-bulk="1"]') as HTMLElement)
    fireEvent.change(form.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value: 'a, A, 64k\nb, B, 32k' },
    })
    fireEvent.click(form.querySelector('[data-form-bulk="1"]') as HTMLElement)
    const rows = [...form.querySelectorAll('.model-row')]
    expect(rows).toHaveLength(2)
    expect((rows[0]?.querySelectorAll('input')[0] as HTMLInputElement).value).toBe('a')
    expect((rows[1]?.querySelectorAll('input')[0] as HTMLInputElement).value).toBe('b')
  })

  test('新增端点用批量文本：token 写法归一化后整份交给 saveProvider', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-models-add="1"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('[data-provider-form="new"]')).not.toBeNull())
    const form = page.container.querySelector('[data-provider-form="new"]') as HTMLElement
    type(formField(form, 0), 'bulkprov')
    type(formField(form, 2), 'https://b.example/v1')

    fireEvent.click(form.querySelector('[data-form-bulk="1"]') as HTMLElement)
    fireEvent.change(form.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value: 'm1, M1, 128k, 8k\nm2, M2, 64k' },
    })
    fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)

    await waitFor(() => expect(native.calls.length).toBe(1))
    const payload = native.calls[0]?.args[0] as ProviderDraft
    expect(payload.name).toBe('bulkprov')
    expect(payload.models.map((model) => model.id)).toEqual(['m1', 'm2'])
    expect(payload.models[0]).toMatchObject({ name: 'M1', contextWindow: 128_000, maxTokens: 8_000 })
    expect(payload.models[1]).toMatchObject({ name: 'M2', contextWindow: 64_000, maxTokens: 0 })
  })

  test('端点表单的取消：草稿丢弃，左栏新增伪条目消失', async () => {
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-models-add="1"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('[data-provider-form="new"]')).not.toBeNull())
    fireEvent.click(page.container.querySelector('[data-provider-form="new"] .pane-form-actions .btn-ghost') as HTMLElement)
    expect(page.container.querySelector('[data-provider-form="new"]')).toBeNull()
    expect(page.container.querySelector('[data-provider="__new__"]')).toBeNull()
    // 取消后落到默认端点的详情。
    expect(page.container.querySelector('.provider-title-name')?.textContent).toBe('DeepSeek 官方')
  })
})

// ── 模型能力编辑器 ─────────────────────────────────────────────────────────────

describe('模型能力编辑器', () => {
  test('token 输入认 256k / 16k，认不出退回原值；勾档与输入模态一起保存', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-model-edit="deepseek-chat"]') as HTMLElement)
    const box = page.container.querySelector('[data-model-edit-box="deepseek-chat"]') as HTMLElement
    await waitFor(() => expect(box).not.toBeNull())
    const inputs = box.querySelectorAll('input')

    // 显示名改成和 id 不同；上下文 256k；最大输出 16k。
    type(inputs[1] ?? null, 'Chat X')
    type(inputs[2] ?? null, 'abc')
    blur(inputs[2] ?? null)
    expect((inputs[2] as HTMLInputElement).value, '认不出的 token 数退回原值').toBe('128000')
    type(inputs[2] ?? null, '256k')
    blur(inputs[2] ?? null)
    expect((inputs[2] as HTMLInputElement).value).toBe('256000')
    type(inputs[3] ?? null, '16k')
    blur(inputs[3] ?? null)
    expect((inputs[3] as HTMLInputElement).value).toBe('16000')

    // 去掉「最大」「关」两档；勾上图片输入。文本永远勾着且不可点。
    fireEvent.click(box.querySelector('[data-cap-level="max"]') as HTMLElement)
    expect(box.querySelector('[data-cap-level="max"]')?.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(box.querySelector('[data-cap-level="off"]') as HTMLElement)
    expect(box.querySelector('[data-cap-level="off"]')?.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(box.querySelector('[data-cap-modality="image"]') as HTMLElement)
    expect(box.querySelector('[data-cap-modality="image"]')?.getAttribute('aria-pressed')).toBe('true')
    expect((box.querySelector('[data-cap-modality="text"]') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(box.querySelector('[data-model-save="deepseek-chat"]') as HTMLElement)
    await waitFor(() => expect(native.calls.length).toBe(1))
    const payload = native.calls[0]?.args[0] as ProviderDraft
    expect(payload.models[0]).toMatchObject({
      id: 'deepseek-chat',
      name: 'Chat X',
      contextWindow: 256_000,
      maxTokens: 16_000,
      thinkingLevels: ['low', 'high'],
      modalities: ['text', 'image'],
    })
    // 另一行原样保留。
    expect(payload.models[1]?.id).toBe('deepseek-reasoner')
  })

  test('档位字段切到 reasoning_effort 才出现线上值输入；切走再切回值还在', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-model-edit="deepseek-chat"]') as HTMLElement)
    const box = page.container.querySelector('[data-model-edit-box="deepseek-chat"]') as HTMLElement
    await waitFor(() => expect(box).not.toBeNull())

    expect(box.querySelector('[data-cap-wire]'), 'thinking 开关模式下没有线上值输入').toBeNull()
    chooseSelectOption('思考档位字段', 'reasoning_effort')
    await waitFor(() => expect(box.querySelectorAll('[data-cap-wire]')).toHaveLength(4))
    type(box.querySelector('[data-cap-wire="off"]'), 'none')
    type(box.querySelector('[data-cap-wire="low"]'), 'low-x')

    chooseSelectOption('思考档位字段', '不发思考字段')
    expect(box.querySelector('[data-cap-wire]')).toBeNull()
    chooseSelectOption('思考档位字段', 'reasoning_effort')
    expect((box.querySelector('[data-cap-wire="off"]') as HTMLInputElement).value).toBe('none')

    fireEvent.click(box.querySelector('[data-model-save="deepseek-chat"]') as HTMLElement)
    await waitFor(() => expect(native.calls.length).toBe(1))
    const payload = native.calls[0]?.args[0] as ProviderDraft
    expect(payload.models[0]?.thinkingParam).toBe('reasoning-effort')
    expect(payload.models[0]?.effortMap).toEqual({ off: 'none', low: 'low-x' })
  })

  test('列表末尾新增模型：编辑器长在列表末尾，保存后整份写回（新行在最后）', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-model-add="1"]') as HTMLElement)
    const box = page.container.querySelector('[data-model-add-box="1"]') as HTMLElement
    await waitFor(() => expect(box).not.toBeNull())
    const inputs = box.querySelectorAll('input')
    type(inputs[0] ?? null, 'extra-model')
    type(inputs[2] ?? null, '64k')
    blur(inputs[2] ?? null)
    fireEvent.click(box.querySelector('[data-model-save="new"]') as HTMLElement)

    await waitFor(() => expect(native.calls.length).toBe(1))
    const payload = native.calls[0]?.args[0] as ProviderDraft
    expect(payload.models.map((model) => model.id)).toEqual(['deepseek-chat', 'deepseek-reasoner', 'extra-model'])
    expect(payload.models[2]?.contextWindow).toBe(64_000)
    await waitFor(() => expect(lastToast()).toContain('已加入模型 extra-model'))
  })
})

// ── 删除模型 / 删除端点 ───────────────────────────────────────────────────────

describe('删除', () => {
  test('删模型：取消不动桥；确认后整份写回，删的正好是默认模型时把默认挪到下一条', async () => {
    const native = nativeOf()
    const { channel, calls } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)

    fireEvent.click(page.container.querySelector('[data-model-remove="deepseek-chat"]') as HTMLElement)
    await waitFor(() => expect(document.querySelector('.dsc-confirm__title')?.textContent).toContain('删除模型「deepseek-chat」'))
    fireEvent.click(document.querySelectorAll('.dsc-confirm__actions button')[0] as HTMLElement)
    expect(native.calls, '取消不得写桥').toHaveLength(0)

    fireEvent.click(page.container.querySelector('[data-model-remove="deepseek-chat"]') as HTMLElement)
    await answerConfirm(true)

    await waitFor(() => expect(native.calls.length).toBe(1))
    const payload = native.calls[0]?.args[0] as ProviderDraft
    expect(payload.models.map((model) => model.id)).toEqual(['deepseek-reasoner'])
    // 默认模型搬家：走通道的 setDefaultModel，而不是原生桥。
    await waitFor(() => expect(calls.some((call) => call.method === 'setDefaultModel')).toBe(true))
    expect(calls.find((call) => call.method === 'setDefaultModel')?.args).toEqual(['deepseek', 'deepseek-reasoner'])
  })

  test('删掉最后一个模型：确认框写明「这是最后一个」，保存的清单是空的', async () => {
    const config = configOf()
    config.providers[0] = { ...config.providers[0]!, models: [modelOf('only-one')] }
    config.defaultModel = 'only-one'
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? config : { ok: true }))
    const page = mount(channel)
    await waitRail(page)

    fireEvent.click(page.container.querySelector('[data-model-remove="only-one"]') as HTMLElement)
    await waitFor(() =>
      expect(document.querySelector('.dsc-confirm__detail')?.textContent).toContain('这是这个端点最后一个模型'),
    )
    await answerConfirm(true)
    await waitFor(() => expect(native.calls.length).toBe(1))
    const payload = native.calls[0]?.args[0] as ProviderDraft
    expect(payload.models).toEqual([])
  })

  test('删端点：确认框带显示名与「key 保留」说明，确认后走 removeProvider', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)

    fireEvent.click(page.container.querySelector('[data-provider-remove="1"]') as HTMLElement)
    await waitFor(() => expect(document.querySelector('.dsc-confirm__title')?.textContent).toContain('删除端点「DeepSeek 官方」'))
    expect(document.querySelector('.dsc-confirm__detail')?.textContent).toContain('API key 仍保留在凭据库中')
    await answerConfirm(true)

    await waitFor(() => expect(native.calls.length).toBe(1))
    expect(native.calls[0]).toEqual({ op: 'removeProvider', args: ['deepseek'] })
    await waitFor(() => expect(lastToast()).toContain('已删除端点「deepseek」'))
  })
})

// ── 密钥与 Base URL ──────────────────────────────────────────────────────────

describe('连接行就地编辑', () => {
  test('写密钥：空值保存钮是灰的；填好保存走 setProviderKey 并收起录入行', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)

    fireEvent.click(page.container.querySelector('[data-key-edit="1"]') as HTMLElement)
    const input = document.querySelector('input[aria-label="API key"]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect((document.querySelector('.conn-key-edit .btn-ghost') as HTMLButtonElement).disabled).toBe(true)
    type(input, 'sk-new')
    fireEvent.click(document.querySelector('.conn-key-edit .btn-ghost') as HTMLElement)

    await waitFor(() => expect(native.calls.length).toBe(1))
    expect(native.calls[0]).toEqual({ op: 'setProviderKey', args: ['deepseek', 'sk-new'] })
    await waitFor(() => expect(document.querySelector('input[aria-label="API key"]')).toBeNull())
    await waitFor(() => expect(lastToast()).toContain('API key 已写进凭据库'))
  })

  test('清密钥：取消不动桥，确认后传 null；未配 key 的端点没有清除钮', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    expect(document.querySelector('[data-key-clear="1"]')).not.toBeNull()

    fireEvent.click(page.container.querySelector('[data-key-clear="1"]') as HTMLElement)
    await waitFor(() => expect(document.querySelector('.dsc-confirm__title')?.textContent).toContain('清除 DEEPSEEK_API_KEY？'))
    fireEvent.click(document.querySelectorAll('.dsc-confirm__actions button')[0] as HTMLElement)
    expect(native.calls).toHaveLength(0)

    fireEvent.click(page.container.querySelector('[data-key-clear="1"]') as HTMLElement)
    await answerConfirm(true)
    await waitFor(() => expect(native.calls.length).toBe(1))
    expect(native.calls[0]).toEqual({ op: 'setProviderKey', args: ['deepseek', null] })

    // lab 没配 key：按钮写「填写」，没有清除。
    fireEvent.click(page.container.querySelector('[data-provider="lab"]') as HTMLElement)
    await waitFor(() => expect(document.querySelector('[data-key-edit="1"]')?.textContent).toBe('填写'))
    expect(document.querySelector('[data-key-clear="1"]')).toBeNull()
  })

  test('Base URL 失焦保存：去掉尾部斜杠；非法地址报错并重读配置', async () => {
    const native = nativeOf()
    const { channel, calls } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    const input = page.container.querySelector('input[aria-label="Base URL"]') as HTMLInputElement

    type(input, 'https://new.example/v1/')
    blur(input)
    await waitFor(() => expect(native.calls.length).toBe(1))
    expect(native.calls[0]?.op).toBe('saveProvider')
    expect((native.calls[0]?.args[0] as ProviderDraft).baseUrl).toBe('https://new.example/v1')
    await waitFor(() => expect(lastToast()).toContain('Base URL 已保存'))

    type(page.container.querySelector('input[aria-label="Base URL"]'), 'nope')
    blur(page.container.querySelector('input[aria-label="Base URL"]'))
    await waitFor(() => expect(lastToast()).toContain('Base URL 要写成完整的 http(s) 地址'))
    expect(native.calls, '非法地址不得写桥').toHaveLength(1)
    // 重取次数：初始一次 + 合法保存成功后一次 + 非法地址失败后一次。
    await waitFor(() => expect(calls.filter((call) => call.method === 'getModelConfig')).toHaveLength(3))
  })
})

// ── 连接测试 ─────────────────────────────────────────────────────────────────

describe('连接测试', () => {
  test('成功 / 失败结论都留在模型行后面；请求没发出去（reject）也留一条失败结论', async () => {
    let reply: unknown = { ok: true, model: 'deepseek-chat', ms: 21, reply: '你好' }
    const { channel } = channelOf((method) => {
      if (method === 'getModelConfig') return configOf()
      if (method === 'testConnection') return reply
      return { ok: true }
    })
    const page = mount(channel)
    await waitRail(page)

    fireEvent.click(page.container.querySelector('[data-probe-model="deepseek-chat"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('[data-probe="ok"]')).not.toBeNull())
    expect(page.container.querySelector('[data-probe="ok"]')?.getAttribute('data-probe-model')).toBe('deepseek-chat')
    expect(lastToast()).toContain('通了')

    reply = { ok: false, model: 'deepseek-chat', ms: 5, reply: '', error: 'HTTP 401' } satisfies ConnectionTestView
    fireEvent.click(page.container.querySelector('[data-probe-model="deepseek-chat"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('[data-probe="fail"]')).not.toBeNull())
    await waitFor(() => expect(lastToast()).toContain('没通：HTTP 401'))
    expect(page.container.querySelector('[data-probe="fail"]')?.getAttribute('title')).toContain('HTTP 401')

    reply = new Error('boom')
    fireEvent.click(page.container.querySelector('[data-probe-model="deepseek-chat"]') as HTMLElement)
    await waitFor(() => expect(lastToast()).toContain('测试失败：boom'))
    expect(page.container.querySelector('[data-probe="fail"]')?.getAttribute('title')).toContain('没通：boom')
  })

  test('没配密钥的端点：测试连接按钮不可点，悬浮说明讲清原因', async () => {
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-provider="lab"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('[data-probe-model="lab-mini"]')).not.toBeNull())
    const probe = page.container.querySelector('[data-probe-model="lab-mini"]') as HTMLButtonElement
    expect(probe.disabled).toBe(true)
    expect(probe.getAttribute('title')).toContain('该端点没配密钥')
    // 设为默认的圆点也不可点。
    expect((page.container.querySelector('[data-model-set-default="lab-mini"]') as HTMLButtonElement).disabled).toBe(true)
  })
})

// ── 拉取清单 ─────────────────────────────────────────────────────────────────

describe('拉取清单', () => {
  test('默认只勾没加过的；全不选 / 单选 / 采用后整份写回，已有模型行不可点', async () => {
    const native = nativeOf()
    const { channel } = channelOf((method) =>
      method === 'getModelConfig'
        ? configOf()
        : method === 'discoverModels'
          ? ['m-a', 'm-b', 'deepseek-chat']
          : { ok: true },
    )
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-model-discover="1"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('[data-models-discover="1"]')).not.toBeNull())

    // existing 是「端点清单里已有几个模型」，不是「与拉取结果重合几个」。
    expect(document.querySelector('.models-discover-count')?.textContent).toBe('3 个，已加 2 个')
    const existing = page.container.querySelector('[data-discover-item="deepseek-chat"]') as HTMLButtonElement
    expect(existing.disabled).toBe(true)
    expect(existing.textContent).toContain('已有')
    expect(page.container.querySelector('[data-models-discover-adopt="1"]')?.textContent).toContain('采用选中的 2 个')

    fireEvent.click(page.container.querySelector('[data-models-discover-all="1"]') as HTMLElement)
    expect((page.container.querySelector('[data-models-discover-adopt="1"]') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(page.container.querySelector('[data-discover-item="m-a"]') as HTMLElement)
    expect(page.container.querySelector('[data-models-discover-adopt="1"]')?.textContent).toContain('采用选中的 1 个')
    fireEvent.click(page.container.querySelector('[data-models-discover-adopt="1"]') as HTMLElement)

    await waitFor(() => expect(native.calls.length).toBe(1))
    const payload = native.calls[0]?.args[0] as ProviderDraft
    expect(payload.models.map((model) => model.id)).toEqual(['deepseek-chat', 'deepseek-reasoner', 'm-a'])
    await waitFor(() => expect(page.container.querySelector('[data-models-discover="1"]')).toBeNull())
    await waitFor(() => expect(lastToast()).toContain('已加入 1 个模型'))
  })

  test('过滤无结果时给人话；关闭按钮收起弹窗', async () => {
    const { channel } = channelOf((method) =>
      method === 'getModelConfig'
        ? configOf()
        : method === 'discoverModels'
          ? ['m-a', 'm-b']
          : { ok: true },
    )
    const page = mount(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-model-discover="1"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('[data-models-discover="1"]')).not.toBeNull())

    fireEvent.change(page.container.querySelector('input[aria-label="过滤线上模型"]') as HTMLInputElement, {
      target: { value: 'zzz' },
    })
    expect(page.container.querySelector('.models-discover-none')?.textContent).toContain('没有匹配「zzz」的模型')
    expect(page.container.querySelectorAll('[data-discover-item]')).toHaveLength(0)

    fireEvent.click(page.container.querySelector('[data-models-discover-close="1"]') as HTMLElement)
    expect(page.container.querySelector('[data-models-discover="1"]')).toBeNull()
  })
})

// ── 默认端点 / 默认模型 ──────────────────────────────────────────────────────

describe('默认模型下拉', () => {
  test('切默认端点：写它的第一个模型（标签里带「无密钥」提示）', async () => {
    const { channel, calls } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    chooseSelectOption('默认端点', 'lab')
    await waitFor(() => expect(calls.some((call) => call.method === 'setDefaultModel')).toBe(true))
    expect(calls.find((call) => call.method === 'setDefaultModel')?.args).toEqual(['lab', 'lab-mini'])

    // 再打开一次看标签：lab 没配 key，选项带提示。
    fireEvent.click(document.querySelector('[aria-label="默认端点"]') as HTMLElement)
    const labels = [...document.querySelectorAll('.select-opt-label')].map((node) => node.textContent)
    expect(labels.some((label) => label?.includes('lab（无密钥）'))).toBe(true)
  })

  test('默认端点没配密钥：默认模型下拉是禁用的（选了也注册不进去）', async () => {
    const config = configOf({ defaultProvider: 'lab', defaultModel: 'lab-mini' })
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? config : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    expect(page.container.querySelector('[data-provider="lab"] .tag')?.textContent).toBe('默认')
    expect((document.querySelector('[aria-label="默认模型"]') as HTMLButtonElement).disabled).toBe(true)
  })

  test('写默认模型失败：Toast 报原因并重读配置', async () => {
    const { channel, calls } = channelOf((method) => {
      if (method === 'getModelConfig') return configOf()
      if (method === 'setDefaultModel') return { ok: false, error: 'nope' }
      return { ok: true }
    })
    const page = mount(channel)
    await waitRail(page)
    chooseSelectOption('默认模型', 'deepseek-reasoner')
    await waitFor(() => expect(lastToast()).toContain('操作失败：nope'))
    await waitFor(() => expect(calls.filter((call) => call.method === 'getModelConfig')).toHaveLength(2))
  })
})

// ── 刷新与默认选中 ───────────────────────────────────────────────────────────

describe('刷新', () => {
  test('左栏刷新按钮重新拉一次配置', async () => {
    const { channel, calls } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mount(channel)
    await waitRail(page)
    expect(calls.filter((call) => call.method === 'getModelConfig')).toHaveLength(1)
    fireEvent.click(page.container.querySelector('.models-refresh') as HTMLElement)
    await waitFor(() => expect(calls.filter((call) => call.method === 'getModelConfig')).toHaveLength(2))
  })
})
