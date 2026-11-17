/**
 * 归档后会话列表缓存自刷新的用例（迁自 `scripts/session-archive-refresh-test.mjs`）。
 *
 * 0.6.49 报障：组菜单「删除工作区」之后侧栏的组不消失。事故形状是 `session.archive`
 * 把 jsonl 挪进 `.archived/`、写了 sidecar，却不重扫列表缓存——快照的 `sessions` 字段
 * 读的就是这份缓存，于是归档成功的会话仍按活动区留在侧栏；再点那行还会撞 ENOENT
 * （文件已经挪走了）。
 *
 * 断言四件事：
 *   1. 归档前 refresh 后，缓存里有两条活动会话；
 *   2. archive 返回后同一份缓存里不再有被归档的那条（**不需要调用方再 refresh**）；
 *   3. 缓存里多出那条带 `archivedAt` 的记录（归档区可见）；
 *   4. 没有被归档的那条仍在活动区；archive 期间发过 `dsc/changed`（宿主据此推快照）。
 *
 * 迁移改动：原探针手搓一个假 ctx 再 `sessionPlugin.apply(ctx)`；这里用真内核
 * （`bootKernel`），验的是「整套装配起来之后 archive 还会不会自刷」。缓存里同时住着
 * 内核自己那条还没落盘的会话（cwd = 进程目录），所以断言一律按本文件的工作目录过滤。
 *
 * @module dsc/packages/session/archive-refresh.int.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'

/** 列表里的一行（`src/packages/session/index.ts` 的 `toSummary`）。 */
interface Summary {
  id: string
  cwd: string
  archivedAt?: number
}

interface Services {
  session: {
    readonly sessions: Summary[]
    refresh(): Promise<void>
    archive(paths: string[]): Promise<{ ok: boolean; notice?: string; error?: string }>
  }
}

/** 临时主目录；必须在任何内核模块被加载之前换好。 */
const home = tempHome()
/** 本文件的工作目录：会话的 `meta.cwd` 指着它。 */
const WORK = join(home.home, 'work')

let kernel: BootedKernel
let fake: FakeLLM
let core: typeof import('@pneuma/runtime/core/session.js')
let services: Services
/** archive 期间发过的应用层事件（宿主据此推快照）。 */
let events: string[] = []

beforeAll(async () => {
  mkdirSync(WORK, { recursive: true })
  core = await import('@pneuma/runtime/core/session.js')
  fake = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
  services = kernel.ctx as unknown as Services
  const ctx = kernel.ctx as unknown as { on(event: string, listener: () => void): unknown }
  ctx.on('dsc/changed', () => events.push('dsc/changed'))
})

afterAll(async () => {
  await kernel?.dispose()
  await fake?.close()
  home.restore()
})

/** 铺一条真会话日志：meta 行 + 一条用户消息（没有对话的文件不进列表）。 */
function seedSession(id: string, text: string): string {
  const dir = join(core.sessionsRoot(), core.slugCwd(WORK))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  const lines = [
    { type: 'meta', id, cwd: WORK, createdAt: Date.now() },
    { type: 'user', text, ts: Date.now() },
  ]
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  return file
}

/** 本工作目录的会话行（缓存里还住着内核自己那条，不能按总数断）。 */
function rowsHere(): Summary[] {
  return services.session.sessions.filter((item) => item.cwd === WORK)
}

/** 活动区（没被归档）的路径。 */
function livePaths(): string[] {
  return rowsHere()
    .filter((item) => item.archivedAt === undefined)
    .map((item) => item.id)
}

describe('① 归档前：缓存里是两条活动会话', () => {
  test('refresh 之后两条都在活动区', async () => {
    const keep = seedSession('11111111-1111-4111-8111-111111111111', '保留的会话')
    const gone = seedSession('22222222-2222-4222-8222-222222222222', '要归档的会话')
    await services.session.refresh()
    expect(typeof services.session.archive).toBe('function')
    expect(livePaths()).toHaveLength(2)
    expect(livePaths()).toEqual(expect.arrayContaining([keep, gone]))
  })
})

describe('② archive 自己重扫缓存，不需要调用方再 refresh', () => {
  test('归档后活动区不再有它，没被归档的那条仍在', async () => {
    const keep = seedSession('33333333-3333-4333-8333-333333333333', '保留')
    const gone = seedSession('44444444-4444-4444-8444-444444444444', '归档')
    await services.session.refresh()

    const result = await services.session.archive([gone])
    expect(result.ok).toBe(true)
    expect(livePaths()).not.toContain(gone)
    expect(livePaths()).toContain(keep)
  })

  test('归档区里能看见它（带 archivedAt）', async () => {
    const keep = seedSession('55555555-5555-4555-8555-555555555555', '保留')
    const gone = seedSession('66666666-6666-4666-8666-666666666666', '归档')
    await services.session.refresh()
    expect((await services.session.archive([gone])).ok).toBe(true)

    const archived = rowsHere().filter((item) => typeof item.archivedAt === 'number')
    expect(archived.length).toBeGreaterThanOrEqual(1)
    // 被归档的那条不该再出现在活动区，保留的那条也不该被误标。
    // 同一个临时 HOME 里还躺着前面用例的会话，所以只按本条的 id 判，不比整张表。
    expect(livePaths()).toContain(keep)
    expect(livePaths()).not.toContain(gone)
  })
})

describe('③ 宿主侧事件', () => {
  test('archive 期间发过 dsc/changed（侧栏才会跟着变）', async () => {
    const gone = seedSession('77777777-7777-4777-8777-777777777777', '归档')
    await services.session.refresh()
    events = []
    expect((await services.session.archive([gone])).ok).toBe(true)
    expect(events).toContain('dsc/changed')
  })
})
