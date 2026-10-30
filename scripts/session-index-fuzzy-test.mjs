/**
 * 历史会话检索的宽松召回（2026-10-30 用户拍板 B 方案）。
 *
 * 严格口径：查询按相邻两字 AND，等于要求原文里逐字相邻出现——「内存占用过高」搜不到
 * 「内存占用一直很高」。宽松口径只在**严格一条都没有**时启用：按每组命中过半两字词算成立，
 * 结果带 fuzzy 标记，调用方要说明「模糊命中，请核对原文」。
 *
 * 这一节钉住六件事：
 *   [1] 严格口径真的搜不到（前提成立，否则测不到兜底）；
 *   [2] 兜底能召回换了说法的句子，且带 fuzzy 标记；
 *   [3] fuzzy:false 关掉兜底时仍然一条不返回（调用方可以要严格结果）；
 *   [4] 只共享一个两字词的句子不算命中（避免「多数」退化成「沾边就算」）；
 *   [5] 严格能命中时不走兜底（结果不带 fuzzy 标记，原有行为不变）；
 *   [6] 分组切法本身：长段要过半、短段要全中、英文整词单独一组。
 *
 * 隔离：临时 DSC_HOME，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm run build && node scripts/session-index-fuzzy-test.mjs
 *
 * @module dsc/scripts/session-index-fuzzy-test
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-session-fuzzy-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
const dscHome = process.env.DSC_HOME

let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) {
    pass += 1
    console.log('  PASS ' + name)
  } else {
    fail += 1
    console.log('  FAIL ' + name + (extra === undefined || extra === '' ? '' : ' — ' + extra))
  }
}

/** 写一个会话文件：meta 行 + 若干 user 行。 */
function writeSession(id, cwdName, texts) {
  const dir = join(dscHome, 'sessions', cwdName)
  mkdirSync(dir, { recursive: true })
  const rows = [JSON.stringify({ type: 'meta', id, cwd: join(home, cwdName) })]
  texts.forEach((text, at) => rows.push(JSON.stringify({ type: 'user', text, ts: 1000 + at })))
  const file = join(dir, id + '.jsonl')
  writeFileSync(file, rows.join('\n') + '\n', 'utf8')
  return file
}

writeSession('sess-loosely', 'ws-a', ['内存占用一直很高，机器很卡'])
writeSession('sess-narrow', 'ws-b', ['内存很卡'])
writeSession('sess-strict', 'ws-c', ['内存占用过高，已经重启过'])
writeSession('sess-mixed', 'ws-d', ['内存泄漏比较严重，用 leak 工具查过'])

const { defaultSessionIndexOptions, queryGroups, SessionIndex } = await import('../lib/core/session-index.js')

const index = new SessionIndex({ ...defaultSessionIndexOptions(), indexDir: join(dscHome, 'cache') })
index.load()

console.log('历史会话宽松召回')

// [1] 前提：严格口径搜不到
const strictOnly = await index.search('内存占用过高', { fuzzy: false })
const strictHits = strictOnly.filter((hit) => hit.sessionId === 'sess-strict')
check('前提：严格口径下「内存占用过高」只命中逐字出现的那条', strictOnly.length === 1 && strictHits.length === 1, JSON.stringify(strictOnly.map((hit) => hit.sessionId)))

// [2] 兜底不是为了有严格命中时凑数：那条仍然只有它自己
check('严格有命中时不带 fuzzy 标记', strictHits.every((hit) => hit.fuzzy !== true))

// 换一个关键词：严格一条都没有的句子
const looseStrict = await index.search('内存占用过高', { fuzzy: false, cwd: join(home, 'ws-a') })
check('在换了说法的那个工作区里严格一条都没有', looseStrict.length === 0, JSON.stringify(looseStrict.map((hit) => hit.snippet)))

// [2] 兜底召回
const fuzzyHits = await index.search('内存占用过高', { cwd: join(home, 'ws-a') })
check('兜底召回换了说法的句子', fuzzyHits.length === 1 && fuzzyHits[0].sessionId === 'sess-loosely', JSON.stringify(fuzzyHits.map((hit) => hit.sessionId)))
check('兜底结果带 fuzzy 标记', fuzzyHits.length === 1 && fuzzyHits[0].fuzzy === true)

// [3] 可关掉
const off = await index.search('内存占用过高', { cwd: join(home, 'ws-a'), fuzzy: false })
check('fuzzy:false 时仍然一条都不返回', off.length === 0, JSON.stringify(off))

// [4] 只共享一个两字词不算命中（sess-narrow 的「内存很卡」只有一个 内存）
check('只沾一个两字词的句子不被召回', !fuzzyHits.some((hit) => hit.sessionId === 'sess-narrow'), JSON.stringify(fuzzyHits.map((hit) => hit.sessionId)))

// [5] 严格命中优先：两字词查询照旧是严格结果
const word = await index.search('内存')
check('两字查询走严格口径（有命中且不带 fuzzy）', word.length >= 3 && word.every((hit) => hit.fuzzy !== true), JSON.stringify(word.map((hit) => [hit.sessionId, hit.fuzzy])))

// [5b] 中英混写：中文段过半 + 英文整词都在才成立
const mixed = await index.search('内存泄漏严重')
check('中英混写的宽松召回命中 sess-mixed', mixed.some((hit) => hit.sessionId === 'sess-mixed' && hit.fuzzy === true), JSON.stringify(mixed.map((hit) => [hit.sessionId, hit.fuzzy])))

// [6] 分组切法
const longGroup = queryGroups('内存占用过高')
check('长中文段是一组：5 个两字词、过半算 3', longGroup.length === 1 && longGroup[0].terms.length === 5 && longGroup[0].need === 3, JSON.stringify(longGroup))
const shortGroup = queryGroups('内存')
check('短段要全中（2 字词：1 项、need 1）', shortGroup.length === 1 && shortGroup[0].terms.length === 1 && shortGroup[0].need === 1, JSON.stringify(shortGroup))
const mixedGroups = queryGroups('内存 leak')
check('英文整词单独一组', mixedGroups.length === 2 && mixedGroups[1].terms[0] === 'leak' && mixedGroups[1].need === 1, JSON.stringify(mixedGroups))
const threeGroup = queryGroups('人工智能')
check('4 字段：3 个两字词里命中过半（2 个）即成立', threeGroup.length === 1 && threeGroup[0].terms.length === 3 && threeGroup[0].need === 2, JSON.stringify(threeGroup))

console.log('')
console.log(String(pass) + ' PASS / ' + String(fail) + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
