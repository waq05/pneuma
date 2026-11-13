/**
 * `/sa` 命令：建工单、看工单、停 / 重试 / 清理工单。
 *
 * 命令服务的一条 `CommandSpec.name` 只能是一个词（`src/services/types.ts:578`），
 * 所以 `/sa new ...` 与 `/sa list` 注册成**一条** `sa`，第一个参数当子命令——
 * 与 `/schedule add ...` 同一个写法（`src/packages/schedule/index.ts:376-379`）。
 *
 * 解析单独抽成 `parseSaCommand`，是为了能被包级测试直接测：起整个宿主去测一条
 * 命令的参数错误，代价太大，而且测到的是宿主的派发链路，不是这里的解析。
 *
 * **这里的文案是中文常量，不走 locale 字典**。本地化门禁只扫「声明过设置分区」的宿主
 * 文件（`scripts/ui-locale-test.mjs:270-277`：文件里没有设置分区声明就直接跳过），
 * 所以命令输出本来就不在它的覆盖面上；而全部宿主半的 `/命令` 输出都是中文字面量
 * （例 `src/packages/schedule/index.ts:399`）。把命令文案塞进字典，只会让那批键被门禁
 * 判成「没人用的键」。要真正本地化命令输出，得先改门禁的扫描面，那是另一件事。
 *
 * @module dsc/packages/superagent/commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TicketStage } from './core/index.js'
import type { SuperagentRuntime, TicketView } from './runtime.js'

/** 一条 `/sa` 输入解析后的动作；出错时带回可直接显示的文案。 */
export type SaCommand =
  | { kind: 'new'; title: string; body: string }
  | { kind: 'list' }
  /** 停止 / 重试 / 清理：`id` 可以是完整 id，也可以是开头几位（`/sa list` 只显示前 8 位）。 */
  | { kind: 'stop'; id: string }
  | { kind: 'retry'; id: string }
  | { kind: 'clean'; id: string }
  | { kind: 'error'; message: string }

/** 操作工单的三条子命令；列表与解析两处共用同一份名字。 */
const TICKET_VERBS = ['stop', 'retry', 'clean'] as const
type TicketVerb = (typeof TICKET_VERBS)[number]

/** 参数不对时给的那句话：要能照着敲，不是「参数错误」。 */
const USAGE = '格式：/sa new 标题 | 正文，/sa list，/sa stop|retry|clean <id>'

/**
 * 解析 `/sa` 的参数。
 *
 * 参数已经按空白切好（命令服务的行为，`CommandInvocation.args`），但标题本身可能
 * 含空格，所以先 `join(' ')` 再按第一个 `|` 切：`/sa new 改 登录 页 | 中文提示`
 * 的标题是「改 登录 页」。分隔符 `|` 两侧的空格可写可不写。
 *
 * 缺正文时正文取标题（设计文档第 4 步的示例是「标题 | 正文」，但正文不该是必填）。
 *
 * `stop` / `retry` / `clean` 只接一个 id，且不在这里查它存不存在：解析是纯的，
 * 与库无关（见 `registerCommands` 里的 `resolveTicket`）。
 *
 * @param args - 首个是子命令，其余是标题与正文，或一个工单 id
 */
export function parseSaCommand(args: readonly string[]): SaCommand {
  const head = (args[0] ?? '').trim().toLowerCase()
  if (head === 'new') {
    const rest = args.slice(1).join(' ').trim()
    if (rest === '') return { kind: 'error', message: USAGE }
    const separator = rest.indexOf('|')
    const title = (separator === -1 ? rest : rest.slice(0, separator)).trim()
    if (title === '') return { kind: 'error', message: `标题不能为空。${USAGE}` }
    const body = separator === -1 ? title : rest.slice(separator + 1).trim()
    return { kind: 'new', title, body: body === '' ? title : body }
  }
  if (head === 'list') {
    if (args.length > 1) return { kind: 'error', message: `/sa list 不接受参数。${USAGE}` }
    return { kind: 'list' }
  }
  if ((TICKET_VERBS as readonly string[]).includes(head)) {
    const id = args.slice(1).join(' ').trim()
    if (id === '') return { kind: 'error', message: `/sa ${head} 后面要跟一个工单 id（/sa list 显示前 8 位）。${USAGE}` }
    // id 里不会有空格：多写的那几个词多半是顺手把标题也贴进来了，直接说清楚比猜好。
    if (/\s/.test(id)) return { kind: 'error', message: `/sa ${head} 只接一个工单 id，别把标题也贴上。` }
    if (head === 'stop') return { kind: 'stop', id }
    if (head === 'retry') return { kind: 'retry', id }
    return { kind: 'clean', id }
  }
  return { kind: 'error', message: USAGE }
}

/**
 * 按前缀找一张工单。
 *
 * `/sa list` 只显示 id 的前 8 位（完整 id 是 32 位十六进制，摆一行会把标题挤没），
 * 用户会照着那 8 位敲，所以 `stop` / `retry` / `clean` 都按前缀认。
 *
 * 匹配到多条时**不许瞎选**：返回一句「有歧义，贴长一点」，把候选的前 8 位与标题列出来，
 * 让人自己决定。完整 id 命中时直接用它，不再看前缀。
 */
export function resolveTicket(
  tickets: readonly TicketView[],
  input: string,
): { ticket: TicketView } | { message: string } {
  const wanted = input.trim().toLowerCase()
  if (wanted === '') return { message: '要给一个工单 id。' }
  const exact = tickets.find(ticket => ticket.id.toLowerCase() === wanted)
  if (exact !== undefined) return { ticket: exact }
  const matched = tickets.filter(ticket => ticket.id.toLowerCase().startsWith(wanted))
  if (matched.length === 0) return { message: `没有这张工单：${input}。用 /sa list 看现有工单的 id。` }
  if (matched.length > 1) {
    const shown = matched.slice(0, 3).map(ticket => `${ticket.id.slice(0, 8)}「${ticket.title}」`).join('、')
    return {
      message: `有歧义：以 ${input} 开头的工单有 ${matched.length} 张（${shown}${matched.length > 3 ? ' 等' : ''}）。` +
        '贴长一点（至少 8 位）再试。',
    }
  }
  return { ticket: matched[0] }
}

/** 状态档位 → 列表里那一格的说法。 */
function stageText(stage: TicketStage): string {
  switch (stage.stage) {
    case 'ended': return '已结束'
    case 'idle': return '空闲'
    case 'working': return stage.action === 'queued' ? '待派工' : '执行中'
    case 'person':
      switch (stage.action) {
        case 'delivery': return '等你接收'
        case 'answer': return '等你回答'
        case 'review': return '等你验收'
        case 'blocked': return '卡住了'
        case 'failed': return '失败了'
      }
  }
}

/**
 * 列表的一屏文本。
 *
 * 只显示 id 的前 8 位：完整 id 是 32 位十六进制，摆在一行里会把标题挤到看不见；
 * 按 id 操作的命令都认前缀（见 `resolveTicket`），所以 8 位够用。
 */
function renderList(tickets: readonly TicketView[]): string {
  if (tickets.length === 0) return '还没有工单。用 /sa new 标题 | 正文 建一个。'
  // 不用 `padEnd` 对齐：中文在等宽字体里占两列，按字符数补空格只会看着更歪。
  const lines = ['ID / 状态 / 标题']
  for (const ticket of tickets) {
    lines.push(`${ticket.id.slice(0, 8)}  ${stageText(ticket.stage)}  ${ticket.title}`)
  }
  return lines.join('\n')
}

/** 把未知异常压成一行，notice 里用。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 领域错误翻成人话。
 *
 * `core/errors.ts` 的 `USER_ERRORS` 是英文模板（核心要同时服务面板与命令，英文是上游原文），
 * 直接 `describe(error)` 会甩给用户一句 `Only an open ticket can be retried...`。这里按 `code`
 * 翻最常见的三条，其它原样透出——宁可露出原文，也不编一句错的。
 */
function explain(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (code === 'unknownTicket') return '没有这张工单（可能刚被清理），用 /sa list 看一眼'
  if (code === 'notRetryable') return '这张工单现在不能重试：只有「失败了」或「卡住了」、且之后没人再发消息的工单能重试'
  if (code === 'ticketEnded') return '这张工单已经结束了'
  return describe(error)
}

/** 三条动作命令成功后的那句话：先说做了什么，再带一眼当前状态。 */
const VERB_DONE: Record<TicketVerb, string> = {
  stop: '工单已停止',
  retry: '已重新派工',
  clean: '工作树已清理',
}

/** 失败时的开头三个字，不要把「已清理」和「失败」拼成一句自相矛盾的话。 */
const VERB_FAIL: Record<TicketVerb, string> = {
  stop: '停止失败',
  retry: '重试失败',
  clean: '清理失败',
}

/**
 * 注册 `/sa` 命令。
 *
 * `runtime` 是**取**运行期的函数：返回 null 表示未启动（连库失败），命令只给一句
 * 可操作的提示，不在这里重试建库——重试归 `index.ts` 的入口，命令层不该有第二套
 * 启动逻辑。
 *
 * @returns 退订函数；由调用方挂到 `ctx.effect` 上
 */
export function registerCommands(ctx: Context, runtime: () => SuperagentRuntime | null): () => void {
  return ctx.commands.register(
    {
      name: 'sa',
      args: '[new <标题> | <正文> | list | stop|retry|clean <id>]',
      label: 'Super Agent 工单',
      description: '把一句话派给独占工作区的智能体；/sa new 建单、/sa list 看单、/sa stop|retry|clean 按 id 管单',
    },
    ({ args, ui }) => {
      const parsed = parseSaCommand(args)
      if (parsed.kind === 'error') {
        ui.notice(parsed.message)
        return
      }
      let active: SuperagentRuntime | null
      try {
        active = runtime()
      } catch (error) {
        ui.notice(`Super Agent 没启动起来：${describe(error)}`)
        return
      }
      if (active === null) {
        ui.notice('Super Agent 未启动（连库失败）。命令不会替你重试，重启宿主或看日志。')
        return
      }
      if (parsed.kind === 'list') {
        ui.notice(renderList(active.list()))
        return
      }
      if (parsed.kind === 'stop' || parsed.kind === 'retry' || parsed.kind === 'clean') {
        // 先按用户敲的前缀把工单定下来：匹配到多条时这里就给一句「贴长一点」，不替他选。
        const found = resolveTicket(active.list(), parsed.id)
        if ('message' in found) {
          ui.notice(found.message)
          return
        }
        const { id, title } = found.ticket
        try {
          if (parsed.kind === 'stop') active.stop(id)
          else if (parsed.kind === 'retry') active.retry(id)
          else active.clean(id)
        } catch (error) {
          ui.notice(`${VERB_FAIL[parsed.kind]}：${explain(error)}`)
          return
        }
        // 成功那句带上操作后的状态，用户不用再 /sa list 确认一遍。
        // 清理只对已结束的工单开放（状态必然是「已结束」），再说一遍没有信息量。
        const after = parsed.kind === 'clean' ? undefined : active.list().find(item => item.id === id)
        const state = after === undefined ? '' : `，现在${stageText(after.stage)}`
        ui.notice(`${VERB_DONE[parsed.kind]}：${title}${state}`)
        return
      }
      try {
        const id = active.publish({ title: parsed.title, body: parsed.body })
        const ticket = active.list().find(item => item.id === id)
        // `publish` 在没接单时返回的是 Trigger id（见 `runtime.ts` 的注释），
        // 那种 id 在工单列表里查不到，这里据此分辨「建成」与「没建成」。
        ui.notice(ticket === undefined
          ? `已收到，但没有接单成功（id ${id}），去看日志。`
          : `工单已建：${ticket.title}（${id}）`)
      } catch (error) {
        ui.notice(`发布失败：${describe(error)}`)
      }
    },
  )
}
