/**
 * 手动来源：把 `/sa new 标题 | 正文` 这段话包装成一条领域 `Trigger`。
 *
 * 这个文件只做「形状转换」，不做准入判断：那句话能不能开工，由 `Engine.receive`
 * 之后的准入闸（`core/policy.ts` 的 `gate`）按设置里的名单判定。把判定塞进这里，
 * 就会冒出两套规则（适配层一套、核心一套），改一处忘另一处。
 *
 * @module dsc/packages/superagent/adapters/manual
 */
import { randomUUID } from 'node:crypto'
import { key } from '../core/ids.js'
import type { Trigger } from '../core/model.js'
import type { ScopeResult, SourceScope } from '../core/ports.js'
import { DEFAULT_ACTOR, MANUAL_SOURCE } from './settings.js'

/**
 * 用户敲的一条需求。
 *
 * `body` 可以为空：命令解析（`commands.ts`）在缺正文时已经把正文填成标题了，
 * 这里再兜一次底，省得别的调用点漏填时造出一条 `text: ''` 的 Trigger——
 * 空正文的 Trigger 能通过准入，但建出来的工单没有任何可用于执行的内容。
 */
export interface ManualRequest { title: string; body: string; actor?: string }

/**
 * 把一条手动请求变成 `Trigger`。
 *
 * 三个必须讲清的选择：
 *
 * 1. **`id` 带随机量**。核心的 `key()` 是内容哈希，同样的输入永远同一个 id；而 `Intake`
 *    收到已存在的 id 会返回 `duplicate`（`core/intake.ts:23`），于是「同一句话发两次」
 *    只会有一张工单。P0 的验收明确要求两次得两张工单（P0 不做去重），所以这里在哈希
 *    的输入里掺一个 `randomUUID()`——内容相同、时间相同也能得到不同的 id。
 * 2. **`addressed: 'direct'`**。准入闸给 `explicit` 强度的条件是「在名单里 **且**
 *    这条消息是对着智能体说的」（`core/policy.ts:209`：`allowed && trigger.addressed`）。
 *    不带 `addressed` 会掉进准入表那一格，而那张表默认给 `inferred` 或 `ignore`，
 *    于是用户明确写下的需求反而变得「不够明确」。终端里敲的是给智能体的指令，
 *    所以记 `direct`（直接对它说），不是群聊里的 `mention`。
 * 3. **标题进 `meta.title`**。`Trigger` 模型里没有 `title` 字段（`core/model.ts:23-39`），
 *    只有 `text` 与自由形状的 `meta`。标题要能被 `ManualAssessor` 取到、又要不污染
 *    正文（正文是将来喂给执行器的需求原文），只能放 `meta`，正文放 `text`。
 *
 * @param input - 标题、正文与可选的发送者
 * @param now - 当前时刻，`Date#toISOString` 形式；核心不读环境时钟
 * @returns 一条 `human` 的手动 Trigger
 * @throws 标题为空时抛错——调用点应在更外层给出可操作的提示，而不是造一条空工单
 */
export function manualTrigger(input: ManualRequest, now: string): Trigger {
  const title = input.title.trim()
  if (title === '') throw new Error('manual trigger needs a non-empty title')
  const body = input.body.trim() === '' ? title : input.body.trim()
  const id = key('trigger', MANUAL_SOURCE, now, title, body, randomUUID())
  const actor = input.actor?.trim()
  return {
    id,
    source: MANUAL_SOURCE,
    // 每条命令消息一条独立线程：P0 不做「同一句话算同一个线程」的归并，
    // 否则两次发布会被 Eval 的防抖合并，第二张工单就建不出来。
    threads: [{ source: MANUAL_SOURCE, id: `${MANUAL_SOURCE}:${id}` }],
    actor: { source: MANUAL_SOURCE, id: actor === undefined || actor === '' ? DEFAULT_ACTOR : actor },
    human: true,
    addressed: 'direct',
    at: now,
    text: body,
    meta: { title },
  }
}

/**
 * 手动来源的接收范围。
 *
 * P0 只有 manual 一个来源，`observed: true` 表示「这个来源里的消息全都收」——
 * 准入闸把它记进 `MandateBasis.scope`，将来改设置时 `revalidate` 会重读这一位。
 * 别的来源在这里一律「不监听」：P0 没有接 GitHub / 飞书，真让它们进来也没人判定，
 * 只会攒一堆 `filtered` 的 Trigger。
 */
export const manualScope: SourceScope = {
  scope({ source }): ScopeResult {
    if (source !== MANUAL_SOURCE) return { listened: false, reason: 'source_not_connected' }
    return { listened: true, observed: true }
  },
}
