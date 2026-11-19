/**
 * 转录归属的隔离用例（迁自 `scripts/session-transcript-isolation-test.mjs`）。
 *
 * 现场是「A 会话在跑 PTC，用户切到新建的 B，A 的『查找文件』卡片落在 B 的空白页上」。
 * 只看代码看不出这个事故：要真起内核、真开两个会话、真往转录里写一条带归属的事件，
 * 再看当前快照里有没有它。所以这组用例留在 integration 层，而不是拿假 ctx 测过滤函数。
 *
 * 归属口径是「会话 id（uuid）」：`transcript.emit(event, owner)` / `system(..., owner)`
 * 的第四个参数不给 = 全局提示（启动横幅这类），必须照写，不能连带误伤。
 *
 * @module dsc/packages/transcript/transcript-isolation.int.spec
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'

/** 内核里本文件用到的服务面。 */
interface SessionView {
  meta: { id: string; cwd: string }
}

interface Services {
  session: { current(): SessionView; open(filePath?: string, cwd?: string): Promise<void> }
  transcript: {
    getSnapshot(): { entries: Array<Record<string, unknown>> }
    emit(event: Record<string, unknown>, owner?: string): void
    system(text: string, level?: string, command?: string, owner?: string): void
  }
}

/** 一张工具卡：形状照抄内核真实的 tool/call 事件。 */
function card(callId: string): Record<string, unknown> {
  return { type: 'tool/call', callId, name: 'glob', args: '{"pattern":"**/*.ts"}' }
}

let home: ReturnType<typeof tempHome>
let kernel: BootedKernel
let fake: FakeLLM
let services: Services

beforeEach(async () => {
  home = tempHome()
  fake = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
  services = kernel.ctx as unknown as Services
})

afterEach(async () => {
  await kernel.dispose()
  await fake.close()
  home.restore()
})

/** 建一个工作目录并返回（新建会话要求目录真实存在）。 */
function workspace(name: string): string {
  const dir = join(home.home, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 当前快照里的条目数：用差值断言，启动横幅那些既有条目不该影响判断。 */
function entryCount(): number {
  return services.transcript.getSnapshot().entries.length
}

describe('① 当前会话：自己的卡片照进，陌生的丢掉', () => {
  test('当前会话的卡片照常进', () => {
    const before = entryCount()
    services.transcript.emit(card('a-1'), services.session.current().meta.id)
    expect(entryCount()).toBe(before + 1)
  })

  test('不属于任何当前会话的卡片被丢掉', () => {
    const before = entryCount()
    services.transcript.emit(card('ghost-1'), 'no-such-session')
    expect(entryCount()).toBe(before)
  })
})

describe('② 切到 B：归属过滤跟着会话走', () => {
  test('后台会话 A 的卡片不进当前视图，B 的照常进', async () => {
    const a = services.session.current()
    await services.session.open(undefined, workspace('ws-b'))
    const b = services.session.current()
    expect(b.meta.cwd).toBe(join(home.home, 'ws-b'))

    const before = entryCount()
    services.transcript.emit(card('a-2'), a.meta.id)
    expect(entryCount()).toBe(before)

    services.transcript.emit(card('b-1'), b.meta.id)
    expect(entryCount()).toBe(before + 1)
  })

  test('后台会话的 system 行不进；不带归属的全局提示照写', async () => {
    const a = services.session.current()
    await services.session.open(undefined, workspace('ws-b'))

    const before = entryCount()
    services.transcript.system('A 的提示', undefined, undefined, a.meta.id)
    expect(entryCount()).toBe(before)

    // 启动横幅这类没有归属：不能因为加了过滤就一起吞掉。
    services.transcript.system('全局提示')
    expect(entryCount()).toBe(before + 1)
  })
})

describe('③ 再切到 C：上一条的卡片同样被挡住', () => {
  test('B 的卡片不进当前视图 C，C 的照常进', async () => {
    const b = services.session.current()
    await services.session.open(undefined, workspace('ws-c'))
    const c = services.session.current()
    expect(c.meta.cwd).toBe(join(home.home, 'ws-c'))

    const before = entryCount()
    services.transcript.emit(card('b-2'), b.meta.id)
    expect(entryCount()).toBe(before)
    expect(c.meta.id).not.toBe(b.meta.id)

    services.transcript.emit(card('c-1'), c.meta.id)
    expect(entryCount()).toBe(before + 1)
  })
})
