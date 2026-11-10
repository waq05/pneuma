/**
 * 「历史被压缩」这个落点有没有画进会话流的确定性探针（差距清单 S8 的第一块）。
 *
 * 数据一直都在：`contract/transcript.ts` 的 `CompactionMark`（第几次压缩，1 基），适配器在
 * 两种条目上挂它——实时的 system 通知（adapter 的 `system(text, compaction = true)`）与
 * 重放出来的那条压缩摘要 user 条目（`SUMMARY_BANNER` 前缀认出来的）。轨迹页早就在用它切
 * 区段；缺的是**会话流**：以前带压缩标记的 system 条目按普通灰字画，用户消息上的标记更是
 * 看不见。这一批补两张卡：
 *
 *   - `.entry-compaction`：一条两侧细线的分隔行，说清「第几次」（`rows/compaction-row.tsx`）；
 *   - `.entry-user-compaction`：压缩摘要那个气泡上方的一行 16px 小字（`rows/user-row.tsx`）。
 *
 * 五段：
 *   [1] 组件：次数从 `mark` 来、两侧各一条 `aria-hidden` 的线、正文不画只进 data-tip
 *   [2] 接线：render.tsx 的 system 分支**先**判 `entry.compaction` 再解析写前预览；
 *       user-row 的两处气泡上方都挂小标
 *   [3] 样式：两组规则都在、分隔行靠 `flex: 1` 拉出两侧线、颜色只走 `--dsc-*` 令牌
 *   [4] 文案：zh / en 两个键都在、两份字典键集一致、英文里没有汉字
 *   [5] 反向钉：组件里没有中文字面量（文案只有字典一处）、没有写死的 `#` 色值
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-compaction-row-test.mjs
 *
 * @module dsc/scripts/ui-compaction-row-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveUiHalf } from './_check-runner.mjs'

const UI = resolveUiHalf('transcript')
const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')
/** 汉字（与 ui-locale-test 同一条范围）。 */
const CJK = /[\u4e00-\u9fff]/

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

const rowSrc = read(`${UI}/rows/compaction-row.tsx`)
const userRowSrc = read(`${UI}/rows/user-row.tsx`)
const renderSrc = read(`${UI}/render.tsx`)
const css = read('src/packages/ui-renderer/ui/styles/legacy/views.css')

console.log('[1] 组件：次数从 mark 来，正文不画')
{
  check('导出 CompactionRow，收的是 CompactionMark', /export function CompactionRow\(\{ mark \}: \{ mark: CompactionMark \}\): ReactNode/.test(rowSrc))
  check('根节点是 .entry-compaction，次数写进 data-compaction-count', rowSrc.includes('className="entry-compaction"') && rowSrc.includes('data-compaction-count={mark.count}'))
  // 断言钉的是「说明来自字典」，不是它在 JSX 里的写法：现在先把 key 取成常量（`const tip = …`），
  // 再同时挂 `data-tip` 与原生 `title`——气泡层 0.6.37 起下线，只写 data-tip 等于把说明藏进 DOM。
  check(
    '说明走字典（transcript.compaction.tip），并且挂到了原生 title 上',
    rowSrc.includes("t('transcript.compaction.tip')") && /title=\{tip\}|title=\{t\('transcript\.compaction\.tip'\)\}/.test(rowSrc),
  )
  check('两侧各一条 aria-hidden 的分隔线', (rowSrc.match(/className="entry-compaction-line" aria-hidden="true"/g) ?? []).length === 2)
  check('中间一行文字取字典（transcript.compaction.mark，带 count）', rowSrc.includes("t('transcript.compaction.mark', { count: mark.count })"))
  check('不画 system 正文：组件只收 mark，不碰 entry.text', !rowSrc.includes('entry.text') && !rowSrc.includes('text={'))
}

console.log('[2] 接线：system 分支先判压缩标记，用户气泡上方挂小标')
{
  // 只截 system 分支：整份文件里 parseReviewNotice 在 import 那一行就先出现过，
  // 拿全文 indexOf 比顺序会把 import 当判据，永远假绿。
  const from = renderSrc.indexOf("case 'system':")
  const to = renderSrc.indexOf("case 'turn-max-tokens':")
  const branch = from >= 0 && to > from ? renderSrc.slice(from, to) : ''
  check('找得到 system 分支（切到 turn-max-tokens 为止）', branch !== '' && branch.includes('parseReviewNotice('))
  check(
    '先判 entry.compaction，再解析写前预览（indexOf 比顺序）',
    branch.includes('if (entry.compaction !== undefined) return <CompactionRow mark={entry.compaction} />') &&
      branch.indexOf('entry.compaction') < branch.indexOf('parseReviewNotice('),
    `compaction@${String(branch.indexOf('entry.compaction'))} preview@${String(branch.indexOf('parseReviewNotice('))}`,
  )
  check('压缩提示的正文不再画一遍（分支里没有把它交给 .entry-system）', !/entry\.compaction[\s\S]{0,120}entry-system/.test(branch))
  check('render.tsx 真的 import 了 CompactionRow', /import \{ CompactionRow \} from '\.\/rows\/compaction-row'/.test(renderSrc))

  check('user-row 读 compaction 字段', userRowSrc.includes('entry.compaction'))
  check('气泡上方那一行是 .entry-user-compaction', userRowSrc.includes('className="entry-user-compaction"'))
  // 两处气泡各一份：可编辑行 + 只读出口（渲染层重构后两处都读同一条条目）。
  const marks = (userRowSrc.match(/entry\.compaction === undefined \? null : <UserCompactionMark mark=\{entry\.compaction\} \/>/g) ?? []).length
  check('可编辑行与只读出口各挂一枚（不是只改了一处）', marks === 2, String(marks))
  check('小标也带次数与说明', userRowSrc.includes('data-compaction-count={mark.count}') && userRowSrc.includes("t('transcript.compaction.tip')"))
}

console.log('[3] 样式：分隔行 + 气泡上方小标')
{
  const block = (selector) => {
    const at = css.indexOf(`\n${selector} {`)
    if (at < 0) return null
    const end = css.indexOf('}', at)
    return end < 0 ? null : css.slice(at, end + 1)
  }
  const row = block('.entry-compaction')
  const line = block('.entry-compaction-line')
  const text = block('.entry-compaction-text')
  const mark = block('.entry-user-compaction')
  check('有 .entry-compaction 规则', row !== null)
  check('有 .entry-compaction-line 规则', line !== null)
  check('有 .entry-compaction-text 规则', text !== null)
  check('有 .entry-user-compaction 规则', mark !== null)
  check('分隔行居中：flex + align-items: center', row !== null && /display: flex/.test(row) && /align-items: center/.test(row))
  check('两侧线各占一半（flex: 1）', line !== null && /flex: 1;/.test(line))
  check('线的颜色走 --dsc-stroke-2 令牌', line !== null && /background: var\(--dsc-stroke-2\)/.test(line))
  check('上下间距走 --dsc-sp-2', row !== null && /margin: var\(--dsc-sp-2\) 0/.test(row))
  check('文字 --dsc-fs-tool + --dsc-text-tertiary', text !== null && /font-size: var\(--dsc-fs-tool\)/.test(text) && /color: var\(--dsc-text-tertiary\)/.test(text))
  check('气泡上方小标 --dsc-fs-tool + --dsc-text-quaternary', mark !== null && /font-size: var\(--dsc-fs-tool\)/.test(mark) && /color: var\(--dsc-text-quaternary\)/.test(mark))
  check('小标高 16px（不顶动气泡）', mark !== null && /height: 16px/.test(mark) && /line-height: 16px/.test(mark))
  check('小标不被压缩（flex: none，宽度由文字撑）', mark !== null && /flex: none/.test(mark))
}

console.log('[4] 文案：两个键在 zh / en 里都有')
{
  const zh = JSON.parse(read('src/packages/ui-transcript/locale/ui.zh.json'))
  const en = JSON.parse(read('src/packages/ui-transcript/locale/ui.en.json'))
  const keys = ['transcript.compaction.mark', 'transcript.compaction.tip']
  for (const key of keys) {
    check(`zh 有 ${key}`, typeof zh[key] === 'string' && zh[key] !== '')
    check(`en 有 ${key}`, typeof en[key] === 'string' && en[key] !== '')
  }
  const zhKeys = Object.keys(zh).sort().join('\n')
  const enKeys = Object.keys(en).sort().join('\n')
  check('两份字典键集一致（缺译 / 多键都不放过）', zhKeys === enKeys)
  check('英文里没有汉字（真译过，不是抄的）', keys.every((key) => !CJK.test(en[key] ?? '')))
  check('次数占位符两边都在（mark 的 {count}）', keys.every((key) => (key === 'transcript.compaction.mark') === zh[key].includes('{count}')))
  check('mark 的 {count} 在英文译本里也保留', en['transcript.compaction.mark'].includes('{count}'))
  check('中文说清「压缩」与次数', zh[keys[0]].includes('压缩') && zh[keys[0]].includes('{count}'))
}

console.log('[5] 反向钉：组件里没有中文字面量、没有写死色值')
{
  // 「不该出现」的断言先剥注释：文件头就引着「历史已压缩」这类中文原话，不剥会自己打脸。
  const code = rowSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  check('组件里没有中文字面量（文案只有字典一处）', !CJK.test(code))
  check(
    '组件的文案键都在本包字典里（写错键会静默显示键名）',
    (code.match(/t\('([^']+)'/g) ?? []).every((hit) => {
      const key = hit.slice(3, -1)
      return typeof JSON.parse(read('src/packages/ui-transcript/locale/ui.zh.json'))[key] === 'string'
    }),
  )
  const at = css.indexOf('\n.entry-compaction {')
  const end = css.indexOf('}', at)
  const rowBlock = at < 0 || end < 0 ? '' : css.slice(at, end + 1)
  check('分隔行那段 CSS 里没有写死的 # 色值', !rowBlock.includes('#'))
  check('分隔行那段 CSS 里没有 rgb()/hsl() 直写', !/rgba?\(|hsla?\(/.test(rowBlock))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
