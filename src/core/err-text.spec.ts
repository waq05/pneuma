/**
 * errText 的单位测试：把「抛出来的任意东西」压成一句话。
 *
 * 为什么这组用例值得钉：这句话原先在五处各抄一份（adapter/transcript、core/loop、
 * core/market、core/plugin-loader、渲染层）。合并成一份之后，各处真正的差别只体现在
 * **非 Error 输入**上——`throw 42`、`reject({ code })`、`throw null` 平时不出现，
 * 一出现就落在「会话里显示 undefined / [object Object]」这种排障现场，而且没人会
 * 怀疑到一句话的转换上。所以 Error 与非 Error 两侧的每种输入各钉一条。
 *
 * @module dsc/core/err-text.spec
 */
import { expect, test } from 'vitest'
import { errText } from './err-text.js'

test('Error 只取 message，不把错误名与堆栈带进文案', () => {
  // 界面拿这句话当「一行错误」渲染；带上 `Error: ` 前缀或调用栈会撑爆一张卡片，
  // 而真正有用的原因本来就在 message 里。
  expect(errText(new Error('连接超时'))).toBe('连接超时')
})

test('message 为空的 Error 得到空串，而不是字面量 Error', () => {
  // `throw new Error()` 是常见随手写法；退化成 'Error' 只剩一个没有信息量的词，
  // 退成空串至少能让调用方按「有错误但没说原因」处理。
  expect(errText(new Error(''))).toBe('')
})

test('Error 子类同样只取 message', () => {
  // 内核里 TypeError / RangeError / 自造错误混用。按 instanceof Error 判，子类才不会
  // 掉进 String(error) 分支变成 'TypeError: ...'。
  class ConfigError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'ConfigError'
    }
  }
  expect(errText(new ConfigError('配置项 api 未知'))).toBe('配置项 api 未知')
})

test('多行 message 原样保留，不压成一行', () => {
  // 解析失败时 message 里常带「第几行、哪一段」。压行会把定位信息挤成一句读不懂的话。
  expect(errText(new Error('第 1 行\n第 2 行'))).toBe('第 1 行\n第 2 行')
})

test('cause 不进入文案，只认最外层的 message', () => {
  // 因果链是排障用的；把它拼进一行文案会让主因被底层错误淹掉，要看链的人读 stack/cause。
  const error = new Error('外层失败', { cause: new Error('底层原因') })
  expect(errText(error)).toBe('外层失败')
})

test('字符串原样返回', () => {
  expect(errText('后端 500')).toBe('后端 500')
})

test('数字与布尔走 String 化，不变成 undefined 也不抛错', () => {
  // `throw 42` 与 Promise.reject(false) 都会走进来。这里同时钉住「非 Error 不炸」：
  // 换成模板字符串 `${error}` 时 Symbol 会抛，所以实现必须走 String() 或等价路径。
  expect(errText(42)).toBe('42')
  expect(errText(false)).toBe('false')
})

test('null 与 undefined 变成字面量，而不是空串', () => {
  // String(null) = 'null' 是可区分的：用户能看到「这里确实是 null」，而不是和
  // 「空 message 的 Error」混成同一种空白。
  expect(errText(null)).toBe('null')
  expect(errText(undefined)).toBe('undefined')
})

test('普通对象不抛错，走 String 化那条分支', () => {
  // 被 reject 的可能是个 { code, message } 对象。这里不承诺可读，只承诺不炸——
  // 一旦这条红了，说明实现退回了 `error.message` 这类假设。
  expect(errText({ code: 400 })).toBe('[object Object]')
})
