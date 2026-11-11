/**
 * `read` 工具卡的纯逻辑（差距清单 S4 第二批）：这次读了哪个文件的哪一段，结果里是哪几行。
 *
 * 为什么要一张专用卡：通用卡把一次读取摆成「参数表 + 结果首行」，读者得自己从参数里读
 * `offset` / `limit` 再心算区间，而结果正文里每一行前面还顶着一个行号制表符。这里把两件事
 * 分开算清：**头行说区间**（`第 40–79 行`，见 `read-view.tsx` 的 `ReadRange`），**展开体给
 * 内容预览**（行号一列 + 原文一列，限高自滚）。
 *
 * 行号从哪来——两个来源，**结果的优先**：
 *   1. 参数（`core/tools/fs-tools.ts:90-91`：`offset` 起始行 1-based、`limit` 行数）。
 *      调用还在跑时只有它；没有 `offset` 就是第 1 行起，没有 `limit` 就不知道止于哪一行。
 *   2. 结果正文（`fs-tools.ts:144` 的 `${file}\n${start + index}\t${shown}`）。落地后这份
 *      是实际读到的行，比参数更准：宿主有 16000 字符与 2000 行的硬顶（`fs-tools.ts:20-24`），
 *      模型要 5000 行时真正回来的可能只有 40 行。
 *
 * 结果正文里还有宿主补的尾注（`fs-tools.ts:142-143` 的 `…（共 N 行，可用 offset/limit 续读）`），
 * 它带着**文件总行数**——所以「第 40–79 行」这句话能补一个「共 300 行」的悬停说明。
 *
 * 认不出形状就返回 null（工具报错的散文、半截结果）：调用方据此回落原文，绝不把一段报错
 * 当成「读到了 0 行」画出来。中文标记只能用**正则字面量**匹配：宿主写进结果里的就是中文，
 * 而 `locale` 闸门（`scripts/ui-locale-test.mjs`）管的是字符串字面量里的界面文案——这里
 * 匹配的是宿主产物，不是要翻译的界面文字（与 `bash-view.tsx` 的 `/退出码 (\d+)/` 同一条口径）。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card/read-model
 */

/**
 * 走这张卡的工具名。
 *
 * 只有 `read`：本机注册的就是它（`core/tools/fs-tools.ts:80`，`tools-default` 插件装配）。
 * `read_file` 是别家（MCP 系）工具的常见名字，本批**不认**——认了它，头行的可点路径却出不来
 * （`fileTargetOf` 只认 read / write / edit），那会变成半张卡；不认它就照旧走通用卡，不丢信息。
 */
const READ_TOOL_NAME = 'read'

/** 一张 read 卡要用到的参数：路径 + 行区间。 */
export interface ReadCall {
  /** 参数里的文件路径原文（可能相对会话工作目录）。 */
  path: string
  /** 起始行（1-based）；模型没给就是 1。 */
  offset: number
  /** 要读的行数；模型没给就是 null（宿主按自己的预算截）。 */
  limit: number | null
}

/** 结果里的一行：行号 + 原文（原文一个字符都不动，缩进原样）。 */
export interface ReadLine {
  number: number
  text: string
}

/** 一次读取结果解析出来的样子。 */
export interface ReadPreview {
  /** 结果首行回显的文件路径（宿主给的是绝对路径）。 */
  path: string
  /** 正文行（空文件是空数组）。 */
  lines: ReadLine[]
  /** 文件总行数（从尾注「共 N 行」解析）；宿主没写就是 null。 */
  total: number | null
  /** 宿主补的尾注原文（截断说明、还有更多），按出现顺序。 */
  notes: string[]
}

/** 一次读取在界面上说的是哪一段。 */
export interface ReadSpan {
  /** 起始行（1-based）。 */
  from: number
  /** 结束行；只说得清起点时是 null。 */
  to: number | null
  /** 文件总行数；不知道就是 null。 */
  total: number | null
}

/** 结果正文里的一行：行号 + 制表符 + 原文（宿主就是这么写的，制表符后的空白也算内容）。 */
const LINE_RE = /^(\d+)\t([\s\S]*)$/

/** 宿主补的尾注：都以 `…（` 开头。 */
const NOTE_RE = /^…（/

/** 尾注里的总行数：`…（共 300 行，可用 offset/limit 续读）`。 */
const TOTAL_RE = /共 (\d+) 行/

/** 一整行就是一个绝对路径（空文件的读取结果就只有这一行）。 */
const ABSOLUTE_RE = /^(?:\/|[A-Za-z]:[\\/])/

/**
 * 参数是不是一张 read 卡：**名字对得上**且**参数里真有 `path`**。
 *
 * 与终端块同一条取舍（`factory.tsx` 的 `isTerminalCall`）：只看名字会把「名字叫 read、参数键
 * 却是别的」的调用画成一张空壳；只看参数又会把碰巧带 `path` 的别家工具（write / edit）
 * 拉进来。两条同时成立才算。
 *
 * 行号字段是宽松的：`offset` / `limit` 给了不是正整数的值（0、负数、小数、字符串）就当没给——
 * 那是模型产出的原始 JSON，不该让一张卡因为一个坏字段整张不画。
 *
 * @param name 工具名（宿主原样交来的，可能大小写不一）
 * @param argsText 模型产出的原始 arguments JSON 字符串
 * @returns 参数视图；不是 read 形态时 null（回落通用卡）
 */
export function readCallOf(name: string, argsText: string): ReadCall | null {
  if (name !== READ_TOOL_NAME) return null
  if (typeof argsText !== 'string' || argsText === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(argsText) as unknown
  } catch {
    // 参数还在流式吐出来的半截 JSON：取不到路径就当不是这一形态。
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const args = parsed as Record<string, unknown>
  const raw = args['path']
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const offset = positiveLine(args['offset'])
  const limit = positiveLine(args['limit'])
  return { path: raw.trim(), offset: offset ?? 1, limit }
}

/**
 * 正整数行号 / 行数；其余一律 null。
 *
 * 为什么 `0` 不算：宿主自己的口径是「1-based，默认 1」（`fs-tools.ts:90`），0 行在语义上
 * 不存在；把它当成第 1 行会让头行说错话。
 */
function positiveLine(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null
}

/**
 * 把 read 的结果原文解析成「路径 + 行 + 尾注」。
 *
 * 形状（`core/tools/fs-tools.ts:144`）是三段：
 *
 * ```
 * D:\work\sample.txt
 * 3	第三行的原文
 * 4	第四行的原文
 * …（共 300 行，可用 offset/limit 续读）
 * ```
 *
 * 判据是**整份形状**，不是首行像不像路径：正文每一行都必须以「数字 + 制表符」开头、其余行
 * 必须是 `…（` 尾注。任一行对不上就整份返回 null——工具报错时结果是散文（「读不到…」），
 * 把它当成「读了 0 行」画出来比不画更坏。空文件例外：宿主只回一行路径，那是合法的
 * （此时 `lines` 是空数组，调用方画「（空文件）」）。
 *
 * @param resultText 工具结果原文（可能是 undefined：还在跑）
 * @returns 解析结果；不是这份形状时 null
 */
export function readPreviewOf(resultText: string | undefined): ReadPreview | null {
  if (typeof resultText !== 'string' || resultText.trim() === '') return null
  const all = resultText.replace(/\r\n?/g, '\n').split('\n')
  // 末尾那个空行是模板串收尾留下的，不是内容行。
  while (all.length > 0 && (all[all.length - 1] ?? '') === '') all.pop()
  const head = (all[0] ?? '').trim()
  if (head === '') return null
  const lines: ReadLine[] = []
  const notes: string[] = []
  for (const line of all.slice(1)) {
    const body = LINE_RE.exec(line)
    if (body !== null) {
      lines.push({ number: Number(body[1]), text: body[2] ?? '' })
      continue
    }
    if (NOTE_RE.test(line)) {
      notes.push(line.trim())
      continue
    }
    // 有一行既不是正文也不是尾注：这份结果不是读取回显（报错散文 / 半截结果）。
    return null
  }
  if (lines.length === 0 && notes.length === 0 && !ABSOLUTE_RE.test(head)) return null
  let total: number | null = null
  for (const note of notes) {
    const hit = TOTAL_RE.exec(note)
    if (hit !== null) {
      total = Number(hit[1])
      break
    }
  }
  return { path: head, lines, total, notes }
}

/**
 * 头行说的那一段：**结果优先、参数兜底**。
 *
 * 为什么不是「一直用参数」：宿主有字符与行数硬顶（`fs-tools.ts:20-24`），模型要 5000 行时
 * 真正回来的可能只有 40 行；头行若照参数说「第 1–5000 行」，读者点开只看到 40 行，会觉得
 * 卡片在骗人。结果里每一行都带着真实行号，落地后它就是唯一准的那份。
 *
 * @param call 参数视图（至少给出了起点）
 * @param preview 结果预览（还没落地时是 null）
 */
export function readSpanOf(call: ReadCall, preview: ReadPreview | null): ReadSpan {
  if (preview !== null && preview.lines.length > 0) {
    const first = preview.lines[0]
    const last = preview.lines[preview.lines.length - 1]
    if (first !== undefined && last !== undefined) {
      return { from: first.number, to: last.number, total: preview.total }
    }
  }
  const from = call.offset
  return {
    from,
    to: call.limit === null ? null : from + call.limit - 1,
    total: preview?.total ?? null,
  }
}
