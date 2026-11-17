/**
 * 「点新会话要看得见一行」的宿主半行为（迁自 `scripts/ui-sessions-unsaved-row-test.mjs`
 * 第 [1][2] 段的宿主与守卫两节）。
 *
 * 报障原话（2026-11-03）：点「新建会话」应该有新会话出现；当时的毛病是侧栏一片安静——
 * 正文其实已经切到空会话了，但列表里什么行都不出现。宿主的应对：`refresh()` 给**当前**
 * 没落盘的会话动态补一行回执（`unsaved: true`），第一条消息落盘后由 `dsc/changed` 的补刷
 * 守卫把它换成扫盘的真行。
 *
 * 为什么是集成用例：补行、只认当前一条、落盘换行三条都长在真内核的会话服务上——要真起
 * 内核、真发一轮消息（假模型）、真等 `dsc/changed` 触发补刷，才看得到这三件事。
 *
 * 不迁的部分（原探针第 [3]–[5] 段，见交付报告缺口清单）：界面半的只读回执约束（不弹
 * 菜单 / 不给归档 / 不给改名 / 不参与拖拽）、点名新建时展开工作区、乐观高亮——全是
 * ui-sessions 渲染接线的文本钉，归组件渲染批。
 *
 * @module dsc/tests/integration/session-unsaved-row.int.spec
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../harness.js'
import { createTempDir } from '../support/tmp-dir.js'

/** 会话列表里的一行（只声明本文件用到的成员）。 */
interface SummaryRow {
  id: string
  cwd: string
  createdAt: number
  updatedAt: number
  title?: string
  unsaved?: boolean
}

/** 会话服务面（窄化；`sessions` 是 refresh() 填的缓存）。 */
interface SessionSurface {
  current(): { filePath: string }
  readonly sessions: SummaryRow[]
  refresh(): Promise<void>
  open(filePath?: string, cwd?: string): Promise<void>
}

let fake: FakeLLM
let kernel: BootedKernel
let session: SessionSurface

beforeAll(async () => {
  fake = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
  session = (kernel.ctx as unknown as { session: SessionSurface }).session
})

afterAll(async () => {
  await kernel.dispose()
})

describe('点新会话要看得见一行', () => {
  test('刚起的内核：当前会话没落盘，refresh 后列表第一行就是它的回执（unsaved）', async () => {
    await session.refresh()
    const current = session.current().filePath
    expect(session.sessions[0]?.id).toBe(current)
    expect(session.sessions[0]?.unsaved).toBe(true)
  })

  test('第一条消息落盘后：下一次 dsc/changed 让补刷守卫把临时行换成扫盘的真行', async () => {
    await kernel.runTurn('你好')
    // 守卫由 dsc/changed 触发（真界面上 git 监听 / todo / hooks 都会发；极简文本一轮没有
    // 自然发射点），这里补发一次等价事件——守卫看到「文件已在」就该补刷。
    ;(kernel.ctx as unknown as { emit(event: 'dsc/changed'): void }).emit('dsc/changed')
    const current = session.current().filePath
    // 补刷是异步的：轮询到「这一行不再带 unsaved」为止，不 sleep。
    await expect
      .poll(() => session.sessions.some((item) => item.id === current && item.unsaved !== true), {
        timeout: 10_000,
      })
      .toBe(true)
    expect(session.sessions.some((item) => item.unsaved === true)).toBe(false)
  })

  test('再点一次新会话：回执只补当前这一条，已落盘的那行不受影响', async () => {
    const previous = session.current().filePath
    // 开一个新工作区，给新会话一个合法目录：系统临时根下、`dsc-` 前缀，由统一清理认领。
    // 工作区只当 cwd 用、不依赖 HOME 位置。
    const workspace = createTempDir('dsc-unsaved-ws-')
    await session.open(undefined, workspace)
    await session.refresh()
    const current = session.current().filePath
    expect(current).not.toBe(previous)
    // 回执在列表第一位，且全部行里只有这一条带 unsaved。
    expect(session.sessions[0]?.id).toBe(current)
    expect(session.sessions[0]?.unsaved).toBe(true)
    expect(session.sessions.filter((item) => item.unsaved === true)).toHaveLength(1)
    // 上一条会话已落盘：行还在，但不带 unsaved（按 filePath 去重，不再补第二行）。
    const oldRow = session.sessions.find((item) => item.id === previous)
    expect(oldRow).toBeDefined()
    expect(oldRow?.unsaved).toBeUndefined()
  })

  test('回执行的工作区与新建时指的目录一致（目录跟着会话走）', async () => {
    // 同上：原前缀 `unsaved-ws-` 不在 `dsc-` 白名单里，改走 createTempDir 建在临时根顶层。
    const workspace = createTempDir('dsc-unsaved-ws-')
    await session.open(undefined, workspace)
    await session.refresh()
    expect(session.sessions[0]?.cwd).toBe(workspace)
  })
})
