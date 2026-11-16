/**
 * DSC 宿主的 `/sa` 命令：工单的建 / 看 / 停 / 重试 / 清理。
 *
 * ## 为什么单独一个文件
 *
 * `/sa` 是 DSC 专有入口（上游 dsh-superagent 的工单操作都在它自己的管理面板里，没有
 * 终端命令），而且面板与命令共用同一套运行期能力——只是入口不同。旧入口把命令放在
 * `commands.ts`（吃旧 `SuperagentRuntime`），本批把它接到新树的面板服务
 * `app/api.ts` 的 `PanelApi` 上：`surface()` 读快照、`publish` / `stop` / `retry` /
 * `clean` 走与 `ui-superagent` 完全相同的写路径，不再经过旧 `service.ts`。
 *
 * 命令服务的一条 `CommandSpec.name` 只能是一个词（`src/services/types.ts:621`），所以
 * `/sa new ...` 与 `/sa list` 注册成一条 `sa`，第一个参数当子命令——与旧入口同一取舍。
 * 解析单独导出（`parseSaCommand`），包级测试不必起整个宿主。
 *
 * ## 与新树的两处必然差异
 *
 * 1. **写动作是异步的**：新树 `publish` 要等主会话的模型回合做判定（`app/api.ts:236-254`），
 *    `stop` / `retry` 要跑一拍把效果推出去。命令处理器本身是同步的（`CommandHandler` 返回
 *    void），所以结果用 `ui.notice` 在 Promise 收尾时回；与 `/schedule` 的写法一致。
 * 2. **列表读快照面**：`PanelApi.surface()` 的工单行就是面板看到的那一份，命令不再自己
 *    拼一份视图，两处口径因此不会漂。
 *
 * @module dsc/packages/superagent/host/command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SuperagentTicketView } from '@pneuma/runtime/contract.js'
import type { CommandContext, CommandSpec } from '@pneuma/runtime/services/types.js'
import type { PanelApi } from '../app/api.js'

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
 * 与库无关（见 `registerSaCommand` 里的 `resolveTicket`）。
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
  tickets: readonly SuperagentTicketView[],
  input: string,
): { ticket: SuperagentTicketView } | { message: string } {
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

/** 状态档位 → 列表里那一格的说法（与旧命令逐字一致）。 */
function stageText(stage: SuperagentTicketView['stage']): string {
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
function renderList(tickets: readonly SuperagentTicketView[]): string {
  if (tickets.length === 0) return '还没有工单。用 /sa new 标题 | 正文 建一个。'
  // 不用 `padEnd` 对齐：中文在等宽字体里占两列，按字符数补空格只会看着更歪。
  const lines = ['ID / 状态 / 标题']
  for (const ticket of tickets) lines.push(`${ticket.id.slice(0, 8)}  ${stageText(ticket.stage)}  ${ticket.title}`)
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
const VERB_DONE: Record<TicketVerb, string> = { stop: '工单已停止', retry: '已重新派工', clean: '工作树已清理' }
/** 失败时的开头三个字，不要把「已清理」和「失败」拼成一句自相矛盾的话。 */
const VERB_FAIL: Record<TicketVerb, string> = { stop: '停止失败', retry: '重试失败', clean: '清理失败' }

/** 运行期没就绪时的那句话：能操作的只是「等」，说清楚缺什么。 */
function notReady(api: PanelApi): string {
  const surface = api.surface()
  return `Super Agent 未就绪：${surface.problem?.detail ?? '运行期还没起来'}`
}

/** 跑一条写动作，结果用 notice 回来（命令处理器本身是同步的）。 */
function runTicketAction(ui: CommandContext, api: PanelApi, verb: TicketVerb, ticket: SuperagentTicketView): void {
  const action = verb === 'stop' ? api.stop(ticket.id) : verb === 'retry' ? api.retry(ticket.id) : api.clean(ticket.id)
  void action.then(
    () => {
      // 清理只对已结束的工单开放（状态必然是「已结束」），再说一遍没有信息量。
      const after = verb === 'clean' ? undefined : api.surface().tickets.find(item => item.id === ticket.id)
      ui.notice(`${VERB_DONE[verb]}：${ticket.title}${after === undefined ? '' : `，现在${stageText(after.stage)}`}`)
    },
    (error: unknown) => { ui.notice(`${VERB_FAIL[verb]}：${explain(error)}`) },
  )
}

/**
 * 注册 `/sa` 命令。
 *
 * 所有读写都走 `PanelApi`：命令层不碰库、不认执行器，与面板服务是同一条路。
 *
 * @param ctx - 插件上下文（`commands` 服务已就绪，见 `index.ts` 的 inject）
 * @param api - 面板服务（`createApi(runtime)` 的返回值）
 * @returns 退订函数；由调用方挂到 `ctx.effect` 上
 */
export function registerSaCommand(ctx: Context, api: PanelApi): () => void {
  const spec: CommandSpec = {
    name: 'sa',
    args: '[new <标题> | <正文> | list | stop|retry|clean <id>]',
    label: 'Super Agent 工单',
    description: '把一句话派给独占工作区的智能体；/sa new 建单、/sa list 看单、/sa stop|retry|clean 按 id 管单',
  }
  return ctx.commands.register(spec, ({ args, ui }) => {
    const parsed = parseSaCommand(args)
    if (parsed.kind === 'error') {
      ui.notice(parsed.message)
      return
    }
    const surface = api.surface()
    if (!surface.ready) {
      ui.notice(notReady(api))
      return
    }
    if (parsed.kind === 'list') {
      ui.notice(renderList(surface.tickets))
      return
    }
    if (parsed.kind === 'stop' || parsed.kind === 'retry' || parsed.kind === 'clean') {
      // 先按用户敲的前缀把工单定下来：匹配到多条时这里就给一句「贴长一点」，不替他选。
      const found = resolveTicket(surface.tickets, parsed.id)
      if ('message' in found) {
        ui.notice(found.message)
        return
      }
      runTicketAction(ui, api, parsed.kind, found.ticket)
      return
    }
    // `publish` 会等主会话判定（新树里判定是模型回合），所以结果异步回。
    void api.publish({ title: parsed.title, body: parsed.body }).then(
      id => {
        const ticket = api.surface().tickets.find(item => item.id === id)
        // 新树 `publish` 只在出了工单时返回工单 id，查不到说明快照还没刷新或者刚被清理。
        ui.notice(ticket === undefined ? `已收到，但没有接单成功（id ${id}），去看日志。` : `工单已建：${ticket.title}（${id}）`)
      },
      (error: unknown) => { ui.notice(`发布失败：${describe(error)}`) },
    )
  })
}
