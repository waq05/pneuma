/**
 * shiki 语法高亮（壳内置平台层）：单例 highlighter + 按需懒装载语法。
 *
 * 从旧渲染层 `desktop/src/renderer/file-preview.tsx`（单例 / LANG_IMPORTS /
 * highlightToHtml）与 `diff-highlight.ts`（highlightLines）移植，作为 `@dsc/ui`
 * web 值面的一部分转出——插件 bundle 不自带这些依赖（平台模块表里没有它们），
 * 一律经 `import { highlightLines } from '@dsc/ui'` 用壳里这一份。
 *
 * 引擎用 JS regex（免 oniguruma WASM）；主题 github-light / one-dark-pro 双主题，
 * 色值出成 CSS 变量（`--shiki-light` / `--shiki-dark`，legacy CSS :3536 起消费），
 * 浅/深由页面的 data-theme 切换，不重解析。
 *
 * @module dsc-ui-shell/platform/highlight
 */
import { SHIKI_LANG_BY_EXT } from './lang-table'

type HighlighterCoreLike = Awaited<ReturnType<typeof import('shiki/core').createHighlighterCore>>
type LangModule = { default: unknown }

/** 路径里的文件名（两种分隔符都认；与壳 files 插件同名工具同一份逻辑）。 */
function basenameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** 扩展名 → shiki 语法 id（没有映射的返回 undefined = 纯文本）。 */
export function langForPath(path: string): string | undefined {
  const name = basenameOf(path).toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
  return SHIKI_LANG_BY_EXT[ext]
}

/**
 * 语法 id → 模块加载器。必须用字面量 import（@shikijs/langs 的 exports 是固定
 * 枚举、没有通配，模板串动态 import 运行时解析不了）；每条各自成懒 chunk，
 * 点开对应语言的文件才加载。表键与 SHIKI_LANG_BY_EXT 映射出的 id 一一对应。
 */
const LANG_IMPORTS: Record<string, () => Promise<LangModule>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  json5: () => import('@shikijs/langs/json5'),
  markdown: () => import('@shikijs/langs/markdown'),
  mdx: () => import('@shikijs/langs/mdx'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  swift: () => import('@shikijs/langs/swift'),
  php: () => import('@shikijs/langs/php'),
  ruby: () => import('@shikijs/langs/ruby'),
  lua: () => import('@shikijs/langs/lua'),
  scala: () => import('@shikijs/langs/scala'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  bat: () => import('@shikijs/langs/bat'),
  powershell: () => import('@shikijs/langs/powershell'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  ini: () => import('@shikijs/langs/ini'),
  dotenv: () => import('@shikijs/langs/dotenv'),
  html: () => import('@shikijs/langs/html'),
  xml: () => import('@shikijs/langs/xml'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  sass: () => import('@shikijs/langs/sass'),
  less: () => import('@shikijs/langs/less'),
  vue: () => import('@shikijs/langs/vue'),
  svelte: () => import('@shikijs/langs/svelte'),
  astro: () => import('@shikijs/langs/astro'),
  sql: () => import('@shikijs/langs/sql'),
  graphql: () => import('@shikijs/langs/graphql'),
  proto: () => import('@shikijs/langs/proto'),
  'objective-c': () => import('@shikijs/langs/objective-c'),
  'objective-cpp': () => import('@shikijs/langs/objective-cpp'),
  dart: () => import('@shikijs/langs/dart'),
  r: () => import('@shikijs/langs/r'),
  julia: () => import('@shikijs/langs/julia'),
  elixir: () => import('@shikijs/langs/elixir'),
  erlang: () => import('@shikijs/langs/erlang'),
  haskell: () => import('@shikijs/langs/haskell'),
  clojure: () => import('@shikijs/langs/clojure'),
  perl: () => import('@shikijs/langs/perl'),
  zig: () => import('@shikijs/langs/zig'),
  solidity: () => import('@shikijs/langs/solidity'),
  fsharp: () => import('@shikijs/langs/fsharp'),
  diff: () => import('@shikijs/langs/diff'),
  log: () => import('@shikijs/langs/log'),
  rst: () => import('@shikijs/langs/rst'),
  latex: () => import('@shikijs/langs/latex'),
  makefile: () => import('@shikijs/langs/makefile'),
}

let highlighterPromise: Promise<HighlighterCoreLike> | null = null
const loadedLangs = new Set<string>()

/**
 * 围栏标注的常见短名 → shiki 语法 id。markdown 代码块的语言直接来自 ```` ```ts ````
 * 这类写法，而 shiki 的枚举里是 `typescript`——不做这一层归一，最常用的几种围栏
 * 全都会静默降级成纯文本（旧渲染层就是这个毛病，这里顺手修掉）。
 */
const FENCE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  rb: 'ruby',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  yml: 'yaml',
  ps1: 'powershell',
  cs: 'csharp',
  'c++': 'cpp',
  golang: 'go',
}

/** 围栏语言 → 可装载的语法 id（表里原生有的原样过，短名走别名，其余原样返回由调用方回落）。 */
function normalizeFenceLang(lang: string): string {
  return LANG_IMPORTS[lang] !== undefined ? lang : (FENCE_ALIASES[lang] ?? lang)
}

/** 单例 highlighter：JS regex 引擎（免 oniguruma WASM），主题先空载、语言按需装。 */
export function getHighlighter(): Promise<HighlighterCoreLike> {
  highlighterPromise ??= import('shiki/core').then(async (core) =>
    core.createHighlighterCore({
      themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/one-dark-pro')],
      langs: [],
      engine: (await import('shiki/engine/javascript')).createJavaScriptRegexEngine(),
    }),
  )
  return highlighterPromise
}

/** 装一门语法（幂等；表里没有的 id 原样返回——调用方回落纯文本）。 */
export async function loadLang(id: string): Promise<void> {
  if (loadedLangs.has(id)) return
  const loader = LANG_IMPORTS[id]
  if (loader === undefined) return
  const grammar = await loader()
  const highlighter = await getHighlighter()
  await highlighter.loadLanguage((grammar as LangModule).default as never)
  loadedLangs.add(id)
}

/** 把一段代码高亮成 shiki HTML（无语法 / 装不上 → 纯文本 lang，回落转义输出）。 */
export async function highlightToHtml(code: string, lang: string | undefined): Promise<string> {
  const highlighter = await getHighlighter()
  const resolved = lang === undefined ? undefined : normalizeFenceLang(lang)
  const usable = resolved !== undefined && (loadedLangs.has(resolved) || LANG_IMPORTS[resolved] !== undefined)
  const id = usable && resolved !== undefined ? resolved : 'text'
  if (usable && resolved !== undefined && !loadedLangs.has(resolved)) await loadLang(resolved)
  return highlighter.codeToHtml(code, {
    lang: id,
    themes: { light: 'github-light', dark: 'one-dark-pro' },
    defaultColor: false,
  })
}

/** 高亮的规模上限（行数 / 字符数），超了整块返回 null（纯文本渲染）。 */
const MAX_HIGHLIGHT_LINES = 2000
const MAX_HIGHLIGHT_BYTES = 512 * 1024

/** 一行的高亮产物：每段 token 一条（html 是已转义并带双主题 CSS 变量的 <span>）。 */
export interface HighlightedLine {
  segments: string[]
}

/**
 * 把一段代码（通常是 diff hunk 行按行序拼接）高亮成逐行的 token HTML。
 *
 * 为什么按「整块代码」喂 shiki 而不是逐行：shiki 的解析器状态（多行字符串、块注释、
 * 缩进结构）是跨行的，逐行喂会把这类结构高亮碎掉。增删行交替处的语法流会有轻微
 * 错位，换来的是单行内的关键字/字符串/注释高亮基本全对。
 *
 * 没有对应语法 / 超限 / shiki 失败 → 返回 null，调用方回落纯文本。
 */
export async function highlightLines(code: string, path: string): Promise<HighlightedLine[] | null> {
  const lang = langForPath(path)
  if (lang === undefined) return null
  const lines = code.split('\n')
  if (lines.length > MAX_HIGHLIGHT_LINES || code.length > MAX_HIGHLIGHT_BYTES) return null
  try {
    // 表里没有这门语法时 loadLang 静默返回，下面的 codeToTokens 会抛「未装载」——
    // 与 shiki 自身的解析失败一起归到 null（纯文本回落），调用方不用区分原因。
    await loadLang(lang)
    const highlighter = await getHighlighter()
    const result = highlighter.codeToTokens(code, {
      lang,
      themes: { light: 'github-light', dark: 'one-dark-pro' },
      defaultColor: false,
    })
    return result.tokens.map((tokens) => ({
      segments: tokens.map((token) => {
        const style = token.htmlStyle ?? { color: token.color }
        const css = Object.entries(style)
          .map(([name, value]) => `${name}:${value}`)
          .join(';')
        return `<span style="${css}">${escapeHtml(token.content)}</span>`
      }),
    }))
  } catch {
    return null
  }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** token 内容是文件原文，拼进 innerHTML 前必须转义（shiki 只转义自己的结构，不代管 content）。 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
}
