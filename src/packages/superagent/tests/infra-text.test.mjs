/**
 * @pneuma/superagent 的 IM 文案工具包级测试：字数统计（中英混排）、超限报错、模板填充、名称比较与正则转义。
 *
 * 为什么这些要单独钉：`wordCount` 决定「一条 IM 回复能不能发出去」，切词规则一变，同一段话就可能从
 * 「能发」变成「超限」；`fill` 决定错误文案里的 `{占位符}` 有没有漏；`escapeRegExp` 用错会让
 * 用户在工单里写的文字变成正则语法。所以每条都断言具体数值，不只断言「不抛」。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/infra-text
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { IM_WORDS, NOTE_WORDS, wordCount, checkedImText, fill, sameName, escapeRegExp } =
  await import('../../../../lib/packages/superagent/infra/text.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

test('wordCount：英文按词、标点不算、中文按词典切词、中英混排各算各的', () => {
  assert.equal(IM_WORDS, 100)
  assert.equal(NOTE_WORDS, 30)
  assert.equal(wordCount('hello, world!'), 2, '标点不是词')
  assert.equal(wordCount('!!!'), 0, '纯标点一个字都不算')
  assert.equal(wordCount(''), 0)
  assert.equal(wordCount("don't stop"), 2, '英文缩写算一个词')
  assert.equal(wordCount('你好世界'), 2, '中文按词典切：你好 / 世界')
  assert.equal(wordCount('hello 世界, 你好 world'), 4, '中英混排：英文两词 + 中文两词')
  assert.equal(wordCount('100% 完成'), 2, '数字与中文各算一个')
  assert.equal(wordCount('a '.repeat(100).trim()), 100, '一百个英文词整好一百')
  passed += 1
})

test('checkedImText：不超限原样返回，超一个词就按上游文案抛错', () => {
  const atLimit = 'a '.repeat(IM_WORDS).trim()
  assert.equal(checkedImText(atLimit), atLimit, '正好到上限要放行')
  const overLimit = 'a '.repeat(IM_WORDS + 1).trim()
  assert.throws(() => checkedImText(overLimit), {
    message: `IM message has ${IM_WORDS + 1} words; maximum is ${IM_WORDS}. Rewrite as a short high-level update. Do not split it into multiple messages.`,
  })
  assert.equal(checkedImText('a '.repeat(IM_WORDS).trim()), atLimit, '报错不该改掉原参数')
  passed += 1
})

test('fill：按占位符取值，没给的值填空串（上游是 `?? \'\'`，不是原样留着）', () => {
  assert.equal(fill('@{account} cannot read {repository}.', { account: 'alice', repository: 'owner/repo' }), '@alice cannot read owner/repo.')
  assert.equal(fill('{a}-{b}', { a: 'x' }), 'x-', '没给的占位符填成空串')
  assert.equal(fill('no placeholders', { a: 'x' }), 'no placeholders')
  assert.equal(fill('{a}{a}', { a: 'x' }), 'xx', '同一个占位符出现两次都要填')
  passed += 1
})

test('sameName：GitHub 登录名与仓库名大小写不敏感', () => {
  assert.equal(sameName('Alice', 'alice'), true)
  assert.equal(sameName('owner/Repo', 'OWNER/repo'), true)
  assert.equal(sameName('alice', 'alice2'), false)
  passed += 1
})

test('escapeRegExp：用户文字里的正则符号按字面匹配', () => {
  const source = 'a.b*c(d)[e]{f}$^|\\+?'
  const pattern = new RegExp(`^${escapeRegExp(source)}$`)
  assert.equal(pattern.test(source), true, '转义后能精确匹配原文')
  assert.equal(pattern.test('axb'), false, '转义前 `.` 会乱匹配，转义后不会')
  assert.equal(escapeRegExp('plain'), 'plain')
  passed += 1
})
