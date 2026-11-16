/**
 * @pneuma/session-search 的第二组包级测试：索引本体的磁盘行为 + `index.ts` 的运行面。
 *
 * 既有 `session-search.spec.ts` 钉装配行/包形态与切词；`session-index.int.spec.ts` 钉宽松召回。
 * 这里补的是索引作为「旁路缓存」的完整生命周期：落盘与原子改名、命中字段、ts 回退、
 * 坏行容错、排序与 limit、cwd/归档/隐藏区过滤、增量重解析、删除、超大文件指纹、
 * 坏索引/版本不符时的整表重建、`load` 的字段校验、rebuild、dispose、并发 sync；
 * 以及 `index.ts` 的工具参数校验、命中/空结果文案、`/search` 命令与设置分区保存。
 *
 * 环境隔离：索引目录与会话根都从 `dscPath()` 派生，而路径策略在模块加载时算 `DSC_HOME`，
 * 所以先把它指到 `mkdtempSync` 的临时目录，再动态 import；每个用例前清空会话与缓存。
 *
 * @module @pneuma/session-search/tests/index-extra
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { SettingsSectionSpec, SettingsValue, SettingsValues, SessionSearchService } from '@pneuma/runtime/services/types.js'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-session-index-extra-'))
const sessionsDir = join(home, 'sessions')
const cacheDir = join(home, 'cache')

let api: typeof import('../session-index.js')
let mod: typeof import('../index.js')

beforeAll(async () => {
  process.env.DSC_HOME = home
  api = await import('../session-index.js')
  mod = await import('../index.js')
})

afterAll(() => {
  delete process.env.DSC_HOME
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

beforeEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  rmSync(join(home, 'plugins.json'), { force: true, maxRetries: 5, retryDelay: 50 })
  mkdirSync(sessionsDir, { recursive: true })
})

type Row = Record<string, unknown>

/** 写一个会话文件；默认第一行是 meta（id / cwd / createdAt 都可覆盖），返回绝对路径。 */
function writeSession(
  id: string,
  records: readonly Row[],
  options: { dir?: string; root?: string; meta?: Row | false } = {},
): string {
  const dir = options.dir ?? 'ws'
  const folder = join(options.root ?? sessionsDir, dir)
  mkdirSync(folder, { recursive: true })
  const rows = records.map((record) => JSON.stringify(record))
  if (options.meta !== false) {
    rows.unshift(JSON.stringify({ type: 'meta', id, cwd: `/ws/${dir}`, ...(options.meta ?? {}) }))
  }
  const file = join(folder, `${id}.jsonl`)
  writeFileSync(file, `${rows.join('\n')}\n`, 'utf8')
  return file
}

/** 一份指向临时缓存目录的索引。 */
function open(overrides: Partial<import('../session-index.js').SessionIndexOptions> = {}) {
  const index = new api.SessionIndex({ ...api.defaultSessionIndexOptions(), indexDir: cacheDir, ...overrides })
  index.load()
  return index
}

const idsOf = (hits: readonly import('../session-index.js').SessionIndexHit[]): string[] => hits.map((hit) => hit.sessionId)

// ── 落盘与命中 ───────────────────────────────────────────────────────────────

test('sync 建索引并落盘：统计、索引路径、版本号都对，临时文件不留下', async () => {
  writeSession('sess-alpha', [{ type: 'user', text: 'alpha memory leak', ts: 10 }])
  const index = open()
  expect(index.indexPath()).toBe(join(cacheDir, api.SESSION_INDEX_FILE))
  expect(await index.sync()).toBe(1)

  const stats = index.stats()
  expect(stats.files).toBe(1)
  expect(stats.terms).toBe(3) // alpha / memory / leak
  expect(stats.updatedAt).toBeGreaterThan(0)

  const stored = JSON.parse(readFileSync(index.indexPath(), 'utf8')) as { version: number }
  expect(stored.version).toBe(api.SESSION_INDEX_VERSION)
  expect(existsSync(`${index.indexPath()}.tmp`)).toBe(false)
})

test('search 命中给出可直接跳转的字段：会话 id、工作区、角色、时间、行号与片段', async () => {
  const file = writeSession('sess-hit', [
    { type: 'user', text: 'needle in a haystack', ts: 500 },
    { type: 'assistant', text: 'other row', ts: 600 },
  ])
  const index = open()
  const hits = await index.search('needle')
  expect(hits).toHaveLength(1)
  expect(hits[0]).toMatchObject({
    sessionId: 'sess-hit',
    file,
    cwd: '/ws/ws',
    role: 'user',
    ts: 500,
    line: 2,
  })
  expect(hits[0]?.snippet).toBe('needle in a haystack')
  expect(hits[0]?.fuzzy).toBeUndefined()
})

test('记录没带 ts 时回落到 meta.createdAt，连它也没有就是 0；没有 meta 时 sessionId 退回文件名', async () => {
  writeSession('with-created', [{ type: 'user', text: 'fallbackword' }], { meta: { createdAt: 111 } })
  writeSession('no-meta', [{ type: 'user', text: 'fallbackword' }], { meta: false })
  const index = open()
  const hits = await index.search('fallbackword')
  expect(hits.map((hit) => [hit.sessionId, hit.ts])).toEqual([
    ['with-created', 111],
    ['no-meta', 0],
  ])
})

test('坏行与不进正文的记录都跳过，同一文件其余行照常可搜', async () => {
  writeSession('sess-bad', [
    { type: 'system', text: 'needle system' },
    { type: 'user', text: '   ' },
    { type: 'user' },
    { type: 'user', text: 'needle live' },
  ])
  // 手工插入坏 JSON 与数组行。
  const file = join(sessionsDir, 'ws', 'sess-bad.jsonl')
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
  lines.splice(1, 0, 'not json', '[]')
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')

  const index = open()
  const hits = await index.search('needle')
  expect(hits).toHaveLength(1)
  expect(hits[0]?.sessionId).toBe('sess-bad')
  expect(hits[0]?.role).toBe('user')
  // 插入两行后，真正的正文从第 7 行开始（meta 1、坏 JSON 2、[] 3、system 4、空白 5、无 text 6）。
  expect(hits[0]?.line).toBe(7)
})

test('四种正文记录都进索引，其它类型不进；结果按时间倒序', async () => {
  writeSession('sess-roles', [
    { type: 'user', text: 'roleword', ts: 1 },
    { type: 'assistant', text: 'roleword', ts: 2 },
    { type: 'tool', text: 'roleword', ts: 3 },
    { type: 'summary', text: 'roleword', ts: 4 },
    { type: 'system', text: 'roleword', ts: 5 },
  ])
  const index = open()
  const hits = await index.search('roleword')
  expect(hits.map((hit) => hit.role)).toEqual(['summary', 'tool', 'assistant', 'user'])
})

test('排序稳定：时间新的在前，同一时间按文件路径与行号排', async () => {
  writeSession('a', [
    { type: 'user', text: 'zebra new', ts: 2_000 },
    { type: 'assistant', text: 'zebra old', ts: 1_000 },
  ])
  writeSession('b', [{ type: 'user', text: 'zebra tie', ts: 2_000 }])
  const index = open()
  const hits = await index.search('zebra')
  expect(hits.map((hit) => `${hit.sessionId}:${hit.line}`)).toEqual(['a:2', 'b:2', 'a:3'])
})

test('limit 与 defaultLimit：0 或负数返回空，缺省走配置值', async () => {
  writeSession('sess-limit', [
    { type: 'user', text: 'zebra one', ts: 1 },
    { type: 'user', text: 'zebra two', ts: 2 },
    { type: 'user', text: 'zebra three', ts: 3 },
  ])
  const index = open({ defaultLimit: 1 })
  expect((await index.search('zebra')).map((hit) => hit.ts)).toEqual([3])
  expect((await index.search('zebra', { limit: 2 })).map((hit) => hit.ts)).toEqual([3, 2])
  expect(await index.search('zebra', { limit: 0 })).toEqual([])
  expect(await index.search('zebra', { limit: -3 })).toEqual([])
})

test('cwd 过滤只留目标工作区的会话，不传就全给', async () => {
  writeSession('wsa', [{ type: 'user', text: 'cwdword', ts: 1 }], { dir: 'a' })
  writeSession('wsb', [{ type: 'user', text: 'cwdword', ts: 2 }], { dir: 'b' })
  const index = open()
  expect(new Set(idsOf(await index.search('cwdword')))).toEqual(new Set(['wsa', 'wsb']))
  expect(idsOf(await index.search('cwdword', { cwd: '/ws/a' }))).toEqual(['wsa'])
})

// ── 区域可见性 ───────────────────────────────────────────────────────────────

test('归档区默认不收，打开 includeArchived 后收进来', async () => {
  writeSession('archived-one', [{ type: 'user', text: 'archivedword' }], {
    dir: 'ws',
    root: join(sessionsDir, '.archived'),
  })
  expect(await open().search('archivedword')).toEqual([])
  const withArchived = open({ includeArchived: true })
  expect(idsOf(await withArchived.search('archivedword'))).toEqual(['archived-one'])
  // 单次查询的 includeArchived 覆盖配置：即便索引收过归档，本次也能要求不看。
  expect(await withArchived.search('archivedword', { includeArchived: false })).toEqual([])
})

test('回收站与队友日志默认不收，打开 includeHiddenDirs 后按 hidden 区收进来', async () => {
  writeSession('trash-one', [{ type: 'user', text: 'hiddenword' }], { dir: 'ws', root: join(home, '.trash') })
  writeSession('mate-one', [{ type: 'user', text: 'hiddenword' }], { dir: 'ws', root: join(sessionsDir, '.teammates') })
  expect(await open().search('hiddenword')).toEqual([])
  expect(new Set(idsOf(await open({ includeHiddenDirs: true }).search('hiddenword')))).toEqual(
    new Set(['trash-one', 'mate-one']),
  )
})

// ── 增量 ─────────────────────────────────────────────────────────────────────

test('增量对齐：追加内容后只重解析变了的文件，旧词照旧命中；整文件改写后旧词消失', async () => {
  const file = writeSession('sess-inc', [{ type: 'user', text: 'alpha' }])
  const index = open()
  expect(await index.sync()).toBe(1)
  expect(idsOf(await index.search('alpha'))).toEqual(['sess-inc'])

  writeSession('sess-inc', [
    { type: 'user', text: 'alpha' },
    { type: 'user', text: 'beta' },
  ])
  expect(statSync(file).size).toBeGreaterThan(0)
  expect(await index.sync()).toBe(1)
  expect(idsOf(await index.search('beta'))).toEqual(['sess-inc'])
  expect(idsOf(await index.search('alpha'))).toEqual(['sess-inc'])
  expect(index.stats().files).toBe(1)

  writeSession('sess-inc', [{ type: 'user', text: 'gamma' }])
  expect(await index.sync()).toBe(1)
  expect(await index.search('alpha')).toEqual([])
  expect(idsOf(await index.search('gamma'))).toEqual(['sess-inc'])
})

test('盘上已经没有的文件撤下它的行：检索立刻搜不到，统计归零', async () => {
  const file = writeSession('sess-gone', [{ type: 'user', text: 'goneword' }])
  const index = open()
  await index.sync()
  expect(idsOf(await index.search('goneword'))).toEqual(['sess-gone'])

  rmSync(file)
  expect(await index.sync()).toBe(0)
  expect(index.stats().files).toBe(0)
  expect(await index.search('goneword')).toEqual([])
})

test('超过 maxFileBytes 的文件只记指纹不解析正文，文件数仍算一个', async () => {
  writeSession('sess-big', [{ type: 'user', text: 'bigword '.repeat(20) }])
  const index = open({ maxFileBytes: 16 })
  expect(await index.sync()).toBe(1)
  expect(index.stats().files).toBe(1)
  expect(index.stats().terms).toBe(0)
  expect(await index.search('bigword')).toEqual([])
})

// ── 坏索引 / 载入校验 ────────────────────────────────────────────────────────

test('索引文件是坏 JSON 时整表重建，会话历史不受影响', async () => {
  writeSession('sess-corrupt', [{ type: 'user', text: 'corruptword' }])
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, api.SESSION_INDEX_FILE), 'not json at all', 'utf8')
  const index = open()
  expect(await index.sync()).toBe(1)
  expect(idsOf(await index.search('corruptword'))).toEqual(['sess-corrupt'])
  const stored = JSON.parse(readFileSync(index.indexPath(), 'utf8')) as { version: number }
  expect(stored.version).toBe(api.SESSION_INDEX_VERSION)
})

test('索引版本对不上时同样整表重建', async () => {
  writeSession('sess-version', [{ type: 'user', text: 'versionword' }])
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(
    join(cacheDir, api.SESSION_INDEX_FILE),
    JSON.stringify({ version: 999, updatedAt: 1, files: [], docs: [], terms: {} }),
    'utf8',
  )
  const index = open()
  expect(await index.sync()).toBe(1)
  expect(idsOf(await index.search('versionword'))).toEqual(['sess-version'])
  const stored = JSON.parse(readFileSync(index.indexPath(), 'utf8')) as { version: number }
  expect(stored.version).toBe(api.SESSION_INDEX_VERSION)
})

test('load 逐项校验落盘索引：空路径/越界文档/坏词表都丢掉，其余照常可搜', async () => {
  const file = writeSession('stored-id', [{ type: 'user', text: 'hello from index', ts: 5 }], { meta: false })
  const stat = statSync(file)
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(
    join(cacheDir, api.SESSION_INDEX_FILE),
    JSON.stringify({
      version: api.SESSION_INDEX_VERSION,
      updatedAt: 123,
      files: [
        { path: file, sessionId: 'stored-id', cwd: '/ws/stored', mtimeMs: stat.mtimeMs, size: stat.size, zone: 'active', parsedAt: 9 },
        { path: '', sessionId: 'dropped' },
      ],
      docs: [
        { file: 0, line: 1, role: 'user', ts: 5, text: 'hello from index' },
        { file: 7, line: 2, role: 'user', ts: 1, text: 'out of range' },
      ],
      terms: {
        hello: { 0: [1], 7: [9] },
        bad: { 0: 'not-an-array' },
        empty: { 0: [] },
      },
    }),
    'utf8',
  )
  const index = open()
  expect(index.stats()).toEqual({ files: 1, terms: 1, updatedAt: 123 })
  const hits = await index.search('hello')
  expect(hits).toHaveLength(1)
  expect(hits[0]).toMatchObject({ sessionId: 'stored-id', cwd: '/ws/stored', ts: 5, line: 1 })
})

test('从磁盘 load 回来的索引能直接检索，统计与落盘时间原样保留', async () => {
  writeSession('sess-persist', [{ type: 'user', text: 'persistword' }])
  const first = open()
  await first.sync()
  const before = first.stats()

  const second = open()
  expect(second.stats()).toEqual(before)
  expect(idsOf(await second.search('persistword'))).toEqual(['sess-persist'])
})

test('rebuild 丢掉整张表重来：旧词消失，新内容当场可搜', async () => {
  writeSession('sess-rebuild', [{ type: 'user', text: 'oldword' }])
  const index = open()
  await index.sync()
  expect(idsOf(await index.search('oldword'))).toEqual(['sess-rebuild'])

  writeSession('sess-rebuild', [{ type: 'user', text: 'newword' }])
  await index.rebuild()
  expect(await index.search('oldword')).toEqual([])
  expect(idsOf(await index.search('newword'))).toEqual(['sess-rebuild'])
})

test('dispose 之后 sync 立即返回 0，内存里的旧结果仍可读，不再重扫', async () => {
  writeSession('sess-dispose', [{ type: 'user', text: 'disposeword' }])
  const index = open()
  await index.sync()
  index.dispose()
  expect(await index.sync()).toBe(0)
  expect(idsOf(await index.search('disposeword'))).toEqual(['sess-dispose'])
})

test('并发 sync 共用同一次对齐，不会重复扫目录', async () => {
  writeSession('sess-concurrent', [{ type: 'user', text: 'concurrentword' }])
  const index = open()
  const first = index.sync()
  const second = index.sync()
  expect(second).toBe(first)
  expect(await first).toBe(1)
})

// ── 切词与片段 ───────────────────────────────────────────────────────────────

test('CJK 判定与切词边界：假名/谚文/扩展 B 都算中文，英文统一小写并按非字母数字断开', () => {
  expect(api.isCjkChar('あ')).toBe(true)
  expect(api.isCjkChar('한')).toBe(true)
  expect(api.isCjkChar('𠀀')).toBe(true)
  expect(api.isCjkChar('A')).toBe(false)
  expect(new Set(api.documentTerms('Hello,世界!'))).toEqual(new Set(['hello', '世', '界', '世界']))
  expect(api.queryTerms('Hello 世界')).toEqual(['hello', '世界'])
  expect(api.queryGroups('')).toEqual([])
  expect(api.relaxable([])).toBe(false)
})

test('命中片段压平空白；长行以第一个命中词为中心截断并加省略号', async () => {
  writeSession('sess-snippet', [
    { type: 'user', text: 'alpha   beta needle', ts: 2 },
    { type: 'user', text: `${'x'.repeat(100)} needle ${'y'.repeat(100)}`, ts: 1 },
  ])
  const index = open({ snippetLength: 40 })
  const hits = await index.search('needle')
  const short = hits.find((hit) => hit.line === 2)
  expect(short?.snippet).toBe('alpha beta needle')
  const long = hits.find((hit) => hit.line === 3)
  expect(long?.snippet.startsWith('…')).toBe(true)
  expect(long?.snippet.endsWith('…')).toBe(true)
  expect(long?.snippet).toContain('needle')
})

// ── 装配面：index.ts ────────────────────────────────────────────────────────

/**
 * 本文件的装配实现是同步的（`index.ts` 的 `values`、`save`、`action` 都直接返回值），而契约
 * 声明的是 `MaybePromise`、`save` / `action` 还是可选的。这里按实现收窄一次。
 */
type SyncSection = Omit<SettingsSectionSpec, 'values' | 'save' | 'action'> & {
  values(): SettingsValues
  save(key: string, value: SettingsValue): string | void
  action(name: string): string | void
}

interface SearchState {
  tool?: ToolEntry
  command?: { name: string; args?: string; description?: string }
  commandHandler?: (args: { args: string[]; ui: { notice(text: string): void } }) => void
  section?: SyncSection
  services: Record<string, SessionSearchService>
  system: string[]
  offCalls: number
}

/** 一份够 apply 用的假 ctx：注册结果收集起来，不模拟 cordis 的 Fiber。 */
function mountSearch(): { state: SearchState; dispose: () => void } {
  const state: SearchState = { services: {}, system: [], offCalls: 0 }
  const off = (): void => {
    state.offCalls += 1
  }
  const ctx = {
    get: () => undefined,
    emit: () => {},
    transcript: { system: (text: string) => state.system.push(text) },
    session: { current: () => ({ meta: { cwd: home } }) },
    provide: (name: string, value: SessionSearchService) => {
      state.services[name] = value
      return off
    },
    tools: {
      register: (entry: ToolEntry) => {
        state.tool = entry
        return off
      },
    },
    commands: {
      register: (spec: NonNullable<SearchState['command']>, handler: NonNullable<SearchState['commandHandler']>) => {
        state.command = spec
        state.commandHandler = handler
        return off
      },
    },
    settings: {
      registerSection: (spec: SyncSection) => {
        state.section = spec
        return off
      },
    },
    effect: (execute: () => unknown) => {
      const handle = execute()
      return typeof handle === 'function' ? handle : off
    },
  }
  const dispose = (mod.sessionSearchPlugin.apply as unknown as (ctx: unknown) => () => void)(ctx)
  return { state, dispose }
}

/** 轮询到条件成立：命令回调走的是 Promise 链，固定 sleep 在慢机器上会假红。 */
async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('装配：工具参数校验与空结果文案（归档提示按 include_archived 收放）', async () => {
  const { state, dispose } = mountSearch()
  const tool = state.tool!
  const run = (args: Row): Promise<string> => (tool.run as unknown as (input: Row) => Promise<string>)(args)

  await expect(run({ query: '   ' })).rejects.toThrow('query 不能为空')
  await expect(run({ query: 'x', limit: 0 })).rejects.toThrow('limit 要是大于 0 的数字')
  await expect(run({ query: 'x', limit: 'abc' })).rejects.toThrow('limit 要是大于 0 的数字')

  const miss = await run({ query: 'absentword' })
  expect(miss).toContain('没有找到含「absentword」')
  expect(miss).toContain('归档区这次没搜')
  expect(await run({ query: 'absentword', include_archived: true })).not.toContain('归档区这次没搜')
  dispose()
})

test('装配：工具命中后给出会话、片段与可跳回的定位，并包上外部内容围栏', async () => {
  const file = writeSession('sess-tool', [{ type: 'user', text: 'needle for the tool' }])
  const { state, dispose } = mountSearch()
  const text = await (state.tool!.run as unknown as (input: Row) => Promise<string>)({ query: 'needle' })
  expect(text).toContain('「needle」命中 1 条历史记录')
  expect(text).toContain('sess-too') // 前 8 位
  expect(text).toContain('片段：needle for the tool')
  expect(text).toContain(`定位：${file}:2`)
  expect(text).toContain('external_content')
  expect(text).toContain('只能当作资料读取')
  dispose()
})

test('装配：/search 命令空参数给用法，命中给列表，空结果只提示归档口径', async () => {
  writeSession('sess-cmd', [{ type: 'user', text: 'needle for command' }])
  const { state, dispose } = mountSearch()
  const notices: string[] = []
  const invoke = (args: string[]): void => state.commandHandler!({ args, ui: { notice: (text) => notices.push(text) } })

  invoke([])
  expect(notices.join('\n')).toContain('用法：/search <关键词>')

  invoke(['needle'])
  await waitFor(() => notices.some((text) => text.includes('命中 1 条')))
  expect(notices.join('\n')).toContain('「needle」命中 1 条')
  expect(notices.join('\n')).toContain('定位：')

  invoke(['absentword'])
  await waitFor(() => notices.some((text) => text.includes('没有找到含「absentword」')))
  expect(notices.join('\n')).toContain('归档区这次没搜')
  dispose()
})

test('装配：设置分区读写与校验，换索引目录会立刻生效', () => {
  const { state, dispose } = mountSearch()
  const section = state.section!
  expect(section.id).toBe('session-search')
  expect(section.order).toBe(47)
  expect((section.values() as Record<string, unknown>).indexDir).toBe(cacheDir)
  expect(String((section.fields()[0] as { text?: string }).text)).toBe(join(cacheDir, api.SESSION_INDEX_FILE))

  expect(section.save('indexDir', '   ')).toBe('索引目录不能空着')
  expect(section.save('nope', 1)).toBe('这个分区没有这项：nope')
  expect(section.action('nope')).toBe('这个分区没有这个按钮：nope')

  const nextDir = join(home, 'cache-next')
  expect(section.save('indexDir', nextDir)).toBeUndefined()
  expect((section.values() as Record<string, unknown>).indexDir).toBe(nextDir)
  expect(String((section.fields()[0] as { text?: string }).text)).toBe(join(nextDir, api.SESSION_INDEX_FILE))

  expect(section.save('includeArchived', true)).toBeUndefined()
  expect((section.values() as Record<string, unknown>).includeArchived).toBe(true)
  expect(String(section.action('rebuild'))).toContain('已经开始重建索引')
  expect(state.services['sessionSearch']).toBeDefined()
  dispose()
  expect(state.offCalls).toBeGreaterThanOrEqual(4)
})
