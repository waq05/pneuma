/**
 * 工具卡（`tool-card/factory.tsx`）剩余出口的补测（W14 重 harness 面）。
 *
 * 两个缺口都得靠真装配 / 假盒模型才走得到：
 *
 *  - **Factory 定义组件本身**（208-214）：`ToolCard` 只在使用方给了槽上下文时才会被挂上，
 *    既有测试都直接渲染 `ToolCardView`，定义组件从没跑过。这里用 `ui-core` 的注册表 +
 *    `ui-slots` 的 `FactoryOutlet` 走生产那条装配路（与 ui-slots 包自己的 w11 测试同一手法），
 *    把真实定义注册进去再渲染一次。
 *  - **展开后的吸附快捷栏**（435-449/535）：`barVisible` 要 `expandedContentHeight(body) > 400`，
 *    jsdom 没有布局。用「整棵子树恒报 500 高」的假盒模型撑过阈值，再点一次收起按钮。
 *
 * @module dsc-ui-transcript/ui/w14c-tool-factory.spec
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { SlotRegistry } from '@dsc/ui-core'
import { FactoryOutlet } from '@dsc/ui-slots'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { UiPluginApi, UiSlots } from '@dsc/ui'
import type { ToolEntry } from './shared.js'
import { TOOLCARD_FACTORY, ToolCardView, registerToolCard } from './tool-card/factory.js'

/** 本文件不触发宿主调用：快照恒 null、invoke 一律拒绝。 */
const stubChannel = (): HostChannel => ({
  getSnapshot: () => null,
  getHello: () => null,
  getStatus: () => 'closed',
  getHostError: () => null,
  getPluginsFrame: () => null,
  onPlugins: () => () => undefined,
  onAsk: () => () => undefined,
  subscribe: () => () => undefined,
  invoke: () => Promise.reject(new Error('测试不触发宿主调用')),
  reconnect: () => undefined,
  close: () => undefined,
})

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

afterAll(() => {
  vi.unstubAllGlobals()
})

let seq = 0
const toolEntry = (call: Partial<ToolEntry['call']> & { name: string }): ToolEntry => ({
  kind: 'tool',
  id: (seq += 1),
  call: { callId: `c${String(seq)}`, argsText: '{}', status: 'done', ...call },
})

// ── Factory 定义组件：走真注册表 + FactoryOutlet 装配 ────────────────────────

describe('ToolCard 定义组件', () => {
  /** 一张只读注册表：只实现 FactoryOutlet 需要的 slots 面。 */
  function mountFactory(): ReturnType<typeof render> {
    const registry = new SlotRegistry()
    const slots = registry as unknown as UiSlots
    // `registerToolCard` 的产物是 void：登记落在注册表里，渲染完随注册表一起丢掉即可。
    ;(registerToolCard as unknown as (ui: UiPluginApi) => void)({ slots } as unknown as UiPluginApi)
    return render(
      <RuntimeProvider channel={stubChannel()}>
        <FactoryOutlet
          slots={slots}
          name={TOOLCARD_FACTORY}
          inputProps={{
            entry: toolEntry({ name: 'mcp_unknown', argsText: '{"k":"v"}', resultText: '结果正文' }),
            variant: 'chat',
            cwd: 'D:/work',
          }}
        />
      </RuntimeProvider>,
    )
  }

  test('定义组件把 entry / cwd 交给共享骨架，四个局部槽各自退到定义内建件（208-214）', () => {
    const { container } = mountFactory()
    const card = container.querySelector('.entry.tool-card')
    expect(card, '定义组件应当画出一张工具卡').not.toBeNull()
    expect(card?.querySelector('.tool-click')).not.toBeNull()
    // 头行摘要（内建 SummaryPreview）与状态列（内建 ChatStatus）都渲染了：both 都是 fallback 件。
    expect(card?.querySelector('.preview')).not.toBeNull()
    expect(card?.querySelector('.status')).not.toBeNull()
  })

  test('点一下展开：定义组件给的 bodyExtra 也在展开体里（后三个槽取自同一份 props）', () => {
    const { container } = mountFactory()
    fireEvent.click(container.querySelector('.tool-click') as HTMLElement)
    expect(container.querySelector('.tool-body')).not.toBeNull()
    // 尾部槽没内容：NoTrailing 什么都不画。
    expect(container.querySelector('.tool-tail')).toBeNull()
  })

  test('槽位能力面完整：renderSlot 收的是声明过的 footer 子槽', () => {
    const registry = new SlotRegistry()
    const slots = registry as unknown as UiSlots
    ;(registerToolCard as unknown as (ui: UiPluginApi) => void)({ slots } as unknown as UiPluginApi)
    const definition = slots.factory(TOOLCARD_FACTORY)
    expect(definition).toBeDefined()
    expect(definition?.children).toContain('transcript.toolcard.footer')
    expect(definition?.slots).toEqual(expect.arrayContaining(['preview', 'statusDetail', 'bodyExtra', 'trailing']))
  })
})

// ── 轨迹页的参数字段表（594） ──────────────────────────────────────────────

describe('轨迹页展开体的参数字段表', () => {
  test('带真实改动的 write 卡：正文退到 diff，其余参数一行一字段（594）', () => {
    const entry = toolEntry({
      name: 'write',
      argsText: JSON.stringify({ path: 'a.md', content: '# 标题', justification: '因为要输出' }),
      change: { path: 'a.md', added: 2, removed: 0, hunks: [], status: 'added' },
    })
    const { container } = render(
      <RuntimeProvider channel={stubChannel()}>
        <ToolCardView entry={entry} variant="trace" />
      </RuntimeProvider>,
    )
    fireEvent.click(container.querySelector('.tool-click') as HTMLElement)
    const fields = [...container.querySelectorAll('.arg-field')].map((field) => ({
      key: field.querySelector('.arg-key')?.textContent ?? '',
      value: field.querySelector('.arg-value')?.textContent ?? '',
    }))
    // 字段顺序按参数对象原有键序（path 在前），只钉「justification 这一对确实画出来了」。
    const justification = fields.find((field) => field.key === 'justification')
    expect(justification?.value).toBe('因为要输出')
  })
})

// ── 吸附快捷栏：假盒模型撑过 400px 阈值 ─────────────────────────────────────

describe('展开后的吸附快捷栏', () => {
  test('展开内容够长：栏出现、按滚动容器顶距标 stuck；点收起把卡合上（435-449/535）', async () => {
    // 假盒模型：所有元素恒报 500 高（jsdom 不做布局）。阈值 400 因此必过。
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 500 })
    try {
      const entry = toolEntry({ name: 'mcp_unknown', argsText: '{"k":"v"}', resultText: '第一行\n第二行\n第三行' })
      const { container } = render(
        <RuntimeProvider channel={stubChannel()}>
          <div className="chat">
            <ToolCardView entry={entry} />
          </div>
        </RuntimeProvider>,
      )
      fireEvent.click(container.querySelector('.tool-click') as HTMLElement)
      await waitFor(() => expect(container.querySelector('.tc-bar')).not.toBeNull())
      const bar = container.querySelector('.tc-bar') as HTMLElement
      // 滚动容器顶距 0 <= 内距 + 1.5：初始 sync 就把 stuck 标上。
      expect(bar.classList.contains('stuck')).toBe(true)
      // 滚一下：监听器真的挂在 .chat 上（sync 重复执行，不抛）。
      fireEvent.scroll(container.querySelector('.chat') as HTMLElement)
      expect(bar.classList.contains('stuck')).toBe(true)
      // 收起按钮：点一下整卡合上。
      fireEvent.click(bar.querySelector('.tc-collapse') as HTMLElement)
      expect(container.querySelector('.tool-body')).toBeNull()
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
      else Object.defineProperty(HTMLElement.prototype, 'scrollHeight', descriptor)
    }
  })
})
