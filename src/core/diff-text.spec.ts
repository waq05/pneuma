/**
 * 文本差异引擎的单位测试。
 *
 * 为什么这组用例值得钉：diffLines 的输出是一堆 `@@ -a,b +c,d @@` 加前缀行，肉眼能看
 * 出「大致对」，看不出行号差一位、hunk 少一段、末尾多一行。所以每条用例都用**确定的
 * 小输入**，断言渲染出来的每行（头 + 前缀 + 正文），而不是只看 added / removed 两个
 * 计数——那两个数对不上时也可能碰巧相等（一增一删）。
 *
 * 另有两处刻意只钉正文、不钉 hunk 头的新侧起点（见下面带「只钉」字样的用例注释）：
 * 当前实现里，以删除行开头的 hunk 会把新侧起点取成「上一行的行号」，与 diff -u 的
 * 写法差一；那是待修行为，不该被测试锁死。
 *
 * @module dsc/core/diff-text.spec
 */
import { expect, test } from 'vitest'
import { DIFF_LINE_CHAR_LIMIT, diffLines, renderHunk, splitLines } from './diff-text.js'

/** 把结果铺成「头 + 前缀 + 正文」的字符串数组，一条断言就能看住行数与每行前缀。 */
const rendered = (before: string, after: string, context: number): string[] =>
  diffLines(before, after, context).hunks.flatMap((hunk) => renderHunk(hunk))

// ── splitLines ──────────────────────────────────────────────────────────────

test('空串切出零行', () => {
  // 空文件不能切出一个空行，否则「空 → 新增一行」会算成「改了一个空行」。
  expect(splitLines('')).toEqual([])
})

test('单行不带换行时切出一行', () => {
  expect(splitLines('a')).toEqual(['a'])
})

test('按换行切行', () => {
  expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c'])
})

test('末尾一个换行不额外产出一行', () => {
  // 绝大多数文件以换行结尾；多算一行会让每份 diff 末尾都挂一个假改动。
  expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
})

test('末尾两个换行产出一个真的空行', () => {
  // 与上一条配套：多余的换行在文件里是一个空行，必须保留，否则「删掉末尾空行」看不见。
  expect(splitLines('a\n\n')).toEqual(['a', ''])
})

test('CRLF 的每个行尾回车都被抹掉', () => {
  // 留着 \r 会让同一行在 LF 与 CRLF 两个版本里被判成「改过」，整篇全是红绿。
  expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
})

test('开头的 BOM 被抹掉', () => {
  // BOM 不是正文；留着会让第一行永远显示成一个看不见的改动。
  expect(splitLines('\ufeffa\nb')).toEqual(['a', 'b'])
})

// ── diffLines ───────────────────────────────────────────────────────────────

test('一行替换渲染成四行：两行上下文夹一对 -/+', () => {
  // 这条同时钉住 hunk 头（-1,3 +1,3）与每行前缀；行数错一位，界面上的定位就全错。
  expect(rendered('a\nb\nc', 'a\nB\nc', 1)).toEqual(['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'])
})

test('context 为 0 时正文只剩改动行，旧侧起点仍是替换发生的行', () => {
  // 0 上下文是「只看改动」的模式，不能把整段上下文贴进来。
  // 只钉旧侧起点：新侧起点在这一形态下是当前实现的兜底值，见文件头说明。
  const lines = rendered('a\nb\nc', 'a\nB\nc', 0)
  expect(lines.slice(1)).toEqual(['-b', '+B'])
  expect(lines[0]).toMatch(/^@@ -2 /)
})

test('纯插入在 context 为 0 时给 -N,0 起，单行计数省略 ,1', () => {
  // 插入不消耗旧侧行数，所以旧侧计数是 0；新侧只有一行时按 diff -u 的写法省掉 `,1`。
  expect(rendered('a\nc', 'a\nb\nc', 0)).toEqual(['@@ -1,0 +2 @@', '+b'])
})

test('纯插入只多一行，计数是 +1', () => {
  // 插入没有删除行；若把上下文算进改动，added 会变成 3。
  const result = diffLines('a\nc', 'a\nb\nc', 1)
  expect(result.added).toBe(1)
  expect(result.removed).toBe(0)
  expect(rendered('a\nc', 'a\nb\nc', 1)).toEqual(['@@ -1,2 +1,3 @@', ' a', '+b', ' c'])
})

test('纯删除只少一行，计数是 -1', () => {
  const result = diffLines('a\nb\nc', 'a\nc', 1)
  expect(result.added).toBe(0)
  expect(result.removed).toBe(1)
  expect(rendered('a\nb\nc', 'a\nc', 1)).toEqual(['@@ -1,3 +1,2 @@', ' a', '-b', ' c'])
})

test('从空文件新增：hunk 头是 -0,0 起', () => {
  // 空文件没有「上一行」可退，起点只能落 0；写成 1 会让界面试图跳到不存在的第 1 行。
  expect(rendered('', 'x', 0)).toEqual(['@@ -0,0 +1 @@', '+x'])
})

test('删到空文件：新增侧起点是 0', () => {
  // 与上一条对称：旧侧还有第 1 行，新侧已经空了。
  expect(rendered('a', '', 0)).toEqual(['@@ -1 +0,0 @@', '-a'])
})

test('内容完全相同时不产 hunk，identical 为真', () => {
  // 宿主拿 identical 决定要不要显示差异区；这里错成 false 会让干净文件也弹一张空卡片。
  const result = diffLines('a\nb\n', 'a\nb\n', 3)
  expect(result).toEqual({ ok: true, hunks: [], added: 0, removed: 0, identical: true, oversize: false })
})

test('只有换行风格不同时给一条说明，不产逐行差异', () => {
  // 整篇 CRLF→LF 在逐行层面是「没变」；不给说明的话用户会以为文件真的没改。
  const result = diffLines('a\r\nb', 'a\nb', 3)
  expect(result.identical).toBe(false)
  expect(result.hunks).toEqual([])
  expect(result.added).toBe(0)
  expect(result.removed).toBe(0)
  expect(result.note).toContain('换行风格')
})

test('两处改动隔得远时切成两个 hunk', () => {
  // 相隔超过 2×context 就该分两段，否则中间几行没改的内容会被重复贴出来。
  const before = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'].join('\n')
  const after = ['l0', 'X1', 'l2', 'l3', 'l4', 'l5', 'l6', 'X7', 'l8'].join('\n')
  const result = diffLines(before, after, 1)
  expect(result.hunks).toHaveLength(2)
  expect(result.added).toBe(2)
  expect(result.removed).toBe(2)
})

test('两处改动隔得近时并成一个 hunk', () => {
  // 并段规则跟 diff -u 一致：中间没改的内容不超过 2×context 就合并，避免碎成一片片。
  const before = ['a', 'b', 'c', 'd', 'e'].join('\n')
  const after = ['a', 'B', 'c', 'D', 'e'].join('\n')
  expect(diffLines(before, after, 1).hunks).toHaveLength(1)
})

test('超长行被截断，行尾写明原本字符数', () => {
  // minified 的 js / 单行 json 会让一条 diff 撑爆上下文；截断标记必须带上原长度，
  // 用户才知道自己看的不是完整内容。
  const long = 'x'.repeat(401)
  const lines = rendered(long, 'y'.repeat(401), 0)
  expect(lines[1]).toBe(`-${'x'.repeat(DIFF_LINE_CHAR_LIMIT)}…（本行原 401 字符，预览已截断）`)
  expect(lines[2]).toBe(`+${'y'.repeat(DIFF_LINE_CHAR_LIMIT)}…（本行原 401 字符，预览已截断）`)
})

test('恰好等于上限的行不截断', () => {
  // 边界：400 字符是「可以不切」的最大值，401 才切。差一位会让正常的长行尾巴上多出提示。
  expect(DIFF_LINE_CHAR_LIMIT).toBe(400)
  const exact = 'x'.repeat(DIFF_LINE_CHAR_LIMIT)
  const lines = rendered(exact, 'y'.repeat(DIFF_LINE_CHAR_LIMIT), 0)
  expect(lines.slice(1)).toEqual([`-${exact}`, `+${'y'.repeat(DIFF_LINE_CHAR_LIMIT)}`])
})

test('context 配负数被夹到 0，不把上下文行拉成负数下标', () => {
  // 负上下文没有语义，但参数来自界面；夹到 0 后正文应与显式传 0 完全一致。
  const lines = rendered('a\nb\nc\nd\ne', 'a\nb\nC\nd\ne', -5)
  expect(lines.slice(1)).toEqual(['-c', '+C'])
  expect(lines[0]).toMatch(/^@@ -3 /)
})

test('context 配超过 50 时被夹到 50', () => {
  // 上下文太多会把整份文件贴进对话框；50 是上限，改坏后这一段会变成 121 行。
  const before = Array.from({ length: 120 }, (_, index) => `L${String(index)}`)
  const after = [...before]
  after[60] = 'CHANGED'
  const hunk = diffLines(before.join('\n'), after.join('\n'), 100).hunks[0]
  expect(hunk?.lines).toHaveLength(102)
  expect(hunk?.oldStart).toBe(11)
})

test('改动区间超过矩阵上限时退回摘要，不产逐行差异', () => {
  // 整篇重写一万行的文件时逐行 diff 既慢又不可读；摘要要能说清「从第几行起、增删多少」。
  const before = Array.from({ length: 2000 }, (_, index) => `old-${String(index)}`).join('\n')
  const after = Array.from({ length: 2000 }, (_, index) => `new-${String(index)}`).join('\n')
  const result = diffLines(before, after, 3)
  expect(result.ok).toBe(false)
  expect(result.oversize).toBe(true)
  expect(result.hunks).toEqual([])
  expect(result.added).toBe(2000)
  expect(result.removed).toBe(2000)
  expect(result.note).toContain('第 1 行起')
})

test('每个 hunk 的计数与它自己的行一致（多个 hunk 时不串号）', () => {
  // 第二个 hunk 的 oldCount / newCount 若沿用第一个的累计值，行号会越往后偏得越多。
  const before = Array.from({ length: 12 }, (_, index) => `L${String(index)}`)
  const after = [...before]
  after[1] = 'A1'
  after[10] = 'A10'
  const result = diffLines(before.join('\n'), after.join('\n'), 1)
  expect(result.hunks).toHaveLength(2)
  for (const hunk of result.hunks) {
    expect(hunk.oldCount).toBe(hunk.lines.filter((line) => line.kind !== 'add').length)
    expect(hunk.newCount).toBe(hunk.lines.filter((line) => line.kind !== 'remove').length)
  }
})
