/**
 * 生成 `ui-shell/src/legacy-color-fallback.css`：给**认不得 `color-mix()` 的内核**的整套调色板兜底。
 *
 * 为什么需要它：令牌体系（`src/legacy/tokens.css`）几乎全部由 `color-mix()` 算出——页面/侧栏/卡片底色、
 * 五级填充、四级描边、四级文字色、悬停底色、阴影。`color-mix()` 是 Chromium 111（2023-03）才有的函数，
 * 比它旧的内核**在解析期就把这些声明整条丢掉**，于是每个令牌都成了「未定义」：
 *
 *   - `background: var(--dsc-bg-side)` → 无效值 → 计算值退回 `transparent`
 *     → **侧栏/停靠区/浮层的底色整块消失**，看着就是「透明的，和会话叠在一起」；
 *   - `color: var(--dsc-text-secondary)` → 同样无效 → 继承 `body` 那一层
 *     → 标题、正文、次要说明**全是一个白度**，层级感没了。
 *
 * 这不是猜的：手机浏览器那一侧留下的证据是「`AbortSignal.timeout is not a function`」（Chromium 103 才有），
 * 而 `color-mix()` 要 111——同一个内核，同一个原因（见 `docs/development-log.md` 本批的记录）。
 *
 * 做法：**不手抄色板**，而是把 tokens.css 自己那套公式算一遍。
 *   1. 按层叠顺序重放 `:root` / `:root[data-theme='light']` 上的自定义属性（后写的赢）；
 *   2. 递归求值：`var()` 取重放结果，`color-mix()` 按 CSS 规范算（**预乘 alpha**，与浏览器同算法）；
 *   3. 只输出**真正依赖 color-mix 的那些**令牌，包在 `@supports not (color: color-mix(...))` 里
 *      ——支持 color-mix 的内核整块不生效，主题色永远以 tokens.css 为唯一真源，这里不会漂。
 *
 * 一处刻意的近似：`--dsc-stroke-float` 用的是 `currentColor`（跟着元素自己的文字色走），
 * 在 `:root` 上无法求值，用当前的 `--dsc-text-primary` 顶上（3% 的发丝线，肉眼等价）。
 *
 * 用法：node ui-shell/scripts/build-color-fallback.mjs
 * 产物已入库（与 `desktop/scripts/build-icon-map.mjs` 同一套约定）；改了 tokens.css 后重跑一次，
 * 漂移由 `scripts/ui-color-fallback-test.mjs` 逐字节比对把关。
 *
 * @module dsc-ui-shell/build-color-fallback
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const shellRoot = join(here, '..')
export const TOKENS_PATH = join(shellRoot, 'src', 'legacy', 'tokens.css')
export const OUT_PATH = join(shellRoot, 'src', 'legacy-color-fallback.css')

/* ── 一、把 tokens.css 拆成规则（认得 @media 嵌套，别的 at-rule 不需要） ────────────── */

/** 去掉注释。令牌文件里的注释很多，留着会把括号配平搞乱。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 从 `open` 处的 `{` 找到配对的 `}` 的下标（块里还有嵌套块，不能取第一个 `}`）。 */
function matchBrace(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 递归拆规则：`{ selector, decls, media }`。`media` 为 null 表示不在任何媒体查询里。
 * @param {string} css - 已去注释的 CSS 文本
 * @param {string|null} media - 外层媒体条件
 * @returns {Array<{selector: string, decls: Map<string,string>, media: string|null}>}
 */
export function parseRules(css, media = null) {
  const rules = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open === -1) break
    const prelude = css.slice(i, open).trim()
    const close = matchBrace(css, open)
    if (close === -1) break
    const body = css.slice(open + 1, close)
    if (prelude.startsWith('@media')) {
      rules.push(...parseRules(body, prelude))
    } else if (prelude.startsWith('@')) {
      // 其它 at-rule（@supports / @keyframes）与令牌无关，跳过整块
    } else if (prelude !== '') {
      const decls = new Map()
      for (const raw of body.split(';')) {
        const colon = raw.indexOf(':')
        if (colon === -1) continue
        const name = raw.slice(0, colon).trim()
        if (!name.startsWith('--')) continue
        decls.set(name, raw.slice(colon + 1).trim())
      }
      if (decls.size > 0) rules.push({ selector: prelude, decls, media })
    }
    i = close + 1
  }
  return rules
}

/* ── 二、按层叠重放出一套主题下的令牌表 ──────────────────────────────────────────── */

/**
 * `:root` 选择器在当前主题状态下命中吗？
 *
 * 只认令牌文件里真实出现过的形态（`:root`、`:root[data-theme='light']`、`:root[data-density='…']`），
 * 不做通用选择器引擎——多一个选择器形态就该在这里显式加一条，而不是悄悄漏掉。
 */
export function rootMatches(selector, attrs) {
  return selector.split(',').some((part) => {
    const trimmed = part.trim()
    if (!trimmed.startsWith(':root')) return false
    const conditions = [...trimmed.matchAll(/\[([a-z-]+)=['"]([^'"]+)['"]\]/g)]
    return conditions.every(([, name, value]) => attrs[name] === value)
  })
}

/**
 * 重放一套主题：返回 `Map<令牌名, 原始值文本>`。
 * @param {Array} rules - parseRules 的结果
 * @param {Record<string,string>} attrs - 假想的 `:root` 属性（`data-theme` / `data-density`）
 * @param {boolean} systemLight - 假想「系统是浅色」（只影响 `@media (prefers-color-scheme: light)` 那一段）
 */
export function collectTokens(rules, attrs, systemLight) {
  const out = new Map()
  for (const rule of rules) {
    if (rule.media !== null) {
      // 令牌文件里只有 `(prefers-color-scheme: light)` 这一种媒体条件
      const wantsLight = /prefers-color-scheme:\s*light/.test(rule.media)
      if (wantsLight !== systemLight) continue
    }
    if (!rootMatches(rule.selector, attrs)) continue
    for (const [name, value] of rule.decls) out.set(name, value)
  }
  return out
}

/* ── 三、求值：颜色字面量 + 预乘混合（与 CSS 规范同算法） ─────────────────────────── */

/** 认得的颜色写法：`#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` / `transparent`。 */
export function parseColor(text) {
  const value = text.trim()
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)
  if (hex !== null) {
    const digits = hex[1]
    const short = digits.length === 3 || digits.length === 4
    const parts = short ? [...digits].map((c) => c + c) : (digits.match(/../g) ?? [])
    if (parts.length < 3) return null
    const [r, g, b] = parts.slice(0, 3).map((p) => Number.parseInt(p, 16))
    const a = parts.length >= 4 ? Number.parseInt(parts[3], 16) / 255 : 1
    return { r, g, b, a }
  }
  const fn = /^rgba?\(([^)]*)\)$/i.exec(value)
  if (fn !== null) {
    const nums = fn[1].split(/[\s,/]+/).filter((x) => x !== '')
    if (nums.length < 3) return null
    const [r, g, b] = nums.slice(0, 3).map((n) => Math.round(Number.parseFloat(n)))
    const a = nums.length >= 4 ? Number.parseFloat(nums[3]) : 1
    return { r, g, b, a: Number.isFinite(a) ? a : 1 }
  }
  return null
}

export function formatColor(color) {
  if (color.a <= 0) return 'transparent'
  const a = Math.round(color.a * 1000) / 1000
  if (a >= 1) return `rgb(${color.r} ${color.g} ${color.b})`
  return `rgb(${color.r} ${color.g} ${color.b} / ${a})`
}

/**
 * CSS 规范的 `color-mix(in srgb, …)`：**预乘 alpha** 之后再插值。
 *
 * 为什么不能按通道直接加权：与 `transparent`（rgba(0,0,0,0)）混合时，非预乘的算法会把
 * 「96% 的深灰 + 4% 透明」算成「96% 深灰 + 4% 黑」——整体压暗一档，浮层底色会明显偏黑。
 * 预乘之后「与透明混合」就是纯粹的透明度衰减，和浏览器算出来的一致。
 */
export function mixColors(first, p1, second, p2) {
  let w1 = p1
  let w2 = p2
  if (w1 === null && w2 === null) {
    w1 = 50
    w2 = 50
  } else if (w1 === null) {
    w1 = 100 - w2
  } else if (w2 === null) {
    w2 = 100 - w1
  }
  const sum = w1 + w2
  if (sum <= 0) return { r: 0, g: 0, b: 0, a: 0 }
  const n1 = w1 / sum
  const n2 = w2 / sum
  const a = n1 * first.a + n2 * second.a
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 }
  const channel = (x, y) => Math.round((n1 * first.a * x + n2 * second.a * y) / a)
  return { r: channel(first.r, second.r), g: channel(first.g, second.g), b: channel(first.b, second.b), a }
}

/** 按顶层逗号切分（`color-mix()` 的参数里还嵌着 `color-mix()`）。 */
export function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** 找 `text` 里从 `open`（指向 `(`）起配对的 `)` 下标。 */
function matchParen(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 求值一段值文本：把 `color-mix()` 与 `var()` 都换成实色，其余原样保留
 * （阴影那种「长度 + 颜色」的简写因此也能整体过一遍）。
 *
 * @param {string} text - 原始值
 * @param {{resolveVar: (name: string) => string|null, rawTokens: Map<string,string>}} ctx
 *   取值上下文：`resolveVar` 取一个令牌的**实色值**（递归、带环检测），`rawTokens` 是原始文本表
 *   （百分比写成 `var(--dsc-mix-x)` 时要回原文看它是不是百分数）
 * @returns {string|null} 求不出来给 null（保持原样输出，宁可少兜一个也不写错）
 */
export function evaluate(text, ctx) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    const candidates = [rest.indexOf('color-mix('), rest.indexOf('var(')].filter((x) => x !== -1)
    if (candidates.length === 0) {
      out += rest
      break
    }
    const next = Math.min(...candidates)
    out += rest.slice(0, next)
    const isMix = rest.startsWith('color-mix(', next)
    const openAt = i + next + (isMix ? 'color-mix'.length : 'var'.length)
    const end = matchParen(text, openAt)
    if (end === -1) return null
    const inner = text.slice(openAt + 1, end)
    if (isMix) {
      const color = evalMix(inner, ctx)
      if (color === null) return null
      out += formatColor(color)
    } else {
      const value = ctx.resolveVar(inner.trim())
      if (value === null) return null
      out += value
    }
    i = end + 1
  }
  return out
}

/** 把 `「颜色 [百分比]」` 拆开：百分比可能写成字面量，也可能是解析成百分比的 `var()`。 */
function splitColorAndPct(side, rawTokens) {
  const trimmed = side.trim()
  // 从尾部找一个顶层空格：它右边就是候选百分比
  let depth = 0
  let splitAt = -1
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    const ch = trimmed[i]
    if (ch === ')') depth += 1
    else if (ch === '(') depth -= 1
    else if (/\s/.test(ch) && depth === 0) {
      splitAt = i
      break
    }
  }
  const asPct = (text) => {
    const t = text.trim()
    if (t.endsWith('%')) return Number.parseFloat(t)
    const varRef = /^var\((--[a-z0-9-]+)\)$/.exec(t)
    if (varRef === null) return null
    const raw = rawTokens.get(varRef[1])
    return raw !== undefined && raw.trim().endsWith('%') ? Number.parseFloat(raw) : null
  }
  if (splitAt !== -1) {
    const pct = asPct(trimmed.slice(splitAt + 1))
    if (pct !== null) return { colorText: trimmed.slice(0, splitAt).trim(), pct }
  }
  return { colorText: trimmed, pct: null }
}

/** 求值一个 `color-mix()` 的内层参数（`in srgb, A, B`）；A/B 本身也可以是嵌套的 color-mix。 */
export function evalMix(inner, ctx) {
  const parts = splitTopLevel(inner).map((p) => p.trim())
  if (parts.length !== 3) return null
  if (!/^in\s+srgb$/i.test(parts[0])) return null
  const sides = []
  for (const side of [parts[1], parts[2]]) {
    const { colorText, pct } = splitColorAndPct(side, ctx.rawTokens)
    const resolvedText = evaluate(colorText, ctx)
    if (resolvedText === null) return null
    const color = parseColor(resolvedText)
    if (color === null) return null
    sides.push({ color, pct })
  }
  return mixColors(sides[0].color, sides[0].pct, sides[1].color, sides[1].pct)
}

/* ── 四、挑出「依赖 color-mix 的令牌」并逐个求值 ─────────────────────────────────── */

/** 值里出现 `color-mix(` 的令牌，以及**引用**了这类令牌的那些（`--dsc-chrome-bar` 就是）。 */
export function pickDependent(tokens) {
  const dependent = new Set()
  for (const [name, value] of tokens) if (value.includes('color-mix(')) dependent.add(name)
  for (let round = 0; round < 8; round += 1) {
    let grew = false
    for (const [name, value] of tokens) {
      if (dependent.has(name)) continue
      for (const ref of value.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
        if (dependent.has(ref[1])) {
          dependent.add(name)
          grew = true
          break
        }
      }
    }
    if (!grew) break
  }
  return dependent
}

/**
 * 造一个求值器：`resolveVar(name)` 给出某个令牌的实色值。
 *
 * 环检测用「正在求的那些」集合（不是调用栈参数）：`evaluate` 回调进来时只带名字，
 * 环要在这里断，否则 A→B→A 会一路递归到爆栈。
 */
export function makeResolver(tokens) {
  const cache = new Map()
  const inProgress = new Set()
  const ctx = { rawTokens: tokens, resolveVar: null }
  const resolveVar = (name) => {
    if (cache.has(name)) return cache.get(name)
    if (inProgress.has(name)) return null
    const raw = tokens.get(name)
    if (raw === undefined) return null
    inProgress.add(name)
    let value = raw
    if (value.includes('currentColor')) {
      const fallback = resolveVar('--dsc-text-primary')
      if (fallback === null) {
        inProgress.delete(name)
        return null
      }
      value = value.split('currentColor').join(fallback)
    }
    const resolved = evaluate(value, ctx)
    inProgress.delete(name)
    if (resolved === null) return null
    cache.set(name, resolved)
    return resolved
  }
  ctx.resolveVar = resolveVar
  return resolveVar
}

/** 一套主题的兜底声明（`--名字: 值;` 列表，按名字排序）。 */
export function fallbackDecls(tokens) {
  const dependent = pickDependent(tokens)
  const resolveVar = makeResolver(tokens)
  const lines = []
  for (const name of [...tokens.keys()]) {
    if (!dependent.has(name)) continue
    const value = resolveVar(name)
    if (value === null || value.includes('var(') || value.includes('color-mix(')) continue
    lines.push(`${name}: ${value};`)
  }
  return lines.sort()
}

/* ── 五、拼产物 ────────────────────────────────────────────────────────────────── */

/** 深色/浅色两套主题要重放的状态。 */
const THEMES = [
  { attrs: { 'data-theme': 'dark', 'data-density': 'standard' }, systemLight: false },
  { attrs: { 'data-theme': 'light', 'data-density': 'standard' }, systemLight: false },
]

/**
 * 生成整份兜底 CSS。
 * @param {string} tokensCss - tokens.css 的原文
 * @returns {{ css: string, counts: number[] }}
 */
export function buildFallbackCss(tokensCss) {
  const rules = parseRules(stripComments(tokensCss))
  const themes = THEMES.map((state) => collectTokens(rules, state.attrs, state.systemLight))
  const header = `/*
 * 老内核的调色板兜底（**生成物，别手改**）。
 *
 * 由 \`ui-shell/scripts/build-color-fallback.mjs\` 从 \`src/legacy/tokens.css\` 算出：
 * 把里面每个 \`color-mix()\` 令牌按 CSS 规范（预乘 alpha）求成实色，包在
 * \`@supports not (color: color-mix(...))\` 里。认不得 \`color-mix()\` 的内核
 * （Chromium < 111，手机上的老 WebView 常见）靠这一块拿到整套底色/文字色/描边；
 * 认得的内核**整块不生效**，主题永远以 tokens.css 为唯一真源。
 *
 * 改了 tokens.css 就重跑一次：node ui-shell/scripts/build-color-fallback.mjs
 * 漂移由 \`scripts/ui-color-fallback-test.mjs\` 逐字节比对把关。
 */
`
  const indent = (lines) => lines.map((line) => `    ${line}`)
  const body = [
    '@supports not (color: color-mix(in srgb, red, blue)) {',
    '  :root {',
    ...indent(fallbackDecls(themes[0])),
    '  }',
    '',
    "  :root[data-theme='light'] {",
    ...indent(fallbackDecls(themes[1])),
    '  }',
    '}',
    '',
  ].join('\n')
  return { css: `${header}\n${body}`, counts: themes.map((t) => fallbackDecls(t).length) }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const { css, counts } = buildFallbackCss(readFileSync(TOKENS_PATH, 'utf8'))
  // 入库的文件跟仓库其它文本一样是 CRLF（见 docs：工作区是 CRLF，别用脚本把它整篇变 LF）。
  writeFileSync(OUT_PATH, css.replace(/\n/g, '\r\n'), 'utf8')
  process.stdout.write(
    `[color-fallback] 深色 ${String(counts[0])} 条 / 浅色 ${String(counts[1])} 条 → ${OUT_PATH}\n`,
  )
}
