/**
 * cmd.exe 参数加引号与 shell 选择的纯函数（unit 层）。
 *
 * `quoteForCmd` 是纯字符串函数；`shellOf` 只读 `process.platform`，不落盘、不起进程，
 * 所以两者都能直接喂。
 *
 * 为什么值得钉：加引号少一个字符就是一条注入路径（`a&calc` 会被 cmd 当成两条命令）；
 * `/d /s /c` 少一个，cmd 的引号剥离规则就换了一套。两者都不会在本地测试里「看起来坏」，
 * 只会在别人的机器上炸。
 *
 * @module dsc/core/shell-quote.spec
 */
import { expect, test } from 'vitest'
import { quoteForCmd, shellOf } from './shell-quote.js'

test('不含特殊字符的实参原样返回', () => {
  expect(quoteForCmd('node')).toBe('node')
  expect(quoteForCmd('C:\\tools\\dsc\\bin\\dsc.js')).toBe('C:\\tools\\dsc\\bin\\dsc.js')
})

test('空串原样返回，不加一对空引号', () => {
  // 空实参本身合法；包成 '""' 会让收到的一方拿到两个字面双引号。
  expect(quoteForCmd('')).toBe('')
})

test('含空格的实参加双引号', () => {
  expect(quoteForCmd('C:\\Program Files\\node.exe')).toBe('"C:\\Program Files\\node.exe"')
})

test('制表与换行也触发加引号', () => {
  // 换行在 cmd 里等价于命令分隔，不包引号会把一条参数断成两条。
  expect(quoteForCmd('a\tb')).toBe('"a\tb"')
  expect(quoteForCmd('a\nb')).toBe('"a\nb"')
})

test('每个 cmd 元字符都触发加引号', () => {
  // 少一个字符就是一条注入路径。用 map + toEqual 而不是逐条 expect：失败时能一次看全
  // 哪个字符漏了。
  const metas = ['&', '|', '<', '>', '^', '(', ')']
  expect(metas.map((meta) => quoteForCmd(`a${meta}b`))).toEqual(metas.map((meta) => `"a${meta}b"`))
})

test('内部双引号转义成 \\" 后再包一层双引号', () => {
  expect(quoteForCmd('a"b')).toBe('"a\\"b"')
})

test('单独一个双引号也要转义', () => {
  expect(quoteForCmd('"')).toBe('"\\""')
})

test('已经带引号的实参被再包一层（调用方只该过一道）', () => {
  // 这条故意钉住「不幂等」：它只该作用在原始实参上，重复调用会多一套引号，
  // 而多出来的引号会被目标程序当成实参正文。
  expect(quoteForCmd('"a b"')).toBe('"\\"a b\\""')
})

test('单引号不算特殊字符（cmd 不认它）', () => {
  expect(quoteForCmd("it's")).toBe("it's")
})

test('按当前平台给出固定的 shell 与参数', () => {
  // 参数顺序（/d /s /c）不是排版：少了 /s，cmd 对引号的处理规则就变了。
  // 两个分支都写全，平台迁移时一眼能看出该改哪边。
  const expected = process.platform === 'win32'
    ? { file: 'cmd.exe', args: ['/d', '/s', '/c'] }
    : { file: '/bin/sh', args: ['-c'] }
  expect(shellOf()).toEqual(expected)
})
