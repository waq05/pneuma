/**
 * read 专用工具卡的判据与回执解析（ui 层）。
 *
 * 来源：`scripts/ui-tool-views-test.mjs` 第 [1] 段（判据、行区间、内容预览）与第 [6] 段的
 * 字典键（数据断言，照 `compaction-locale.spec.ts` 的口径）。
 *
 * 为什么是行为测试而不是复刻：`read-model.ts` 零 import（没有 React、没有取词器），
 * 探针时代用 Node 类型擦除直读它；Vitest 里直接 import 跑的就是产品代码。
 * 原探针的源码钉（`read-view.tsx` 的取法、`factory.tsx` 装配顺序、views.css 样式、
 * 「代码里没有硬编码中文」扫描）没有行为接缝，不迁——渲染与样式归组件渲染批，
 * 逐条见交付报告的缺口清单。
 *
 * @module dsc-ui-transcript/ui/tool-card/read-model.spec
 */
import { expect, test } from 'vitest'
import en from '../../locale/ui.en.json'
import zh from '../../locale/ui.zh.json'
import { readCallOf, readPreviewOf, readSpanOf } from './read-model.js'

/** 常用参数：从第 3 行起读 5 行。 */
const ARGS = JSON.stringify({ path: 'sample.txt', offset: 3, limit: 5 })

// ── 判据：名字 + path 缺一不可 ───────────────────────────────────────────────

test('read + path → 一张 read 卡，offset / limit 原样进参数视图', () => {
  const call = readCallOf('read', ARGS)
  expect(call).not.toBeNull()
  expect(call?.path).toBe('sample.txt')
  expect(call?.offset).toBe(3)
  expect(call?.limit).toBe(5)
})

test('没给 offset 就从第 1 行起；没给 limit 就是 null（不猜「读到多少行」）', () => {
  const call = readCallOf('read', '{"path":"a.txt"}')
  expect(call?.offset).toBe(1)
  expect(call?.limit).toBeNull()
})

test('名字不是 read → 不是这张卡', () => {
  expect(readCallOf('grep', ARGS)).toBeNull()
})

test('名字是 read 但没有 path → 不是这张卡（只有名字不够）', () => {
  // 本仓的参数名是 `path`，不是 dsh 的 `file_path`：认了它，头行就没有可点路径。
  expect(readCallOf('read', '{"file_path":"a.txt"}')).toBeNull()
})

test('path 是空白 → 不是这张卡', () => {
  expect(readCallOf('read', '{"path":"   "}')).toBeNull()
})

test('半截 JSON（流式参数）→ 不抛，判成不是这张卡', () => {
  expect(readCallOf('read', '{"path":')).toBeNull()
})

test('参数是数组 → 不是这张卡', () => {
  expect(readCallOf('read', '[]')).toBeNull()
})

test('坏行号当没给：offset 0 退回第 1 行、limit 2.5 与字符串 "3" 都不算', () => {
  // 行号是 1-based：0 在语义上不存在，退回默认比画错强。
  expect(readCallOf('read', '{"path":"a","offset":0}')?.offset).toBe(1)
  expect(readCallOf('read', '{"path":"a","limit":2.5}')?.limit).toBeNull()
  expect(readCallOf('read', '{"path":"a","offset":"3"}')?.offset).toBe(1)
})

// ── 内容预览 ─────────────────────────────────────────────────────────────────

/** 宿主回执的典型形状：路径 + 「行号<TAB>原文」+ 尾注。 */
const RESULT = [
  'D:\\work\\sample.txt',
  '3\t第三行的原文',
  '4\t第四行的原文',
  '5\t第五行的原文',
  '7\t第七行的原文',
  '…（共 300 行，可用 offset/limit 续读）',
].join('\n')

test('结果首行是文件路径，正文按行拆开', () => {
  const preview = readPreviewOf(RESULT)
  expect(preview?.path).toBe('D:\\work\\sample.txt')
  expect(preview?.lines).toHaveLength(4)
  expect(preview?.lines.map((line) => line.number).join(',')).toBe('3,4,5,7')
})

test('正文原文不动（缩进也不 trim）', () => {
  expect(readPreviewOf('D:\\a.txt\n1\t    缩进两格')?.lines[0]?.text).toBe('    缩进两格')
})

test('尾注里的总行数解析出来，尾注原文留在 notes（给展开体作说明）', () => {
  const preview = readPreviewOf(RESULT)
  expect(preview?.total).toBe(300)
  expect(preview?.notes).toHaveLength(1)
  expect(preview?.notes[0]?.startsWith('…（')).toBe(true)
})

test('工具报错的散文 → 不是预览（不能画成「读了 0 行」）', () => {
  expect(readPreviewOf('读不到文件：D:\\work\\x.txt')).toBeNull()
})

test('空结果 → null（还在跑，不画空卡）', () => {
  expect(readPreviewOf('')).toBeNull()
  expect(readPreviewOf(undefined)).toBeNull()
})

test('空文件（宿主真实形状：路径 + 一行 `1<TAB>`）→ 预览存在、0 行、empty 为真', () => {
  // 宿主对空文件也编出第 1 行（`''.split(/\r?\n/)` 得 `['']`），所以这个形状才是空文件。
  const empty = readPreviewOf('D:\\work\\empty.txt\n1\t')
  expect(empty).not.toBeNull()
  expect(empty?.lines).toHaveLength(0)
  expect(empty?.empty).toBe(true)
  expect(empty?.path).toBe('D:\\work\\empty.txt')
})

test('只有路径一行（offset 越过末尾的形状）→ 不猜成空文件', () => {
  expect(readPreviewOf('D:\\work\\empty.txt')).toBeNull()
})

test('空正文行后面还有「共 N 行」尾注 → 不是空文件（文件里还有别的行）', () => {
  const more = readPreviewOf('D:\\a.txt\n1\t\n…（共 2 行，可用 offset/limit 续读）')
  expect(more?.empty).toBe(false)
  expect(more?.lines).toHaveLength(1)
  expect(more?.total).toBe(2)
})

test('CRLF 换行也能解析；末尾空行不算正文；认不出的行整份不认', () => {
  expect(readPreviewOf('D:\\a.txt\r\n1\t一\r\n2\t二')?.lines).toHaveLength(2)
  expect(readPreviewOf('D:\\a.txt\n1\t一\n\n')?.lines).toHaveLength(1)
  expect(readPreviewOf('D:\\a.txt\n随便一句')).toBeNull()
})

// ── 行区间：结果优先、参数兜底 ───────────────────────────────────────────────

test('区间取结果里的首尾行，文件总行数跟着区间走', () => {
  const span = readSpanOf(readCallOf('read', ARGS) as NonNullable<ReturnType<typeof readCallOf>>, readPreviewOf(RESULT))
  expect(span.from).toBe(3)
  expect(span.to).toBe(7)
  expect(span.total).toBe(300)
})

test('还没落地时按参数算区间（3 → 3+5-1=7）；没有 limit 时只说得出起点', () => {
  const call = readCallOf('read', ARGS) as NonNullable<ReturnType<typeof readCallOf>>
  const span = readSpanOf(call, null)
  expect(span.from).toBe(3)
  expect(span.to).toBe(7)
  expect(span.total).toBeNull()

  const openEnded = readSpanOf(readCallOf('read', '{"path":"a","offset":40}') as NonNullable<ReturnType<typeof readCallOf>>, null)
  expect(openEnded.from).toBe(40)
  expect(openEnded.to).toBeNull()
})

test('只读一行时区间退化成一个数', () => {
  const one = readPreviewOf('D:\\a.txt\n42\t唯一一行')
  const span = readSpanOf(readCallOf('read', '{"path":"a"}') as NonNullable<ReturnType<typeof readCallOf>>, one)
  expect(span.from).toBe(42)
  expect(span.to).toBe(42)
})

test('空文件的头行说「文件是空的」，不退回参数算成「第 1 行」', () => {
  const empty = readPreviewOf('D:\\work\\empty.txt\n1\t')
  const span = readSpanOf(readCallOf('read', '{"path":"a","limit":5}') as NonNullable<ReturnType<typeof readCallOf>>, empty)
  expect(span.empty).toBe(true)
  expect(span.total).toBeNull()
})

test('结果落地后以真实行数为准（宿主有硬顶，参数可能说大了）', () => {
  const wide = readPreviewOf('D:\\a.txt\n1\t一\n2\t二')
  const span = readSpanOf(readCallOf('read', '{"path":"a","offset":1,"limit":5000}') as NonNullable<ReturnType<typeof readCallOf>>, wide)
  expect(span.from).toBe(1)
  expect(span.to).toBe(2)
})

// ── 本卡字典键（数据断言：两份字典都在、英文真译过） ─────────────────────────

const READ_KEYS = [
  'transcript.tool.readLine',
  'transcript.tool.readRange',
  'transcript.tool.readFrom',
  'transcript.tool.readEmpty',
  'transcript.tool.readWaiting',
  'transcript.tool.readTotal',
] as const

test('read 卡用到的六个键两份字典都在（非空字符串）', () => {
  for (const key of READ_KEYS) {
    expect(typeof zh[key] === 'string' && (zh[key] as string).trim() !== '', `zh 有 ${key}`).toBe(true)
    expect(typeof en[key] === 'string' && (en[key] as string).trim() !== '', `en 有 ${key}`).toBe(true)
  }
})

test('英文译本里没有汉字', () => {
  for (const key of READ_KEYS) {
    expect(/[\u4e00-\u9fff]/.test(String(en[key] ?? '')), `${key} 的英文里没有汉字`).toBe(false)
  }
})
