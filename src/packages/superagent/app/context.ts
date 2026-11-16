/**
 * 移植自 dsh-superagent/src/app/context.ts（33 行，原生重写）。
 *
 * 上游只依赖 DSH 一处：`import type { SessionEvent } from '@deepseek-ai/dsh-session'`，
 * 用在文件末尾的 `transcriptEntry()`。本仓的等价能力是
 * `core/dsh-compat/session-bridge.ts:43` 的 `BridgeEvent`：它把会话 jsonl 的每一行翻成
 * dsh 的 `user/message` / `assistant/message` / `tool/result` 事件，正是上游
 * `sessionController.inspect(id).events`（`app/resources.ts:114-116`）在 DSC 侧的对应物。
 * 因此只换类型：判定顺序（先筛三种事件类型）、返回结构（`{ type, message: { role, content } }`）、
 * 过滤 `reasoning` 块的行为都与上游逐行一致。
 *
 * 其余部分（`promptFile` 读 md、`textPage` 再导出）没有 DSH 依赖，逐字保留：
 * 上游这两件事一个在本文件的 `sharedPrompt` 等常量里，一个在 `export { textPage }`。
 * 会话前缀的装配不在本文件：DSC 由 `core/session.ts:1250` 的 `appendSystemPrompt(view, text)`
 * 接收调用方（`app/sessions.ts` / `app/runtime.ts`，其它批次）拼好的段与 `PromptSectionView`；
 * 本文件只负责给出这些段的文本来源。
 *
 * 内置提示词段落、角色策略与会话转录投影，orchestrator 与 worker Session 共用。
 *
 * @module dsc/packages/superagent/app/context
 */
/** Built-in prompt sections, role policies, and transcript projections for orchestrator and worker Sessions. */
import { bundledSkills, promptFile } from './skill-files.js'
import type { BridgeEvent } from '../../../core/dsh-compat/session-bridge.js'
export { textPage } from './cards.js'

/** Built-in host-delivery and tool-usage rules shared by all Sessions; a team may override them (`builtInParts`). */
export const sharedPrompt = promptFile('shared')
export const masterPrompt = promptFile('orchestrator')
export const workerPrompt = promptFile('worker')
/** Built-in policy sections referenced by role prompts; a team may override them. */
export const guides: Readonly<Record<string, string>> = Object.fromEntries(['subscriptions', 'replies', 'dispatch', 'work']
  .map(name => [name, promptFile(name)]))
/** Bundled Source skills registered by dsh-superagent; a team may override their text. */
export const sourceSkills: Readonly<Record<'feishu' | 'github', string>> = { feishu: bundledSkills.feishu.content, github: bundledSkills.github.content }
export const cliNotes = promptFile('cli')
/** Default text for the team-editable prompt sections (communication, ticket scope, and PR delivery). */
export const teamDefaults = {
  communication: promptFile('team/communication'), scope: promptFile('team/scope'), delivery: promptFile('team/delivery'),
}

export const mainAdmissionPolicy = promptFile('admission')

const handoff = { shared: promptFile('handoff'), orchestrator: promptFile('handoff-orchestrator'), worker: promptFile('handoff-worker') }
export const handoffPolicy = (role: 'orchestrator' | 'worker'): string => `${handoff.shared}\n${handoff[role]}`

export const autoMergeThreshold = (lines: number): string => `it changes fewer than ${lines} lines (additions plus deletions);`

/** A content block of a dsh-shaped message; only `text` blocks carry text, the rest are labelled by `type`. */
type TranscriptBlock = { type: 'text'; text: string } | { type: string }
/** The message view `transcriptEntry` reads: its role and content blocks (dsh messages also carry `id` and `source`). */
interface TranscriptMessage { role: string; content: readonly TranscriptBlock[]; [key: string]: unknown }

/** Retains message content while omitting streamed chunks, usage accounting, and reasoning blocks. */
export function transcriptEntry(event: BridgeEvent) {
  if (event.type !== 'user/message' && event.type !== 'tool/result' && event.type !== 'assistant/message') return undefined
  const message = (event.type === 'user/message' ? event.data : event.data['message']) as TranscriptMessage
  return { type: event.type, message: { role: message.role, content: message.content.filter(block => block.type !== 'reasoning') } }
}
