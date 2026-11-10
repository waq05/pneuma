/**
 * `bash` 工具卡的专用渲染体：`$ 命令` / 输出 / 退出码徽章（差距清单 S4 的第一张专用卡）。
 *
 * 为什么单开一张：参考实现给命令行工具一张「命令 + 回显 + 退出码」的卡，而本仓所有工具
 * 共用一张通用卡——参数表里一行 `{"command":"…"}`、结果缩在「输出」那一格，读起来像参数
 * 而不是一次命令的执行记录。这里只换掉通用卡的「参数表 + 结果尾巴」两块，头部与页脚照旧
 * （见 `factory.tsx` 的 bash 分支）。
 *
 * **不做黑底终端**：本仓的版式与配色以旧桌面端为准、会话区行内风格参考 codex
 * （`docs/ui-design.md` §6.1），黑底是参考实现自己的视觉语言。外观直接沿用仓里已有的代码块
 * 那一档（等宽 + `--dsc-fill-quaternary` 底 + 1px `--dsc-stroke-3` 描边 + `--dsc-r-block`
 * 圆角，见 `views.css` 的 `.file-md pre`），只在它上面加一行 `$ 命令` 和一枚退出码徽章。
 *
 * 退出码从哪来：宿主没有给结构化的退出码，`tools-default/bash.ts` 只在**非 0** 时把
 * 「退出码 N」写进结果文本的第一行（有终止原因时那行排第二），成功时结果里没有这一行。
 * 所以这里从结果文本里解析，并把那一行从正文摘掉——正文里再出现一次就是同一句话两遍。
 *
 * 纯函数（{@link bashCommandOf} / {@link bashOutcomeOf}）不碰 React，调试与回归探针
 * （`scripts/ui-tool-bash-test.mjs`）在 Node 里复刻同一套正则核对分支。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card/bash-view
 */
import type { ReactNode } from 'react'
import { createT, type ToolCallView } from '@dsc/ui'
import { formatDuration } from '@dsc/ui-primitives'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../../locale/ui.zh.json'
import en from '../../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 宿主写在结果文本里的退出码那一行。
 *
 * 只看前两行：命令被终止时结果的第一行是终止原因（超时 / 用户取消），退出码那行因此
 * 可能落到第二行；再往后就是命令自己的输出，那里出现的「退出码 3」是输出内容，不是状态。
 */
const EXIT_LINE = /退出码 (\d+)/

/** 从参数 JSON 里取命令；不是 bash 形态（没有 command 字段）就返回 null。 */
export function bashCommandOf(argsText: string): string | null {
  if (typeof argsText !== 'string' || argsText === '') return null
  try {
    const parsed: unknown = JSON.parse(argsText)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const command = (parsed as Record<string, unknown>)['command']
    return typeof command === 'string' && command.trim() !== '' ? command : null
  } catch {
    // 参数还在流式吐出来的半截 JSON：取不到命令就当不是终端形态（回落通用卡）。
    return null
  }
}

/** 从结果文本里取退出码，并把 `退出码 N` 那一行从正文里摘掉。 */
export function bashOutcomeOf(resultText: string | undefined): { code: number | null; body: string } {
  const text = typeof resultText === 'string' ? resultText : ''
  const lines = text.split('\n')
  const head = lines.slice(0, 2)
  for (let at = 0; at < head.length; at += 1) {
    const hit = EXIT_LINE.exec(head[at])
    if (hit === null) continue
    // 整行摘掉（含它自己那一个换行）：其余正文原样保留，连输出自己的缩进都不 trim。
    const rest = [...lines.slice(0, at), ...lines.slice(at + 1)]
    return { code: Number(hit[1]), body: rest.join('\n') }
  }
  return { code: null, body: text }
}

/** 终端块的状态档：与 `data-bash-state` 的取值一一对应。 */
type BashState = 'running' | 'done' | 'failed' | 'rejected'

/**
 * 展示状态 → 终端块的状态档。
 *
 * `preparing`（参数还没到齐）与 `running` 同档：这一格只在展开体里渲染，而参数没到齐的卡
 * 本来就不可展开，到不了这里。`aborted`（用户按了停止）归到 `rejected` 那一档：
 * 两者都是「没跑出退出码」，只是下面那枚徽章的文案不同。
 */
function bashStateOf(status: ToolCallView['status']): BashState {
  if (status === 'running' || status === 'preparing') return 'running'
  if (status === 'done') return 'done'
  if (status === 'failed') return 'failed'
  return 'rejected'
}

/** 退出码徽章的三档色：正常 / 非 0 / 没有数字（运行中、被拒、中止、跑挂）。 */
type ExitTone = 'ok' | 'bad' | 'none'

/** 徽章文案与色档：跑动中不写「退出码 0」（还没跑完就说 0 是错的）。 */
function exitViewOf(status: ToolCallView['status'], code: number | null): { text: string; tone: ExitTone } {
  if (status === 'running' || status === 'preparing') return { text: t('transcript.tool.bashRunning'), tone: 'none' }
  if (code !== null) {
    return { text: t('transcript.tool.bashExit', { code }), tone: code === 0 ? 'ok' : 'bad' }
  }
  // 解析不到退出码：工具算成功就是 0（宿主成功时本来就不写这一行）。
  if (status === 'done') return { text: t('transcript.tool.bashExit', { code: 0 }), tone: 'ok' }
  if (status === 'rejected') return { text: t('transcript.tool.bashRejected'), tone: 'none' }
  if (status === 'aborted') return { text: t('transcript.tool.bashAborted'), tone: 'none' }
  return { text: t('transcript.tool.bashFailed'), tone: 'none' }
}

/** 终端块：$ 命令 / 输出 / 退出码徽章。 */
export function BashBody({ call }: { call: ToolCallView }): ReactNode {
  // 命令取不到就画空串：调用方（factory）用 bashCommandOf 判过一道，到这里的 bash 卡必有命令。
  const command = bashCommandOf(call.argsText) ?? ''
  const outcome = bashOutcomeOf(call.resultText)
  const exit = exitViewOf(call.status, outcome.code)
  const duration = formatDuration(call.durationMs ?? null)
  /**
   * 输出原样交给 `<pre>`（保留自己的换行与缩进）。
   *
   * 两档空：
   * - **跑完了（`done`）真的一行都没有** → 画一句「（无输出）」，这是「命令执行过、它什么都
   *   没打印」；
   * - **还在跑** → 什么都不画。这一格的语义是「跑完了、没有输出」，跑动中写这句等于断言
   *   一件还没发生的事；徽章那格已经写着「运行中」，够读者判断了。没输出时连 `<pre>` 都
   *   不挂，这一格不白占高度。
   */
  const finished = call.status === 'done'
  const empty = outcome.body.trim() === ''
  const output = empty && finished ? t('transcript.tool.bashNoOutput') : outcome.body
  return (
    <div className="tc-bash" data-bash-state={bashStateOf(call.status)}>
      <div className="tc-bash-cmd">
        <span className="tc-bash-prompt" aria-hidden="true">
          $
        </span>
        <code>{command}</code>
      </div>
      {output === '' ? null : <pre className="tc-bash-out">{output}</pre>}
      <div className="tc-bash-meta">
        <span className="tc-bash-exit" data-exit={exit.tone}>
          {exit.text}
        </span>
        {duration === null ? null : <span className="tc-bash-time">{duration}</span>}
      </div>
    </div>
  )
}
