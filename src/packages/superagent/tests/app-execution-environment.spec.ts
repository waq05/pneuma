/**
 * `app/execution-environment.ts` 的补盲：执行根、变量声明、按设置与来源展开的变量表、以及给 worker 的
 * 环境变量说明行。
 *
 * 全部用对象字面量的 `SourceRegistry` 假件（只实现被测函数真用到的 `environments` / `declarations`），
 * 设置走真的 `SettingsSchema.parse`，不建运行期、不碰磁盘。
 *
 * @module dsc/packages/superagent/tests/app-execution-environment
 */
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { EXECUTOR_VARIABLES, declaredVariables, environmentLines, environmentOf, executionRoot, ticketEnvironment }
  from '../app/execution-environment.js'
import type { Deployment } from '../deployment.js'
import type { Settings } from '../core/policy.js'
import { SettingsSchema } from '../core/policy.js'
import type { SourceRegistry } from '../sources/registry.js'
import type { Ticket, Trigger } from '../core/index.js'

/** 一个来源的环境变量声明，形状照 `SourceKind.environment`。 */
const kindOf = (kind: string, variables = [{ key: 'DSH_SUPERAGENT_PR', description: { zh: 'PR 号', en: 'PR number' } }]) => ({
  kind: { kind }, variables,
})

/** 假注册表：`environments` 只回传用例给的实例，`declarations` 只回传已声明变量的 kind。 */
function registryOf(options: {
  environments?: { kind: { kind: string }; environment: { variables: { key: string; description: { zh: string; en: string } }[]; values?: (input: unknown) => Record<string, string> }; config: Record<string, unknown> }[]
  declarations?: { kind: string; variables: { key: string; description: { zh: string; en: string } }[] }[]
} = {}): SourceRegistry {
  const environments = options.environments ?? []
  return {
    environments: () => environments,
    declarations: () => options.declarations ?? environments.map(item => ({ kind: item.kind.kind, variables: item.environment.variables })),
  } as unknown as SourceRegistry
}

const settingsOf = (patch: Record<string, unknown>[] = []): Settings => SettingsSchema.parse(Object.assign({}, ...patch))
const deployment = {} as Deployment

describe('执行根', () => {
  test('settings.executor.directory 有值就用它，空串回落到 stateDir/work', () => {
    expect(executionRoot(settingsOf([{ executor: { directory: '/srv/work' } }]), '/state')).toBe('/srv/work')
    expect(executionRoot(settingsOf(), '/state')).toBe(join('/state', 'work'))
  })
})

describe('declaredVariables', () => {
  test('executor 一组永远启用（含 ticket 专属变量），来源按 configured 后的开关标 enabled', () => {
    const github = kindOf('github')
    const feishu = kindOf('feishu', [])
    const sources = registryOf({ environments: [github, feishu].map(item => ({ kind: item.kind, environment: { variables: item.variables }, config: {} })) })
    const declared = declaredVariables(sources)
    expect(declared[0]).toStrictEqual({ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES })
    expect(declared.map(item => [item.owner, item.enabled])).toStrictEqual([['executor', true], ['github', true], ['feishu', true]])
    // 只声明了变量、没有环境值的 kind 也列出来，但 enabled 看它有没有进 environments。
    const declaredOnly = registryOf({ environments: [], declarations: [{ kind: 'github', variables: github.variables }] })
    expect(declaredVariables(declaredOnly).map(item => [item.owner, item.enabled])).toStrictEqual([['executor', true], ['github', false]])
    // 传 settings 时直接把它交给 environments（这里用一个让 kind 仍启用的空设置验证一路透传）。
    expect(declaredVariables(registryOf({ environments: [github].map(item => ({ kind: item.kind, environment: { variables: item.variables }, config: {} })) }),
      settingsOf()).map(item => item.owner)).toStrictEqual(['executor', 'github'])
  })
})

describe('environmentOf / ticketEnvironment', () => {
  const source = {
    kind: { kind: 'github' },
    environment: {
      variables: [
        { key: 'DSH_SUPERAGENT_PR', description: { zh: 'PR 号', en: 'PR number' } },
        { key: 'DSH_SUPERAGENT_ABSENT', description: { zh: '缺省值', en: 'Absent value' } },
      ],
      values: (input: unknown) => ({ DSH_SUPERAGENT_PR: (input as { trigger?: { id: string } }).trigger ? '7' : 'unset' }),
    },
    config: { repository: 'acme/widget' },
  }

  test('无工单时只给非 ticket 变量；有工单时补目录、名字与工单 id', () => {
    const sources = registryOf({ environments: [source] })
    const values = (variables: ReturnType<typeof environmentOf>) => Object.fromEntries(variables.map(item => [item.key, item.value]))
    const without = environmentOf({ deployment, sources, settings: settingsOf([{ executor: { blockedCommands: ['rm', 'curl'] } }]) })
    expect(values(without)).toStrictEqual({
      DSH_SUPERAGENT_BLOCKED_COMMANDS: 'rm curl',
      DSH_SUPERAGENT_PR: 'unset',
      DSH_SUPERAGENT_ABSENT: '',
    })
    const withTicket = environmentOf({ deployment, sources, settings: settingsOf(),
      ticket: { id: 'ticket-1', name: 'fix-typo', directory: '/work/fix-typo' } })
    expect(values(withTicket)).toMatchObject({
      DSH_SUPERAGENT_DIR: '/work/fix-typo', DSH_SUPERAGENT_NAME: 'fix-typo', DSH_SUPERAGENT_TICKET: 'ticket-1',
    })
    expect(withTicket.map(item => item.owner)).toStrictEqual(['executor', 'executor', 'executor', 'executor', 'github', 'github'])
    // trigger 透传给来源的 values。
    const withTrigger = environmentOf({ deployment, sources, settings: settingsOf(), trigger: { id: 'trigger-1' } as Trigger })
    expect(values(withTrigger).DSH_SUPERAGENT_PR).toBe('7')
  })

  test('ticketEnvironment 读工单的 execution，缺 execution 时三个值都是空串', () => {
    const sources = registryOf()
    const ticket = { id: 'ticket-1', execution: { name: 'fix-typo', directory: '/work/fix-typo', assignment: 'a' } } as Ticket
    const present = Object.fromEntries(ticketEnvironment({ deployment, sources, settings: settingsOf(), ticket }).map(item => [item.key, item.value]))
    expect(present).toStrictEqual({ DSH_SUPERAGENT_BLOCKED_COMMANDS: '', DSH_SUPERAGENT_DIR: '/work/fix-typo',
      DSH_SUPERAGENT_NAME: 'fix-typo', DSH_SUPERAGENT_TICKET: 'ticket-1' })
    const absent = Object.fromEntries(ticketEnvironment({ deployment, sources, settings: settingsOf(), ticket: { id: 'ticket-2' } as Ticket })
      .map(item => [item.key, item.value]))
    expect(absent).toStrictEqual({ DSH_SUPERAGENT_BLOCKED_COMMANDS: '', DSH_SUPERAGENT_DIR: '', DSH_SUPERAGENT_NAME: '',
      DSH_SUPERAGENT_TICKET: 'ticket-2' })
  })

  test('environmentLines 一行一个变量，值用 JSON 引号，描述取英文', () => {
    expect(environmentLines([
      { key: 'A', value: 'x', description: { zh: '甲', en: 'Letter A' }, owner: 'executor' },
      { key: 'B', value: 'has "quote"', description: { zh: '乙', en: 'Letter B' }, owner: 'github' },
    ])).toBe('- A = "x": Letter A.\n- B = "has \\"quote\\"": Letter B.')
    expect(environmentLines([])).toBe('')
  })
})
