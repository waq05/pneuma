/**
 * Super Agent 的界面面：快照（§8.2）与执行会话的只读转录。
 *
 * 这里只做三件界面要的事，不碰编排库的写路径：
 *   1. `buildSurface(runtime)`：把 `runtime.list()` 与最近动态装配成 `SuperagentSurface`；
 *   2. `withRepoGuide(surface, repoPath)`：仓库路径空着时补一条「先填路径」的引导（O1）；
 *   3. `readSessionTranscript(ticketId)`：读 `<DSC_HOME>/superagent/sessions/<id>/*.jsonl`
 *      并按普通会话重放成 `TranscriptEntry[]`（只读，不拿写租约）。
 *
 * 快照面的登记也在这里（{@link registerSurface}）：`ctx.effect` 包住
 * `ctx.surfaces.register`，插件停用即自动摘掉，不用另写清理清单。
 *
 * @module dsc/packages/superagent/surface
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SuperagentCandidateView,
  SuperagentSurface,
  SuperagentTicketView,
  TranscriptEntry,
} from '@pneuma/runtime/contract.js'
import { Transcript } from '@pneuma/runtime/adapter/transcript.js'
import { Session } from '@pneuma/runtime/core/session.js'
import { sessionsDir } from './paths.js'
import type { CandidateRecord } from './adapters/store.js'
import type { SuperagentRuntime, TicketView } from './runtime.js'

/** 一张工单的命令层视图 → 界面视图（只换字段名，不在这里算业务）。 */
function toTicketView(ticket: TicketView): SuperagentTicketView {
  return {
    id: ticket.id,
    title: ticket.title,
    stage: ticket.stage,
    // 契约里叫 `at`（与 recent 同一口径），命令层叫 createdAt：同一个值。
    at: ticket.createdAt,
    ...(ticket.summary === undefined ? {} : { summary: ticket.summary }),
  }
}

/** 一条候选记录 → 界面视图（只换字段名，判定结果不往外给）。 */
function toCandidateView(record: CandidateRecord): SuperagentCandidateView {
  return {
    id: record.id,
    title: record.value.title,
    reason: record.value.reason,
    scope: record.value.scope,
    source: record.value.source,
    at: record.at,
  }
}

/**
 * 装配当前快照面。
 *
 * 三组计数的口径（三组之和 = 工单总数，界面分组头不会出现「加起来对不上」）：
 *   - `needsYou`：`stage: 'person'`（等你接收 / 回答 / 验收，或卡住 / 失败）；
 *   - `running`：`working`（含待派工）与 `idle`（还开着、只是这轮之间空闲）；
 *   - `done`：`ended`。
 *
 * @param runtime - 已经建好的运行期（调用方保证非空）
 */
export function buildSurface(runtime: SuperagentRuntime): SuperagentSurface {
  const tickets = runtime.list().map(toTicketView)
  const counts = { needsYou: 0, running: 0, done: 0 }
  for (const ticket of tickets) {
    if (ticket.stage.stage === 'person') counts.needsYou += 1
    else if (ticket.stage.stage === 'ended') counts.done += 1
    else counts.running += 1
  }
  return {
    ready: true, counts, tickets, recent: runtime.recent(),
    // 「先等我确认」关着时不给这一格：`undefined` 表示这个功能没开，空数组表示
    // 「开了但没人等」——界面按前者整块不画，按后者画一句「暂时没有待确认」。
    ...(runtime.confirmingInferred() ? { candidates: runtime.candidates().map(toCandidateView) } : {}),
  }
}

/**
 * 仓库路径没填时给界面的一条引导（O1 首次使用）。
 *
 * 为什么文案是完整的操作步骤：全新装好后 `repoPath` 是空的，用户发布的第一张工单会在派工
 * 那一刻失败（`adapters/executor.ts:732`），而失败到面板上只剩「派工失败」四个字。这里把
 * 「去哪儿填」直接写出来，用户不必去翻日志猜。
 */
const REPO_MISSING_PROBLEM: { code: string; detail: string } = {
  code: 'repo_missing',
  detail: '先填仓库路径（设置 → Super Agent → 默认仓库路径），否则发布的任务会停在待派工',
}

/**
 * 给已经能用的快照面补一条「仓库路径没填」的引导。
 *
 * 为什么补在登记快照面这一层，而不是 `buildSurface` 里：`buildSurface` 只拿到运行期，
 * 设置归装配层（`index.ts` 现读磁盘）读；它的调用方 `service.ts` 是薄层，不碰配置。
 * 所以在 `index.ts` 登记快照面那一刻把两者拼起来。
 *
 * 为什么复用 `problem` 而不是加字段：契约（`src/contract/runtime.ts` 的
 * `SuperagentSurface`）已经有 `problem?: { code, detail }`，界面也已经在摊这一项；加字段
 * 要改契约，而契约此刻冻结。`ready: true` 带上 `problem` 在这里的含义收窄成
 * 「能用，但有一件事没配」，界面据此只画一条警告，不挡页面。
 *
 * @param surface - `service.surface()` 装好的快照面
 * @param repoPath - 设置里的仓库路径（空串 = 没配）
 */
export function withRepoGuide(surface: SuperagentSurface, repoPath: string): SuperagentSurface {
  // 运行期没起来时那条 problem 更要紧（库都打不开，路径填了也没用），不覆盖它。
  if (!surface.ready || surface.problem !== undefined) return surface
  if (repoPath.trim() !== '') return surface
  return { ...surface, problem: REPO_MISSING_PROBLEM }
}

/**
 * 把 `superagent` 这一格登记进快照。
 *
 * @param ctx - 插件上下文（`surfaces` 必须在 inject 里）
 * @param read - 每次装配快照时调用；返回 {@link SuperagentSurface}
 */
export function registerSurface(ctx: Context, read: () => SuperagentSurface): void {
  ctx.effect(() => ctx.surfaces.register('superagent', read), 'superagent: surfaces.register')
}

/** 一次执行会话的文件：名字（只用来排序/报错）与绝对路径。 */
interface SessionFile {
  name: string
  path: string
  mtimeMs: number
}

/** 列出某张工单的执行会话文件，按修改时间升序（重试会新建文件，旧的在前）。 */
function sessionFiles(ticketId: string): SessionFile[] {
  const dir = sessionsDir(ticketId)
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    // 目录不存在 = 这张工单还没真派过工（或者工作树/会话已被清理），不是程序错误。
    throw new Error(`这张工单还没有执行会话：${ticketId}`)
  }
  const files: SessionFile[] = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      files.push({ name, path, mtimeMs: statSync(path).mtimeMs })
    } catch {
      // 刚好被清理掉的文件跳过：读转录不该因为一个抖动整份失败。
    }
  }
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs)
}

/**
 * 读一张工单的执行会话转录（只读）。
 *
 * 一张工单重试几次就有几个 jsonl（执行器每次派工建一个新会话，`executor.ts:562`），
 * 这里按修改时间从旧到新拼起来，并把每条条目的 `id` 顺延——每份 `Transcript` 的 id
 * 都从 1 开始，直接拼会撞 key，界面按 id 复用行时会串。
 *
 * 只读的口径与队友转录同一条（`subagent/index.ts:1009-1019`）：`Session.load(..., { lease: false })`
 * 重放，不写那个文件、不抢写租约（worker 可能正活着写它）。
 *
 * @param ticketId - 工单 id（`paths.sessionsDir` 会校验它能不能当目录名）
 * @throws 工单 id 非法，或这张工单还没有执行会话
 */
export async function readSessionTranscript(ticketId: string): Promise<TranscriptEntry[]> {
  const files = sessionFiles(ticketId)
  if (files.length === 0) throw new Error(`这张工单还没有执行会话：${ticketId}`)
  const entries: TranscriptEntry[] = []
  let offset = 0
  for (const file of files) {
    const session = Session.load(file.path, true, { lease: false })
    try {
      const replay = new Transcript()
      replay.replayHistory(session.messages, session.toolErrors, session.fileChanges, session.presentations)
      const part = [...replay.entries, ...replay.liveEntries()]
      let max = 0
      for (const entry of part) {
        const id = typeof entry.id === 'number' ? entry.id : 0
        if (id > max) max = id
        entries.push({ ...entry, id: id + offset })
      }
      // 下一份从这一份的最大 id 接着编号（不是 part.length：中间可能有跳号）。
      offset += max
    } finally {
      session.close()
    }
  }
  return entries
}
