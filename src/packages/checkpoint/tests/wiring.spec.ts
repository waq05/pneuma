/**
 * checkpoint 插件装配面（`packages/checkpoint/index.ts`）：两个回合事件、快照节流与失败旁路、
 * 超限停用、设置分区与 `/checkpoint` 命令。
 *
 * 影子仓库本身（真 git）在 `checkpoint.spec.ts` / `restore.spec.ts` 里测；这里把
 * `./shadow.js` 整包换成固定返回，只钉「插件把哪一刻的哪个动作接到了哪条钩子上」：
 *   - `turn-start` 先自增回合号再拍 pre，`turn-end` 拍 post、记账本、量占用；
 *   - 同一刻只跑一张快照（busy 跳过）、失败只说一次、超限只停一次；
 *   - 设置分区的 fields/values/save 与命令文案的每个分支。
 *
 * `DSC_HOME` 在任何 import 之前指向临时目录：`plugin-registry` 在模块求值时就算定
 * `plugins.json` 的绝对路径。
 *
 * @module @pneuma/checkpoint/tests/wiring.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-checkpoint-wiring-'))
process.env['DSC_HOME'] = HOME
mkdirSync(join(HOME, 'plugins'), { recursive: true })

vi.mock('../shadow.js', () => ({
  bumpTurn: vi.fn(async () => 1),
  currentTurn: vi.fn(() => 3),
  listSnapshots: vi.fn(async () => []),
  recordTurnLedger: vi.fn(async () => 0),
  repoSizeMB: vi.fn(async () => 1.5),
  restoreTurn: vi.fn(async () => ({
    ok: true,
    turn: 3,
    changed: 0,
    written: 0,
    skipped: 0,
    conflicts: [],
    decisions: [],
    available: [],
  })),
  shadowRepoPath: vi.fn((cwd: string) => `shadow-repo:${cwd}`),
  shadowRoot: vi.fn((cwd: string) => `shadow-root:${cwd}`),
  snapshot: vi.fn(async () => ({ ok: true, commit: 'abc', turn: 3 })),
}))

import * as shadow from '../shadow.js'

const mock = vi.mocked(shadow)
const { checkpointPlugin } = await import('../index.js')

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  mock.bumpTurn.mockResolvedValue(1)
  mock.currentTurn.mockReturnValue(3)
  mock.snapshot.mockResolvedValue({ ok: true, commit: 'abc', turn: 3 })
  mock.repoSizeMB.mockResolvedValue(1.5)
  mock.listSnapshots.mockResolvedValue([])
  mock.recordTurnLedger.mockResolvedValue(0)
  mock.restoreTurn.mockResolvedValue(result())
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

/** 等事件回调里那条 `void run()` 跑完（mock 都是即时 resolve 的，冲几次微任务就够）。 */
async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

function result(over: Partial<shadow.RestoreResult> = {}): shadow.RestoreResult {
  return {
    ok: true,
    turn: 3,
    changed: 1,
    written: 1,
    skipped: 0,
    conflicts: [],
    decisions: [],
    available: [],
    ...over,
  }
}

const signal = (sessionId = 'sess-1'): { sessionId: string; sessionPath: string } => ({
  sessionId,
  sessionPath: `sessions/${sessionId}.jsonl`,
})

interface CommandSpec {
  name: string
  args: string
  label: string
  description: string
}

interface SectionSpec {
  id: string
  order: number
  title: string
  fields(): Array<Record<string, unknown>>
  values(): Record<string, unknown>
  save(key: string, value: unknown): string | void
}

interface Harness {
  handlers: Map<string, (...args: never[]) => void>
  commands: Array<{ spec: CommandSpec; run: (payload: { args: string[]; ui: { notice: (text: string) => void } }) => void }>
  sections: SectionSpec[]
  notices: Array<{ text: string; sessionId?: string }>
  debug: string[]
  effects: Array<() => unknown>
  dispose: (() => unknown) | undefined
}

/**
 * 假 ctx 真跑 `apply()`。
 *
 * `cwd === null` 模拟「没有打开的会话」（`session.current()` 抛错）；`passed` 就是
 * 装配时递给插件的第二参数（`resolvePluginConfig` 的最强一档）。
 */
function harness(options: { cwd?: string | null; sessionId?: string; passed?: unknown } = {}): Harness {
  const cwd = options.cwd === undefined ? '/ws/demo' : options.cwd
  const sessionId = options.sessionId ?? 'sess-1'
  const handlers = new Map<string, (...args: never[]) => void>()
  const commands: Harness['commands'] = []
  const sections: SectionSpec[] = []
  const notices: Harness['notices'] = []
  const debug: string[] = []
  const effects: Array<() => unknown> = []

  const ctx = {
    session: {
      current(): { meta: { id: string; cwd: string } } {
        if (cwd === null) throw new Error('没有打开的会话')
        return { meta: { id: sessionId, cwd } }
      },
    },
    logger: {
      debug: (...args: unknown[]): void => {
        debug.push(args.map((item) => String(item)).join(' '))
      },
    },
    transcript: {
      system: (text: string, _kind?: string, _ephemeral?: boolean, owner?: string): void => {
        notices.push(owner === undefined ? { text } : { text, sessionId: owner })
      },
    },
    on: (name: string, handler: (...args: never[]) => void): (() => void) => {
      handlers.set(name, handler)
      return () => undefined
    },
    effect: (factory: () => unknown): (() => void) => {
      const off = factory()
      if (typeof off === 'function') effects.push(off as () => unknown)
      return () => undefined
    },
    commands: {
      register(spec: CommandSpec, run: Harness['commands'][number]['run']): () => void {
        commands.push({ spec, run })
        return () => undefined
      },
    },
    settings: {
      registerSection(section: SectionSpec): () => void {
        sections.push(section)
        return () => undefined
      },
    },
  }

  const dispose = checkpointPlugin.apply?.(ctx as never, options.passed ?? {})
  return {
    handlers,
    commands,
    sections,
    notices,
    debug,
    effects,
    dispose: typeof dispose === 'function' ? (dispose as () => unknown) : undefined,
  }
}

/** 跑一次 `/checkpoint`，返回它写到会话流的文案。 */
async function runCommand(harnessValue: Harness, args: string[]): Promise<string[]> {
  const said: string[] = []
  harnessValue.commands[0]!.run({ args, ui: { notice: (text: string) => said.push(text) } })
  await flush()
  return said
}

/** 落盘那一份 `checkpoint` 的配置。 */
function savedConfig(): Record<string, unknown> {
  const file = join(HOME, 'plugins.json')
  if (!existsSync(file)) return {}
  const doc = JSON.parse(readFileSync(file, 'utf8')) as {
    entries?: Array<{ file?: string; config?: Record<string, unknown> }>
  }
  return doc.entries?.find((entry) => entry.file === 'checkpoint')?.config ?? {}
}

describe('回合钩子', () => {
  test('turn-start：先自增回合号，再按同一个号拍 pre 快照', async () => {
    mock.currentTurn.mockReturnValue(4)
    const value = harness()
    value.handlers.get('dsc/turn-start')!(signal() as never)
    await flush()

    expect(mock.bumpTurn).toHaveBeenCalledWith('/ws/demo')
    // 顺序：bumpTurn 必须在 snapshot 之前（同一个回合的 pre/post 共用一个号）。
    expect(mock.bumpTurn.mock.invocationCallOrder[0]!).toBeLessThan(mock.snapshot.mock.invocationCallOrder[0]!)
    expect(mock.snapshot).toHaveBeenCalledWith('/ws/demo', 'pre', 'turn 4 pre')
    expect(mock.recordTurnLedger).not.toHaveBeenCalled()
    expect(mock.repoSizeMB).not.toHaveBeenCalled()
  })

  test('turn-end：拍 post、记写者账本、量仓库占用', async () => {
    mock.currentTurn.mockReturnValue(4)
    const value = harness()
    value.handlers.get('dsc/turn-end')!('completed' as never, signal() as never)
    await flush()

    expect(mock.bumpTurn).not.toHaveBeenCalled()
    expect(mock.snapshot).toHaveBeenCalledWith('/ws/demo', 'post', 'turn 4 post')
    expect(mock.recordTurnLedger).toHaveBeenCalledWith('/ws/demo', 4)
    expect(mock.repoSizeMB).toHaveBeenCalledWith('/ws/demo')
  })

  test('设置里关掉：两个事件都不拍，也不记错', async () => {
    const value = harness({ passed: { enabled: false } })
    value.handlers.get('dsc/turn-start')!(signal() as never)
    value.handlers.get('dsc/turn-end')!('completed' as never, signal() as never)
    await flush()

    expect(mock.bumpTurn).not.toHaveBeenCalled()
    expect(mock.snapshot).not.toHaveBeenCalled()
    expect(value.notices).toHaveLength(0)
  })

  test('会话对不上 / 读不到当前会话：宁可少一张快照，也不拍错工作区', async () => {
    const mismatch = harness({ sessionId: 'sess-1' })
    mismatch.handlers.get('dsc/turn-start')!(signal('sess-2') as never)
    await flush()
    expect(mock.bumpTurn).not.toHaveBeenCalled()

    const missing = harness({ cwd: null })
    missing.handlers.get('dsc/turn-start')!(signal('sess-1') as never)
    missing.handlers.get('dsc/turn-end')!('completed' as never, signal('sess-1') as never)
    await flush()
    expect(mock.bumpTurn).not.toHaveBeenCalled()
    expect(mock.snapshot).not.toHaveBeenCalled()
  })

  test('快照失败：落 debug + 会话流只说一次（带回合归属）', async () => {
    mock.snapshot.mockResolvedValue({ ok: false, error: '磁盘满了' })
    const value = harness()

    value.handlers.get('dsc/turn-start')!(signal() as never)
    await flush()
    expect(value.debug.some((line) => line.includes('磁盘满了'))).toBe(true)
    expect(value.notices).toHaveLength(1)
    expect(value.notices[0]).toEqual({
      text: '影子快照失败（不影响回合）：磁盘满了',
      sessionId: 'sess-1',
    })

    // 第二个回合再失败：不再刷同一行。
    value.handlers.get('dsc/turn-end')!('completed' as never, signal() as never)
    await flush()
    expect(value.notices).toHaveLength(1)
  })

  test('快照抛异常：异常在事件回调里被收干净，仍然只说一次', async () => {
    mock.snapshot.mockRejectedValue(new Error('git 崩了'))
    const value = harness()

    value.handlers.get('dsc/turn-start')!(signal() as never)
    await flush()
    expect(value.notices[0]?.text).toContain('git 崩了')
    expect(value.debug.some((line) => line.includes('git 崩了'))).toBe(true)
  })

  test('同一刻只跑一张：上一张没完时这次跳过，完了之后继续', async () => {
    let release!: (value: { ok: true; turn: number }) => void
    mock.snapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const value = harness()

    value.handlers.get('dsc/turn-start')!(signal() as never)
    await flush()
    expect(mock.snapshot).toHaveBeenCalledTimes(1)

    // pre 还挂着：这一次直接跳过，并留下能看懂的一行 debug。
    value.handlers.get('dsc/turn-end')!('completed' as never, signal() as never)
    await flush()
    expect(mock.snapshot).toHaveBeenCalledTimes(1)
    expect(value.debug.some((line) => line.includes('上一张快照还在跑'))).toBe(true)

    release({ ok: true, turn: 3 })
    await flush()
    value.handlers.get('dsc/turn-start')!(signal() as never)
    await flush()
    expect(mock.snapshot).toHaveBeenCalledTimes(2)
  })

  test('超过上限：post 之后停用并说一次；调大上限后下一个回合恢复', async () => {
    mock.repoSizeMB.mockResolvedValue(600.04)
    const value = harness()

    value.handlers.get('dsc/turn-end')!('completed' as never, signal() as never)
    await flush()
    expect(value.notices.some((notice) => notice.text.includes('影子快照已停用'))).toBe(true)
    expect(value.notices.some((notice) => notice.text.includes('600.0MB > 512MB'))).toBe(true)

    // 停用之后即使事件再来也不拍（本进程内一直停着）。
    mock.snapshot.mockClear()
    value.handlers.get('dsc/turn-start')!(signal() as never)
    await flush()
    expect(mock.snapshot).not.toHaveBeenCalled()

    // 用户在设置里把上限调大：下一个回合恢复快照。
    value.sections[0]!.save('maxRepoMB', 1024)
    value.handlers.get('dsc/turn-start')!(signal() as never)
    await flush()
    expect(mock.snapshot).toHaveBeenCalledTimes(1)
  })
})

describe('设置分区', () => {
  test('分区坐标与 fields：默认三档，有会话时多一行只读的仓库位置', () => {
    const value = harness()
    const section = value.sections[0]!
    expect(section).toMatchObject({ id: 'checkpoint', order: 39, title: '回合快照' })

    const fields = section.fields()
    expect(fields.map((field) => field['key'] ?? field['type'])).toEqual(['enabled', 'maxRepoMB', 'listLimit', 'info'])
    expect(fields[3]).toMatchObject({
      type: 'info',
      label: '影子仓库位置',
      mono: true,
      copyable: true,
      text: 'shadow-root:/ws/demo',
    })

    const withoutSession = harness({ cwd: null })
    expect(withoutSession.sections[0]!.fields().map((field) => field['type'])).toEqual([
      'switch',
      'number',
      'number',
    ])
  })

  test('values：非法数字回落到默认值，合法数字按口径取整/夹取', () => {
    const fallback = harness({ passed: { maxRepoMB: -1, listLimit: 0 } })
    expect(fallback.sections[0]!.values()).toEqual({ enabled: true, maxRepoMB: 512, listLimit: 20 })

    const parsed = harness({ passed: { maxRepoMB: '64', listLimit: 3.6 } })
    expect(parsed.sections[0]!.values()).toEqual({ enabled: true, maxRepoMB: 64, listLimit: 4 })

    const capped = harness({ passed: { listLimit: 999 } })
    expect(capped.sections[0]!.values()).toMatchObject({ listLimit: 200 })

    const enabledOff = harness({ passed: { enabled: false } })
    expect(enabledOff.sections[0]!.values()).toMatchObject({ enabled: false })
  })

  test('save：开关落盘、非法数字挡回、上限夹到 200、未知键给出键名', () => {
    const value = harness()
    const section = value.sections[0]!

    expect(section.save('enabled', true)).toBeUndefined()
    expect(savedConfig()).toMatchObject({ enabled: true })

    expect(section.save('maxRepoMB', 'abc')).toBe('这里要填一个正数')
    expect(section.save('maxRepoMB', 10.6)).toBeUndefined()
    expect(savedConfig()).toMatchObject({ maxRepoMB: 11 })

    expect(section.save('listLimit', 9999)).toBeUndefined()
    expect(savedConfig()).toMatchObject({ listLimit: 200 })
    expect(section.save('listLimit', 0)).toBe('这里要填一个正数')

    expect(section.save('nope', 1)).toBe('这个分区没有这项：nope')
  })

  test('注册的两个退订函数都交给 effect，apply 返回收尾', () => {
    const value = harness()
    // commands.register 与 settings.registerSection 各被 effect 包了一次。
    expect(value.effects).toHaveLength(2)
    expect(typeof value.dispose).toBe('function')
    expect(value.dispose?.()).toBeUndefined()
  })
})

describe('/checkpoint 命令', () => {
  test('status：开关、仓库路径、回合数与占用；关掉后状态改口', async () => {
    mock.currentTurn.mockReturnValue(7)
    mock.repoSizeMB.mockResolvedValue(12.34)
    const value = harness()

    const status = await runCommand(value, [])
    expect(status[0]).toContain('影子快照：开')
    expect(status[0]).toContain('仓库：shadow-repo:/ws/demo')
    expect(status[0]).toContain('回合数：7｜占用：12.3MB（上限 512MB）')

    value.sections[0]!.save('enabled', false)
    const off = await runCommand(value, ['status'])
    expect(off[0]).toContain('关（设置里已停用）')
  })

  test('list：条数参数优先、坏的参数退回默认值并夹到 200；空列表给人话', async () => {
    mock.listSnapshots.mockResolvedValue([
      { tag: 'dsc/turn-2-post', turn: 2, label: 'post', at: '2026-11-11T08:42:50+08:00', message: '' },
      { tag: 'dsc/turn-2-pre', turn: 2, label: 'pre', at: 'not-a-date', message: '' },
      { tag: 'dsc/manual-restore-20261111-090000', turn: 0, label: 'manual', at: '2026-11-11T09:00:00+08:00', message: '' },
    ])
    const value = harness()

    const listed = await runCommand(value, ['list', '2'])
    expect(mock.listSnapshots).toHaveBeenLastCalledWith('/ws/demo', 2)
    expect(listed[0]).toContain('最近 3 次影子快照（新的在前）：')
    expect(listed[0]).toMatch(/回合 2 · 回合后 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
    expect(listed[0]).toContain('回合 2 · 回合前 · not-a-date')
    expect(listed[0]).toMatch(/还原前 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)

    await runCommand(value, ['list', 'abc'])
    expect(mock.listSnapshots).toHaveBeenLastCalledWith('/ws/demo', 20)
    await runCommand(value, ['list', '999'])
    expect(mock.listSnapshots).toHaveBeenLastCalledWith('/ws/demo', 200)

    mock.listSnapshots.mockResolvedValue([])
    expect((await runCommand(value, ['list']))[0]).toBe('还没有影子快照：下一次回合开始时自动存一份。')
  })

  test('restore：坏参数与各类错误结果都说清「没有动任何文件」', async () => {
    const value = harness()

    expect((await runCommand(value, ['restore']))[0]).toContain('用法：/checkpoint restore <回合号>')
    expect((await runCommand(value, ['restore', '0']))[0]).toContain('用法：/checkpoint restore <回合号>')

    mock.restoreTurn.mockResolvedValue(result({ ok: false, error: 'bad-turn' }))
    expect((await runCommand(value, ['restore', '3']))[0]).toContain('用法：/checkpoint restore <回合号>')

    mock.restoreTurn.mockResolvedValue(result({ ok: false, error: 'missing', available: [] }))
    expect((await runCommand(value, ['restore', '5']))[0]).toContain('没有第 5 个回合的快照。还没有任何回合快照')

    mock.restoreTurn.mockResolvedValue(result({ ok: false, error: 'missing', available: [4, 3] }))
    expect((await runCommand(value, ['restore', '5']))[0]).toContain('最近可用的回合：4、3')

    mock.restoreTurn.mockResolvedValue(result({ ok: false, error: 'missing-post' }))
    expect((await runCommand(value, ['restore', '5']))[0]).toContain('没有回合后快照')

    mock.restoreTurn.mockResolvedValue(result({ ok: false, error: 'safety:写不进' }))
    expect((await runCommand(value, ['restore', '5']))[0]).toBe(
      '还原前的安全快照没存下来，已取消还原（没有动任何文件）：写不进',
    )

    mock.restoreTurn.mockResolvedValue(
      result({ ok: false, error: 'boom', written: 2, safetyTag: 'dsc/manual-restore-20261111-090000' }),
    )
    expect((await runCommand(value, ['restore', '5']))[0]).toContain('已写盘 2 处，还原前的现场在 dsc/manual-restore')

    mock.restoreTurn.mockResolvedValue(result({ ok: false, error: 'boom', written: 0 }))
    expect((await runCommand(value, ['restore', '5']))[0]).toBe('还原失败：boom（没有动任何文件）')
  })

  test('restore：成功路径覆盖「没改动 / 冲突 / 已还原」三种说法', async () => {
    const value = harness()

    mock.restoreTurn.mockResolvedValue(result({ turn: 2, changed: 0 }))
    expect((await runCommand(value, ['restore', '2']))[0]).toBe('第 2 回合模型没有改动文件，不用还原。')

    const conflicts = Array.from({ length: 11 }, (_, index) => `src/f${String(index)}.ts`)
    mock.restoreTurn.mockResolvedValue(
      result({ turn: 2, changed: 11, written: 0, conflicts, safetyTag: 'dsc/manual-restore-20261111-090000' }),
    )
    const conflicted = (await runCommand(value, ['restore', '2']))[0]!
    expect(conflicted).toContain('第 2 回合没有写盘：模型改过 11 处，写回 0 处，跳过 0 处，冲突 11 处。')
    expect(conflicted).toContain('  src/f0.ts')
    expect(conflicted).toContain('……另有 1 条')
    expect(conflicted).toContain('还原前的现场存成了快照 dsc/manual-restore-20261111-090000')

    mock.restoreTurn.mockResolvedValue(result({ turn: 2, changed: 2, written: 2, skipped: 1, safetyTag: undefined }))
    expect((await runCommand(value, ['restore', '2']))[0]).toBe(
      '第 2 回合已还原：模型改过 2 处，写回 2 处，跳过 1 处，冲突 0 处。',
    )
  })

  test('restore 抛异常 / 未知子命令 / 没有会话：命令不崩，给人话', async () => {
    const value = harness()
    mock.restoreTurn.mockRejectedValue(new Error('炸了'))
    expect((await runCommand(value, ['restore', '3']))[0]).toBe('还原失败（没有动任何文件）：炸了')

    expect((await runCommand(value, ['dance']))[0]).toBe(
      '用法：/checkpoint [status] | /checkpoint list [条数] | /checkpoint restore <回合>',
    )

    const noSession = harness({ cwd: null })
    expect((await runCommand(noSession, ['status']))[0]).toBe('没有打开的会话，读不到工作目录。')
  })

  test('命令注册的元信息来自 locale', () => {
    const value = harness()
    expect(value.commands[0]!.spec).toMatchObject({
      name: 'checkpoint',
      args: '[status | list [条数] | restore <回合>]',
      label: '快照',
    })
    expect(value.commands[0]!.spec.description).toContain('restore 把工作区还原到某回合之前')
  })
})
