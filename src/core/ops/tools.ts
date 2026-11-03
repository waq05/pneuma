/**
 * 十三个 ops 工具（七个只读 + 六个写类）：把 worker 的能力包成 numa 的工具条目。
 *
 * 只读那批补「read 做不到的几件事」（一次读多段、16 进制视图、文档、表格、差异）；
 * 写类那批补「逐字节修订锚 + 预演」（worker 按 SHA-256 比对，版本不符整次拒绝）。
 *
 * 三条与 numa 其余工具一致的规矩：
 *   1. **读禁一律先过 `readBlockReason`**：密钥、`.env`、凭据目录不进对话，
 *      worker 那边还有一道 `deny_credential_names`，两道闸互不替代；
 *   2. **路径先转绝对**：worker 按 `root`（本次 cwd）解析相对路径，但工具层直接给
 *      绝对路径，省得两边对「当前目录」的理解不一致；
 *   3. **失败要抛**：worker 交回 `error`/`rejected` 时抛中文说明，让循环按失败记，
 *      别把「拒了」画成「读到了」。例外是文档类：worker 的契约是「后面几页坏了，
 *      前面已解析的照给」，这时把已拿到的部分连同失败尾注一起交回去。
 *
 * @module dsc/core/ops/tools
 */
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { noteRead, noteWrite, readBlockReason, staleEditReason, staleOverwriteReason, writeHardBlockReason } from '../path-policy.js'
import { absPath } from '../tools/path-args.js'
import { sandboxPermissionProperties } from '../tools/sandbox-args.js'
import type { ToolContext, ToolEntry } from '../tools.js'
import { hasItems, isFailure, renderDiff, renderDocx, renderFailure, renderInspect, renderMutation, renderPdf, renderReadFiles, renderStat, renderTable } from './render.js'
import type { OpsOutcome } from './render.js'
import { callOpsWorker } from './worker.js'

/** 建工具条目要的三样东西（插件挂载时定下来，之后不变）。 */
export interface OpsToolOptions {
  /** worker 可执行文件。 */
  file: string
  /** 单次调用时限。 */
  timeoutMs: number
  /** 单次输出上限。 */
  maxBytes: number
}

/**
 * 可以「部分成功」的工具：文档类会在坏页之后停下，但已经解析出来的内容照给。
 * 这里不抛整条失败，渲染时把 `error` 附在末尾。
 */
const PARTIAL_OK: ReadonlySet<string> = new Set(['read_table', 'read_docx', 'read_pdf'])

/** 参数里的路径：绝对化之后再过读禁；空串与非字符串用与内置工具同一句报错。 */
function targetPath(cwd: string, raw: unknown): string {
  const file = absPath(cwd, typeof raw === 'string' ? raw.trim() : raw)
  const blocked = readBlockReason(file)
  if (blocked !== null) throw new Error(blocked)
  return file
}

/** 调一次 worker，失败按异常抛出（渲染成中文）。 */
async function invoke(
  options: OpsToolOptions,
  tool: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  mutating = false,
): Promise<OpsOutcome> {
  const outcome = await callOpsWorker({
    file: options.file,
    tool,
    args,
    cwd: ctx.cwd,
    scope: ctx.sessionId,
    readOnly: !mutating,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    signal: ctx.signal,
  })
  if (isFailure(outcome) && !(PARTIAL_OK.has(tool) && hasItems(outcome))) {
    throw new Error(renderFailure(outcome))
  }
  return outcome
}

/**
 * 写类工具的前置检查：只做 numa 的硬禁（凭据目录、受保护路径）。
 *
 * 沙箱档位与审批**不在这里判**：那是守卫链（sandbox 插件 order 8）与审批卡的职责，
 * 而且它们按调用方会话判。工具层拿 `ctx.session.current()` 的档位去拦，后台会话会拿错，
 * 还会把用户已经批准的升权路径一起挡死。
 */
function guardWrite(cwd: string, raw: unknown): string {
  const file = absPath(cwd, typeof raw === 'string' ? raw.trim() : raw)
  const hard = writeHardBlockReason(file)
  if (hard !== null) throw new Error(hard)
  return file
}

/**
 * 取目标当前的修订号当 CAS 锚：调用方没传 expectedRevision 时现取一次。
 *
 * 注意这个锚是「现在」的版本，不是「模型读它的时候」的版本——所以不传
 * expectedRevision 时，CAS 只防「取锚到写盘之间」这段窗口，防不住模型拿旧印象来写。
 * 要强保护就把 ops_stat 给的版本号显式传回来。
 *
 * 文件确认不存在才给 `absent`（worker 约定：只允许新建）；其它失败原样抛，
 * 不能把「读不到」当成「不存在」——那等于把保护静默拆掉。
 */
async function revisionOf(options: OpsToolOptions, path: string, ctx: ToolContext): Promise<string> {
  const outcome = await callOpsWorker({
    file: options.file,
    tool: 'stat',
    args: { path },
    cwd: ctx.cwd,
    scope: ctx.sessionId,
    readOnly: true,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    signal: ctx.signal,
  })
  if (isFailure(outcome)) throw new Error(renderFailure(outcome))
  if (outcome.exists === false) return 'absent'
  if (typeof outcome.revision !== 'string' || outcome.revision === '') {
    throw new Error('取不到目标文件的修订号，这次不写；先用 ops_stat 看它现在什么状态')
  }
  return outcome.revision
}

/**
 * 目标文件的父目录不存在就先建出来（worker 自己不会建，会直接 NOT_FOUND）。
 *
 * 为什么不怕「写失败却留下空目录」：父目录不存在时目标本身也必然不存在，
 * 这次调用只能是新建（每个工具都是这么取的锚）；新建没有 CAS 可失败，
 * 真正会失败的是权限与参数，而那两种在 worker 的 preflight 里就拒了。
 */
function ensureParent(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
}

/**
 * 预演时父目录不存在：不建目录（预演承诺「磁盘一点不动」），但要说清楚正式写入会建。
 *
 * 不说的话，worker 只会回一句「系统找不到指定的文件」，模型会以为目标路径写错了。
 */
function dryRunParentCheck(file: string): void {
  const dir = dirname(file)
  if (!existsSync(dir)) {
    throw new Error(`父目录还不存在：${dir}。正式写入会自动建出来，预演不建目录；先把目录建好，或去掉 dryRun 直接写`)
  }
}

/**
 * 批量替换的根路径围栏：目录整替换会把 glob 落到整棵树，不能对着盘符根或主目录干。
 *
 * 单文件时 `writeHardBlockReason` 够用；目录时受保护名（.git 等）与凭据目录不一定在
 * 根字符串上命中，所以整棵树这条路单独加一道。
 */
function guardReplaceRoot(path: string): void {
  const trimmed = path.replace(/[\\/]+$/, '')
  const root = trimmed === '' || path === resolve(path) && dirname(path) === path
  if (root) throw new Error(`不能对根目录（${path}）整树替换：把 path 收窄到具体目录或文件`)
  if (trimmed === homedir().replace(/[\\/]+$/, '')) {
    throw new Error('不能对主目录整树替换：把 path 收窄到具体目录，或改用 glob 限定文件')
  }
}

/** 修订锚参数的说明：六个写类工具共用同一句话，免得模型每个工具重新猜。 */
const REVISION_HELP =
  '要改的版本号（64 位十六进制，由 ops_stat / ops_inspect_local_file 给出）；不传就现取一次，' +
  '传了而版本不符时整次拒绝、一个字节都不改'

/** 整数参数：不是数字就报错，认出来就给整数。 */
function optionalInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${name} 要是数字，收到的是「${String(value)}」`)
  return Math.trunc(number)
}

/** 带下界的整数参数：越界当场报错，别让 worker 回一句难懂的话。 */
function boundedInt(value: unknown, name: string, min: number): number | undefined {
  const number = optionalInt(value, name)
  if (number !== undefined && number < min) throw new Error(`${name} 不能小于 ${String(min)}`)
  return number
}

/**
 * 造十三个 ops 工具。
 *
 * @param options - worker 路径与限额
 * @returns 按固定顺序排好的工具条目（七个只读在前，六个写类在后）
 */
export function createOpsTools(options: OpsToolOptions): ToolEntry[] {
  const inspect: ToolEntry = {
    name: 'ops_inspect_local_file',
    description:
      '按行读一个文件，行号在前、正文在后；也能切 16 进制视图看二进制头。' +
      '与内置 read 的区别：它给的是纯行号视图、支持 hex、并回报修订号（revision），适合读日志、二进制头、需要对齐行号的场合。' +
      '图片与 PDF/DOCX 不要用它，分别走 read 和 ops_read_pdf / ops_read_docx。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（绝对或相对当前目录）' },
        offset: { type: 'integer', minimum: 0, description: '起始行（文本视图从 1 起；hex 视图是 16 字节行号，从 0 起）' },
        limit: { type: 'integer', minimum: 1, maximum: 10000, description: '最多读多少行（默认 200，上限 10000）' },
        view: { type: 'string', enum: ['text', 'hex'], description: 'text = 按行读（默认）；hex = 每行 16 字节的十六进制' },
      },
      required: ['path'],
    },
    risk: 'read',
    async run(args, ctx) {
      const path = targetPath(ctx.cwd, args.path)
      const request: Record<string, unknown> = { path }
      const offset = boundedInt(args.offset, 'offset', 0)
      const limit = boundedInt(args.limit, 'limit', 1)
      if (offset !== undefined) request['offset'] = offset
      if (limit !== undefined) request['limit'] = limit
      if (args.view === 'hex') request['view'] = 'hex'
      const outcome = await invoke(options, 'inspect_local_file', request, ctx)
      // 读过了就记账：后面用 write / edit 覆盖时，先读后写的台账认得出这一笔。
      noteRead(path, ctx.sessionId)
      return renderInspect(outcome, request)
    },
  }

  const readFiles: ToolEntry = {
    name: 'ops_read_files',
    description:
      '一次读多个文件的多个区间（最多 32 段），每段各自带行号与「还有多少没显示」。' +
      '与内置 read 的区别：read 一次只读一个文件；要看十几处日志、对齐几份配置时，用它省掉十几次往返。' +
      '每段参数与 read 一样：path、offset、limit。某一段失败不影响其它段。',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: '要读的文件与区间，1-32 段',
          minItems: 1,
          maxItems: 32,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件路径（绝对或相对当前目录）' },
              offset: { type: 'integer', minimum: 1, description: '起始行（1 起，默认 1）' },
              limit: { type: 'integer', minimum: 1, maximum: 10000, description: '最多读多少行（默认 200）' },
            },
            required: ['path'],
          },
        },
      },
      required: ['files'],
    },
    risk: 'read',
    async run(args, ctx) {
      const raw = Array.isArray(args.files) ? args.files : []
      if (raw.length === 0) throw new Error('files 不能为空：给至少一段 { path, offset?, limit? }')
      if (raw.length > 32) throw new Error(`一次最多读 32 段，这次给了 ${String(raw.length)} 段`)
      const files = raw.map((entry) => {
        const record = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
        const file: Record<string, unknown> = { path: targetPath(ctx.cwd, record['path']) }
        const offset = boundedInt(record['offset'], 'offset', 1)
        const limit = boundedInt(record['limit'], 'limit', 1)
        if (offset !== undefined) file['offset'] = offset
        if (limit !== undefined) file['limit'] = limit
        return file
      })
      const outcome = await invoke(options, 'read_files', { files }, ctx)
      for (const item of Array.isArray(outcome.items) ? outcome.items : []) {
        const file = item !== null && typeof item === 'object' ? (item as Record<string, unknown>)['path'] : undefined
        if (typeof file === 'string' && !isFailure(item as Record<string, unknown>)) noteRead(file, ctx.sessionId)
      }
      return renderReadFiles(outcome)
    },
  }

  const stat: ToolEntry = {
    name: 'ops_stat',
    description:
      '看一个文件的「体检数据」：存在与否、字节数、行数、修订号（revision）、修改时间、只读属性。' +
      '与内置 read 的区别：read 会把内容读进上下文，stat 只回答事实；判断「改之前有没有变过」就看 revision。' +
      '文件不存在也算正常结果（存在：否），不会报错。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径（绝对或相对当前目录）' } },
      required: ['path'],
    },
    risk: 'read',
    async run(args, ctx) {
      const request = { path: targetPath(ctx.cwd, args.path) }
      const outcome = await invoke(options, 'stat', request, ctx)
      return renderStat(outcome, request)
    },
  }

  const diff: ToolEntry = {
    name: 'ops_diff',
    description:
      '把一段新内容与磁盘上的文件当前内容逐行比，给出 +/- 与行号；不落盘、不修改任何东西。' +
      '与内置 edit 的区别：edit 直接改，diff 只预演；想先让用户看清要改哪几行，或者改了之后想确认差异，用它。' +
      'content 是「改完之后整个文件应该长什么样」，不是补丁。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要比对的文件路径（绝对或相对当前目录）' },
        content: { type: 'string', description: '改完后整个文件的完整内容' },
        offset: { type: 'integer', minimum: 0, description: '从第几条差异记录开始显示（0 起，默认 0）' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: '最多显示多少条差异记录（默认 100）' },
      },
      required: ['path', 'content'],
    },
    risk: 'read',
    async run(args, ctx) {
      const path = targetPath(ctx.cwd, args.path)
      if (typeof args.content !== 'string') throw new Error('content 要是字符串：请给改完之后整个文件的完整内容')
      const request: Record<string, unknown> = { path, content: args.content }
      const offset = boundedInt(args.offset, 'offset', 0)
      const limit = boundedInt(args.limit, 'limit', 1)
      if (offset !== undefined) request['offset'] = offset
      if (limit !== undefined) request['limit'] = limit
      const outcome = await invoke(options, 'diff', request, ctx)
      return renderDiff(outcome, request)
    },
  }

  const readTable: ToolEntry = {
    name: 'ops_read_table',
    description:
      '读 CSV / TSV：列名单独一行，数据按行给单元格；支持带引号的多行字段，不做类型转换（都是字符串）。' +
      '与 read 的区别：read 会把 JSON 化的整行原样吐出来、多行字段看成一堆碎行；这个按记录切，行号不会错位。' +
      '默认第一行当表头；Excel 的 .xlsx 不支持（先另存为 CSV）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'CSV/TSV 文件路径（绝对或相对当前目录）' },
        format: { type: 'string', enum: ['csv', 'tsv'], description: '分隔格式；按扩展名自动判断，判断错了才传' },
        encoding: { type: 'string', enum: ['utf-8', 'utf-16le', 'utf-16be'], description: '编码，默认 utf-8；UTF-16 要写清楚是哪一端' },
        header: { type: 'boolean', description: '第一行是不是表头（默认是）；传 false 就把第一行也当数据' },
        offset: { type: 'integer', minimum: 1, description: '从第几条数据行开始（1 起，表头不算）' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: '最多读多少条数据行（默认 200）' },
      },
      required: ['path'],
    },
    risk: 'read',
    async run(args, ctx) {
      const request: Record<string, unknown> = { path: targetPath(ctx.cwd, args.path) }
      if (args.format === 'csv' || args.format === 'tsv') request['format'] = args.format
      if (typeof args.encoding === 'string' && args.encoding !== '') request['encoding'] = args.encoding
      if (typeof args.header === 'boolean') request['header'] = args.header
      const offset = boundedInt(args.offset, 'offset', 1)
      const limit = boundedInt(args.limit, 'limit', 1)
      if (offset !== undefined) request['offset'] = offset
      if (limit !== undefined) request['limit'] = limit
      const outcome = await invoke(options, 'read_table', request, ctx)
      return renderTable(outcome, request)
    },
  }

  const readDocx: ToolEntry = {
    name: 'ops_read_docx',
    description:
      '读 Word 文档（.docx）的正文段落，按段落编号列出；表格里的单元格会标出「表几、第几行、第几列」。' +
      '范围只含正文：页眉页脚、脚注、批注、图片都不在内，排版也不还原。' +
      '与 read 的区别：read 读 .docx 只能拿到 zip 里的二进制噪声。老的 .doc 不支持，先另存为 .docx。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '.docx 文件路径（绝对或相对当前目录）' },
        offset: { type: 'integer', minimum: 1, maximum: 100000, description: '从第几段开始（1 起，默认 1）' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: '最多读多少段（默认 200，上限 1000）' },
      },
      required: ['path'],
    },
    risk: 'read',
    async run(args, ctx) {
      const request: Record<string, unknown> = { path: targetPath(ctx.cwd, args.path) }
      const offset = boundedInt(args.offset, 'offset', 1)
      const limit = boundedInt(args.limit, 'limit', 1)
      if (offset !== undefined) request['offset'] = offset
      if (limit !== undefined) request['limit'] = limit
      const outcome = await invoke(options, 'read_docx', request, ctx)
      return renderDocx(outcome, request)
    },
  }

  const readPdf: ToolEntry = {
    name: 'ops_read_pdf',
    description:
      '读 PDF 的文本层，按页给文字；只认文本层，扫描件（图片型 PDF）读不出字，需要 OCR 的场合别用它。' +
      '与 read 的区别：read 读 .pdf 只能拿到二进制。分页读：offset 是起始页（1 起），limit 是页数。' +
      '只支持带标准字体的普通 PDF；加密、破损、纯图 PDF 会明确报错，不会给你一段乱码。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PDF 文件路径（绝对或相对当前目录）' },
        offset: { type: 'integer', minimum: 1, maximum: 32, description: '从第几页开始（1 起，默认 1）' },
        limit: { type: 'integer', minimum: 1, maximum: 32, description: '最多读多少页（默认 10，上限 32）' },
      },
      required: ['path'],
    },
    risk: 'read',
    async run(args, ctx) {
      const request: Record<string, unknown> = { path: targetPath(ctx.cwd, args.path) }
      const offset = boundedInt(args.offset, 'offset', 1)
      const limit = boundedInt(args.limit, 'limit', 1)
      if (offset !== undefined) request['offset'] = offset
      if (limit !== undefined) request['limit'] = limit
      const outcome = await invoke(options, 'read_pdf', request, ctx)
      return renderPdf(outcome, request)
    },
  }

  // ── 第二批：写类六件 ─────────────────────────────────────────────────────
  // 与内置 write/edit 的分工：内置那两件是「马上改」；这六件多给两样东西——
  // 逐字节的修订锚（改错版本整次拒绝）与 dryRun 预演，并且能一次改多处、能整目录替换。

  const writeFile: ToolEntry = {
    name: 'ops_write_file',
    description:
      '把内容整体写入文件（覆盖原内容），父目录不存在会先建出来；带修订锚与预演。' +
      '与内置 write 的区别：可以先 dryRun 看回执，也能指定 expectedRevision 做并发保护（版本不符整次拒绝）。' +
      '已存在的文件必须先读过内容（read、ops_inspect_local_file、ops_read_files 都算），否则拒绝；dryRun 不受这条限制。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径（绝对或相对当前目录）' },
        content: { type: 'string', description: '完整文件内容' },
        expectedRevision: { type: 'string', description: REVISION_HELP },
        dryRun: { type: 'boolean', description: '只预演不落盘：给回执但不写磁盘、不建目录' },
        ...sandboxPermissionProperties,
      },
      required: ['path', 'content'],
    },
    risk: 'write',
    async run(args, ctx) {
      const path = guardWrite(ctx.cwd, args.path)
      if (typeof args.content !== 'string') throw new Error('content 要是字符串：请给完整文件内容')
      // 预演不落盘，也就不需要「先读后写」这道闸：想先看一眼哪几行会变，是最该放行的路径。
      if (args.dryRun !== true) {
        const stale = staleOverwriteReason(path, ctx.sessionId)
        if (stale !== null) throw new Error(stale)
      }
      const revision = typeof args.expectedRevision === 'string' && args.expectedRevision !== '' ? args.expectedRevision : await revisionOf(options, path, ctx)
      const request: Record<string, unknown> = { path, content: args.content, expectedRevision: revision }
      if (args.dryRun === true) {
        request['dryRun'] = true
        dryRunParentCheck(path)
      } else ensureParent(path)
      const outcome = await invoke(options, 'write_file', request, ctx, true)
      if (args.dryRun !== true) noteWrite(path, ctx.sessionId)
      return renderMutation('write_file', outcome, request)
    },
  }

  const editFile: ToolEntry = {
    name: 'ops_edit_file',
    description:
      '对同一个文件一次做多处精确替换（1-100 处，互不重叠）：每处给 oldText 与 newText。' +
      '与内置 edit 的区别：edit 一次一处；这个一次改多处，且每处都对着同一份原始内容校验，改到一半不会只落一半。' +
      'oldText 必须在原文里恰好出现一次；匹配多处就多带几行上下文。带修订锚与 dryRun。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径（绝对或相对当前目录）' },
        expectedRevision: { type: 'string', description: REVISION_HELP },
        edits: {
          type: 'array',
          description: '1-100 处替换，互不重叠',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: '要被替换的原文，必须在原文里恰好出现一次' },
              newText: { type: 'string', description: '替换后的内容' },
            },
            required: ['oldText', 'newText'],
          },
        },
        dryRun: { type: 'boolean', description: '只预演不落盘' },
        ...sandboxPermissionProperties,
      },
      required: ['path', 'edits'],
    },
    risk: 'write',
    async run(args, ctx) {
      const path = guardWrite(ctx.cwd, args.path)
      const raw = Array.isArray(args.edits) ? args.edits : []
      if (raw.length === 0) throw new Error('edits 不能为空：给至少一处 { oldText, newText }')
      if (raw.length > 100) throw new Error(`一次最多 100 处替换，这次给了 ${String(raw.length)} 处`)
      if (args.dryRun !== true) {
        const stale = staleEditReason(path, ctx.sessionId)
        if (stale !== null) throw new Error(stale)
      }
      const edits = raw.map((entry) => {
        const record = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
        if (typeof record['oldText'] !== 'string' || record['oldText'] === '') throw new Error('每一处都要给 oldText（非空字符串）')
        if (typeof record['newText'] !== 'string') throw new Error('每一处都要给 newText（可以是空串，表示删掉）')
        return { oldText: record['oldText'], newText: record['newText'] }
      })
      const revision = typeof args.expectedRevision === 'string' && args.expectedRevision !== '' ? args.expectedRevision : await revisionOf(options, path, ctx)
      const request: Record<string, unknown> = { path, expectedRevision: revision, edits }
      if (args.dryRun === true) request['dryRun'] = true
      const outcome = await invoke(options, 'edit_file', request, ctx, true)
      if (args.dryRun !== true) noteWrite(path, ctx.sessionId)
      return renderMutation('edit_file', outcome, request)
    },
  }

  /**
   * 守卫链与审批卡只认 args.path 这类键（`core/tools.ts` 的 `callFacts`），而复制/移动真正
   * 会写的是 `to`。不把这一调用按 `to` 的身份再过一次闸，目标落在工作区外时沙箱判不到、
   * 审批卡也会按源路径画「工作区内改动」。返回的 args 只换 path，原参数照旧带给工具。
   */
  const gateAsDestination = (name: string) => (args: Record<string, unknown>, cwd: string) => {
    const to = typeof args['to'] === 'string' ? args['to'].trim() : ''
    if (to === '') return undefined
    const target = isAbsolute(to) ? to : resolve(cwd, to)
    return { name, risk: 'write' as const, args: { ...args, path: target } }
  }

  const copy: ToolEntry = {
    name: 'ops_copy',
    description:
      '复制一个文件到新路径；源文件的版本必须与 expectedRevision 一致（不传就现取当前版本）。' +
      '与 bash 的 cp 的区别：目标已存在时不覆盖（会明确报冲突），不会悄悄盖掉别人的文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '源文件路径（绝对或相对当前目录）' },
        to: { type: 'string', description: '目标路径（不存在；父目录不存在会先建出来）' },
        expectedRevision: { type: 'string', description: REVISION_HELP },
        ...sandboxPermissionProperties,
      },
      required: ['path', 'to'],
    },
    risk: 'write',
    gateAs: gateAsDestination('ops_copy'),
    async run(args, ctx) {
      const path = guardWrite(ctx.cwd, args.path)
      const to = guardWrite(ctx.cwd, args.to)
      const stale = staleEditReason(path, ctx.sessionId)
      if (stale !== null) throw new Error(stale)
      const revision = typeof args.expectedRevision === 'string' && args.expectedRevision !== '' ? args.expectedRevision : await revisionOf(options, path, ctx)
      const request: Record<string, unknown> = { path, to, expectedRevision: revision }
      ensureParent(to)
      const outcome = await invoke(options, 'copy', request, ctx, true)
      noteWrite(to, ctx.sessionId)
      return renderMutation('copy', outcome, request)
    },
  }

  const move: ToolEntry = {
    name: 'ops_move',
    description:
      '移动（改名）一个文件到新路径；源文件的版本必须与 expectedRevision 一致（不传就现取当前版本）。' +
      '与 bash 的 mv 的区别：目标已存在时不覆盖，跨盘移动也是「先确认再落」，不会留下半截文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '源文件路径（绝对或相对当前目录）' },
        to: { type: 'string', description: '目标路径（不存在；父目录不存在会先建出来）' },
        expectedRevision: { type: 'string', description: REVISION_HELP },
        ...sandboxPermissionProperties,
      },
      required: ['path', 'to'],
    },
    risk: 'write',
    gateAs: gateAsDestination('ops_move'),
    async run(args, ctx) {
      const path = guardWrite(ctx.cwd, args.path)
      const to = guardWrite(ctx.cwd, args.to)
      const stale = staleEditReason(path, ctx.sessionId)
      if (stale !== null) throw new Error(stale)
      const revision = typeof args.expectedRevision === 'string' && args.expectedRevision !== '' ? args.expectedRevision : await revisionOf(options, path, ctx)
      const request: Record<string, unknown> = { path, to, expectedRevision: revision }
      ensureParent(to)
      const outcome = await invoke(options, 'move', request, ctx, true)
      noteWrite(to, ctx.sessionId)
      // 源路径已经不在：`noteRead` 的 stat 失败会顺手把旧条目删掉，免得下次同路径新建被误判「被改过」。
      noteRead(path, ctx.sessionId)
      return renderMutation('move', outcome, request)
    },
  }

  const remove: ToolEntry = {
    name: 'ops_remove',
    description:
      '删除一个文件；文件的版本必须与 expectedRevision 一致（不传就现取当前版本），能挡住「准备期间被改过」的误删。' +
      '与 bash 的 rm 的区别：只删文件、不递归目录；回执写明删了哪个、原来的修订号。' +
      '删除不可撤销，动手前先用 ops_stat 确认是它。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要删的文件路径（绝对或相对当前目录）' },
        expectedRevision: { type: 'string', description: REVISION_HELP },
        ...sandboxPermissionProperties,
      },
      required: ['path'],
    },
    risk: 'write',
    async run(args, ctx) {
      const path = guardWrite(ctx.cwd, args.path)
      const stale = staleEditReason(path, ctx.sessionId)
      if (stale !== null) throw new Error(stale)
      const revision = typeof args.expectedRevision === 'string' && args.expectedRevision !== '' ? args.expectedRevision : await revisionOf(options, path, ctx)
      const request: Record<string, unknown> = { path, expectedRevision: revision }
      const outcome = await invoke(options, 'remove', request, ctx, true)
      noteRead(path, ctx.sessionId)
      return renderMutation('remove', outcome, request)
    },
  }

  const replace: ToolEntry = {
    name: 'ops_replace',
    description:
      '按字面量批量替换：在 path（文件或目录）里把 pattern 换成 replacement，可用 glob 限定文件、设上限、先预演。' +
      'pattern 是**字面文本**不是正则；改多处时比一条条 edit 省往返。' +
      '与 edit 的区别：edit 要求唯一匹配、一次一处；这个按出现次数替换，并回报每个文件改了几处。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件或目录路径（绝对或相对当前目录）' },
        pattern: { type: 'string', description: '要替换的字面文本（不是正则）' },
        replacement: { type: 'string', description: '替换成什么；空串表示删掉' },
        glob: { type: 'array', items: { type: 'string' }, description: '在目录里限定文件名，例如 ["**/*.ts"]；给文件路径时可省' },
        maxReplacements: { type: 'integer', minimum: 1, maximum: 100000, description: '最多替换多少处（默认 100）；超过上限整次失败，不会只改一半' },
        dryRun: { type: 'boolean', description: '只预演不落盘：回报每个文件会改几处' },
        ...sandboxPermissionProperties,
      },
      required: ['path', 'pattern', 'replacement'],
    },
    risk: 'write',
    async run(args, ctx) {
      const path = guardWrite(ctx.cwd, args.path)
      guardReplaceRoot(path)
      if (typeof args.pattern !== 'string' || args.pattern === '') throw new Error('pattern 要是非空字符串（字面文本，不是正则）')
      if (typeof args.replacement !== 'string') throw new Error('replacement 要是字符串（可以是空串）')
      const request: Record<string, unknown> = { path, pattern: args.pattern, replacement: args.replacement }
      if (Array.isArray(args.glob) && args.glob.length > 0) request['glob'] = args.glob.map((item) => String(item))
      const max = boundedInt(args.maxReplacements, 'maxReplacements', 1)
      if (max !== undefined) request['maxReplacements'] = max
      if (args.dryRun === true) request['dryRun'] = true
      const outcome = await invoke(options, 'replace', request, ctx, true)
      if (args.dryRun !== true) {
        const items = Array.isArray(outcome.items) ? outcome.items : []
        for (const item of items) {
          const file = item !== null && typeof item === 'object' ? (item as Record<string, unknown>)['path'] : undefined
          if (typeof file === 'string') noteWrite(file, ctx.sessionId)
        }
      }
      return renderMutation('replace', outcome, request)
    },
  }

  return [inspect, readFiles, stat, diff, readTable, readDocx, readPdf, writeFile, editFile, copy, move, remove, replace]
}
