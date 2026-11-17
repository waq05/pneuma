/**
 * 移植自上游 `src/app/role-models.ts`（42 行，原生重写）。
 * 上游 import 了 `@deepseek-ai/cordis`（Context）、`@deepseek-ai/dsh-agent`（Agent / ModelSelection）与
 * `@deepseek-ai/dsh-llm`（ReasoningEffortId）；本仓照同一模块边界与导出名重写，只把宿主调用换成原生能力：
 *
 * | 上游（DSH） | 本仓原生等价物 |
 * | --- | --- |
 * | `ctx.llm.resolveCallConfig({ provider, model, reasoningEffort: ReasoningEffortId(x) })` | `ctx.llm.routeTo(provider, model, effort)`（`src/services/types.ts:150` 的 `LlmService.routeTo`；实现在 `src/packages/llm/index.ts:187-189`，端点/模型不存在时抛错） |
 * | `ModelSelection`（dsh-agent：`{ provider, model, reasoningEffort? }`） | {@link RoleModelSelection}：字段名照上游 `{ provider, model, reasoningEffort? }`；写进会话时映射成 `SessionStateMap['model']` 的 `effort?`（`src/core/session.ts:353`） |
 * | `Agent`（dsh-agent 的会话句柄） | `Session`（`@pneuma/runtime/core/session.js`，`src/core/session.ts:555`）。本仓没有人格化 agent 这一层，会话自己就是模型选择的持有者 |
 * | `agent.session.requestHeader()` 判「已经发过请求」 | `session.messages.length > 0`（`src/core/session.ts:558`；有消息即已发过请求） |
 * | `agent.session.snapshotEvents().some(e => e.type === 'model/selection')` 判「已经选过模型」 | `session.state('model') !== undefined`（llm 插件在 /model 切换与新会话打开时写这一条，`src/packages/llm/index.ts:71-92,244,263`） |
 * | `agent.session.append('model/selection', selected)` | `session.appendState('model', selected)`（`src/core/session.ts:1101`，写内存并追加一条 state 日志，恢复会话时最后一条生效） |
 * | `agent.ctx.effect(...)` 里两条 `system-prompt/assemble` / `agent/request` waterfall + `ctx.on('session/event')` | **不需要**。上游用它们只为一件事：把这次选择只塞进「初始那一次请求」，而不改动 DSH 的全局默认（见上游第 19 行注释）。本仓的模型选择本来就是**按会话**存的（llm 插件的 `routeForSession` 读 `SessionStateMap['model']`，`src/packages/llm/index.ts:174-177`），种进会话状态既不影响全局、也不会漏给别的会话；用户之后手动换模型写的是更新的一条 state，天然「后选覆盖先选」 |
 * | `await ctx.sessionPersistence.flush()` | **不需要**。本仓 `appendState` 同步追加日志（会话第一次写盘前由 Session 自己缓冲，见 `src/core/session.ts:1101-1106`），没有单独的持久化服务要 flush |
 *
 * 两处口径差异，都是宿主差异而不是语义改动：
 *   ① 上游 `resolveCallConfig` 只要求「经活的 provider 解析」，不要求模型在目录里；本仓 `routeTo`
 *      按 `config.yaml` 的端点/模型表解析，不在表里就抛错。因此 `resolveRoleModel` 只用于**校验 + 落地**
 *      一个设置里填的选择；校验失败由 `settings.ts` 包成 `UserError('modelUnavailable')`。
 *   ② 上游 `initializeRoleModel` 内部再解析一次模型；本仓签名按 `app/sessions.ts` 的调用点定为
 *      `(session, model)`（s6 已确认），没有 `Context` 可用来解析。因此种入的是设置里的原值，校验只发生在
 *      保存设置那一步（`settings.save` → `resolveRoleModel` → `llm.routeTo`）。设置之外的调用方若跳过保存
 *      直接种一个表外模型，发请求时由 llm 插件按它自己的口径处理（表外端点抛错、表外模型回落配置默认，
 *      见 `src/packages/llm/index.ts:142-150`）；这与上游 `resolveCallConfig` 允许表外模型的口径不同，
 *      是本仓「模型表由 config.yaml 独占」的宿主差异。
 *
 * Resolves and seeds per-role default models on newly created sessions without mutating the global DSH default.
 *
 * @module dsc/packages/superagent/app/role-models
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@pneuma/runtime/core/session.js'
import type { EffortLevel } from '@pneuma/runtime/contract.js'
import type { RoleModel } from '../core/policy.js'

/** 上游 `ModelSelection` 的本仓等价物：字段名照上游，落盘时映射到会话 `model` 状态（`src/core/session.ts:353`）。 */
export interface RoleModelSelection { provider: string; model: string; reasoningEffort?: EffortLevel }

/** 本仓的思考强度档位（`src/contract/mode.ts:14` 的 `EffortLevel`）。 */
const EFFORTS: readonly EffortLevel[] = ['default', 'off', 'low', 'high', 'max']
/** 把设置里的 `reasoningEffort`（自由字符串）收成 `EffortLevel`；空 = `'default'`（不声明思考字段）。 */
function effortOf(effort: string | undefined): EffortLevel {
  if (effort === undefined) return 'default'
  if (!(EFFORTS as readonly string[]).includes(effort)) throw new Error(`Unknown reasoning effort "${effort}"; use one of ${EFFORTS.join(', ')}`)
  return effort as EffortLevel
}
/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
export function resolveRoleModel(ctx: Context, model: RoleModel): RoleModelSelection {
  const effort = effortOf(model.reasoningEffort)
  // 组装一次路由：端点/模型不可用时在这里抛出可读原因（上游 resolveCallConfig 同一职责）。
  ctx.llm.routeTo(model.provider, model.model, effort)
  return { provider: model.provider, model: model.model, ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: effort }) }
}

/** Seed a role's configured model onto a brand-new session before its first request, leaving later manual or durable selections intact. */
export function initializeRoleModel(session: Session, model: RoleModel | null): void {
  if (!model) return
  if (session.messages.length > 0 || session.state('model') !== undefined) return
  // Avoid llm.setModel because it mutates `lastSelected` (the process-wide default for new sessions); record the selection on this session only.
  session.appendState('model', { provider: model.provider, model: model.model, ...(model.reasoningEffort === undefined ? {} : { effort: effortOf(model.reasoningEffort) }) })
}
