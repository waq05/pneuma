/**
 * 设置 → 模型页的渲染断言（ui 层）。
 *
 * 来源：`scripts/ui-models-page-test.mjs` 整条与 `scripts/ui-model-caps-test.mjs` 第 [3][5] 段
 * 里「壳侧接线」的那一半。原探针读 `models.tsx` 源码钉类名、钩子与写路径——真渲染下这些钉
 * 全部有行为等价物，而且「写路径」比源码钉硬得多：
 *
 * - 「写口只有三个桥方法」→ 假桥记下每一次 `invoke`，提交路径里收到的 op 与参数直接断言；
 * - 「单模型保存借 saveProvider 整份写（并回端点的模型清单再走同一套校验）」→ 详情页编辑
 *   一行保存，桥收到的 payload 是**整份**模型清单；
 * - 「validateDraft 校验与宿主同款」→ `validateDraft` 埋在组件内（没导出，方案 E 不落地），
 *   经「新增端点表单填坏值 → 提交 → 读报错」这条用户路径验：非法名字、模型 id 空白，各自的
 *   报错原文都在 Toast 层读得到；
 * - 「忙碌态按端点记的集合」→ 两家端点同时拉清单，一张转另一张不转（0.6.69 报障的行为面）；
 * - 「弹窗每行给依据」→ 拉到的模型按推断来源打到 `data-discover-source` 上（known/marker/
 *   family/default 四档），行上带上下文读数。
 *
 * 骨架与左栏 / 右栏的钩子（`data-provider`、默认标、密钥状态点、`data-model-chip`、
 * `data-probe-model`、`data-model-edit`…）直接按 DOM 断言——比源码文本钉多验一层
 * 「真的画出来了」。
 *
 * 第 [6] 段（views.css 的样式门）与 [7] 段（探针自证）是 CSS 文本钉 / 探针自检，
 * jsdom 不吃样式表，无渲染接缝，不迁（与 B26 同一处置）。
 *
 * 渲染口径：`ModelsGroup` 摸 `useHostChannel`（要 `RuntimeProvider` + 假通道）与
 * `getHostNative`（读 `globalThis.dscNative`——用例里塞桩，桌面窗口的桥就是这个形状）。
 * Toast / 确认框都落在 `document.body` 上，用例直接查。
 *
 * @module dsc-ui-settings/ui/models.spec
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { ModelConfigView, ProviderModelView, SettingsMutation } from '@dsc/ui'
import { ModelsGroup } from './models.js'

// ── 假宿主与假桥 ───────────────────────────────────────────────────────────────

/** 两个端点：deepseek 已配 key 且是默认，lab 没配 key。 */
function configOf(): ModelConfigView {
  const model = (id: string, over: Partial<ProviderModelView> = {}): ProviderModelView => ({
    id,
    name: id,
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinkingLevels: ['off', 'low', 'high', 'max'],
    thinkingParam: 'thinking',
    effortMap: {},
    modalities: ['text'],
    ...over,
  })
  return {
    providers: [
      { name: 'deepseek', displayName: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', keyRef: 'DEEPSEEK_API_KEY', keyConfigured: true, models: [model('deepseek-chat'), model('deepseek-reasoner')] },
      { name: 'lab', displayName: '', baseUrl: 'https://lab.example/v1', keyRef: 'LAB_KEY', keyConfigured: false, models: [model('lab-mini')] },
    ],
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek-chat',
    temperature: null,
    configFile: 'D:\\dsc\\config.yaml',
    credentialsFile: 'D:\\dsc\\credentials.yaml',
  }
}

interface Recorded {
  method: string
  args: unknown[]
}

/**
 * 假通道：`getModelConfig` 回配置，其余按用例给的应答表走；都记进 `calls`。
 */
function fakeChannel(config: ModelConfigView, replies: Record<string, unknown> = {}): { channel: HostChannel; calls: Recorded[] } {
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
    invoke: <T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      if (method === 'getModelConfig') return Promise.resolve(config) as Promise<T>
      const reply = replies[method]
      return (reply === undefined ? Promise.resolve({ ok: true }) : Promise.resolve(reply)) as Promise<T>
    },
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

/** 假原生桥：桌面窗口 preload 挂的 `window.dscNative` 就是这个形状。 */
function fakeNative(replies: Record<string, (args: unknown[]) => unknown> = {}): { calls: { op: string; args: unknown[] }[] } {
  const calls: { op: string; args: unknown[] }[] = []
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (op: string, args: unknown[] = []) => {
      calls.push({ op, args })
      const handler = replies[op]
      return Promise.resolve(handler === undefined ? { ok: true } : handler(args))
    },
    on: () => () => undefined,
  }
  return { calls }
}

/** 挂一次 ModelsGroup（通道与桥由调用方给）。 */
function mount(channel: HostChannel): ReturnType<typeof render> {
  return render(
    <RuntimeProvider channel={channel}>
      <ModelsGroup />
    </RuntimeProvider>,
  )
}

/** 摘掉 Toast / 确认框的 body 挂件与桥桩。 */
afterEach(() => {
  cleanup()
  document.querySelectorAll('.dsc-toasts, .dsc-confirm').forEach((node) => node.remove())
  delete (globalThis as { dscNative?: unknown }).dscNative
})

/**
 * 桌面窗口的桥默认在位（`editable = native.available`）：没有桥时整页降级只读——
 * 添加端点、编辑、删除全都不画。需要验只读档的用例自己把桩删掉。
 */
beforeEach(() => {
  ;(globalThis as { dscNative?: unknown }).dscNative = { version: 1, call: () => Promise.resolve({ ok: true }), on: () => () => undefined }
})

/** 等左栏端点行出现（getModelConfig 的 promise 落地、组件重画）。 */
async function waitRail(page: ReturnType<typeof render>): Promise<void> {
  await waitFor(() => expect(page.container.querySelector('[data-provider="deepseek"]')).not.toBeNull())
}

/** 读最近一条 Toast 的文字（err 与 ok 都走同一个容器）。 */
function lastToast(): string {
  const nodes = document.querySelectorAll('.dsc-toasts [role="status"], .dsc-toasts > *')
  const node = nodes[nodes.length - 1]
  return node?.textContent ?? ''
}

// ── 骨架与左栏（探针 [1][2] 的 DOM 面） ────────────────────────────────────────

test('页面骨架：两栏卡（左栏端点 + 右栏详情）与页根类名都画出来了', async () => {
  const page = mount(fakeChannel(configOf()).channel)
  await waitRail(page)
  expect(page.container.querySelector('.models-page')).not.toBeNull()
  expect(page.container.querySelector('.models-panes')).not.toBeNull()
  expect(page.container.querySelector('.models-rail')).not.toBeNull()
  expect(page.container.querySelector('.models-detail')).not.toBeNull()
})

test('左栏端点行：默认标、密钥状态点、添加端点的钩子、文件路径都在', async () => {
  const page = mount(fakeChannel(configOf()).channel)
  await waitRail(page)
  const rows = page.container.querySelectorAll('[data-provider]')
  expect(rows.length).toBe(2)
  // 默认端点带「默认」标；没配 key 的端点状态点是 warn 档。
  expect(page.container.querySelector('[data-provider="deepseek"] .tag')?.textContent).toBe('默认')
  expect(page.container.querySelector('[data-provider="lab"] .provider-dot.warn')).not.toBeNull()
  expect(page.container.querySelector('[data-provider="deepseek"] .provider-dot.ok')).not.toBeNull()
  expect(page.container.querySelector('[data-provider-add="1"]')).not.toBeNull()
  expect(page.container.querySelector('.models-paths')?.textContent).toContain('config.yaml')
})

// ── 右栏详情头 / 连接卡 / 模型块（探针 [3] 的 DOM 面） ─────────────────────────

test('右栏详情：连接卡两行、模型块的三个动作、每行模型的钩子都在', async () => {
  const page = mount(fakeChannel(configOf()).channel)
  await waitRail(page)
  // 默认落在 deepseek。
  expect(page.container.querySelector('[data-provider-edit="1"]')).not.toBeNull()
  expect(page.container.querySelector('[data-provider-remove="1"]')).not.toBeNull()
  expect(page.container.querySelector('.conn-card')?.textContent).toContain('Base URL')
  expect(page.container.querySelector('[data-key-edit="1"]')?.textContent).toContain('替换')
  expect(page.container.querySelector('[data-model-bulk="1"]')).not.toBeNull()
  expect(page.container.querySelector('[data-model-discover="1"]')).not.toBeNull()
  expect(page.container.querySelector('[data-model-add="1"]')).not.toBeNull()
  const chip = page.container.querySelector('[data-model-chip="deepseek-chat"]')
  expect(chip).not.toBeNull()
  // 默认模型圆点 + 测试连接 + 编辑 / 删除，全在这一行里。
  expect(page.container.querySelector('[data-model-set-default="deepseek-chat"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(page.container.querySelector('[data-probe-model="deepseek-chat"]')).not.toBeNull()
  expect(page.container.querySelector('[data-model-edit="deepseek-chat"]')).not.toBeNull()
  expect(page.container.querySelector('[data-model-remove="deepseek-chat"]')).not.toBeNull()
})

test('一次只开一个能力编辑器：点另一行的编辑，前一个收起', async () => {
  const page = mount(fakeChannel(configOf()).channel)
  await waitRail(page)
  fireEvent.click(page.container.querySelector('[data-model-edit="deepseek-chat"]') as HTMLElement)
  await waitFor(() => expect(page.container.querySelector('[data-model-edit-box="deepseek-chat"]')).not.toBeNull())
  fireEvent.click(page.container.querySelector('[data-model-edit="deepseek-reasoner"]') as HTMLElement)
  await waitFor(() => expect(page.container.querySelector('[data-model-edit-box="deepseek-reasoner"]')).not.toBeNull())
  expect(page.container.querySelector('[data-model-edit-box="deepseek-chat"]'), '前一个编辑器应已收起').toBeNull()
})

// ── 写路径：validateDraft 埋在组件内，经「填 → 提交 → 读报错」这条用户路径验 ─────

test('新增端点填了非法名字 → 提交被拦，报错原文在 Toast 层（桥一次都没被调）', async () => {
  const { channel } = fakeChannel(configOf())
  const native = fakeNative()
  const page = mount(channel)
  await waitRail(page)
  fireEvent.click(page.container.querySelector('[data-models-add="1"]') as HTMLElement)
  await waitFor(() => expect(page.container.querySelector('[data-provider-form="new"]')).not.toBeNull())
  const form = page.container.querySelector('[data-provider-form="new"]') as HTMLElement
  const nameInput = form.querySelector('input.setting-input') as HTMLInputElement
  fireEvent.change(nameInput, { target: { value: 'Bad Name!' } })
  fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)
  await waitFor(() => expect(lastToast()).toContain('端点名只能用小写字母、数字、- 或 _'))
  expect(native.calls, '校验不过不得写桥').toHaveLength(0)
})

test('新增端点模型 id 空白 → 提交被拦（宿主那侧同样拒收的那一条）', async () => {
  const { channel } = fakeChannel(configOf())
  const native = fakeNative()
  const page = mount(channel)
  await waitRail(page)
  fireEvent.click(page.container.querySelector('[data-models-add="1"]') as HTMLElement)
  await waitFor(() => expect(page.container.querySelector('[data-provider-form="new"]')).not.toBeNull())
  const form = page.container.querySelector('[data-provider-form="new"]') as HTMLElement
  const inputs = form.querySelectorAll('input.setting-input')
  // 新增表单的字段序：名字 / 显示名 / Base URL / API Key；名字给合法值，模型 id 留空。
  fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: 'newprov' } })
  fireEvent.change(inputs[2] as HTMLInputElement, { target: { value: 'https://x.example/v1' } })
  fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)
  await waitFor(() => expect(lastToast()).toContain('每个模型都要填 id'))
  expect(native.calls).toHaveLength(0)
})

test('新增端点填全 → 提交走 saveProvider（payload 是整份模型清单），名字改回合法形状', async () => {
  const { channel } = fakeChannel(configOf())
  const native = fakeNative()
  const page = mount(channel)
  await waitRail(page)
  fireEvent.click(page.container.querySelector('[data-models-add="1"]') as HTMLElement)
  await waitFor(() => expect(page.container.querySelector('[data-provider-form="new"]')).not.toBeNull())
  const form = page.container.querySelector('[data-provider-form="new"]') as HTMLElement
  const inputs = form.querySelectorAll('input.setting-input')
  fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: 'newprov' } })
  fireEvent.change(inputs[2] as HTMLInputElement, { target: { value: 'https://x.example/v1/' } })
  const modelId = form.querySelector('.model-row input') as HTMLInputElement
  fireEvent.change(modelId, { target: { value: 'new-model' } })
  // 上下文窗口必填（宿主同样拒收 0）：这一行输入框的顺序是 id / 显示名 / 上下文 / 最大输出。
  const rowInputs = (form.querySelector('.model-row') as HTMLElement).querySelectorAll('input')
  fireEvent.change(rowInputs[2] as HTMLInputElement, { target: { value: '128000' } })
  fireEvent.blur(rowInputs[2] as HTMLInputElement)
  fireEvent.click(form.querySelector('[data-provider-save="1"]') as HTMLElement)
  await waitFor(() => expect(native.calls.length).toBeGreaterThan(0))
  const save = native.calls[0] as { op: string; args: unknown[] }
  expect(save.op).toBe('saveProvider')
  const payload = save.args[0] as { name: string; baseUrl: string; models: ProviderModelView[] }
  expect(payload.name).toBe('newprov')
  expect(payload.baseUrl).toBe('https://x.example/v1')
  expect(payload.models).toHaveLength(1)
  expect(payload.models[0]?.id).toBe('new-model')
})

test('详情页编辑一行模型保存：借 saveProvider 整份写（并回端点的模型清单）', async () => {
  const { channel } = fakeChannel(configOf())
  const native = fakeNative()
  const page = mount(channel)
  await waitRail(page)
  fireEvent.click(page.container.querySelector('[data-model-edit="deepseek-chat"]') as HTMLElement)
  await waitFor(() => expect(page.container.querySelector('[data-model-edit-box="deepseek-chat"]')).not.toBeNull())
  // 编辑器里改 id 并保存（data-model-save={model.id} 那颗钮）。
  const box = page.container.querySelector('[data-model-edit-box="deepseek-chat"]') as HTMLElement
  const idInput = box.querySelector('input') as HTMLInputElement
  fireEvent.change(idInput, { target: { value: 'deepseek-chat-2' } })
  fireEvent.click(box.querySelector('[data-model-save="deepseek-chat"]') as HTMLElement)
  await waitFor(() => expect(native.calls.length).toBeGreaterThan(0))
  const payload = (native.calls[0] as { args: unknown[] }).args[0] as { models: ProviderModelView[] }
  // 整份：两个模型都在，且被编辑的那一行换成了新 id。
  expect(payload.models.map((model) => model.id)).toEqual(['deepseek-chat-2', 'deepseek-reasoner'])
})

// ── ui-model-caps [3]：忙碌态按端点记的集合 ─────────────────────────────────────

test('拉清单忙碌态按端点：A 在拉，B 不跟着转（0.6.69 报障的行为面）', async () => {
  const { channel } = fakeChannel(configOf(), {
    discoverModels: new Promise(() => undefined), // 永不落定：忙碌态停在 A 上
  })
  const page = mount(channel)
  await waitRail(page)
  // 右栏此刻是默认端点 deepseek：点它的「拉取清单」。忙碌态的表现是钮转圈 + disabled
  // （文案恒是「拉取清单」，转的是图标）。
  fireEvent.click(page.container.querySelector('[data-model-discover="1"]') as HTMLElement)
  await waitFor(() => expect(page.container.querySelector('[data-model-discover="1"]')).toHaveProperty('disabled', true))
  expect(page.container.querySelector('[data-model-discover="1"] .spin')).not.toBeNull()
  // 切到 lab：它的拉取钮不是忙碌态。
  fireEvent.click(page.container.querySelector('[data-provider="lab"]') as HTMLElement)
  await waitFor(() => expect(page.container.querySelector('[data-provider="lab"]')).not.toBeNull())
  expect(page.container.querySelector('[data-model-discover="1"]')).toHaveProperty('disabled', false)
})

// ── ui-model-caps [5]：弹窗每行给依据（推断来源打到 DOM 上） ─────────────────────

test('拉取清单弹窗：每行带推断来源（data-discover-source 四档）与上下文读数', async () => {
  const { channel } = fakeChannel(configOf(), {
    // deepseek-chat 是本端点已有的（行上标「已有」但推断仍走 known 一档——配置里配过的同 id）。
    discoverModels: ['deepseek-chat', 'qwen3-1m-vl', 'claude-sonnet-9', 'mystery-model-zz'],
  })
  const page = mount(channel)
  await waitRail(page)
  fireEvent.click(page.container.querySelector('[data-model-discover="1"]') as HTMLElement)
  const sourceOf = (id: string): string | null =>
    page.container.querySelector(`[data-discover-item="${id}"]`)?.getAttribute('data-discover-source') ?? null
  await waitFor(() => expect(sourceOf('claude-sonnet-9')).not.toBeNull())
  // 四档推断（model-infer.ts）在弹窗行上一一可读：别的端点配过的同 id → known；
  // id 写着尺寸/视觉词 → marker；家族表 → family；都不认得 → default。
  expect(sourceOf('deepseek-chat')).toBe('known')
  expect(sourceOf('qwen3-1m-vl')).toBe('marker')
  expect(sourceOf('claude-sonnet-9')).toBe('family')
  expect(sourceOf('mystery-model-zz')).toBe('default')
  const row = page.container.querySelector('[data-discover-item="qwen3-1m-vl"]') as HTMLElement
  // 本页的读数口径：≥1M 显示「1M」，其余取整到 K（models.tsx 自己的 contextLabel）。
  expect(row.querySelector('.ctx')?.textContent).toBe('1M')
  expect(row.textContent).toContain('图')
})
