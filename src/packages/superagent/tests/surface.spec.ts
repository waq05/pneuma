/**
 * 第 7 步前半的包级测试：界面面（快照）与服务转发。
 *
 * 六条用例各钉一件「界面点了没反应」的事：
 *   1. 面形状齐：ready / counts / tickets / recent 四样都在；
 *   2. 工单增减时 counts 跟着变（发布 → running；停止 → done）；
 *   3. peekSession 真读得到刚写进去的 jsonl（只读重放，不改文件）；
 *   4. 停 / 重试 / 清理 / 发布四个动作转发到运行期的对应方法；
 *   5. 运行期没起来时 `ready:false` 且带 `problem`（界面据此说清卡在哪）；
 *   6. 一张工单多个执行会话（重试过）时条目 id 顺延，不会撞 key。
 *
 * 全程用 `tmpdir()` 下的临时 `DSC_HOME`，绝不碰用户真实的 `~/.dsc`。
 * 迁移说明：原文件 import `lib/` 构建产物；现在直接 import 源码，不再要求先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { SuperagentRuntime as RuntimeInstance } from '../runtime.js'
import type { SuperagentService } from '../service.js'

const { openStore } = await import('../adapters/store.js')
const { SuperagentRuntime } = await import('../runtime.js')
const { SuperagentService: Service } = await import('../service.js')
const { sessionsDir } = await import('../paths.js')

/** 固定时钟：断言不依赖「跑得快慢」。 */
const AT = '2026-01-01T00:00:00.000Z'

/** 一张合法工单 id（32 位十六进制；`paths.ts` 的目录名校验认这个形状）。 */
const TICKET_ID = 'abcdef0123456789abcdef0123456789'

const roots: string[] = []

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** 一个用例一个临时根目录。 */
function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `superagent-surface-${label}-`))
  roots.push(dir)
  return dir
}

/** 一套运行期 + 服务，以及读计数器的小口。 */
interface RuntimeFixture {
  runtime: RuntimeInstance
  service: SuperagentService
  root: string
  changes: () => number
}

/**
 * 在临时目录里装一套运行期 + 服务，跑完 `work` 后按「运行期 → 库 → 环境变量」收尾。
 * @param work - 拿到 runtime / service / root
 */
async function withRuntime<T>(label: string, work: (context: RuntimeFixture) => T | Promise<T>): Promise<T> {
  const root = tempRoot(label)
  const previous = process.env.DSC_HOME
  process.env.DSC_HOME = root
  const store = openStore()
  const runtime = new SuperagentRuntime(store, { now: () => AT, log: () => {} })
  let changed = 0
  const service = new Service({
    current: () => runtime,
    ensure: () => runtime,
    problem: () => null,
    changed: () => {
      changed += 1
    },
  })
  try {
    return await work({ runtime, service, root, changes: () => changed })
  } finally {
    runtime.close()
    store.close()
    if (previous === undefined) delete process.env['DSC_HOME']
    else process.env['DSC_HOME'] = previous
  }
}

/** 转发用例记下的一次调用：方法名 + 第一个参数。 */
type ForwardedCall = [string, unknown]

/** 一台只记调用的假运行期：转发用例只要「调到了哪个方法、给了什么」。 */
function fakeRuntime(): { runtime: RuntimeInstance; calls: ForwardedCall[] } {
  const calls: ForwardedCall[] = []
  const runtime = {
    publish(input: unknown) {
      calls.push(['publish', input])
      return TICKET_ID
    },
    list() {
      return [{ id: TICKET_ID, title: '假工单', stage: { stage: 'working', action: 'queued' }, createdAt: AT }]
    },
    stop(id: string) {
      calls.push(['stop', id])
    },
    retry(id: string) {
      calls.push(['retry', id])
    },
    clean(id: string) {
      calls.push(['clean', id])
    },
    pump() {},
    recent() {
      return []
    },
  }
  // 只实现服务转发会碰到的几个方法；真实运行期远不止这些。
  return { runtime: runtime as unknown as RuntimeInstance, calls }
}

/**
 * 手写一个执行会话 jsonl：meta 首行 + 一条用户消息（与 `Session` 落盘的形状一致）。
 *
 * 为什么不直接用 `Session.create`：它用写流异步落盘，`close()` 只是 `stream.end()`，
 * 紧跟着读会偶发 ENOENT。peek 只认日志的形状，手写更确定。
 */
function writeSession(file: string, cwd: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const meta = { type: 'meta', id: randomUUID(), cwd, createdAt: Date.now() }
  const user = { type: 'user', text, ts: Date.now() }
  writeFileSync(file, `${JSON.stringify(meta)}\n${JSON.stringify(user)}\n`)
}

test('面形状：ready / counts / tickets / recent 四样都在', async () => {
  await withRuntime('shape', ({ runtime, service }) => {
    const id = runtime.publish({ title: '改登录页文案', body: '把错误提示改成中文' })
    const surface = service.surface()
    expect(surface.ready).toBe(true)
    expect(surface.problem).toBeUndefined()
    expect(typeof surface.counts.needsYou).toBe('number')
    expect(typeof surface.counts.running).toBe('number')
    expect(typeof surface.counts.done).toBe('number')
    expect(surface.tickets.length).toBe(1)
    expect(surface.tickets[0].id).toBe(id)
    expect(surface.tickets[0].title).toBe('改登录页文案')
    expect(surface.tickets[0].at, '建单时刻要带出来（命令层叫 createdAt，契约叫 at）').toBe(AT)
    expect(surface.tickets[0].stage).toStrictEqual({ stage: 'working', action: 'queued' })
    expect(Array.isArray(surface.recent), 'recent 必须是数组（没有动态就是空数组）').toBe(true)
    // 三组计数之和必须等于工单总数：界面分组头不许「加起来对不上」。
    expect(surface.counts.needsYou + surface.counts.running + surface.counts.done).toBe(surface.tickets.length)
  })
})

test('工单数变化时 counts 跟着变：发布算进行中，停止后算已完成', async () => {
  await withRuntime('counts', async ({ runtime, service }) => {
    const id = runtime.publish({ title: '要停的工单', body: '正文' })
    expect(service.surface().counts).toStrictEqual({ needsYou: 0, running: 1, done: 0 })

    await service.stop(id)
    const after = service.surface()
    expect(after.counts).toStrictEqual({ needsYou: 0, running: 0, done: 1 })
    expect(after.tickets[0].stage).toStrictEqual({ stage: 'ended' })
  })
})

test('peekSession 读得到刚写进去的执行会话 jsonl（只读）', async () => {
  const root = tempRoot('peek')
  const previous = process.env['DSC_HOME']
  process.env['DSC_HOME'] = root
  try {
    const file = join(sessionsDir(TICKET_ID), '11111111-1111-4111-8111-111111111111.jsonl')
    writeSession(file, root, '把登录页的错误提示改成中文')
    const before = readFileSync(file, 'utf8')

    // peekSession 不需要运行期：文件在就能看（库还没开也一样）。
    const service = new Service({
      current: () => null,
      ensure: () => null,
      problem: () => null,
      changed: () => {},
    })
    const entries = await service.peekSession(TICKET_ID)
    const user = entries.find((entry) => entry.kind === 'user')
    expect(user, `转录里应有那条用户消息，实际：${entries.map((entry) => entry.kind).join(',')}`).toBeDefined()
    expect(user?.text).toMatch(/错误提示改成中文/)
    expect(readFileSync(file, 'utf8'), '读转录不能改动 jsonl').toBe(before)
  } finally {
    if (previous === undefined) delete process.env['DSC_HOME']
    else process.env['DSC_HOME'] = previous
  }
})

test('停 / 重试 / 清理 / 发布转发到运行期的对应方法', async () => {
  const { runtime, calls } = fakeRuntime()
  let changed = 0
  const service = new Service({
    current: () => runtime,
    ensure: () => runtime,
    problem: () => null,
    changed: () => {
      changed += 1
    },
  })

  const id = await service.publish({ title: '转发', body: '正文' })
  expect(id).toBe(TICKET_ID)
  await service.stop(TICKET_ID)
  await service.retry(TICKET_ID)
  await service.clean(TICKET_ID)

  expect(calls).toStrictEqual([
    ['publish', { title: '转发', body: '正文' }],
    ['stop', TICKET_ID],
    ['retry', TICKET_ID],
    ['clean', TICKET_ID],
  ])
  expect(changed, '四个写动作各通知一次快照失效（发布 / 停 / 重试 / 清理）').toBe(4)
})

test('运行期没起来时 ready:false 且带 problem', () => {
  const service = new Service({
    current: () => null,
    ensure: () => null,
    problem: () => ({ code: 'store_unavailable', detail: '编排库没打开：拿不到单实例锁' }),
    changed: () => {},
  })
  const surface = service.surface()
  expect(surface.ready).toBe(false)
  expect(surface.problem?.code).toBe('store_unavailable')
  expect(surface.problem?.detail ?? '').toMatch(/单实例锁/)
  expect(surface.counts).toStrictEqual({ needsYou: 0, running: 0, done: 0 })
  expect(surface.tickets).toStrictEqual([])
  expect(surface.recent).toStrictEqual([])
})

test('多个执行会话（重试过）时条目 id 顺延，不撞 key', async () => {
  const root = tempRoot('multi')
  const previous = process.env['DSC_HOME']
  process.env['DSC_HOME'] = root
  try {
    const dir = sessionsDir(TICKET_ID)
    const files = ['11111111-1111-4111-8111-111111111111.jsonl', '22222222-2222-4222-8222-222222222222.jsonl']
    for (const name of files) writeSession(join(dir, name), root, `第 ${name.slice(0, 1)} 次的执行`)
    const service = new Service({
      current: () => null,
      ensure: () => null,
      problem: () => null,
      changed: () => {},
    })
    const entries = await service.peekSession(TICKET_ID)
    const ids = entries.map((entry) => entry.id)
    expect(new Set(ids).size, `条目 id 不能重复：${ids.join(',')}`).toBe(ids.length)
    expect(entries.some((entry) => entry.kind === 'user' && /第 1 次/.test(entry.text))).toBe(true)
    expect(entries.some((entry) => entry.kind === 'user' && /第 2 次/.test(entry.text))).toBe(true)
  } finally {
    if (previous === undefined) delete process.env['DSC_HOME']
    else process.env['DSC_HOME'] = previous
  }
})
