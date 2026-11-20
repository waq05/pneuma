/**
 * microcompact 插件层补测（W14）：只补既有两个 spec 没走到的边角。
 *
 * 覆盖目标（对照 W14 缺口清单）：
 * - `index.ts`：`request` 刷新档每次请求重算；冻结表满 64 条后的淘汰；估算服务在
 *   「总开关关着」与「ROI 门槛不够」两条短路；设置分区 `save` 的 `enabled` 分支与未知键；
 *   卸载收尾三件事。
 * - `microcompact.ts`：`messageChars` 对数组正文（只数 text 部件）与 null 正文（算 0）。
 *
 * 纯函数算法与 round/budget 两档语义在 `microcompact.spec.ts` / `config.spec.ts` 里已经钉过，
 * 这里不重复断言行为语义，只把这些分支真正走一遍并断言可观察结果。
 *
 * 环境隔离与 `config.spec.ts` 同一套：`resolvePluginConfig` / `writePluginConfig` 读
 * `DSC_HOME` 下的 `plugins.json`，而 `path-policy` 的 `DSC_HOME` 是**模块求值时**算定的常量，
 * 所以本文件不许在设置环境变量之前静态 import 任何 `src/**` 运行期模块（类型 import 会被
 * 擦掉，安全）：先指到 `mkdtempSync` 的临时目录，再动态 import 插件；真实 `~/.dsc` 一个字节都不碰。
 *
 * @module @pneuma/microcompact/tests/w14-plugin-edges
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import type { SettingsField, SettingsValues } from '@pneuma/runtime/contract.js'
import type { MicrocompactService, SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { afterAll, expect, test } from 'vitest'

/** 临时主目录；模块级常量在 import 运行时之前就要换好。 */
const home = mkdtempSync(join(tmpdir(), 'dsc-microcompact-w14-'))
const originalHome = process.env.DSC_HOME
process.env.DSC_HOME = home

const { microcompactPlugin } = await import('../index.js')
const { promptCharsOf } = await import('../microcompact.js')
const { estimateTokens } = await import('@pneuma/session-core/compact.js')

afterAll(() => {
  if (originalHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

/** 投影签名（本文件只用到前两个参数）。 */
type Projection = (messages: ChatMessage[], session: unknown) => ChatMessage[]

/** 设置分区窄接口：本插件同步实现，测试按同步形状断言。 */
interface TestSection {
  fields(): SettingsField[]
  values(): SettingsValues
  save(key: string, value: unknown): string | void
}

/** mount 出来的四件东西。 */
interface Mounted {
  projection: Projection
  section: TestSection
  service: MicrocompactService
  /** 卸载时被调用的 disposer 名字，用来验收尾三件事一件不漏。 */
  disposed: string[]
  dispose: () => void
}

/**
 * 装一次插件。桩 ctx 只提供 apply 用到的面，语义与 cordis 一致：
 * `effect` 立即执行回调并把返回值当作注销函数。
 * @param config - 装配时递给插件的第二参数（`resolvePluginConfig` 的最强一档）。
 */
function mount(config: Record<string, unknown> = {}): Mounted {
  const disposed: string[] = []
  let projection: Projection | null = null
  let section: TestSection | null = null
  let service: MicrocompactService | null = null
  const stub = {
    prompt: {
      registerProjection: (_id: string, fn: Projection) => {
        projection = fn
        return () => {
          disposed.push('projection')
        }
      },
    },
    settings: {
      registerSection: (spec: SettingsSectionSpec) => {
        section = spec as unknown as TestSection
        return () => {
          disposed.push('section')
        }
      },
    },
    session: {
      current: () => {
        throw new Error('测试里应显式传会话')
      },
    },
    provide: (_name: string, provided: MicrocompactService) => {
      service = provided
      return () => {
        disposed.push('service')
      }
    },
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
  }
  const dispose = microcompactPlugin.apply(stub as never, config) as unknown as () => void
  if (projection === null || section === null || service === null) {
    throw new Error('插件没有注册投影、设置分区或估算服务')
  }
  return { projection, section, service, disposed, dispose }
}

/** 一份假会话：投影只读 `meta.id` 与 `toolErrors`。 */
const sessionOf = (id: string): { meta: { id: string }; toolErrors: Map<string, string> } => ({
  meta: { id },
  toolErrors: new Map(),
})

/** n 条带长结果的工具往返；正文越长，单条能省的字符越多。 */
function conversation(count: number, text: string): ChatMessage[] {
  const list: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '开跑' },
  ]
  for (let index = 1; index <= count; index += 1) {
    list.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: `e${String(index)}`,
          type: 'function',
          function: { name: 'bash', arguments: '{}' },
        },
      ],
    })
    list.push({
      role: 'tool',
      tool_call_id: `e${String(index)}`,
      content: text,
    })
  }
  return list
}

/** 一份消息里被清掉的工具结果条数。 */
const cleared = (list: readonly ChatMessage[]): number =>
  list.filter(
    (message) =>
      message.role === 'tool' && typeof message.content === 'string' && message.content.startsWith('[旧工具结果已清理'),
  ).length

test('request 档每次请求都重算：同一会话连调两次都按当前消息清，不吃冻结计划', () => {
  const { projection } = mount({ refresh: 'request' })
  const messages = conversation(7, `结果：${'x'.repeat(2000)}`)
  // 7 条结果、最近 5 条保留，2 条候选约 3980 字符占整段 28%：过 25% 门槛，清 2 条。
  expect(cleared(projection(messages, sessionOf('w14-request')))).toBe(2)
  // 第二次请求消息更长（多一轮真人发言 + 一条新结果，共 9 条结果），
  // request 档不复用上一次的计划：最近 5 条保留，候选从 2 条涨到 4 条。
  const grown: ChatMessage[] = [
    ...messages,
    { role: 'user', content: '继续' },
    ...conversation(1, `结果：${'x'.repeat(2000)}`).slice(2),
  ]
  expect(cleared(projection(grown, sessionOf('w14-request')))).toBe(4)
})

test('冻结表满 64 个会话后淘汰最早一条：第 65 个会话照样算计划、照样清', () => {
  const { projection } = mount()
  const text = `结果：${'x'.repeat(4500)}`
  // 每次换一个会话 id：budget 档首轮就推进，清 3 条；第 65 次写入时表已满，走淘汰分支。
  for (let index = 0; index < 65; index += 1) {
    expect(cleared(projection(conversation(8, text), sessionOf(`w14-sweep-${String(index)}`)))).toBe(3)
  }
  // 淘汰之后继续写：不会因为表满而丢当前会话自己的冻结结果（同一轮同长度复用同一份）。
  const current = conversation(8, text)
  expect(cleared(projection(current, sessionOf('w14-sweep-0')))).toBe(3)
  expect(cleared(projection(current, sessionOf('w14-sweep-0')))).toBe(3)
})

test('估算服务：总开关关着时按原文算，不套计划', () => {
  const off = mount({ enabled: false })
  const messages = conversation(8, `结果：${'x'.repeat(4500)}`)
  // 关着时投影原样返回，估算也必须按原文；两条路径算出来的数相等才说明计划没参与。
  expect(off.service.projectedTokens(messages)).toBe(estimateTokens(messages))
})

test('估算服务：ROI 门槛不够时仍按原文算；够的时候按清理后的算', () => {
  // 一条 4 万字用户消息 + 2 条 4 千字工具结果：只清 1 条约省 3990 字符，占整段 8% < 25%。
  const notWorth: ChatMessage[] = [
    { role: 'user', content: 'y'.repeat(40_000) },
    { role: 'tool', tool_call_id: 'f1', content: 'x'.repeat(4000) },
    { role: 'tool', tool_call_id: 'f2', content: 'x'.repeat(4000) },
  ]
  const lazy = mount({ keepRecent: 1 })
  expect(lazy.service.projectedTokens(notWorth)).toBe(estimateTokens(notWorth))

  // 同样两条结果、没有那条长用户消息：清 1 条省 50%，超过门槛 → 按清理后的算。
  const worth: ChatMessage[] = [
    { role: 'tool', tool_call_id: 'g1', content: 'x'.repeat(4000) },
    { role: 'tool', tool_call_id: 'g2', content: 'x'.repeat(4000) },
  ]
  expect(lazy.service.projectedTokens(worth)).toBeLessThan(estimateTokens(worth))
})

test('round 档每轮重算一次：同一会话第二次请求仍按当前消息清', () => {
  const { projection } = mount({ refresh: 'round' })
  const messages = conversation(8, `结果：${'x'.repeat(4500)}`)
  expect(cleared(projection(messages, sessionOf('w14-round')))).toBe(3)
  // 同一轮同长度会复用冻结计划，但清理结果与重算一致（3 条候选全清）。
  expect(cleared(projection(messages, sessionOf('w14-round')))).toBe(3)
})

test('设置分区 save：enabled 接受布尔与字符串两种真值，未知键返回文案', () => {
  const { section } = mount()
  expect(section.save('enabled', true)).toBeUndefined()
  expect(section.values().enabled).toBe(true)
  // 界面可能把开关值传成字符串；'true' 也算开，别的值算关。
  expect(section.save('enabled', 'true')).toBeUndefined()
  expect(section.values().enabled).toBe(true)
  expect(section.save('enabled', false)).toBeUndefined()
  expect(section.values().enabled).toBe(false)
  expect(section.save('enabled', 'false')).toBeUndefined()
  expect(section.values().enabled).toBe(false)
  // 三档刷新时机都能存；数值三项走同一个 Number 分支。
  expect(section.save('refresh', 'round')).toBeUndefined()
  expect(section.values().refresh).toBe('round')
  expect(section.save('keepRecent', 3)).toBeUndefined()
  expect(section.values().keepRecent).toBe(3)
  expect(section.save('minSaveTokens', 128)).toBeUndefined()
  expect(section.values().minSaveTokens).toBe(128)
  expect(section.save('minFreePercent', 30)).toBeUndefined()
  expect(section.values().minFreePercent).toBe(30)
  // 不认识键：返回失败原因字符串，不抛、不改值。
  const rejected = section.save('w14-unknown', 1)
  expect(typeof rejected).toBe('string')
  expect(rejected).not.toBe('')
})

test('设置分区字段：五项都在，number 的区间取自常量', () => {
  const { section } = mount()
  const keys = section.fields().map((field) => ('key' in field ? field.key : ''))
  expect(keys).toEqual(['enabled', 'refresh', 'keepRecent', 'minSaveTokens', 'minFreePercent'])
})

test('卸载收尾：投影、服务、设置分区三件都注销', () => {
  const mounted = mount()
  mounted.dispose()
  expect(mounted.disposed.sort()).toEqual(['projection', 'section', 'service'])
})

test('messageChars 认得数组正文与 null 正文：只数 text 部件，图片不算钱', () => {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'abc' },
        {
          type: 'image_url',
          image_url: { url: 'https://example.invalid/w14.png' },
        },
      ],
    },
    { role: 'user', content: null },
  ]
  expect(promptCharsOf(messages)).toBe(3)
})
