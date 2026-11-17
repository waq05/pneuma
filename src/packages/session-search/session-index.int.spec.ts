/**
 * 历史会话检索「宽松召回」的用例（迁自 `scripts/session-index-fuzzy-test.mjs`）。
 *
 * 严格口径按相邻两字 AND，等于要求原文里逐字相邻——「内存占用过高」搜不到
 * 「内存占用一直很高」。宽松口径只在**严格一条都没有**时启用：按每组命中过半两字词算成立，
 * 结果带 `fuzzy` 标记，调用方要说明「模糊命中，请核对原文」（2026-10-30 用户拍板 B 方案）。
 *
 * 钉住七件事：
 *   [1] 严格口径真的搜不到（前提成立，否则测不到兜底）；
 *   [2] 兜底能召回换了说法的句子，且带 fuzzy 标记；
 *   [3] `fuzzy:false` 关掉兜底时仍然一条不返回；
 *   [4] 只共享一个两字词的句子不算命中（避免「多数」退化成「沾边就算」）；
 *   [5] 严格能命中时不走兜底（结果不带 fuzzy，原有行为不变）；
 *   [6] 分组切法本身：长段要过半、短段要全中、英文整词单独一组；
 *   [7] 查询里重复的字符只算一个两字词，不能靠重复计数凑满阈值、凭空召回。
 *
 * ## 为什么这一组也要起内核
 *
 * 索引读的是**磁盘上的会话日志**，日志形状由内核决定；最后一组用真内核跑一个回合，
 * 证明「刚写完的会话当场就能被搜到」，而不是只有手工铺的夹具才进得了索引。
 *
 * @module dsc/packages/session-search/session-index.int.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'

/** 临时主目录；必须在任何内核模块被加载之前换好。 */
const home = tempHome()

let kernel: BootedKernel
let fake: FakeLLM
let core: typeof import('@pneuma/runtime/core/session.js')
let searchApi: typeof import('@pneuma/runtime/packages/session-search/session-index.js')
let index: InstanceType<typeof searchApi.SessionIndex>

/** 每个夹具一个工作目录：`cwd` 过滤是「换了个说法」这组用例的前提。 */
const dirOf = (name: string): string => join(home.home, name)

/** 写一个会话文件：meta 行 + 若干 user 行。 */
function writeSession(id: string, cwdName: string, texts: string[]): void {
  const cwd = dirOf(cwdName)
  mkdirSync(cwd, { recursive: true })
  const dir = join(core.sessionsRoot(), core.slugCwd(cwd))
  mkdirSync(dir, { recursive: true })
  const rows = [JSON.stringify({ type: 'meta', id, cwd })]
  texts.forEach((text, at) => rows.push(JSON.stringify({ type: 'user', text, ts: 1_000 + at })))
  writeFileSync(join(dir, `${id}.jsonl`), `${rows.join('\n')}\n`, 'utf8')
}

beforeAll(async () => {
  core = await import('@pneuma/runtime/core/session.js')
  searchApi = await import('@pneuma/runtime/packages/session-search/session-index.js')
  writeSession('sess-loosely', 'ws-a', ['内存占用一直很高，机器很卡'])
  writeSession('sess-narrow', 'ws-b', ['内存很卡'])
  writeSession('sess-strict', 'ws-c', ['内存占用过高，已经重启过'])
  writeSession('sess-mixed', 'ws-d', ['内存泄漏比较严重，用 leak 工具查过'])
  writeSession('sess-dup', 'ws-e', ['这里是重复的内容'])

  index = new searchApi.SessionIndex({
    ...searchApi.defaultSessionIndexOptions(),
    indexDir: join(home.home, '.dsc', 'cache'),
  })
  index.load()

  fake = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
})

afterAll(async () => {
  await kernel?.dispose()
  await fake?.close()
  home.restore()
})

describe('① 严格口径是前提', () => {
  test('「内存占用过高」只命中逐字出现的那条', async () => {
    const strict = await index.search('内存占用过高', { fuzzy: false })
    expect(strict.map((hit) => hit.sessionId)).toEqual(['sess-strict'])
  })

  test('严格命中的结果不带 fuzzy 标记', async () => {
    const strict = await index.search('内存占用过高', { fuzzy: false })
    expect(strict.every((hit) => hit.fuzzy !== true)).toBe(true)
  })

  test('换了说法的那个工作区里严格一条都没有', async () => {
    const strict = await index.search('内存占用过高', { fuzzy: false, cwd: dirOf('ws-a') })
    expect(strict).toHaveLength(0)
  })
})

describe('② 兜底召回', () => {
  test('能召回换了说法的句子，且带 fuzzy 标记', async () => {
    const hits = await index.search('内存占用过高', { cwd: dirOf('ws-a') })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.sessionId).toBe('sess-loosely')
    expect(hits[0]?.fuzzy).toBe(true)
  })

  test('fuzzy:false 时仍然一条都不返回（调用方可以只要严格结果）', async () => {
    const hits = await index.search('内存占用过高', { cwd: dirOf('ws-a'), fuzzy: false })
    expect(hits).toHaveLength(0)
  })

  test('只共享一个两字词的句子不算命中', async () => {
    // 「内存很卡」与「内存占用」只共有「内存」一个两字词：长段要过半才算成立，
    // 否则宽松召回会退化成「沾边就算」。
    const hits = await index.search('内存占用', { cwd: dirOf('ws-b') })
    expect(hits).toHaveLength(0)
  })

  test('中英混写：中文段过半 + 英文整词都在才算命中', async () => {
    const hits = await index.search('内存泄漏严重')
    expect(hits.some((hit) => hit.sessionId === 'sess-mixed' && hit.fuzzy === true)).toBe(true)
  })

  test('两字查询走严格口径（有命中且不带 fuzzy）', async () => {
    const hits = await index.search('内存')
    expect(hits.length).toBeGreaterThanOrEqual(3)
    expect(hits.every((hit) => hit.fuzzy !== true)).toBe(true)
  })
})

describe('③ 分组切法本身', () => {
  test('长中文段是一组：5 个两字词、过半算 3', () => {
    const groups = searchApi.queryGroups('内存占用过高')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.terms).toHaveLength(5)
    expect(groups[0]?.need).toBe(3)
  })

  test('短段要全中（2 字词：1 项、need 1）', () => {
    const groups = searchApi.queryGroups('内存')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.terms).toHaveLength(1)
    expect(groups[0]?.need).toBe(1)
  })

  test('4 字段：3 个两字词里命中过半（2 个）即成立', () => {
    const groups = searchApi.queryGroups('人工智能')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.terms).toHaveLength(3)
    expect(groups[0]?.need).toBe(2)
  })

  test('英文整词单独一组', () => {
    const groups = searchApi.queryGroups('内存 leak')
    expect(groups).toHaveLength(2)
    expect(groups[1]?.terms[0]).toBe('leak')
    expect(groups[1]?.need).toBe(1)
  })

  test('重复字符切出的两字词去重后只剩 2 项、need 2', () => {
    const groups = searchApi.queryGroups('重复重复重复')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.terms).toHaveLength(2)
    expect(groups[0]?.need).toBe(2)
  })

  test('重复字符的查询不靠重复计数凭空召回（严格 0 条，兜底也 0 条）', async () => {
    expect(await index.search('重复重复重复', { fuzzy: false })).toHaveLength(0)
    expect(await index.search('重复重复重复')).toHaveLength(0)
  })
})

describe('④ 真内核写出来的会话当场可搜', () => {
  test('跑一个回合之后，按会话正文能搜到它', async () => {
    await kernel.runTurn('内核写入：标题刷新验证')
    const ctx = kernel.ctx as unknown as { session: { current(): { filePath: string; meta: { id: string } } } }
    const current = ctx.session.current()

    const hits = await index.search('标题刷新验证')
    expect(hits.some((hit) => hit.sessionId === current.meta.id)).toBe(true)
    // 索引认的 id 与文件名同一个：两条来源对不上说明解析路径不一致。
    expect(current.meta.id).toBe(basename(current.filePath, '.jsonl'))
  })
})
