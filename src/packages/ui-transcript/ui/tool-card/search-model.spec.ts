/**
 * glob / grep 检索工具卡的判据与命中解析（ui 层）。
 *
 * 来源：`scripts/ui-tool-views-test.mjs` 第 [2] 段（判据、命中解析、「无匹配」识别）与第 [6]
 * 段的本卡字典键。`search-model.ts` 零 import，直接 import 跑的就是产品代码。
 * 原探针的装配 / 样式 / 「硬编码中文」扫描钉不迁（无行为接缝，归组件渲染批）。
 *
 * @module dsc-ui-transcript/ui/tool-card/search-model.spec
 */
import { expect, test } from 'vitest'
import en from '../../locale/ui.en.json'
import zh from '../../locale/ui.zh.json'
import { searchCallOf, searchResultOf } from './search-model.js'

// ── 判据：名字 + 非空 pattern ────────────────────────────────────────────────

test('grep + pattern → 内容检索那一档；没给 path 时检索根是 null（= 会话工作目录）', () => {
  const call = searchCallOf('grep', '{"pattern":"needle"}')
  expect(call).not.toBeNull()
  expect(call?.kind).toBe('content')
  expect(call?.pattern).toBe('needle')
  expect(call?.root).toBeNull()
})

test('glob + pattern → 文件名检索那一档，检索根原样带出来', () => {
  const call = searchCallOf('glob', '{"pattern":"**/*.ts","path":"src"}')
  expect(call?.kind).toBe('files')
  expect(call?.root).toBe('src')
})

test('空 / 空白 pattern → 不是这张卡', () => {
  expect(searchCallOf('grep', '{"pattern":""}')).toBeNull()
  expect(searchCallOf('glob', '{"pattern":"   "}')).toBeNull()
})

test('名字不是 glob / grep → 不是这张卡', () => {
  expect(searchCallOf('search', '{"pattern":"x"}')).toBeNull()
  expect(searchCallOf('lsp', '{"pattern":"x"}')).toBeNull()
})

test('半截 JSON 不抛；没有 pattern 字段 → 不是这张卡；path 空白当没给', () => {
  expect(searchCallOf('grep', '{"pattern":')).toBeNull()
  expect(searchCallOf('grep', '{"path":"src"}')).toBeNull()
  expect(searchCallOf('grep', '{"pattern":"x","path":"  "}')?.root).toBeNull()
})

// ── grep 命中解析 ────────────────────────────────────────────────────────────

const GREP_RESULT = [
  'src/a.ts:12: const needle = 1',
  'src/a.ts:40: needle + 1',
  'src/b.md:3: needle 在这里',
].join('\n')

test('grep 命中按文件分组，命中总数是命中行数', () => {
  const parsed = searchResultOf('content', GREP_RESULT)
  expect(parsed?.files).toHaveLength(2)
  expect(parsed?.total).toBe(3)
  expect(parsed?.empty).toBe(false)
})

test('同一文件的两处命中归到一组，命中带行号与内容原文', () => {
  const parsed = searchResultOf('content', GREP_RESULT)
  expect(parsed?.files[0]?.hits).toHaveLength(2)
  expect(parsed?.files[0]?.hits[0]?.line).toBe(12)
  expect(parsed?.files[0]?.hits[1]?.line).toBe(40)
  expect(parsed?.files[1]?.hits[0]?.text).toBe('needle 在这里')
})

test('Windows 盘符路径里的冒号不被当行号分隔', () => {
  const one = searchResultOf('content', 'D:/work/a.ts:7: 内容')
  expect(one?.files[0]?.path).toBe('D:/work/a.ts')
  expect(one?.files[0]?.hits[0]?.line).toBe(7)
})

test('内容里再出现冒号也不打断解析；CRLF 也能解析', () => {
  const one = searchResultOf('content', 'a.ts:1: key: value: needle')
  expect(one?.files[0]?.hits[0]?.text).toBe('key: value: needle')
  expect(searchResultOf('content', 'a.ts:1: x\r\nb.ts:2: y')?.files).toHaveLength(2)
})

// ── glob 命中解析 ────────────────────────────────────────────────────────────

test('glob 一行一个文件，文件下面没有命中行', () => {
  const files = searchResultOf('files', ['src/a.ts', 'src/b.ts', 'docs/c.md'].join('\n'))
  expect(files?.files).toHaveLength(3)
  expect(files?.total).toBe(3)
  expect(files?.files.every((file) => file.hits.length === 0)).toBe(true)
})

// ── 「无匹配」与尾注 ─────────────────────────────────────────────────────────

test('「无匹配」识别成 empty（不是空卡），那一行不再进尾注（视图已经说过一遍）', () => {
  const none = searchResultOf('content', '（无匹配：needle）')
  expect(none?.empty).toBe(true)
  expect(none?.total).toBe(0)
  expect(none?.notes).toHaveLength(0)
})

test('被跳过的受保护文件那句尾注留着（有用的尾注不能被一起丢掉）', () => {
  const skipped = searchResultOf('content', '（无匹配：needle）\n（已跳过 2 个受保护文件：.env、id_rsa）')
  expect(skipped?.notes).toHaveLength(1)
  expect(skipped?.notes[0]).toContain('已跳过')
  expect(skipped?.notes.some((note) => note.startsWith('（无匹配：'))).toBe(false)
})

test('展开体上只剩一句「没有匹配」（不画两遍）', () => {
  // 视图那句取自字典（`transcript.tool.searchNone` 的中文文案里含「没有匹配」），
  // notes 里不能再出现「无匹配 / 没有匹配」——同一句话出现两次是这批修过的缺陷。
  const skipped = searchResultOf('content', '（无匹配：needle）\n（已跳过 2 个受保护文件：.env、id_rsa）')
  const noneText = (zh as Record<string, string>)['transcript.tool.searchNone'] ?? ''
  const emptyBody = [noneText.replace('{pattern}', 'needle'), ...(skipped?.notes ?? [])].join(' ')
  expect((emptyBody.match(/没有匹配|无匹配/g) ?? [])).toHaveLength(1)
})

test('截断尾注留着；空结果 → null（还在跑，不画空卡）', () => {
  const truncated = searchResultOf('files', 'src/a.ts\n（只显示前 100 条，还有更多；把 pattern 或 path 收窄一点再看全部）')
  expect(truncated?.notes).toHaveLength(1)
  expect(truncated?.files).toHaveLength(1)
  expect(searchResultOf('content', '')).toBeNull()
  expect(searchResultOf('files', undefined)).toBeNull()
})

// ── 本卡字典键（数据断言） ───────────────────────────────────────────────────

const SEARCH_KEYS = [
  'transcript.tool.searchHits',
  'transcript.tool.searchFiles',
  'transcript.tool.searchFileHits',
  'transcript.tool.searchNone',
  'transcript.tool.searchNoMatch',
  'transcript.tool.searchWaiting',
] as const

test('检索卡用到的六个键两份字典都在（非空字符串，英文真译过）', () => {
  for (const key of SEARCH_KEYS) {
    expect(typeof zh[key] === 'string' && (zh[key] as string).trim() !== '', `zh 有 ${key}`).toBe(true)
    expect(typeof en[key] === 'string' && (en[key] as string).trim() !== '', `en 有 ${key}`).toBe(true)
    expect(/[\u4e00-\u9fff]/.test(String(en[key] ?? '')), `${key} 的英文里没有汉字`).toBe(false)
  }
})
