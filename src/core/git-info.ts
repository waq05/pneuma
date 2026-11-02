/**
 * 工作区 git 收集（/review 命令的取数层）。
 *
 * 为什么独立成模块而不是长在 commands 插件里：渲染层会 import `lib/plugins/commands.js`
 * 里的补全函数，vite 把 `node:child_process` externalize 成浏览器代理模块——顶层 import
 * 一旦出现在 commands.js，渲染进程一启动就炸成白屏（0.6.26 实机探针抓到）。取数挪进
 * core 后，commands.js 的顶层不再碰 node 内置模块。
 *
 * 安全姿势照 codex /diff：execFile 固定子命令数组（无 shell、无拼接）；
 * `--no-textconv --no-ext-diff` 防文本转换与外部 diff driver 当场执行程序。
 *
 * 本模块同时放 /review 的「审查范围 + 完整 diff 落盘 + 会话账本（状态/取消）」：
 * 这三件事是同一个功能的宿主侧基础设施，命令侧（派审查前后）与审查通道（收工/叫停）
 * 都要读写同一份口径；分开两个文件只会多出一处「记录字段与谁对得上」的维护负担。
 *
 * @module dsc/core/git-info
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, promises as fsp, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ReviewStatusView } from '../services/types.js'
import { dscPath } from './path-policy.js'
import { stripBaseline, type FileChangeSummary } from './tools.js'
import { summarizeChange } from './tools/fs-tools.js'

/** 受控执行 git（execFile 固定首参字面量 + 参数数组；无 shell）。 */
export function gitExec(cwd: string, args: string[]): Promise<string> {
  return runGit(cwd, args, 8 * 1024 * 1024, 15000)
}

/**
 * 受控执行 git 的唯一实现（{@link gitExec} 与取数那几次调用都走它）。
 *
 * 为什么缓冲与超时要能传：一次审查的 diff 不再截断（截断会把「后面还有问题」的改动
 * 整段藏起来），8 MB 的默认上限在中等规模仓库里就会 ENOBUFS 当场失败，而不是「慢一点」。
 * 128 MB 的上限是防跑飞的闸，不是预期用量；超过它的 diff 本来也不该一次读进内存。
 */
function runGit(cwd: string, args: string[], maxBuffer: number, timeout: number): Promise<string> {
  return new Promise((resolveDone, rejectDone) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer, windowsHide: true, timeout, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error !== undefined && error !== null) rejectDone(new Error(String(stderr || error.message).slice(0, 400)))
        else resolveDone(String(stdout))
      },
    )
  })
}

/** 取 diff 那几次 git 调用共用：缓冲 128 MB、超时 5 分钟（大仓库的一次 diff 就够慢）。 */
const gitForDiff = (cwd: string, args: string[]): Promise<string> => runGit(cwd, args, 128 * 1024 * 1024, 300_000)

/** 超过这个字节数的 diff 在「改动清单」末尾补一句读法提示（20 MB，见下）。 */
const HUGE_DIFF_BYTES = 20 * 1024 * 1024

/**
 * 校验用户给的分支 / 提交引用。
 *
 * 为什么非校验不可：`git show <ref>` 的 ref 来自 `/review` 后面的自由输入，而
 * `execFile` 只挡得住 shell 拼接、挡不住**选项注入**——填 `--output=D:\\任意路径` 时
 * git 会把它当选项执行（把补丁写进那个文件）。所以只放行正常引用字符，并且不许以
 * `-` 开头（那就是选项的地盘）。`~`、`^`、`@{` 这些 rev 语法照常可用。
 *
 * @param ref - 用户输入或候选里的原始值
 * @returns 去掉首尾空白的引用
 */
export function assertReviewRef(ref: string): string {
  const trimmed = ref.trim()
  if (trimmed === '' || trimmed.startsWith('-') || !/^[A-Za-z0-9._~^@{}/:-]+$/.test(trimmed)) {
    throw new Error(`不像一个分支或提交引用：${ref}`)
  }
  return trimmed
}

// ── /review 的范围与落盘（T45）──────────────────────────────────────────────

/** /review 的审查范围。 */
export type ReviewTarget =
  | { kind: 'worktree' }
  | { kind: 'base'; ref: string }
  | { kind: 'commit'; ref: string; title?: string }
  | { kind: 'custom'; instructions: string }

/** 一次审查的取数结果：范围描述 + 完整 diff 落盘路径 + 改动清单 + 未跟踪名单。 */
export interface ReviewScope {
  target: ReviewTarget
  /** 给用户与队友看的一句话范围（「未提交改动」「对比基准分支 main 的差异（共同祖先 abc1234）」）。 */
  label: string
  /** 完整 diff 落盘的绝对路径。 */
  diffPath: string
  /** 落盘 diff 的字节数（不是字符数——中文一个字 3 字节，按字节算才知道文件多大）。 */
  diffBytes: number
  /** `git diff --stat` 的原文：给队友一眼看清单。 */
  stat: string
  /** 未跟踪文件（diff 里本来就没有它们，只列名单让队友自己 read）。 */
  untracked: string[]
  /** base 范围算出来的共同祖先提交（完整 SHA）。 */
  base?: string
}

/** 未跟踪文件名单：`git status --porcelain` 里 `??` 那几行。 */
async function listUntracked(cwd: string): Promise<string[]> {
  const porcelain = await gitExec(cwd, ['-c', 'core.quotePath=false', 'status', '--porcelain=v1'])
  return porcelain
    .split('\n')
    .filter((line) => line.startsWith('??'))
    .map((line) => line.slice(3).trim())
    .filter((file) => file !== '')
}

/** 短哈希：会话 id 或工作目录都行，只用来让同一个会话的 diff 文件名彼此认得出来。 */
function shortHash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 8)
}

/**
 * 把完整 diff 写进 `<数据目录>/cache/review/<会话短哈希>-<时间戳>.diff`，返回绝对路径。
 *
 * 为什么落盘而不是塞进任务描述：审查队友的上下文有预算，塞进去就得截断；落盘之后
 * 它可以按需 `read` 的 offset/limit 分批看完整内容，截断这件事就不存在了。
 * 数据目录复用 path-policy 的 DSC_HOME（`DSC_HOME` 环境变量优先），与配置、会话同一处。
 */
async function writeReviewDiff(seed: string, diff: string): Promise<string> {
  const dir = dscPath('cache', 'review')
  await fsp.mkdir(dir, { recursive: true })
  const file = join(dir, `${shortHash(seed)}-${String(Date.now())}.diff`)
  await fsp.writeFile(file, diff, 'utf8')
  return file
}

/**
 * 按范围取一次审查的完整数据（不截断）。
 *
 * 取数口径（`--no-textconv --no-ext-diff` 防文本转换与外部 diff driver 当场跑程序）：
 *   - worktree / custom：`git diff HEAD`（含已暂存；未跟踪只列名单）；
 *   - base：先 `git merge-base HEAD <ref>` 拿到共同祖先，再 `git diff <祖先>`；
 *   - commit：`git show <ref> --format=fuller`（连提交信息一起给队友）。
 *
 * @param cwd - 会话工作目录
 * @param target - 审查范围
 * @param sessionId - 会话 id（只用于 diff 文件名；不传就按 cwd 哈希，探针里两参调用即可）
 * @returns 不是 git 仓库时 null；ref 不存在等 git 报错按异常抛出（调用方给用户看原文）
 */
export async function collectReviewScope(
  cwd: string,
  target: ReviewTarget,
  sessionId?: string,
): Promise<ReviewScope | null> {
  try {
    const inside = (await gitExec(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return null
  } catch {
    return null
  }

  let diff: string
  let stat: string
  let label: string
  let base: string | undefined
  // 未跟踪文件只在「工作区」口径里有意义：对比分支与某次提交看的是已入库的改动。
  const untracked = target.kind === 'worktree' || target.kind === 'custom' ? await listUntracked(cwd) : []

  if (target.kind === 'commit') {
    const ref = assertReviewRef(target.ref)
    diff = await gitForDiff(cwd, ['show', ref, '--no-textconv', '--no-ext-diff', '--format=fuller'])
    stat = await gitForDiff(cwd, ['show', ref, '--stat', '--format='])
    const sha = (await gitExec(cwd, ['rev-parse', ref])).trim()
    const title = target.title ?? (await gitExec(cwd, ['log', '-1', '--format=%s', ref])).trim()
    label = `提交 ${sha.slice(0, 10)}${title === '' ? '' : ` ${title}`}`
  } else if (target.kind === 'base') {
    const ref = assertReviewRef(target.ref)
    base = (await gitExec(cwd, ['merge-base', 'HEAD', ref])).trim()
    diff = await gitForDiff(cwd, ['diff', base, '--no-textconv', '--no-ext-diff'])
    stat = await gitForDiff(cwd, ['diff', base, '--stat'])
    label = `对比基准分支 ${ref} 的差异（共同祖先 ${base.slice(0, 10)}）`
  } else {
    diff = await gitForDiff(cwd, ['diff', 'HEAD', '--no-textconv', '--no-ext-diff'])
    stat = await gitForDiff(cwd, ['diff', 'HEAD', '--stat'])
    label = target.kind === 'custom' ? '未提交改动（自定义审查要求）' : '未提交改动'
  }

  const diffBytes = Buffer.byteLength(diff, 'utf8')
  // 超大 diff 照样写全（写文件没有上下文压力），只在清单末尾教队友怎么读。
  if (diffBytes > HUGE_DIFF_BYTES) {
    stat = `${stat.trimEnd()}\n\ndiff 很大（${(diffBytes / 1024 / 1024).toFixed(1)} MB），用 read 的 offset/limit 分批读，别一次全读。`
  }
  const diffPath = await writeReviewDiff(sessionId ?? cwd, diff)
  return {
    target,
    label,
    diffPath,
    diffBytes,
    stat,
    untracked,
    ...(base === undefined ? {} : { base }),
  }
}

/** 本地分支清单（「对比基准分支」的候选项）；不是 git 仓库或没有分支时给空数组。 */
export async function listReviewBranches(cwd: string): Promise<string[]> {
  try {
    const text = await gitExec(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    return text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  } catch {
    return []
  }
}

/** 最近 100 条提交（「审查某次提交」的候选项）；取不到给空数组，用户仍可手填 SHA。 */
export async function listReviewCommits(cwd: string): Promise<{ sha: string; subject: string }[]> {
  try {
    const text = await gitExec(cwd, ['log', '-n', '100', '--format=%H%x09%s'])
    return text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const at = line.indexOf('\t')
        return at < 0
          ? { sha: line, subject: '' }
          : { sha: line.slice(0, at), subject: line.slice(at + 1) }
      })
  } catch {
    return []
  }
}

/**
 * 给审查队友的任务书（/review 的唯一组装点：派队友走它，回落主会话轮也走它）。
 *
 * 为什么要把「diff 已落盘」写进任务书：队友只有读类工具，不知道文件在哪就只能
 * 在上下文里找，而完整 diff 可能几十 MB——先告诉它路径与读法，它才可能读全。
 *
 * @param scope - 取数结果
 * @param focus - 用户写在 /review 后面的关注点（空串 = 不限）
 */
export function reviewTaskText(scope: ReviewScope, focus: string): string {
  const lines = [
    '你是一次代码审查的审查员：只读代码，不改任何文件。',
    '',
    '## 本次审查范围',
    scope.label,
  ]
  if (scope.target.kind === 'custom') {
    lines.push('', '## 自定义审查要求', scope.target.instructions)
  }
  lines.push(
    '',
    '## 完整 diff 已落盘',
    scope.diffPath,
    `用 read 分批读（offset / limit），别只看开头：这份 diff 共 ${String(scope.diffBytes)} 字节。`,
  )
  if (scope.diffBytes === 0) {
    lines.push('（这个范围里没有已跟踪文件的改动，只有下面列出的未跟踪新文件。）')
  }
  if (scope.stat.trim() !== '') {
    lines.push('', '## 改动清单', scope.stat.trimEnd())
  }
  if (scope.untracked.length > 0) {
    lines.push('', '## 未跟踪文件（diff 里没有，逐个 read 再评）', ...scope.untracked.map((file) => `- ${file}`))
  }
  if (focus !== '') {
    lines.push('', '## 关注点', focus)
  }
  lines.push(
    '',
    '## 输出要求',
    '按 P0–P3 分级：P0 = 必须修（必然出错、安全漏洞、数据丢失）；'
      + 'P1 = 正确性或安全问题；P2 = 边界、健壮性、性能问题；P3 = 可读性、风格、更好的写法。',
    '每条按这个格式写（渲染层按它解析成卡片，字段一个都不能少）：',
    '',
    '### [P0] 一句话标题',
    '位置：相对路径:行号',
    '说明：问题是什么、证据是什么',
    '建议：怎么改',
    '',
    '最后单起一段给整体结论，只能二选一：`整体结论：可提交` 或 `整体结论：需修改后提交`。',
    '没有发现问题就明说没有，并交代你查过的文件与维度。',
  )
  return lines.join('\n')
}

// ── /review 的会话账本（状态回看 / 取消）────────────────────────────────────

/** 取消之后记进记录文件的那句话（/review-status 会原样回看）。 */
export const REVIEW_CANCELED_TEXT = '审查被取消。'

/** 一次正在跑的审查：记下队友名字与开始时间，取消与收工都用得上。 */
interface ReviewRun {
  startedAt: number
  target: string
  /** 队友名（取消时要按它叫停）。 */
  handle: string
  /** 已经被用户取消：收工记录里要保留「审查被取消」，不许被队友状态覆盖。 */
  cancelled: boolean
}

/**
 * /review 的会话账本：内存里记「这个会话有没有在跑的审查」，磁盘上留「最近一次长什么样」。
 *
 * 为什么放在这里：命令侧（派审查前写 running）、审查通道（收工写 findings、取消时改状态）
 * 与自检探针要共用同一份读写口径。各自拼路径、各自猜字段，重启后就对不上了。
 * 记录文件 `<数据目录>/code-review/<会话 id>.json`，一个会话一份，后一次覆盖前一次。
 */
export class ReviewJournal {
  private readonly runs = new Map<string, ReviewRun>()
  private readonly views = new Map<string, ReviewStatusView>()
  private readonly home: string

  /** @param home - 数据目录（`ctx.settings.about().home`，与 DSC_HOME 同一个） */
  constructor(home: string) {
    this.home = home
  }

  /** 这个会话的记录文件路径（会话 id 先洗一遍，别让奇怪的 id 拼出目录穿越）。 */
  recordPath(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_')
    return join(this.home, 'code-review', `${safe}.json`)
  }

  /** 读记录文件；没有、读不动、字段对不上都算「没有记录」。 */
  read(sessionId: string): ReviewStatusView | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.recordPath(sessionId), 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return null
      const record = parsed as Record<string, unknown>
      if (record['version'] !== 1) return null
      const state = record['state']
      if (state !== 'running' && state !== 'finished') return null
      if (typeof record['startedAt'] !== 'number' || typeof record['target'] !== 'string') return null
      const findings = record['findings']
      return {
        state,
        startedAt: record['startedAt'],
        target: record['target'],
        ...(typeof findings === 'string' ? { findings } : {}),
      }
    } catch {
      return null
    }
  }

  /** 写记录文件（写不下去只让 /review-status 回看少一份，不影响审查本身）。 */
  private write(sessionId: string, view: ReviewStatusView): void {
    this.views.set(sessionId, view)
    try {
      const path = this.recordPath(sessionId)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify({ version: 1, ...view }, null, 2)}\n`, 'utf8')
    } catch {
      // 记录落盘失败不该让审查失败：内存里那份还在，本进程内的 /review-status 照常能看
    }
  }

  /** 最近一次审查的状态；没有记录返回 null。 */
  status(sessionId: string): ReviewStatusView | null {
    return this.views.get(sessionId) ?? this.read(sessionId)
  }

  /** 这个会话正在跑的那次审查；没有返回 undefined（取消要按它拿队友名）。 */
  running(sessionId: string): ReviewRun | undefined {
    return this.runs.get(sessionId)
  }

  /** 派出去之后登记「在跑」并落一份 running 记录。 */
  begin(sessionId: string, input: { target: string; handle: string; startedAt?: number }): void {
    const startedAt = input.startedAt ?? Date.now()
    this.runs.set(sessionId, { startedAt, target: input.target, handle: input.handle, cancelled: false })
    this.write(sessionId, { state: 'running', startedAt, target: input.target })
  }

  /**
   * 标记取消：记录立刻变成 finished +「审查被取消」，但**保留** runs 里那条，
   * 好让随后的收工回调还知道这次审查的起始时间与范围（它会把同一句话再写一遍）。
   * @returns 没有在跑的审查时 false
   */
  cancel(sessionId: string): boolean {
    const run = this.runs.get(sessionId)
    if (run === undefined) return false
    run.cancelled = true
    this.write(sessionId, {
      state: 'finished',
      startedAt: run.startedAt,
      target: run.target,
      findings: REVIEW_CANCELED_TEXT,
    })
    return true
  }

  /** 这次审查是不是被用户取消的（收工时用来决定写哪句话）。 */
  wasCancelled(sessionId: string): boolean {
    return this.runs.get(sessionId)?.cancelled === true
  }

  /**
   * 收工：把 findings 写进记录并清掉「在跑」那一笔。
   * @param handle - 收工的是哪个队友；同一会话里前一次没收工又派了新的时，
   *   旧那次收工不能把新那次的状态改成 finished（传了就按它比对，不传一律照写）
   */
  finish(sessionId: string, findings: string, handle?: string): void {
    const run = this.runs.get(sessionId)
    if (handle !== undefined && run !== undefined && run.handle !== handle) return
    this.runs.delete(sessionId)
    this.write(sessionId, {
      state: 'finished',
      startedAt: run?.startedAt ?? Date.now(),
      target: run?.target ?? '（范围未知）',
      findings: run?.cancelled === true ? REVIEW_CANCELED_TEXT : findings,
    })
  }
}

/** `/review-status` 上屏的那段文本（命令与探针共用一份，不许各写一套）。 */
export function reviewStatusText(view: ReviewStatusView | null): string {
  if (view === null) return '还没有审查记录。'
  const when = new Date(view.startedAt).toLocaleString('zh-CN', { hour12: false })
  const lines = [
    view.state === 'running' ? `审查进行中（开始于 ${when}）` : `审查已完成（开始于 ${when}）`,
    `范围：${view.target}`,
  ]
  if (view.state === 'running') lines.push('用 /review-cancel 可以取消这次审查。')
  if (view.findings !== undefined && view.findings.trim() !== '') {
    lines.push('', '结论：', view.findings.trimEnd())
  }
  return lines.join('\n')
}

// ── T42：回合首尾快照（轮尾「文件已更改」卡对 bash/脚本改动的兜底）─────────────

/**
 * 一轮最多补多少个 git 兜底条目。
 *
 * 上限本身要有（一个脚本扫动几千个文件会把轮尾卡撑爆），但 20 太小：真实的一次
 * 「按需求文档补一堆文件」很容易超过 20，用户看到的就是「文件显示不全」
 * （2026-10-30 报障）。200 够覆盖正常一轮的重构，真超了也只是少列，不影响功能。
 */
const MAX_GIT_TURN_FILES = 200

/**
 * 回合起点的 git 状态快照：仓库根 + porcelain 一行一条。非 git 仓库、git 跑不动
 * （超时/没装）一律返回 null——兜底只在确定拿得到的时候参与，绝不挡回合本身。
 */
export async function snapshotGitStatus(cwd: string): Promise<{ root: string; lines: string[] } | null> {
  try {
    const inside = (await gitExec(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return null
    const root = (await gitExec(cwd, ['rev-parse', '--show-toplevel'])).trim()
    const lines = (await gitExec(cwd, ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '--untracked-files=all']))
      .split('\n')
      .filter((line) => line !== '')
    return { root, lines }
  } catch {
    return null
  }
}

/** porcelain 一行 → { 状态码, 仓库根相对路径 }；rename 的 `old -> new` 取 new 一侧。 */
function parsePorcelain(line: string): { code: string; path: string } | null {
  if (line.length < 4) return null
  const code = line.slice(0, 2)
  let path = line.slice(3)
  const arrow = path.indexOf(' -> ')
  if (arrow >= 0) path = path.slice(arrow + 4)
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
  return { code, path }
}

/**
 * 对比回合首尾快照，把「第一方 write/edit 之外」动过的文件补成变更条目（bash、
 * sed、构建脚本改的文件也要进轮尾卡，用户不能看到「无更改」而工作区其实变了）。
 *
 * 口径：porcelain 状态码变了才算本回合动的——回合开始前就脏着的文件「又改了一刀」
 * 在这里看不出来，这是相对 dsh scratch-index 方案的已知盲区。`already` 里的路径跳过
 * （write/edit 已经记了更准的「回合前全文」基线）。基线内容：已跟踪取 HEAD 版本，
 * 未跟踪取空串（整篇新增）。删除（盘上已无此文件）跳过——diff 面板没有「删除」的展示形态。
 */
export async function collectGitTurnChanges(
  cwd: string,
  before: { root: string; lines: string[] } | null,
  after: { root: string; lines: string[] } | null,
  already: readonly string[],
): Promise<FileChangeSummary[]> {
  if (before === null || after === null || before.root !== after.root) return []
  const startState = new Map<string, string>()
  for (const line of before.lines) {
    const parsed = parsePorcelain(line)
    if (parsed !== null) startState.set(parsed.path, parsed.code)
  }
  const taken = new Set(already.map((path) => path.toLowerCase()))
  const out: FileChangeSummary[] = []
  for (const line of after.lines) {
    if (out.length >= MAX_GIT_TURN_FILES) break
    const parsed = parsePorcelain(line)
    if (parsed === null || parsed.code === ' D' || parsed.code === 'D ') continue
    const startCode = startState.get(parsed.path)
    if (startCode === parsed.code) continue // 状态没变：要么没动，要么回合前就脏着（盲区）
    const abs = join(after.root, parsed.path)
    if (taken.has(abs.toLowerCase())) continue
    const baseline =
      startCode === undefined
        ? '' // 回合开始时不存在（未跟踪的新文件）：整篇算新增
        : await gitExec(cwd, ['show', `HEAD:${parsed.path}`]).catch(() => '')
    const current = await fsp.readFile(abs, 'utf8').catch(() => null)
    if (current === null) continue
    const change = summarizeChange(abs, baseline, current)
    if (change !== undefined) out.push(stripBaseline(change))
  }
  return out
}
