/**
 * `core/tools/command-runner.ts` 的补测（W14）：执行器链的排序、改写记账、收尾容错与清空。
 *
 * 这条缝本身不 spawn 任何进程（真进程由 bash 工具那侧负责），所以全部用例都是纯同步/异步
 * 调用：注册假的执行器，看 `planCommand` 按 order（同 order 按 id）依次问、谁改写了谁记账，
 * 以及 `finishCommand` 里某个收尾抛错不会污染工具结果。
 *
 * @module dsc/core/tools/w14-command-runner.spec
 */
import { beforeEach, describe, expect, test } from 'vitest'
import {
  commandRunnerIds,
  finishCommand,
  planCommand,
  registerCommandRunner,
  resetCommandRunners,
  type CommandRun,
  type CommandRunner,
  type SpawnPlan,
} from './command-runner.js'

/** 一次待执行命令的事实（信号随便给一个永不过期的）。 */
function makeRun(): CommandRun {
  return {
    command: 'echo hi',
    cwd: process.cwd(),
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  }
}

/** 默认计划（bash 工具原本那一份）。 */
function makeBase(): SpawnPlan {
  return { file: 'bash', args: ['-c', 'echo hi'], env: {}, cwd: process.cwd() }
}

beforeEach(() => {
  resetCommandRunners()
})

describe('执行器链：询问顺序与改写记账', () => {
  test('同 order 按 id 字典序；不同 order 小的先问', () => {
    registerCommandRunner({ id: 'b', order: 10, plan: () => null })
    registerCommandRunner({ id: 'a', order: 10, plan: () => null })
    registerCommandRunner({ id: 'first', order: 5, plan: () => null })
    expect(commandRunnerIds()).toEqual(['first', 'a', 'b'])
  })

  test('改写计划的那位进 changed，返回 null 的不进；异步改写也认', async () => {
    registerCommandRunner({ id: 'skip', order: 1, plan: () => null })
    registerCommandRunner({
      id: 'rewrite',
      order: 2,
      plan: () => Promise.resolve({ ...makeBase(), file: 'docker' }),
    })
    registerCommandRunner({
      id: 'after',
      order: 3,
      plan: (_run, current) => ({ ...current, args: [...current.args, '--x'] }),
    })
    const { plan, changed } = await planCommand(makeRun(), makeBase())
    expect(changed).toEqual(['rewrite', 'after'])
    expect(plan.file).toBe('docker')
    expect(plan.args).toEqual(['-c', 'echo hi', '--x'])
  })

  test('同 id 后注册者顶掉先注册者，退订只删自己那一份', () => {
    const first = registerCommandRunner({
      id: 'same',
      order: 1,
      plan: () => null,
    })
    const second = registerCommandRunner({
      id: 'same',
      order: 1,
      plan: () => null,
    })
    expect(commandRunnerIds()).toEqual(['same'])
    first()
    expect(commandRunnerIds()).toEqual(['same'])
    second()
    expect(commandRunnerIds()).toEqual([])
  })
})

describe('收尾：抛错只吞掉，不影响工具结果', () => {
  test('没 done 的跳过；done 抛错也被吞；不在 changed 里的不问', async () => {
    const seen: string[] = []
    registerCommandRunner({
      id: 'boom',
      order: 1,
      plan: () => null,
      done: () => {
        seen.push('boom')
        throw new Error('清理容器失败')
      },
    })
    registerCommandRunner({ id: 'quiet', order: 2, plan: () => null })
    registerCommandRunner({
      id: 'not-changed',
      order: 3,
      plan: () => null,
      done: () => {
        seen.push('not-changed')
      },
    })
    await expect(finishCommand(makeRun(), makeBase(), ['boom', 'quiet', 'ghost'])).resolves.toBeUndefined()
    expect(seen).toEqual(['boom'])
  })

  test('resetCommandRunners 清空整条链', () => {
    registerCommandRunner({ id: 'x', order: 1, plan: () => null })
    expect(commandRunnerIds()).toHaveLength(1)
    resetCommandRunners()
    expect(commandRunnerIds()).toEqual([])
  })
})

// 显式引用一次类型，保证与实现里的接口同形（运行时不参与）。
const _typecheck: CommandRunner['plan'] | null = null
void _typecheck
