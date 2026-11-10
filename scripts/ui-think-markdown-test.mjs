/**
 * 思考展开区正文的 markdown 排版（差距清单 S3，2026-11-10）。
 *
 * 背景：参考实现（dsh）的思考正文走 `MarkdownText`
 * （`deepseek-harness/packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:80`），
 * 代码块、列表、加粗都排得出来；本仓原来是 `white-space: pre-wrap` 直吐原文，
 * 同一段思考在这里是一坨纯文本。这一批把正文换成 `MarkdownView`（会话正文同一个渲染器），
 * 样式上复用已有的 `.file-md` 规则、只补「思考里该收的那几档」。
 *
 * 五段：
 *   [1] 形态钉：`ThinkText` 走 `MarkdownView`，`streaming` 接 `live`、`baseDir` 接 `ShellCwdContext`
 *   [2] 旧路已拆：不再有 `{text}` 裸直出（「加了 MarkdownView 又留着旧的那条」是最容易犯的错）
 *   [3] 样式：`.think-text` 不再 `pre-wrap`，左竖线 / 小字号保留
 *   [4] 代码块 / 表格 / 标题 / 列表 / 段距：思考里的降级规则都在，且代码块有 `overflow-x`
 *   [5] 回归闸：`.entry-text` 原有那套 markdown 规则没被顺手删掉
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-think-markdown-test.mjs
 *
 * @module dsc/scripts/ui-think-markdown-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveUiHalf } from './_check-runner.mjs'

const UI = resolveUiHalf('transcript')
const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

/** 「不该出现」的断言先剥注释：修法的注释里就引着旧写法，不剥会自己打脸。 */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const thinkTextPath = UI + '/rows/think-text.tsx'
const thinkText = read(thinkTextPath)
const thinkTextCode = stripComments(thinkText)
const viewsCss = read('src/packages/ui-renderer/ui/styles/legacy/views.css')
const markdown = read('src/packages/ui-primitives/ui/markdown.tsx')

/** 一条 CSS 规则的规则体（第一个花括号到配对的 `}`）；找不到给空串。 */
const ruleBody = (css, selector) => {
  const at = css.indexOf(`\n${selector} {`)
  if (at === -1) return ''
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  return close === -1 ? '' : css.slice(open + 1, close)
}

console.log('[1] 形态钉：ThinkText 走 MarkdownView，入参接对地方')
{
  check('MarkdownView 从 @dsc/ui 取（与会话正文同一个渲染器）', thinkTextCode.includes("import { MarkdownView } from '@dsc/ui'"))
  check(
    '工作目录从 ShellCwdContext 取（相对路径文件链接才点得动）',
    thinkTextCode.includes("import { ShellCwdContext } from '../shared'") &&
      thinkTextCode.includes('useContext(ShellCwdContext)'),
  )
  // 调用口径照 render.tsx:319 / 329：path="" 让 baseDir 当基准，streaming 跟着直播走。
  check(
    '<MarkdownView text={text} path="" baseDir={cwd} streaming={live} />',
    /<MarkdownView\s+text=\{text\}\s+path=""\s+baseDir=\{cwd\}\s+streaming=\{live\}\s*\/>/.test(thinkTextCode),
  )
  check(
    '签名冻结：{ text, live } 两个入参、导出名 ThinkText 不变',
    /export function ThinkText\(\{ text, live \}: \{ text: string; live: boolean \}\): ReactNode/.test(thinkTextCode),
  )
  // DOM 根节点是别人按类名认块的锚：`.think-block.live .think-text` 与截图脚本都依赖它。
  check('根节点仍是 <div className="think-text"（.think-block.live .think-text 依赖它）', /<div className="think-text"/.test(thinkTextCode))
  check('data-live 留着（直播态的原标记，没被顺手删）', thinkTextCode.includes("data-live={live ? '1' : undefined}"))
  // streaming 到底降级了什么：读代码确认它只改代码块上色的时机，markdown 解析本身不降级。
  check(
    'streaming 只推迟代码块上色（markdown.tsx 的 120ms 空闲窗口），不是另一套排版',
    markdown.includes('STREAM_HIGHLIGHT_IDLE_MS = 120') &&
      markdown.includes('window.setTimeout(run, STREAM_HIGHLIGHT_IDLE_MS)'),
  )
}

console.log('[2] 旧路已拆：正文不再直出裸文本')
{
  // 尖括号之间只剩一个 `{text}` 就是旧写法：它和 <MarkdownView> 会同时画一遍（重复显示）。
  check('没有「.think-text 里直接放 {text}」的旧写法', !/className="think-text"[^>]*>\s*\{text\}/.test(thinkTextCode))
  check('{text} 只作为 props 值出现（不当作子节点吐出去）', !/>\s*\{text\}\s*\n?\s*</.test(thinkTextCode))
  check('组件体里只画一个 MarkdownView（没有第二份渲染出口）', (thinkTextCode.match(/<MarkdownView\b/g) ?? []).length === 1)
}

console.log('[3] 样式：.think-text 不再 pre-wrap，引用体造型保留')
{
  const body = ruleBody(viewsCss, '.think-text')
  check('取到了 .think-text 规则（选择器没被改名）', body !== '')
  check('white-space: pre-wrap 已去掉（排版交给 markdown）', !body.includes('pre-wrap'), body.replace(/\s+/g, ' ').trim())
  check('左竖线还在（border-left: 2px solid var(--dsc-stroke-2)）', body.includes('border-left: 2px solid var(--dsc-stroke-2)'))
  check('字号仍是 --dsc-fs-caption（思考正文是次要内容）', body.includes('font-size: var(--dsc-fs-caption)'))
  check('line-height 1.7 / overflow-wrap / 12px 内距都没动', body.includes('line-height: 1.7') && body.includes('overflow-wrap: anywhere') && body.includes('padding: 4px 0 4px 12px'))
  check('直播那条只换竖线颜色（.think-block.live .think-text 还在）', ruleBody(viewsCss, '.think-block.live .think-text').includes('border-left-color: color-mix('))
}

console.log('[4] 思考里的 markdown 版式：克制、不撑破')
{
  // 段距 / 标题 / 列表 / 行内代码 / 代码块 / 表格 / 引用：全部挂 .think-text 前缀，
  // 不碰正文那套 .file-md 规则（那是全站共用的一份，改它会波及所有消息与预览页签）。
  check('段距比正文紧（p 收到 0.35em）', /\.think-text \.file-md p \{\s*\n\s*margin: 0\.35em 0;/.test(viewsCss))
  check('首尾块贴边（展开区上下不留白带）', /\.think-text \.file-md > :first-child \{\s*\n\s*margin-top: 0;/.test(viewsCss) && /\.think-text \.file-md > :last-child \{\s*\n\s*margin-bottom: 0;/.test(viewsCss))
  check('标题降级到正文字号（不比行头「思考」还大）', /\.think-text \.file-md h6 \{[^}]*font-size: inherit;[^}]*font-weight: 600;/.test(viewsCss))
  check('有序 / 无序列表都有缩进（标记不贴着左竖线）', /\.think-text \.file-md ul,\s*\n\.think-text \.file-md ol \{[^}]*padding-left: 1\.3em;/.test(viewsCss))
  check('行内代码不换行撑破（overflow-wrap: anywhere）', /\.think-text \.file-md code \{\s*\n\s*overflow-wrap: anywhere;/.test(viewsCss))

  // 代码块：这一条是「400px 限高的阶段组体不被撑破」的保险，缺 overflow-x 就红。
  const codeRule = /\.think-text \.md-code-block,\s*\n\.think-text \.file-md pre \{([^}]*)\}/.exec(viewsCss)
  check('代码块规则存在（.think-text .md-code-block / .file-md pre）', codeRule !== null)
  check(
    '代码块有 overflow-x: auto + max-width: 100%（长行在块内滚，不撑宽组体）',
    codeRule !== null && codeRule[1].includes('overflow-x: auto') && codeRule[1].includes('max-width: 100%') && codeRule[1].includes('min-width: 0'),
  )
  check('代码块底色 / 等宽仍来自共用的 .file-md pre（思考这层没另写一套）', /\.entry-text \.markdown pre,\s*\n\.file-md pre \{[^}]*background: var\(--dsc-fill-quaternary\);[^}]*font-family: var\(--dsc-font-mono\);/.test(viewsCss))
  check('表格不许溢出到右侧（display: block + overflow-x: auto）', /\.think-text \.file-md table \{[^}]*overflow-x: auto;/.test(viewsCss))
  check('引用有自己的一档内距（不叠三层缩进）', /\.think-text \.file-md blockquote \{[^}]*padding-left: 10px;/.test(viewsCss))
  // .file-md 自带 10px/14px 内距是给预览页签的，思考里不清零会把正文推出左竖线。
  check('思考里清掉 .file-md 的预览内距', /\.think-text \.file-md \{\s*\n\s*padding: 0;/.test(viewsCss))
}

console.log('[5] 回归闸：.entry-text 原有那套 markdown 规则没被误删')
{
  // 修法是「覆盖」，不是「重写」：正文那几条规则的并列选择器（`.entry-text .markdown X` 与
  // `.file-md X`）只要少一条，全站消息的排版就跟着变。挑三条关键的钉住。
  check('.file-md 的段距那条还在（正文 0.65em）', /\.entry-text \.markdown p,\s*\n\.file-md p \{\s*\n\s*margin: 0\.65em 0;/.test(viewsCss))
  check('.file-md pre 的底色 + 横向滚动还在', /\.entry-text \.markdown pre,\s*\n\.file-md pre \{[^}]*overflow-x: auto;/.test(viewsCss))
  check('.file-md table 的 border-collapse 还在', /\.entry-text \.markdown table,\s*\n\.file-md table \{\s*\n\s*border-collapse: collapse;/.test(viewsCss))
  check('.file-md 的行内 code 底色还在', /\.entry-text \.markdown code,\s*\n\.file-md code \{[^}]*background: var\(--dsc-fill-quaternary\);/.test(viewsCss))
  check('.file-md 容器自己的内距还在（预览页签靠它）', /\.file-md \{\s*\n\s*padding: 10px 14px;/.test(viewsCss))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
