/**
 * 外部命令钩子（codex 事件名）的失败方向与配置读迁移（迁自 `scripts/lifecycle-hook-default-test.mjs`）。
 *
 * ## 为什么这条留在 unit、而且不起内核
 *
 * 被测的全是纯函数：一次执行结果 → 一条裁决、条目树 → 一份配置。没有磁盘副作用
 * （除了读 `plugins.json`），没有子进程，没有内核装配。放进 integration 只会让它
 * 为了一个临时 HOME 去起真内核，把 40 条断言拖成几秒钟。
 *
 * ## 钉的是什么
 *
 * 核心只有一句：**钩子没跑成不拦路**，只有明确的退出码 2 才挡工具。
 * 为什么值得单独一条（2026-10-30 用户拍板）：以前默认 `failClosed: true`，脚本有个小毛病
 * （路径写错、超时、非 0 退出）就把所有工具调用一起掐死；而 codex 的语义是
 * 「非 2 的退出码记成 Failed，`should_block` 仍为 false」
 * （`codex-rs/hooks/src/engine/mod.rs` 的 pre_tool_use 用例）。这一节把这些事实钉住：
 *   [1] 缺省配置是「不拦」，显式 true 才拦；
 *   [2] 超时、起不来、退出码非 0、输出看不懂：默认只留一条提示，形态是 `pass` + problem；
 *   [3] 退出码 2（带 stderr 或不带）在任何配置下都拦，理由是 stderr 原文；
 *   [4] 钩子自己写的 `failClosed` 覆盖全局开关（codex 没有这一层，是 dsc 自己的扩展）；
 *   [5] JSON 结论照旧生效（放行 / 拦下 / 要人确认）——失败方向的改动不动它们；
 *   [6] 配置读迁移（0.9.0 合并进 `@pneuma/hooks`）：`hooks` 条目缺的项沿用旧条目
 *       `lifecycle-hooks` 的同名项、旧条目被停用过就按关处理，全程只读、幂等、不删旧条目。
 *
 * ## 临时 HOME 必须在第一次 import 之前
 *
 * `LIFECYCLE_DEFAULTS.configPath` 与插件条目树都从 `DSC_HOME` 派生，而 `path-policy.ts`
 * 的 `DSC_HOME` 是模块顶层常量。所以这里先 `tempHome()`，再用**动态 import** 取模块；
 * 写成静态 import 会先求值模块、把默认路径锁在真实 `~/.dsc` 上（并往那里写插件条目）。
 *
 * @module @pneuma/hooks/lifecycle-hooks.spec
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type { HookRun } from '@pneuma/session-core/hooks.js'
import { tempHome } from '../../../tests/harness.js'

/** 临时主目录：必须先于任何 `DSC_HOME` 派生模块被求值。 */
const home = tempHome('dsc-lifecycle-hooks-')

/** `.dsc` 与条目树文件（`resolveLifecycleConfig` 从这份文件读配置）。 */
const DSC_HOME = join(home.home, '.dsc')
const PLUGINS_JSON = join(DSC_HOME, 'plugins.json')

/** 被测模块：在临时 HOME 就位之后才加载。 */
let hooks: typeof import('./lifecycle-hooks.js')

/** 一条写进条目树的插件条目。 */
interface Entry {
  file: string
  disabled?: boolean
  config?: Record<string, unknown>
}

/**
 * 写一份条目树。
 * @param entries - 条目；`null` = 写一个空文件（「文件在、里面没东西」）
 */
function writeEntries(entries: Entry[] | null): void {
  writeFileSync(PLUGINS_JSON, entries === null ? '' : `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8')
}

/** 一条 PreToolUse 钩子；`failClosed` 不写 = 跟全局开关走。 */
function hook(patch: Partial<import('./lifecycle-hooks.js').LifecycleHook> = {}): import('./lifecycle-hooks.js').LifecycleHook {
  return {
    id: 'PreToolUse#1.1',
    enabled: true,
    event: 'PreToolUse',
    matcher: '*',
    command: 'node guard.js',
    timeoutMs: 5000,
    failClosed: undefined,
    ...patch,
  }
}

/** 一次执行结果；缺省 = 干净退出、什么都没说。 */
function run(patch: Partial<HookRun> = {}): HookRun {
  return { exitCode: 0, stdout: '', stderr: '', ms: 12, timedOut: false, spawnError: '', truncated: false, ...patch }
}

beforeAll(async () => {
  mkdirSync(DSC_HOME, { recursive: true })
  hooks = await import('./lifecycle-hooks.js')
})

beforeEach(() => {
  writeEntries(null)
})

afterAll(home.restore)

describe('① 缺省值与显式开关：默认不拦，写了 true 才拦', () => {
  test('LIFECYCLE_DEFAULTS.failClosed 是 false', () => {
    expect(hooks.LIFECYCLE_DEFAULTS.failClosed).toBe(false)
  })

  test('什么都不配时 failClosed=false（与 codex 一致）', () => {
    expect(hooks.resolveLifecycleConfig({}).failClosed).toBe(false)
  })

  test('什么都不配时默认开着（没有钩子可跑 = 空转）', () => {
    expect(hooks.resolveLifecycleConfig({}).enabled).toBe(true)
  })

  test('显式写 true 才打开', () => {
    expect(hooks.resolveLifecycleConfig({ failClosed: true }).failClosed).toBe(true)
  })

  test('字符串 "true" 也认（手改 plugins.json 会写成串）', () => {
    expect(hooks.resolveLifecycleConfig({ failClosed: 'true' }).failClosed).toBe(true)
  })

  test('字符串 "false" 不会误开', () => {
    expect(hooks.resolveLifecycleConfig({ failClosed: 'false' }).failClosed).toBe(false)
  })
})

describe('② 默认档：没跑成 = 只留提示，不拦工具', () => {
  /** 五种失败形态：每一种都必须落成 `pass` + problem，而不是 block。 */
  const cases: Array<[string, HookRun]> = [
    ['超时被杀', run({ exitCode: -1, timedOut: true, ms: 5000 })],
    ['命令起不来', run({ exitCode: -1, spawnError: 'spawn cmd.exe ENOENT' })],
    ['非 0 退出且没给结论', run({ exitCode: 3, stderr: 'SyntaxError: boom' })],
    ['干净退出但输出看不懂', run({ exitCode: 0, stdout: 'not json' })],
    ['删除脚本后的 ENOENT', run({ exitCode: 1, stderr: "Cannot find module 'D:\\x\\guard.js'" })],
  ]

  test.each(cases)('%s → 不拦（pass + problem 说清原因）', (_label, result) => {
    const judgement = hooks.judgeLifecycleRun(result, hook(), hooks.resolveLifecycleConfig({}))
    expect(judgement.action).toBe('pass')
    expect(judgement.problem ?? '').not.toBe('')
  })
})

describe('③ 退出码 2：任何配置下都拦（这是钩子唯一明确的拒绝信号）', () => {
  test('默认档：退出码 2 + stderr 照样拦，理由是 stderr 原文', () => {
    const judgement = hooks.judgeLifecycleRun(run({ exitCode: 2, stderr: '不许动生产库' }), hook(), hooks.resolveLifecycleConfig({}))
    expect(judgement.action).toBe('block')
    expect(judgement.message).toContain('不许动生产库')
  })

  test('退出码 2 没写原因也拦，理由说清「没给原因」', () => {
    const judgement = hooks.judgeLifecycleRun(run({ exitCode: 2 }), hook(), hooks.resolveLifecycleConfig({}))
    expect(judgement.action).toBe('block')
    expect(judgement.message).toContain('没给原因')
  })

  test('打开 failClosed 后退出码 2 一样拦', () => {
    const judgement = hooks.judgeLifecycleRun(run({ exitCode: 2, stderr: 'x' }), hook(), hooks.resolveLifecycleConfig({ failClosed: true }))
    expect(judgement.action).toBe('block')
  })

  test('退出码 2 且 stdout 有结论时用 JSON 的理由', () => {
    const judgement = hooks.judgeLifecycleRun(
      run({ exitCode: 2, stdout: '{"action":"deny","message":"JSON 里的原因"}' }),
      hook(),
      hooks.resolveLifecycleConfig({}),
    )
    expect(judgement.action).toBe('block')
    expect(judgement.message).toBe('JSON 里的原因')
  })
})

describe('④ 单条钩子覆盖全局：失败方向写到钩子自己头上就听它', () => {
  test('单条写 failClosed: true 时它自己按拦处理（全局关着也拦）', () => {
    const judgement = hooks.judgeLifecycleRun(run({ exitCode: 1 }), hook({ failClosed: true }), hooks.resolveLifecycleConfig({}))
    expect(judgement.action).toBe('block')
  })

  test('单条写 failClosed: false 时全局开着它也不拦', () => {
    const judgement = hooks.judgeLifecycleRun(
      run({ exitCode: 1 }),
      hook({ failClosed: false }),
      hooks.resolveLifecycleConfig({ failClosed: true }),
    )
    expect(judgement.action).toBe('pass')
  })

  test('白名单挡下：默认只提示（action=pass，problem 说清是白名单）', () => {
    const judgement = hooks.judgeBlockedByAllowlist(hook(), hooks.resolveLifecycleConfig({}))
    expect(judgement.action).toBe('pass')
    expect(judgement.problem).toContain('白名单')
  })

  test('白名单挡下：全局开了才拦', () => {
    expect(hooks.judgeBlockedByAllowlist(hook(), hooks.resolveLifecycleConfig({ failClosed: true })).action).toBe('block')
  })
})

describe('⑤ JSON 结论不受失败方向影响', () => {
  test('干净退出的 deny 结论照旧拦，理由取 JSON 里的 message', () => {
    const judgement = hooks.judgeLifecycleRun(
      run({ stdout: '{"action":"deny","message":"规则说不行"}' }),
      hook(),
      hooks.resolveLifecycleConfig({}),
    )
    expect(judgement.action).toBe('block')
    expect(judgement.message).toBe('规则说不行')
  })

  test('ask 结论照旧交给上层（由守卫按「先拒、让模型问人」处理）', () => {
    const judgement = hooks.judgeLifecycleRun(run({ stdout: '{"action":"ask","message":"问一下"}' }), hook(), hooks.resolveLifecycleConfig({}))
    expect(judgement.action).toBe('ask')
  })

  test('pass 结论照旧放行，不塞一条 problem', () => {
    const judgement = hooks.judgeLifecycleRun(run({ stdout: '{"action":"pass"}' }), hook(), hooks.resolveLifecycleConfig({}))
    expect(judgement.action).toBe('pass')
    expect(judgement.problem).toBe('')
  })

  test('退出码 2 与 JSON 都拦时理由取 JSON', () => {
    const judgement = hooks.judgeLifecycleRun(
      run({ exitCode: 2, stdout: '{"action":"block","message":"脚本自己要拦"}' }),
      hook(),
      hooks.resolveLifecycleConfig({}),
    )
    expect(judgement.message).toBe('脚本自己要拦')
  })
})

describe('⑥ 配置读迁移：`hooks` 缺的项沿用旧 `lifecycle-hooks` 条目', () => {
  test('旧条目的 failClosed / timeoutMs / configPath / 白名单都沿用，开关仍默认开', () => {
    writeEntries([
      {
        file: 'lifecycle-hooks',
        disabled: false,
        config: { failClosed: true, timeoutMs: 7000, configPath: 'C:\\me\\lc.json', commandAllowlist: 'node' },
      },
    ])
    const migrated = hooks.resolveLifecycleConfig({})
    expect(migrated.failClosed).toBe(true)
    expect(migrated.timeoutMs).toBe(7000)
    expect(migrated.configPath.endsWith('lc.json')).toBe(true)
    expect(migrated.commandAllowlist).toBe('node')
    // 旧条目没写 enabled、又没被停用过 → 仍默认开
    expect(migrated.enabled).toBe(true)
  })

  test('读一次不写盘：plugins.json 逐字节没变，旧条目还在', () => {
    writeEntries([
      { file: 'lifecycle-hooks', disabled: false, config: { failClosed: true, timeoutMs: 7000, configPath: 'C:\\me\\lc.json', commandAllowlist: 'node' } },
    ])
    const before = readFileSync(PLUGINS_JSON, 'utf8')
    hooks.resolveLifecycleConfig({})
    expect(readFileSync(PLUGINS_JSON, 'utf8')).toBe(before)
  })

  test('再读一次结果一样（幂等：不因为读过一次就把旧条目搬走或删掉）', () => {
    writeEntries([{ file: 'lifecycle-hooks', disabled: false, config: { failClosed: true, timeoutMs: 7000 } }])
    const first = hooks.resolveLifecycleConfig({})
    const second = hooks.resolveLifecycleConfig({})
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect((JSON.parse(readFileSync(PLUGINS_JSON, 'utf8')) as { entries: Entry[] }).entries.some((entry) => entry.file === 'lifecycle-hooks')).toBe(true)
  })

  test('旧条目被停用过 → 外部命令钩子按关处理', () => {
    writeEntries([{ file: 'lifecycle-hooks', disabled: true, config: {} }])
    expect(hooks.resolveLifecycleConfig({}).enabled).toBe(false)
  })

  test('旧条目被停用过，配置里留着 enabled:true 也按关处理（停用标记排在前面）', () => {
    writeEntries([{ file: 'lifecycle-hooks', disabled: true, config: { enabled: true } }])
    expect(hooks.resolveLifecycleConfig({}).enabled).toBe(false)
  })

  test('旧条目配置里显式 enabled:false 也认', () => {
    writeEntries([{ file: 'lifecycle-hooks', disabled: false, config: { enabled: false } }])
    expect(hooks.resolveLifecycleConfig({}).enabled).toBe(false)
  })

  test('旧条目配置里显式 enabled:true 认', () => {
    writeEntries([{ file: 'lifecycle-hooks', disabled: false, config: { enabled: true } }])
    expect(hooks.resolveLifecycleConfig({}).enabled).toBe(true)
  })

  test('新条目写过的值一律优先，空串也算「写过」', () => {
    writeEntries([
      { file: 'hooks', disabled: false, config: { enabled: true, failClosed: false, timeoutMs: 5000, commandAllowlist: '' } },
      { file: 'lifecycle-hooks', disabled: true, config: { failClosed: true, timeoutMs: 9000, commandAllowlist: 'node' } },
    ])
    const merged = hooks.resolveLifecycleConfig({})
    expect(merged.failClosed).toBe(false)
    expect(merged.timeoutMs).toBe(5000)
    expect(merged.commandAllowlist).toBe('')
    // 新条目的 enabled 压过旧条目的停用标记
    expect(merged.enabled).toBe(true)
  })

  test('合并读取之后两份条目都还在（旧条目留给回滚）', () => {
    writeEntries([
      { file: 'hooks', disabled: false, config: { enabled: true } },
      { file: 'lifecycle-hooks', disabled: true, config: { failClosed: true } },
    ])
    hooks.resolveLifecycleConfig({})
    const saved = readFileSync(PLUGINS_JSON, 'utf8')
    expect(saved).toContain('"lifecycle-hooks"')
    expect(saved).toContain('"hooks"')
  })
})
