/**
 * 字符串小判定的纯函数（unit 层）。
 *
 * 三个导出都不读环境、不写盘；`splitList` 的分隔符集合、`nonEmptyString` 的「trim 只用于
 * 判空、不用于清洗」、`oneLine` 的截断长度，都是调用方按字符串字面量依赖的口径。
 *
 * 为什么这些断言值得钉：配置串拆错一项，白名单/域名清单只会「多一条或少一条」，
 * 不会报错；摘要截错一位，界面上只是少一个字。都是不红不响的那类回归。
 *
 * @module dsc/core/strings.spec
 */
import { expect, test } from 'vitest'
import { nonEmptyString, oneLine, splitList } from './strings.js'

test('英文逗号分隔的清单被拆开', () => {
  expect(splitList('a,b,c')).toEqual(['a', 'b', 'c'])
})

test('中文逗号与英文逗号同等对待', () => {
  // 用户会把配置从中文文档里抄过来；只认英文逗号时整串会被当成一个条目，
  // 表现是「白名单加了三项，实际只生效一个怪名字」。
  expect(splitList('a，b,c')).toEqual(['a', 'b', 'c'])
})

test('空白（空格、制表、换行）也是分隔符', () => {
  expect(splitList('a b\tc\nd')).toEqual(['a', 'b', 'c', 'd'])
})

test('空格与逗号混用不产生空项', () => {
  expect(splitList(' a , b ,, c ')).toEqual(['a', 'b', 'c'])
})

test('空串给空数组', () => {
  expect(splitList('')).toEqual([])
})

test('只有分隔符的串给空数组', () => {
  // 配置项留空、或用户敲了 `, ,` 时，调用方拿到 [] 才走「未配置」分支；
  // 拿到 [''] 会当成「配了一个空条目」，白名单从此永远命中不了。
  expect(splitList(' , ，\t\n')).toEqual([])
})

test('连续分隔符之间的空项被丢掉', () => {
  expect(splitList('a,,b')).toEqual(['a', 'b'])
})

test('不把分号当分隔符', () => {
  // 分隔符集合要窄：`a;b` 这类串（样式表片段、shell 命令）被拆开会改变调用方语义。
  expect(splitList('a;b')).toEqual(['a;b'])
})

test('条目首尾空白被裁掉', () => {
  expect(splitList('  a  ,\tb\t')).toEqual(['a', 'b'])
})

test('nonEmptyString 返回原串，不做 trim', () => {
  // 这里只判「有没有给值」，不清洗：`" a "` 拿去拼路径或做匹配时首尾空白必须留着，
  // 否则调用方拿到的值和他配置的不是同一个。
  expect(nonEmptyString(' a ')).toBe(' a ')
})

test('空串当没给', () => {
  expect(nonEmptyString('')).toBeUndefined()
})

test('纯空白当没给', () => {
  // 配置里写一个空格很常见；放行会让「设了但为空」变成「设了一个空格」。
  expect(nonEmptyString('   ')).toBeUndefined()
})

test('非字符串当没给', () => {
  expect(nonEmptyString(null)).toBeUndefined()
  expect(nonEmptyString(undefined)).toBeUndefined()
  expect(nonEmptyString(0)).toBeUndefined()
  expect(nonEmptyString({})).toBeUndefined()
})

test('oneLine 把换行与连续空白压成一个空格', () => {
  expect(oneLine('a\n\nb\t c')).toBe('a b c')
})

test('oneLine 去掉首尾空白', () => {
  expect(oneLine('  a b  ')).toBe('a b')
})

test('oneLine 不传 limit 时只压平、不截断', () => {
  // 快照类调用只要「没有换行」，不想要截断；这里传 500 个字符验证它确实不砍。
  const long = 'x'.repeat(500)
  expect(oneLine(long)).toBe(long)
})

test('oneLine 恰好等于 limit 时不加省略号', () => {
  // 差一位就红：`<` 与 `<=` 的选择直接决定「刚好塞得下的摘要」会不会被白白砍掉一个字。
  expect(oneLine('abcde', 5)).toBe('abcde')
})

test('oneLine 超一位时砍到 limit 个字符再加省略号', () => {
  expect(oneLine('abcdef', 5)).toBe('abcde…')
})

test('oneLine 按压平后的长度计算，不按原始长度', () => {
  // '  ab  ' 原始 6 个字符、压平后 2 个；若先判长度再压平，明明放得下的摘要会被砍。
  expect(oneLine('  ab  ', 2)).toBe('ab')
})

test('oneLine 对空串返回空串', () => {
  expect(oneLine('')).toBe('')
})

test('oneLine 对纯空白返回空串', () => {
  expect(oneLine(' \n\t ')).toBe('')
})

test('oneLine 的 limit 为 0 时只剩省略号（非空输入）', () => {
  // 0 不是合理预算，但配置面可能算出来 0；此时返回 '…' 而不是整段原文，
  // 免得界面上「限 0 字」反而显示了全文。
  expect(oneLine('abc', 0)).toBe('…')
})
