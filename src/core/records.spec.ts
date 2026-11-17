/**
 * 「是不是普通对象」判定的纯函数（unit 层）。
 *
 * 两个导出都不碰盘、不看环境，输入任意 `unknown` 就有确定结果，因此可以逐条喂边界值。
 *
 * 为什么值得单独测试：这套判定是解析外部 JSON（MCP、webhook、界面帧）的第一道门。
 * 口径变松，后续取值就会从「数组 / 函数」上取到莫名其妙的东西；口径变紧，
 * 合法记录会被当空值丢掉。两种错都不会抛异常，只会在界面上少一块数据。
 *
 * @module dsc/core/records.spec
 */
import { expect, test } from 'vitest'
import { asRecord, isRecord } from './records.js'

test('普通对象原样返回同一个引用', () => {
  // 返回同一引用而不是浅拷贝，是调用方「改字段能生效」的前提（例如把配置对象就地补默认值）。
  const input = { a: 1 }
  expect(asRecord(input)).toBe(input)
})

test('空对象也认，返回空对象而不是 null', () => {
  // JSON 里的 `{}` 是合法记录：认它，调用方才能按「没有字段」处理，而不是按「没给对象」处理。
  expect(asRecord({})).toEqual({})
})

test('null 给 null', () => {
  expect(asRecord(null)).toBeNull()
})

test('undefined 给 null', () => {
  expect(asRecord(undefined)).toBeNull()
})

test('数组给 null（JSON 数组不是记录）', () => {
  // 数组的 typeof 也是 'object'；只看 typeof 的写法会把 [1,2] 当记录，随后 `record['0']`
  // 取到 1 这种「能跑但语义全错」的结果。
  expect(asRecord([1, 2])).toBeNull()
})

test('原始值给 null', () => {
  expect(asRecord('x')).toBeNull()
  expect(asRecord(0)).toBeNull()
  expect(asRecord(false)).toBeNull()
})

test('函数给 null（typeof 是 function，不是 object）', () => {
  // 函数上挂属性完全合法（`fn.config = {}`），但「能取属性」不等于「是记录」；
  // 放行会让调用方把回调当配置对象去改。
  expect(asRecord(() => 1)).toBeNull()
})

test('类实例与 Date 也会通过：实现只排除数组', () => {
  // 这条钉的是当前口径，不是文档承诺：模块注释写「普通对象」，实现却只看 typeof
  // 与 Array.isArray，带原型的实例照样通过。要收紧必须同步改文档与各调用方。
  expect(asRecord(new Date(0))).not.toBeNull()
  expect(asRecord(new (class Foo { a = 1 })())?.['a']).toBe(1)
})

test('isRecord 对普通对象为 true', () => {
  expect(isRecord({ a: 1 })).toBe(true)
  expect(isRecord({})).toBe(true)
})

test('isRecord 对数组为 false（与 asRecord 同口径）', () => {
  // 两个名字必须是同一件事的两种用法；一边认数组一边不认，是「取值时拿到 null、
  // 类型守卫却放行」的经典错配。
  expect(isRecord([1])).toBe(false)
})

test('isRecord 对 null 与 undefined 为 false', () => {
  expect(isRecord(null)).toBe(false)
  expect(isRecord(undefined)).toBe(false)
})

test('isRecord 对原始值与函数为 false', () => {
  expect(isRecord('x')).toBe(false)
  expect(isRecord(0)).toBe(false)
  expect(isRecord(true)).toBe(false)
  expect(isRecord(() => 1)).toBe(false)
})
