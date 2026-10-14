/**
 * desktop-dock 插件：为桌面端 dock 面板提供工作区文件系统与 git 能力
 * （renderer 经 DscRuntime.dock(op, payload) 透传调用）。
 *
 * 安全边界：路径限定在**当前会话的工作目录**内（fs-read 文本 ≤512KB、图片 ≤5MB、
 * PDF/XLSX 整读 ≤10MB、二进制扩展名不读内容）；git 全部 execFile 固定子命令 +
 * safeArg 参数净化（拒绝选项注入），无 shell。
 *
 * 三档（2026-10-10，见 `core/dock-ops.ts` 的对照表）：读类直接放行；**写类先过审批**
 * （与工具调用同一套裁决，权限模式对它同样成立）；终端那档**不进界面 HTTP 面**，
 * 只从桌面窗口的原生桥进来。这里承担写类的闸门；终端那档由传输侧保证。
 *
 * @module dsc/plugins/desktop-dock
 */
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, statSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import type { ChildProcess } from 'node:child_process'
import { DOCK_WRITE_LABEL, isDockWriteOp, type DockWriteOp } from '../core/dock-ops.js'
// 执行姿势与 porcelains 解析住在 core：git 插件（分支/改动读数那条快照面）读的是同一个
// 工作区，两处必须共用一份（尤其是 `-z` 的 rename 双记录），见 core/git-exec.ts。
import { git, parsePorcelainZ, repoPrefix, toWorkspacePath } from '../core/git-exec.js'

/** 参数净化：拒绝空字节/换行与选项注入位。 */
function safeArg(value: unknown, allowNewline = false): string {
  const text = String(value ?? '')
  if (text.includes('\0')) throw new Error('非法参数')
  if (!allowNewline && text.includes('\n')) throw new Error('非法参数：含换行')
  if (text.startsWith('-')) throw new Error('非法参数：以 - 开头')
  return text
}

/**
 * HEAD 是否已经出生（仓库里至少有一次提交）。
 *
 * 空仓库（`git init` 之后一次没提交）与 HEAD 指向不存在引用的坏仓库，`git diff HEAD`
 * 都会直接报 `fatal: ambiguous argument 'HEAD'`——这个原始报错 2026-10-13 被用户当
 * 面板故障报了上来。凡是要「相对 HEAD」的读取都先问这一句，问不到就换无 HEAD 的走法。
 */
async function hasHead(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/** `--numstat -z` 的输出解析：`add\trem\tpath\0`；rename 是 `add\trem\t\0old\0new\0`（取新路径）。 */
function parseNumstatZ(text: string): Map<string, { added: number; removed: number }> {
  const stats = new Map<string, { added: number; removed: number }>()
  const records = text.split('\0')
  for (let at = 0; at < records.length; at += 1) {
    const record = records[at] ?? ''
    if (record === '') continue
    const fields = record.split('\t')
    if (fields.length < 3) continue
    // 二进制文件 numstat 给 `-\t-\tpath`：parseInt 得 NaN，按 0 计（与参考实现同口径）。
    const addedRaw = Number.parseInt(fields[0] ?? '', 10)
    const removedRaw = Number.parseInt(fields[1] ?? '', 10)
    const added = Number.isFinite(addedRaw) ? addedRaw : 0
    const removed = Number.isFinite(removedRaw) ? removedRaw : 0
    const path = fields.slice(2).join('\t')
    if (path !== '') {
      stats.set(path, { added, removed })
      continue
    }
    // rename：紧跟两条路径记录（旧、新），取新路径
    const renamed = records[at + 2] ?? ''
    at += 2
    if (renamed !== '') stats.set(renamed, { added, removed })
  }
  return stats
}

/** 把一份 numstat -z 读数按工作目录范围过滤并剥前缀，得到「cwd 相对路径 → 增删行数」。 */
function workspaceNumstat(prefix: string, text: string): Record<string, { added: number; removed: number }> {
  const out: Record<string, { added: number; removed: number }> = {}
  for (const [repoPath, stat] of parseNumstatZ(text)) {
    const path = toWorkspacePath(repoPath, prefix)
    if (path === null) continue
    out[path] = stat
  }
  return out
}

/** 未跟踪条目的路径清单（含被折叠的目录条目，如 `deepseek-harness/`），已 rebase 到 cwd 相对。 */
async function untrackedPaths(cwd: string): Promise<string[]> {
  const prefix = await repoPrefix(cwd)
  const porcelain = await git(cwd, ['status', '--porcelain=v1', '-z'])
  return parsePorcelainZ(porcelain)
    .filter((entry) => entry.code === '??')
    .map((entry) => toWorkspacePath(entry.file, prefix))
    .filter((path): path is string => path !== null)
}

/** 合成预览的上限：单文件 512KB（与 fs-read 文本同口径）。 */
const UNTRACKED_PREVIEW_MAX_BYTES = 512 * 1024
/** 「全部改动」里合成未跟踪段的护栏：最多 40 个文件 / 合计 2MB（防一次点开撑爆 payload）。 */
const UNTRACKED_PREVIEW_MAX_FILES = 40
const UNTRACKED_PREVIEW_MAX_TOTAL_BYTES = 2 * 1024 * 1024
/** 未跟踪行数统计的单文件上限：超过就不数（口径与参考实现一致：1 MiB）。 */
const GIT_UNTRACKED_STAT_MAX_BYTES = 1024 * 1024
/** 未跟踪行数统计的并发宽度（一次别把一堆小文件全读进内存）。 */
const GIT_UNTRACKED_STAT_CONCURRENCY = 4

/**
 * 读一个未跟踪条目的内容：**预览与行数统计共用这一份判定**，别分裂成两套。
 *
 * 判定顺序：越界 → 读不到 → 不是文件（未跟踪目录整条）→ 超过上限 → 含 NUL（二进制）→
 * 文本（CRLF 归一到 LF）。两个调用方只差一个字节上限（预览 512KB、行数统计 1MiB），
 * 二进制 / 目录 / 过大 / 缺失这几条判定是同一份——避免「预览说能看、统计说没有」的分叉。
 */
type UntrackedRead =
  | { kind: 'outside' }
  | { kind: 'missing' }
  | { kind: 'dir' }
  | { kind: 'tooLarge'; bytes: number }
  | { kind: 'binary' }
  | { kind: 'text'; text: string }

function readUntracked(cwd: string, file: string, maxBytes: number): UntrackedRead {
  const abs = resolve(cwd, file)
  if (!inside(abs, cwd)) return { kind: 'outside' }
  let stat: Stats
  try {
    stat = statSync(abs)
  } catch {
    return { kind: 'missing' }
  }
  if (!stat.isFile()) return { kind: 'dir' }
  if (stat.size > maxBytes) return { kind: 'tooLarge', bytes: stat.size }
  const bytes = readFileSync(abs)
  if (bytes.includes(0)) return { kind: 'binary' }
  // CRLF 归一：diff 行按 LF 切，行尾的 \r 留着会在行里显示成方块。
  return { kind: 'text', text: bytes.toString('utf8').replace(/\r\n/g, '\n') }
}

/**
 * 按内容给未跟踪文件合成一段 unified diff。
 *
 * 为什么不用 `git diff --no-index`：Windows 上它会带平台相关的头，壳的解析对它并不
 * 宽容（参考实现在这里同样退回最小形态）。自己拼的形态最稳，只需要
 * `diff --git` / `--- /dev/null` / `+++ b/<路径>` / 全 `+` 行这几样。
 * 读不成文本的（二进制、过大、目录条目、已消失）给一句说明，不假装「没有改动」。
 */
function untrackedPreview(cwd: string, file: string): { patch: string; note: string } {
  const read = readUntracked(cwd, file, UNTRACKED_PREVIEW_MAX_BYTES)
  if (read.kind === 'outside') return { patch: '', note: `${file}：路径超出工作目录。` }
  if (read.kind === 'missing') return { patch: '', note: `${file}：读不到这个条目（未跟踪目录里的整体条目或文件已不在了）。` }
  if (read.kind === 'dir') return { patch: '', note: `${file}：未跟踪目录整条收录，展开看里面请用文件页签。` }
  if (read.kind === 'tooLarge') {
    return { patch: '', note: `${file}：${Math.round(read.bytes / 1024)}KB，超过 ${String(UNTRACKED_PREVIEW_MAX_BYTES / 1024)}KB 不合成预览。` }
  }
  if (read.kind === 'binary') return { patch: '', note: `${file}：二进制文件，没有可预览的文本差异。` }
  const text = read.text
  if (text === '') return { patch: '', note: `${file}：空文件，没有内容可看。` }
  const hasTrailingNewline = text.endsWith('\n')
  const lines = text.split('\n')
  if (hasTrailingNewline) lines.pop()
  const head = [`diff --git a/${file} b/${file}`, 'new file mode 100644', '--- /dev/null', `+++ b/${file}`]
  const body =
    lines.length === 0
      ? []
      : [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`), ...(hasTrailingNewline ? [] : ['\\ No newline at end of file'])]
  return { patch: `${[...head, ...body].join('\n')}\n`, note: '' }
}

/**
 * 未跟踪文件的行数（口径照参考实现：≤{@link GIT_UNTRACKED_STAT_MAX_BYTES} 才数、
 * 含 NUL 即二进制记 0、读不到 / 目录 / 过大一律 0；未跟踪只有新增，`removed` 恒 0）。
 * 数换行符而不是走 `diff --numstat`——未跟踪文件根本不在 diff 里。
 */
function countUntrackedLines(cwd: string, file: string): number {
  const read = readUntracked(cwd, file, GIT_UNTRACKED_STAT_MAX_BYTES)
  if (read.kind !== 'text' || read.text === '') return 0
  const newlines = read.text.split('\n').length - 1
  return read.text.endsWith('\n') ? newlines : newlines + 1
}

/** 并发给多个未跟踪条目数行数（宽度 {@link GIT_UNTRACKED_STAT_CONCURRENCY}）。 */
async function untrackedLineStats(cwd: string, paths: readonly string[]): Promise<Map<string, number>> {
  const stats = new Map<string, number>()
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const path = paths[next]
      next += 1
      if (path === undefined) continue
      stats.set(path, countUntrackedLines(cwd, path))
    }
  }
  const width = Math.max(1, Math.min(GIT_UNTRACKED_STAT_CONCURRENCY, paths.length))
  await Promise.all(Array.from({ length: width }, () => worker()))
  return stats
}

/**
 * tracked 改动的 diff 文本：HEAD 在就一段 `diff HEAD`（已暂存 + 未暂存合并在一份里），
 * HEAD 没出生就改成未暂存 + 已暂存两段拼——这是唯一能在空仓库里出 diff 的走法。
 *
 * `staged` 为真时只取已暂存段（index vs HEAD）；`file` 为空时 pathspec 用 `.`，把范围
 * 限定在**工作目录子树**内——git 从子目录跑 `diff HEAD` 默认会带上仓库根那侧别的目录的
 * 改动，而「只列 cwd 之内的变更」这条在 diff 这一层同样要成立。
 */
async function trackedDiff(cwd: string, guard: readonly string[], file?: string, staged = false): Promise<string> {
  const tail = ['--', file ?? '.']
  if (staged) return git(cwd, ['diff', '--cached', ...guard, ...tail]).catch(() => '')
  if (await hasHead(cwd)) return git(cwd, ['diff', 'HEAD', ...guard, ...tail])
  const parts = await Promise.all([
    git(cwd, ['diff', ...guard, ...tail]).catch(() => ''),
    git(cwd, ['diff', '--cached', ...guard, ...tail]).catch(() => ''),
  ])
  return parts.filter((part) => part !== '').join('\n')
}

/** 文件面板可直接预览的图片扩展名 → MIME（fs-read 按 kind:'image' 回 base64）。 */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

/** 走 base64 整读再由 renderer 解析的格式（fs-read 按 kind:'bytes' 回）。 */
const BYTES_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroenabled.12',
}

/** 明确的二进制扩展名：不读内容，renderer 画「暂不支持预览」占位。 */
const BINARY_EXTS = new Set([
  'exe', 'dll', 'so', 'dylib', 'node', 'bin', 'msi', 'apk',
  'zip', '7z', 'rar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'tar',
  'jar', 'class', 'pyc', 'pyd', 'wasm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'flac', 'ogg', 'm4a',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'flv',
  'psd', 'ai', 'sketch', 'blend',
  'db', 'sqlite', 'sqlite3', 'mdb', 'accdb',
  'doc', 'docx', 'ppt', 'pptx', 'xls', 'odt', 'ods',
])

/** 文件名的自然序（数字按值、大小写不敏感），移植 dsh orderEntries 的排序器。 */
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** 支持的终端 shell（payload.shell 白名单；spawn 首参必须是字面量——安全扫描静态规则）。 */
function spawnShell(shell: string, cwd: string): ChildProcess {
  switch (shell) {
    case 'pwsh':
      return spawn('pwsh.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], { cwd, windowsHide: true })
    case 'cmd':
      return spawn('cmd.exe', ['/Q', '/K'], { cwd, windowsHide: true })
    case 'bash':
      return spawn('bash.exe', ['--noprofile', '--norc'], { cwd, windowsHide: true })
    case 'node':
      return spawn('node.exe', ['-i'], { cwd, windowsHide: true })
    default:
      return spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], { cwd, windowsHide: true })
  }
}

export const desktopDockPlugin: Plugin.Object = {
  name: 'desktop-dock',
  provide: 'dock',
  apply(ctx, config) {
    /**
     * 兜底工作目录：插件挂载时进程的启动目录。只在拿不到当前会话时用它
     * （宿主刚起来还没有会话的极短窗口）。它不是主基准——见 {@link baseCwd}。
     */
    const fallbackCwd = (config as { cwd?: string } | undefined)?.cwd ?? process.cwd()

    /**
     * 本次请求的工作目录基准：**当前会话的 cwd**，取不到才落回启动目录。
     *
     * 为什么不用挂载时定死的 `process.cwd()`：常驻多会话模型下（0.6.48 起），
     * 同一宿主进程里不同会话的 cwd 不同，进程 cwd 只是「宿主从哪启动的」。
     * 拿启动目录当基准，用户切到别的工作区的会话后，文件树 / git / 终端会
     * 继续指着那个目录（0.6.67 报障：文件管理显示的不是对应工作区的文件）。
     * 沙箱的 `canWrite(path, cwd)` 早就用「会话工作目录随会话走」的口径，
     * 这一份与它对齐；安全边界（`inside` 检查）仍然在，只是基准从进程目录
     * 换成了会话目录——越界读写与从前一样被拒。
     */
    const baseCwd = (): string => {
      const session = ctx.get('session') as
        | { current(): { meta?: { cwd?: unknown } } }
        | undefined
      const cwd = session?.current().meta?.cwd
      return typeof cwd === 'string' && cwd !== '' ? cwd : fallbackCwd
    }

    // ---- 终端会话（管道模式：行缓冲输入由 renderer 负责，这里每行执行） ----
    const terms = new Map<string, ChildProcess>()
    let termSeq = 0

    /**
     * 写类 op 的审批闸：与工具调用同一套裁决（`approval.decide`），所以权限模式
     * （只读 / 自动编辑 / 完全访问 / AI 审查）对"文件面板里按一下暂存"同样成立，
     * 不需要给界面另立一套策略。
     *
     * 不带 `sessionPath`：`ApprovalRequest` 缺它时归到**当前会话**（宿主的 `pathOf` 口径），
     * 这与界面按钮"点的是我正在看的这个会话"一致。
     *
     * 失败方向：**审批服务没起来就拒**——宁可这次点不动，也不要在没有闸门的情况下改仓库。
     */
    const requireWriteApproval = async (
      op: DockWriteOp,
      payload: Record<string, unknown>,
      cwd: string,
    ): Promise<void> => {
      const approval = ctx.get('approval')
      if (approval === undefined) throw new Error(`写操作 ${op} 需要审批服务，但它没有起来`)
      const label = DOCK_WRITE_LABEL[op]
      const decision = await approval.decide(
        { toolName: label.toolName, argsSummary: label.summary(payload), args: { ...payload }, cwd },
        new AbortController().signal,
      )
      if (decision === 'reject') throw new Error(`已拒绝：${label.toolName}`)
    }

    const runOp = async (op: string, payload: Record<string, unknown>, cwd: string): Promise<unknown> => {
      switch (op) {
        // ---- 终端（管道模式；无 tty，交互式全屏程序不可用） ----
        case 'term-spawn': {
          const id = `t${++termSeq}`
          const dir = resolve(cwd, safeArg(payload.cwd ?? '.', true))
          if (!inside(dir, cwd)) throw new Error('路径超出工作目录')
          // shell 白名单：非白名单值回落 PowerShell
          const shell = ['powershell', 'pwsh', 'cmd', 'bash', 'node'].includes(String(payload.shell ?? ''))
            ? String(payload.shell)
            : 'powershell'
          const child = spawnShell(shell, dir)
          terms.set(id, child)
          child.stdout?.on('data', (chunk: Buffer) => ctx.emit('dsc/dock-data', id, chunk.toString()))
          child.stderr?.on('data', (chunk: Buffer) => ctx.emit('dsc/dock-data', id, chunk.toString()))
          child.on('exit', (code) => {
            terms.delete(id)
            ctx.emit('dsc/dock-data', id, `\r\n[终端会话已退出（code ${code ?? 0}）]\r\n`)
          })
          return { id, shell }
        }
        case 'term-input': {
          const child = terms.get(String(payload.id ?? ''))
          if (child === undefined) throw new Error('终端会话不存在')
          child.stdin?.write(String(payload.data ?? ''))
          return { ok: true }
        }
        case 'term-kill': {
          const child = terms.get(String(payload.id ?? ''))
          if (child !== undefined) {
            terms.delete(String(payload.id ?? ''))
            child.kill()
          }
          return { ok: true }
        }

        // ---- 文件系统（限 cwd 内） ----
        case 'fs-list': {
          const dir = resolve(cwd, safeArg(payload.dir ?? '.'))
          if (!inside(dir, cwd)) throw new Error('路径超出工作目录')
          const maxEntries = typeof payload.maxEntries === 'number' && payload.maxEntries > 0 ? Math.floor(payload.maxEntries) : 2000
          const listed = readdirSync(dir, { withFileTypes: true })
          const entries = listed.slice(0, maxEntries).map((entry) => {
            let size = 0
            if (!entry.isDirectory()) {
              try {
                size = statSync(join(dir, entry.name)).size
              } catch {
                size = 0
              }
            }
            return { name: entry.name, dir: entry.isDirectory(), size }
          })
          entries.sort((a, b) => (a.dir === b.dir ? NAME_COLLATOR.compare(a.name, b.name) : a.dir ? -1 : 1))
          return { cwd: dir, entries, truncated: listed.length > maxEntries }
        }
        case 'fs-read': {
          const file = resolve(cwd, safeArg(payload.file ?? '.'))
          if (!inside(file, cwd)) throw new Error('路径超出工作目录')
          const stat = statSync(file)
          const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
          const mime = IMAGE_MIME[ext]
          if (mime !== undefined) {
            // 图片按 base64 回给 renderer 画 <img>（SVG 也是图片路，免得当文本读成 XML）
            if (stat.size > 5 * 1024 * 1024) return { path: file, kind: 'image', tooLarge: true, mime, base64: '' }
            return { path: file, kind: 'image', tooLarge: false, mime, base64: readFileSync(file).toString('base64') }
          }
          const bytesMime = BYTES_MIME[ext]
          if (bytesMime !== undefined) {
            // PDF / XLSX 整读成 base64，renderer 侧再解析渲染（≤10MB，超限不读）
            if (stat.size > 10 * 1024 * 1024) return { path: file, kind: 'bytes', tooLarge: true, mime: bytesMime, base64: '', size: stat.size }
            return { path: file, kind: 'bytes', tooLarge: false, mime: bytesMime, base64: readFileSync(file).toString('base64'), size: stat.size }
          }
          if (BINARY_EXTS.has(ext)) {
            return { path: file, kind: 'binary', tooLarge: false, size: stat.size }
          }
          if (stat.size > 512 * 1024) return { path: file, kind: 'text', tooLarge: true, text: '' }
          return { path: file, kind: 'text', tooLarge: false, text: readFileSync(file, 'utf8') }
        }

        // ---- git（execFile 固定子命令） ----
        case 'git-status': {
          // 空仓库（尚无任何提交）时 HEAD 不存在：git 把分支名打到 stdout 但退出码 128，
          // 这里按读不到处理，显示占位分支名
          const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
            .then((out) => out.trim())
            .catch(() => '(无提交)')
          // 工作目录在仓库里的前缀：porcelain / numstat 报的都是仓库根相对路径，展示要剥掉
          // 它、范围要收在它之内（见 toWorkspacePath）。
          const prefix = await repoPrefix(cwd)
          // `-z`：路径原样给（默认的 C 引号会把非 ASCII 路径写成 `"a\350b"`，界面点不动）
          const porcelain = await git(cwd, ['status', '--porcelain=v1', '-z'])
          const staged: string[] = []
          const unstaged: string[] = []
          const untrackedRepo: string[] = []
          let dirtyFileCount = 0
          for (const { code, file } of parsePorcelainZ(porcelain)) {
            const path = toWorkspacePath(file, prefix)
            // 工作目录之外的变更整条不列（对齐参考实现，也与 inside() 的安全边界一致）。
            if (path === null) continue
            dirtyFileCount += 1
            if (code === '??') untrackedRepo.push(path)
            else {
              if (code[0] !== ' ' && code[0] !== '?') staged.push(`${code} ${path}`)
              if (code[1] !== ' ') unstaged.push(`${code} ${path}`)
            }
          }
          // `stats: true` = 状态面板「Git 工具」区与 Git 页签文件行要的每文件增删行数。
          // 已暂存 = index vs HEAD；未暂存 = worktree vs index——两段分开拿才给得出每文件
          // 数字（空仓库里 `--cached` 是「相对空树」，照样算得出）。
          if (payload.stats !== true) return { branch, staged, unstaged, untracked: untrackedRepo }
          const [stagedNumstat, unstagedNumstat] = await Promise.all([
            git(cwd, ['diff', '--cached', '--numstat', '-z']).catch(() => ''),
            git(cwd, ['diff', '--numstat', '-z']).catch(() => ''),
          ])
          const stagedStats = workspaceNumstat(prefix, stagedNumstat)
          const unstagedStats = workspaceNumstat(prefix, unstagedNumstat)
          // 未跟踪不在 diff 里：逐文件读内容数换行符（≤1MiB、含 NUL 记 0、removed 恒 0）。
          const untrackedLineMap = await untrackedLineStats(cwd, untrackedRepo)
          const untracked: string[] = []
          const untrackedStats: Record<string, { added: number; removed: number }> = {}
          for (const path of untrackedRepo) {
            const added = untrackedLineMap.get(path) ?? 0
            // 0 增 0 删的未跟踪项不进列表（目录折叠条目 `…/` 结尾的保留）——空文件、构建
            // 产物、读不动的二进制不该以 +0/−0 占着列表；目录条目仍留作暂存入口。
            if (added === 0 && !path.endsWith('/')) continue
            untracked.push(path)
            untrackedStats[path] = { added, removed: 0 }
          }
          let added = 0
          let removed = 0
          for (const stat of [...Object.values(stagedStats), ...Object.values(unstagedStats), ...Object.values(untrackedStats)]) {
            added += stat.added
            removed += stat.removed
          }
          return { branch, staged, unstaged, untracked, added, removed, dirtyFileCount, stagedStats, unstagedStats, untrackedStats }
        }
        case 'git-branches': {
          // 本地分支清单（输入框上那颗分支钮的菜单读它）。排序照参考实现：当前分支永远
          // 第一，其余按「最后一次提交时间」从新到旧——刚动过的分支最可能是要切的那个。
          // 空仓库（还没提交过）时 `refs/heads` 是空的，但 HEAD 那个分支名仍然有意义，
          // 所以把 `rev-parse --abbrev-ref HEAD` 的结果补进清单里（它不在 refs 里）。
          const head = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
            .then((out) => out.trim())
            .catch(() => '')
          const detached = head === 'HEAD'
          const current = detached ? '' : head
          const records = await git(cwd, [
            'for-each-ref',
            'refs/heads',
            // 名字 + 最后一次提交的 unix 秒（排序用）。%00 是 NUL：分支名里可能有空格，
            // 拿 \t 或空格切都会切坏。参考实现这一条还带 upstream 与 objectname，
            // dsc 的菜单不显示它们，就不多取。
            '--format=%(refname:short)%00%(committerdate:unix)',
          ])
            .then((out) => out.split('\n').map((line) => line.trimEnd()).filter((line) => line !== ''))
            .catch(() => [] as string[])
          interface BranchRow {
            name: string
            current: boolean
            at: number
          }
          const rows: BranchRow[] = []
          for (const line of records) {
            const [name = '', at = ''] = line.split('\0')
            if (name === '') continue
            const seconds = Number.parseInt(at, 10)
            rows.push({ name, current: name === current, at: Number.isFinite(seconds) ? seconds : 0 })
          }
          if (current !== '' && !rows.some((row) => row.name === current)) {
            rows.push({ name: current, current: true, at: Number.POSITIVE_INFINITY })
          }
          rows.sort((left, right) => (left.current !== right.current ? (left.current ? -1 : 1) : right.at - left.at))
          return {
            current,
            detached,
            // 空仓库时 current 是 git 给的那个默认分支名（如 master），但它还不在清单里
            // 也算「当前」——前端拿 current 判重，所以这里不重复上报。
            branches: rows.map((row) => ({ name: row.name, current: row.current })),
          }
        }
        case 'git-stage': {
          const files = (Array.isArray(payload.files) ? payload.files : []).map((file) => safeArg(file))
          await git(cwd, ['add', '--', ...files])
          return { ok: true }
        }
        case 'git-unstage': {
          const files = (Array.isArray(payload.files) ? payload.files : []).map((file) => safeArg(file))
          await git(cwd, ['reset', 'HEAD', '--', ...files])
          return { ok: true }
        }
        case 'git-commit': {
          const text = safeArg(payload.message, true)
          if (text.trim() === '') throw new Error('提交信息为空')
          // 提交对话框勾了未暂存文件时一次带过来：先暂存这批路径再提交，两步同属这一条
          // 写类 op（同一张审批卡覆盖），免得「暂存」与「提交」各弹一次。
          const paths = (Array.isArray(payload.paths) ? payload.paths : []).map((file) => safeArg(file))
          if (paths.length > 0) await git(cwd, ['add', '--', ...paths])
          return { ok: true, output: (await git(cwd, ['commit', '-m', text])).slice(0, 1200) }
        }
        case 'git-checkout': {
          // `switch --no-guess`（git ≥ 2.23）：`checkout <名字>` 在同名文件存在时会有
          // 「是分支还是路径」的歧义，`--no-guess` 也不会顺手替用户从远端建分支。
          // 工作树有冲突性的改动时 git 自己会拒（stderr 里说得清清楚楚），原样抛给界面。
          const branch = safeArg(payload.branch)
          if (branch === '') throw new Error('没有指定要切到哪个分支')
          await git(cwd, ['switch', '--no-guess', branch])
          return { ok: true, branch }
        }
        case 'git-branch-create': {
          const name = safeArg(payload.branch)
          if (name.trim() === '') throw new Error('没有指定新分支名')
          await git(cwd, ['switch', '--no-guess', '-c', name])
          return { ok: true, branch: name }
        }
        case 'git-log': {
          return {
            log: await git(cwd, ['log', '--pretty=format:%h%x09%an%x09%ad%x09%s', '--date=short', '-n', '30']),
          }
        }
        case 'git-diff': {
          // file 为空 = 全部未提交改动（tracked 段含已暂存 + 未暂存，外加未跟踪的合成段）；
          // 指定文件 = 单文件。`staged: true` 时单文件只取已暂存段（index vs HEAD）。
          // --no-textconv --no-ext-diff 是 codex /diff 的 git 安全姿势：文本转换与
          // 外部 diff driver 都可能配置成执行任意程序，看个 diff 不该替用户跑它们。
          const guard = ['--no-textconv', '--no-ext-diff']
          const file = typeof payload.file === 'string' ? safeArg(payload.file) : ''
          const staged = payload.staged === true
          const untracked = await untrackedPaths(cwd)
          if (file !== '') {
            // 未跟踪的目录条目带尾斜杠（`dsh-TUI/`）：两边都剥掉再比，别让尾斜杠把它
            // 甩进 tracked 那一路（那样只会回一份空 diff，看着像「没改动」）。
            const wanted = file.replace(/\/+$/, '')
            if (!staged && untracked.some((path) => path.replace(/\/+$/, '') === wanted)) {
              const preview = untrackedPreview(cwd, file)
              return preview.patch === ''
                ? { diff: '', note: preview.note }
                : { diff: preview.patch.slice(0, 20000) }
            }
            return { diff: (await trackedDiff(cwd, guard, file, staged)).slice(0, 20000) }
          }
          // 全量：tracked 段打头，未跟踪的按内容合成段跟上（git 自己不为未跟踪文件出
          // patch，但「全部改动」的条数本来就含它们，看不到会像坏掉）。
          const chunks = await trackedDiff(cwd, guard).then((text) => (text === '' ? [] : [text]))
          let synthesized = 0
          let bytes = 0
          let skipped = 0
          for (const path of untracked) {
            if (synthesized >= UNTRACKED_PREVIEW_MAX_FILES || bytes >= UNTRACKED_PREVIEW_MAX_TOTAL_BYTES) {
              skipped += 1
              continue
            }
            const preview = untrackedPreview(cwd, path)
            if (preview.patch === '') {
              skipped += 1
              continue
            }
            synthesized += 1
            bytes += preview.patch.length
            chunks.push(preview.patch)
          }
          return {
            diff: chunks.join('\n').slice(0, 20000),
            note: skipped === 0 ? '' : `另有 ${skipped} 个未跟踪条目没有合成预览，点这些行看各自的原因。`,
          }
        }
        default:
          throw new Error(`dock 未知操作：${op}`)
      }
    }

    /**
     * 一次 dock 请求：取当前会话的工作目录 → 写类先过审批闸 → 执行 → 写类落盘后催一拍
     * git 读数。
     *
     * 催拍那一步是给界面那颗分支钮（宿主快照面 `surfaces.git`）的：提交 / 暂存 / 切分支 /
     * 建分支都改了「当前分支 + 改动计数」，界面正盯着这一步的结果，不该等下一个 12 秒。
     */
    const handle = async (op: string, payload: Record<string, unknown>): Promise<unknown> => {
      // 基准目录按「当前会话」现取：切会话后下一次读取就落到新工作区（终端/git 同理）。
      const cwd = baseCwd()
      // 写类先过闸，再进 switch（闸门只挡写类，读类与终端不受影响）。
      const write = isDockWriteOp(op)
      if (write) await requireWriteApproval(op, payload, cwd)
      const out = await runOp(op, payload, cwd)
      if (write) ctx.get('git')?.refresh()
      return out
    }

    ctx.provide('dock', { handle })
    // 热卸载必须收干净（2026-09-29 审查）：终端子进程不杀会继续往 dsc/dock-data 吐输出。
    return () => {
      for (const child of terms.values()) {
        try {
          child.kill()
        } catch {
          // 已退出的进程 kill 会报错：忽略，目的已达到
        }
      }
      terms.clear()
    }
  },
}

/** 路径是否落在 root 内（Windows 大小写归一）。 */
function inside(path: string, root: string): boolean {
  if (!isAbsolute(path)) return false
  const rel = relative(resolve(root), resolve(path)).toLowerCase()
  return rel === '' || (!rel.startsWith('..') && !rel.split(/[\\/]/)[0]!.includes(':'))
}
