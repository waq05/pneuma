/**
 * runtime_api 工具的八条主题分支（覆盖率补齐）：`packages/runtime-api/index.ts` 的
 * describe* 闭包与 `run` 的 topic 派发原先只有包形态测试，逻辑行全裸。
 *
 * 做法：造一个最小假宿主（tools / guards / prompt / surfaces / presets / reflect / events），
 * 让 `apply` 把工具注册进来，再逐 topic 调 `run` 断言正文口径。不 mock 被测函数本身。
 *
 * @module @pneuma/runtime-api/tests/runtime-api-branches
 */
import { describe, expect, test } from 'vitest'
import { runtimeApiPlugin } from '../index.js'

interface RegisteredTool {
  name: string
  description: string
  risk: string
  presets?: string[]
  run: (args: Record<string, unknown>) => Promise<string>
}

/** 假宿主：只实现被测闭包用到的那几个面。 */
function fakeHost(): { ctx: Record<string, unknown>; registered: RegisteredTool[] } {
  const registered: RegisteredTool[] = []
  const ctx: Record<string, unknown> = {
    tools: {
      list: () => [
        { name: 'bash', risk: 'exec', description: '运行 shell 命令\n第二行', presets: undefined },
        { name: 'read_image', risk: 'read', description: '看图片', presets: ['minimal'] },
      ],
      register: (entry: RegisteredTool) => {
        registered.push(entry)
        return () => {}
      },
    },
    guards: { chain: [{ order: 30, id: 'approval' }] },
    prompt: {
      sections: () => [
        { order: 20, id: 'tool-rules', text: '工具规则\n第二行' },
        { order: 10, id: 'identity', text: '你是谁' },
      ],
    },
    surfaces: { ids: ['main'] },
    presets: {
      surface: () => ({
        current: 'standard',
        defaultName: 'standard',
        options: [
          { name: 'standard', label: '标准', tools: null, drop: [] },
          { name: 'minimal', label: '极简', tools: ['bash'], drop: ['skills'], problem: '缺 read' },
          { name: 'empty', label: '空档', tools: [], drop: [] },
        ],
      }),
    },
    // cordis 的 effect：立即执行工厂，返回值被丢弃也不影响被测逻辑。
    effect: (factory: () => unknown) => factory(),
  }
  return { ctx, registered }
}

/** 八条主题之外的全量正文里必须出现的标题。 */
const TOPICS = ['plugins', 'tools', 'prompt', 'guards', 'surfaces', 'presets', 'services', 'events'] as const

describe('runtime_api 的只读清单', () => {
  test('注册元数据：名字、只读风险档、只给创造模式', () => {
    const { ctx, registered } = fakeHost()
    ;(runtimeApiPlugin.apply as unknown as (host: unknown) => void)(ctx)
    expect(registered).toHaveLength(1)
    const tool = registered[0]!
    expect(tool.name).toBe('runtime_api')
    expect(tool.risk).toBe('read')
    expect(tool.presets).toEqual(['maker'])
    expect(tool.description).toContain('topic=plugins')
  })

  test('tools：列出名字/风险档/模式限制，长描述压成一行', async () => {
    const { ctx, registered } = fakeHost()
    ;(runtimeApiPlugin.apply as unknown as (host: unknown) => void)(ctx)
    const out = await registered[0]!.run({ topic: 'tools' })
    expect(out).toContain('工具 2 个')
    expect(out).toContain('- bash [exec]')
    expect(out).toContain('只在 minimal 模式露面')
    expect(out).toContain('运行 shell 命令 第二行')
  })

  test('plugins：无注册表时也报一行（不抛）', async () => {
    const { ctx, registered } = fakeHost()
    ;(runtimeApiPlugin.apply as unknown as (host: unknown) => void)(ctx)
    const out = await registered[0]!.run({ topic: 'plugins' })
    expect(out).toContain('插件 0 个：')
  })

  test('prompt：按 order 升序，同序按 id；附内置骨架段说明', async () => {
    const { ctx, registered } = fakeHost()
    ;(runtimeApiPlugin.apply as unknown as (host: unknown) => void)(ctx)
    const out = await registered[0]!.run({ topic: 'prompt' })
    expect(out).toContain('提示段 2 个')
    expect(out.indexOf('10 identity')).toBeLessThan(out.indexOf('20 tool-rules'))
    expect(out).toContain('内置骨架段')
    expect(out).toContain('模式能去掉的段')
  })

  test('guards / surfaces：报链上守卫与快照片段', async () => {
    const { ctx, registered } = fakeHost()
    ;(runtimeApiPlugin.apply as unknown as (host: unknown) => void)(ctx)
    const guards = await registered[0]!.run({ topic: 'guards' })
    expect(guards).toContain('守卫链 1 位')
    expect(guards).toContain('order 30｜approval')
    const surfaces = await registered[0]!.run({ topic: 'surfaces' })
    expect(surfaces).toContain('快照片段 1 个：main')
  })

  test('presets：全量/无/清单三种 tools 口径与 drop、problem 尾注', async () => {
    const { ctx, registered } = fakeHost()
    ;(runtimeApiPlugin.apply as unknown as (host: unknown) => void)(ctx)
    const out = await registered[0]!.run({ topic: 'presets' })
    expect(out).toContain('模式 3 个（当前 standard，新会话默认 standard）')
    expect(out).toContain('standard｜标准｜工具：全量')
    expect(out).toContain('minimal｜极简｜工具：bash｜去掉：skills｜有问题：缺 read')
    expect(out).toContain('empty｜空档｜工具：无')
    expect(out).toContain('模式文件目录')
  })

  test('services / events：走 cordis 内部表，过滤 getter 与 internal 事件', async () => {
    const { ctx, registered } = fakeHost()
    const symbol = Symbol('svc')
    ctx['reflect'] = {
      store: {
        [symbol]: {
          name: 'llm',
          value: {
            complete() {},
            stream() {},
            notAFunction: 1,
            get lazy() {
              return 1
            },
          },
        },
        [Symbol('broken')]: { name: 42 },
      },
    }
    ctx['events'] = {
      _hooks: {
        'tool/before': [() => {}, () => {}],
        'internal/secret': [() => {}],
        'empty/event': [],
        [Symbol('sym/event')]: [() => {}],
      },
    }
    ;(runtimeApiPlugin.apply as unknown as (host: unknown) => void)(ctx)
    const services = await registered[0]!.run({ topic: 'services' })
    expect(services).toContain('服务 1 个')
    expect(services).toContain('llm（2 个方法）')
    expect(services).not.toContain('lazy')
    const events = await registered[0]!.run({ topic: 'events' })
    expect(events).toContain('事件 2 个')
    expect(events).toContain('tool/before｜2 个监听')
    expect(events).not.toContain('internal/secret')
    expect(events).toContain('Symbol(sym/event)')
  })

  test('省略 topic 时八段全报；不认识的 topic 退回全量', async () => {
    const { ctx, registered } = fakeHost()
    ;(runtimeApiPlugin.apply as unknown as (host: unknown) => void)(ctx)
    const all = await registered[0]!.run({})
    for (const topic of TOPICS) expect(all).toContain(`## ${topic}`)
    expect(all).toContain('内核 API 版本')
    const bogus = await registered[0]!.run({ topic: 'no-such-topic' })
    expect(bogus).toContain('## plugins')
  })
})



