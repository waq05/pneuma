/**
 * 宿主的取词：语言来自 `config.yaml` 的 `language:`，字典来自包自己的 `locale/`。
 *
 * 为什么宿主也要取词：设置页的分区标题与字段、权限档位名、模式名这些文案是**宿主包**
 * 拼好后交给界面的（`getSettingsSections` 之类的界面通道），不在各包的 `ui/` 目录里，
 * 界面那套按启动图取词的 `createT` 覆盖不到它们。宿主取同一份 `ui.zh.json` /
 * `ui.en.json`，两半的语言因此永远一致。
 *
 * 语言只读一次：它与界面一样是「配置文件里的值」，改了要重启——页面生命周期内不会变，
 * 所以不需要订阅。配置路径还没落盘（`activeConfigFile()` 给空串）时**不缓存**，
 * 等下一次调用再读，免得把「还没读到配置」钉成中文。
 *
 * 翻译内容不进这个模块：它只做「读盘 + 查表」，键值由各包自己的 `locale/` 提供。
 *
 * @module dsc/core/i18n
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { activeConfigFile } from './config-store.js'
import { languageOfConfigFile } from './plugin-locale.js'
import { createLocalizer, normalizeLanguage, type Translate, type UiLanguage, type UiMessages } from './i18n-text.js'

export { createLocalizer, normalizeLanguage }
export type { Translate, UiLanguage, UiMessages }

/** 已经解析过的语言（null = 还没读，或配置路径还没落盘）。 */
let cachedLanguage: UiLanguage | null = null

/**
 * 宿主这一侧的语言：`config.yaml` 的 `language:`，归一成两档。
 *
 * 与界面同源：`webserver` 把同一个函数的结果写进启动图的 `host.language`。
 * @returns `'zh'` 或 `'en'`
 */
export function hostUiLanguage(): UiLanguage {
  if (cachedLanguage !== null) return cachedLanguage
  const file = activeConfigFile()
  const language = normalizeLanguage(languageOfConfigFile(file))
  // 空路径 = 偏好还没读出来（或用户把配置换成了空）。这时读到的「中文」不算答案。
  if (file !== '') cachedLanguage = language
  return language
}

/** 已经读过的字典：键是包目录，一个进程只读一次盘。 */
const dicts = new Map<string, UiMessages>()

/** 已经告警过「缺字典」的目录（同一个包只报一次，免得每取一个词刷一行）。 */
const warnedMissing = new Set<string>()

/**
 * 读一份字典文件；不在、坏 JSON、值不是字符串都当「没这条」。
 * @param file - 字典的绝对路径
 * @returns 键值表；读不出来给 null
 */
function readDict(file: string): Record<string, string> | null {
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return null
  }
}

/**
 * 一个包的界面字典：`locale/ui.zh.json`（必须）与 `locale/ui.en.json`（可缺）。
 *
 * 中文那份是语义真源，缺了就是构建漏了文件——直接抛，别让界面静默显示键名。
 * @param dir - 包目录（编译后是 `lib/packages/<id>`，源码期是 `src/packages/<id>`）
 * @returns 两份对照
 */
export function loadUiMessages(dir: string): UiMessages {
  const hit = dicts.get(dir)
  if (hit !== undefined) return hit
  const zh = readDict(join(dir, 'locale', 'ui.zh.json'))
  if (zh === null) {
    // 不抛：一个包漏了字典不该让整个插件起不来（与 plugin-locale 同一条纪律）。
    // 代价是界面显示键名而不是文案——那是**看得见**的坏，比「插件加载失败」好查。
    // 提交前由 `scripts/ui-locale-test.mjs` 判死，轮不到它上线。
    if (!warnedMissing.has(dir)) {
      warnedMissing.add(dir)
      console.warn(`[i18n] ${dir} 缺 locale/ui.zh.json：这一包的设置面文案会显示成键名`)
    }
  }
  const messages: UiMessages = { zh: zh ?? {}, en: readDict(join(dir, 'locale', 'ui.en.json')) ?? {} }
  dicts.set(dir, messages)
  return messages
}

/**
 * 宿主包自己的取词器。
 *
 * 第一次取词时才解析语言（插件 apply 时配置可能还没落盘，早读会钉错语言）；
 * 之后同一个包的取词器固定，语言在进程内不变。
 *
 * @param dir - 包目录，源码里写 `import.meta.dirname`
 * @returns `t(key, params?)`
 */
export function hostT(dir: string): Translate {
  const messages = loadUiMessages(dir)
  let localize: Translate | null = null
  return (key, params) => {
    localize ??= createLocalizer(messages, hostUiLanguage())
    return localize(key, params)
  }
}
