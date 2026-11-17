/**
 * 字体与字号：两个用户可配的字体列表（正文 / 代码）和「正文多少 px」的唯一口径。
 *
 * 为什么放在契约层而不是各端各写一份：这几个值要走三条路——宿主读档（`core/prefs.ts`，
 * Node 侧）、壳落地（`ui-runtime/ui/appearance.ts`，浏览器侧）、设置页画控件
 * （`ui-settings/ui/ui.tsx`，插件 bundle 侧）。以前字号倍率在这三处各有一份夹取逻辑，
 * 靠注释「改这里要两边一起改」维持，2026-11 加字体列表时再抄一份就是第四份了。
 * 这里只放**纯函数**（无 import、无状态），三处都调同一份实现。
 *
 * 边界：本文件与 `src/contract/**` 自身不得 import 任何 `@deepseek-ai/*`，
 * 也不得读写 DOM / 文件系统——它只做字符串与数字的归一。
 *
 * @module dsc/contract/fonts
 */

/**
 * 正文基准像素：`--dsc-font-scale` 就是「正文 px ÷ 这个数」。
 *
 * 为什么是 14 而不是 13：2026-11 的外观档把正文从 13/18 抬到 14/20（`styles.css:3806`），
 * `tokens.css` 的 `calc(13px * scale)` 已被覆盖。基准跟着实际值走，否则「100%」和
 * 「14px」在界面上对不上。
 */
export const FONT_BASE_PX = 14

/** 正文字号下限（px）。再小中文的横画只剩半像素，读不动。 */
export const FONT_SIZE_PX_MIN = 10

/** 正文字号上限（px）。与 dsh 的正文档一致（10–22）。 */
export const FONT_SIZE_PX_MAX = 22

/** 读不出字号时的默认值（px）：正文 14px，与当前观感一致。 */
export const FONT_SIZE_PX_DEFAULT = FONT_BASE_PX

/**
 * 0.6 之前 `ui.fontSize` 存的三档字符串，读档时按这张表换算成倍率。
 *
 * 只在这里留一份：`core/prefs.ts` 的读档迁移与 `ui-runtime` 的镜像兜底都从这取。
 */
export const LEGACY_FONT_SCALES: Readonly<Record<string, number>> = { sm: 0.92, md: 1, lg: 1.12 }

/** 旧倍率的下限（与历史存档一致；迁移时夹取用，新值不再写倍率）。 */
export const LEGACY_FONT_SCALE_MIN = 0.85

/** 旧倍率的上限（同上）。 */
export const LEGACY_FONT_SCALE_MAX = 1.35

/** 一条字体列表允许的总字符数。超过就整条丢弃：半截列表比默认栈更难读。 */
export const FONT_LIST_MAX_CHARS = 200

/** 一条字体列表最多认几个族。多出来的忽略（正常用户不会写九个）。 */
export const FONT_LIST_MAX_FAMILIES = 8

/** 单个字体名的长度上限。超长的一律视为坏值，整条列表回落默认。 */
export const FONT_FAMILY_MAX_CHARS = 64

/**
 * 从字体名里剔掉的字符：控制字符、分号、花括号。
 *
 * 为什么要剔：这串值最终进的是 `document.documentElement.style.setProperty('font-family', …)`。
 * 自定义属性的值不会创建新声明（`;` 在值里不构成语句边界），但一个带着 `{`/`}` 的
 * 值会让整条声明被解析器丢弃，用户只会看到「字体没生效」而没有任何提示。
 * 与其让样式静默失效，不如在入口就把这些字符删掉。
 */
const FORBIDDEN_IN_FAMILY = /[\u0000-\u001f\u007f;{}]/g

/** 名字里有空格就必须加引号，否则 CSS 会把它当成两个族（`Noto Sans SC` → Noto + Sans + SC）。 */
const NEEDS_QUOTES = /\s/

/**
 * 把一条用户输入的字体列表归一成可直接进 CSS 的字符串。
 *
 * 规则（顺序即是实现顺序）：
 *   1. 非字符串 / 空串 → `''`（调用方据此删掉 CSS 变量，回落到内置栈）；
 *   2. 整串超过 {@link FONT_LIST_MAX_CHARS} → `''`（丢弃半截列表，不截断）；
 *   3. 按逗号切段；每段剔控制字符与 `;{}`、剥掉所有引号、trim；
 *   4. 单个名字超过 {@link FONT_FAMILY_MAX_CHARS} → `''`（同上，宁可用默认栈）；
 *   5. 不区分大小写去重，最多 {@link FONT_LIST_MAX_FAMILIES} 段；
 *   6. 含空格的加双引号，其余原样；用 `, ` 拼回。
 *
 * 为什么不支持「引号里含逗号」：字体名里出现逗号的情况不存在（系统字体名允许的字符
 * 本来就不含它），为它写一个状态机会让这段逻辑从 20 行涨到 60 行，收益为零。
 *
 * @param value 设置页输入、settings.json 里的原值，或宿主回读的值
 * @returns 归一后的 CSS 字体列表；`''` 表示使用内置栈
 */
export function normalizeFontList(value: unknown): string {
  if (typeof value !== 'string') return ''
  const raw = value.trim()
  if (raw === '') return ''
  if (raw.length > FONT_LIST_MAX_CHARS) return ''

  const families: string[] = []
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    // 引号只是分隔符，不进名字：先全剥掉，需要时下面按「有空格」重新加。
    const name = part.replace(FORBIDDEN_IN_FAMILY, '').replace(/["']/g, '').trim()
    if (name === '') continue
    if (name.length > FONT_FAMILY_MAX_CHARS) return ''
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    families.push(name)
    if (families.length >= FONT_LIST_MAX_FAMILIES) break
  }

  if (families.length === 0) return ''
  return families.map((name) => (NEEDS_QUOTES.test(name) ? `"${name}"` : name)).join(', ')
}

/**
 * 把正文字号（px）夹进可选范围并取整。
 *
 * 坏值（字符串、NaN、null、越界）一律回落 {@link FONT_SIZE_PX_DEFAULT}，绝不让存档
 * 把界面搞成 0px 或者 300px。
 *
 * @param value settings.json 里的 `textSizePx`，或设置页传来的数
 * @returns 10–22 之间的整数 px
 */
export function normalizeTextSizePx(value: unknown): number {
  const px = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : FONT_SIZE_PX_DEFAULT
  return Math.min(FONT_SIZE_PX_MAX, Math.max(FONT_SIZE_PX_MIN, px))
}

/**
 * 读旧存档里的字号倍率。
 *
 * 只给迁移用：新值一律以 px 存，倍率不再写回。认不出的值（`"大"`、NaN、null、
 * 超出 0.85–1.35 的数）返回 `null`，由调用方决定回落默认。
 *
 * @param value 旧 `ui.fontSize` 的原始值（数字倍率或 `'sm' | 'md' | 'lg'`）
 * @returns 0.85–1.35 之间的倍率，或 null
 */
export function legacyFontScale(value: unknown): number | null {
  if (typeof value === 'string') {
    const scale = LEGACY_FONT_SCALES[value]
    return scale === undefined ? null : scale
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(LEGACY_FONT_SCALE_MAX, Math.max(LEGACY_FONT_SCALE_MIN, value))
  }
  return null
}

/**
 * 旧倍率 → 正文字号 px（迁移入口）。
 *
 * 例：旧档 `1.12` → 16px；旧档 `'lg'` → 16px；认不出 → `null`（调用方用默认 14）。
 *
 * @param value 旧 `ui.fontSize` 的原始值
 * @returns 10–22 之间的整数 px，或 null
 */
export function textSizePxFromLegacy(value: unknown): number | null {
  const scale = legacyFontScale(value)
  return scale === null ? null : normalizeTextSizePx(scale * FONT_BASE_PX)
}

/**
 * 正文字号 px → `--dsc-font-scale`（界面里那批 `calc(Npx * scale)` 都读它）。
 *
 * 保留 4 位小数：12/14 = 0.857142…，留 2 位会让 12px 实际画出 11.96px，
 * 在 12–22 这个区间里是肉眼可辨的偏小。
 *
 * @param px 正文字号（会被夹进 10–22）
 * @returns 直接写进 `--dsc-font-scale` 的倍率
 */
export function fontScaleFromTextSizePx(px: number): number {
  return Math.round((normalizeTextSizePx(px) / FONT_BASE_PX) * 1e4) / 1e4
}
