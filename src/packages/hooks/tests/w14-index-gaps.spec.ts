/**
 * hooks 插件装配面的长尾补盲（w14）：
 *
 *   - `fireObserve` 的 `.then`：观察型脚本判定有毛病时发「没跑好」提醒；
 *   - `fireObserve` 的 `.catch`：异步链里读会话失败只报一条「执行出错」，不变成未处理拒绝；
 *   - `fireExternal` 的 `.catch`：`runExternalHooks` 意外拒绝时同样只报一条；
 *   - 设置分区的「最近钩子」：有审计记录时按行列出（`recent()` 的 kind 过滤 + 渲染）。
 *
 * 全部走「假 ctx + 真 apply」，`DSC_HOME` 在任何产品 import 之前指进临时目录；
 * 脚本是真 `node` 子进程，都很快退出。
 *
 * @module dsc/packages/hooks/tests/w14-index-gaps.spec
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import type { ToolGuardInput } from '@pneuma/runtime/core/tool-guards.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-hooks-w14-'))
process.env['DSC_HOME'] = HOME
const REPO = join(HOME, 'repo')
mkdirSync(REPO, { recursive: true })
const HOOKS_FILE = join(HOME, 'hooks.json')
const LIFECYCLE_FILE = join(HOME, 'lifecycle-hooks.json')

let hooksPlugin: (typeof import('../index.js'))['hooksPlugin']

beforeAll(async () => {
  hooksPlugin = (await import('../index.js')).hooksPlugin
})

interface FakeSection {
  values(): Record<string, unknown>
  fields(): Array<Record<string, unknown>>
  save(key: string, value: unknown): string | void
  action(name: string): string | void
}

interface FakeCtx {
  guards: Array<{ id: string; order: number; decide: (input: ToolGuardInput) => Promise<unknown> }>
  observers: Array<{ id: string; order: number; observe: (tool: string, text: string) => string }>
  sections: FakeSection[]
  services: Map<string, unknown>
  notices: Array<{ text: string; sessionPath?: string }>
  notes: Array<{ kind: string; text: string }>
  session: {
    meta: { id: string; cwd: string }
    filePath: string
    messages: unknown[]
    appendNote(kind: string, text: string): void
  }
  llm: { model: string }
  section: FakeSection
}

let bump = 0

/** 写配置并把 mtime 往前推：`readHooks` 的缓存按 mtime+size 判新。 */
function writeFileFresh(file: string, text: string): void {
  writeFileSync(file, text, 'utf8')
  bump += 1
  const stamp = new Date(Date.now() + bump * 1_000)
  try {
    utimesSync(file, stamp, stamp)
  } catch {
    // 改不了时间就算了
  }
}

function writeHooks(doc: { rules?: unknown[]; scripts?: unknown[]; settings?: Record<string, unknown> }): void {
  writeFileFresh(
    HOOKS_FILE,
    JSON.stringify({ version: 1, settings: doc.settings ?? {}, rules: doc.rules ?? [], scripts: doc.scripts ?? [] }),
  )
}

/** 写一个立即退出的脚本，返回 `node <文件>` 形式的命令。 */
function exitScript(name: string, code: number): string {
  const file = join(HOME, name)
  writeFileSync(file, `process.exit(${String(code)})\n`, 'utf8')
  return `node ${file}`
}

const defaultPassed = { enabled: false, configPath: LIFECYCLE_FILE, timeoutMs: 5_000, failClosed: false, commandAllowlist: '' }

function fakeCtx(options: { passed?: unknown } = {}): FakeCtx {
  const guards: FakeCtx['guards'] = []
  const observers: FakeCtx['observers'] = []
  const sections: FakeSection[] = []
  const services = new Map<string, unknown>()
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const notices: FakeCtx['notices'] = []
  const notes: FakeCtx['notes'] = []
  const session = {
    meta: { id: 'sess-hooks-w14', cwd: REPO },
    filePath: join(REPO, '.dsc', 'sessions', 'a.jsonl'),
    messages: [{ role: 'assistant', content: '刚说完的话' }],
    appendNote(kind: string, text: string): void {
      notes.push({ kind, text })
    },
  }
  const llm = { model: 'dsc-model' }
  const ctx = {
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    guards: {
      register(guard: FakeCtx['guards'][number]) {
        guards.push(guard)
        return () => undefined
      },
      registerObserver(observer: FakeCtx['observers'][number]) {
        observers.push(observer)
        return () => undefined
      },
    },
    approval: {
      policy: 'auto-edit',
      decide: async () => 'allow-once',
    },
    session: { current: () => session },
    llm,
    commands: { register: () => () => undefined },
    prompt: { registerProjection: () => () => undefined },
    settings: {
      registerSection(spec: FakeSection) {
        sections.push(spec)
        return () => undefined
      },
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => undefined
    },
    emit(event: string, text?: string, _kind?: string, sessionPath?: string) {
      if (event === 'dsc/notice' && typeof text === 'string') {
        notices.push({ text, ...(typeof sessionPath === 'string' ? { sessionPath } : {}) })
      }
    },
  }
  hooksPlugin.apply?.(ctx as never, options.passed ?? defaultPassed)
  return { guards, observers, sections, services, notices, notes, session, llm, section: sections[0]! }
}

function input(overrides: Record<string, unknown> = {}): ToolGuardInput {
  return {
    toolName: 'bash',
    risk: 'exec',
    cwd: REPO,
    args: {},
    command: '',
    target: '',
    signal: new AbortController().signal,
    sessionId: 'sess-hooks-w14',
    sessionPath: join(REPO, '.dsc', 'sessions', 'a.jsonl'),
    ...overrides,
  } as never
}

/** 轮询到条件成立。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeEach(() => {
  writeHooks({})
  writeFileFresh(LIFECYCLE_FILE, JSON.stringify({ hooks: {} }))
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 句柄：留给系统清
  }
})

afterEach(() => {
  // 每个用例都拿一份新的假 ctx 与配置；这里只兜底清掉审计，避免用例间互相看到「最近钩子」。
  try {
    rmSync(join(HOME, 'audit.jsonl'), { force: true })
  } catch {
    // 没有就算了
  }
})

test('post-tool 脚本失败：判定有毛病时发「钩子脚本没跑好」', async () => {
  writeHooks({
    settings: { autoAccept: true },
    scripts: [{ id: 's-post-w14', event: 'post-tool', matcher: 'bash', command: exitScript('post-exit3-w14.mjs', 3) }],
  })
  const harness = fakeCtx()
  const observer = harness.observers.find((item) => item.id === 'hooks')!
  observer.observe('bash', '工具结果')
  await waitFor(() => harness.notices.some((item) => item.text.includes('钩子脚本没跑好')))
  const notice = harness.notices.find((item) => item.text.includes('钩子脚本没跑好'))
  expect(notice?.text).toContain('脚本以 3 退出')
})

test('观察型脚本的异步链里读会话失败：只发一条「执行出错」，不变成未处理拒绝', async () => {
  writeHooks({
    settings: { autoAccept: true },
    scripts: [{ id: 's-broken-w14', event: 'post-tool', matcher: 'bash', command: exitScript('post-broken-w14.mjs', 0) }],
  })
  const harness = fakeCtx()
  let idCalls = 0
  Object.defineProperty(harness.session.meta, 'id', {
    configurable: true,
    get() {
      idCalls += 1
      if (idCalls > 1) throw new Error('会话已经关了')
      return 'sess-hooks-w14'
    },
  })
  const observer = harness.observers.find((item) => item.id === 'hooks')!
  observer.observe('bash', '工具结果')
  await waitFor(() => harness.notices.some((item) => item.text.includes('钩子脚本执行出错')))
  const notice = harness.notices.find((item) => item.text.includes('钩子脚本执行出错'))
  expect(notice?.text).toContain('会话已经关了')
})

test('外部命令钩子读载荷时出错：runExternalHooks 拒绝被接住，只报一条执行出错', async () => {
  writeFileFresh(LIFECYCLE_FILE, JSON.stringify({ PostToolUse: [{ hooks: [{ command: 'node noop-w14.js' }] }] }))
  const harness = fakeCtx({
    passed: { enabled: true, configPath: LIFECYCLE_FILE, timeoutMs: 5_000, failClosed: false, commandAllowlist: 'node' },
  })
  let modelReads = 0
  Object.defineProperty(harness.llm, 'model', {
    configurable: true,
    get() {
      modelReads += 1
      throw new Error('模型服务没接上')
    },
  })
  expect(modelReads).toBe(0)
  const observer = harness.observers.find((item) => item.id === 'lifecycle-hooks')!
  observer.observe('bash', '工具结果')
  await waitFor(() => harness.notices.some((item) => item.text.includes('执行出错')))
  const notice = harness.notices.find((item) => item.text.includes('执行出错'))
  expect(notice?.text).toContain('模型服务没接上')
})

test('设置分区：有钩子审计时「最近钩子」按行列出工具与理由', async () => {
  writeHooks({
    rules: [
      { id: 'r-w14', enabled: true, tool: 'bash', field: 'command', pattern: 'rm -rf', action: 'deny', reason: '危险命令' },
    ],
  })
  const harness = fakeCtx()
  const guard = harness.guards.find((item) => item.id === 'hooks')!
  const verdict = await guard.decide(input({ command: 'rm -rf /' }))
  expect(verdict).toMatchObject({ action: 'deny' })

  const service = harness.services.get('hooks') as { recent(limit?: number): Array<Record<string, unknown>> }
  const recent = service.recent(5)
  expect(recent.length).toBeGreaterThan(0)
  expect(recent[0]).toMatchObject({ kind: 'hook', tool: 'bash' })

  const fields = harness.section.fields()
  const recentField = fields.find((field) => String(field['text'] ?? '').includes('bash'))
  expect(recentField).toBeDefined()
})
