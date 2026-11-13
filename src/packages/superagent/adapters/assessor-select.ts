/**
 * 判定器的选择：配了模型就用模型，没配就用 P0 那套同步规则。
 *
 * 为什么要单独一个文件而不是在 runtime 里写个三元表达式：判定器的形状是本包自己的约定
 * （核心端口 + 泵要的 `drain` / `clear`），两个实现必须同时满足它。写成一处，换实现时
 * 编译器会当场告诉你少了个方法，而不是等泵在半夜报 `drain is not a function`。
 *
 * **默认必须是没模型的这一支**：`eval.model` 在核心的 schema 里是 `nullable().default(null)`
 * （`core/policy.ts:98`），也就是说「不配模型」是合法且默认的形态。装上插件什么都不配，
 * 行为要与 P0 逐字一致——不偷偷发一次模型请求，也不因为没网而卡住工单。
 *
 * @module dsc/packages/superagent/adapters/assessor-select
 */
import type { Engine, Assessor } from '../core/index.js'
import type { RoleModel, Settings } from '../core/policy.js'
import { ManualAssessor } from './assessor.js'
import { ModelAssessor, type AssessorComplete, type AssessorContext, type HeldCandidate } from './assessor-model.js'

/** 本包用的判定器：核心端口 + 泵每拍要的两件事。 */
export interface SuperagentAssessor extends Assessor {
  /** 泵的一拍：把待判定的候选推进一步；返回这一拍建出的工单 id（模型版必然是空的）。 */
  drain(engine: Engine): string[]
  /** 丢掉全部待办；运行期关闭时用。 */
  clear(): void
}

/** 选择所需的依赖。 */
export interface AssessorSelection {
  /** 配的模型；`null` = 不调模型（默认）。 */
  model: RoleModel | null
  /** 现读设置：规则表与接单模式改了，下一条判定就用新的。 */
  settings: () => Settings
  /** 一次问答。配了模型却没给它，等于配不出模型版——按没配处理。 */
  complete?: AssessorComplete
  /**
   * 线程上下文。运行期给的是「按 Trigger 现读来源的对话窗口」；不给就是没有这一节。
   *
   * 同步规则那一支不需要它：`ManualAssessor` 只看规则名单，从不问模型，也就不需要前后文。
   */
  context?: AssessorContext
  onError?: (error: unknown, evalId: string) => void
  log?: (line: string) => void
  /** 推断候选的落点（backlog G1）；不给 = 判定即接单的老行为。 */
  holdCandidate?: (hold: HeldCandidate) => void
}

/**
 * 按配置挑一个判定器。
 *
 * 模型版缺 `complete`（宿主没接上模型服务）时**退回同步规则**，不抛错：插件装上了但没有
 * 模型可用，应当表现为「本机能判断的照常判断」，而不是「点了发布没反应」。
 */
export function selectAssessor(selection: AssessorSelection): SuperagentAssessor {
  if (selection.model !== null && selection.complete !== undefined) {
    return new ModelAssessor({
      complete: selection.complete,
      settings: selection.settings,
      ...(selection.context === undefined ? {} : { context: selection.context }),
      ...(selection.onError === undefined ? {} : { onError: selection.onError }),
      ...(selection.log === undefined ? {} : { log: selection.log }),
      ...(selection.holdCandidate === undefined ? {} : { holdCandidate: selection.holdCandidate }),
    })
  }
  return new ManualAssessor(selection.onError)
}
