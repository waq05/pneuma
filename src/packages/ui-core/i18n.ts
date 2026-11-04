/**
 * 界面文案的语言与取词：一个页面只定一次语言，每个包自带一份中英对照。
 *
 * 为什么语言从启动图读、而不是让宿主现问一遍：文案在**首帧之前**就要用（骨架的标题、
 * 空态说明），等一次异步回读会让页面先闪一段中文再换英文。启动图是页面打开时就有的静态
 * 数据（`__DSC_BOOT__`），而且它已经带着 `host.language`——与插件中心读清单译本用的是
 * 同一个字段。
 *
 * 为什么取词器是 `createT` 而不是全局 `t`：插件 bundle 之间不能互相 import，每个包自己
 * 带字典、自己建一个取词器，键名只需要在本包内唯一。全局单例反而要求所有包的键名不许撞。
 *
 * 语言只有两档（与内核 `plugin-locale.ts` 同一口径）：`en` 开头读英文，其余读中文原文。
 * 中文是语义真源：英文缺某条时**回落中文**，不显示键名，也不显示空白。
 *
 * @module @dsc/ui-core/i18n
 */

/** 界面语言：只有这两档。 */
export type UiLanguage = 'zh' | 'en'

/** 一个包自带的两份对照（键名只在本包内有意义）。 */
export interface UiMessages {
  /** 中文原文：语义真源，缺英文时回落它。 */
  zh: Record<string, string>
  /** 英文译本。 */
  en: Record<string, string>
}

/**
 * 语言标签归一到两档。
 * @param tag - 例如 `'en'` / `'en-US'` / `'zh-CN'` / `undefined`
 * @returns `'en'` 或 `'zh'`
 */
export function normalizeLanguage(tag: string | null | undefined): UiLanguage {
  return typeof tag === 'string' && tag.trim().toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** 启动图里我们只关心这一个字段；不 import 引导，避免内核 ↔ 界面成环。 */
interface BootLanguageHost {
  host?: { language?: unknown }
}

let resolved: UiLanguage | null = null

/**
 * 当前界面语言（首次调用读一次启动图，之后固定：语言在页面生命周期里不会变）。
 *
 * 读不到启动图（单元测试、单独打开的组件页）时按中文——中文是原文，缺省最不容易出错。
 * @returns `'zh'` 或 `'en'`
 */
export function uiLanguage(): UiLanguage {
  if (resolved !== null) return resolved
  const global = globalThis as { __DSC_BOOT__?: BootLanguageHost }
  const tag = global.__DSC_BOOT__?.host?.language
  resolved = normalizeLanguage(typeof tag === 'string' ? tag : null)
  return resolved
}

/** 已经缺过译的键（只告警一次：同一条缺译在列表里刷屏没有信息量）。 */
const warned = new Set<string>()

/**
 * 造一个取词器。
 *
 * @param messages - 本包的两份对照
 * @returns `t(key, params?)`：按当前语言取词；英文缺译回落中文；中文也没有就返回键名并告警一次
 */
export function createT(messages: UiMessages): (key: string, params?: Record<string, string | number>) => string {
  return (key, params) => {
    const language = uiLanguage()
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
