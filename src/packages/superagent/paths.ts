/**
 * superagent 的落盘坐标：一个库、一把锁、每个工单一个会话目录、一块提示词目录。
 *
 * 为什么单独一份：库文件、锁、会话、提示词这四样要由适配层、执行器、体检脚本分别拼路径。
 * 各拼一遍就会冒出 `superagent` 与 `superagent/`、`\` 与 `/` 两种写法；Windows 上大小写
 * 不一致还会算成两个目录，于是「锁明明拿着」却能被第二个进程再拿一次。这里只留一份。
 *
 * `<DSC_HOME>` 的取法照 `src/core/schedule/store.ts:104-108`：环境变量优先，否则
 * `~/.dsc`（`src/core/path-policy.ts:20`）。每次调用重读环境变量，是为了让包级测试能把
 * 整个存储层指到临时目录，而不必在 import 之前先设好。
 *
 * @module dsc/packages/superagent/paths
 */
import { join } from 'node:path'
import { dscPath } from '@pneuma/runtime/core/path-policy.js'

/** 工单 id 当目录名用时的形状：不以点开头（挡住 `..` 与隐藏目录），只留安全字符。 */
const TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** superagent 的数据根：`<DSC_HOME>/superagent`。 */
export function superagentRoot(): string {
  return join(process.env.DSC_HOME ?? dscPath(), 'superagent')
}

/** 编排库：工单、事件、出站队列都在这一个文件里。 */
export function orchestratorDbPath(): string {
  return join(superagentRoot(), 'orchestrator.sqlite')
}

/** 单实例锁的锚点文件（`tryOsLock` 拿它算命名互斥量；POSIX 下会再多一个 `.lock` 后缀文件）。 */
export function orchestratorLockPath(): string {
  return join(superagentRoot(), 'orchestrator.lock')
}

/**
 * 某个工单的会话目录。
 *
 * 校验 id 不是防御性摆设：这个值会拼进文件路径，上游一旦从工单文本里取值，`../` 就能把
 * 会话写到数据根外面去。
 */
export function sessionsDir(ticketId: string): string {
  if (!TICKET_ID.test(ticketId)) throw new Error(`工单 id 不能当目录名：${JSON.stringify(ticketId)}`)
  return join(superagentRoot(), 'sessions', ticketId)
}

/**
 * 可在运行期覆盖的提示词目录：`<DSC_HOME>/superagent/prompts`。
 *
 * 为什么和包内 `prompts/` 分开：包内那份是出厂文案（安装目录可能只读），主会话要改提示词
 * 就得写用户的数据根。读的时候先看这里、没有再退回包内，包内也读不到才用内置兜底
 * （`adapters/executor.ts` 的 `loadPromptVolumes`）。
 */
export function promptsDir(): string {
  return join(superagentRoot(), 'prompts')
}
