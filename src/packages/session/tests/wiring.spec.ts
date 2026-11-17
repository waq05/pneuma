/**
 * session 装配面（`packages/session/index.ts`）：启动恢复、会话列表缓存、会话库操作
 * （归档 / 恢复 / 删除 / 改名 / 置顶 / 分叉 / 回退）与两个事件。
 *
 * 假 ctx 只提供 get('agent') / emit / on / provide，`apply` 是真的；会话文件、meta
 * sidecar、归档区与回收站全部真读写临时 `DSC_HOME`。agent 用一个最小替身记录
 * `stop` / `isRunning` / `sessionFor`——本文件钉的是插件怎么用它，不是常驻 agent 本身。
 *
 * @module dsc/packages/session/tests/wiring.spec
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import type { Session as SessionInstance } from '@pneuma/runtime/core/session.js'
import type { SessionService } from '@pneuma/runtime/services/types.js'
import type { SessionPluginOptions } from '../index.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-session-wiring-'))
process.env['DSC_HOME'] = HOME
const WORK = mkdtempSync(join(tmpdir(), 'dsc-session-work-'))
const WORK2 = mkdtempSync(join(tmpdir(), 'dsc-session-work2-'))

type SessionModule = typeof import('@pneuma/runtime/core/session.js')
type MetaModule = typeof import('@pneuma/runtime/core/session-meta.js')
type SessionPackage = typeof import('../index.js')
let core: SessionModule
let meta: MetaModule
let sessionPlugin: SessionPackage['sessionPlugin']
let SessionClass: typeof import('@pneuma/runtime/core/session.js').Session

/** 常驻 agent 的最小替身。 */
interface AgentDouble {
  stopped: string[]
  running: Set<string>
  residents: Map<string, SessionInstance>
  stop(path: string): Promise<void>
  isRunning(path: string): boolean
  sessionFor(path: string): SessionInstance | undefined
}

interface Harness {
  service: SessionService
  events: Array<{ name: string; payload: unknown }>
  handlers: Map<string, (payload?: unknown) => void>
  agent: AgentDouble
}

const harnesses: Harness[] = []

/** 假 ctx 真 apply。 */
function boot(options: Partial<SessionPluginOptions> = {}, withAgent = true): Harness {
  const events: Array<{ name: string; payload: unknown }> = []
  const handlers = new Map<string, (payload?: unknown) => void>()
  const services = new Map<string, unknown>()
  const agent: AgentDouble = {
    stopped: [],
    running: new Set(),
    residents: new Map(),
    async stop(path) {
      this.stopped.push(path)
    },
    isRunning(path) {
      return this.running.has(path)
    },
    sessionFor(path) {
      return this.residents.get(path)
    },
  }
  const ctx = {
    get(name: string) {
      return name === 'agent' && withAgent ? agent : undefined
    },
    emit(name: string, payload?: unknown) {
      events.push({ name, payload })
    },
    on(name: string, handler: (payload?: unknown) => void) {
      handlers.set(name, handler)
      return () => undefined
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
  }
  sessionPlugin.apply(ctx as never, { cwd: WORK, ...options } as SessionPluginOptions)
  const harness = { service: services.get('session') as SessionService, events, handlers, agent }
  harnesses.push(harness)
  return harness
}

/** 等写入流把内容真正落到磁盘（`close()` 只是 end()，不等人刷完）。 */
async function waitForWritten(path: string): Promise<string> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    try {
      if (readFileSync(path, 'utf8').trim() !== '') return path
    } catch {
      // 目录还没建好或文件还没出现：再等一轮
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return path
}

/** 等文件里出现某段文本（临时副本的 `close()` 同样是异步刷盘）。 */
async function waitForContent(path: string, needle: string): Promise<string> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(path, 'utf8')
      if (text.includes(needle)) return text
    } catch {
      // 还没写出来：再等一轮
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return readFileSync(path, 'utf8')
}

/** 造一条已经落盘的会话（每条用户消息后面跟一句回答）。 */
async function persisted(cwd: string, texts: string[]): Promise<string> {
  const session = SessionClass.create(cwd)
  for (const text of texts) {
    session.appendUser(text)
    session.appendAssistant(`答：${text}`, '', [])
  }
  const path = session.filePath
  session.close()
  return waitForWritten(path)
}

beforeAll(async () => {
  core = await import('@pneuma/runtime/core/session.js')
  meta = await import('@pneuma/runtime/core/session-meta.js')
  SessionClass = core.Session
  sessionPlugin = (await import('../index.js')).sessionPlugin
})

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    try {
      harness.service.current().close()
    } catch {
      // 已经关过了
    }
  }
})

afterAll(() => {
  delete process.env['DSC_HOME']
  for (const dir of [HOME, WORK, WORK2]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('启动与恢复', () => {
  test('恢复已有会话：当前/指针/服务面都对，退出时关会话', async () => {
    const path = await persisted(WORK, ['历史第一句'])
    const h = boot({ cwd: WORK, resumeSessionPath: path })
    expect(h.service.current().filePath).toBe(path)
    expect(h.service.resumedStartup).toBe(true)
    expect(h.service.startupNote).toBeNull()
    expect(h.service.sessions).toEqual([])
    expect(h.service.loading).toBe(false)
    expect(core.loadLastSessionPath()).toBe(path)

    for (const method of ['open', 'refresh', 'archive', 'archived', 'restore', 'purge', 'rename', 'setPinned', 'userMessages', 'fork', 'rewind'] as const) {
      expect(typeof h.service[method], method).toBe('function')
    }

    const close = vi.spyOn(h.service.current(), 'close')
    h.handlers.get('dsc/exit')?.()
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('恢复失败回退新会话并留 startupNote；文件不存在则安静开新会话', () => {
    const broken = join(HOME, 'broken.jsonl')
    writeFileSync(broken, 'not a jsonl line\n', 'utf8')
    const failed = boot({ cwd: WORK, resumeSessionPath: broken })
    expect(failed.service.current().meta.cwd).toBe(WORK)
    expect(failed.service.current().filePath).not.toBe(broken)
    expect(failed.service.startupNote).toContain('恢复会话失败')

    const quiet = boot({ cwd: WORK2, resumeSessionPath: join(HOME, 'missing.jsonl') })
    expect(quiet.service.current().meta.cwd).toBe(WORK2)
    expect(quiet.service.startupNote).toBeNull()
    expect(quiet.service.resumedStartup).toBe(false)
  })
})

describe('open', () => {
  test('新建用当前目录；同一条再开是 no-op；指定目录生效、坏目录当场拒绝', async () => {
    const h = boot({ cwd: WORK })
    const first = h.service.current().filePath
    await h.service.open()
    const opened = h.service.current()
    expect(opened.filePath).not.toBe(first)
    expect(opened.meta.cwd).toBe(WORK)
    expect(h.events.some((event) => event.name === 'dsc/session-open')).toBe(true)
    expect(h.events.filter((event) => event.name === 'dsc/changed').length).toBeGreaterThan(0)

    const eventsBefore = h.events.length
    await h.service.open(opened.filePath)
    expect(h.events.length).toBe(eventsBefore)

    opened.close()
    await h.service.open(undefined, WORK2)
    expect(h.service.current().meta.cwd).toBe(WORK2)

    // 坏目录是当场抛（界面拿得到原因），不是悄悄回落到别处。
    const beforeBad = h.service.current()
    await expect(h.service.open(undefined, 'relative/path')).rejects.toThrow('工作目录不可用')
    expect(h.service.current()).toBe(beforeBad)
  })

  test('打开已有文件走 Session.load；常驻 agent 有实例时直接复用；坏文件只发通知', async () => {
    const file = await persisted(WORK, ['旧会话'])
    const h = boot({ cwd: WORK })
    await h.service.open(file)
    expect(h.service.current().filePath).toBe(file)
    expect(h.service.current().messages.length).toBe(2)

    const resident = SessionClass.create(WORK)
    resident.appendUser('常驻实例')
    h.agent.residents.set(resident.filePath, resident)
    await h.service.open(resident.filePath)
    expect(h.service.current()).toBe(resident)

    const broken = join(HOME, 'cannot-load.jsonl')
    writeFileSync(broken, 'oops\n', 'utf8')
    const before = h.service.current()
    await h.service.open(broken)
    expect(h.service.current()).toBe(before)
    expect(h.events.at(-2)?.name).toBe('dsc/notice')
    expect(String(h.events.at(-2)?.payload)).toContain('会话打开失败')
  })
})

describe('列表缓存', () => {
  test('refresh 收活动区与归档区，给未落盘的当前会话补一行；loading 来回翻', async () => {
    await persisted(WORK, ['会话一'])
    const archivedPath = await persisted(WORK2, ['会话二'])
    core.archiveSession(archivedPath)

    const h = boot({ cwd: WORK })
    const changedBefore = h.events.filter((event) => event.name === 'dsc/changed').length
    await h.service.refresh()
    expect(h.service.loading).toBe(false)
    expect(h.events.filter((event) => event.name === 'dsc/changed').length).toBe(changedBefore + 2)
    const ids = h.service.sessions.map((item) => item.id)
    expect(ids).toContain(h.service.current().filePath)
    expect(h.service.sessions.find((item) => item.id === h.service.current().filePath)?.unsaved).toBe(true)
    expect(h.service.sessions.some((item) => item.archivedAt !== undefined)).toBe(true)
  })

  test('当前会话第一次落盘后，dsc/changed 自动补刷列表（只补一次）', async () => {
    const h = boot({ cwd: WORK })
    h.service.current().appendUser('第一句话')
    await waitForWritten(h.service.current().filePath)
    h.handlers.get('dsc/changed')?.()
    await vi.waitFor(() => {
      expect(h.service.sessions.some((item) => item.id === h.service.current().filePath && item.unsaved !== true)).toBe(true)
    })
  })
})

describe('归档 / 恢复 / 删除', () => {
  test('归档：当前会话不许动；真挪进归档区；没有可归档的给回执', async () => {
    const h = boot({ cwd: WORK })
    const other = await persisted(WORK, ['待归档'])
    expect(await h.service.archive([h.service.current().filePath])).toMatchObject({ ok: false })
    expect(await h.service.archive(['relative/missing.jsonl'])).toMatchObject({ ok: true, notice: '没有要归档的会话（可能已经都在归档区）' })

    const result = await h.service.archive([other])
    expect(result).toMatchObject({ ok: true })
    expect(existsSync(other)).toBe(false)
    const archived = h.service.archived()
    const item = archived.items.find((entry) => entry.path.endsWith('.jsonl'))
    expect(item?.path.startsWith(core.archivedRoot())).toBe(true)
    expect(item?.archivedAt).toBeGreaterThan(0)
    expect(archived.trashDir).toBe(core.trashRoot())
  })

  test('归档失败半批：报告失败条数与原因；恢复成功/失败都给结论', async () => {
    const h = boot({ cwd: WORK })
    const outside = join(HOME, 'outside.jsonl')
    writeFileSync(outside, '{}\n', 'utf8')
    const failed = await h.service.archive([outside])
    expect(failed.ok).toBe(false)
    expect(failed).toMatchObject({ error: expect.stringContaining('1 个失败') })

    const path = await persisted(WORK, ['恢复我'])
    await h.service.archive([path])
    // 归档目标路径 = 归档根 + 原工作目录名 + 原文件名。
    const archivedPath = join(core.archivedRoot(), basename(dirname(path)), basename(path))
    expect(h.service.restore([archivedPath])).toMatchObject({ ok: true })
    expect(existsSync(path)).toBe(true)
    expect(h.service.restore([join(core.archivedRoot(), 'nope.jsonl')]).ok).toBe(false)
  })

  test('永久删除：当前会话拒绝；普通会话进回收站并先让 agent 收摊', async () => {
    const h = boot({ cwd: WORK })
    const path = await persisted(WORK, ['要删的'])
    expect(await h.service.purge([h.service.current().filePath])).toMatchObject({ ok: false })
    const done = await h.service.purge([path])
    expect(done).toMatchObject({ ok: true })
    expect(h.agent.stopped).toContain(path)
    expect(core.countTrashFiles()).toBeGreaterThan(0)
    expect(await h.service.purge([join(WORK, 'nope.jsonl')])).toMatchObject({ ok: false })
  })
})

describe('改名 / 置顶 / 消息清单 / 分叉 / 回退', () => {
  test('改名折叠空白并截断；空名拒绝；置顶与取消置顶写 sidecar', async () => {
    const h = boot({ cwd: WORK })
    const path = await persisted(WORK, ['一条'])
    expect(h.service.rename(path, `  ${'长'.repeat(70)}  `)).toMatchObject({ ok: true })
    expect(meta.readSessionMeta()[core.uuidOf(path)]?.title).toHaveLength(60)
    expect(h.service.rename(path, '  ')).toMatchObject({ ok: false, error: '会话名字不能是空的' })
    expect(h.service.rename(path, '  新   名字  ')).toMatchObject({ ok: true, notice: '已改名为「新 名字」' })

    expect(h.service.setPinned(path, true)).toMatchObject({ ok: true, notice: '已置顶这个会话' })
    expect(meta.readSessionMeta()[core.uuidOf(path)]?.pinnedAt).toBeGreaterThan(0)
    expect(h.service.setPinned(path, false)).toMatchObject({ ok: true, notice: '已取消置顶' })
    expect(meta.readSessionMeta()[core.uuidOf(path)]?.pinnedAt).toBeUndefined()
  })

  test('userMessages 压成一行并截 50 字；读不到文件发通知给空表', async () => {
    const h = boot({ cwd: WORK })
    const path = await persisted(WORK, ['你好   世界\n下一行'])
    expect(h.service.userMessages(path)).toEqual(['你好 世界 下一行'])
    expect(h.service.userMessages(join(WORK, 'missing.jsonl'))).toEqual([])
    expect(String(h.events.at(-1)?.payload)).toContain('读取会话消息失败')
  })

  test('分叉：按用户消息下标切；越界与切在开头都给失败', async () => {
    const h = boot({ cwd: WORK })
    const path = await persisted(WORK, ['第一', '第二'])
    const first = h.service.fork(path, 1)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('分叉失败')
    expect(core.readUserMessages(first.path)).toEqual(['第一'])
    expect(meta.readSessionMeta()[core.uuidOf(first.path)]?.forkedFrom).toBe(core.uuidOf(path))

    const whole = h.service.fork(path, 2)
    expect(whole.ok && core.readUserMessages(whole.path).length === 2).toBe(true)
    expect(h.service.fork(path, 0)).toMatchObject({ ok: false, error: expect.stringContaining('分叉点之前') })
    expect(h.service.fork(path, 99)).toMatchObject({ ok: false, error: expect.stringContaining('没有第 100 条') })
  })

  test('回退：只认当前会话、回合在跑拒绝、越界拒绝；keep=0 顺手改自动标题', async () => {
    const h = boot({ cwd: WORK })
    const current = h.service.current()
    current.appendUser('第一句')
    current.appendAssistant('答一', '', [])
    current.appendUser('第二句')

    const other = await persisted(WORK, ['别的'])
    expect(h.service.rewind(other, 0)).toMatchObject({ ok: false, error: expect.stringContaining('只能改当前会话') })

    h.agent.running.add(current.filePath)
    expect(h.service.rewind(current.filePath, 0)).toMatchObject({ ok: false, error: expect.stringContaining('还在跑') })
    h.agent.running.delete(current.filePath)

    h.agent.residents.set(current.filePath, current)
    expect(h.service.rewind(current.filePath, 99)).toMatchObject({ ok: false, error: expect.stringContaining('已经不在会话里') })
    expect(h.service.rewind(current.filePath, 0, '改过的第一句')).toEqual({ ok: true })
    expect(meta.readSessionMeta()[core.uuidOf(current.filePath)]?.autoTitle).toBe('改过的第一句')
    expect(h.events.some((event) => event.name === 'dsc/session-open')).toBe(true)
    expect(h.events.at(-1)?.name).toBe('dsc/changed')
  })

  test('回退在没有常驻 agent 时用临时副本改盘', async () => {
    const h = boot({ cwd: WORK }, false)
    const current = h.service.current()
    current.appendUser('第一句')
    current.appendAssistant('答一', '', [])
    current.appendUser('第二句')
    await waitForWritten(current.filePath)
    expect(h.service.rewind(current.filePath, 1)).toEqual({ ok: true })
    // 内存里的常驻会话不动（没有承接者），盘上追加了一条 rewind 记录。
    expect(h.service.current().messages).toHaveLength(3)
    expect(await waitForContent(current.filePath, '"type":"rewind"')).toContain('"type":"rewind"')
  })
})
