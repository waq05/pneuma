/**
 * 界面文案的语言与取词：一个页面只定一次语言，每个包自带一份中英对照。
 *
 * 为什么语言从启动图读、而不是让宿主现问一遍：文案在**首帧之前**就要用（骨架的标题、
 * 空态说明），等一次异步回读会让页面先闪一段中文再换英文。启动图是页面打开时就有的静态
 * 数据（`__DSC_BOOT__`），而且它已经带着 `host.language`——与插件中心读清单译本、
 * 宿主读设置面文案用的是同一个字段、同一条判定。
 *
 * 为什么取词器是 `createT` 而不是全局 `t`：插件 bundle 之间不能互相 import，每个包自己
 * 带字典、自己建一个取词器，键名只需要在本包内唯一。全局单例反而要求所有包的键名不许撞。
 *
 * 判定与插值在 `src/core/i18n-text.ts`：宿主（读 `config.yaml`）与界面（读启动图）只差
 * 「语言从哪来」，取词规则必须只有一份。这个文件因此只剩「语言来源」这一件事。
 *
 * @module @dsc/ui-core/i18n
 */
import { createLocalizer, normalizeLanguage, type Translate, type UiLanguage, type UiMessages } from '../../core/i18n-text.js'

export { normalizeLanguage }
export type { Translate, UiLanguage, UiMessages }

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

/**
 * 造一个取词器。
 *
 * @param messages - 本包的两份对照
 * @returns `t(key, params?)`：按当前语言取词；英文缺译回落中文；中文也没有就返回键名并告警一次
 */
export function createT(messages: UiMessages): Translate {
  return createLocalizer(messages, uiLanguage())
}
