/**
 * session-search 补测（W14）：补 `session-index.ts` 与 `index.ts` 的边角分支。
 *
 * 覆盖目标（对照 W14 缺口清单）：
 * - `session-index.ts`：单字段查询分组（`queryGroups` 的 `run.length === 1`）、倒排表求交集
 *   的两个方向、命中排序的同文件行号兜底、分批回填的 `yieldToHost`、根目录下直接放的
 *   jsonl、多组查询的宽松召回（组内缺失即淘汰、命中计数累加）、扫描时目录项已失效、
 *   索引落盘失败只影响下次启动；
 * - `index.ts`：后台回填失败时报一条错、服务的三个方法、工具 `limit` 上限夹取、
 *   `/search` 检索失败的兜底文案、设置分区五个数值/开关的保存分支、有索引时状态文案里的
 *   时间格式化。
 *
 * 环境隔离：索引目录与会话根都从 `dscPath()` 派生，而路径策略在模块加载时算 `DSC_HOME`，
 * 所以先把 `DSC_HOME` 指到 `mkdtempSync` 的临时目录，再动态 import；每个用例前清空会话与
 * 缓存。真实 `~/.dsc` 一个字节都不碰。
 *
 * @module @pneuma/session-search/tests/w14-index-edges
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { SettingsSectionSpec, SettingsValue, SettingsValues, SessionSearchService } from '@pneuma/runtime/services/types.js'
import { afterAll, beforeEach, expect, test, vi } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-session-search-w14-'))
const sessionsDir = join(home, 'sessions')
const cacheDir = join(home, 'cache')
process.env.DSC_HOME = home

const api = await import('../session-index.js')
const mod = await import('../index.js')

afterAll(() => {
  delete process.env.DSC_HOME
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

beforeEach(() => {
  vi.restoreAllMocks()
  rmSync(sessionsDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })
  rmSync(cacheDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })
  rmSync(join(home, 'plugins.json'), {
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })
  mkdirSync(sessionsDir, { recursive: true })
})

type Row = Record<string, unknown>

/** 写一个会话文件；默认第一行是 meta，`dir` 给 `'.'` 表示直接放在会话根下。 */
function writeSession(
  id: string,
  records: readonly Row[],
  options: { dir?: string; root?: string; meta?: Row | false } = {},
): string {
  const dir = options.dir ?? 'ws'
  const folder = join(options.root ?? sessionsDir, dir)
  mkdirSync(folder, { recursive: true })
  const rows = records.map((record) => JSON.stringify(record))
  if (options.meta !== false)
    rows.unshift(
      JSON.stringify({
        type: 'meta',
        id,
        cwd: `/ws/${dir}`,
        ...(options.meta ?? {}),
      }),
    )
  const file = join(folder, `${id}.jsonl`)
  writeFileSync(file, `${rows.join('\n')}\n`, 'utf8')
  return file
}

/** 一份指向临时缓存目录的索引。 */
function open(overrides: Partial<import('../session-index.js').SessionIndexOptions> = {}) {
  const index = new api.SessionIndex({
    ...api.defaultSessionIndexOptions(),
    indexDir: cacheDir,
    ...overrides,
  })
  index.load()
  return index
}

// ── session-index.ts ────────────────────────────────────────────────────────

test('queryGroups：单个汉字自成一组（run.length === 1）', () => {
  expect(api.queryGroups('内')).toEqual([{ terms: ['内'], need: 1 }])
  // 两字词去重后只剩一个两字项：短段要求全中。
  expect(api.queryGroups('内存')).toEqual([{ terms: ['内存'], need: 1 }])
})

test('倒排表求交集：两个词项行号错开时两个方向都能正确收尾', async () => {
  writeSession('sess-intersect', [
    { type: 'user', text: 'alpha only', ts: 1 },
    { type: 'user', text: 'lemon only', ts: 2 },
  ])
  const index = open()
  // 左表更靠前：a < b 分支推进左指针。
  expect(await index.search('alpha lemon')).toEqual([])
  // 左表更靠后：a > b 分支推进右指针。
  expect(await index.search('lemon alpha')).toEqual([])
})

test('命中排序：同文件同一时间的两条按行号升序，顺序稳定', async () => {
  writeSession(
    'sess-tie',
    [
      { type: 'user', text: 'needle first' },
      { type: 'user', text: 'needle second' },
    ],
    { meta: { createdAt: 100 } },
  )
  const index = open()
  const hits = await index.search('needle')
  expect(hits.map((hit) => hit.line)).toEqual([2, 3])
  expect(hits.map((hit) => hit.ts)).toEqual([100, 100])
})

test('分批回填在批与批之间让出事件循环：backfillBatch=1、两个文件也能全部索引', async () => {
  writeSession('sess-yield-a', [{ type: 'user', text: 'yieldword alpha', ts: 1 }])
  writeSession('sess-yield-b', [{ type: 'user', text: 'yieldword beta', ts: 2 }], { dir: 'ws2' })
  const index = open({ backfillBatch: 1 })
  expect(await index.sync()).toBe(2)
  const hits = await index.search('yieldword')
  expect(hits).toHaveLength(2)
})

test('会话根下直接放的 jsonl 也收（不只在工作目录子目录里找）', async () => {
  writeSession('sess-root-level', [{ type: 'user', text: 'rootlevelword', ts: 1 }], { dir: '.' })
  const index = open()
  expect(await index.sync()).toBe(1)
  const hits = await index.search('rootlevelword')
  expect(hits.map((hit) => hit.sessionId)).toEqual(['sess-root-level'])
})

test('扫描时目录项已失效（悬空链接）：跳过它，不影响同区其它会话', async () => {
  writeSession('sess-alive', [{ type: 'user', text: 'aliveword', ts: 1 }])
  // 指向不存在目录的链接：readdir 能看到名字，stat 时已经 ENOENT。
  symlinkSync(
    join(home, 'w14-missing-dir'),
    join(sessionsDir, 'dangling-entry'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const index = open()
  expect(await index.sync()).toBe(1)
  expect((await index.search('aliveword')).map((hit) => hit.sessionId)).toEqual(['sess-alive'])
})

test('宽松召回：多组查询里缺组的候选被淘汰，两组都命中的候选累计得分并标模糊', async () => {
  // 查询「内存占用 qqq」：中文段切出 内存/存占/占用（need=2），英文组只有 qqq。
  writeSession('sess-relax', [
    { type: 'user', text: '内存占 qqq', ts: 2 },
    { type: 'user', text: '内存占 但没英文词', ts: 1 },
    { type: 'user', text: 'qqq only', ts: 3 },
  ])
  const index = open()
  const hits = await index.search('内存占用 qqq')
  // 严格 AND 一条都没有 → 走宽松召回；只有同时凑齐中文组与英文组的那一行入选。
  expect(hits).toHaveLength(1)
  expect(hits[0]?.line).toBe(2)
  expect(hits[0]?.fuzzy).toBe(true)
})

test('索引落盘失败（indexDir 是文件）：这一次检索照常，状态里 updatedAt 保持 0', async () => {
  writeSession('sess-save-fail', [{ type: 'user', text: 'savefailword', ts: 1 }])
  const blockedDir = join(home, 'cache-is-a-file')
  writeFileSync(blockedDir, 'not a directory\n', 'utf8')
  const index = new api.SessionIndex({
    ...api.defaultSessionIndexOptions(),
    indexDir: blockedDir,
  })
  index.load()
  expect(await index.sync()).toBe(1)
  expect(index.stats().updatedAt).toBe(0)
  // 内存里的索引仍然能查。
  expect((await index.search('savefailword')).map((hit) => hit.sessionId)).toEqual(['sess-save-fail'])
})

// ── index.ts（插件运行面）───────────────────────────────────────────────────

/** 插件命令处理器收到的参数（本插件只读 `args` 与 `ui.notice`）。 */
interface CommandCall {
  args: string[]
  ui: { notice: (text: string) => void }
}

interface Mounted {
  service: SessionSearchService
  tool: ToolEntry
  command: (call: CommandCall) => void
  section: SettingsSectionSpec
  /** `transcript.system` 收到的提示（后台回填失败的报错走这里）。 */
  systems: string[]
  dispose: () => void
}

/** 装一次插件。桩 ctx 只提供 apply 用到的面。 */
function mount(config: Record<string, unknown> = {}): Mounted {
  const mounted: Mounted = {
    service: undefined as never,
    tool: undefined as never,
    command: () => {
      throw new Error('插件没有注册 /search 命令')
    },
    section: undefined as never,
    systems: [],
    dispose: () => undefined,
  }
  const stub = {
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
    tools: {
      register(spec: ToolEntry) {
        mounted.tool = spec
        return () => {}
      },
    },
    commands: {
      register(_meta: Record<string, unknown>, handler: (call: CommandCall) => void) {
        mounted.command = handler
        return () => {}
      },
    },
    settings: {
      registerSection(spec: SettingsSectionSpec) {
        mounted.section = spec
        return () => {}
      },
    },
    transcript: {
      system: (text: string) => {
        mounted.systems.push(text)
      },
    },
    session: {
      current: () => ({ meta: { id: 'w14-session', cwd: '/ws/ws' } }),
    },
    provide: (_name: string, service: SessionSearchService) => {
      mounted.service = service
      return () => {}
    },
  }
  mounted.dispose = mod.sessionSearchPlugin.apply(stub as never, config) as unknown as () => void
  return mounted
}

test('后台回填失败：插件往会话流报一条「会话索引没能建起来」而不是静默', async () => {
  vi.spyOn(api.SessionIndex.prototype, 'sync').mockRejectedValueOnce(new Error('索引盘坏了'))
  const wired = mount()
  await vi.waitFor(() => {
    expect(wired.systems).toHaveLength(1)
  })
  expect(wired.systems[0]).toContain('会话索引没能建起来')
  expect(wired.systems[0]).toContain('索引盘坏了')
  wired.dispose()
})

test('服务三方法可用；工具把 limit 夹到上限；有索引时状态文案带格式化时间', async () => {
  writeSession('sess-plugin', [{ type: 'user', text: 'pluginhit', ts: 1 }])
  const wired = mount()
  // 挂载后台跑 sync；等它落盘成功（updatedAt > 0）再读设置面。
  await vi.waitFor(() => {
    expect(wired.service.stats().updatedAt).toBeGreaterThan(0)
  })
  const hits = await wired.service.search('pluginhit')
  expect(hits.map((hit) => hit.sessionId)).toEqual(['sess-plugin'])
  // limit 传一个天文数字：夹到 SESSION_INDEX_BOUNDS.defaultLimit.max，不抛错。
  const text = await (wired.tool.run as (args: unknown) => Promise<string>)({
    query: 'pluginhit',
    limit: 1_000_000,
  })
  expect(text).toContain('命中 1 条')
  await wired.service.rebuild()
  await vi.waitFor(() => {
    expect(wired.service.stats().files).toBe(1)
  })
  const stateText = (
    wired.section.fields() as Array<{
      label?: string
      text?: string
      key?: string
    }>
  ).find((field) => field.text?.includes('·') && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(field.text ?? ''))
  expect(stateText?.text, '索引状态要带上「上次更新时间」这种可读时间').toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  wired.dispose()
})

test('/search 检索失败：命令处理器把错误变成一句可读文案', async () => {
  const wired = mount()
  vi.spyOn(api.SessionIndex.prototype, 'search').mockRejectedValueOnce(new Error('索引读坏了'))
  const notices: string[] = []
  wired.command({
    args: ['needle'],
    ui: { notice: (text) => notices.push(text) },
  })
  await vi.waitFor(() => {
    expect(notices).toHaveLength(1)
  })
  expect(notices[0]).toBe('检索失败：索引读坏了')
  wired.dispose()
})

test('设置分区 save：五个可调项都走保存分支，保存后 values 反映新值', () => {
  const wired = mount()
  const section = wired.section as unknown as {
    values: () => SettingsValues
    save: (key: string, value: SettingsValue) => string | void
  }
  expect(section.save('includeHiddenDirs', true)).toBeUndefined()
  expect(section.values().includeHiddenDirs).toBe(true)
  expect(section.save('maxFileBytes', 1024 * 1024)).toBeUndefined()
  expect(section.values().maxFileBytes).toBe(1024 * 1024)
  expect(section.save('snippetLength', 120)).toBeUndefined()
  expect(section.values().snippetLength).toBe(120)
  expect(section.save('backfillBatch', 4)).toBeUndefined()
  expect(section.values().backfillBatch).toBe(4)
  expect(section.save('defaultLimit', 7)).toBeUndefined()
  expect(section.values().defaultLimit).toBe(7)
  // 未知键返回文案，不抛。
  expect(typeof section.save('w14-unknown', 1)).toBe('string')
  wired.dispose()
})
