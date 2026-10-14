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

/** 建探针（只建一次）：后面每次读只是换个 backgroundColor 再读回来。 */
function ensureProbe(): HTMLDivElement {
  if (colorProbe === undefined) {
    colorProbe = document.createElement('div')
    colorProbe.style.cssText =
      'position:absolute;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none'
    document.documentElement.append(colorProbe)
  }
  return colorProbe
}

/**
 * 读一个 CSS 变量在当前主题下算出来的颜色。
 *
 * @param token 变量名（含 `--`），例如 `--dsc-chrome-bar`
 * @returns `#rrggbb`；变量不存在、算出来带 alpha、或不是 sRGB 时给 null
 */
export function readCssColor(token: string): string | null {
  if (typeof document === 'undefined') return null
  return toHexColor(probeTokenColor(token))
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

/** 颜色分量（0–255 的 r/g/b + 0–1 的 alpha）。 */
interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/**
 * 把 getComputedStyle 算出来的颜色串解析成分量（**保留 alpha**）。
 *
 * 同一个 `color-mix()` 令牌在不同内核版本里可能被写成 `rgb(13, 13, 15)` 或
 * `color(srgb 0.051 0.051 0.059 / 0.94)`，两种都要认。
 *
 * @param color getComputedStyle 读到的颜色
 * @returns 四个分量；写法不认识时 null
 */
function parseRgba(color: string): Rgba | null {
  const parts = /^(rgb|color)\((.+)\)$/i.exec(color.trim())
  if (!parts) return null
  const srgb = parts[1].toLowerCase() === 'color'
  const body = srgb ? parts[2].replace(/^\s*srgb\s+/i, '') : parts[2]
  const nums = body.split(/[,/\s]+/).filter((piece) => piece !== '').map(Number)
  if (nums.length < 3 || nums.slice(0, 4).some((n) => !Number.isFinite(n))) return null
  // color(srgb …) 的分量是 0~1 的浮点数，rgb() 的是 0~255
  const scale = srgb ? 255 : 1
  const channel = (n: number): number => Math.min(255, Math.max(0, n * scale))
  return {
    r: channel(nums[0]),
    g: channel(nums[1]),
    b: channel(nums[2]),
    a: nums.length > 3 ? Math.min(1, Math.max(0, nums[3])) : 1,
  }
}

/** 分量 → `#rrggbb`（alpha 一律当 1）。 */
function hexOf(color: Rgba): string {
  const part = (value: number): string =>
    Math.round(value).toString(16).padStart(2, '0')
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`
}

/** 半透明前景压到背景上，算出不透明的实际颜色。 */
function over(front: Rgba, back: Rgba): Rgba {
  const mix = (a: number, b: number): number => a * front.a + b * (1 - front.a)
  return { r: mix(front.r, back.r), g: mix(front.g, back.g), b: mix(front.b, back.b), a: 1 }
}

/**
 * 把浏览器算出来的颜色转成 `#rrggbb`。
 *
 * @param color getComputedStyle 读到的颜色
 * @returns 不透明颜色的十六进制写法；带 alpha 或不是 sRGB 时给 null
 */
export function toHexColor(color: string): string | null {
  const rgba = parseRgba(color)
  if (rgba === null || rgba.a < 0.999) return null
  return hexOf(rgba)
}

/** 取一个令牌在当前主题下算成的颜色串（探针只设 backgroundColor，读完即取）。 */
function probeTokenColor(token: string): string {
  const probe = ensureProbe()
  probe.style.backgroundColor = `var(${token})`
  return getComputedStyle(probe).backgroundColor
}

/**
 * 读一个**可能带 alpha** 的令牌，压在另一条令牌给出的底色上，得到不透明的 `#rrggbb`。
 *
 * 为什么要多这一步：`--dsc-text-primary` 是 `color-mix(in srgb, var(--dsc-base) 94%, transparent)`，
 * 带 4% 透明——它是正文该有的颜色，但二维码这类只吃纯色值的消费者拿它画不出东西。
 * 压在卡片底色上合成一次就够：深色主题得到近白块、浅色主题得到近黑块，不必为二维码
 * 各配一张图。底色读不出来时直接用前景色（比退回纯黑强），前景也读不出来才用 fallback。
 *
 * @param token 前景令牌（含 `--`），可以带 alpha
 * @param baseToken 底色令牌（含 `--`），码块会长在它上面
 * @param fallback 两步都读不出来时的回落色（`#rrggbb`）
 * @returns 不透明的 `#rrggbb`
 */
export function readCssSolidColor(token: string, baseToken: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const front = parseRgba(probeTokenColor(token))
  if (front === null) return fallback
  if (front.a >= 0.999) return hexOf(front)
  const back = parseRgba(probeTokenColor(baseToken))
  return hexOf(back === null ? front : over(front, back))
}
