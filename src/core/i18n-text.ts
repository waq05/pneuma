/**
 * 取词的纯逻辑：语言归一、查字典、插值、缺译告警。
 *
 * 为什么单独一个文件：宿主与界面都要取词，但**语言的来源不同**——宿主读 `config.yaml`
 * 的 `language:`（见 `src/core/i18n.ts`），界面读启动图的 `host.language`
 * （见 `src/packages/ui-core/i18n.ts`）。判定规则不能各写一份：`en` 开头读英文，
 * 其余读中文原文；英文缺译回落中文；中文也缺就给键名并在控制台告警一次。
 *
 * 零依赖（连 node 内置都不 import）：`@pneuma/ui-core` 把它转出给界面壳，
 * 这里混进一个 `node:` 前缀就会在浏览器里炸。`scripts/ui-locale-test.mjs` 与本文件
 * 的注释一起钉住这条约束。
 *
 * @module dsc/core/i18n-text
 */

/** 语言只有两档：中文原文与英文译本。 */
export type UiLanguage = 'zh' | 'en'

/** 一个包自带的两份对照（键名只在本包内有意义）。 */
export interface UiMessages {
  /** 中文原文：语义真源，英文缺这条时回落它。 */
  zh: Record<string, string>
  /** 英文译本；没写某条键就是「没译」，不是空串。 */
  en: Record<string, string>
}

/** 取词器：`t('section.title')` 或 `t('field.count.help', { n: 3 })`。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * 语言标签归一到两档。
 * @param tag - 例如 `'en'` / `'en-US'` / `'zh-CN'` / `undefined`
 * @returns `'en'` 或 `'zh'`
 */
export function normalizeLanguage(tag: string | null | undefined): UiLanguage {
  return typeof tag === 'string' && tag.trim().toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** 已经缺过译的键（只告警一次：同一条缺译在列表里刷屏没有信息量）。 */
const warned = new Set<string>()

/**
 * 造一个取词器。
 *
 * @param messages - 本包的两份对照
 * @param language - 已经归一过的语言
 * @returns 取词函数：按语言取；英文缺译回落中文；中文也没有就返回键名并告警一次
 */
export function createLocalizer(messages: UiMessages, language: UiLanguage): Translate {
  return (key, params) => {
    const text = language === 'en' ? (messages.en[key] ?? messages.zh[key]) : messages.zh[key]
    if (text === undefined) {
      if (!warned.has(key)) {
        warned.add(key)
        console.warn(`[i18n] 缺文案：${key}（语言 ${language}）`)
      }
      return key
    }
    if (params === undefined) return text
    // 插值只认 `{name}` 这一种写法：够用，也不会和 JSX 的花括号打架。
    return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = params[name]
      return value === undefined ? whole : String(value)
    })
  }
}
