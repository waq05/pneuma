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
import { execFile, spawn } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import type { ChildProcess } from 'node:child_process'
import { DOCK_WRITE_LABEL, isDockWriteOp, type DockWriteOp } from '../core/dock-ops.js'

/** 受控执行 git（固定首参字面量 + 参数数组；无 shell）。超时由 execFile 自己收进程。 */
function git(cwd: string, args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolveDone, rejectDone) => {
    execFile(
      'git',
      args,
      // timeout 原来只在自己这层 reject，git 进程继续跑（2026-09-29 审查）：
      // 交给 execFile 的 timeout + killSignal，超时连进程一起收掉。
      { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error !== undefined && error !== null) {
          rejectDone(new Error(String(stderr || error.message).slice(0, 800)))
        } else {
          resolveDone(String(stdout))
        }
      },
    )
  })
}

/** 参数净化：拒绝空字节/换行与选项注入位。 */
function safeArg(value: unknown, allowNewline = false): string {
  const text = String(value ?? '')
  if (text.includes('\0')) throw new Error('非法参数')
  if (!allowNewline && text.includes('\n')) throw new Error('非法参数：含换行')
  if (text.startsWith('-')) throw new Error('非法参数：以 - 开头')
  return text
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

    const handle = async (op: string, payload: Record<string, unknown>): Promise<unknown> => {
      // 基准目录按「当前会话」现取：切会话后下一次读取就落到新工作区（终端/git 同理）。
      const cwd = baseCwd()
      // 写类先过闸，再进 switch（闸门只挡写类，读类与终端不受影响）。
      if (isDockWriteOp(op)) await requireWriteApproval(op, payload, cwd)
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
          // 空仓库（尚无任何提交）时 HEAD 不存在——显示占位分支名
          const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
            .then((out) => out.trim())
            .catch(() => '(无提交)')
          const porcelain = await git(cwd, ['status', '--porcelain=v1'])
          const staged: string[] = []
          const unstaged: string[] = []
          const untracked: string[] = []
          let dirtyFileCount = 0
          for (const line of porcelain.split('\n').filter((line) => line !== '')) {
            dirtyFileCount += 1
            const code = line.slice(0, 2)
            const file = line.slice(3)
            if (code === '??') untracked.push(file)
            else {
              if (code[0] !== ' ' && code[0] !== '?') staged.push(`${code} ${file}`)
              if (code[1] !== ' ') unstaged.push(`${code} ${file}`)
            }
          }
          // `stats: true` = 状态面板「Git 工具」区要的那对增删行数（Git 页签不带它，
          // 免得每次刷新多跑一条 git）。口径：tracked 改动的 numstat 汇总（已暂存 +
          // 未暂存都在 `diff HEAD` 里），二进制文件 numstat 给 `-`、记 0；
          // untracked 不进 diff（行数未知），只进 dirtyFileCount。
          if (payload.stats !== true) return { branch, staged, unstaged, untracked }
          let numstat = ''
          try {
            numstat = await git(cwd, ['diff', 'HEAD', '--numstat'])
          } catch {
            // 空仓库（还没有 HEAD）没有「相对 HEAD」的 diff：分未暂存 + 已暂存两段算。
            const parts = await Promise.all([
              git(cwd, ['diff', '--numstat']).catch(() => ''),
              git(cwd, ['diff', '--cached', '--numstat']).catch(() => ''),
            ])
            numstat = parts.join('\n')
          }
          let added = 0
          let removed = 0
          for (const line of numstat.split('\n')) {
            if (line.trim() === '') continue
            const [addText, removeText] = line.split('\t')
            const add = Number.parseInt(addText ?? '', 10)
            const remove = Number.parseInt(removeText ?? '', 10)
            if (Number.isFinite(add)) added += add
            if (Number.isFinite(remove)) removed += remove
          }
          return { branch, staged, unstaged, untracked, added, removed, dirtyFileCount }
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
          return { ok: true, output: (await git(cwd, ['commit', '-m', text])).slice(0, 1200) }
        }
        case 'git-log': {
          return {
            log: await git(cwd, ['log', '--pretty=format:%h%x09%an%x09%ad%x09%s', '--date=short', '-n', '30']),
          }
        }
        case 'git-diff': {
          // file 为空 = 全量未提交改动（含已暂存）；指定文件 = 单文件。
          // --no-textconv --no-ext-diff 是 codex /diff 的 git 安全姿势：文本转换与
          // 外部 diff driver 都可能配置成执行任意程序，看个 diff 不该替用户跑它们。
          const guard = ['--no-textconv', '--no-ext-diff']
          const file = typeof payload.file === 'string' ? safeArg(payload.file) : ''
          const args = file === '' ? ['diff', 'HEAD', ...guard] : ['diff', 'HEAD', ...guard, '--', file]
          return { diff: (await git(cwd, args)).slice(0, 20000) }
        }
        default:
          throw new Error(`dock 未知操作：${op}`)
      }
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
