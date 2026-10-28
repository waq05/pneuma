/**
 * UI ⇄ adapter 的共享契约（单一真源）。**本文件只做转出**，实体按域放在 `src/contract/`。
 *
 * 边界规则（对齐 dsh-TUI 的 adapter 边界实践）：
 *   - `src/adapter/**` 是唯一允许 import `@deepseek-ai/*` 运行期包的层；
 *   - UI 层（`src/app/**`、`src/state/**`、`src/commands.ts`）只依赖这里的
 *     中立类型，通过 DscRuntime 与宿主世界交互；
 *   - 本文件与 `src/contract/**` 自身不得 import 任何 `@deepseek-ai/*`。
 *
 * 为什么分家：一份 2,093 行的契约文件里改「设置」的一个字段，要在 2,093 行里找位置；
 * 十来个人同时动的话每次都是冲突。分成十域之后每域一两百行，改设置只看 `settings.ts`。
 * 导出面一个没变——调用方照旧 `import type { … } from '../contract.js'`。
 *
 * @module dsc/contract
 */

export * from './contract/mode.js'
export * from './contract/task.js'
export * from './contract/transcript.js'
export * from './contract/usage.js'
export * from './contract/runtime.js'
export * from './contract/approval.js'
export * from './contract/session.js'
export * from './contract/plugin.js'
export * from './contract/settings.js'
export * from './contract/snapshot.js'
