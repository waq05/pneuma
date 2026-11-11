/**
 * 两张「请求账单」卡的确定性探针：系统提示（⚙）与上下文注入（⊕）。
 *
 * 数据面已经落地（`contract/transcript.ts` 的两条条目、adapter 的 `prompt/used` 与
 * `context/injected`、会话日志里的 `state('system-prompt')` / `state('context-injected')`），
 * 这一批只做界面那半边：两张卡 + 六处接线。界面模块是 JSX，Node 里 import 不了，
 * 所以本探针打的是**源码钉**（与 `ui-compaction-row-test.mjs` 同一套办法）。
 *
 * 七段：
 *   [1] 组件：两张卡都在、根类名是 `.entry-prompt` / `.entry-injection`、收起行的读数来自字典
 *   [2] 老会话：`bodyMissing` 分支存在，且那一支里**没有段清单表**（不画空表）
 *   [3] 接线：render.tsx 两个 case 直画卡片（不走节点槽）、存档键是 `${sessionId ?? ''}:${row.stable}`
 *   [4] 结构表：round-fold 的 TURN_INDEPENDENT / rounds.ts 的轮尾早退 / ui.tsx 的欢迎态判据
 *   [5] 样式：两份卡用的每一个类名都在 views.css 里有规则（根类名与 CSS 一致）
 *   [6] 文案：26 个键在 zh / en 都在、两份键集一致、英文真译过、占位符两边都留
 *   [7] 反向钉：展开体里没有正文字段（没偷偷去改契约）、组件里没有中文字面量、没有 import 契约
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-prompt-cards-test.mjs
 *
 * @module dsc/scripts/ui-prompt-cards-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveUiHalf } from './_check-runner.mjs'

const UI = resolveUiHalf('transcript')
const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')
/** 汉字（与 ui-locale-test 同一条范围）。 */
const CJK = /[\u4e00-\u9fff]/
/** 组件里所有静态 className 的类名（模板串拼出来的不放进来，这里一个都没有）。 */
const classNamesOf = (src) =>
  [...src.matchAll(/className="([^"]+)"/g)].flatMap((hit) => hit[1].split(/\s+/)).filter((name) => name !== '')

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

const cardSrc = read(`${UI}/rows/prompt-card.tsx`)
const renderSrc = read(`${UI}/render.tsx`)
const roundFoldSrc = read(`${UI}/round-fold.tsx`)
const roundsSrc = read(`${UI}/rounds.ts`)
const uiSrc = read(`${UI}/ui.tsx`)
const css = read('src/packages/ui-renderer/ui/styles/legacy/views.css')
const zh = JSON.parse(read('src/packages/ui-transcript/locale/ui.zh.json'))
const en = JSON.parse(read('src/packages/ui-transcript/locale/ui.en.json'))

console.log('[1] 组件：两张卡在、根类名定死、收起行读数齐全')
{
  check('导出 SystemPromptCard，收 prompt', /export function SystemPromptCard\(\{[\s\S]*?\}: \{[\s\S]*?prompt: SystemPromptView/.test(cardSrc))
  check('导出 ContextInjectionCard，收 parts', /export function ContextInjectionCard\(\{[\s\S]*?\}: \{[\s\S]*?parts: ContextInjectionView\[\]/.test(cardSrc))
  check('系统提示卡的根节点是 .entry-prompt', cardSrc.includes('className="entry-prompt"') && cardSrc.includes('data-prompt-hash={prompt.hash}'))
  check('上下文注入卡的根节点是 .entry-injection', cardSrc.includes('className="entry-injection"') && cardSrc.includes('data-injection-count={parts.length}'))
  check('两卡的类型都从条目上就地取（没有另开一份契约类型）',
    cardSrc.includes("Extract<TranscriptEntry, { kind: 'system-prompt' }>['prompt']")
    && cardSrc.includes("Extract<TranscriptEntry, { kind: 'context-injection' }>['parts'][number]"))
  // 收起行三段读数：字数（千位折算 K）· 段数 · 模型（有才画）。
  check('字数走字典（transcript.prompt.chars），千位折算成 K',
    cardSrc.includes("t('transcript.prompt.chars', { chars: formatChars(chars) })")
    && cardSrc.includes("`${kilo.toFixed(1)}K`") && cardSrc.includes("`${String(kilo)}K`"))
  check('段数走字典（transcript.prompt.sections，带 count）',
    cardSrc.includes("t('transcript.prompt.sections', { count: sections.length })"))
  check('有 model 才画分隔点与模型名', /\{prompt\.model === undefined \|\| prompt\.model === '' \? null : \(/.test(cardSrc))
  check('段清单按 order 升序排（不是照 sections 原序铺）',
    cardSrc.includes('[...prompt.sections].sort((left, right) => left.order - right.order)'))
  check('末行画 hash 前 8 位', cardSrc.includes("prompt.hash.slice(0, 8)") && cardSrc.includes("t('transcript.prompt.hash'"))
  // 注入卡：同类合并、按首次出现顺序、超过三类收进 +N。
  check('注入卡按 kind 合并（groupByKind）', cardSrc.includes('function groupByKind(') && cardSrc.includes('found.chars += part.chars'))
  check('合并顺序是首次出现（Map 只用来查下标，不排序）',
    cardSrc.includes('at.get(part.kind)') && !/groups\.sort\(|\.sort\(\(left, right\) => left\.kind/.test(cardSrc))
  check('最多列三类，其余写 +N', cardSrc.includes('const MAX_KIND_LABELS = 3') && cardSrc.includes("t('transcript.injection.more', { count: rest })"))
  check('展开体逐条画来源 / 位置 / 字数 / 预览',
    cardSrc.includes('entry-injection-source') && cardSrc.includes('entry-injection-where')
    && cardSrc.includes('entry-injection-chars') && cardSrc.includes('entry-injection-preview'))
  check('位置两档走字典（系统提示 / 请求末尾）',
    cardSrc.includes("? t('transcript.injection.whereSystem') : t('transcript.injection.whereTail')"))
  check('parts 为空就什么都不画', cardSrc.includes('if (parts.length === 0) return null'))
  check('钩子在空清单早退之前调（钩子顺序不会随数据变）',
    cardSrc.indexOf('useFoldState(storeKey, false)') < cardSrc.indexOf('if (parts.length === 0) return null'))
  check('折叠态走 useFoldState（存档键由调用方给）',
    cardSrc.includes("import { useFoldState } from '../fold-hook'")
    && (cardSrc.match(/useFoldState\(storeKey, false\)/g) ?? []).length === 2)
}

console.log('[2] 老会话：bodyMissing 分支存在，且不画空表')
{
  const at = cardSrc.indexOf('prompt.bodyMissing === true')
  const to = cardSrc.indexOf('entry-prompt-body')
  const branch = at >= 0 && to > at ? cardSrc.slice(at, to) : ''
  check('有 bodyMissing 分支', at >= 0)
  check('那一支里给的是「老会话」那句话', branch.includes("t('transcript.prompt.bodyMissing')") && branch.includes('entry-prompt-missing'))
  check('那一支里没有段清单表（不画空表）', branch !== '' && !branch.includes('entry-prompt-table') && !branch.includes('sections.map'))
  check('bodyMissing 与段表是二选一（同一个三元的两个分支）', /prompt\.bodyMissing === true \? \([\s\S]{0,600}?\) : \(/.test(cardSrc))
  check('收起行不受 bodyMissing 影响（照画）',
    cardSrc.indexOf('entry-prompt-label') < at && cardSrc.indexOf('transcript.prompt.sections') < at)
}

console.log('[3] 接线：render.tsx 两个 case 直画卡片，存档键与 think/tool 同口径')
{
  const sliceCase = (kind) => {
    const from = renderSrc.indexOf(`case '${kind}':`)
    if (from < 0) return ''
    const to = renderSrc.indexOf('case ', from + 10)
    return to < 0 ? renderSrc.slice(from) : renderSrc.slice(from, to)
  }
  const promptBranch = sliceCase('system-prompt')
  const injectionBranch = sliceCase('context-injection')
  check("有 case 'system-prompt'", promptBranch !== '')
  check("有 case 'context-injection'", injectionBranch !== '')
  check('render.tsx 真的 import 了两张卡',
    /import \{ ContextInjectionCard, SystemPromptCard \} from '\.\/rows\/prompt-card'/.test(renderSrc))
  const storeKeyLine = "const storeKey = `${sessionId ?? ''}:${row.stable}`"
  check('系统提示那一支的存档键是 `${sessionId ?? \'\'}:${row.stable}`', promptBranch.includes(storeKeyLine))
  check('注入那一支的存档键同上', injectionBranch.includes(storeKeyLine))
  check('两张卡都拿到了存档键',
    promptBranch.includes('<SystemPromptCard prompt={entry.prompt} storeKey={storeKey} />')
    && injectionBranch.includes('<ContextInjectionCard parts={entry.parts} count={entry.count} storeKey={storeKey} />'))
  // 要求：**别**走节点槽，直接画。走槽的话这一支里会出现 TRANSCRIPT_NODE_SLOT / renderSlot。
  check('两支都不走节点槽（直接画卡片）',
    !promptBranch.includes('renderSlot') && !promptBranch.includes('TRANSCRIPT_NODE_SLOT')
    && !injectionBranch.includes('renderSlot') && !injectionBranch.includes('TRANSCRIPT_NODE_SLOT'))
  check('存档键与会话 id 拼（`${sessionId ?? \'\'}`，不是 entry.id）',
    (renderSrc.match(/const storeKey = `\$\{sessionId \?\? ''\}:\$\{row\.stable\}`/g) ?? []).length >= 3
    && !renderSrc.includes("${sessionId ?? ''}:${String(row.entry.id)}"))
}

console.log('[4] 结构表：三处集合 / 早退都含两个新 kind')
{
  // round-fold：整轮收起不许把它们一起藏掉。
  const from = roundFoldSrc.indexOf('export const TURN_INDEPENDENT')
  const to = roundFoldSrc.indexOf('])', from)
  const independent = from >= 0 && to > from ? roundFoldSrc.slice(from, to) : ''
  check('round-fold.tsx 的 TURN_INDEPENDENT 含 system-prompt', independent.includes("'system-prompt'"), independent.slice(0, 120))
  check('round-fold.tsx 的 TURN_INDEPENDENT 含 context-injection', independent.includes("'context-injection'"), independent.slice(0, 120))
  check('原来的五类没被删', ['user', 'plan', 'system', 'turn-end', 'turn-max-tokens'].every((kind) => independent.includes(`'${kind}'`)))

  // rounds.ts：开场一条注入不许把「这一轮答没答」变成已答。
  // 切片必须从 guard 的位置往后找终点：轮中途插话那一支（steering）里也有同一句
  // `current.endIndex = index`，从头找会切出一个空串、让三条断言假红。
  const guardAt = roundsSrc.indexOf("if (current === undefined || entry.kind === 'system'")
  const guard = guardAt < 0 ? '' : roundsSrc.slice(guardAt, roundsSrc.indexOf('current.endIndex = index', guardAt))
  check('rounds.ts 的早退含 system-prompt', guard.includes("entry.kind === 'system-prompt'"), guard.slice(0, 160))
  check('rounds.ts 的早退含 context-injection', guard.includes("entry.kind === 'context-injection'"))
  check('早退之后就 return（不推进 endIndex / answered）', /return/.test(guard) && !guard.includes('current.endIndex = index'))
  // 同一段里 endIndex / answered 的推进还在（别把整段删了当「早退」）。
  check('endIndex / answered 的推进仍在（只是被早退挡在前面）',
    roundsSrc.includes('current.endIndex = index') && roundsSrc.includes('current.answered = true'))

  // ui.tsx：空会话欢迎态不许被开场那两张账单卡顶掉。
  // 从后往前找：同一个文件里还有一处 `seats.rounds.length === 0`（清空后的滚动复位），
  // 从头找会命中那一处，白名单根本不在窗口里。
  const predicateAt = uiSrc.lastIndexOf('seats.rounds.length === 0')
  // 固定窗口够读完那个三元 + every 的白名单（三行），不靠 `) {` 找终点——
  // 箭头函数 `(row) =>` 里也有一对括号，按它切会切到别处去。
  const predicate = predicateAt < 0 ? '' : uiSrc.slice(predicateAt, predicateAt + 420)
  check('ui.tsx 欢迎态判据含 system-prompt', predicate.includes("row.entry.kind === 'system-prompt'"), predicate.slice(0, 200))
  check('ui.tsx 欢迎态判据含 context-injection', predicate.includes("row.entry.kind === 'context-injection'"), predicate.slice(0, 200))
  check('判据仍是「一个都不许是真内容」（every + 白名单）',
    predicate.includes('seats.leading.every(') && !predicate.includes('some('))
}

console.log('[5] 样式：组件用到的每个类名都在 views.css 里有规则')
{
  const names = [...new Set(classNamesOf(cardSrc))]
  check('类名清单一共 20 个以上（卡不是空壳）', names.length >= 20, String(names.length))
  const missing = names.filter((name) => !css.includes(`.${name}`))
  check('没有「组件里写了类名、CSS 里没有」的（根类名与 CSS 一致）', missing.length === 0, JSON.stringify(missing))
  const block = (selector) => {
    // 这组规则里有好几条是「两卡共用一条」（`.entry-prompt,` / `.entry-injection,`），
    // 所以两种开头都要试：单选择器与并列选择器的第一项。
    for (const head of [`\n${selector} {`, `\n${selector},`]) {
      const at = css.indexOf(head)
      if (at < 0) continue
      const open = css.indexOf('{', at)
      const end = open < 0 ? -1 : css.indexOf('}', open)
      if (open < 0 || end < 0) continue
      return css.slice(at, end + 1)
    }
    return null
  }
  const regionAt = css.indexOf('\n.entry-prompt,')
  const regionEnd = css.indexOf('/* 追加区：', regionAt)
  const region = regionAt < 0 || regionEnd < regionAt ? '' : css.slice(regionAt, regionEnd)
  check('有 .entry-prompt 规则', block('.entry-prompt') !== null)
  check('有 .entry-injection 规则', block('.entry-injection') !== null)
  check('行头与思考行同一档高度（min-height: --dsc-process-row-h）',
    block('.entry-prompt-head') !== null && /min-height: var\(--dsc-process-row-h\)/.test(block('.entry-prompt-head') ?? ''))
  check('展开体是竖排 flex（表与行各占一行）',
    block('.entry-prompt-body') !== null && /flex-direction: column/.test(block('.entry-prompt-body') ?? ''))
  check('段表是三列网格', block('.entry-prompt-tr') !== null && /grid-template-columns:/.test(block('.entry-prompt-tr') ?? ''))
  check('预览单行省略（不是正文块）',
    block('.entry-injection-preview') !== null && /text-overflow: ellipsis/.test(block('.entry-injection-preview') ?? '')
    && /white-space: nowrap/.test(block('.entry-injection-preview') ?? ''))
  check('颜色全走 --dsc-* 令牌（这一段规则里没有写死色值）',
    region !== '' && !/rgba?\(|hsla?\(/.test(region) && !/#[0-9a-fA-F]{3,8}/.test(region), region.slice(0, 80))
}

console.log('[6] 文案：26 个键在 zh / en 都在，真译过，占位符两边都留')
{
  const keys = Object.keys(zh).filter((key) => key.startsWith('transcript.prompt.') || key.startsWith('transcript.injection.'))
  check('两张卡一共 26 个键', keys.length === 26, String(keys.length))
  for (const key of keys) {
    check(`zh 有 ${key}`, typeof zh[key] === 'string' && zh[key] !== '')
    check(`en 有 ${key}`, typeof en[key] === 'string' && en[key] !== '')
    check(`en 的 ${key} 真译过`, !CJK.test(en[key] ?? ''), en[key])
    // 占位符是运行时插值，翻丢了会显示半截话：两边必须同名、同数量。
    const zhSlots = (zh[key].match(/\{\w+\}/g) ?? []).sort().join(',')
    const enSlots = (en[key].match(/\{\w+\}/g) ?? []).sort().join(',')
    check(`${key} 的占位符两边一致`, zhSlots === enSlots, `${zhSlots} vs ${enSlots}`)
  }
  check('两份字典键集一致（缺译 / 多键都不放过）', Object.keys(zh).sort().join('\n') === Object.keys(en).sort().join('\n'))
  check('中文侧说清「段」「字数」「环境快照」这几个词',
    zh['transcript.prompt.sections'].includes('段') && zh['transcript.prompt.chars'].includes('字')
    && zh['transcript.injection.kind.envFacts'].includes('环境'))
  // 文案闸只认字面量 t('key')：拼出来的键会被判成死键，这里直接钉住卡片用到的键都在字典里，
  // 而且这两组键**一个不剩**都被卡片用着（写了不用 = 死键，用了没写 = 界面上显示键名）。
  const used = [...new Set([...cardSrc.matchAll(/t\('([^']+)'/g)].map((hit) => hit[1]))]
  check('卡片用到的每一个键都在 zh 字典里', used.every((key) => typeof zh[key] === 'string'), JSON.stringify(used.filter((key) => typeof zh[key] !== 'string')))
  check('这两组键与卡片用到的键完全一致（没有死键、也没有漏写的）',
    used.sort().join('\n') === keys.sort().join('\n'),
    `used=${JSON.stringify(used)} keys=${JSON.stringify(keys)}`)
}

console.log('[7] 反向钉：没有正文字段、没有中文字面量、没有碰契约')
{
  // 「不该出现」的断言先剥注释：模块头里引着「别画正文」「段清单」这类原话，不剥会自己打脸。
  const code = cardSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  check('展开体里没有正文字段（prompt.text / prompt.body 都没有）', !/prompt\.(?:text|body)(?![A-Za-z])/.test(code))
  check('没有去读 state 里的全文（不出现 state( / bodyMissing 之外的正文取法）',
    !code.includes("state('system-prompt')") && !code.includes('bodyMissing.text'))
  check('组件里没有中文字面量（文案只有字典一处）', !CJK.test(code))
  check('没有 import 契约（类型从条目上就地取，而不是另开一条依赖）',
    !/from '\.\.\/\.\.\/\.\.\/contract/.test(code) && !code.includes("@pneuma/runtime/contract"))
  check('没有把 data-tip 当唯一说明（气泡层已下线，说明走原生 title）',
    code.includes('title={open ?') && (code.match(/title=\{open \?/g) ?? []).length === 2)
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
