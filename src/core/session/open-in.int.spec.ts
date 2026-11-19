/**
 * 「在指定目录里新建会话」的内核集成用例（迁自 `scripts/session-open-in-test.mjs`）。
 *
 * 钉的是与参考实现对齐的那一刀：**目录是会话自己的数据**（写进 jsonl 的 meta 行），
 * 不再是宿主进程的状态——于是「在别的工作区新建会话」只是一次普通调用：不切宿主目录、
 * 不重启宿主、不重载窗口（早先那条路是 switchCwd → 宿主重启 → 整页 loadURL，界面会闪）。
 *
 * ## 迁移时砍掉的东西（原探针的第 [7] 节）
 *
 * 那一节是 22 条**源码文本断言**（`readSource(...).includes('...')`），钉「进程 cwd 不再
 * 当数据用」的几处收口：模型终端、MCP、审批路径基准、外部插件源、LSP。它们没有行为接缝
 * （真起 shell / MCP / LSP 是另一条电池的事），按本批规矩不搬源码文本。已在交接里单列，
 * 需要另开行为用例或留在 check-core 里。
 *
 * ## 隔离
 *
 * `tempHome()` 必须在任何内核模块被加载之前调用：`core/path-policy.ts` 的 `DSC_HOME`
 * 是模块级常量。所以内核模块一律 `await import()`。
 *
 * @module dsc/core/session/open-in.int.spec
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'

/** 临时主目录；必须在任何内核模块被加载之前换好。 */
const home = tempHome()
/** 两个工作区：`WORK` 当起点，`OTHER` 是一个空的新工作区。 */
const WORK = join(home.home, 'ws')
const OTHER = join(home.home, 'ws-b')

/** 内核里本文件用到的服务面：只声明用到的，避免把整个 Context 类型拖进来。 */
interface SessionView {
  meta: { id: string; cwd: string }
  filePath: string
  persisted: boolean
  appendUser(text: string): void
}

interface SnapshotView {
  status: { cwd: string; sessionPath: string }
  sessions: Array<{ id: string; cwd: string; unsaved?: boolean }>
}

interface Services {
  session: { current(): SessionView; open(filePath?: string, cwd?: string): Promise<void>; refresh(): Promise<void> }
  transcript: { getSnapshot(): SnapshotView }
  ui: { newSessionIn(cwd: string): Promise<void>; openSession(filePath?: string): Promise<void> }
}

let kernel: BootedKernel
let fake: FakeLLM
let core: typeof import('@pneuma/runtime/core/session.js')
let uiMethods: typeof import('@pneuma/runtime/core/ui-methods.js')
let services: Services
/** 启动时的三份读数：第一组用例断言「起点是进程目录」，先记下来就不依赖用例顺序。 */
let startup: { metaCwd: string; statusCwd: string; filePath: string }

beforeAll(async () => {
  for (const dir of [WORK, OTHER]) mkdirSync(dir, { recursive: true })
  core = await import('@pneuma/runtime/core/session.js')
  uiMethods = await import('@pneuma/runtime/core/ui-methods.js')
  fake = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
  services = kernel.ctx as unknown as Services
  startup = {
    metaCwd: services.session.current().meta.cwd,
    statusCwd: services.transcript.getSnapshot().status.cwd,
    filePath: services.session.current().filePath,
  }
})

afterAll(async () => {
  await kernel?.dispose()
  await fake?.close()
  home.restore()
})

/** 列表里与某个路径相关的行（新建会话的临时回执也按这个键找）。 */
function rowsOf(filePath: string): Array<{ id: string; cwd: string; unsaved?: boolean }> {
  return services.transcript.getSnapshot().sessions.filter((item) => item.id === filePath)
}

/** 等写流把特征串刷到盘上（新建会话的日志是异步落盘的）。 */
async function waitForText(file: string, needle: string): Promise<void> {
  const deadline = Date.now() + 3_000
  for (;;) {
    if (existsSync(file) && readFileSync(file, 'utf8').includes(needle)) return
    if (Date.now() > deadline) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('① 启动：会话目录来自会话数据，不是进程目录', () => {
  test('启动那条会话的目录 = 进程目录（没有别的依据时，进程目录只是兜底）', () => {
    expect(startup.metaCwd).toBe(process.cwd())
  })

  test('快照的当前目录与 status.sessionPath 跟着会话走', () => {
    expect(startup.statusCwd).toBe(startup.metaCwd)
    expect(services.transcript.getSnapshot().status.sessionPath).toBe(services.session.current().filePath)
  })
})

describe('② newSessionIn：在另一个目录新建，进程目录不动', () => {
  test('会话的 meta.cwd 落在目标目录，jsonl 落在目标目录的 slug 子目录下', async () => {
    await services.ui.newSessionIn(OTHER)
    const current = services.session.current()
    expect(current.meta.cwd).toBe(OTHER)
    expect(current.filePath.startsWith(join(core.sessionsRoot(), core.slugCwd(OTHER)))).toBe(true)
  })

  test('快照的当前目录与 sessionPath 同时跟着变', async () => {
    const before = services.session.current().filePath
    await services.ui.newSessionIn(OTHER)
    const snapshot = services.transcript.getSnapshot()
    expect(snapshot.status.cwd).toBe(OTHER)
    expect(snapshot.status.sessionPath).toBe(services.session.current().filePath)
    // 换的是一条新会话，不是把老的那条原地改目录。
    expect(services.session.current().filePath).not.toBe(before)
  })

  test('宿主进程自己的 cwd 没被动过', async () => {
    const before = process.cwd()
    await services.ui.newSessionIn(OTHER)
    expect(process.cwd()).toBe(before)
  })

  test('没给目录时不悄悄退到进程目录，而是落在你正在看的这条会话的目录里', async () => {
    // 原探针第 [3] 节：先切到 WORK，再「不带目录的新建」，新会话必须还在 WORK。
    await services.ui.newSessionIn(WORK)
    await services.ui.openSession()
    expect(services.session.current().meta.cwd).toBe(WORK)
    expect(services.session.current().meta.cwd).not.toBe(process.cwd())
  })
})

describe('③ 还没落盘的当前会话：列表里有一行临时回执', () => {
  test('刷新后有一行标着 unsaved，磁盘上不建文件', async () => {
    await services.ui.newSessionIn(OTHER)
    const current = services.session.current()
    await services.session.refresh()
    const rows = rowsOf(current.filePath)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.unsaved).toBe(true)
    // 补默认值只是 state 记账，不能顺手在磁盘上建个空壳。
    expect(existsSync(current.filePath)).toBe(false)
    expect(current.meta.cwd).toBe(OTHER)
  })

  test('发第一条消息后文件出现，临时行换成真行且不重复', async () => {
    await services.ui.newSessionIn(OTHER)
    const current = services.session.current()
    current.appendUser('落盘了')
    await waitForText(current.filePath, '"type":"user"')
    expect(existsSync(current.filePath)).toBe(true)

    await services.session.refresh()
    const rows = rowsOf(current.filePath)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.unsaved).not.toBe(true)
    expect(rows[0]?.cwd).toBe(current.meta.cwd)
  })

  test('切到别的会话之后，那行临时回执消失', async () => {
    // 先造一条真落盘的会话当「切过去」的目标。
    await services.ui.newSessionIn(WORK)
    const keep = services.session.current()
    keep.appendUser('保留的会话')
    await waitForText(keep.filePath, '"type":"user"')

    await services.ui.newSessionIn(OTHER)
    const blank = services.session.current()
    await services.session.refresh()
    expect(rowsOf(blank.filePath)).toHaveLength(1)

    await services.ui.openSession(keep.filePath)
    await services.session.refresh()
    expect(rowsOf(blank.filePath)).toHaveLength(0)
  })
})

describe('④ 坏目录：当场抛，且不动当前会话', () => {
  test('不存在的目录 → 抛错，消息说清是哪个目录不可用', async () => {
    const before = services.session.current().filePath
    await expect(services.ui.newSessionIn(join(home.home, '没有这个目录'))).rejects.toThrow(/工作目录不可用/)
    expect(services.session.current().filePath).toBe(before)
  })

  test('相对路径 → 抛错（不悄悄按进程目录解析）', async () => {
    const before = services.session.current().filePath
    await expect(services.ui.newSessionIn('ws-b')).rejects.toThrow(/工作目录不可用/)
    expect(services.session.current().filePath).toBe(before)
  })
})

describe('⑤ 界面通道：白名单 + 实参规格', () => {
  test('newSessionIn 在界面通道白名单里，实参是一个必传字符串', () => {
    expect(uiMethods.UI_METHODS).toContain('newSessionIn')
    expect(uiMethods.UI_ARG_SPECS.newSessionIn).toHaveLength(1)
    expect(uiMethods.UI_ARG_SPECS.newSessionIn?.[0]?.optional).not.toBe(true)
  })

  test('宿主方法清单里也有它（旧桌面版那条通道）', async () => {
    // 原探针这条是源码文本断言（`hostMethods.includes("'newSessionIn',")`）；这里换成
    // 读导出值本身：清单是数据，不是实现细节。
    const hostMethods = await import('@pneuma/runtime/core/host-methods.js')
    expect(hostMethods.INVOKABLE_METHODS).toContain('newSessionIn')
    expect(hostMethods.isInvokableMethod('newSessionIn')).toBe(true)
  })

  test('合法调用过闸，非字符串 / 超长 / 空实参被拒', () => {
    expect(uiMethods.validateUiArgs('newSessionIn', [OTHER]).ok).toBe(true)
    expect(uiMethods.validateUiArgs('newSessionIn', [123]).ok).toBe(false)
    expect(uiMethods.validateUiArgs('newSessionIn', ['x'.repeat(5_000)]).ok).toBe(false)
    expect(uiMethods.validateUiArgs('newSessionIn', []).ok).toBe(false)
  })
})
