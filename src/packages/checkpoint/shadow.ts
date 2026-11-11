/**
 * 影子 git 仓库：把**工作区**按回合存成快照，但不碰用户自己的 `.git`。
 *
 * ## 为什么另起一个仓库
 *
 * 「模型改坏文件后能回到某回合之前」需要一个跨回合的时间轴。直接用用户工作区里的
 * `.git` 有三个问题：工作区可能根本不是仓库；模型自己的改动会混进用户的分支与暂存区；
 * 还原时要动用户的索引。影子仓库放在 `~/.dsc/checkpoints/`，靠 `GIT_DIR` /
 * `GIT_WORK_TREE` / `GIT_INDEX_FILE` 三个变量指过去，用户那份仓库一个字节都不碰。
 *
 * ## 为什么回合号落盘
 *
 * 从消息数推回合号是错的：压缩会改消息数，`/compact` 一次前后同一回合会被数成两回合，
 * 前一次压缩之后所有快照的编号都会漂。所以 `state.json` 只记 `lastTurn`，每回合显式 +1。
 *
 * ## 为什么先剥 `GIT_*` 再叠
 *
 * 见 `core/git-exec.ts`：用户 shell 里的 `GIT_DIR` 会把每条命令带到别的仓库去；
 * 只叠我们自己的值挡不住没传的那几个。
 *
 * ## 还原为什么不是 `reset --hard`
 *
 * `/checkpoint restore <回合>` 要把工作区退回该回合**开始时**，但用户在这个回合之后
 * 很可能又手改过同一批文件。`reset --hard` 会把用户的手改一起抹掉，`clean` 会删掉
 * 未跟踪的新文件——两条都禁用。这里逐路径判「用户动过没有」，动过的走三方合并；
 * 合并不干净就整次不写盘，宁可什么都不做也不留一个半还原的工作区（判定细节见
 * {@link restoreTurn}）。
 *
 * @module dsc/plugins/checkpoint/shadow
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { errText } from '@pneuma/runtime/core/err-text.js'
import { git } from '@pneuma/runtime/core/git-exec.js'
import { DSC_HOME, dscPath } from '@pneuma/runtime/core/path-policy.js'

/** 快照一条的记录（`listSnapshots` 的返回项）。 */
export interface SnapshotInfo {
  /** 标签全名，例如 `dsc/turn-3-pre` 或 `dsc/manual-restore-20261111-170500`。 */
  tag: string
  /** 第几回合（从 1 起）；手动还原自己存的那张给 0。 */
  turn: number
  /** 回合前 / 回合后 / 还原前（`/checkpoint restore` 自己拍的那一张）。 */
  label: 'pre' | 'post' | 'manual'
  /** 提交时间（ISO 8601，带时区）。 */
  at: string
  /** 提交说明。 */
  message: string
}

/** 一次快照的结果：失败不抛，交给调用方决定记日志还是说话。 */
export interface SnapshotResult {
  ok: boolean
  commit?: string
  turn?: number
  error?: string
}

/** 影子仓库的两个坐标。 */
export interface ShadowRepo {
  /** `~/.dsc/checkpoints/<slug>-<hash8>`（仓库本体在它下面的 `repo/`）。 */
  root: string
  /** 真正的 git 目录。 */
  repo: string
}

/** 影子仓库的落盘状态：只有回合号，别的东西都能从 git 里读回来。 */
interface ShadowState {
  lastTurn: number
}

/** git 的默认超时：`git add -A` 在大工作区上会比普通读命令慢，给足两分钟。 */
const SNAPSHOT_TIMEOUT_MS = 120_000

/** 两种标签：回合快照（`dsc/turn-3-pre`）与还原前自己存的那张（`dsc/manual-restore-20261111-170500`）。 */
const TURN_TAG = /^dsc\/turn-(\d+)-(pre|post)$/
const MANUAL_TAG = /^dsc\/manual-restore-\d{8}-\d{6}$/

/** 每次调用都带的配置：换行符不转换（否则 Windows 上每次快照都像改了全文）、自动 gc 关掉。 */
const GIT_CONFIG_ARGS = ['-c', 'core.autocrlf=false', '-c', 'gc.auto=0']

/**
 * 路径的归一化键：同一目录的不同写法（`D:\a\b` 与 `D:/a/b/`）折成同一串。
 *
 * Windows 上再转小写：`D:\Proj` 与 `d:\proj` 是同一个目录，不折的话同一个工作区会得到
 * 两个影子仓库，快照历史当场断成两截。
 */
function pathKey(cwd: string): string {
  const normalized = resolve(cwd).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** 目录名里能用的 slug：只留字母数字与 `._-`，其余压成一个短横。 */
function slugOf(cwd: string): string {
  const raw = basename(resolve(cwd))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40)
  return raw === '' ? 'workspace' : raw
}

/**
 * 这个工作区的影子仓库根：`<DSC_HOME>/checkpoints/<slug>-<hash8>`。
 *
 * hash 取归一化路径的 sha1 前 8 位：slug 只为了人看得懂，真正防撞的是这 8 位。
 * **绝不把仓库放进用户工作区**——放进去就会出现在用户的 `git status` 里，
 * 还会被下一次 `add -A` 自己收进来。
 */
export function shadowRoot(cwd: string): string {
  const digest = createHash('sha1').update(pathKey(cwd)).digest('hex').slice(0, 8)
  return dscPath('checkpoints', `${slugOf(cwd)}-${digest}`)
}

/** 这个工作区的影子 git 目录（`<root>/repo`）。 */
export function shadowRepoPath(cwd: string): string {
  return join(shadowRoot(cwd), 'repo')
}

/** `state.json` 的位置。 */
function statePath(cwd: string): string {
  return join(shadowRoot(cwd), 'state.json')
}

/** 读回合状态；文件不在或坏了都按 0（下一次快照从第 1 回合起）。 */
function readState(cwd: string): ShadowState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(cwd), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const lastTurn = Number((parsed as { lastTurn?: unknown }).lastTurn)
      if (Number.isFinite(lastTurn) && lastTurn >= 0) return { lastTurn: Math.floor(lastTurn) }
    }
  } catch {
    // 读不到就当没有：快照本身仍然有用，不能因为一本状态文件坏了就停
  }
  return { lastTurn: 0 }
}

/** 写回合状态（目录不存在就建）。 */
function writeState(cwd: string, state: ShadowState): void {
  mkdirSync(shadowRoot(cwd), { recursive: true })
  writeFileSync(statePath(cwd), `${JSON.stringify(state)}\n`, 'utf8')
}

/**
 * 影子仓库要排除的东西。
 *
 * 为什么用 `info/exclude` 而不是 `.gitignore`：`.gitignore` 要提交进历史，等于替用户
 * 决定哪些文件不该进版本库；`info/exclude` 只影响这个影子仓库自己。
 * `<DSC_HOME>` 若落在工作区里也排除——否则影子仓库会把自己拍进自己。
 */
function excludePatterns(cwd: string): string[] {
  const patterns = [
    'node_modules/',
    // 不带斜杠：用户的工作区可能是 git worktree / submodule，那里的 `.git` 是文件不是目录。
    '.git',
    'dist/',
    // `dist-next/`、`dist-foo/` 这类并行构建目录：只写 `dist/` 挡不住它们，
    // 而这些目录里常常躺着几百 MB 的安装包（实测本仓 1.1GB），首次快照会把它们全哈希一遍。
    'dist*/',
    'release/',
    'build/',
    'out/',
    'coverage/',
    '.next/',
    '.turbo/',
    'target/',
    '*.log',
  ]
  const rel = relative(resolve(cwd), resolve(DSC_HOME)).replace(/\\/g, '/')
  if (rel !== '' && !rel.startsWith('..') && !rel.startsWith('/')) patterns.push(`${rel.replace(/\/+$/, '')}/`)
  return patterns
}

/** 指到影子仓库的环境变量：三个一起给才是真隔离。 */
function shadowEnv(cwd: string): Record<string, string> {
  const repo = shadowRepoPath(cwd)
  return {
    GIT_DIR: repo,
    GIT_WORK_TREE: resolve(cwd),
    GIT_INDEX_FILE: join(repo, 'index'),
  }
}

/**
 * 在影子仓库里跑一条 git（固定带换行符与 gc 配置）。
 *
 * `extraEnv` 只给还原用：把 `GIT_INDEX_FILE` 换成一个临时索引，就能从快照里把文件取到
 * 临时目录而不动影子仓库自己的索引。
 */
function shadowGit(
  cwd: string,
  args: string[],
  timeoutMs = SNAPSHOT_TIMEOUT_MS,
  extraEnv?: Record<string, string>,
): Promise<string> {
  return git(cwd, [...GIT_CONFIG_ARGS, ...args], timeoutMs, { ...shadowEnv(cwd), ...extraEnv })
}

/**
 * 确保影子仓库存在：没有就 `git init --bare`，然后刷新 `info/exclude` 与回合状态。
 *
 * 为什么是 bare：我们只用一个索引 + 对象库，不需要工作树里的 `.git`；bare 少一层嵌套，
 * 也不会让 `git` 误认工作区里的父仓库。
 */
export async function ensureRepo(cwd: string): Promise<ShadowRepo> {
  const root = shadowRoot(cwd)
  const repo = shadowRepoPath(cwd)
  mkdirSync(root, { recursive: true })
  if (!existsSync(join(repo, 'HEAD'))) {
    await git(cwd, ['init', '--bare', repo], 60_000)
  }
  mkdirSync(join(repo, 'info'), { recursive: true })
  writeFileSync(join(repo, 'info', 'exclude'), `${excludePatterns(cwd).join('\n')}\n`, 'utf8')
  await excludeOversize(cwd, repo)
  if (!existsSync(statePath(cwd))) writeState(cwd, { lastTurn: 0 })
  return { root, repo }
}

/** 单个文件超过这个体积就不进快照（哈希几百 MB 的安装包会让首次快照卡十几秒）。 */
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024

/**
 * 把超大文件逐条写进 `info/exclude`，只做一次（`info/oversize-done` 当标记）。
 *
 * 为什么要单独一趟：`git add -A` 会对每个候选文件算哈希，1GB 的安装包就是十几秒。
 * 这里只 `stat` 不读内容，代价是几百毫秒；随后 `add -A` 直接跳过它们。
 * 代价是：文件后来缩小了也仍然被排除——这是可接受的，比每次回合都卡十几秒划算。
 */
async function excludeOversize(cwd: string, repo: string): Promise<void> {
  const marker = join(repo, 'info', 'oversize-done')
  if (existsSync(marker)) return
  const big: string[] = []
  try {
    const listed = await shadowGit(cwd, ['ls-files', '-z', '-o', '--exclude-standard'], 60_000)
    const tracked = await shadowGit(cwd, ['ls-files', '-z'], 60_000)
    const paths = [...new Set([...listed.split('\0'), ...tracked.split('\0')].filter((item) => item !== ''))]
    for (const path of paths) {
      try {
        if (statSync(join(cwd, path)).size > MAX_SNAPSHOT_BYTES) big.push(path)
      } catch {
        // 文件刚好被删掉：不管它，下一趟也不会有它
      }
    }
  } catch {
    // 扫不出来就当没有超大文件：快照照常做，只是可能慢一点
  }
  if (big.length > 0) {
    // 开头加 `/`：锚定在工作区根，避免同名的深层文件被误伤
    const lines = big.map((path) => `/${path.replace(/\\/g, '/')}`).join('\n')
    appendFileSync(join(repo, 'info', 'exclude'), `${lines}\n`, 'utf8')
  }
  try {
    writeFileSync(marker, `${String(big.length)}\n`, 'utf8')
  } catch {
    // 标记写不进去只是下次再扫一遍，不影响正确性
  }
}

/** 当前回合号（0 = 还没开过回合）。 */
export function currentTurn(cwd: string): number {
  return readState(cwd).lastTurn
}

/**
 * 回合开始时把回合号 +1，并返回新号。
 *
 * 只在这里自增：回合内 pre / post 两次快照必须共用同一个号，否则一次对话会被拆成两回合。
 */
export async function bumpTurn(cwd: string): Promise<number> {
  await ensureRepo(cwd)
  const next = readState(cwd).lastTurn + 1
  writeState(cwd, { lastTurn: next })
  return next
}

/**
 * 拍一份快照：`git add -A` → 提交（允许空提交）→ 打/改标签 `dsc/turn-<n>-<label>`。
 *
 * `add -A` 失败直接返回错误：此时提交只会把上一次的索引再提交一遍，看起来成功、内容却是旧的。
 */
export async function snapshot(
  cwd: string,
  label: 'pre' | 'post',
  message: string,
): Promise<SnapshotResult> {
  try {
    await ensureRepo(cwd)
    const turn = Math.max(1, readState(cwd).lastTurn)
    return await capture(cwd, `dsc/turn-${String(turn)}-${label}`, message, turn)
  } catch (error) {
    return { ok: false, error: errText(error) }
  }
}

/**
 * 拍一张「还原前」的快照，标签 `dsc/manual-restore-<时间戳>`。
 *
 * 为什么要它：还原会写盘，写错了就没有退路。这张快照让「刚才那次还原」本身也能再还原一次，
 * 而且它与回合号无关——还原不推进回合，也不该混进 `dsc/turn-*` 的时间轴里。
 */
export async function snapshotManual(
  cwd: string,
  at: Date = new Date(),
): Promise<{ ok: boolean; tag?: string; error?: string }> {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${String(at.getFullYear())}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  const tag = `dsc/manual-restore-${stamp}`
  try {
    await ensureRepo(cwd)
    const result = await capture(cwd, tag, `manual restore ${stamp}`, 0)
    return result.ok ? { ok: true, tag } : { ok: false, error: result.error }
  } catch (error) {
    return { ok: false, error: errText(error) }
  }
}

/** 快照的公共部分：`add -A` → 提交 → 打标签。两个入口（回合 / 还原前）只差标签与说明。 */
async function capture(cwd: string, tag: string, message: string, turn: number): Promise<SnapshotResult> {
  try {
    try {
      await shadowGit(cwd, ['add', '-A'])
    } catch (error) {
      return { ok: false, turn, error: `git add -A 失败：${errText(error)}` }
    }
    await shadowGit(cwd, [
      '-c', 'user.name=dsc',
      '-c', 'user.email=dsc@local',
      'commit',
      '--allow-empty',
      '-m', message,
    ])
    const commit = (await shadowGit(cwd, ['rev-parse', 'HEAD'])).trim()
    await shadowGit(cwd, ['tag', '-f', tag, commit])
    return { ok: true, commit, turn }
  } catch (error) {
    return { ok: false, turn, error: errText(error) }
  }
}

/** 按提交时间倒序列出快照标签（回合快照与还原前的快照一起列）；仓库还没建时给空数组（不是错误）。 */
export async function listSnapshots(cwd: string, limit = 20): Promise<SnapshotInfo[]> {
  if (!existsSync(join(shadowRepoPath(cwd), 'HEAD'))) return []
  try {
    const out = await shadowGit(cwd, [
      'for-each-ref',
      '--sort=-creatordate',
      '--format=%(refname:short)%00%(creatordate:iso-strict)%00%(subject)',
      'refs/tags',
    ], 15_000)
    const entries: SnapshotInfo[] = []
    for (const record of out.split('\n')) {
      if (record.trim() === '') continue
      const [tag = '', at = '', ...rest] = record.split('\0')
      const turnHit = TURN_TAG.exec(tag)
      // 手动快照与回合快照同列：用户在 /checkpoint list 里看得出来「这张是还原前存的」。
      const manual = MANUAL_TAG.test(tag)
      if (turnHit === null && !manual) continue
      entries.push({
        tag,
        turn: turnHit === null ? 0 : Number(turnHit[1]),
        label: turnHit === null ? 'manual' : turnHit[2] === 'pre' ? 'pre' : 'post',
        at,
        message: rest.join('\0'),
      })
    }
    const capped = Math.max(1, Math.floor(limit))
    return entries.slice(0, capped)
  } catch {
    return []
  }
}

/**
 * 影子仓库现在占多少 MB（`git count-objects -v` 的 `size` + `size-pack`，单位 KiB）。
 *
 * 两个都算：松散的提交在第一次 gc 之前只进 `size`，打包之后才进 `size-pack`；
 * 只看一个，刚建仓的前几回合会永远显示 0。
 */
export async function repoSizeMB(cwd: string): Promise<number> {
  if (!existsSync(join(shadowRepoPath(cwd), 'HEAD'))) return 0
  try {
    const out = await shadowGit(cwd, ['count-objects', '-v'], 15_000)
    let kb = 0
    for (const line of out.split('\n')) {
      const matched = /^(?:size|size-pack):\s*(\d+)/.exec(line)
      if (matched !== null) kb += Number(matched[1])
    }
    return kb / 1024
  } catch {
    return 0
  }
}

// ── 还原（`/checkpoint restore <回合>`）──────────────────────────────────────

/**
 * 一处路径的还原判定。
 *
 * `write` 写回 A、`delete` 删掉（A 那时不存在）、`skip` 是用户自己已经改回起点、`conflict`
 * 是两边都动了同一段或没法安全合并——**有冲突时一个文件都不写**。
 */
export interface RestoreDecision {
  /** 工作目录相对路径（`/` 分隔，与快照里的写法一致）。 */
  path: string
  /** 写回 / 删除 / 跳过 / 冲突。 */
  action: 'write' | 'delete' | 'skip' | 'conflict'
  /** 冲突或跳过的一句话原因（给人看，不参与判定）。 */
  reason?: string
}

/** 一次还原的结果。`ok` 只表示「判定算完了」；有没有落盘看 `written` 与 `conflicts`。 */
export interface RestoreResult {
  ok: boolean
  turn: number
  /** 这一回合 pre 与 post 之间内容有差异的路径数（模型改过的全部文件）。 */
  changed: number
  /** 实际写盘（含删除）的次数；有冲突时一定是 0。 */
  written: number
  /** 跳过（用户已改回起点版本）的次数。 */
  skipped: number
  /** 冲突路径（有冲突时一个文件都不写）。 */
  conflicts: string[]
  /** 每一处的判定（冲突时也全有，便于排查）。 */
  decisions: RestoreDecision[]
  /** 还原前那张安全快照的标签。 */
  safetyTag?: string
  /** `bad-turn` / `missing` / `missing-post` / `safety:…` / 其它错误的一句话。 */
  error?: string
  /** `error === 'missing'` 时最近几个可用的回合号（新的在前）。 */
  available: number[]
}

/** 不做文本合并的体积上限：10MB 的文本合起来既慢又没人看得懂。 */
const MAX_MERGE_BYTES = 10 * 1024 * 1024

/** 快照树里的一个条目：`link` 来自 mode 120000（内容就是链接目标）。 */
interface TreeEntry {
  sha: string
  size: number
  kind: 'file' | 'link'
}

/** 磁盘上一个路径的现状。`other`（目录、设备…）用一个永远拼不出来的 sha 顶着，绝不与快照相等。 */
interface DiskState {
  sha: string | null
  size: number
  kind: 'file' | 'link' | 'other' | 'absent'
}

/** 内部的判定：比公开的那份多一个「写盘内容来自哪个临时文件」。 */
interface InternalPlan {
  path: string
  action: RestoreDecision['action']
  reason?: string
  /** 合并结果的临时文件；不给就用快照 A 取出来的那份。 */
  src?: string
}

/** blob 的 sha1：`blob <字节数>\0<内容>`，与 `git hash-object` 同口径（不算换行符转换）。 */
function blobSha(content: Buffer | string): string {
  const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  return createHash('sha1').update(`blob ${String(body.length)}\0`).update(body).digest('hex')
}

/** 磁盘文件的 blob sha：走流，2GB 的文件也不会整块读进内存。 */
async function fileSha(file: string, size: number): Promise<string> {
  const hash = createHash('sha1').update(`blob ${String(size)}\0`)
  await new Promise<void>((done, fail) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk: Buffer | string) => {
      hash.update(chunk)
    })
    stream.on('end', () => done())
    stream.on('error', fail)
  })
  return hash.digest('hex')
}

/** 磁盘上这一路径现在是什么：不存在 / 普通文件 / 符号链接 / 其它。 */
async function diskState(abs: string): Promise<DiskState> {
  try {
    const info = lstatSync(abs)
    if (info.isSymbolicLink()) {
      const target = readlinkSync(abs)
      return { sha: blobSha(target), size: Buffer.byteLength(target), kind: 'link' }
    }
    if (info.isFile()) return { sha: await fileSha(abs, info.size), size: info.size, kind: 'file' }
    return { sha: 'other', size: 0, kind: 'other' }
  } catch {
    return { sha: null, size: 0, kind: 'absent' }
  }
}

/** 一棵快照树里的全部文件：路径 → blob。`-z` 让非 ASCII 路径原样给出、不被引号转义。 */
async function readTree(cwd: string, rev: string): Promise<Map<string, TreeEntry>> {
  const out = await shadowGit(cwd, ['ls-tree', '-r', '-l', '-z', '--full-tree', rev], SNAPSHOT_TIMEOUT_MS)
  const entries = new Map<string, TreeEntry>()
  for (const record of out.split('\0')) {
    if (record === '') continue
    // 元数据与路径之间隔着第一个 TAB（路径里再有 TAB 也切不错）；元数据是 `mode type sha size`。
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [mode = '', type = '', sha = '', sizeText = '0'] = record.slice(0, tab).trim().split(/\s+/)
    if (type !== 'blob') continue
    entries.set(record.slice(tab + 1), {
      sha,
      size: Number(sizeText),
      kind: mode === '120000' ? 'link' : 'file',
    })
  }
  return entries
}

/** 路径在一棵树里的身份：内容 sha + 类型（换行符不计，只有模式变化时才会同 sha 不同类型）。 */
function treeKey(entry: TreeEntry | undefined): string {
  return entry === undefined ? '' : `${entry.kind}:${entry.sha}`
}

/**
 * 把一棵快照里的若干路径取到临时目录。
 *
 * 为什么不 `git show tag:path`：它走标准输出，`git()` 按 utf8 解码字符串，二进制会被改坏。
 * `read-tree` + `checkout-index --prefix` 只写文件、不过标准输出，字节原样。
 */
async function materialize(cwd: string, rev: string, paths: string[], dir: string): Promise<void> {
  if (paths.length === 0) return
  mkdirSync(dir, { recursive: true })
  const env = { GIT_INDEX_FILE: join(dir, '.index') }
  await shadowGit(cwd, ['read-tree', rev], SNAPSHOT_TIMEOUT_MS, env)
  // Windows 命令行有长度上限：一次一百条，路径多也不会撞上。
  for (let at = 0; at < paths.length; at += 100) {
    await shadowGit(
      cwd,
      ['checkout-index', '-f', `--prefix=${dir}${sep}`, '--', ...paths.slice(at, at + 100)],
      SNAPSHOT_TIMEOUT_MS,
      env,
    )
  }
}

/** 头 8KB 里有 NUL 就当二进制（与 git 自己的判法同口径）；读不开也按二进制处理。 */
function looksBinary(file: string): boolean {
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(8192)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, read).includes(0)
  } catch {
    return true
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

/**
 * 三方合并：`current` 是磁盘现状，`base` 是 M（回合末），`other` 是 A（回合初）。
 *
 * 语义就是「以 M 为基线，把 M→A 的改动（撤销模型的改动）合到 C 上」：用户在别处的手改
 * 原样保留。合并成功时结果直接写在 `current` 文件里；退出码 1（冲突）与更大的错误码
 * 都按「没成功」处理——两种都不写盘。
 */
async function mergeThreeWay(cwd: string, current: string, base: string, other: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-file', '-q', current, base, other], SNAPSHOT_TIMEOUT_MS)
    return true
  } catch {
    return false
  }
}

/** 写盘只能落在工作区里，且绝不进用户的 `.git`（影子仓库天然不在，这里是第二道闸）。 */
function writableInWorkspace(cwd: string, path: string): boolean {
  const rel = relative(resolve(cwd), resolve(cwd, path))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  return rel.split(/[\\/]/)[0] !== '.git'
}

/** 断言影子仓库与用户 `.git` 互不包含：任何一个方向成立都说明隔离破了，直接不还原。 */
function assertShadowIsolated(cwd: string): void {
  const repo = resolve(shadowRepoPath(cwd))
  const gitDir = resolve(cwd, '.git')
  const inside = (parent: string, child: string): boolean => {
    const rel = relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  if (inside(gitDir, repo)) throw new Error(`影子仓库落在用户的 .git 里（${repo}）`)
  if (inside(repo, gitDir)) throw new Error(`影子仓库包住了用户的 .git（${repo}）`)
}

/** 这个标签存在吗（`--quiet` 不给多余输出；不存在时 git 以非零退出）。 */
async function tagExists(cwd: string, tag: string): Promise<boolean> {
  try {
    await shadowGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], 15_000)
    return true
  } catch {
    return false
  }
}

/** 最近几个可用回合号（新的在前，只数回合快照）。 */
export async function availableTurns(cwd: string, limit = 5): Promise<number[]> {
  const entries = await listSnapshots(cwd, 500)
  const turns = new Set<number>()
  for (const entry of entries) if (entry.label !== 'manual') turns.add(entry.turn)
  return [...turns].sort((left, right) => right - left).slice(0, Math.max(1, limit))
}

/** 落盘一处：内容来自临时文件，按快照里的类型写成普通文件或符号链接。 */
function applyOne(abs: string, source: string, link: boolean): void {
  mkdirSync(dirname(abs), { recursive: true })
  // 先删再写：原位置可能是符号链接（只删链接本身）或只读文件。
  rmSync(abs, { force: true })
  if (link) symlinkSync(readFileSync(source, 'utf8'), abs)
  else copyFileSync(source, abs)
}

/**
 * 把工作区还原到第 `turn` 回合**开始时**的样子，同时保住用户手改的部分。
 *
 * 对每一处「模型在这一回合改过」的路径（pre 与 post 之间有差异），记 A = 起点版本、
 * M = 终点版本、C = 磁盘现状，按固定顺序判：
 *   1. C == M（用户没动过）→ 写回 A；A 那时不存在就删掉。
 *   2. C == A（用户自己改回去了）→ 跳过。
 *   3. 其余且两边都是文本 → `git merge-file` 做三方合并，成功才写。
 *   4. 二进制、超过 10MB、符号链接、模型新建/删除过而用户又改过的 → 冲突，不写。
 *
 * 什么都不写的情况：有任意一处冲突。这是硬规矩——半写的工作区比不还原更难收拾。
 * 还原前先拍一张 `dsc/manual-restore-<时间戳>`，所以还原本身还能再还原一次。
 */
export async function restoreTurn(cwd: string, turn: number): Promise<RestoreResult> {
  const wanted = Math.floor(turn)
  let written = 0
  let changed = 0
  let skipped = 0
  let temp: string | null = null
  const base: RestoreResult = {
    ok: false,
    turn: Number.isFinite(wanted) ? wanted : 0,
    changed: 0,
    written: 0,
    skipped: 0,
    conflicts: [],
    decisions: [],
    available: [],
  }
  if (!Number.isFinite(turn) || wanted < 1) return { ...base, error: 'bad-turn' }
  try {
    await ensureRepo(cwd)
    assertShadowIsolated(cwd)
    const preTag = `dsc/turn-${String(wanted)}-pre`
    const postTag = `dsc/turn-${String(wanted)}-post`
    if (!(await tagExists(cwd, preTag))) {
      return { ...base, error: 'missing', available: await availableTurns(cwd) }
    }
    if (!(await tagExists(cwd, postTag))) {
      return { ...base, error: 'missing-post', available: await availableTurns(cwd) }
    }

    // 先留退路：这张快照存不成就不动工作区。
    const safety = await snapshotManual(cwd)
    if (!safety.ok) return { ...base, error: `safety:${safety.error ?? '未知错误'}` }
    // 失败时也要能告诉用户「退路在哪」，所以记在 base 上。
    if (safety.tag !== undefined) base.safetyTag = safety.tag

    const pre = await readTree(cwd, preTag)
    const post = await readTree(cwd, postTag)
    const all = new Set([...pre.keys(), ...post.keys()])
    const paths = [...all].filter((path) => treeKey(pre.get(path)) !== treeKey(post.get(path))).sort()
    changed = paths.length

    const plans = new Map<string, InternalPlan>()
    const review: string[] = []
    const needPre: string[] = []
    const needPost: string[] = []

    for (const path of paths) {
      if (!writableInWorkspace(cwd, path)) {
        plans.set(path, { path, action: 'conflict', reason: '路径越出工作区' })
        continue
      }
      const abs = resolve(cwd, path)
      const a = pre.get(path)
      const m = post.get(path)
      const disk = await diskState(abs)

      // 1. 用户没动过：C 与 M 一样（都“不存在”也算）→ 写回 A。
      if (disk.sha === (m?.sha ?? null)) {
        if (a === undefined) plans.set(path, { path, action: 'delete', reason: '模型新建的，你没动过' })
        else {
          plans.set(path, { path, action: 'write', reason: '模型改过，你没动过' })
          needPre.push(path)
        }
        continue
      }
      // 2. 用户已经自己改回起点版本：跳过。
      if (disk.sha === (a?.sha ?? null)) {
        plans.set(path, { path, action: 'skip', reason: '你已经改回起点版本' })
        continue
      }
      // 3. 模型新建 / 删除过，用户又改过：A 或 M 缺一条，三方合并的基线不成立。
      if (a === undefined || m === undefined) {
        plans.set(path, { path, action: 'conflict', reason: '模型新建或删除过这个文件，你又改过它' })
        continue
      }
      // 4. 符号链接、超大文件、二进制：不做文本合并。
      if (a.kind === 'link' || m.kind === 'link' || disk.kind === 'link') {
        plans.set(path, { path, action: 'conflict', reason: '符号链接不做合并' })
        continue
      }
      if (disk.kind !== 'file') {
        plans.set(path, {
          path,
          action: 'conflict',
          reason: disk.kind === 'absent' ? '你已经删掉了这个文件' : '盘上这个路径不是普通文件',
        })
        continue
      }
      if (a.size > MAX_MERGE_BYTES || m.size > MAX_MERGE_BYTES || disk.size > MAX_MERGE_BYTES) {
        plans.set(path, { path, action: 'conflict', reason: '超过 10MB，不做文本合并' })
        continue
      }
      review.push(path)
      needPre.push(path)
      needPost.push(path)
    }

    if (needPre.length + needPost.length > 0) {
      temp = mkdtempSync(join(tmpdir(), 'dsc-restore-'))
      await materialize(cwd, preTag, needPre, join(temp, 'a'))
      await materialize(cwd, postTag, needPost, join(temp, 'm'))
    }

    // 第二轮：要合并的先取内容，二进制与冲突都在这里定。
    for (const [index, path] of review.entries()) {
      const aFile = join(temp ?? '', 'a', path)
      const mFile = join(temp ?? '', 'm', path)
      if (looksBinary(aFile) || looksBinary(mFile) || looksBinary(resolve(cwd, path))) {
        plans.set(path, { path, action: 'conflict', reason: '二进制文件，不做合并' })
        continue
      }
      const merged = join(temp ?? '', 'c', `${String(index)}.merged`)
      mkdirSync(dirname(merged), { recursive: true })
      copyFileSync(resolve(cwd, path), merged)
      if (await mergeThreeWay(cwd, merged, mFile, aFile)) {
        plans.set(path, { path, action: 'write', reason: '三方合并成功', src: merged })
      } else {
        plans.set(path, { path, action: 'conflict', reason: '两边都改了同一段' })
      }
    }

    const decisions: RestoreDecision[] = paths.map((path) => {
      const plan = plans.get(path)
      return plan === undefined ? { path, action: 'skip' } : { path, action: plan.action, reason: plan.reason }
    })
    const conflicts = decisions.filter((item) => item.action === 'conflict').map((item) => item.path)
    skipped = decisions.filter((item) => item.action === 'skip').length
    const summary: RestoreResult = {
      ...base,
      ok: true,
      changed,
      skipped,
      conflicts,
      decisions,
      safetyTag: safety.tag,
    }

    // 有冲突就一个文件都不写：半写的工作区比不还原更难收拾。
    if (conflicts.length > 0) return summary

    for (const path of paths) {
      const plan = plans.get(path)
      if (plan === undefined) continue
      if (plan.action !== 'write' && plan.action !== 'delete') continue
      const abs = resolve(cwd, path)
      if (!writableInWorkspace(cwd, path)) continue
      if (plan.action === 'delete') {
        rmSync(abs, { force: true })
      } else {
        const source = plan.src ?? join(temp ?? '', 'a', path)
        applyOne(abs, source, pre.get(path)?.kind === 'link')
      }
      written += 1
    }
    return { ...summary, written }
  } catch (error) {
    return { ...base, ok: false, changed, written, skipped, error: errText(error) }
  } finally {
    if (temp !== null) {
      try {
        rmSync(temp, { recursive: true, force: true })
      } catch {
        // 临时目录清不掉只是脏一点，不能盖掉还原本身的结果
      }
    }
  }
}
