/**
 * `runtime_api` 的反射主题 services / events（integration 层，原 `scripts/runtime-api-test.mjs`）。
 *
 * 这两个主题读的是 cordis 的内部结构（`reflect.store` / `events._hooks`）。口径错了不报错，
 * 只报出一堆假信息：原型链上的 `hasOwnProperty` 算成一个方法、`internal/*` 内部事件算成
 * 插件挂钩点、同一服务的两份隔离副本各报一遍。所以这一层钉两件事：
 *
 *   1. 纯函数（`inspect.ts`）的过滤口径：排序、去重留方法多的、跳过无值服务、跳过
 *      `internal/*` 与零监听事件；
 *   2. 真内核里跑一次 `runtime_api`，看**模型真的拿到的文本**里有 services / events 两段。
 *      这是原探针第 3 段那 5 条源码文本断言的替代品：那几条钉的是「接线还在不在」，
 *      这里直接问工具要输出——接线断了就没有这两段。
 *
 * `describe` 的字符串化（`toContain('## services')`）用的是工具输出里的真实分节头
 * （`src/packages/runtime-api/index.ts` 的 `TOPICS.map((name) => '## ' + name)`）。
 *
 * @module dsc/packages/runtime-api/runtime-api.int.spec
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'
import { listEvents, listServices } from './inspect.js'

describe('listServices：反射出来的服务清单', () => {
  /** 一份照 cordis 存储形状搭的假表：symbol 键 → { name, value }。 */
  const store = {
    [Symbol('a')]: { name: 'tools', value: { register() {}, list() {}, project() {} } },
    // 同一服务在另一个 isolation 作用域里的副本：方法少的丢掉。
    [Symbol('b')]: { name: 'tools', value: { register() {} } },
    [Symbol('c')]: { name: 'guards', value: { chain: [] } },
    [Symbol('d')]: { name: 'broken' },
  }
  const rows = listServices(store)

  test('按名字排序', () => {
    expect(rows.map((row) => row.name)).toEqual(['broken', 'guards', 'tools'])
  })

  test('同一服务的多份实现只留方法多的那一份', () => {
    expect(rows.find((row) => row.name === 'tools')?.methods).toHaveLength(3)
  })

  test('没有值的服务不炸，报成零方法', () => {
    expect(rows.find((row) => row.name === 'broken')?.methods).toEqual([])
  })

  test('原型链上的 Object 方法不进清单', () => {
    expect(rows.find((row) => row.name === 'tools')?.methods).not.toContain('hasOwnProperty')
  })

  test('空表给空数组', () => {
    expect(listServices(undefined)).toEqual([])
  })
})

describe('listEvents：事件名与监听数', () => {
  const hooks = {
    'dsc/changed': [() => {}, () => {}],
    'internal/listener': [() => {}],
    'agent/start': [],
    [Symbol('dsc/private')]: [() => {}],
  }
  const rows = listEvents(hooks)

  test('internal/* 内部事件不列', () => {
    expect(rows.some((row) => row.name.startsWith('internal/'))).toBe(false)
  })

  test('零监听的事件不列（列出来等于告诉写插件的人挂上去没用）', () => {
    expect(rows.some((row) => row.name === 'agent/start')).toBe(false)
  })

  test('字符串事件带监听数，符号事件也列', () => {
    expect(rows.find((row) => row.name === 'dsc/changed')?.listeners).toBe(2)
    expect(rows).toHaveLength(2)
  })

  test('按名字排序', () => {
    expect(rows[0]!.name.localeCompare(rows[1]!.name)).toBeLessThanOrEqual(0)
  })
})

/** 内核里本文件用到的服务面。 */
interface KernelSurface {
  presets: { use(name: string): string; readonly name: string }
  tools: { list(): Array<{ name: string; description: string }>; visible(): Array<{ name: string }> }
  session: { current(): { messages: Array<{ role: string; content: unknown }> } }
}

let llm: FakeLLM
let kernel: BootedKernel
let surface: KernelSurface

beforeAll(async () => {
  llm = await fakeLLM({
    // 每轮两步：先要一次 runtime_api，再收尾。请求序号与回合一一对应。
    turns: [
      { toolCall: { name: 'runtime_api', args: { topic: 'services' } } },
      '看完了',
      { toolCall: { name: 'runtime_api', args: { topic: 'events' } } },
      '看完了',
      { toolCall: { name: 'runtime_api', args: {} } },
      '看完了',
    ],
  })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  surface = kernel.ctx as unknown as KernelSurface
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
})

/** 这一轮新增的工具结果文本（会话跨用例累积，只看这一轮新写的）。 */
function toolTextsSince(before: number): string[] {
  return surface.session
    .current()
    .messages.slice(before)
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content))
}

/** 跑一个回合并返回新增的工具结果文本。 */
async function turn(text: string): Promise<string[]> {
  const before = surface.session.current().messages.length
  await kernel.runTurn(text)
  return toolTextsSince(before)
}

describe('真内核：runtime_api 报的是此刻的真状态', () => {
  test('创造模式下工具目录里才有 runtime_api（标准模式不露头）', () => {
    expect(surface.tools.visible().map((tool) => tool.name)).not.toContain('runtime_api')
    surface.presets.use('maker')
    expect(surface.presets.name).toBe('maker')
    expect(surface.tools.visible().map((tool) => tool.name)).toContain('runtime_api')
  })

  test('工具说明里两个主题都写着（模型靠它决定问什么）', () => {
    const description = surface.tools.list().find((tool) => tool.name === 'runtime_api')?.description ?? ''
    expect(description).toContain('topic=services')
    expect(description).toContain('topic=events')
  })

  test('topic 的参数枚举里两个主题都是合法值（原探针「TOPICS 含 services / events」的行为面）', () => {
    // 参数 schema 是模型唯一能看到的契约：枚举里没有，模型就不会问这个主题。
    const entry = surface.tools.list().find((tool) => tool.name === 'runtime_api') as
      | { parameters?: { properties?: { topic?: { enum?: string[] } } } }
      | undefined
    expect(entry?.parameters?.properties?.topic?.enum).toEqual(
      expect.arrayContaining(['services', 'events']),
    )
  })

  test('topic=services：报出真注册的服务名与方法数', async () => {
    const texts = await turn('看服务')
    expect(texts.some((text) => text.includes('服务 '))).toBe(true)
    // 内核自己 provide 的服务一定在：这是「读的是真注册表」而不是静态清单的证据。
    expect(texts.some((text) => /- (session|approval|tools)（\d+ 个方法）/.test(text))).toBe(true)
  })

  test('topic=events：报出真事件名与监听数，且不含 internal/*', async () => {
    const texts = await turn('看事件')
    const joined = texts.join('\n')
    expect(joined).toContain('事件 ')
    expect(joined).toMatch(/- dsc\/[a-z-]+｜\d+ 个监听/)
    expect(joined).not.toContain('internal/')
  })

  test('省略 topic：从第一段起全套都报（不是只剩一行标题）', async () => {
    // 省略 topic 会把八个主题全拼进一段正文，工具结果会被截断——能断言的是「从最前面
    // 那段起就真的在报」，而不是「八段都塞得下」。
    const texts = await turn('全都报一遍')
    const joined = texts.join('\n')
    expect(joined).toContain('内核 API 版本')
    expect(joined).toContain('## plugins')
    expect(joined).toContain('## tools')
  })
})
