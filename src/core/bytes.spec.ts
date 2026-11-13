/**
 * 字节数人话读法的纯函数（unit 层）。
 *
 * `formatBytes` 不读盘、不看环境，输入数字、输出字符串。它与壳里 `ui-primitives/sizes.ts`
 * 的同名函数由 `scripts/ui-bytes-test.mjs` 逐字比对，所以这里的断言同时是那半边的行为契约。
 *
 * 为什么值得钉：单位换算错一位，界面上「1.2 MB」会变成「1228 KB」，用户不会报错，
 * 只会觉得这个软件「数不对」。负数与非有限数返回破折号，则是「不显示 NaN」的兜底。
 *
 * @module dsc/core/bytes.spec
 */
import { expect, test } from 'vitest'
import { formatBytes } from './bytes.js'

test('0 字节显示为 0 B', () => {
  expect(formatBytes(0)).toBe('0 B')
})

test('1KB 以下按整数 B 显示', () => {
  expect(formatBytes(512)).toBe('512 B')
  expect(formatBytes(1)).toBe('1 B')
})

test('不足 1 字节的小数四舍五入成整数 B', () => {
  expect(formatBytes(0.4)).toBe('0 B')
  expect(formatBytes(512.6)).toBe('513 B')
})

test('1023 字节仍是 1023 B', () => {
  // 边界下沿：1024 才换单位，1023 不能提前变成 0.9 KB。
  expect(formatBytes(1023)).toBe('1023 B')
})

test('1023.5 字节取整成 1024 B，仍不换单位', () => {
  // 单位判断在取整之前，所以它会显示成「1024 B」而不是「1 KB」。这是实现顺序的直接结果，
  // 也是「先判单位、再取整」与「先取整、再判单位」两种写法的分界点。
  expect(formatBytes(1023.5)).toBe('1024 B')
})

test('恰好 1024 字节显示为 1 KB，且抹掉 .0', () => {
  expect(formatBytes(1024)).toBe('1 KB')
})

test('1KB 与 10KB 之间保留一位小数', () => {
  expect(formatBytes(1536)).toBe('1.5 KB')
  expect(formatBytes(9728)).toBe('9.5 KB')
})

test('10KB 及以上取整，不再保留小数', () => {
  // 界面宽度有限；10 以上再留小数只会让同一列数字对不齐。
  expect(formatBytes(10240)).toBe('10 KB')
  expect(formatBytes(10752)).toBe('11 KB')
})

test('1MB 与 1.5MB', () => {
  expect(formatBytes(1024 * 1024)).toBe('1 MB')
  expect(formatBytes(1536 * 1024)).toBe('1.5 MB')
})

test('1GB 与 1.5GB', () => {
  expect(formatBytes(1024 ** 3)).toBe('1 GB')
  expect(formatBytes(1536 * 1024 ** 2)).toBe('1.5 GB')
})

test('1TB', () => {
  expect(formatBytes(1024 ** 4)).toBe('1 TB')
})

test('超过 TB 不再升单位，停在 1024 TB', () => {
  // 单位表只到 TB；没有上限判断的话 `value` 会继续除下去，单位数组越界变成 undefined。
  expect(formatBytes(1024 ** 5)).toBe('1024 TB')
})

test('负数给破折号', () => {
  // 负数在界面上没有任何含义；显示 -1 B 或 NaN 都不如一个破折号。
  expect(formatBytes(-1)).toBe('—')
})

test('NaN 给破折号', () => {
  expect(formatBytes(Number.NaN)).toBe('—')
})

test('正负无穷给破折号', () => {
  expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—')
  expect(formatBytes(Number.NEGATIVE_INFINITY)).toBe('—')
})
