/**
 * 插件清单的两行字按语言取：`locale/<语言>.json` 优先，回落到 `package.json` 的
 * `pneuma.title` / `pneuma.description`。
 *
 * 为什么只本地化这两行：它们是 `numa plugin list` 与插件中心里**给用户看**的全部文字，
 * 组件内部的界面文案属于各包自己的界面，不在这一层管（见各包 README 的已知限制）。
 *
 * 语言只有两档：`en` 开头读 `locale/en.json`，其余（含 `zh` 与没配）用清单原文。
 * 中文原文是语义真源，`locale/en.json` 是它的译本；译本缺字段就当没译，逐字段回落。
 *
 * 读盘只发生一次：按「包目录 + 语言」缓存，同一个包目录不会每次 `list()` 都读盘。
 *
 * 这个模块刻意**不 import 别的内核模块**（只有 node 内置与 yaml）：源码直读探针能直接
 * import 它，不必等 tsc 产物。
 *
 * @module dsc/core/plugin-locale
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

/** 没配语言时按中文（清单原文就是中文）。 */
export const DEFAULT_LANGUAGE = 'zh-CN'

/** 有译本的语言：现在只有一份英文。 */
type LocaleName = 'en'

/** 清单里与语言无关、但插件中心要显示的那两项。 */
export interface PluginDisplay {
  title?: string
  description?: string
}

/**
 * 从 config.yaml 解析出来的文档里取 `language`。
 *
 * 读不懂 / 不是字符串 / 空串一律按缺省中文——语言配错不该让插件列表变成空标题。
 * @param doc - 解析后的配置文档（形状不认识时也能调）
 * @returns 语言标签，例如 'zh-CN' / 'en'
 */
export function languageOfConfig(doc: unknown): string {
  if (doc === null || typeof doc !== 'object') return DEFAULT_LANGUAGE
  const value = (doc as { language?: unknown }).language
  if (typeof value !== 'string') return DEFAULT_LANGUAGE
  const trimmed = value.trim()
  return trimmed === '' ? DEFAULT_LANGUAGE : trimmed
}

/**
 * 直接读一份配置文件取语言（不碰 providers，也不做任何写盘动作）。
 *
 * 为什么不用 `readConfig()`：`numa plugin list` 要在内核起来之前跑，而 `readConfig()`
 * 会顺带做凭据注入与 dsh 迁移（没配置时会往 `~/.dsc` 写文件）。显示语言只要一个字段，
 * 不值得把那些副作用带进来。
 * @param file - config.yaml 的绝对路径
 * @returns 语言标签；文件不在或读不懂给缺省值
 */
export function languageOfConfigFile(file: string): string {
  if (file === '' || !existsSync(file)) return DEFAULT_LANGUAGE
  try {
    return languageOfConfig(YAML.parse(readFileSync(file, 'utf8')))
  } catch {
    return DEFAULT_LANGUAGE
  }
}

/**
 * 语言标签 → 有译本的语言；null = 用清单原文。
 * @param language - 例如 'en' / 'en-US' / 'zh-CN'
 */
function localeOf(language: string): LocaleName | null {
  return language.trim().toLowerCase().startsWith('en') ? 'en' : null
}

/** 已读过的译本：键是 `包目录\0语言`，同一次进程里只读一次盘。 */
const localeCache = new Map<string, PluginDisplay>()

/** 一个译本文件里认得的两个字段；缺的、空的、不是字符串的都不算译过。 */
function readLocaleFile(dir: string, name: LocaleName): PluginDisplay {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'locale', `${name}.json`), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const record = parsed as Record<string, unknown>
    const pick = (key: string): string | undefined => {
      const value = record[key]
      return typeof value === 'string' && value.trim() !== '' ? value : undefined
    }
    const title = pick('title')
    const description = pick('description')
    return {
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
    }
  } catch {
    // 文件不在、坏 JSON、形状不对：都当没译过，回落清单元数据。这里不抛——
    // 一个包的译本坏了不该让整张插件列表起不来。
    return {}
  }
}

/**
 * 某个包目录在某种语言下的译本（只读一次盘）。
 * @param dir - 包目录（`locale/` 与 `package.json` 所在目录）
 * @param language - 语言标签
 * @returns 译过的字段；没有译本 / 该语言不翻译给空对象
 */
export function pluginLocaleOf(dir: string, language: string): PluginDisplay {
  const name = localeOf(language)
  if (name === null) return {}
  const key = `${dir}\u0000${name}`
  const cached = localeCache.get(key)
  if (cached !== undefined) return cached
  const text = readLocaleFile(dir, name)
  localeCache.set(key, text)
  return text
}

/**
 * 插件中心与 `numa plugin list` 显示的两行字：先查译本，再回落清单。
 *
 * 逐字段回落：译本只译了标题时，描述仍用原文，而不是整条丢掉。
 * @param manifest - 包清单（读到的那份 `package.json`；null = 没读到）
 * @param dir - 这个包所在的目录
 * @param language - 语言标签
 * @returns title / description；两处都没有时字段缺省
 */
export function pluginDisplayOf(
  manifest: Record<string, unknown> | null,
  dir: string,
  language: string,
): PluginDisplay {
  const raw = manifest?.['pneuma']
  const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const pick = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const locale = pluginLocaleOf(dir, language)
  const title = locale.title ?? pick('title')
  const description = locale.description ?? pick('description')
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  }
}
