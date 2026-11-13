/**
 * 数字收敛的纯函数（unit 层）。
 *
 * `clamp.ts` 不读盘、不看环境、没有模块级状态，入参进、数字出——整份导出都能直接喂，
 * 所以这里不需要临时 HOME，也不需要任何桩。
 *
 * 这些断言钉的是「解析外部 JSON 的配置项」那套口径：收敛一旦走样，表现不是报错，
 * 而是用户改的设置静默变回缺省值，排查时看不出是哪一层丢的。
 *
 * @module dsc/core/clamp.spec
 */
import { expect, test } from 'vitest'
import { clampInt, clampIntIn, isFiniteNumber } from './clamp.js'

test('落在区间内的整数原样返回', () => {
  expect(clampInt(5, 0, 10, 0)).toBe(5)
})

test('低于下界时夹到下界', () => {
  // 配置面传 0 但下界是 1（例如「每几轮提醒一次」）：不夹的话 0 会被当成「关闭」，
  // 而语义上 0 只该是最频繁。
  expect(clampInt(0, 1, 100, 8)).toBe(1)
})

test('高于上界时夹到上界', () => {
  expect(clampInt(999, 1, 100, 8)).toBe(100)
})

test('恰好等于边界时原样返回（区间闭口）', () => {
  // 闭区间是调用方按「允许的最大值」写配置时依赖的：100 是保护线，不是第一个被改的值。
  expect(clampInt(1, 1, 100, 8)).toBe(1)
  expect(clampInt(100, 1, 100, 8)).toBe(100)
})

test('小数先四舍五入再返回', () => {
  expect(clampInt(2.4, 0, 10, 0)).toBe(2)
  expect(clampInt(2.6, 0, 10, 0)).toBe(3)
})

test('负小数按 Math.round 的口径向正方向取整', () => {
  // Math.round(-2.5) 是 -2 而不是 -3（JS 的半值向 +∞）。负数区间（偏移量、差额）
  // 上换成人肉四舍五入就会差 1，这条把语言语义钉在测试里。
  expect(clampInt(-2.5, -10, 0, 0)).toBe(-2)
})

test('数字字符串按 Number 的规则接受', () => {
  // 配置文件与环境变量都可能给字符串；这里认它，是「配置写 "8" 也能生效」的保证。
  expect(clampInt('42', 0, 100, 0)).toBe(42)
})

test('null 被 Number 成 0 后按区间夹取，而不是回落到缺省', () => {
  // JSON 里的 null 是合法值。若实现改成 `typeof value === 'number'` 判断，null 会走缺省，
  // 下界大于 0 时结果就从「下界」变成「缺省」，用户看到的间隔直接换了。
  expect(clampInt(null, 5, 10, 7)).toBe(5)
})

test('空串被 Number 成 0 后按区间夹取', () => {
  // 配置项留空与「填了 0」在 Number 语义下同值；这条说明实现是有意走转换而不是走类型判断。
  expect(clampInt('', 5, 10, 7)).toBe(5)
})

test('布尔按 0 / 1 转换', () => {
  expect(clampInt(true, 0, 10, 7)).toBe(1)
  expect(clampInt(false, 0, 10, 7)).toBe(0)
})

test('undefined 不是有限数，回落到缺省', () => {
  expect(clampInt(undefined, 1, 100, 8)).toBe(8)
})

test('NaN 不是有限数，回落到缺省', () => {
  expect(clampInt(Number.NaN, 1, 100, 8)).toBe(8)
})

test('正负无穷都不是有限数，回落到缺省', () => {
  // 比例类配置拿 0 做分母就会算出 Infinity；它必须走缺省，不能被夹成上界，
  // 否则「比例配 0」会悄悄变成「比例配满」。
  expect(clampInt(Number.POSITIVE_INFINITY, 1, 100, 8)).toBe(8)
  expect(clampInt(Number.NEGATIVE_INFINITY, 1, 100, 8)).toBe(8)
})

test('解析不出数字的字符串回落到缺省', () => {
  expect(clampInt('八', 1, 100, 8)).toBe(8)
})

test('缺省值本身不参与夹取', () => {
  // 缺省值是调用方写死的代码常量，不是用户输入；悄悄夹它会把「缺省 99」变成 10，
  // 排查时又少一条线索。这条钉的是「缺省原样返回」。
  expect(clampInt(Number.NaN, 0, 10, 99)).toBe(99)
})

test('区间成对给出时与摊开 min / max 的结果一致', () => {
  expect(clampIntIn('15', { min: 0, max: 10 }, 0)).toBe(10)
  expect(clampIntIn(3, { min: 0, max: 10 }, 0)).toBe(3)
})

test('isFiniteNumber：有限数字（含 0 与负数）为 true', () => {
  expect(isFiniteNumber(0)).toBe(true)
  expect(isFiniteNumber(-0)).toBe(true)
  expect(isFiniteNumber(-1.5)).toBe(true)
  expect(isFiniteNumber(Number.MAX_SAFE_INTEGER)).toBe(true)
})

test('isFiniteNumber：NaN 与正负无穷为 false', () => {
  expect(isFiniteNumber(Number.NaN)).toBe(false)
  expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false)
  expect(isFiniteNumber(Number.NEGATIVE_INFINITY)).toBe(false)
})

test('isFiniteNumber：字符串数字与布尔为 false（类型守卫不看可转换性）', () => {
  // 类型守卫与 clampInt 的口径故意不同：守卫用于「解析结果是不是数字」，`"8"` 仍是字符串；
  // clampInt 用于取值，允许 Number 转换。混同会让 JSON 里的字符串混进数值字段。
  expect(isFiniteNumber('8')).toBe(false)
  expect(isFiniteNumber(true)).toBe(false)
})

test('isFiniteNumber：null、undefined、对象、BigInt 均为 false', () => {
  expect(isFiniteNumber(null)).toBe(false)
  expect(isFiniteNumber(undefined)).toBe(false)
  expect(isFiniteNumber({})).toBe(false)
  expect(isFiniteNumber(8n)).toBe(false)
})
