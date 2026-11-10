/**
 * bash 专用工具卡的确定性探针（差距清单 S4 的第一张专用卡）：
 * 「命令 + 输出 + 退出码」的终端块，而不是通用卡的参数表 + 结果尾巴。
 *
 * 为什么这里只能「钉源码 + 复刻纯函数」，不能直接 import 产品模块：
 * `ui-transcript/ui/tool-card/bash-view.tsx` 是 React 组件，除了取词器之外还 import
 * `@dsc/ui-primitives` 的 `formatDuration`；而探针的别名（`scripts/_i18n-alias.mjs`）
 * 只把 `@dsc/ui` 指到取词器，解析不了 `@dsc/ui-primitives`，Node 也载不动 TSX。
 * 于是分两层验：
 *   1. **源码钉**：读真源码，断言判据、类名、正则、样式令牌都在（防止有人改掉判据或
 *      偷偷换成别处的实现）；
 *   2. **逻辑复刻**：把 `bashOutcomeOf` / `bashCommandOf` 的那几行原样抄进本探针跑用例
 *      ——正则与分支是同一段文字，产品侧若改了，上面的源码钉会先红。
 *
 * 四小节：
 *   [1] 解析退出码（宿主只在非 0 时写「退出码 N」那一行，成功时没有这一行）
 *   [2] 命令解析（bash 的参数键是 `command`，模型给的是原始 JSON 字符串）
 *   [3] 装配（bash 分支只认 bash/shell/pwsh **且**参数里真有 command **且**这一页是对话页；
 *       三个类名都在；跑动中不写「退出码 0」；跑动中也不写「（无输出）」）
 *   [4] 样式（与 `.file-md pre` 同一档、限高自己滚、徽章按 data-exit 分三色、没有写死色值）
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-tool-bash-test.mjs
 *
 * @module dsc/scripts/ui-tool-bash-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

/** 界面半的落点：本仓已把 transcript 搬进宿主包（`src/packages/ui-transcript/ui`）。 */
const TOOL_CARD = 'src/packages/ui-transcript/ui/tool-card'
const BASH_VIEW = read(`${TOOL_CARD}/bash-view.tsx`)
/** 去掉注释的那一份：几条「源码里没有某句字面量」的断言只能看代码，注释里说明用不算。 */
const BASH_CODE = BASH_VIEW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const FACTORY = read(`${TOOL_CARD}/factory.tsx`)
const VIEWS_CSS = read('src/packages/ui-renderer/ui/styles/legacy/views.css')

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

// ── 复刻的两段纯函数（与 bash-view.tsx 里的实现逐字同形）───────────────────────
/** 与产品侧同一个正则：宿主写的那一行就是「退出码 3」。 */
const EXIT_LINE = /退出码 (\d+)/

/** 从结果文本里取退出码，并把 `退出码 N` 那一行从正文里摘掉。 */
const outcomeOf = (resultText) => {
  const text = typeof resultText === 'string' ? resultText : ''
  const lines = text.split('\n')
  const head = lines.slice(0, 2)
  for (let at = 0; at < head.length; at += 1) {
    const hit = EXIT_LINE.exec(head[at])
    if (hit === null) continue
    const rest = [...lines.slice(0, at), ...lines.slice(at + 1)]
    return { code: Number(hit[1]), body: rest.join('\n') }
  }
  return { code: null, body: text }
}

/** 从参数 JSON 里取命令；不是 bash 形态（没有 command 字段）就 null。 */
const commandOf = (argsText) => {
  if (typeof argsText !== 'string' || argsText === '') return null
  try {
    const parsed = JSON.parse(argsText)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const command = parsed['command']
    return typeof command === 'string' && command.trim() !== '' ? command : null
  } catch {
    return null
  }
}

/** 徽章走的哪一支（复刻 exitViewOf 的分支顺序，只判「哪一句文案」不判译文）。 */
const exitKeyOf = (status, code) => {
  if (status === 'running' || status === 'preparing') return 'transcript.tool.bashRunning'
  if (code !== null) return 'transcript.tool.bashExit'
  if (status === 'done') return 'transcript.tool.bashExit'
  if (status === 'rejected') return 'transcript.tool.bashRejected'
  if (status === 'aborted') return 'transcript.tool.bashAborted'
  return 'transcript.tool.bashFailed'
}

/**
 * 输出区那句话（复刻 BashBody 的空输出判定）：只有**跑完**（done）且正文为空才画
 * 「（无输出）」；还在跑就留空，不然等于断言一件还没发生的事。
 */
const outputOf = (status, body) =>
  status === 'done' && body.trim() === '' ? 'transcript.tool.bashNoOutput' : body

/** factory 源码压成一行：跨行断句的判据也读得出来（格式化不改变判据）。 */
const FACTORY_FLAT = FACTORY.replace(/\s+/g, ' ')

// ── [1] 解析退出码 ───────────────────────────────────────────────────────────
console.log('[1] 解析退出码：从结果文本前两行取「退出码 N」，并把那一行从正文摘掉')
{
  check(
    '源码里「退出码」的正则存在（/退出码 (\\d+)/）',
    BASH_VIEW.includes('/退出码 (\\d+)/'),
    'bash-view.tsx 里找不到 EXIT_LINE 的正则',
  )
  check(
    '只看前两行（原因行可能排在退出码之前）',
    BASH_VIEW.includes('lines.slice(0, 2)'),
    '没有 slice(0, 2) 这道「只看前两行」的限制',
  )

  const hit = outcomeOf('退出码 3\n输出')
  check('「退出码 3\\n输出」→ 3，正文去掉首行', hit.code === 3 && hit.body === '输出', JSON.stringify(hit))

  const none = outcomeOf('输出')
  check('「输出」→ 没有退出码（成功时宿主不写这一行）', none.code === null && none.body === '输出', JSON.stringify(none))

  const empty = outcomeOf('')
  check('「」→ 没有退出码，正文也是空', empty.code === null && empty.body === '', JSON.stringify(empty))

  const zero = outcomeOf('退出码 0\n')
  check('「退出码 0\\n」→ 0，正文是空串（连它那个换行一起摘）', zero.code === 0 && zero.body === '', JSON.stringify(zero))

  const reason = outcomeOf('[超时] 已终止\n退出码 124\n输出')
  check(
    '「[超时] 已终止\\n退出码 124\\n输出」→ 124，正文保留原因行',
    reason.code === 124 && reason.body === '[超时] 已终止\n输出',
    JSON.stringify(reason),
  )

  check(
    '正文不 trim（输出自己的缩进原样保留）',
    outcomeOf('退出码 1\n    缩进两格\n').body === '    缩进两格\n',
    JSON.stringify(outcomeOf('退出码 1\n    缩进两格\n').body),
  )
}

// ── [2] 命令解析 ─────────────────────────────────────────────────────────────
console.log('[2] 命令解析：从原始参数 JSON 里取 command 字段')
{
  check(
    '源码里有 JSON.parse 与 command 键',
    BASH_VIEW.includes('JSON.parse(argsText)') && BASH_VIEW.includes("['command']"),
    'bash-view.tsx 里找不到 JSON.parse 或 command 字段',
  )

  check('正常参数 → 拿到命令原文', commandOf('{"command":"echo hi"}') === 'echo hi')
  check('没有 command 字段 → null（不是 bash 形态）', commandOf('{"path":"a.txt"}') === null)
  check('坏 JSON（流式半截参数）→ null，不抛', commandOf('{"command":') === null)
  check(
    '多行命令原样保留（不折成一长条、不吞换行）',
    commandOf('{"command":"echo 一\\necho 二"}') === 'echo 一\necho 二',
  )
  check('空命令 → null（画不出东西就不开终端块）', commandOf('{"command":"   "}') === null)
}

// ── [3] 装配 ─────────────────────────────────────────────────────────────────
console.log('[3] 装配：factory 的 bash 分支只认三个名字且要求有 command；终端块三个部位都在')
{
  // 判据两条同时成立：名字在白名单里、参数里真取到 command。
  check(
    'factory 里有 SHELL_TOOL_NAMES 小组',
    /const SHELL_TOOL_NAMES = new Set\(\[/.test(FACTORY),
    'factory.tsx 里没有 SHELL_TOOL_NAMES',
  )
  for (const name of ['bash', 'shell', 'pwsh']) {
    check(`名字白名单里有 '${name}'`, new RegExp(`'${name}'`).test(FACTORY), `factory.tsx 里找不到 '${name}'`)
  }
  check(
    '判据是「名字命中」且「有 command」两条同时成立',
    /SHELL_TOOL_NAMES\.has\(call\.name\.toLowerCase\(\)\)\s*&&\s*bashCommand !== null/.test(FACTORY_FLAT),
    'factory.tsx 里的 bash 判据不是「名字命中 && bashCommand !== null」',
  )
  check(
    "轨迹页不走终端块（判据里有 variant === 'chat'）",
    /bashCommand !== null && variant === 'chat'/.test(FACTORY_FLAT),
    "factory.tsx 的终端块判据没有限制在对话页（variant === 'chat'）",
  )
  check(
    'bash 分支渲染 BashBody（不再走参数表 / 结果尾巴）',
    FACTORY.includes('<BashBody call={call} />'),
    'factory.tsx 里没有 <BashBody call={call} />',
  )
  // 三个部位：命令行 / 输出 / 徽章。类名以 className="…" 的形式出现在源码里。
  for (const cls of ['tc-bash-cmd', 'tc-bash-out', 'tc-bash-exit']) {
    check(`BashBody 有 .${cls}`, BASH_VIEW.includes(`"${cls}"`), `bash-view.tsx 里找不到 ${cls}`)
  }
  check('终端块根节点带 data-bash-state', BASH_VIEW.includes('data-bash-state={bashStateOf(call.status)}'))
  check(
    '跑动中写的是「运行中」而不是退出码（bashRunning 分支排在退出码分支之前）',
    BASH_CODE.indexOf('bashRunning') !== -1 &&
      BASH_CODE.indexOf('bashRunning') < BASH_CODE.indexOf('code !== null'),
    'bash-view.tsx 里没有把 bashRunning 判在退出码之前',
  )
  check(
    '跑动中不写「退出码 0」（代码里没有这句字面量）',
    !BASH_CODE.includes('退出码 0'),
    'bash-view.tsx 的代码里出现了字面量「退出码 0」',
  )
  check('运行中 → 运行中文案', exitKeyOf('running', null) === 'transcript.tool.bashRunning')
  check('运行中即使已经解析出 0 也不写退出码', exitKeyOf('running', 0) === 'transcript.tool.bashRunning')
  check('成功且解析不到退出码 → 0', exitKeyOf('done', null) === 'transcript.tool.bashExit')
  check('失败且解析不到退出码 → 失败文案', exitKeyOf('failed', null) === 'transcript.tool.bashFailed')
  check('被拒 → 已拒绝文案', exitKeyOf('rejected', null) === 'transcript.tool.bashRejected')

  // 「（无输出）」只在跑完之后才画：跑动中写这句等于断言一件还没发生的事。
  const emptyLine = BASH_CODE.split('\n').find((line) => line.includes('bashNoOutput')) ?? ''
  const runningLine = BASH_CODE.split('\n').find((line) => line.includes('bashRunning')) ?? ''
  check(
    '「（无输出）」那一行带 done 门槛（finished）',
    emptyLine.includes('finished') && emptyLine.includes('empty'),
    emptyLine.trim().slice(0, 120),
  )
  check(
    'running 那一支的源码里没有「无输出」那个键',
    runningLine !== '' && !runningLine.includes('bashNoOutput') && !emptyLine.includes('running'),
    `running 行：${runningLine.trim().slice(0, 90)}`,
  )
  check('还在跑且没有输出 → 输出区留空', outputOf('running', '') === '')
  check('跑完且没有输出 → 画「（无输出）」', outputOf('done', '') === 'transcript.tool.bashNoOutput')
  check('跑完且有输出 → 原样输出（不覆盖成占位）', outputOf('done', '自检输出') === '自检输出')
}

// ── [4] 样式 ─────────────────────────────────────────────────────────────────
console.log('[4] 样式：与代码块同一档、输出限高自滚、徽章分三色、无写死色值')
{
  /** 取一条规则的花括号体（`选择器 {` 之后到配对的 `}`）。 */
  const ruleOf = (selector) => {
    const at = VIEWS_CSS.indexOf(`${selector} {`)
    if (at === -1) return ''
    const from = VIEWS_CSS.indexOf('{', at)
    let depth = 0
    for (let i = from; i < VIEWS_CSS.length; i += 1) {
      if (VIEWS_CSS[i] === '{') depth += 1
      else if (VIEWS_CSS[i] === '}') {
        depth -= 1
        if (depth === 0) return VIEWS_CSS.slice(from + 1, i)
      }
    }
    return ''
  }

  // 整组 `.tc-bash*` 规则的文本：从这一节的注释起，到**下一节**注释为止（不外溢到别的规则，
  // 否则「没有写死色值」那条会扫到别人家的规则上）。
  const sectionAt = VIEWS_CSS.indexOf('/* ── bash 工具卡的终端块')
  const nextAt = sectionAt === -1 ? -1 : VIEWS_CSS.indexOf('\n/* ── ', sectionAt)
  const section = sectionAt === -1 ? '' : VIEWS_CSS.slice(sectionAt, nextAt === -1 ? undefined : nextAt)

  check('views.css 有 .tc-bash 一组规则', sectionAt !== -1 && section.includes('.tc-bash-cmd'))
  const bashRoot = ruleOf('.tc-bash')
  check('外观与 `.file-md pre` 同一档（四级底 + 三级描边 + 块圆角 + 等宽 + 12px）',
    bashRoot.includes('var(--dsc-fill-quaternary)') &&
      bashRoot.includes('1px solid var(--dsc-stroke-3)') &&
      bashRoot.includes('var(--dsc-r-block)') &&
      bashRoot.includes('var(--dsc-font-mono)') &&
      bashRoot.includes('var(--dsc-fs-caption)'),
    bashRoot.replace(/\s+/g, ' ').slice(0, 160),
  )

  const out = ruleOf('.tc-bash-out')
  check('输出限高 min(240px, 30vh)', out.includes('max-height: min(240px, 30vh)'), out.replace(/\s+/g, ' ').slice(0, 160))
  check('输出自己滚（overflow: auto）', out.includes('overflow: auto'), out.replace(/\s+/g, ' ').slice(0, 160))
  check('输出保留原样换行（white-space: pre-wrap）', out.includes('white-space: pre-wrap'))

  const cmd = ruleOf('.tc-bash-cmd code')
  check('命令按原样折行（white-space: pre-wrap），不压成一长条', cmd.includes('white-space: pre-wrap'))

  const exitPill = ruleOf('.tc-bash-exit')
  check('徽章是小药丸（--dsc-r-pill）', exitPill.includes('var(--dsc-r-pill)'), exitPill.replace(/\s+/g, ' ').slice(0, 120))
  check('徽章字号走 --dsc-fs-tool', exitPill.includes('var(--dsc-fs-tool)'))
  check('徽章三色：ok 绿', ruleOf(".tc-bash-exit[data-exit='ok']").includes('var(--dsc-green)'))
  check('徽章三色：bad 红', ruleOf(".tc-bash-exit[data-exit='bad']").includes('var(--dsc-red)'))
  check('徽章三色：none 三级文字色', ruleOf(".tc-bash-exit[data-exit='none']").includes('var(--dsc-text-tertiary)'))

  const hex = section.match(/#[0-9a-fA-F]{3,8}\b/g)
  check('这一段里没有写死的 # 色值', hex === null, hex === null ? undefined : hex.join(' / '))
}

const total = passed + failures
console.log('')
console.log(failures === 0 ? `全部通过（${String(total)} 项）` : `${String(failures)} 项失败 / ${String(total)} 项`)
process.exit(failures === 0 ? 0 : 1)
