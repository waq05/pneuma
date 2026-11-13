/**
 * 「新会话没发消息就不留文件、不进列表」（迁自 `scripts/empty-session-test.mjs`）。
 *
 * ## 事故形状
 *
 * 点一下「新会话」，权限与模型插件立刻往会话状态里补默认值，每条 `state` 都经写流建出
 * jsonl——磁盘上多一个零消息文件，侧栏列表也跟着多一行。用户机器上已经攒了一堆这种垃圾行。
 *
 * ## 断言分五层
 *
 *   [1] 新建会话：id / 路径当场就有，磁盘上没有文件，列表里也没有它；
 *   [2] 第一条用户消息落地：meta → 攒下的 state → user 按序一次写出；权限、模型默认值
 *       确实进了文件，并能被重放恢复；
 *   [3] 记账缓冲严格保序（同一 id 多条 state 按产生顺序、后者生效）；
 *   [4] 发消息前选过的权限与模型：不建文件，但首条消息落地时一并写进日志；
 *   [5] 零消息 / 只有 meta + state 的历史文件不进列表；说过话的照常露脸（含 T31 头行损坏）。
 *
 * ## 隔离
 *
 * harness 的 `tempHome` + 临时工作区，真实 `~/.dsc` 一个字节都不动。会话模块一律
 * `await import()`：`core/path-policy.ts` 的 `DSC_HOME` 是模块级常量，静态 import 会把它
 * 按加载前的 HOME 算死。
 *
 * @module dsc/core/session/empty-session.int.spec
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'

/** 临时主目录；必须在任何内核模块被加载之前换好（`DSC_HOME` 是模块级常量）。 */
const home = tempHome('dsc-empty-session-')
/** 第一个工作区（也是启动会话的目录）。 */
const WORK = join(home.home, 'ws')
/** 第二个工作区：用来验「发消息前先选权限与模型」。 */
const WORK2 = join(home.home, 'ws-2')

type SessionModule = typeof import('../../core/session.js')
type SessionInstance = ReturnType<SessionModule['Session']['create']>

/** 一条会话状态记录（jsonl 里 `type: 'state'` 的行）。 */
interface StateRecord {
  type?: string
  id?: string
  payload?: Record<string, unknown>
}

/** 内核里本文件用到的服务面：只声明用到的成员。 */
interface SessionView {
  meta: { id: string; cwd: string }
  filePath: string
  state(id: string): Record<string, unknown> | undefined
  appendUser(text: string): void
  appendState(id: string, value: Record<string, unknown>): void
}

interface Services {
  session: { current(): SessionView; open(filePath?: string, cwd?: string): Promise<void> }
  transcript: { getSnapshot(): { sessions: Array<{ id: string; cwd: string }> } }
  permissionPresets: { use(preset: string): void }
  llm: { setModel(provider: string, model: string): void }
  emit(event: string): void
}

let llm: FakeLLM
let kernel: BootedKernel
let services: Services
let core: SessionModule
/** 启动时那条会话（后面几节拿它当「说过话的会话」）。 */
let startup: SessionView

beforeAll(async () => {
  for (const dir of [WORK, WORK2]) mkdirSync(dir, { recursive: true })
  core = await import('../../core/session.js')
  llm = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({
    providerBaseUrl: llm.baseUrl,
    config: {
      providers: {
        test: {
          name: 'test',
          displayName: 'Test',
          baseUrl: llm.baseUrl,
          apiKey: 'k',
          models: [
            { id: 'm1', name: 'm1', contextWindow: 100_000, maxTokens: 500, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} },
            { id: 'm2', name: 'm2', contextWindow: 100_000, maxTokens: 500, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} },
          ],
        },
      },
      defaultProvider: 'test',
      defaultModel: 'm1',
    },
  })
  services = kernel.ctx as unknown as Services
  // 启动会话（宿主 cwd）也是新建会话：补默认值同样只该留在内存里。
  await services.session.open(undefined, WORK)
  startup = services.session.current()
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
  home.restore()
})

/** 递归收集一个目录下所有 jsonl（验「磁盘上一个文件都没有」）。 */
function jsonlFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...jsonlFiles(path))
    else if (entry.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

/** 等文件里真的出现某段文本（写流是异步的，`existsSync` 会先真后假）。 */
async function waitForText(file: string, needle: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(file) && readFileSync(file, 'utf8').includes(needle)) return true
    if (Date.now() > deadline) return false
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

/** 读一份 jsonl 成对象数组；坏行丢掉（进程被杀时最后一行只写半截是正常事故形态）。 */
function readRecords(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}

/** 一条会话的单行记录（造历史文件用）。 */
function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

describe('① 新建会话：身份当场就有，文件与列表都不该出现', () => {
  test('会话 id 在 create 时就生成', () => {
    expect(typeof startup.meta.id).toBe('string')
    expect(startup.meta.id.length).toBeGreaterThan(0)
  })

  test('jsonl 路径也当场定下（文件名就是 id）', () => {
    expect(startup.filePath.endsWith(`${startup.meta.id}.jsonl`)).toBe(true)
  })

  test('磁盘上没有这条会话的文件', () => {
    expect(existsSync(startup.filePath)).toBe(false)
  })

  test('整个会话根目录下没有任何 jsonl', () => {
    expect(jsonlFiles(core.sessionsRoot())).toEqual([])
  })

  test('列表里没有它，而且是空的（启动会话也没落盘）', () => {
    const listed = core.listSessions()
    expect(listed.every((item) => item.id !== startup.meta.id)).toBe(true)
    expect(listed).toHaveLength(0)
  })

  test('内存里已经拿到权限默认值（只是没写盘）', () => {
    // 默认值该补进内存：界面要立刻能显示「当前是哪个档」，落盘则等第一条消息。
    expect(startup.state('permissions')?.['policy']).toBeDefined()
  })

  test('内存里已经拿到模型默认值 m1', () => {
    expect(startup.state('model')?.['model']).toBe('m1')
  })
})

describe('② 第一条用户消息落地：meta → 攒下的 state → user 按序写出', () => {
  /** 首条消息落盘后的记录。 */
  let records: Array<Record<string, unknown>>

  test('用户消息确实让它出现了', async () => {
    startup.appendUser('第一句话')
    expect(await waitForText(startup.filePath, '"type":"user"')).toBe(true)
  })

  test('首行是 meta，末行是 user，用户消息只有一条', async () => {
    await waitForText(startup.filePath, '"type":"user"')
    records = readRecords(startup.filePath)
    expect(records[0]?.['type']).toBe('meta')
    expect(records.at(-1)?.['type']).toBe('user')
    expect(records.filter((record) => record['type'] === 'user')).toHaveLength(1)
  })

  test('攒下的 state 不止一条（权限 + 模型），且全在 user 之前', () => {
    const stateRecords = records.filter((record) => record['type'] === 'state')
    expect(stateRecords.length).toBeGreaterThanOrEqual(2)
    const firstState = records.findIndex((record) => record['type'] === 'state')
    expect(firstState).toBeGreaterThan(0)
    for (const [index, record] of records.entries()) {
      if (record['type'] === 'state') expect(index).toBeLessThan(records.length - 1)
    }
  })

  test('权限默认值进了文件：模式与审阅者都有值', () => {
    // 沙箱档位按需在首次读取时钉，这里不强求。
    const permissions = records.filter((record) => record['type'] === 'state' && record['id'] === 'permissions').at(-1)
    const payload = (permissions as StateRecord | undefined)?.payload
    expect(typeof payload?.['policy']).toBe('string')
    expect(typeof payload?.['reviewer']).toBe('string')
  })

  test('模型默认值进了文件，就是配置里的 m1', () => {
    const modelState = records.find((record) => record['type'] === 'state' && record['id'] === 'model')
    expect((modelState as StateRecord | undefined)?.payload?.['model']).toBe('m1')
  })

  test('重放之后模型状态还是 m1、权限状态还在、首条消息还在', () => {
    const restored = core.Session.load(startup.filePath, true, { lease: false })
    try {
      expect(restored.state('model')?.['model']).toBe('m1')
      expect(restored.state('permissions')?.['policy']).toBeDefined()
      expect(restored.messages).toHaveLength(1)
    } finally {
      restored.close()
    }
  })
})

describe('③ 记账缓冲严格保序：多次 state 按产生顺序排在 user 之前', () => {
  /** 另一条独立会话（直接 `Session.create`，不走内核）。 */
  const path = join(home.home, 'order', 'order.jsonl')
  let session: SessionInstance

  test('攒着的时候磁盘上还是没有文件', () => {
    session = core.Session.create(WORK, path)
    session.appendState('model', { provider: 'test', model: 'm1', effort: 'default' })
    session.appendState('permissions', { sandbox: 'workspace-write', policy: 'auto-edit', reviewer: 'user' })
    session.appendState('model', { provider: 'test', model: 'm1', effort: 'high' })
    expect(existsSync(path)).toBe(false)
  })

  test('首条用户消息把它一次写出来，记录条数 = meta + 3 条 state + user', async () => {
    session.appendUser('按序落盘')
    expect(await waitForText(path, '"type":"user"')).toBe(true)
    const records = readRecords(path)
    expect(records).toHaveLength(5)
    expect(records[0]?.['type']).toBe('meta')
    expect(records[4]?.['type']).toBe('user')
  })

  test('第 2..4 条 state 保持产生顺序（model / permissions / model）', () => {
    const records = readRecords(path)
    expect(records.slice(1, 4).map((record) => record['id'])).toEqual(['model', 'permissions', 'model'])
  })

  test('同名 state 后者生效（重放读到 high）', () => {
    const restored = core.Session.load(path, true, { lease: false })
    try {
      expect(restored.state('model')?.['effort']).toBe('high')
    } finally {
      restored.close()
    }
  })
})

describe('④ 发消息前选过的权限与模型：不建文件，但首条消息落地时一并写进日志', () => {
  let picked: SessionView

  test('选完权限与模型后磁盘上仍然没有文件', async () => {
    await services.session.open(undefined, WORK2)
    picked = services.session.current()
    // 为什么选 `auto-review` 而不是探针里的 `read-only`：harness 默认停用沙箱插件（台账 D16），
    // 预设里「沙箱档位」那一半落不了地；`read-only` 另一半分（policy）又与默认值相同，
    // 于是切过去在会话状态上一个字节都不变，断言就失去了对象。`auto-review` 换的是
    // 审阅者（user → auto-review）与策略（auto-edit → full-access），两样都能观察。
    services.permissionPresets.use('auto-review')
    services.llm.setModel('test', 'm2')
    expect(existsSync(picked.filePath)).toBe(false)
  })

  test('内存里审阅者已是 auto-review、模型已是 m2', () => {
    expect(picked.state('permissions')?.['reviewer']).toBe('auto-review')
    expect(picked.state('model')?.['model']).toBe('m2')
  })

  test('首条消息让文件出现，选过的权限与模型都进了日志，user 仍在最后', async () => {
    picked.appendUser('选完再发')
    expect(await waitForText(picked.filePath, '"type":"user"')).toBe(true)
    const records = readRecords(picked.filePath)
    const permissions = records.filter((record) => record['type'] === 'state' && record['id'] === 'permissions').at(-1)
    const model = records.filter((record) => record['type'] === 'state' && record['id'] === 'model').at(-1)
    expect((permissions as StateRecord | undefined)?.payload?.['reviewer']).toBe('auto-review')
    expect((model as StateRecord | undefined)?.payload?.['model']).toBe('m2')
    expect(records.at(-1)?.['type']).toBe('user')
  })

  test('重放恢复选过的权限与模型', () => {
    const restored = core.Session.load(picked.filePath, true, { lease: false })
    try {
      expect(restored.state('permissions')?.['reviewer']).toBe('auto-review')
      expect(restored.state('model')?.['model']).toBe('m2')
    } finally {
      restored.close()
    }
  })
})

describe('⑤ 零消息 / 只有 meta + state 的历史文件不进列表', () => {
  /** 会话根目录下与 WORK 对应的那一层。 */
  function dirOf(): string {
    return join(core.sessionsRoot(), core.slugCwd(WORK))
  }

  test('只有 meta 的文件不在列表里', () => {
    const dir = dirOf()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, '00000000-0000-0000-0000-000000000001.jsonl')
    writeFileSync(path, line({ type: 'meta', id: '00000000-0000-0000-0000-000000000001', cwd: WORK, createdAt: 1 }), 'utf8')
    expect(core.listSessions().every((item) => item.path !== path)).toBe(true)
  })

  test('只有 meta + state 的文件不在列表里（存量垃圾行）', () => {
    // 老版本已经在用户机器上留下这种文件：读侧要按同一口径挡掉，否则清不掉。
    const dir = dirOf()
    const id = '00000000-0000-0000-0000-000000000002'
    const path = join(dir, `${id}.jsonl`)
    writeFileSync(
      path,
      line({ type: 'meta', id, cwd: WORK, createdAt: 1 }) +
        line({ type: 'state', id: 'model', payload: { provider: 'test', model: 'm1', effort: 'default' } }),
      'utf8',
    )
    expect(core.listSessions().every((item) => item.path !== path)).toBe(true)
  })
})

describe('⑥ 真说过话的文件照常出现（含 T31 头行损坏）', () => {
  /** 会话根目录下与 WORK 对应的那一层。 */
  function dirOf(): string {
    return join(core.sessionsRoot(), core.slugCwd(WORK))
  }

  test('有 user 记录的文件出现在列表里，标题取首条用户消息', () => {
    const dir = dirOf()
    const id = '00000000-0000-0000-0000-000000000003'
    const path = join(dir, `${id}.jsonl`)
    writeFileSync(
      path,
      line({ type: 'meta', id, cwd: WORK, createdAt: 1 }) + line({ type: 'user', text: '有用户消息的会话' }),
      'utf8',
    )
    const item = core.listSessions().find((entry) => entry.path === path)
    expect(item).toBeDefined()
    expect(item?.title).toBe('有用户消息的会话')
  })

  test('有 assistant 记录的文件也出现在列表里', () => {
    const dir = dirOf()
    const id = '00000000-0000-0000-0000-000000000004'
    const path = join(dir, `${id}.jsonl`)
    writeFileSync(
      path,
      line({ type: 'meta', id, cwd: WORK, createdAt: 1 }) + line({ type: 'assistant', text: '先说话的是助手', reasoning: '' }),
      'utf8',
    )
    expect(core.listSessions().some((item) => item.path === path)).toBe(true)
  })

  test('头行损坏但有 user 文本的文件仍露脸（T31），id 取文件名、标题从 user 里救', () => {
    // 零消息过滤不能把「头坏了但真说过话」的会话一起误伤——那是用户的消息，不是垃圾。
    const dir = dirOf()
    const id = '00000000-0000-0000-0000-000000000005'
    const path = join(dir, `${id}.jsonl`)
    writeFileSync(path, `{"type":"meta",\n` + line({ type: 'user', text: '头坏了也要露脸' }), 'utf8')
    const item = core.listSessions().find((entry) => entry.path === path)
    expect(item).toBeDefined()
    expect(item?.id).toBe(id)
    expect(item?.title).toBe('头坏了也要露脸')
  })

  test('头坏且只剩 state 的文件不进列表', () => {
    const dir = dirOf()
    const id = '00000000-0000-0000-0000-000000000006'
    const path = join(dir, `${id}.jsonl`)
    writeFileSync(
      path,
      `{"type":"meta",\n` + line({ type: 'state', id: 'model', payload: { provider: 'test', model: 'm1' } }),
      'utf8',
    )
    expect(core.listSessions().every((item) => item.path !== path)).toBe(true)
  })
})

describe('⑦ 说过话之后，一次 dsc/changed 就把它补进列表快照（且只补一次）', () => {
  /** 列表快照里与当前会话相关的行。 */
  function rows(): Array<{ id: string }> {
    return services.transcript.getSnapshot().sessions.filter((item) => item.id === startup.filePath)
  }

  test('说过话的会话在列表快照里', async () => {
    // 新会话不再补虚拟行，于是「文件刚出现」与「列表下一次重扫」之间有一段空窗；
    // 宿主在 dsc/changed 里看到「当前会话的文件在了、缓存里却没有」时自己补刷一次。
    services.emit('dsc/changed')
    await new Promise((resolveTick) => setTimeout(resolveTick, 200))
    expect(rows()).toHaveLength(1)
  })

  test('再广播一次也不会补成两条', async () => {
    // 补刷的闸门只认「同一条路径一次」：重复广播既不该补成两条，也不该来回刷。
    services.emit('dsc/changed')
    await new Promise((resolveTick) => setTimeout(resolveTick, 100))
    expect(rows()).toHaveLength(1)
  })
})
