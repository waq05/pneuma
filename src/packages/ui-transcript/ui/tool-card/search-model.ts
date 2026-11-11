/**
 * 检索工具卡的纯逻辑（差距清单 S4 第二批）：`grep` / `glob` 的命中数与命中清单。
 *
 * 为什么把这两个名字合成一张卡：它们在本仓是同一件事的两种问法——`glob` 按文件名找、
 * `grep` 按内容找（`packages/tools-default/search-tools.ts:338` / `:380`），头行的动词也分别
 * 是「查找文件」「搜索文件内容」，收起行都只该说「命中了多少」。两张卡会长得一模一样，
 * 所以一个模块、两个分支。
 *
 * 数据从哪来：宿主**没有**结构化命中（结果就是一段文本），所以这里解析那段文本：
 *  - `glob` 一行一个相对路径（`search-tools.ts:376`），末尾可能补一条「只显示前 N 条」；
 *  - `grep` 一行一处命中，形状是 `相对路径:行号: 内容`（`search-tools.ts:447`，内容已被宿主
 *    `trim` 并截到 200 字），末尾可能补「只显示前 N 条」与「已跳过 K 个受保护文件」两条；
 *  - 没有命中时宿主回一行 `（无匹配：pattern）`（`search-tools.ts:375` / `:471`），**这不是空卡**：
 *    本模块把它识别成 `empty`，调用方画一句「没有匹配」并把尾注（比如跳过了几个受保护文件）
 *    一起摊出来——静默给一张空卡会让读者以为工具没跑。
 *
 * 路径的基准：结果里的路径相对**检索根**（`path` 参数），不是相对会话工作目录
 * （`search-tools.ts:312` 的 `displayPath(root, file)`）。所以解析结果里不带绝对路径，
 * 由渲染层按 `root` 拼接（`search-view.tsx` 用 `absPathOf`）。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card/search-model
 */

/** 这张卡认的两档检索。 */
export type SearchKind = 'files' | 'content'

/** 工具名 → 检索档。本机注册的就是这两个（`tools-default` 的 glob / grep）。 */
const SEARCH_TOOL_KINDS: Readonly<Record<string, SearchKind>> = { glob: 'files', grep: 'content' }

/** 一次检索的参数视图。 */
export interface SearchCall {
  /** 按文件名找（glob）还是按内容找（grep）。 */
  kind: SearchKind
  /** 要匹配的模式原文（`glob` 的模式、`grep` 的正则/纯文本）。 */
  pattern: string
  /** 检索根（参数里的 `path` 原文）；没给就是会话工作目录（null）。 */
  root: string | null
}

/** 一处命中：行号（glob 的文件命中没有行号）+ 内容。 */
export interface SearchHit {
  line: number | null
  text: string
}

/** 一个文件下的命中。 */
export interface SearchFileGroup {
  /** 相对检索根的路径原文。 */
  path: string
  /** 这个文件里的命中；glob 的文件命中是空数组（命中的就是这个文件本身）。 */
  hits: SearchHit[]
}

/** 一次检索结果解析出来的样子。 */
export interface SearchResult {
  kind: SearchKind
  /** 命中按文件分组（grep）；glob 是「每个文件一组、组内没有命中行」。 */
  files: SearchFileGroup[]
  /** 命中总数：grep 是命中行数，glob 是文件数。 */
  total: number
  /** 是不是「没有匹配」那一次（宿主明写了 `（无匹配：…）`）。 */
  empty: boolean
  /** 宿主补的尾注原文（截断说明、跳过的受保护文件），按出现顺序。 */
  notes: string[]
}

/** 一处内容命中的一行：`相对路径:行号: 内容`。路径可能含 `/`，内容可能含 `:`，所以两头都放宽。 */
const HIT_RE = /^(.*?):(\d+):\s?([\s\S]*)$/

/** 宿主补的尾注：都以全角括号开头。 */
const NOTE_RE = /^（/

/** 「没有匹配」那一行（`search-tools.ts:375` / `:471`）。 */
const NO_MATCH_RE = /^（无匹配：/

/**
 * 参数是不是一张检索卡：**名字是 glob / grep** 且**参数里真有非空 `pattern`**。
 *
 * 两条同时成立才算，理由与终端块、read 卡一致（`factory.tsx` 的 `isTerminalCall`）：
 * 只看名字会给「名字对、参数键不对」的调用画一张空卡；只看参数会把碰巧带 `pattern` 的
 * 别家工具（`lsp`、`tool_search` 也用它）拉进来。
 *
 * `path` 是可选字段（两个工具都默认搜当前目录），给了空串就当没给。
 *
 * @param name 工具名
 * @param argsText 模型产出的原始 arguments JSON 字符串
 * @returns 参数视图；不是检索形态时 null（回落通用卡）
 */
export function searchCallOf(name: string, argsText: string): SearchCall | null {
  const kind = SEARCH_TOOL_KINDS[name]
  if (kind === undefined) return null
  if (typeof argsText !== 'string' || argsText === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(argsText) as unknown
  } catch {
    // 半截 JSON：取不到模式就当不是这一形态。
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const args = parsed as Record<string, unknown>
  const pattern = args['pattern']
  if (typeof pattern !== 'string' || pattern.trim() === '') return null
  const root = args['path']
  return {
    kind,
    pattern,
    root: typeof root === 'string' && root.trim() !== '' ? root.trim() : null,
  }
}

/**
 * 把检索结果原文解析成「文件 + 命中 + 尾注」。
 *
 * 空结果（还在跑、或宿主什么都没回）返回 null：调用方据此不画内容区，绝不画一张空卡。
 *
 * @param kind 检索档（决定一行是「一个文件」还是「一处命中」）
 * @param resultText 工具结果原文
 * @returns 解析结果；结果为空时 null
 */
export function searchResultOf(kind: SearchKind, resultText: string | undefined): SearchResult | null {
  if (typeof resultText !== 'string' || resultText.trim() === '') return null
  const raw = resultText.replace(/\r\n?/g, '\n').split('\n')
  let empty = false
  const notes: string[] = []
  const groups = new Map<string, SearchFileGroup>()
  for (const line of raw) {
    // 宿主已经对 grep 的命中行做过 trim（`search-tools.ts:447`），glob 的路径本身不带空白；
    // 这里统一 trim 一遍，只为让尾注判定不被行尾空白打扰。
    const text = line.trim()
    if (text === '') continue
    if (NO_MATCH_RE.test(text)) {
      empty = true
      notes.push(text)
      continue
    }
    if (NOTE_RE.test(text)) {
      // `glob` 的路径也可能以全角括号开头？不可能——那是宿主补话的专用前缀。
      notes.push(text)
      continue
    }
    if (kind === 'files') {
      if (!groups.has(text)) groups.set(text, { path: text, hits: [] })
      continue
    }
    const hit = HIT_RE.exec(text)
    if (hit === null) {
      // 认不出的一行（宿主将来改了形状、或内容自己跨了行）：当尾注留着，别把这句话吞掉。
      notes.push(text)
      continue
    }
    appendHit(groups, hit[1] ?? '', { line: Number(hit[2]), text: hit[3] ?? '' })
  }
  const files = [...groups.values()]
  let total = 0
  for (const file of files) total += kind === 'files' ? 1 : file.hits.length
  return { kind, files, total, empty, notes }
}

/** 把一处命中挂到它的文件组上（保持宿主给的顺序：先出现的文件在前）。 */
function appendHit(groups: Map<string, SearchFileGroup>, path: string, hit: SearchHit): void {
  const existing = groups.get(path)
  if (existing === undefined) {
    groups.set(path, { path, hits: [hit] })
    return
  }
  existing.hits.push(hit)
}
