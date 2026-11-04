/**
 * ops 结果的渲染：把 worker 交回来的结构（Outcome）压成模型能读的几段中文。
 *
 * 为什么不照抄 dsh-ops 的 render.js：那套文案是英文的 `[Notice: …]` 风格，跟 numa 自己
 * 的工具卡（`行号\t正文`）不一致；而且它把写类回执、结果引用、分页这些我们没搬的东西
 * 也一起画了。这里只画七个只读工具真正交出来的那几种形状。
 *
 * 两条必须说清楚的事：
 *   1. **显示不全不等于没读到**：`complete` / `truncated` / `nextOffset` / `pending`
 *      要原样告诉模型，否则它会以为文件就这么点内容；
 *   2. **失败也要能照做**：`error.nextAction` 是 worker 给的处理建议，漏掉它模型只能瞎猜。
 *
 * @module dsc/core/ops/render
 */

/** 一次调用的结果；字段名与 dsh-ops 的 Outcome 一致（没声明的字段按 unknown 读）。 */
export type OpsOutcome = Record<string, unknown>

/** 这些状态等于「这次没做成」，其余按成功渲染。 */
const FAILED_STATUS = new Set(['error', 'rejected', 'conflict', 'unknown', 'failed'])

/** 对象判定：数组不算。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 取一个非负整数，认不出给 undefined。 */
function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** 把任意值写成一行可读文本：字符串原样，其余 JSON 化。 */
function show(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return '未提供'
  return JSON.stringify(value) ?? String(value)
}

/** 正文里可能出现的控制字符：换行留原样（逐行渲染），其余转义。 */
function oneLine(value: unknown): string {
  return String(value ?? '').replace(/[\r\t\x00-\x1f\x7f]/g, (char) => JSON.stringify(char).slice(1, -1))
}

/** 时间戳写成 `2026-11-03 16:20`；0 或认不出给一句人话。 */
function formatTime(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '未知'
  const at = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** 失败结果：一行结论 + 下一步 + 原因。 */
export function renderFailure(outcome: OpsOutcome): string {
  const error = isRecord(outcome.error) ? outcome.error : {}
  const code = typeof error.code === 'string' ? error.code : 'UNKNOWN_ERROR'
  const effect = typeof error.effectState === 'string' ? error.effectState : 'unknown'
  const lines = [`失败：${code}（这次改动：${effect === 'none' ? '没有发生' : effect}）`]
  if (typeof error.nextAction === 'string' && error.nextAction !== '') lines.push(`下一步：${oneLine(error.nextAction)}`)
  if (typeof error.message === 'string' && error.message !== '') lines.push(`原因：${oneLine(error.message)}`)
  return lines.join('\n')
}

/** 结果是不是失败（状态在失败集合里，或带了 error 对象）。 */
export function isFailure(outcome: OpsOutcome): boolean {
  if (isRecord(outcome.error)) return true
  return FAILED_STATUS.has(String(outcome.status))
}

/** 结果里有没有可显示的数据：文档类失败时前几页/前几段照样可用。 */
export function hasItems(outcome: OpsOutcome): boolean {
  return Array.isArray(outcome.items) && outcome.items.length > 0
}

/** 一行「还有多少没显示」的尾巴：有 nextOffset 就给续读写法。 */
function moreLine(shown: number, total: number | undefined, nextOffset: number | undefined, unit = '行'): string | undefined {
  const tail: string[] = []
  if (total !== undefined && total > shown) tail.push(`共 ${String(total)} ${unit}，这里显示 ${String(shown)} ${unit}`)
  if (nextOffset !== undefined) tail.push(`续读用 offset=${String(nextOffset)}`)
  return tail.length === 0 ? undefined : `（${tail.join('；')}）`
}

/** 续读提示（hex 视图与没有「总行数」概念的场合用）。 */
function nextHint(nextOffset: number | undefined): string | undefined {
  return nextOffset === undefined ? undefined : `（续读用 offset=${String(nextOffset)}）`
}

/** 结果不完整时补一句：分页、截断、status=partial 都算。 */
function incompleteLine(outcome: OpsOutcome): string | undefined {
  if (outcome.complete === true && outcome.truncated !== true && outcome.status !== 'partial') return undefined
  return '（这次结果不完整：只给了其中一部分，别当成全部）'
}

/** 逐行列出 `行号\t正文`；hex 视图用偏移量。 */
function lines(items: readonly Record<string, unknown>[], hex: boolean): string[] {
  return items.map((item) => {
    const head = hex ? (item.offset ?? '?') : (item.line ?? '?')
    return `${String(head)}\t${oneLine(item.text)}`
  })
}

/** 单个文件的读取结果（inspect_local_file 与 read_files 的每一项都用它）。 */
function fileBlock(path: string, outcome: OpsOutcome, hex: boolean): string[] {
  const items = Array.isArray(outcome.items) ? outcome.items.filter(isRecord) : []
  const numbers = items.map((item) => asCount(item.line)).filter((line): line is number => line !== undefined)
  const total = asCount(outcome.lineCount) ?? asCount(outcome.total)
  const bytes = asCount(outcome.bytes)
  const head = hex
    ? `文件：${oneLine(path)}（hex 视图，偏移 ${String(items[0]?.offset ?? 0)} 起${bytes === undefined ? '' : `，共 ${String(bytes)} 字节`}）`
    : `文件：${oneLine(path)}（${numbers.length > 0 ? `第 ${String(numbers[0])}-${String(numbers[numbers.length - 1])} 行` : '这个范围没有行'}${total === undefined ? '' : `，共 ${String(total)} 行`}）`
  const output = [head, ...lines(items, hex)]
  if (items.length === 0) output.push(outcome.lineCount === 0 ? '（空文件）' : '（这个范围没有内容）')
  const more = hex ? nextHint(asCount(outcome.nextOffset)) : moreLine(items.length, total, asCount(outcome.nextOffset))
  if (more !== undefined) output.push(more)
  const incomplete = incompleteLine(outcome)
  if (incomplete !== undefined) output.push(incomplete)
  return output
}

/** `inspect_local_file`：单文件、可按 hex 视图。 */
export function renderInspect(outcome: OpsOutcome, args: Record<string, unknown>): string {
  const path = typeof outcome.path === 'string' ? outcome.path : String(args.path ?? '（路径未知）')
  const output = fileBlock(path, outcome, args.view === 'hex')
  if (typeof outcome.revision === 'string') output.push(`（修订：${outcome.revision.slice(0, 16)}…）`)
  return output.join('\n')
}

/** `read_files`：一次读多段，每段一个文件块。 */
export function renderReadFiles(outcome: OpsOutcome): string {
  const files = Array.isArray(outcome.items) ? outcome.items.filter(isRecord) : []
  const blocks: string[] = []
  for (const file of files) {
    const path = typeof file.path === 'string' ? file.path : '（路径未知）'
    if (isFailure(file)) {
      blocks.push([`文件：${oneLine(path)}`, renderFailure(file)].join('\n'))
      continue
    }
    blocks.push(fileBlock(path, file, false).join('\n'))
  }
  if (blocks.length === 0) return '这次没有交回任何文件内容'
  const pending = asCount(outcome.pending)
  if (pending !== undefined && pending > 0) blocks.push(`（还有 ${String(pending)} 段没读完：把 files 从第 ${String(files.length + 1)} 段接着传）`)
  return blocks.join('\n\n')
}

/** `stat`：一行一个事实。 */
export function renderStat(outcome: OpsOutcome, args: Record<string, unknown>): string {
  const path = typeof outcome.path === 'string' ? outcome.path : String(args.path ?? '（路径未知）')
  const exists = outcome.exists === true
  const lines = [`路径：${oneLine(path)}`, `存在：${exists ? '是' : '否'}`]
  if (exists) {
    const size = asCount(outcome.bytes)
    const lineCount = asCount(outcome.lineCount)
    if (size !== undefined) lines.push(`大小：${String(size)} 字节`)
    if (lineCount !== undefined) lines.push(`行数：${String(lineCount)}`)
    if (typeof outcome.revision === 'string') lines.push(`修订：${outcome.revision}`)
    if (outcome.modifiedMs !== undefined) lines.push(`修改时间：${formatTime(outcome.modifiedMs)}`)
    if (outcome.readonly !== undefined) lines.push(`只读：${outcome.readonly === true ? '是' : '否'}`)
  }
  return lines.join('\n')
}

/** `diff`：内容与目标文件当前内容比，按行给 +/-。 */
export function renderDiff(outcome: OpsOutcome, args: Record<string, unknown>): string {
  const path = typeof outcome.path === 'string' ? outcome.path : String(args.path ?? '（路径未知）')
  const hunk = isRecord(outcome.hunk) ? outcome.hunk : undefined
  const stat: string[] = []
  const matched = asCount(outcome.matched)
  if (matched !== undefined) stat.push(`共 ${String(matched)} 条差异记录`)
  if (hunk !== undefined) {
    const added = asCount(hunk.added)
    const removed = asCount(hunk.removed)
    const start = asCount(hunk.startLine)
    const marks = [added === undefined ? '' : `+${String(added)}`, removed === undefined ? '' : `-${String(removed)}`].filter(Boolean)
    if (marks.length > 0) stat.push(`${start === undefined ? '' : `从第 ${String(start)} 行起，`}${marks.join(' ')}`)
  }
  const lines = [`差异：${oneLine(path)}` + (stat.length > 0 ? `（${stat.join('；')}）` : '')]
  const items = Array.isArray(outcome.items) ? outcome.items.filter(isRecord) : []
  for (const item of items) {
    const sign = item.kind === 'remove' ? '-' : item.kind === 'add' ? '+' : '?'
    lines.push(`${sign}${String(item.line ?? '?')}\t${oneLine(String(item.text ?? '').replace(/\r?\n$/, ''))}`)
  }
  if (items.length === 0) lines.push('（没有差异）')
  const more = moreLine(items.length, asCount(outcome.total), asCount(outcome.nextOffset), '条')
  if (more !== undefined) lines.push(more)
  const incomplete = incompleteLine(outcome)
  if (incomplete !== undefined) lines.push(incomplete)
  return lines.join('\n')
}

/** `read_table`：列名 + 逐行单元格（单元格用 JSON 写，多行与逗号不会歧义）。 */
export function renderTable(outcome: OpsOutcome, args: Record<string, unknown>): string {
  const path = typeof outcome.path === 'string' ? outcome.path : String(args.path ?? '（路径未知）')
  const columns = Array.isArray(outcome.columns) ? outcome.columns.map((cell) => oneLine(cell)) : []
  const rows = Array.isArray(outcome.items) ? outcome.items.filter(isRecord) : []
  const head = `表格：${oneLine(path)}（${typeof outcome.format === 'string' ? outcome.format : 'csv'}`
    + (columns.length > 0 ? `，${String(columns.length)} 列：${columns.join(' / ')}` : '')
    + (`，共 ${String(asCount(outcome.rowCount) ?? rows.length)} 行）`)
  const lines = [head]
  for (const row of rows) {
    const cells = Array.isArray(row.cells) ? row.cells : []
    lines.push(`${String(row.row ?? '?')}\t${JSON.stringify(cells)}`)
  }
  if (rows.length === 0) lines.push('（这个范围没有记录）')
  const more = moreLine(rows.length, asCount(outcome.total), asCount(outcome.nextOffset), '行')
  if (more !== undefined) lines.push(more)
  const failure = isRecord(outcome.error) ? renderFailure(outcome) : undefined
  if (failure !== undefined) lines.push(failure)
  return lines.join('\n')
}

/** `read_docx`：段落编号 + 正文；表格里的单元格标出坐标。 */
export function renderDocx(outcome: OpsOutcome, args: Record<string, unknown>): string {
  const path = typeof outcome.path === 'string' ? outcome.path : String(args.path ?? '（路径未知）')
  const paragraphs = Array.isArray(outcome.items) ? outcome.items.filter(isRecord) : []
  const total = asCount(outcome.total)
  const lines = [`文档：${oneLine(path)}（正文段落流程；页眉页脚、批注、脚注不在范围内` + (total === undefined ? '）' : `，共 ${String(total)} 段）`)]
  for (const item of paragraphs) {
    const at = item.table === undefined ? '' : `（表 ${String(item.table)} 第 ${String(item.row ?? '?')} 行第 ${String(item.cell ?? '?')} 列）`
    lines.push(`${String(item.block ?? '?')}\t${oneLine(item.text)}${at}`)
  }
  if (paragraphs.length === 0) lines.push('（这个范围没有段落）')
  const more = moreLine(paragraphs.length, total, asCount(outcome.nextOffset), '段')
  if (more !== undefined) lines.push(more)
  const failure = isRecord(outcome.error) ? renderFailure(outcome) : undefined
  if (failure !== undefined) lines.push(failure)
  return lines.join('\n')
}


/** 写类工具的中文动词：回执第一行用它，模型不用再从工具名猜。 */
const MUTATION_VERBS: Readonly<Record<string, string>> = {
  write_file: '写入',
  edit_file: '编辑',
  copy: '复制',
  move: '移动',
  remove: '删除',
  replace: '替换',
}

/** 修订号只显示前 12 位：回执是给人看的，完整值要对比时用 ops_stat 再取。 */
function shortRevision(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, 12) : undefined
}

/**
 * 写类回执：一行结论 + 每个文件改了什么。
 *
 * `dryRun` 必须写在第一行：不然模型会把「预演成功」当成「已经改了」。
 * 两个数要分开说——replace 的 `changed` 是**替换处数**，不是文件数。
 */
export function renderMutation(tool: string, outcome: OpsOutcome, args: Record<string, unknown>): string {
  const verb = MUTATION_VERBS[tool] ?? tool
  const items = Array.isArray(outcome.items) ? outcome.items.filter(isRecord) : []
  const changed = asCount(outcome.changed)
  const dry = outcome.dryRun === true
  const replacements = items.reduce((sum, item) => sum + (asCount(item.replacements) ?? 0), 0)
  const files = items.length > 0 ? items.length : (changed ?? 0)
  const summary =
    tool === 'replace'
      ? `改动 ${String(files)} 个文件、共替换 ${String(replacements)} 处`
      : `改动 ${String(changed ?? files)} 个文件`
  const lines = [(dry ? '预演（磁盘没动）：' : '') + verb + '，' + summary]
  let sawRevision = false
  for (const item of items) {
    const path = typeof item.path === 'string' ? item.path : String(args['path'] ?? '（路径未知）')
    const facts: string[] = []
    if (item.removed === true) facts.push('已删除')
    const itemReplacements = asCount(item.replacements)
    if (itemReplacements !== undefined) facts.push(`替换 ${String(itemReplacements)} 处`)
    const before = asCount(item.bytesBefore)
    const after = asCount(item.bytesAfter)
    if (before !== undefined || after !== undefined) facts.push(`${String(before ?? '?')} → ${String(after ?? '?')} 字节`)
    const from = shortRevision(item.revisionBefore)
    const to = shortRevision(item.revisionAfter) ?? shortRevision(item.revision)
    if (from !== undefined || to !== undefined) {
      sawRevision = true
      facts.push(`修订 ${from ?? 'absent'} → ${to ?? '?'}`)
    }
    if (item.metadata !== undefined) facts.push('元数据已保留')
    lines.push(facts.length === 0 ? oneLine(path) : `${oneLine(path)}（${facts.join('；')}）`)
  }
  if (items.length === 0) {
    lines.push(tool === 'replace' ? '没有匹配到要替换的内容（一个文件都没动）' : '没有文件被改动')
  }
  const skipped = asCount(outcome.skipped)
  if ((skipped ?? 0) > 0) {
    const paths = Array.isArray(outcome.skippedPaths)
      ? outcome.skippedPaths.filter((item): item is string => typeof item === 'string')
      : []
    const shown = paths.slice(0, 8).map((item) => oneLine(item)).join('、')
    lines.push(`（跳过 ${String(skipped)} 个${shown === '' ? '' : '：' + shown}${paths.length > 8 ? ' 等' : ''}）`)
  }
  const failed = asCount(outcome.failed)
  if ((failed ?? 0) > 0) lines.push(`（${String(failed)} 个失败，看上面的逐条回执）`)
  if (sawRevision) lines.push('（修订号只显示前 12 位；要把完整值当 expectedRevision，用 ops_stat 取）')
  return lines.join('\n')
}

/** `read_pdf`：页号 + 该页文字。 */
export function renderPdf(outcome: OpsOutcome, args: Record<string, unknown>): string {
  const path = typeof outcome.path === 'string' ? outcome.path : String(args.path ?? '（路径未知）')
  const pages = Array.isArray(outcome.items) ? outcome.items.filter(isRecord) : []
  const total = asCount(outcome.total)
  const lines = [`PDF：${oneLine(path)}（只取文本层` + (total === undefined ? '）' : `，共 ${String(total)} 页）`)]
  for (const page of pages) lines.push(`第 ${String(page.page ?? '?')} 页\t${oneLine(page.text)}`)
  if (pages.length === 0) lines.push('（这个范围没有文本）')
  const more = moreLine(pages.length, total, asCount(outcome.nextOffset), '页')
  if (more !== undefined) lines.push(more)
  const failure = isRecord(outcome.error) ? renderFailure(outcome) : undefined
  if (failure !== undefined) lines.push(failure)
  return lines.join('\n')
}
