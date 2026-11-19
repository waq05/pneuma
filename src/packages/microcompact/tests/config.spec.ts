/**
 * microcompact 的「清理时机」三档与设置分区：默认值、选项、存盘校验、以及 round/budget 的
 * 实际差别。纯函数（保留窗口、计划、推进判定）在 microcompact.spec.ts 里钉，这里钉的是
 * 插件策略与配置面——两者分开，改注释/文案不会牵动行为断言。
 *
 * 环境隔离：`resolvePluginConfig` / `writePluginConfig` 读的是 `DSC_HOME` 下的
 * `plugins.json`，所以先把 `DSC_HOME` 指到 `mkdtempSync` 的临时目录、再动态 import 插件；
 * 真实 `~/.dsc` 一个字节都不碰。
 *
 * @module @pneuma/microcompact/tests/config.spec
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsField, SettingsValues } from '@pneuma/runtime/contract.js'
import type { SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import { afterAll, expect, test } from 'vitest'

/** 本包的界面字典：文案断言用它，键名写歪会红。 */
const zh = JSON.parse(readFileSync(new URL('../locale/ui.zh.json', import.meta.url), 'utf8')) as Record<string, string>
const en = JSON.parse(readFileSync(new URL('../locale/ui.en.json', import.meta.url), 'utf8')) as Record<string, string>

/** 临时主目录；模块级常量 `DSC_HOME` 要在 import 运行时之前换好。 */
const home = mkdtempSync(join(tmpdir(), 'dsc-microcompact-config-'))
const originalHome = process.env.DSC_HOME
process.env.DSC_HOME = home

const { microcompactPlugin } = await import('../index.js')

afterAll(() => {
  if (originalHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

/** 投影签名（本文件只用到前两个参数）。 */
type Projection = (messages: ChatMessage[], session: unknown) => ChatMessage[]

/**
 * 测试用的分区窄接口：内核的 `SettingsSectionSpec` 允许 `values`/`save` 返回 Promise、
 * 也允许不实现；本插件是同步实现，测试里按同步形状断言，省掉一堆可能为空的判断。
 */
interface TestSection {
  subtitle: string
  fields(): SettingsField[]
  values(): SettingsValues
  save(key: string, value: unknown): string | void
}

/** mount 出来的三件东西。 */
interface Mounted {
  projection: Projection
  section: TestSection
}

/**
 * 装一次插件，拿回投影与设置分区。桩 ctx 只提供 apply 用到的面。
 * @param config - 装配时递给插件的第二参数（`resolvePluginConfig` 的最强一档）。
 */
function mount(config: Record<string, unknown> = {}): Mounted {
  let projection: Projection | null = null
  let section: TestSection | null = null
  const stub = {
    prompt: {
      registerProjection: (_id: string, fn: Projection) => {
        projection = fn
        return () => {}
      },
    },
    settings: {
      registerSection: (spec: SettingsSectionSpec) => {
        section = spec as unknown as TestSection
        return () => {}
      },
    },
    session: {
      current: () => {
        throw new Error('测试里应显式传会话')
      },
    },
    provide: () => () => {},
    // 插件用 ctx.effect 注册（停用即注销）；桩 ctx 跟着 cordis 的语义跑一遍回调。
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
  }
  microcompactPlugin.apply(stub as never, config)
  if (projection === null || section === null) throw new Error('插件没有注册投影或设置分区')
  return { projection, section }
}

/** 一份假会话：投影只读 `meta.id` 与 `toolErrors`。 */
const sessionOf = (id: string): { meta: { id: string }; toolErrors: Map<string, string> } => ({ meta: { id }, toolErrors: new Map() })

/** n 条带长结果的工具往返；正文越长，单条能省的字符越多。 */
function conversation(count: number, text: string): ChatMessage[] {
  const list: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: '开跑' }]
  for (let index = 1; index <= count; index += 1) {
    list.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `h${String(index)}`, type: 'function', function: { name: 'bash', arguments: '{}' } }],
    })
    list.push({ role: 'tool', tool_call_id: `h${String(index)}`, content: text })
  }
  return list
}

/** 一份消息里被清掉的工具结果条数。 */
const cleared = (list: readonly ChatMessage[]): number =>
  list.filter((message) => message.role === 'tool' && typeof message.content === 'string' && message.content.startsWith('[旧工具结果已清理')).length

/** 设置分区里的 select 控件。 */
const refreshField = (section: TestSection): Extract<SettingsField, { type: 'select' }> => {
  const field = section.fields().find((item) => item.type === 'select' && item.key === 'refresh')
  if (field === undefined || field.type !== 'select') throw new Error('设置分区缺 refresh 下拉框')
  return field
}

test('默认清理时机是 budget，下拉框三档、文案取自 locale，中英字典键一致', () => {
  const { section } = mount()
  const values: SettingsValues = section.values()
  expect(values.refresh).toBe('budget')
  const field = refreshField(section)
  expect(field.options.map((option) => option.value)).toEqual(['budget', 'round', 'request'])
  expect(field.options.map((option) => option.label)).toEqual([
    zh['field.refresh.option.budget'],
    zh['field.refresh.option.round'],
    zh['field.refresh.option.request'],
  ])
  // 标题与帮助同样走字典：字典缺键时 hostT 会退回键名，这里一并钉住。
  expect(section.subtitle).toBe(zh['section.subtitle'])
  expect(field.help).toBe(zh['field.refresh.help'])
  expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
})

test('配置写歪了回落默认 budget；合法值照用', () => {
  expect(mount({ refresh: 'nonsense' }).section.values().refresh).toBe('budget')
  expect(mount({ refresh: 'round' }).section.values().refresh).toBe('round')
  expect(mount({ refresh: 'request' }).section.values().refresh).toBe('request')
})

test('save 接受三档，非法值返回文案且不改当前值', () => {
  const { section } = mount()
  expect(section.save('refresh', 'round')).toBeUndefined()
  expect(section.values().refresh).toBe('round')
  expect(section.save('refresh', 'request')).toBeUndefined()
  expect(section.values().refresh).toBe('request')
  expect(section.save('refresh', 'budget')).toBeUndefined()
  expect(section.values().refresh).toBe('budget')
  const rejected = section.save('refresh', 'weekly')
  expect(typeof rejected).toBe('string')
  expect(section.values().refresh).toBe('budget')
})

test('round 档每轮立即清；budget 档攒不够 8192 字符时一条都不清', () => {
  // 2000 字符 × 2 条候选 ≈ 3980 字符：过了 25% 的 ROI 门槛，但没到 budget 的推进预算。
  const text = `结果：${'x'.repeat(2000)}`
  const budget = mount()
  expect(cleared(budget.projection(conversation(7, text), sessionOf('probe-budget')))).toBe(0)

  // 同一份历史换成旧档 round：每轮重算一次，门槛过了就清。
  budget.section.save('refresh', 'round')
  const round = mount()
  expect(cleared(round.projection(conversation(7, text), sessionOf('probe-round')))).toBe(2)
  round.section.save('refresh', 'budget')
})

test('budget 档：攒够阈值推进一次；同一轮冻结；跨轮新增不够再推进就不动', () => {
  const text = `结果：${'x'.repeat(4500)}`
  const { projection } = mount()
  const session = sessionOf('probe-budget-rounds')
  // 8 条结果里有 3 条候选，约 1.3 万字符 ≥ 8192：第一次推进，清 3 条。
  const first = conversation(8, text)
  expect(cleared(projection(first, session))).toBe(3)
  // 同一轮里又来了一个新结果：冻结的计划不动，仍只清那 3 条。
  const sameRound: ChatMessage[] = [
    ...first,
    { role: 'assistant', content: '', tool_calls: [{ id: 'h9', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'h9', content: text },
  ]
  expect(cleared(projection(sameRound, session))).toBe(3)
  // 换一轮后再来 1 条：新增 1 条不够 8192，不推进，仍只清那 3 条。
  const nextRound: ChatMessage[] = [
    ...first,
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'h9', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'h9', content: text },
  ]
  expect(cleared(projection(nextRound, session))).toBe(3)
})
