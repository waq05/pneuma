/**
 * superagent 的工作树适配：一张工单一个独立目录，智能体只在那儿改代码。
 *
 * ## 为什么要隔离
 *
 * worker 是后台跑的模型，它的每个写操作都落在自己的 cwd 里。cwd 若还是用户的主工作区，
 * 一次失败的派工就会把用户正开着的未提交改动搅进去。所以每张工单一个 `git worktree`：
 * 与主工作区共用同一份历史，却有一棵独立的文件树；执行器的 `workspace-write` 沙箱把写入
 * 天然关在这棵树里（设计文档 §6.2.3、§6.3「派工」）。
 *
 * ## 为什么同步、为什么用参数数组
 *
 * 端口约定同步（`core/ports.ts:105`：synchronous so `atomic` can wrap），所以这里走
 * `spawnSync`，而不是 core 里那份 async 的 `git()`（`src/core/git-exec.ts:27`）。
 * 子命令一律以**参数数组**交给 git、不经过 shell：工单名来自用户输入，拼成字符串就是命令注入。
 * 继承来的 `GIT_*` 照样先剥掉——理由同 `git-exec.ts:35-45`：用户自己在用 worktree 时常设
 * `GIT_DIR`，不剥的话每条命令都跑到别的仓库去，`worktree add` 会把登记写进错的 `.git`。
 *
 * ## 「建」的三条路径（顺序不能换）
 *
 * 1. 目录已在 → 直接复用：同一张工单重复派工、宿主重启后恢复，都走这一条；
 * 2. 目录没了、分支还在 → `worktree add <dir> <branch>`（**不带 `-b`**）。带 `-b` 会因分支
 *    已存在而失败；带 `-B` 会把分支指回起点、丢掉上次的提交——而「分支上的提交还在」正是
 *    这条路径存在的理由（2026-11-13 实测：git 2.55 会保留，前提是别用 `-B`）；
 * 3. 目录和分支都没了 → `worktree add -b <branch> <dir> <base>`。
 *
 * 第 2 条前面必须先 `git worktree prune`：目录被手工删掉后，git 仍会在 `.git/worktrees/<name>`
 * 记着它，直接 add 会报「missing but already registered worktree」（git 2.55 实测原话）。
 *
 * @module dsc/packages/superagent/adapters/worktree
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { worktreesDir } from '../paths.js'

export interface WorktreeHandle {
  /** 工作树目录的绝对路径。 */
  path: string
  /** 分支名，固定 `agent/<slug>`。 */
  branch: string
  /** true = 这次真的 `git worktree add` 了；false = 目录已存在，直接复用。 */
  created: boolean
}

export interface EnsureWorktreeInput {
  /** 仓库根（主工作区）。 */
  repo: string
  /** 工单名，会被 slug 化后进分支名与目录名。 */
  name: string
  /** 起点，缺省 HEAD。 */
  base?: string
  /** 工作树根，缺省 `worktreesDir()`。 */
  root?: string
}

/**
 * slug 长度上限。
 *
 * 60 不是随便挑的：分支名要拼成 `agent/<slug>`，目录名还要落在 `<DSC_HOME>/superagent/worktrees/`
 * 下面，Windows 全路径 260 字符的上限要留出余量；60 又足够容纳「fix-login-copy」这类真实名字。
 */
const SLUG_MAX = 60

/** 允许出现在分支名与目录名里的字符之外，全部折成分隔符（中文、空格、斜杠都在内）。 */
const SLUG_DISALLOWED = /[^A-Za-z0-9._-]+/g

/**
 * 工单名 → 可安全当分支名与目录名用的 slug。
 *
 * 规则与理由逐条：
 * - 只留 `[A-Za-z0-9._-]`：中文没有可靠的音译，一个汉字折一个 `-` 比留空更容易看出「这儿原本有内容」；
 * - 连续 `-` 压成一个：`改 登录页 文案` 不该变成 `-------`；
 * - `..` 压成一个 `.`：git 的 ref 规则直接拒绝含 `..` 的分支名（`git check-ref-format`）；
 * - 去掉开头的 `.` 与 `-`：开头的点会变成隐藏目录，也是 `..` 上跳写法唯一的入口；
 * - 去掉结尾的 `.` 与 `-`：Windows 会吞掉目录名末尾的点（目录与分支对不上），git 也不许 ref 以 `.` 结尾；
 * - 超长截断后再收一次尾：截断点可能正好落在分隔符上。
 *
 * 全中文标题（本插件最常见的输入）会一路折成空串，兜底给 `ticket`——至少让工单能跑起来。
 * 代价是多张全中文工单会撞同一个名字，所以调用方要区分它们时，得自己传可区分的名字
 * （例如工单 id），见设计文档 §6.3「同一时刻一张工单一个 worktree」。
 */
export function slugOf(name: string): string {
  let slug = name
    .replace(SLUG_DISALLOWED, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
  if (slug.length > SLUG_MAX) slug = slug.slice(0, SLUG_MAX).replace(/[-.]+$/, '')
  return slug === '' ? 'ticket' : slug
}

/** 一条 git 命令的结果。`status` 统一成数字：`spawnSync` 在起不来进程时给的是 `null`。 */
interface GitResult {
  status: number
  stdout: string
  stderr: string
  spawnError?: Error
}

/**
 * 只留与 git 无关的环境变量。
 *
 * Windows 的环境变量名不区分大小写，所以按 `toUpperCase()` 判断：`Git_Dir` 一样会被 git 认。
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase().startsWith('GIT_') || value === undefined) continue
    env[key] = value
  }
  return env
}

/**
 * 跑一条 git。同步、无 shell、参数数组。
 *
 * 超时交给 `spawnSync`（大仓库 checkout 可能要几秒，30 秒足够）；`maxBuffer` 给 8MB，
 * 与 core 那份保持一致，`worktree list` 在几百个工单下也够。
 */
function runGit(repo: string, args: string[]): GitResult {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const spawnError = result.error ?? undefined
  return {
    // 进程没起来（git 不在 PATH、被信号杀掉）时 `status` 是 null：记成非 0，别当成成功。
    status: result.status ?? (spawnError === undefined ? 0 : -1),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnError,
  }
}

/**
 * 失败时抛的错：message 里必须带 stderr。
 *
 * 原生 `Error` 只有一句 `Command failed: git ...`，而 `worktree add` 失败的原因——分支已被
 * 另一个工作树占用、路径被登记过、权限不够——全在 stderr 那一行里。丢了它，用户只能看到
 * 「失败了」；带上它，工单报告里直接能贴给用户看（设计文档 §6.3 兜底表：失败要带上命令原文）。
 */
function failure(what: string, repo: string, args: string[], result: GitResult): Error {
  const detail = result.stderr.trim() || result.spawnError?.message || '（git 没有任何输出）'
  return new Error(
    `${what} 失败（git 退出码 ${result.status}）：${detail}\n命令：git -C ${repo} ${args.join(' ')}`,
    { cause: result.spawnError ?? detail },
  )
}

/** 同 {@link runGit}，但非 0 就抛 {@link failure}。 */
function gitOrThrow(repo: string, args: string[], what: string): string {
  const result = runGit(repo, args)
  if (result.status !== 0) throw failure(what, repo, args, result)
  return result.stdout
}

/**
 * 本地分支是否已存在。
 *
 * `show-ref --verify --quiet` 的退出码就是答案：0 有、1 没有、别的（仓库坏、没有 `.git`）
 * 是真错误，不能当成「没有分支」——那会让下一句 `worktree add -b` 报一句更难懂的错。
 * 不用 `rev-parse --verify`：它把远端跟踪分支和 tag 一起认，会把这个判断搅浑。
 */
function branchExists(repo: string, branch: string): boolean {
  const args = ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]
  const result = runGit(repo, args)
  if (result.status === 1) return false
  if (result.status !== 0) throw failure(`查分支 ${branch}`, repo, args, result)
  return true
}

/** 比路径用的规范形：绝对、正斜杠、Windows 下转小写（那儿大小写不敏感，git 报的也不一定是原样）。 */
function normalizePath(value: string): string {
  const absolute = resolve(value).replace(/\\/g, '/')
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * 建一个工单工作树；目录已在则复用。
 *
 * 三种情况的判断顺序与参数选择见文件头「建的三条路径」。返回值里的 `path` 是绝对路径，
 * 执行器会拿它当 worker 的 cwd。
 */
export function ensureWorktree(input: EnsureWorktreeInput): WorktreeHandle {
  const repo = resolve(input.repo)
  const slug = slugOf(input.name)
  const branch = `agent/${slug}`
  const root = resolve(input.root ?? worktreesDir())
  const dir = join(root, slug)

  // 路径 1：目录已在。先确认它真是这个仓库的 worktree——只凭「目录存在」就复用，会把
  // 智能体放进一个普通目录（甚至仓库外面），改动既不在分支上，也没人收得到。
  if (existsSync(dir)) {
    const known = listWorktrees(repo).find((entry) => normalizePath(entry.path) === normalizePath(dir))
    if (known === undefined) {
      throw new Error(
        `工作树目录已存在，但它不是 ${repo} 的 worktree：${dir}。` +
          '删掉这个目录或换一个工单名；直接复用会让智能体改在仓库之外。',
      )
    }
    // detached 的 worktree 没有分支名：退回约定名，让调用方至少有个分支可显示。
    return { path: dir, branch: known.branch ?? branch, created: false }
  }

  // worktree add 会自己建最后一级目录，但不会建整条父路径。
  mkdirSync(root, { recursive: true })
  // 路径 2 的前置：目录被手工删过时，git 还留着「已登记」的记录，不清掉 add 一定失败。
  gitOrThrow(repo, ['worktree', 'prune'], 'worktree prune')

  if (branchExists(repo, branch)) {
    // 路径 2：分支在、目录没了。不带 `-b` 复用分支；绝不用 `-B`，那会把上次的提交重置掉。
    gitOrThrow(repo, ['worktree', 'add', dir, branch], `worktree add ${branch}`)
  } else {
    // 路径 3：全新工单。`base` 留空等于 HEAD，工单从当前工作区的提交点长出去。
    const base = input.base?.trim() || 'HEAD'
    gitOrThrow(repo, ['worktree', 'add', '-b', branch, dir, base], `worktree add -b ${branch}`)
  }
  return { path: dir, branch, created: true }
}

/**
 * 清掉一个工作树：`git worktree remove --force` 加删目录。
 *
 * 幂等：目录已经不在了、或 git 根本不认识它，就当「已经清过」返回，不报错——清理按钮被
 * 点两下不该弹「不是 worktree」。
 */
export function removeWorktree(input: { repo: string; path: string }): void {
  const repo = resolve(input.repo)
  const path = resolve(input.path)

  // 这个函数会递归删目录，先把最不该发生的事挡住：删到仓库根或盘根上。
  if (normalizePath(path) === normalizePath(repo)) throw new Error(`拒绝删除仓库根：${path}`)
  if (dirname(path) === path) throw new Error(`拒绝删除文件系统根：${path}`)

  const known = listWorktrees(repo).some((entry) => normalizePath(entry.path) === normalizePath(path))
  if (!known) {
    // git 不认识这个目录：可能已经清过一次，也可能只剩一个空壳。删壳子，不动 git 元数据。
    rmSync(path, { recursive: true, force: true })
    return
  }
  gitOrThrow(repo, ['worktree', 'remove', '--force', path], 'worktree remove')
  // git 偶尔留下空目录（`.git` 文件先被删了、里面还有被占用的文件）：兜底再删一次。
  if (existsSync(path)) rmSync(path, { recursive: true, force: true })
}

/**
 * 列出仓库的所有工作树（含主工作区）。
 *
 * 解析 `git worktree list --porcelain`：每棵树是一个空行分隔的块，`worktree <path>` 给路径，
 * `branch refs/heads/<name>` 给分支（去掉前缀只留 `<name>`）；detached 的树没有 `branch` 行，
 * 于是 `branch` 缺省——别硬凑一个名字出来。
 */
export function listWorktrees(repo: string): { path: string; branch?: string }[] {
  const out = gitOrThrow(resolve(repo), ['worktree', 'list', '--porcelain'], 'worktree list')
  const entries: { path: string; branch?: string }[] = []
  let current: { path: string; branch?: string } | null = null
  const flush = (): void => {
    if (current !== null) entries.push(current)
    current = null
  }
  for (const raw of out.split('\n')) {
    // Windows 上 git 的换行是 CRLF：不去掉 `\r`，路径尾部会多一个不可见字符，比对全失败。
    const line = raw.replace(/\r$/, '')
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      // 路径里可能有空格，所以取整行剩余部分，不按空格切。
      flush()
      current = { path: line.slice('worktree '.length) }
      continue
    }
    if (current !== null && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length)
      if (ref.startsWith('refs/heads/')) current.branch = ref.slice('refs/heads/'.length)
      continue
    }
  }
  flush()
  return entries
}
