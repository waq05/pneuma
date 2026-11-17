/**
 * 外观偏好：主题模式、字号、字体、密度怎么落到 DOM 上（浏览器侧）。
 *
 * 字号的真源是 px（`textSizePx`），`--dsc-font-scale` 是由它算出来的派生值：px ÷ 14
 * （见 `contract/fonts.ts` 的 `fontScaleFromTextSizePx`）。以前这里存的是倍率、自己夹
 * 0.85–1.35，于是基准从 13 改成 14 之后「设置里写 100%」和「正文 14px」就对不上了。
 *
 * 字体两项（正文 / 代码）走 CSS 变量 `--dsc-font-text` / `--dsc-font-code`。空串时必须
 * `removeProperty`，**不能写空串**：`var(--x, 兜底)` 里的 `--x` 若是「存在但为空」，
 * 整条 `font-family` 会因语法非法被浏览器丢弃、退回默认字体（不是退回兜底栈）。
 *
 * 与桌面渲染层 `desktop/src/renderer/appearance.ts` 同一套语义：真源在宿主的
 * `~/.dsc/settings.json`（走 `getUiPrefs`），这里另存一份 localStorage 镜像，
 * 只为首帧不闪——宿主回读还没到，就能按上次的设置上色。
 *
 * 从旧版搬过来时**故意删掉**三件事（不是漏了）：
 *   1. `pushWindowChrome`：那是在跟 Electron 主进程报原生窗口控件区的颜色——浏览器里
 *      没有这个口子。**现在回来了**：走原生桥（`pushNativeChrome` → `getHostNative()`），
 *      桥缺席时整段是空操作。桌面窗口切到本壳时，这一条才是有用的那一条。
 *   2. `dsc.setThemeSource`：原生弹出层（select 下拉、右键菜单）的深浅同理——同样经
 *      原生桥回来了（`pushNativeChrome` 里那一次 `setThemeSource`）。
 *   3. **按钮大小这条轴**：dsh 没有按钮缩放变量（它的全局轴是字号），按「按钮尺寸对齐
 *      dsh」的口径，本壳不再往 `--dsc-btn-scale` 写值——那批 `calc(Npx * var(--dsc-btn-scale))`
 *      在 `styles.css` 里被固定尺寸覆盖掉了。旧存档里的 `buttonScale` 读得到就忽略，
 *      不做迁移提示（它只影响观感，不影响功能）。
 *
 * @module dsc-ui-shell/appearance
 */
// 这四个类型本来就住在 `@dsc/ui-core`（`@dsc/ui` 只是转出去），这里直接向下取：
// 少一条通往聚合面的类型依赖。原生桥与读色同理——它们在 `@dsc/ui-primitives`
// （`native.ts` / `css.ts`）里实现，`@dsc/ui` 只转出；本包对 `@dsc/ui` 的边因此清零
// （探针 [5b] 已把这条边改成硬禁止，见 ui-layout/index.ts 的说明）。
import type { ThemeMode, UiDensity, UiFontSize, UiPrefsView } from '@dsc/ui-core'
import {
  FONT_SIZE_PX_DEFAULT,
  fontScaleFromTextSizePx,
  normalizeFontList,
  normalizeTextSizePx,
  textSizePxFromLegacy,
} from '@dsc/ui-core'
import { getHostNative, readCssColor } from '@dsc/ui-primitives'

export type { ThemeMode, UiDensity, UiFontSize }

/** 折叠时机（'completion' 跑完立刻收起 / 'next-input' 等下次发言再收起）。 */
export type CollapseTiming = UiPrefsView['collapseTiming']
/** 收起后显示哪些助手回复（'all' 全部 / 'final' 只留最终回答）。 */
export type FoldedReplies = UiPrefsView['foldedReplies']

/**
 * 一项外观设置。按钮大小不在这里——那条轴已经退场（见文件头第 3 条）。
 *
 * collapseTiming / foldedReplies 严格说不是「外观」（不碰配色与字号），但它们和外观一样
 * 是壳读一次、多处消费的界面偏好，所以搭这一趟归一化的车：这里接住并原样带出去，
 * 免得被下面只挑三项的归一化吃掉（消费方仍可直接读 getUiPrefs 的原值）。
 */
export interface Appearance {
  themeMode: ThemeMode
  /** 正文 px（10–22，默认 14）：字号的唯一真源，`--dsc-font-scale` 由它算出。 */
  textSizePx: number
  /** 正文字体列表（已归一）；空串 = 用内置栈。 */
  textFontFamily: string
  /** 代码字体列表（已归一）；空串 = 用内置栈。 */
  codeFontFamily: string
  density: UiDensity
  collapseTiming: CollapseTiming
  foldedReplies: FoldedReplies
}

/**
 * 出厂默认：claude（暖米白）、正文 14px、字体跟随内置栈、标准密度。
 *
 * 真源是 `core/prefs.ts` 的 readPrefs 默认值；这里跟着一起改，是为了宿主还没回读、
 * 或 localStorage 镜像为空的那一帧也落在同一个主题上（0.7.2 起默认由 dark 改成 claude）。
 */
export const DEFAULT_APPEARANCE: Appearance = {
  themeMode: 'claude',
  textSizePx: FONT_SIZE_PX_DEFAULT,
  // 空串 = 不写 CSS 变量，界面用 tokens.css 里的内置栈。
  textFontFamily: '',
  codeFontFamily: '',
  density: 'standard',
  // 与 core/prefs.ts 同口径：时机默认跑完立刻收起，收起后默认保留全部回复。
  collapseTiming: 'completion',
  foldedReplies: 'final',
}

/** 密度只有三档；认不出的值回落 standard。 */
function normalizeDensity(value: unknown): UiDensity {
  return value === 'compact' || value === 'roomy' ? value : 'standard'
}

/** 主题四档（与 `src/core/prefs.ts` 的 `THEME_MODES` 同一份口径）。 */
const THEME_MODES: readonly ThemeMode[] = ['dark', 'light', 'claude', 'system']

/** 主题只有四档；认不出的值回落 claude（与出厂默认一致）。 */
function normalizeTheme(value: unknown): ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
    ? (value as ThemeMode)
    : 'claude'
}

/**
 * 折叠时机两档；认不出的值回落 'completion'（与 core/prefs.ts 的默认同一档）。
 *
 * @param value 宿主回读或 localStorage 镜像里的原始值
 */
function normalizeCollapseTiming(value: unknown): CollapseTiming {
  return value === 'next-input' ? 'next-input' : 'completion'
}

/**
 * 收起后显示的回复两档；认不出的值回落 'all'（参考实现的默认值，不是 'final'）。
 *
 * @param value 宿主回读或 localStorage 镜像里的原始值
 */
function normalizeFoldedReplies(value: unknown): FoldedReplies {
  return value === 'final' ? 'final' : 'all'
}

/**
 * 把宿主 `getUiPrefs` 的返回值（或 localStorage 镜像）归一成渲染层能直接用的外观。
 *
 * 字号取 px 为准。老壳、老镜像、手机远程那份还没升级，只有倍率 `fontSize`——那就按
 * `textSizePxFromLegacy` 换算一次（认不出的回落默认 14px），不让它们把界面带成 0px。
 *
 * @param prefs 宿主原样返回的界面偏好，或解析出来的镜像
 */
export function appearanceFromPrefs(prefs: Partial<UiPrefsView> | null | undefined): Appearance {
  const textSizePx =
    typeof prefs?.textSizePx === 'number'
      ? normalizeTextSizePx(prefs.textSizePx)
      : textSizePxFromLegacy(prefs?.fontSize) ?? FONT_SIZE_PX_DEFAULT
  return {
    themeMode: normalizeTheme(prefs?.themeMode),
    textSizePx,
    textFontFamily: normalizeFontList(prefs?.textFontFamily),
    codeFontFamily: normalizeFontList(prefs?.codeFontFamily),
    density: normalizeDensity(prefs?.density),
    // 这两项只做取值收窄、不参与上色：带出去是为了不让它们在中途被丢掉。
    collapseTiming: normalizeCollapseTiming(prefs?.collapseTiming),
    foldedReplies: normalizeFoldedReplies(prefs?.foldedReplies),
  }
}

/** localStorage 镜像的键；与旧渲染层同一个键（两者不同源，不会互相覆盖）。 */
const STORAGE_KEY = 'dsc.appearance'
const media = typeof window === 'undefined' ? undefined : window.matchMedia?.('(prefers-color-scheme: light)')
let systemWatcher: ((event: MediaQueryListEvent) => void) | undefined
/** 最近一次报出去的两个控件条颜色（`bar symbol`）；没变就不重复报。 */
let lastChrome: string | null = null
/** 最近一次生效的外观：系统偏好监听读它，而不是读挂载当时那份快照，
 *  否则「先选跟随系统、后改字号」会丢——切换时重画的是老字号。 */
let current: Appearance = DEFAULT_APPEARANCE

/**
 * 把一份外观设置写到 document 根元素上。
 *
 * @param appearance 要生效的外观
 */
export function applyAppearance(appearance: Appearance): void {
  current = appearance
  const root = document.documentElement
  const requested = appearance.themeMode
  // claude 是「浅色的暖米白」那一档，自己就是一个 data-theme 值——
  // 它不参与 system 的解析：跟随系统只在 dark / light 之间翻。
  const mode: 'dark' | 'light' | 'claude' = requested === 'system' ? (media?.matches ? 'light' : 'dark') : requested

  // data-theme 是 tokens.css 里浅色主题的开关；这里永远不会写出 'system'，
  // 免得样式表去猜系统偏好、和 JS 的判断各说一套。
  root.dataset.theme = mode
  root.dataset.density = appearance.density
  // 倍率是派生值：界面里那批 `calc(Npx * var(--dsc-font-scale))` 都读它。
  root.style.setProperty('--dsc-font-scale', String(fontScaleFromTextSizePx(appearance.textSizePx)))
  // 两个字体变量：空串删掉（不能写空串，见文件头与 applyFontVariable 的说明）。
  applyFontVariable(root, '--dsc-font-text', appearance.textFontFamily)
  applyFontVariable(root, '--dsc-font-code', appearance.codeFontFamily)
  // 注意这里**不再写** `--dsc-btn-scale`：按钮大小那条轴已退场（见文件头第 3 条）。
  // views.css 里那批 `calc(Npx * var(--dsc-btn-scale))` 由 styles.css 固定尺寸覆盖。

  // 两件"桌面窗口专有"的事：原生控件区的颜色、原生弹层的深浅。浏览器里桥缺席，
  // 整段是空操作——这正是阶段 95 从旧版搬过来时**故意删掉**的那两件，现在经原生桥
  // （窄接口，见 plugin-api.ts 的 getHostNative）回到壳里。
  pushNativeChrome(requested)

  // 只有跟随系统时才需要挂监听；系统翻脸就按 current 重画一次。
  if (!media) return
  if (requested === 'system' && !systemWatcher) {
    systemWatcher = () => {
      applyAppearance(current)
    }
    media.addEventListener('change', systemWatcher)
  } else if (requested !== 'system' && systemWatcher) {
    media.removeEventListener('change', systemWatcher)
    systemWatcher = undefined
  }
}

/**
 * 把一条字体列表写进 CSS 自定义属性；空串就把属性删掉。
 *
 * 为什么空串必须删而不是写 `''`：`tokens.css` 里那两条的写法是
 * `var(--dsc-font-text, 内置栈), 内置栈`。自定义属性「存在但值为空串」时，`var()` **不会**
 * 走兜底（兜底只在变量未定义时生效），展开成 `font-family: , 'Segoe WPC', …`——整条声明
 * 语法非法被浏览器丢掉，用户看到的是浏览器默认字体。删掉变量才真的是「没填 = 用内置栈」。
 *
 * @param root document 根元素
 * @param name 变量名（`--dsc-font-text` / `--dsc-font-code`）
 * @param value 已经过 `normalizeFontList` 的列表；空串表示用内置栈
 */
function applyFontVariable(root: HTMLElement, name: string, value: string): void {
  if (value === '') root.style.removeProperty(name)
  else root.style.setProperty(name, value)
}

/**
 * 把窗口底色 / 原生控件区的颜色、以及原生弹层的深浅报给桌面外壳。
 *
 * 为什么需要它：原生窗口控件区（Windows 的最小化/最大化/关闭）与原生弹层
 * （select 下拉、右键菜单）都由系统画，**样式表够不着**——只能把算出来的颜色与模式
 * 报给主进程。浏览器里桥缺席，这里是空操作（两件事都是桌面窗口专有）。
 *
 * 为什么传「请求的」主题模式而不是解析后的 dark/light：跟随系统时让主进程也跟着系统翻面。
 *
 * @param requested 用户选的主题档（dark / light / system）
 */
function pushNativeChrome(requested: ThemeMode): void {
  const native = getHostNative()
  if (!native.available) return
  void native.invoke('setThemeSource', [requested]).catch(() => undefined)
  const colors = readChromeColors()
  if (colors === null) return
  if (colors === lastChrome) return
  lastChrome = colors
  const [bar, symbol] = colors.split(' ')
  void native.invoke('setWindowChrome', [bar, symbol]).catch(() => undefined)
}

/**
 * 读 `--dsc-chrome-bar` / `--dsc-chrome-symbol` 两个令牌，压平成 `#rrggbb`。
 *
 * 为什么要绕一层（`readCssColor` 里的隐藏探针）：令牌是 `color-mix()` 算出来的，
 * `getComputedStyle` 只认元素上生效的颜色，读不了"变量本身"。
 *
 * @returns `"#rrggbb #rrggbb"`；读不出来（令牌缺失、带 alpha）给 null
 */
function readChromeColors(): string | null {
  const bar = readCssColor('--dsc-chrome-bar')
  const symbol = readCssColor('--dsc-chrome-symbol')
  return bar === null || symbol === null ? null : `${bar} ${symbol}`
}

/**
 * 读取上次落盘的外观镜像。第一次运行或存坏了就返回默认值。
 *
 * @returns 缓存的外观，或默认值
 */
export function loadCachedAppearance(): Appearance {
  const boot = bootTheme()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw !== null) {
      const cached = appearanceFromPrefs(JSON.parse(raw) as Partial<UiPrefsView>)
      // 主题以地址上那份为准：读自 settings.json，比镜像新——镜像按源隔离，
      // 宿主每次换端口就等于换一份空存储，靠它的话浅色用户每次冷启动都会先黑一下。
      return boot === null ? cached : { ...cached, themeMode: boot }
    }
  } catch (error) {
    // 镜像只是加速手段，读不出来就用下面的兜底，不该把启动卡住。
    console.warn('[ui-shell] 外观缓存读取失败，回退启动主题', error)
  }
  return boot === null ? DEFAULT_APPEARANCE : { ...DEFAULT_APPEARANCE, themeMode: boot }
}

/**
 * 地址上带过来的主题（桌面主进程从 `settings.json` 读到、拼在 query 里，见 `pageQuery`）。
 *
 * 为什么不能只靠 localStorage 镜像：镜像按**源**隔离，而宿主每次启动换一个端口，
 * 换一个源就是一份新的空存储——浅色主题的用户于是每次冷启动都先按默认深色闪一下。
 * 主进程那份不依赖存储，首帧就准。
 *
 * @returns 三档主题之一；浏览器里没有这个参数时给 null（交给默认值）
 */
function bootTheme(): ThemeMode | null {
  if (typeof window === 'undefined') return null
  const match = /[?&]theme=(dark|light|claude)/.exec(window.location.search)
  return match === null ? null : (match[1] as ThemeMode)
}

/**
 * 把外观写进 localStorage 镜像，供下次启动的首帧使用。
 *
 * @param appearance 刚从宿主读回来的外观
 */
export function saveCachedAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance))
  } catch (error) {
    // 隐私模式或配额满都会抛；下一次冷启动闪一下默认主题，不影响功能。
    console.warn('[ui-shell] 外观缓存写入失败', error)
  }
}
