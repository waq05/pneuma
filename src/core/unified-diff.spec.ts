/**
 * unified diff 文本解析的单位测试。
 *
 * 为什么这组用例值得钉：这是「输入整段 diff、输出整段 hunk」那一类。算法原先在两处各
 * 长一份，容错口径写在同一段注释里；两份一旦分叉，症状是「同一段 diff 在两个界面里
 * 行数不一样」——没有异常，只有对不上的数字。所以断言挑的是**行数、每行前缀与行号**
 * 这种一改就错位的点，而不是「解析结果非空」。
 *
 * 跳过：本模块没有 I/O、没有环境读取，全部是纯函数。
 *
 * @module dsc/core/unified-diff.spec
 */
import { expect, test } from 'vitest'
import { parseUnifiedDiff, splitUnifiedDiffByFile } from './unified-diff.js'

/** 一份最小的单文件 diff：一个 hunk、两行上下文、一行替换。 */
const singleHunk = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  ' const c = 4',
].join('\n')

// ── parseUnifiedDiff ────────────────────────────────────────────────────────

test('一个 hunk 解出四行，每行的类型与去掉前缀后的正文都对', () => {
  const hunks = parseUnifiedDiff(singleHunk)
  expect(hunks).toHaveLength(1)
  expect(hunks[0]?.lines.map((line) => line.kind)).toEqual(['context', 'remove', 'add', 'context'])
  expect(hunks[0]?.lines.map((line) => line.text)).toEqual(['const a = 1', 'const b = 2', 'const b = 3', 'const c = 4'])
})

test('上下文行两侧都有行号，删除行只有旧行号，新增行只有新行号', () => {
  // 行号错一位，审查面板的「跳到第几行」就全错；这是解析结果里唯一无法靠肉眼校对的部分。
  const lines = parseUnifiedDiff(singleHunk)[0]?.lines ?? []
  expect(lines.map((line) => [line.oldLine, line.newLine])).toEqual([
    [1, 1],
    [2, null],
    [null, 2],
    [3, 3],
  ])
})

test('hunk 头的起止行号与计数按实际行算', () => {
  const hunk = parseUnifiedDiff(singleHunk)[0]
  expect(hunk).toMatchObject({ oldStart: 1, oldCount: 3, newStart: 1, newCount: 3 })
})

test('空文本没有 hunk', () => {
  expect(parseUnifiedDiff('')).toEqual([])
})

test('不是 diff 的普通文本返回空数组，不抛错', () => {
  // 调用方拿到的可能是命令的报错输出；解析失败宁可少一段，也不能把界面炸掉。
  expect(parseUnifiedDiff('fatal: not a git repository')).toEqual([])
})

test('文件完全相同时 git 不输出 hunk，解析结果为空', () => {
  // 「没有 hunk」是正常状态（干净文件），不是解析失败；界面据此显示「无差异」。
  const clean = ['diff --git a/x.ts b/x.ts', 'index 1111111..1111111 100644'].join('\n')
  expect(parseUnifiedDiff(clean)).toEqual([])
})

test('「No newline at end of file」标注行不进差异正文', () => {
  // 它是给 patch 工具看的说明，不是文件内容；混进正文会让用户在文件末尾看到一行假的
  // `\ No newline...`。
  const text = ['@@ -1,2 +1,2 @@', '-a', '+b', '\\ No newline at end of file'].join('\n')
  const hunk = parseUnifiedDiff(text)[0]
  expect(hunk?.lines).toHaveLength(2)
  expect(hunk?.lines.map((line) => line.text)).toEqual(['a', 'b'])
})

test('hunk 头省略计数时（-1 +1）也能解析', () => {
  // `diff -u` 在一行时省略 `,1`；不认这种头就会整段丢掉。
  const hunk = parseUnifiedDiff(['@@ -5 +7 @@', '-a', '+b'].join('\n'))[0]
  expect(hunk).toMatchObject({ oldStart: 5, newStart: 7, oldCount: 1, newCount: 1 })
})

test('hunk 头写的计数与正文不符时，以实际行为准', () => {
  // git 在文件末尾没换行等场景下，头里的计数会与实际行差一；信任头部会让行号错位，
  // 所以这里钉住「按实际行数重算」。
  const text = ['@@ -1,99 +1,99 @@', ' ctx', '-old', '+new'].join('\n')
  expect(parseUnifiedDiff(text)[0]).toMatchObject({ oldCount: 2, newCount: 2 })
})

test('两个 hunk 各自成段，第二个的起始行号不被前一个带偏', () => {
  const text = ['@@ -1,2 +1,2 @@', '-a', '+b', '@@ -10,2 +10,2 @@', '-c', '+d'].join('\n')
  const hunks = parseUnifiedDiff(text)
  expect(hunks).toHaveLength(2)
  expect(hunks[1]).toMatchObject({ oldStart: 10, newStart: 10 })
})

test('遇到 diff 元数据行时当前 hunk 立即结束，不把下一个文件的头吞进行数', () => {
  // `--- a/y` 与 `+++ b/y` 以 - 和 + 开头，若只按首字符判，它们会被当成一行删除一行新增，
  // 于是第一个 hunk 凭空多出两行。
  const text = [
    'diff --git a/x.ts b/x.ts',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
    'diff --git a/y.ts b/y.ts',
    '--- a/y.ts',
    '+++ b/y.ts',
    '@@ -1,1 +1,1 @@',
    '-c',
    '+d',
  ].join('\n')
  const hunks = parseUnifiedDiff(text)
  expect(hunks).toHaveLength(2)
  expect(hunks[0]?.lines).toHaveLength(2)
  expect(hunks[1]?.lines.map((line) => line.text)).toEqual(['c', 'd'])
})

test('CRLF 的 diff 文本同样能解析，正文里不留回车', () => {
  // Windows 上 git 输出可能带 CR；切行用的是 /\r?\n/，正文里不该残留 \r。
  const text = singleHunk.replace(/\n/g, '\r\n')
  const lines = parseUnifiedDiff(text)[0]?.lines ?? []
  expect(lines).toHaveLength(4)
  expect(lines[0]?.text).toBe('const a = 1')
  expect(lines[0]?.text).not.toContain('\r')
})

// ── splitUnifiedDiffByFile ─────────────────────────────────────────────────

test('按文件切段：路径取 b/ 侧，增删行数各算一遍', () => {
  const files = splitUnifiedDiffByFile(singleHunk)
  expect(files).toHaveLength(1)
  expect(files[0]).toMatchObject({ path: 'src/a.ts', added: 1, removed: 1 })
  expect(files[0]?.hunks).toHaveLength(1)
})

test('多个文件按 diff 出现的先后顺序返回', () => {
  // 顺序是用户读审查面板的顺序；排序错了会表现成「文件跳来跳去」，且很难归因。
  const second = singleHunk.replace(/src\/a\.ts/g, 'src/z.ts')
  const files = splitUnifiedDiffByFile(`${second}\n${singleHunk}`)
  expect(files.map((file) => file.path)).toEqual(['src/z.ts', 'src/a.ts'])
})

test('空文本返回空数组', () => {
  expect(splitUnifiedDiffByFile('')).toEqual([])
})

test('只有文件头没有 hunk 的干净文件被跳过', () => {
  // 干净文件在 `git diff` 里根本不该出现；万一出现，返回一个 added=0 的条目会让界面
  // 列出一个点开什么都没有的文件。
  const clean = ['diff --git a/x.ts b/x.ts', 'index 1111111..1111111 100644'].join('\n')
  expect(splitUnifiedDiffByFile(clean)).toEqual([])
})

test('rename 文件取新路径（b/ 侧）', () => {
  // 审查面板要按新路径打开文件；取到 a/ 侧的旧路径会打不开。
  const renamed = [
    'diff --git a/src/old.ts b/src/new.ts',
    'similarity index 90%',
    'rename from src/old.ts',
    'rename to src/new.ts',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
  ].join('\n')
  expect(splitUnifiedDiffByFile(renamed)[0]?.path).toBe('src/new.ts')
})

test('同一个文件的多个 hunk 增删数累加', () => {
  const twoHunks = [
    'diff --git a/x.ts b/x.ts',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
    '@@ -10,1 +10,1 @@',
    '-c',
    '+d',
  ].join('\n')
  expect(splitUnifiedDiffByFile(twoHunks)[0]).toMatchObject({ added: 2, removed: 2 })
  expect(splitUnifiedDiffByFile(twoHunks)[0]?.hunks).toHaveLength(2)
})
