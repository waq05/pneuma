/**
 * 外观偏好：主题模式、字号、密度、按钮大小四项怎么落到 DOM 上（浏览器侧）。
 *
 * 与桌面渲染层 `desktop/src/renderer/appearance.ts` 同一套语义：真源在宿主的
 * `~/.dsc/settings.json`（走 `getUiPrefs`），这里另存一份 localStorage 镜像，
 * 只为首帧不闪——宿主回读还没到，就能按上次的设置上色。
 *
 * 从旧版搬过来时**故意删掉**两件事（不是漏了）：
 *   1. `pushWindowChrome`：那是在跟 Electron 主进程报原生窗口控件区的颜色，
 *      浏览器里没有这个口子，桌面窗口切到本壳时由主进程自己那一侧解决；
 *   2. `dsc.setThemeSource`：原生弹出层（select 下拉、右键菜单）的深浅由主进程定，
 *      同理归桌面侧。所以这里只负责页面内的那一半。
 *
 * @module dsc-ui-shell/appearance
 */
import type { ThemeMode, UiDensity, UiFontSize, UiPrefsView } from '@dsc/ui'

export type { ThemeMode, UiDensity, UiFontSize }

/** 字号倍率的可调范围；与 `src/core/prefs.ts` 读档时的夹取范围一致，改这里要两边一起改。 */
export const FONT_SCALE_MIN = 0.85
export const FONT_SCALE_MAX = 1.35
/** 基准倍率：正文 13px 原样。 */
export const FONT_SCALE_DEFAULT = 1

/** 按钮缩放倍率的可调范围；口径同上。 */
export const BUTTON_SCALE_MIN = 0.9
export const BUTTON_SCALE_MAX = 1.5
/** 基准倍率：图标按钮静息 26px 原样。 */
export const BUTTON_SCALE_DEFAULT = 1

/** 旧存档里的三档字号（0.6 之前存的是字符串），迁移成倍率。 */
const LEGACY_FONT_SCALES: Record<string, number> = { sm: 0.92, md: 1, lg: 1.12 }

/** 一项外观设置。 */
export interface Appearance {
  themeMode: ThemeMode
  fontSize: UiFontSize
  density: UiDensity
  buttonScale: number
}

/** 出厂默认：深色、标准字号、标准密度、按钮原样。真源是 `core/prefs.ts` 的 readPrefs 默认值。 */
export const DEFAULT_APPEARANCE: Appearance = {
  themeMode: 'dark',
  fontSize: FONT_SCALE_DEFAULT,
  density: 'standard',
  buttonScale: BUTTON_SCALE_DEFAULT,
}

/**
 * 把外部来的字号值归一成能用的倍率。
 *
 * 数字夹到 0.85–1.35 并保留两位小数；旧的 'sm'/'md'/'lg' 按 0.92/1/1.12 迁移；
 * 其余（认不出的字符串、NaN、null）回落 1。宿主回读、localStorage 镜像都先过这里，
 * 所以旧存档最多是字号不对，不会把界面带崩。
 *
 * @param value 任意来源的字号值（数字或旧版三档字符串）
 * @returns 可以直接写进 `--dsc-font-scale` 的倍率
 */
export function normalizeFontScale(value: unknown): number {
  const legacy = typeof value === 'string' ? LEGACY_FONT_SCALES[value] : undefined
  const scale = legacy ?? (typeof value === 'number' && Number.isFinite(value) ? value : FONT_SCALE_DEFAULT)
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(scale * 100) / 100))
}

/**
 * 把外部来的按钮缩放值归一成能用的倍率。
 *
 * @param value 任意来源的按钮缩放值
 * @returns 可以直接写进 `--dsc-btn-scale` 的倍率
 */
export function normalizeButtonScale(value: unknown): number {
  const scale = typeof value === 'number' && Number.isFinite(value) ? value : BUTTON_SCALE_DEFAULT
  return Math.min(BUTTON_SCALE_MAX, Math.max(BUTTON_SCALE_MIN, Math.round(scale * 100) / 100))
}

/** 密度只有三档；认不出的值回落 standard。 */
function normalizeDensity(value: unknown): UiDensity {
  return value === 'compact' || value === 'roomy' ? value : 'standard'
}

/** 主题只有三档；认不出的值回落 dark。 */
function normalizeTheme(value: unknown): ThemeMode {
  return value === 'light' || value === 'system' ? value : 'dark'
}

/**
 * 把宿主 `getUiPrefs` 的返回值（或 localStorage 镜像）归一成渲染层能直接用的外观。
 *
 * @param prefs 宿主原样返回的界面偏好，或解析出来的镜像
 */
export function appearanceFromPrefs(prefs: Partial<UiPrefsView> | null | undefined): Appearance {
  return {
    themeMode: normalizeTheme(prefs?.themeMode),
    fontSize: normalizeFontScale(prefs?.fontSize),
    density: normalizeDensity(prefs?.density),
    buttonScale: normalizeButtonScale(prefs?.buttonScale),
  }
}

/** localStorage 镜像的键；与旧渲染层同一个键（两者不同源，不会互相覆盖）。 */
const STORAGE_KEY = 'dsc.appearance'
const media = typeof window === 'undefined' ? undefined : window.matchMedia?.('(prefers-color-scheme: light)')
let systemWatcher: ((event: MediaQueryListEvent) => void) | undefined
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
  const mode: 'dark' | 'light' = requested === 'system' ? (media?.matches ? 'light' : 'dark') : requested

  // data-theme 是 tokens.css 里浅色主题的开关；这里永远不会写出 'system'，
  // 免得样式表去猜系统偏好、和 JS 的判断各说一套。
  root.dataset.theme = mode
  root.dataset.density = appearance.density
  root.style.setProperty('--dsc-font-scale', String(normalizeFontScale(appearance.fontSize)))
  root.style.setProperty('--dsc-btn-scale', String(normalizeButtonScale(appearance.buttonScale)))

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
 * 读取上次落盘的外观镜像。第一次运行或存坏了就返回默认值。
 *
 * @returns 缓存的外观，或默认值
 */
export function loadCachedAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_APPEARANCE
    return appearanceFromPrefs(JSON.parse(raw) as Partial<UiPrefsView>)
  } catch (error) {
    // 镜像只是加速手段，读不出来直接用默认值，不该把启动卡住。
    console.warn('[ui-shell] 外观缓存读取失败，回退默认外观', error)
    return DEFAULT_APPEARANCE
  }
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
