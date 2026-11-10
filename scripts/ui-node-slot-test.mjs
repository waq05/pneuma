/**
 * 会话区节点级槽位（差距清单 S1）的源码钉：三个 chain 子槽各自接在哪、兜底走哪条路。
 *
 * 本批只做**源码钉**，不在 Node 里 import TS 源跑注册表：`@dsc/ui` 的槽契约是
 * `declare module` 的编译期合并，运行期没有对应物，import 进来也验不到那条链。
 *
 * 五段：
 *   [1] 契约层：两个新槽常量、SlotMap 的两条 chain 声明、`TranscriptChildSlot` 的三槽联合、
 *       `renderSlot` 的第三个参数（`fallback?: ReactNode`）
 *   [2] 兜底不许写成 `??` 硬判：ChainOutlet 认 `fallback`；节点槽的调用把兜底放进第三参数
 *   [3] RowBody 的两层：`builtinRowBody` 画「长什么样」、`RowBody` 管「谁画」，
 *       以及与工具卡 `?? <ToolRow>` 那条旧兜底的分工不许混
 *   [4] 装配：两处槽登记都挂三条链、`TranscriptFlow` 的 props 放开到三槽、
 *       子代理流不再自造兜底 lambda
 *   [5] 思考正文别退回纯文本：`body` 可注入 + ThinkText 走 MarkdownView
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-node-slot-test.mjs
 *
 * @module dsc/scripts/ui-node-slot-test
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveUiHalf } from './_check-runner.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
// 界面半的新旧根由 resolveUiHalf 判：transcript 已搬进宿主包，旧根那条只剩兜底。
const UI = resolveUiHalf('transcript')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const shared = read(`${UI}/shared.ts`)
const render = read(`${UI}/render.tsx`)
const transcriptUi = read(`${UI}/ui.tsx`)
const subagent = read(`${UI}/subagent-flow.tsx`)
const thinkRow = read(`${UI}/rows/think-row.tsx`)
const thinkText = read(`${UI}/rows/think-text.tsx`)
// 壳与槽渲染层当契约读（两个文件本批只读，钉住它们的形状即可）。
const pluginApi = read('ui-shell/src/plugin-api.ts')
const slotsReact = read('src/packages/ui-slots/ui/slots-react.tsx')

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

/** 一个字符串在源码里出现几次（钉「两处都要改」时要用）。 */
const countOf = (text, needle) => text.split(needle).length - 1

/** 从标记处截一段到另一个标记处（找不到就返回空串）。 */
const between = (text, from, to) => {
  const at = text.indexOf(from)
  if (at === -1) return ''
  const end = text.indexOf(to, at + from.length)
  return text.slice(at, end === -1 ? text.length : end)
}

console.log('[1] 契约层：三个子槽的名字与形状')
{
  check(
    "shared.ts 有 TRANSCRIPT_NODE_SLOT = 'transcript.node'",
    /export const TRANSCRIPT_NODE_SLOT = 'transcript\.node'/.test(shared),
  )
  check(
    "shared.ts 有 TRANSCRIPT_REASONING_BODY_SLOT = 'transcript.reasoning.body'",
    /export const TRANSCRIPT_REASONING_BODY_SLOT = 'transcript\.reasoning\.body'/.test(shared),
  )
  check(
    "节点槽在 SlotMap 里是 kind: 'chain'",
    /\[TRANSCRIPT_NODE_SLOT\]: \{\s*kind: 'chain'/.test(shared),
  )
  check(
    "思考正文槽在 SlotMap 里是 kind: 'chain'",
    /\[TRANSCRIPT_REASONING_BODY_SLOT\]: \{\s*kind: 'chain'/.test(shared),
  )
  check(
    'TranscriptChildSlot 是三个槽名的联合（不是只写 toolview）',
    /type TranscriptChildSlot =\s*\n\s*\| typeof TOOLVIEW_SLOT\s*\n\s*\| typeof TRANSCRIPT_NODE_SLOT\s*\n\s*\| typeof TRANSCRIPT_REASONING_BODY_SLOT/.test(
      shared,
    ),
    between(shared, 'type TranscriptChildSlot', '\n\n'),
  )
  check(
    'ui-shell 的 renderSlot 有第三个参数 fallback?: ReactNode',
    /renderSlot: <K extends ChildKeys & SlotName>\(name: K, props\?: SlotOwnerOf<K>, fallback\?: ReactNode\) => ReactNode/.test(
      pluginApi,
    ),
  )
}

console.log('[2] 兜底走 ChainOutlet 的第三个参数，不许写成 ?? 硬判')
{
  check(
    'ChainOutlet 全体弃权时直接画 fallback（不套 .slot-entry）',
    slotsReact.includes('if (hit === null) return <>{fallback ?? null}</>'),
  )
  // 行体入口的写法变过两次，切片起点跟着改，判据不变：
  //   2026-11-10 止血：包一层带比较器的 memo，函数体改名 RowBodyBody；
  //   2026-11-10 彻底方案：比较器退役，行体回到普通导出函数 `RowBody`（座位壳与逐行订阅
  //   负责「不重画」，见 `seat-store.ts`）。
  const rowBody = between(render, 'export function RowBody(', '\n}\n')
  // 节点槽的调用本身：从函数名到右括号（props 对象里没有嵌套括号，第一个 `)` 就是调用结尾）。
  const nodeCall = (rowBody.match(/renderSlot\(TRANSCRIPT_NODE_SLOT,[\s\S]*?\)/) ?? [''])[0]
  check(
    '节点槽的调用把兜底放在第三个参数里（末尾是 }, builtin)）',
    /\}, builtin\)$/.test(nodeCall),
    nodeCall,
  )
  check('节点槽的调用里没有 `??` 硬判', nodeCall !== '' && !nodeCall.includes('??'), nodeCall)
  check(
    '全文件只有一处节点槽调用（别在别处又画一遍）',
    countOf(render, 'renderSlot(TRANSCRIPT_NODE_SLOT') === 1,
    String(countOf(render, 'renderSlot(TRANSCRIPT_NODE_SLOT')),
  )
}

console.log('[3] RowBody 的两层：内置行体 / 节点槽')
{
  check('render.tsx 有内置行体 builtinRowBody', /\nfunction builtinRowBody\(/.test(render))
  // 出口形状变过两次（memo 包装 → 普通导出函数），钉的仍是同一件事：行体是个导出的组件。
  check('render.tsx 有出口 RowBody', /\nexport function RowBody\(/.test(render))
  // 反向钉：行体不许再被 memo 包回去——那正是「靠比较器止血」的老写法，已经退役。
  check('RowBody 不再被 memo 包着（保证换到了座位壳与注册表）', !/export const RowBody = memo\(/.test(render))

  const rowBody = between(render, 'export function RowBody(', '\n}\n')
  const shortAt = rowBody.indexOf('renderSlot === undefined')
  const slotAt = rowBody.indexOf('renderSlot(TRANSCRIPT_NODE_SLOT')
  check(
    'RowBody 先判 renderSlot === undefined、再问槽（顺序不能反）',
    shortAt !== -1 && slotAt !== -1 && shortAt < slotAt,
    `${String(shortAt)} / ${String(slotAt)}`,
  )

  const builtin = between(render, 'function builtinRowBody(', 'export function RowBody(')
  check('thinking 分支接了思考正文槽', builtin.includes('TRANSCRIPT_REASONING_BODY_SLOT'))
  check('thinking 分支的兜底是 <ThinkText', builtin.includes('<ThinkText'))
  check(
    'thinking 分支的存档键仍是「会话:行的稳定身份」',
    between(builtin, "case 'thinking'", "case 'tool'").includes("const storeKey = `${sessionId ?? ''}:${row.stable}`"),
  )
  check(
    '工具分支保持旧兜底（renderSlot?.(TOOLVIEW_SLOT, …) ?? <ToolRow>）',
    builtin.includes('renderSlot?.(TOOLVIEW_SLOT, { entry, storeKey }) ?? <ToolRow'),
  )
  check('内置行体不引用节点槽自己（否则自我递归）', !builtin.includes('TRANSCRIPT_NODE_SLOT'))
}

console.log('[4] 装配：两处登记都挂三条链')
{
  const nodeCount = countOf(transcriptUi, 'TRANSCRIPT_NODE_SLOT')
  const bodyCount = countOf(transcriptUi, 'TRANSCRIPT_REASONING_BODY_SLOT')
  check('ui.tsx 里节点槽名出现 ≥ 2 次（两处 children 都声明）', nodeCount >= 2, String(nodeCount))
  check('ui.tsx 里思考正文槽名出现 ≥ 2 次（两处 children 都声明）', bodyCount >= 2, String(bodyCount))

  const blocks = transcriptUi
    .split('children: {')
    .slice(1)
    .map((part) => part.slice(0, part.indexOf('}')))
  check('ui.tsx 里正好两处 children 声明', blocks.length === 2, `共 ${String(blocks.length)} 处`)
  check(
    '两处 children 各含三条链（toolview / node / reasoning.body）',
    blocks.length === 2
      && blocks.every(
        (block) =>
          block.includes('[TOOLVIEW_SLOT]: \'chain\'')
          && block.includes('[TRANSCRIPT_NODE_SLOT]: \'chain\'')
          && block.includes('[TRANSCRIPT_REASONING_BODY_SLOT]: \'chain\''),
      ),
  )
  check(
    'TranscriptFlow 的 props 放开到三槽联合',
    transcriptUi.includes('SlotComponentProps<Record<never, never>, TranscriptChildSlot>'),
  )
  check('子代理流没有自造兜底空函数（() => null 这种）', !/\(\)\s*=>\s*null/.test(subagent))
  check(
    '子代理流把壳给的 renderSlot 原样交给 RowBody',
    subagent.includes('<RowBody row={row} renderSlot={props.renderSlot} />'),
  )
  check('子代理流不再自己拼一份 renderSlot 兜底 lambda', !subagent.includes('props.renderSlot ??'))
}

console.log('[5] 思考正文别退回纯文本')
{
  check('ThinkRow 有可选 body prop', /body\?:\s*ReactNode/.test(thinkRow))
  check(
    'ThinkRow 展开区优先画外面给的 body（body ?? 原件）',
    thinkRow.includes('{body ?? <div className="think-text">{entry.text}</div>}'),
    between(thinkRow, 'think-body-clip', '</div>\n        </div>'),
  )
  check('ThinkText 走 MarkdownView（不是 pre-wrap 直吐原文）', /<MarkdownView text=\{text\}/.test(thinkText))
  check('ThinkText 的根节点还叫 .think-text（样式与截图脚本认它）', thinkText.includes('className="think-text"'))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
