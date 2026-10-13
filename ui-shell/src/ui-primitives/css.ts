/**
 * 读一个 CSS 变量算出来的颜色 / 原始值。
 *
 * 有些地方拿不到"令牌名"，只能拿到**算完的颜色**：xterm 的配色、桌面原生窗口控件区的
 * 两个色（要报给主进程，系统那侧只收 `#rrggbb`）。读法统一成这一处，免得每个调用点
 * 各写一份"挂个隐藏探针读 getComputedStyle 再解析"。
 *
 * 为什么住基元包（E4 收尾）：与 `native.ts` 同一条理由——它是平台层的东西，
 * 原来在 `@dsc/ui`（`plugin-api.ts`）里实现，而 `ui-layout` 的 appearance 也要用，
 * 于是包间成环。下沉之后 `@dsc/ui` 只把它转出。
 *
 * @module dsc-ui-shell/ui-primitives/css
 */

/** 隐藏探针（零尺寸、不可见、不参与布局）；挂在 <html> 上，懒建一次。 */
let colorProbe: HTMLDivElement | undefined

/**
 * 读一个 CSS 变量在当前主题下算出来的颜色。
 *
 * @param token 变量名（含 `--`），例如 `--dsc-chrome-bar`
 * @returns `#rrggbb`；变量不存在、算出来带 alpha、或不是 sRGB 时给 null
 */
export function readCssColor(token: string): string | null {
  if (typeof document === 'undefined') return null
  if (colorProbe === undefined) {
    colorProbe = document.createElement('div')
    colorProbe.style.cssText =
      'position:absolute;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none'
    document.documentElement.append(colorProbe)
  }
  colorProbe.style.backgroundColor = `var(${token})`
  return toHexColor(getComputedStyle(colorProbe).backgroundColor)
}

/**
 * 读一个 CSS 变量的原始文本值（要像素数、字号这类不进颜色的场合用）。
 * @param token 变量名（含 `--`）
 * @param fallback 读不出来时的回落值
 */
export function readCssValue(token: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  return value === '' ? fallback : value
}

/**
 * 把浏览器算出来的颜色转成 `#rrggbb`。
 *
 * 同一个 `color-mix()` 令牌在不同内核版本里可能被写成 `rgb(13, 13, 15)` 或
 * `color(srgb 0.051 0.051 0.059)`，两种都要认。
 *
 * @param color getComputedStyle 读到的 background-color
 * @returns 不透明颜色的十六进制写法；带 alpha 或不是 sRGB 时给 null
 */
export function toHexColor(color: string): string | null {
  const parts = /^(rgb|color)\((.+)\)$/i.exec(color.trim())
  if (!parts) return null
  const srgb = parts[1].toLowerCase() === 'color'
  const body = srgb ? parts[2].replace(/^\s*srgb\s+/i, '') : parts[2]
  const nums = body.split(/[,/\s]+/).filter((piece) => piece !== '').map(Number)
  if (nums.length < 3 || nums.slice(0, 4).some((n) => !Number.isFinite(n))) return null
  if (nums.length > 3 && nums[3] < 0.999) return null
  const scale = srgb ? 255 : 1
  const hex = (n: number): string =>
    Math.min(255, Math.max(0, Math.round(n * scale)))
      .toString(16)
      .padStart(2, '0')
  return `#${hex(nums[0])}${hex(nums[1])}${hex(nums[2])}`
}
