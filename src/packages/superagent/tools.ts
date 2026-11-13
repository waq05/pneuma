/**
 * worker 的报告工具：让后台干活的 worker 主动把自己的状态报给工单。
 *
 * ## 为什么非有这个工具（backlog G7）
 *
 * 执行器原先只从 `turn/end` 推两种状态：正常收尾记 `ready`、出错记 `failed`
 * （`adapters/executor.ts` 的 `turnEndReport`）。可核心的 `ReportState` 有六种
 * （`core/model.ts:216`），其中 `blocked` / `progress` / `waiting` 根本没人产生。
 * 后果是 worker 在正文里问「用 A 还是 B」，那句话只会并进摘要，工单照样按 `ready` 收尾——
 * 用户看到的是「干完了」，实际在等人拍板。
 *
 * 上游的正解是给 worker 一个 `orchestrator_report` 工具（保护仓
 * `src/app/tools/executor.ts:74-103`）：状态由模型显式说出来，而不是由执行器猜。
 * 这里就是它的 DSC 版：参数收窄到 DSC 真正用得上的三个，执行时按会话反查 worker。
 *
 * ## 为什么风险记 `read`
 *
 * 工具自己不写文件、不跑命令、不碰工作树；它只把一段状态交给引擎，真正的状态校验与
 * 副作用在 `core/assignments.ts:99-134`（`blocked` 挂起自动输入、`ready` 结束工单）。
 * 把它记成 `write` 只会让无人值守的 worker 每次报进度都撞审批闸。
 *
 * ## 为什么依赖是窄接口
 *
 * 只用 `report(sessionId, report)` 一个方法：工具不需要认识执行器（它持有工作树、队列、
 * 会话那一大摊），执行器以后换实现也不必动这里。测试可以直接塞一个假函数。
 *
 * @module dsc/packages/superagent/tools
 */
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { WorkerReport } from './core/index.js'

/** 工具能报的五种状态；`waiting` 不开放——那是执行器自己判的「回合结束没交东西」。 */
const REPORT_STATES = ['progress', 'ready', 'blocked', 'failed', 'dropped'] as const

/** {@link REPORT_STATES} 的元素类型。 */
type ReportToolState = (typeof REPORT_STATES)[number]

/**
 * 报告工具的依赖面。
 *
 * 返回 `false` = 这条会话不是正在跑的 worker（工具据此抛错，不改任何状态）。
 * 为什么用布尔而不是抛错：执行器那边「找不到」是正常情况（用户在普通会话里调到了它），
 * 抛错该由工具这层翻译成模型看得懂的一句话。
 */
export interface ReportToolDeps {
  /**
   * 把报告交给这个会话所属的 worker。
   *
   * @param sessionId - 发起调用的会话（`ToolContext.sessionId`）
   * @param report - 状态、摘要与（仅 blocked 时的）问题
   * @returns true = 找到了 worker 并已上报；false = 这条会话不属于任何 worker
   */
  report(sessionId: string, report: WorkerReport): boolean
}

/** 报告落定后回给模型的一句话：说清「接下来该干别的还是停下」。 */
function confirmationOf(state: ReportToolState, question: string): string {
  switch (state) {
    case 'blocked':
      return `已报 blocked${question === '' ? '' : `（问题：${question}）`}：工单会停下来等人回答，这一回合到此为止，不要再继续动手。`
    case 'ready':
      return '已报 ready：工单按交付收尾。'
    case 'progress':
      return '已报 progress：人能看到中途进展，但它不算交付，干完还要报 ready。'
    case 'failed':
      return '已报 failed：工单会停在「等人处理」。'
    case 'dropped':
      return '已报 dropped：工单不再继续。'
  }
}

/**
 * 造 `superagent_report` 工具。
 *
 * `run` 只做三件事：校验参数、组装 {@link WorkerReport}、交给注入的 `report`。
 * 找不到 worker 时抛一句人话——模型看到「只在 worker 会话里可用」，比看到
 * `undefined` 或一条空成功更容易纠正自己。
 *
 * @param deps - 上报出口（生产环境接到运行期 / 执行器）
 */
export function createReportTool(deps: ReportToolDeps): ToolEntry {
  return {
    name: 'superagent_report',
    description:
      '给 Super Agent 的工单报状态：progress（有值得知道的进展）/ ready（这一回合干完、要交付）/ '
      + 'blocked（要人拍板才能继续）/ failed（确定做不下去）/ dropped（这件事不该由这张工单做）。'
      + '只在 Super Agent 的 worker 会话里可用，主会话没有这个工具。'
      + '需要人回答时用 blocked，把要问的原话写进 question，然后停下等回复；'
      + '干完要交付时用 ready。只在真有必要时调，不必每轮都报，也别拿 progress 代替 ready。',
    parameters: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: [...REPORT_STATES],
          description: 'progress / ready / blocked / failed / dropped；要给工单定终态就用后四个里的一个。',
        },
        summary: {
          type: 'string',
          description: '一句话说清现在的状态：progress 说做到了哪一步，ready 说交付了什么，blocked 说卡在哪。',
        },
        question: {
          type: 'string',
          description: '只在 state=blocked 时有用：要人回答的具体问题（一句话，说清要拍板什么）。',
        },
      },
      required: ['state', 'summary'],
    },
    // 见文件头：它不写文件、不跑命令，状态变更由引擎做。
    risk: 'read',
    async run(args, ctx) {
      const raw = String(args.state ?? '').trim() as ReportToolState
      if (!(REPORT_STATES as readonly string[]).includes(raw)) {
        throw new Error(`state 只能是 ${REPORT_STATES.join(' / ')}，收到「${String(args.state ?? '')}」`)
      }
      const state = raw
      const summary = String(args.summary ?? '').trim()
      if (summary === '') throw new Error('summary 不能为空：一句话说清现在是什么状态')
      // 问题只跟着 blocked 走：`ready` 带问题会被核心当非法报告拒掉
      // （`core/assignments.ts:102` 的 `questionWithResult`），另外几种状态带问题也没有人看。
      const question = state === 'blocked' ? String(args.question ?? '').trim() : ''
      const report: WorkerReport = { state, summary }
      if (question !== '') report.question = question
      if (!deps.report(ctx.sessionId, report)) {
        throw new Error('这个工具只在 Super Agent 的 worker 会话里可用：当前会话不属于任何正在跑的工单')
      }
      return confirmationOf(state, question)
    },
  }
}
