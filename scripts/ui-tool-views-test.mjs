/**
 * read / search / todo 三张专用工具卡的探针（差距清单 S4 的第二批）。
 *
 * 这一批换了三张卡：`read`（读了哪个文件的哪一段 + 内容预览）、`glob` / `grep`（命中数 +
 * 命中清单、没有命中单独画）、`todo_write`（四态勾选清单）。三张都只在**对话页**生效，
 * 轨迹页继续摊原始参数与结果原文。
 *
 * 两层验法，与 `ui-tool-bash-test.mjs` 同一条路子，但这一批更结实一点：
 *   1. **真逻辑**：三个 `*-model.ts` 是纯函数、不 import 任何东西（没有 React、没有取词器、
 *      没有 `@dsc/ui-primitives`），Node 的类型擦除可以直接载进来跑真代码——不是复刻；
 *   2. **源码钉**：渲染体与装配在 `.tsx` 里，Node 载不动 JSX，所以读源码断言判据、类名、
 *      位置关系（三张卡必须在轨迹页那一支**之前**、轨迹页那一支里一个卡体都不许出现）。
 *
 * 八小节：
 *   [1] read：判据（名字 + `path` 缺一不可）、行区间（结果优先、参数兜底）、内容预览的形状
 *   [2] search：判据（名字 + 非空 `pattern`）、命中解析（grep 分文件带行号 / glob 一行一个文件）、
 *       没有匹配与宿主尾注
 *   [3] todo：判据（名字 + `todos` 数组）、四态、子任务层级、结果优先（merge 模式）、清空
 *   [4] 装配：三张卡各自的判据都带 `variant === 'chat'`；三个卡体都挂在展开体里；
 *       轨迹页那一支里没有任何卡体（反向钉）
 *   [5] 样式：三处限高内滚、`.tool-card` 上不许有 overflow: hidden、这一段没有写死色值
 *   [6] 本地化：新键两份字典都在、英文里没有汉字、代码里的中文只活在正则字面量里
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-tool-views-test.mjs
 * （`check:ui` 自动收录，`scripts/check-ui.mjs` 会给每条探针加同一个 `--import`）
 *
 * @module dsc/scripts/ui-tool-views-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

/** 界面半的落点：transcript 在宿主包里（`src/packages/ui-transcript/ui`）。 */
const TOOL_CARD = 'src/packages/ui-transcript/ui/tool-card'
const READ_MODEL = `${TOOL_CARD}/read-model.ts`
const SEARCH_MODEL = `${TOOL_CARD}/search-model.ts`
const TODO_MODEL = `${TOOL_CARD}/todo-model.ts`
const READ_VIEW = `${TOOL_CARD}/read-view.tsx`
const SEARCH_VIEW = `${TOOL_CARD}/search-view.tsx`
const TODO_VIEW = `${TOOL_CARD}/todo-view.tsx`
const PATH_BUTTON = `${TOOL_CARD}/path-button.tsx`
const FILE_PATH = `${TOOL_CARD}/file-path.ts`
const FACTORY = `${TOOL_CARD}/factory.tsx`
const VIEWS_CSS = 'src/packages/ui-renderer/ui/styles/legacy/views.css'
const ZH = 'src/packages/ui-transcript/locale/ui.zh.json'
const EN = 'src/packages/ui-transcript/locale/ui.en.json'

const factory = read(FACTORY)
const views = read(VIEWS_CSS)
const zh = JSON.parse(read(ZH))
const en = JSON.parse(read(EN))

let passed = 0
let failures = 0
/** 记一条。`detail` 只在失败时打出来，省得整页都是数值。 */
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}

/** 源码压成一行：跨行断句的判据也读得出来（格式化不改变判据）。 */
const flat = (src) => src.replace(/\s+/g, ' ')

/** 剥注释（`/* *\/` 与 `//`）：几条「源码里没有某句」的断言只能看代码。 */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** 取 CSS 一条规则的花括号体（第一条匹配的那条）。 */
const ruleOf = (selector) => {
  const at = views.indexOf(`${selector} {`)
  if (at === -1) return ''
  const from = views.indexOf('{', at)
  let depth = 0
  for (let i = from; i < views.length; i += 1) {
    if (views[i] === '{') depth += 1
    else if (views[i] === '}') {
      depth -= 1
      if (depth === 0) return views.slice(from + 1, i)
    }
  }
  return ''
}

/** 字典里 `t()` 用到的键：只认本批六个文件里的调用。 */
const usedKeysOf = (files) => {
  const keys = new Set()
  for (const rel of files) {
    for (const hit of read(rel).matchAll(/\bt\('([^']+)'/g)) keys.add(hit[1])
  }
  return keys
}

/**
 * 一行代码里还剩多少汉字（剥掉注释与正则字面量之后）。
 *
 * 为什么这么剥：本仓的界面文案必须走字典（`scripts/ui-locale-test.mjs` 钉着），唯一允许
 * 写汉字的地方是**正则字面量**——它匹配的是宿主写进结果里的中文标记（「退出码 3」「（无匹配：
 * …」「清单已更新」），那些字不是界面文案、也不能翻译（`bash-view.tsx` 的 `/退出码 (\d+)/`
 * 就是先例）。所以判据是「剥完注释与正则之后一个汉字都不剩」。
 */
const linesWithChinese = (rel) => {
  const hits = []
  // 先把块注释整段抹成空格（保留换行数，行号才对得上），再逐行剥行注释与正则字面量。
  const source = read(rel).replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  source.split('\n').forEach((line, index) => {
    const stripped = line
      .replace(/\/\/.*$/, '')
      .replace(/\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\])+\/[a-z]*/g, '')
    if (/[\u4e00-\u9fff]/.test(stripped)) hits.push(`${String(index + 1)}: ${line.trim().slice(0, 60)}`)
  })
  return hits
}

// ── [1] read ─────────────────────────────────────────────────────────────────
const { readCallOf, readPreviewOf, readSpanOf } = await import(new URL(`../${READ_MODEL}`, import.meta.url).href)
console.log('[1] read：判据（名字 + path）、行区间（结果优先 / 参数兜底）、内容预览')

{
  const args = JSON.stringify({ path: 'sample.txt', offset: 3, limit: 5 })
  const call = readCallOf('read', args)
  check('read + path → 一张 read 卡', call !== null && call.path === 'sample.txt')
  check('offset / limit 原样进参数视图', call?.offset === 3 && call?.limit === 5, call)
  check('没给 offset 就从第 1 行起', readCallOf('read', '{"path":"a.txt"}')?.offset === 1)
  check('没给 limit 就是 null（不猜「读到多少行」）', readCallOf('read', '{"path":"a.txt"}')?.limit === null)
  check('名字不是 read → 不是这张卡', readCallOf('grep', args) === null)
  check('名字是 read 但没有 path → 不是这张卡（只有名字不够）', readCallOf('read', '{"file_path":"a.txt"}') === null)
  check('path 是空白 → 不是这张卡', readCallOf('read', '{"path":"   "}') === null)
  check('半截 JSON（流式参数）→ 不抛，判成不是这张卡', readCallOf('read', '{"path":') === null)
  check('参数是数组 → 不是这张卡', readCallOf('read', '[]') === null)
  check('坏行号（offset: 0）当没给，退回第 1 行', readCallOf('read', '{"path":"a","offset":0}')?.offset === 1)
  check('坏行数（limit: 2.5）当没给', readCallOf('read', '{"path":"a","limit":2.5}')?.limit === null)
  check('字符串行号不算行号', readCallOf('read', '{"path":"a","offset":"3"}')?.offset === 1)

  const result = [
    'D:\\work\\sample.txt',
    '3\t第三行的原文',
    '4\t第四行的原文',
    '5\t第五行的原文',
    '7\t第七行的原文',
    '…（共 300 行，可用 offset/limit 续读）',
  ].join('\n')
  const preview = readPreviewOf(result)
  check('结果首行是文件路径', preview?.path === 'D:\\work\\sample.txt', preview)
  check('正文按行拆开（4 行）', preview?.lines.length === 4, preview?.lines.length)
  check('行号原样带出来（3 / 4 / 5 / 7）', preview?.lines.map((line) => line.number).join(',') === '3,4,5,7')
  check('正文原文不动（缩进也不 trim）', readPreviewOf('D:\\a.txt\n1\t    缩进两格')?.lines[0]?.text === '    缩进两格')
  check('尾注里的总行数解析出来（共 300 行）', preview?.total === 300, preview?.total)
  check('尾注原文留着（给展开体作说明）', preview?.notes.length === 1 && preview.notes[0].startsWith('…（'))
  check('工具报错的散文 → 不是预览（不能画成「读了 0 行」）', readPreviewOf('读不到文件：D:\\work\\x.txt') === null)
  check('空结果 → null', readPreviewOf('') === null && readPreviewOf(undefined) === null)
  check('空文件（只回一行绝对路径）→ 预览存在但 0 行', (() => {
    const empty = readPreviewOf('D:\\work\\empty.txt')
    return empty !== null && empty.lines.length === 0
  })())
  check('CRLF 换行也能解析', readPreviewOf('D:\\a.txt\r\n1\t一\r\n2\t二')?.lines.length === 2)
  check('结果末尾的空行不算正文', readPreviewOf('D:\\a.txt\n1\t一\n\n')?.lines.length === 1)
  check('正文里有一行认不出（既不是行号也不是尾注）→ 整份不认', readPreviewOf('D:\\a.txt\n随便一句') === null)

  const spanFromResult = readSpanOf(readCallOf('read', args), preview)
  check('区间取结果里的首尾行（3–7），不是参数推算的 3–7 巧合', spanFromResult.from === 3 && spanFromResult.to === 7)
  check('文件总行数跟着区间走', spanFromResult.total === 300)
  check('还没落地时按参数算区间（3 → 3+5-1=7）', (() => {
    const span = readSpanOf(readCallOf('read', args), null)
    return span.from === 3 && span.to === 7 && span.total === null
  })())
  check('没有 limit 时只说得出起点', (() => {
    const span = readSpanOf(readCallOf('read', '{"path":"a","offset":40}'), null)
    return span.from === 40 && span.to === null
  })())
  check('只读一行时区间退化成一个数', (() => {
    const one = readPreviewOf('D:\\a.txt\n42\t唯一一行')
    const span = readSpanOf(readCallOf('read', '{"path":"a"}'), one)
    return span.from === 42 && span.to === 42
  })())
  check('结果落地后以真实行数为准（宿主有硬顶，参数可能说大了）', (() => {
    const wide = readPreviewOf('D:\\a.txt\n1\t一\n2\t二')
    const span = readSpanOf(readCallOf('read', '{"path":"a","offset":1,"limit":5000}'), wide)
    return span.from === 1 && span.to === 2
  })())

  // 源码钉：判据与渲染体的形状。
  check('参数名用的是本仓的 `path`（不是 dsh 的 file_path）', read(READ_MODEL).includes("const raw = args['path']"))
  check('模型里没有 file_path（认了它头行就没有可点路径）', !code(read(READ_MODEL)).includes("'file_path'"))
  check('read-view 里区间有三种说法（区间 / 起点 / 单行）', read(READ_VIEW).includes('tc-range') && read(READ_VIEW).includes("t('transcript.tool.readRange'") && read(READ_VIEW).includes("t('transcript.tool.readFrom'") && read(READ_VIEW).includes("t('transcript.tool.readLine'"))
  check('展开体是行号 + 原文两列', read(READ_VIEW).includes('tc-read-line') && read(READ_VIEW).includes('tc-read-no') && read(READ_VIEW).includes('tc-read-text'))
  check('展开体有内容时不会铺原始参数（参数信息已在头行）', !read(READ_VIEW).includes('prettyJson'))
}

// ── [2] search ───────────────────────────────────────────────────────────────
const { searchCallOf, searchResultOf } = await import(new URL(`../${SEARCH_MODEL}`, import.meta.url).href)
console.log('[2] search：判据（名字 + 非空 pattern）、命中解析、没有匹配不是空卡')

{
  const grep = searchCallOf('grep', '{"pattern":"needle"}')
  check('grep + pattern → 内容检索那一档', grep !== null && grep.kind === 'content' && grep.pattern === 'needle')
  check('没给 path 时检索根是 null（= 会话工作目录）', grep?.root === null)
  const glob = searchCallOf('glob', '{"pattern":"**/*.ts","path":"src"}')
  check('glob + pattern → 文件名检索那一档', glob !== null && glob.kind === 'files')
  check('检索根原样带出来', glob?.root === 'src')
  check('空 pattern → 不是这张卡', searchCallOf('grep', '{"pattern":""}') === null)
  check('空白 pattern → 不是这张卡', searchCallOf('glob', '{"pattern":"   "}') === null)
  check('名字不是 glob / grep → 不是这张卡', searchCallOf('search', '{"pattern":"x"}') === null && searchCallOf('lsp', '{"pattern":"x"}') === null)
  check('半截 JSON → 不抛', searchCallOf('grep', '{"pattern":') === null)
  check('没有 pattern 字段 → 不是这张卡', searchCallOf('grep', '{"path":"src"}') === null)
  check('path 是空白就当没给', searchCallOf('grep', '{"pattern":"x","path":"  "}')?.root === null)

  const grepResult = [
    'src/a.ts:12: const needle = 1',
    'src/a.ts:40: needle + 1',
    'src/b.md:3: needle 在这里',
  ].join('\n')
  const parsed = searchResultOf('content', grepResult)
  check('grep 命中按文件分组（2 个文件）', parsed?.files.length === 2, parsed?.files.map((file) => file.path))
  check('命中总数是命中行数（3 处）', parsed?.total === 3, parsed?.total)
  check('同一文件的两处命中归到一组', parsed?.files[0]?.hits.length === 2)
  check('命中带行号', parsed?.files[0]?.hits[0]?.line === 12 && parsed?.files[0]?.hits[1]?.line === 40)
  check('命中带内容原文', parsed?.files[1]?.hits[0]?.text === 'needle 在这里')
  check('Windows 盘符路径里的冒号不被当行号分隔', (() => {
    const one = searchResultOf('content', 'D:/work/a.ts:7: 内容')
    return one?.files[0]?.path === 'D:/work/a.ts' && one.files[0].hits[0].line === 7
  })())
  check('内容里再出现冒号也不打断解析', (() => {
    const one = searchResultOf('content', 'a.ts:1: key: value: needle')
    return one?.files[0]?.hits[0]?.text === 'key: value: needle'
  })())
  check('CRLF 也能解析', searchResultOf('content', 'a.ts:1: x\r\nb.ts:2: y')?.files.length === 2)

  const globResult = ['src/a.ts', 'src/b.ts', 'docs/c.md'].join('\n')
  const files = searchResultOf('files', globResult)
  check('glob 一行一个文件（3 个）', files?.files.length === 3 && files.total === 3)
  check('glob 的文件下面没有命中行', files?.files.every((file) => file.hits.length === 0) === true)

  const none = searchResultOf('content', '（无匹配：needle）')
  check('「无匹配」识别成 empty（不是空卡）', none?.empty === true && none.total === 0)
  check('「无匹配」那一行进尾注（要摊给读者看）', none?.notes[0] === '（无匹配：needle）')
  const skipped = searchResultOf('content', '（无匹配：needle）\n（已跳过 2 个受保护文件：.env、id_rsa）')
  check('被跳过的受保护文件那句尾注留着', skipped?.notes.length === 2 && skipped.notes[1].includes('已跳过'))
  const truncated = searchResultOf('files', 'src/a.ts\n（只显示前 100 条，还有更多；把 pattern 或 path 收窄一点再看全部）')
  check('截断尾注留着', truncated?.notes.length === 1 && truncated.files.length === 1)
  check('空结果 → null（还在跑，不画空卡）', searchResultOf('content', '') === null && searchResultOf('files', undefined) === null)
  check('有命中就没标记 empty', parsed?.empty === false)

  check('模型里两个工具名成对出现（glob / grep）', read(SEARCH_MODEL).includes("glob: 'files'") && read(SEARCH_MODEL).includes("grep: 'content'"))
  check('没有匹配有单独一句（不是空卡）', read(SEARCH_VIEW).includes('tc-search-none') && read(SEARCH_VIEW).includes("t('transcript.tool.searchNone'"))
  check('头行读数按两档分别说（命中处数 / 文件数）', read(SEARCH_VIEW).includes("t('transcript.tool.searchHits'") && read(SEARCH_VIEW).includes("t('transcript.tool.searchFiles'"))
  check('命中文件路径是可点的（同一个 PathButton 外壳）', read(SEARCH_VIEW).includes('<PathButton'))
  check('路径按钮的外壳只有一份（factory 与检索卡共用）', read(PATH_BUTTON).includes("className=\"tc-path tc-path-btn\"") && !factory.includes('className="tc-path tc-path-btn"'))
  check('路径换算收在一处（factory 与检索卡共用 file-path）', read(FILE_PATH).includes('export function absPathOf') && factory.includes("from './file-path'") && read(SEARCH_VIEW).includes("from './file-path'"))
}

// ── [3] todo ─────────────────────────────────────────────────────────────────
const { todoCallOf, todoListOf } = await import(new URL(`../${TODO_MODEL}`, import.meta.url).href)
console.log('[3] todo：判据（名字 + todos 数组）、四态、子任务层级、结果优先、清空')

{
  const args = JSON.stringify({
    todos: [
      { id: 'a1', content: '写单测', status: 'completed' },
      { id: 'b2', content: '跑构建', status: 'in_progress' },
      { id: 'c3', content: '收尾', status: 'pending', parent: 'b2' },
    ],
  })
  const call = todoCallOf('todo_write', args)
  check('todo_write + todos 数组 → 一张待办卡', call !== null && call.items.length === 3)
  check('默认不是 merge', call?.merge === false)
  check('merge: true 认出来', todoCallOf('todo_write', '{"todos":[],"merge":true}')?.merge === true)
  check('清空（todos: []）也是这张卡：不是「没这张卡」', todoCallOf('todo_write', '{"todos":[]}')?.items.length === 0)
  check('名字不是 todo_write → 不是这张卡', todoCallOf('todo', args) === null)
  check('没有 todos 字段 → 不是这张卡', todoCallOf('todo_write', '{"merge":true}') === null)
  check('todos 不是数组 → 不是这张卡', todoCallOf('todo_write', '{"todos":"x"}') === null)
  check('半截 JSON → 不抛', todoCallOf('todo_write', '{"todos":[') === null)
  check('不认识的 status 按 pending', todoCallOf('todo_write', '{"todos":[{"content":"x","status":"?"}]}')?.items[0]?.status === 'pending')
  check('没有正文的条目跳过（宿主也会丢）', todoCallOf('todo_write', '{"todos":[{"status":"pending"},{"content":"y"}]}')?.items.length === 1)
  check('子任务按 parent 链算层级（1 层）', call?.items[2]?.depth === 1)
  check('父 id 不在本次参数里时按顶层算（merge 常态）', todoCallOf('todo_write', '{"todos":[{"content":"x","parent":"zzz"}]}')?.items[0]?.depth === 0)

  const result = [
    '清单已更新（1/3 完成）',
    '[x] a1 写单测',
    '[>] b2 跑构建',
    '  [ ] c3 收尾',
    '进度 1/3',
  ].join('\n')
  // merge 模式下参数里只有一条，结果回显整表：结果优先。
  const merged = todoListOf(todoCallOf('todo_write', '{"todos":[{"id":"a1","content":"写单测","status":"completed"}],"merge":true}'), result)
  check('结果优先：merge 模式下也画得出整表（3 条）', merged.items.length === 3, merged.items.length)
  check('四态符号解析：[x] 完成 / [>] 进行中 / [ ] 未做', merged.items[0].status === 'completed' && merged.items[1].status === 'in_progress' && merged.items[2].status === 'pending')
  check('结果里的缩进算出子任务层级', merged.items[2].depth === 1)
  check('id 与正文分开（不是把整行当一个字符串）', merged.items[1].id === 'b2' && merged.items[1].content === '跑构建')
  check('进度 1/3（完成数 / 有效总数）', merged.done === 1 && merged.total === 3)
  check('结果里的取消态认得出', todoListOf(todoCallOf('todo_write', '{"todos":[]}'), '[~] z9 不做了\n进度 0/0').items[0].status === 'cancelled')
  check('取消的不进分母', (() => {
    const list = todoListOf(todoCallOf('todo_write', '{"todos":[]}'), '[x] a 完成\n[~] b 取消\n进度 1/1')
    return list.total === 1 && list.done === 1
  })())
  const notes = todoListOf(todoCallOf('todo_write', '{"todos":[]}'), '清单已更新（1/1 完成）\n[x] a 完成\n进度 1/1\n注意：只保留前 64 条')
  check('宿主的「注意：」提示留着', notes.notes.length === 1 && notes.notes[0].includes('只保留前 64 条'))
  const cleared = todoListOf(todoCallOf('todo_write', '{"todos":[]}'), '清单已清空。')
  check('清空回执 → cleared 为真', cleared.cleared === true && cleared.items.length === 0)
  check('还没落地时退回参数（不猜「已清空」，那是结果说的）', (() => {
    const before = todoListOf(todoCallOf('todo_write', '{"todos":[]}'), '')
    return before.cleared === false && before.items.length === 0
  })())
  check('结果认不出（报错散文）→ 退回参数，不清空卡', (() => {
    const failed = todoListOf(todoCallOf('todo_write', args), 'todos 必须是数组')
    return failed.items.length === 3 && failed.cleared === false
  })())
  check('没有结果时进度按参数算', (() => {
    const draft = todoListOf(todoCallOf('todo_write', args), '')
    return draft.done === 1 && draft.total === 3
  })())

  check('四态符号表与宿主那份同形（[ ] [>] [x] [~]）', read(TODO_MODEL).includes("' ': 'pending'") && read(TODO_MODEL).includes("'>': 'in_progress'") && read(TODO_MODEL).includes("x: 'completed'") && read(TODO_MODEL).includes("'~': 'cancelled'"))
  check('渲染体里勾选框是画的、不是 input（点不动的 checkbox 更气人）', read(TODO_VIEW).includes('tc-todo-box') && !code(read(TODO_VIEW)).includes('<input'))
  check('勾选框按四态给 data-status', read(TODO_VIEW).includes('data-status={item.status}'))
  check('子任务缩进走 CSS 变量（层级数不写死）', read(TODO_VIEW).includes("'--tc-todo-depth'") && ruleOf('.tc-todo-item').includes('var(--tc-todo-depth'))
  check('数据面没改：只读参数与结果两处', !read(TODO_MODEL).includes('fetch') && !read(TODO_MODEL).includes('session'))
}

// ── [4] 装配 ─────────────────────────────────────────────────────────────────
console.log('[4] 装配：三张卡的判据都带「对话页」、三个卡体都挂在展开体里、轨迹页一支不碰')

{
  const factoryCode = code(factory)
  const factoryFlat = flat(factoryCode)

  check('factory 解析了三份参数（read / search / todo）', factoryCode.includes('readCallOf(call.name, call.argsText)') && factoryCode.includes('searchCallOf(call.name, call.argsText)') && factoryCode.includes('todoCallOf(call.name, call.argsText)'))
  check('read 卡判据 = 有参数 且 对话页', /const readCard = readCall !== null && variant === 'chat'/.test(factoryFlat))
  check('search 卡判据 = 有参数 且 对话页', /const searchCard = searchCall !== null && variant === 'chat'/.test(factoryFlat))
  check('todo 卡判据 = 有参数 且 对话页', /const todoCard = todoCall !== null && variant === 'chat'/.test(factoryFlat))
  check('终端块的判据没被动过（名字 + command + 对话页）', /SHELL_TOOL_NAMES\.has\(call\.name\.toLowerCase\(\)\) && bashCommand !== null && variant === 'chat'/.test(factoryFlat))
  check('三个卡体都在（ReadBody / SearchBody / TodoBody）', factoryCode.includes('<ReadBody call={call}') && factoryCode.includes('<SearchBody call={call}') && factoryCode.includes('<TodoBody list={todoList} />'))
  check('三枚头行读数都在（ReadRange / SearchCount / TodoProgress）', factoryCode.includes('<ReadRange call={readCall}') && factoryCode.includes('<SearchCount result={searchResult} />') && factoryCode.includes('<TodoProgress list={todoList} />'))

  // 位置关系：三张卡一体现在**轨迹页那一支之前**（先命中专用卡，再判轨迹页）。
  const traceAt = factoryCode.indexOf("variant === 'trace' ?")
  check('轨迹页那一支还在', traceAt !== -1)
  for (const [label, marker] of [['read', '<ReadBody'], ['search', '<SearchBody'], ['todo', '<TodoBody']]) {
    const at = factoryCode.indexOf(marker)
    check(`${label} 卡体在轨迹页那一支之前（顺序：终端块 → 三张卡 → 轨迹页 → 通用卡）`, at !== -1 && traceAt !== -1 && at < traceAt, `${marker}@${at} / trace@${traceAt}`)
  }
  // 反向钉：轨迹页那一支里一个卡体都不许出现。
  const traceTail = traceAt === -1 ? '' : factoryCode.slice(traceAt)
  const chatFallbackAt = traceTail.indexOf('}) : (')
  const traceBranch = chatFallbackAt === -1 ? traceTail.slice(0, 6000) : traceTail.slice(0, chatFallbackAt)
  check('轨迹页那一支里没有 read 卡体', !traceBranch.includes('<ReadBody') && !traceBranch.includes('tc-read'))
  check('轨迹页那一支里没有检索卡体', !traceBranch.includes('<SearchBody') && !traceBranch.includes('tc-search'))
  check('轨迹页那一支里没有待办卡体', !traceBranch.includes('<TodoBody') && !traceBranch.includes('tc-todo'))
  check('轨迹页仍摊原始参数（prettyJson）', traceBranch.includes('<div className="args">{prettyJson(call.argsText)}</div>'))
  check("轨迹页仍摊结果原文（标签「结果」+ {call.resultText}）", traceBranch.includes("t('transcript.tool.result')") && traceBranch.includes('{call.resultText}'))

  // 三个卡体都在展开体里（bodyOpen 之后）：收起态只留头行。
  const bodyOpenAt = factoryCode.indexOf('{bodyOpen ?')
  check('展开体那一层还在', bodyOpenAt !== -1)
  check('三个卡体都在展开体里（收起态不铺内容）', ['<ReadBody', '<SearchBody', '<TodoBody'].every((marker) => factoryCode.indexOf(marker) > bodyOpenAt))
  check('头行读数都在可点展开的那一段里（摘要之后、行尾读数之前）', (() => {
    const previewAt = factoryCode.indexOf('<Preview ')
    const rangeAt = factoryCode.indexOf('<ReadRange')
    const tailAt = factoryCode.indexOf('{tail !== null')
    return previewAt !== -1 && rangeAt !== -1 && tailAt !== -1 && previewAt < rangeAt && rangeAt < tailAt
  })())
  check('三张卡不再画「+N 行」（头行已有读数，同一件事不说两遍）', /tail !== null && tail\.hidden > 0 && !readCard && !searchCard && !todoCard/.test(factoryFlat))
  check('对话页通用卡那一支照旧（输入 / 输出两段）', factoryCode.includes("t('transcript.tool.input')") && factoryCode.includes("t('transcript.tool.output')"))
  check('头行的路径按钮仍挡冒泡（点路径不折卡）', /onClick=\{\(event\) => \{ event\.stopPropagation\(\)/.test(factoryFlat))
}

// ── [5] 样式 ─────────────────────────────────────────────────────────────────
console.log('[5] 样式：三处限高内滚、.tool-card 上没有 overflow: hidden、这一段没有写死色值')

{
  check('read 正文限高内滚', (() => {
    const body = ruleOf('.tc-read-lines')
    return body.includes('max-height: min(320px, 40vh)') && body.includes('overflow: auto')
  })(), ruleOf('.tc-read-lines').replace(/\s+/g, ' ').slice(0, 120))
  check('检索命中清单限高内滚', (() => {
    const body = ruleOf('.tc-search-files')
    return body.includes('max-height: min(320px, 40vh)') && body.includes('overflow: auto')
  })())
  check('待办清单限高内滚', (() => {
    const body = ruleOf('.tc-todo-list')
    return body.includes('max-height: min(320px, 40vh)') && body.includes('overflow: auto')
  })())
  check('三张卡与终端块同一档外观（四级底 + 三级描边 + 块圆角）', ['.tc-read', '.tc-search', '.tc-todo'].every((selector) => {
    const body = ruleOf(selector)
    return body.includes('var(--dsc-fill-quaternary)') && body.includes('1px solid var(--dsc-stroke-3)') && body.includes('var(--dsc-r-block)')
  }))
  check('代码类两处用等宽（read 预览 / 检索命中）；待办是散文，走正文字号', (() => {
    const mono = ruleOf('.tc-read').includes('var(--dsc-font-mono)') && ruleOf('.tc-search').includes('var(--dsc-font-mono)')
    return mono && ruleOf('.tc-todo').includes('var(--dsc-fs-ui)')
  })())
  // 卡片外壳不许裁剪：那会切断展开体里 sticky 的行头（ui-tool-row-flat-test 第 [1] 节）。
  const card = ruleOf('.tool-card')
  check('.tool-card 规则体存在', card !== '')
  check('.tool-card 上没有 overflow: hidden', !/overflow\s*:\s*hidden/.test(card), card.replace(/\s+/g, ' ').slice(0, 120))
  check('限高滚动放在卡体内部的子元素上（.tc-read-lines / .tc-search-files / .tc-todo-list）', !/overflow\s*:\s*hidden/.test(ruleOf('.tc-read-lines')))

  check('行号列用等宽数字（对齐）', ruleOf('.tc-read-no').includes('font-variant-numeric: tabular-nums'))
  check('行号列不可选（复制正文不会带走行号）', ruleOf('.tc-read-no').includes('user-select: none'))
  check('检索命中行也用同一套行号网格', ruleOf('.tc-search-line').includes('font-variant-numeric: tabular-nums') && ruleOf('.tc-search-line').includes('user-select: none'))
  check('头行读数走三级文字色（不跟摘要抢）', ruleOf('.tc-range,\n.tc-hit-count,\n.tc-todo-progress,\n.tc-todo-active').includes('var(--dsc-text-tertiary)') || /\.tc-range,[\s\S]{0,200}?color: var\(--dsc-text-tertiary\)/.test(views))
  check('进行中的待办加重', /\.tc-todo-item\[data-status='in_progress'\] \.tc-todo-text \{[^}]*color: var\(--dsc-text-primary\)/.test(views))
  check('取消的待办划掉并退色', (() => {
    const body = /\.tc-todo-item\[data-status='cancelled'\] \.tc-todo-text \{([^}]*)\}/.exec(views)?.[1] ?? ''
    return body.includes('line-through') && body.includes('var(--dsc-text-quaternary)')
  })())
  check('完成态是绿勾（令牌，不是写死色值）', /\.tc-todo-item\[data-status='completed'\] \.tc-todo-box \{[^}]*var\(--dsc-green\)/.test(views))
  check('勾选框是 12px 小方块 + 胶囊圆角', ruleOf('.tc-todo-box').includes('width: 12px') && ruleOf('.tc-todo-box').includes('var(--dsc-r-pill)'))
  // 行尾那颗「在轨迹中查看」药丸是绝对定位、压在行尾读数上的；读数不跟着淡出就会被盖住半截。
  // 这条规则住在 styles.css（不是 views.css），与 `.status` / `.tc-more` 的待遇必须一致。
  const stylesCss = read('src/packages/ui-renderer/ui/styles/styles.css')
  check('行尾读数在悬停时淡出（药丸不压字）', ['.tc-range', '.tc-hit-count', '.tc-todo-progress'].every((cls) => new RegExp(`\\.tool-head:hover ${cls.replace('.', '\\.')}`).test(stylesCss)))

  // 新写的那一段里不许出现写死的 #hex（与终端块那一段同一条规矩）。这一段从三枚读数的
  // 小节头起到「工具卡的将做的改动」之前（那一段是这一批之前就有的）。
  const sectionAt = views.indexOf('/* ── 头行的三枚读数')
  const nextAt = sectionAt === -1 ? -1 : views.indexOf('/* ── 工具卡的「将做的改动」', sectionAt)
  const section = sectionAt === -1 ? '' : views.slice(sectionAt, nextAt === -1 ? undefined : nextAt)
  check('新样式那一段找得到', section !== '' && section.includes('.tc-search') && section.includes('.tc-todo'))
  const hex = section.match(/#[0-9a-fA-F]{3,8}\b/g)
  check('新样式那一段里没有写死的 # 色值', hex === null, hex === null ? undefined : hex.join(' / '))
  check('新样式只用 --dsc-* 令牌（没有裸 px 字号）', !/font-size:\s*\d+px/.test(section))
}

// ── [6] 本地化 ───────────────────────────────────────────────────────────────
console.log('[6] 本地化：新键两份字典都在、英文里没有汉字、代码里的中文只活在正则字面量里')

{
  const viewsFiles = [READ_VIEW, SEARCH_VIEW, TODO_VIEW, PATH_BUTTON]
  const used = usedKeysOf(viewsFiles)
  const added = [...used].filter((key) => key.startsWith('transcript.tool.'))
  check('新视图用到的键都从字典取（这一批 ≥ 14 个键）', added.length >= 14, `${String(added.length)} 个：${added.slice(0, 6).join('、')}`)
  for (const key of added) {
    check(`字典里有 ${key}（中文）`, typeof zh[key] === 'string' && zh[key].trim() !== '')
    check(`字典里有 ${key}（英文）`, typeof en[key] === 'string' && en[key].trim() !== '')
  }
  const cjkInEn = added.filter((key) => /[\u4e00-\u9fff]/.test(en[key] ?? ''))
  check('英文译本里没有汉字', cjkInEn.length === 0, cjkInEn.join('、'))
  check('中英字典键集一致', Object.keys(zh).sort().join('|') === Object.keys(en).sort().join('|'))
  const unused = added.filter((key) => !Object.hasOwn(zh, key))
  check('没有写错键名（用到的键全在字典里）', unused.length === 0, unused.join('、'))

  for (const rel of [READ_MODEL, SEARCH_MODEL, TODO_MODEL, FILE_PATH, READ_VIEW, SEARCH_VIEW, TODO_VIEW, PATH_BUTTON]) {
    const hits = linesWithChinese(rel)
    check(`${rel.split('/').pop()} 里没有硬编码中文（注释与正则字面量除外）`, hits.length === 0, hits.slice(0, 3).join(' / '))
  }
  // 正则里那些中文是宿主写进结果的标记，不是界面文案：钉一条「它们还在」，防止有人把它们
  // 一并删掉（删了解析就静默失效：卡片会全部回落原文）。
  check('read 的分页尾注解析规则还在（/共 (\\d+) 行/）', read(READ_MODEL).includes('/共 (\\d+) 行/'))
  check('检索的「无匹配」解析规则还在', read(SEARCH_MODEL).includes('/^（无匹配：/'))
  check('待办四态标记的解析规则还在', read(TODO_MODEL).includes('/^(\\s*)\\[([ x>~])\\]'))
}

const total = passed + failures
console.log('')
console.log(failures === 0 ? `全部通过（${String(total)} 项）` : `${String(failures)} 项失败 / ${String(total)} 项`)
process.exit(failures === 0 ? 0 : 1)
