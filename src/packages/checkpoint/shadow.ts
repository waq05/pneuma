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
 * @module dsc/plugins/checkpoint/shadow
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { errText } from '@pneuma/runtime/core/err-text.js'
import { git } from '@pneuma/runtime/core/git-exec.js'
import { DSC_HOME, dscPath } from '@pneuma/runtime/core/path-policy.js'

/** 快照一条的记录（`listSnapshots` 的返回项）。 */
export interface SnapshotInfo {
  /** 标签全名，例如 `dsc/turn-3-pre`。 */
  tag: string
  /** 第几回合（从 1 起）。 */
  turn: number
  /** 回合前还是回合后。 */
  label: 'pre' | 'post'
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

/** 在影子仓库里跑一条 git（固定带换行符与 gc 配置）。 */
function shadowGit(cwd: string, args: string[], timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<string> {
  return git(cwd, [...GIT_CONFIG_ARGS, ...args], timeoutMs, shadowEnv(cwd))
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
  if (!existsSync(statePath(cwd))) writeState(cwd, { lastTurn: 0 })
  return { root, repo }
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
    await shadowGit(cwd, ['tag', '-f', `dsc/turn-${turn}-${label}`, commit])
    return { ok: true, commit, turn }
  } catch (error) {
    return { ok: false, error: errText(error) }
  }
}

/** 按提交时间倒序列出快照标签；仓库还没建时给空数组（不是错误）。 */
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
      const matched = /^dsc\/turn-(\d+)-(pre|post)$/.exec(tag)
      if (matched === null) continue
      entries.push({
        tag,
        turn: Number(matched[1]),
        label: matched[2] === 'pre' ? 'pre' : 'post',
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
