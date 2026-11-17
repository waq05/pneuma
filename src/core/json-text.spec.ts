/**
 * 安全序列化的纯函数（unit 层）。
 *
 * `jsonText` 唯一的外部行为就是 `JSON.stringify` 加一层兜底；不读盘、不看环境，
 * 所以这里直接把各种「stringify 会抛」的输入喂进去。
 *
 * 为什么值得逐条钉：这条路上抛异常会连累整个界面帧或原生应答（模块注释的原话），
 * 而它被两处调用点当「万能序列化」用。返回 null 与返回字符串 'null' 的区别，
 * 是调用方判断「有没有序列化成功」的唯一依据。
 *
 * @module dsc/core/json-text.spec
 */
import { expect, test } from 'vitest'
import { jsonText } from './json-text.js'

test('普通对象序列化成紧凑 JSON', () => {
  expect(jsonText({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}')
})

test('数组照常序列化', () => {
  expect(jsonText([1, 'a', null])).toBe('[1,"a",null]')
})

test('字符串结果带引号，与「失败返回 null」区分开', () => {
  // 调用方常把返回值直接塞进 JSON 字段：'a' 序列化成 '"a"'，而不是裸的 a。
  expect(jsonText('a')).toBe('"a"')
})

test('数字与布尔原样序列化', () => {
  expect(jsonText(1)).toBe('1')
  expect(jsonText(false)).toBe('false')
})

test('null 序列化成字符串 "null"', () => {
  expect(jsonText(null)).toBe('null')
})

test('undefined 给 null（JSON 里没有 undefined 字面量）', () => {
  // 注意返回值是 null 本身，不是字符串；这一条与下一条的 NaN 正好构成对照。
  expect(jsonText(undefined)).toBeNull()
})

test('函数与 Symbol 给 null', () => {
  expect(jsonText(() => 1)).toBeNull()
  expect(jsonText(Symbol('x'))).toBeNull()
})

test('BigInt 抛错被吞掉，给 null', () => {
  // JSON.stringify(1n) 直接抛 TypeError；原生桥与界面帧不能因为一个 BigInt 就整帧黑掉。
  expect(jsonText(1n)).toBeNull()
})

test('循环引用给 null 而不是抛错', () => {
  const loop: Record<string, unknown> = { a: 1 }
  loop['self'] = loop
  expect(jsonText(loop)).toBeNull()
})

test('对象里的 undefined 键被丢掉（JSON 口径）', () => {
  // 这是 JSON.stringify 的正常行为，不是兜底；钉它是因为调用方按「键一定在」读字段。
  expect(jsonText({ a: undefined, b: 1 })).toBe('{"b":1}')
})

test('NaN 与 Infinity 序列化成字符串 "null"（不是返回值 null）', () => {
  // 与 undefined 那条的区别很实用：JSON 规范把非有限数写成 null，所以调用方拿到的是
  // 四个字符的 'null'，不是「序列化失败」。这正是「不能拿返回值当类型判据」的原因。
  expect(jsonText(Number.NaN)).toBe('null')
  expect(jsonText(Number.POSITIVE_INFINITY)).toBe('null')
})

test('带 toJSON 的对象交给 toJSON 决定', () => {
  expect(jsonText(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"')
})
