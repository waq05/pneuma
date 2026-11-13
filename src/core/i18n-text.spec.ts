/**
 * 取词纯逻辑的单位测试：语言归一、查字典、回落、插值、缺译兜底。
 *
 * 为什么这组用例值得钉：语言的来源分两处（宿主读 config.yaml，界面读启动图），但判定
 * 只能有一份。这里钉的都是「两边必须一致」的判定：`en-US` 算英文、英文缺译回落中文、
 * 中文也没有才给键名。判错一条的表现是界面突然整段英文或整段键名，而不是抛错。
 *
 * 注意：缺译告警用模块级的 Set 去重，同一进程里同一个键只告警一次。所以下面每条
 * 告警用例都用**自己的键**，避免用例之间互相把告警吃掉。
 *
 * @module dsc/core/i18n-text.spec
 */
import { expect, test, vi } from 'vitest'
import { createLocalizer, normalizeLanguage } from './i18n-text.js'

// ── 语言归一 ────────────────────────────────────────────────────────────────

test('en 原样归到英文', () => {
  expect(normalizeLanguage('en')).toBe('en')
})

test('en-US 这类带地区后缀的标签也归到英文', () => {
  // 浏览器给的 navigator.language 就是这个形态；只认严格等于 'en' 会让英文用户看到中文。
  expect(normalizeLanguage('en-US')).toBe('en')
})

test('大小写与首尾空白不影响判定', () => {
  // config.yaml 里手写 `language: EN ` 很常见，多一个空格就回落中文是说不通的。
  expect(normalizeLanguage(' EN-GB ')).toBe('en')
})

test('标签以 en 开头即算英文', () => {
  // 实现是 startsWith('en')，所以 'english' 这种非标准写法也归英文；这条钉住的是
  // 「前缀判定」而不是「白名单判定」。
  expect(normalizeLanguage('english')).toBe('en')
})

test('zh-CN 归到中文原文', () => {
  expect(normalizeLanguage('zh-CN')).toBe('zh')
})

test('空串归到中文原文', () => {
  // 配置项留空时不能变成 undefined 语言；中文是语义真源，默认落它最安全。
  expect(normalizeLanguage('')).toBe('zh')
})

test('null 与 undefined 归到中文原文', () => {
  expect(normalizeLanguage(null)).toBe('zh')
  expect(normalizeLanguage(undefined)).toBe('zh')
})

test('非英文的非空标签（fr）也落中文原文，不落英文', () => {
  // 只有中英两档：第三种语言没有译本，回落中文原文比回落英文更接近语义真源。
  expect(normalizeLanguage('fr')).toBe('zh')
})

// ── 查字典与回落 ────────────────────────────────────────────────────────────

test('中文语言取中文原文', () => {
  const t = createLocalizer({ zh: { a: '中文' }, en: { a: 'english' } }, 'zh')
  expect(t('a')).toBe('中文')
})

test('英文语言优先取英文译本', () => {
  const t = createLocalizer({ zh: { a: '中文' }, en: { a: 'english' } }, 'en')
  expect(t('a')).toBe('english')
})

test('英文缺译时回落中文原文', () => {
  // 这是最要紧的一条：缺译不能显示键名，也不能显示空串，否则界面会突然出现
  // `settings.title` 这种给开发看的字符串。
  const t = createLocalizer({ zh: { a: '中文' }, en: {} }, 'en')
  expect(t('a')).toBe('中文')
})

test('回落中文不算缺译，不告警', () => {
  // 英文没译是常态进度，不是配置错误；告警会把控制台刷满。
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const t = createLocalizer({ zh: { 'spec.fallback.ok': '中文' }, en: {} }, 'en')
  t('spec.fallback.ok')
  expect(spy).not.toHaveBeenCalled()
  spy.mockRestore()
})

test('两边都没有这条键时返回键名', () => {
  // 返回键名而不是空串：界面上看得见「这里缺一条文案」，也看得见缺的是哪条。
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const t = createLocalizer({ zh: {}, en: {} }, 'zh')
  expect(t('spec.missing.only')).toBe('spec.missing.only')
  spy.mockRestore()
})

test('缺译只告警一次，同一条键重复取词不刷屏', () => {
  // 一个缺译的键可能在列表里被取几十次（每行一次）；只告警一次才留得下这条信息。
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const t = createLocalizer({ zh: {}, en: {} }, 'en')
  t('spec.missing.once')
  t('spec.missing.once')
  t('spec.missing.once')
  expect(spy).toHaveBeenCalledTimes(1)
  expect(String(spy.mock.calls[0]?.[0])).toContain('spec.missing.once')
  spy.mockRestore()
})

// ── 插值 ────────────────────────────────────────────────────────────────────

test('数字参数替换到占位符里', () => {
  const t = createLocalizer({ zh: { a: '共 {n} 条' }, en: {} }, 'zh')
  expect(t('a', { n: 3 })).toBe('共 3 条')
})

test('字符串参数原样替换', () => {
  const t = createLocalizer({ zh: { a: '模型：{name}' }, en: {} }, 'zh')
  expect(t('a', { name: 'deepseek-chat' })).toBe('模型：deepseek-chat')
})

test('同一个占位符出现两次都替换', () => {
  // 替换用的是全局正则；漏了 g 只会换第一处，界面上就是 `{n} 条里有 {n} 条`。
  const t = createLocalizer({ zh: { a: '{n} 条里有 {n} 条' }, en: {} }, 'zh')
  expect(t('a', { n: 2 })).toBe('2 条里有 2 条')
})

test('没给对应参数时占位符原样保留', () => {
  // 调用方漏传参数时，保留 `{n}` 比填 'undefined' 更容易定位；也不会把文案改坏。
  const t = createLocalizer({ zh: { a: '共 {n} 条' }, en: {} }, 'zh')
  expect(t('a', { other: 1 })).toBe('共 {n} 条')
})

test('多余参数不影响文案', () => {
  const t = createLocalizer({ zh: { a: '固定文案' }, en: {} }, 'zh')
  expect(t('a', { n: 1 })).toBe('固定文案')
})

test('不传参数时连花括号都原样返回', () => {
  // 没有 params 就整段返回原文，不做一次空替换——这样文案里的 `{` 不会被误伤。
  const t = createLocalizer({ zh: { a: '保留 {n} 原样' }, en: {} }, 'zh')
  expect(t('a')).toBe('保留 {n} 原样')
})

test('英文文案同样做插值', () => {
  // 插值发生在选完语言之后，两种语言共用同一段替换逻辑。
  const t = createLocalizer({ zh: {}, en: { a: 'Show {n} items' } }, 'en')
  expect(t('a', { n: 5 })).toBe('Show 5 items')
})

test('花括号里带空格不是占位符，不替换', () => {
  // 只认 `{name}` 这一种写法，是为了不和 JSX / 模板语法打架；带空格的按普通文本处理。
  const t = createLocalizer({ zh: { a: '共 { n } 条' }, en: {} }, 'zh')
  expect(t('a', { n: 3 })).toBe('共 { n } 条')
})
