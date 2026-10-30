/**
 * 轮尾：用时 / 用量 / 复制 / 评价 / 分叉，以及回合进行中的状态行。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/rows/foot
 */
import type { ReactNode } from 'react'
import { IconBranch, IconCopy } from '@dsc/ui'
import { formatTokens } from '@dsc/ui-primitives'
import { formatClock, formatDuration, roundDuration, type RoundInfo } from '../timing'

/**
 * 轮尾一行（桌面端 `TurnFooter.tsx` 的同构移植）：复制 · 分叉 · 用量 · 时刻，
 * 一条左对齐行。
 *
 * 赞 / 踩两颗钮**去掉了**（产品决定）：评价只记本机、没有上传通道，留两颗按了不出声的
 * 钮只会让人以为「反馈发出去了」；本机存档（`dsc.messageFeedback`）也一并不再读写。
 *
 * 「用时」不占行面、只挂在整行的 title 上（旧界面口径：它是这一行里分量最轻的一项，
 * 形态上也与 dsh 不同——dsh 只在整轮过程总开关的标签上报时长）。**别再把它印成可见的
 * 一行字**：早期壳版在这里印原始秒数，把「684083.4 秒」这种数字直接摊给了用户。
 *
 * 降级规则（老会话没有 ts 时是常态，不是异常）：什么都没有 → 整行不画；只拿得到开始
 * 时刻 → 只显示 HH:mm；用时算不出来（含乱序日志）→ 不往 title 里写。绝不显示 NaN。
 * 这一轮还在跑时时刻与用量都不画：那一刻流末尾的状态行正在报同一份时间，两处一起跳
 * 反而乱；用量还在长，报半截数字没有意义。分叉按钮要留在这一行上（置灰）。
 */
export function RoundFoot(props: {
  /** 这一轮的起止时刻（timing.roundInfos 那份；用时 = 它俩之差）。 */
  round: RoundInfo
  /** 这一轮还在跑：时刻与用量先不画。 */
  running: boolean
  /** 这一轮最终回答的原文；没有（以工具结果收尾）就不画复制。 */
  copyText?: string
  /** 宿主上报的整轮真实用量（该轮最后一条带 usage 的条目）。 */
  usage: { inputTokens: number; outputTokens: number } | null
  /** 这一轮正文的 token 估算（没有真值时回落显示，带 ~）。 */
  tokens: number | null
  /** 「分叉这一轮」；undefined = 这个视图分不了（只读 / 第 1 轮）。 */
  onFork?: () => void
}): ReactNode {
  const clock = props.running ? null : formatClock(props.round.startTs)
  const used = props.running ? null : formatDuration(roundDuration(props.round))
  // 真值优先：0 或负数当没上报——真跑过一轮不可能一个 token 都没有。
  const measured = props.running ? null : props.usage
  const real =
    measured !== null && measured.inputTokens + measured.outputTokens > 0
      ? measured.inputTokens + measured.outputTokens
      : null
  // 回落口径：没有宿主上报的用量才用正文估算顶上（显示时带 ~）。
  const estimated = real !== null || props.running || props.tokens === null || props.tokens <= 0 ? null : props.tokens
  const copy = props.copyText !== undefined && props.copyText !== ''
  const fork = props.onFork !== undefined
  // 老会话什么时间都拿不到、又没有动作与用量要画：这一行不必占位（旧界面整行不渲染）。
  if (clock === null && !copy && !fork && real === null && estimated === null) return null
  return (
    // 与 `.changes-card` 同理：不再包 `.entry-row`，让 `.turn-seat > .round-foot` 的
    // 间距规则命中——包一层之后那条规则失配，回落到 `.round-foot` 自带的 -15px
    // 负外边距（它本来是给旧版 `.chat-inner` 的 16px 间距设计的），会把这一行顶进
    // 上面的改动卡里（截图里的「底部按钮与文件变更重叠」就是这么来的）。
    <div
      className="round-foot"
      // 「用时」不占行面，放在整行的悬停提示里（口径与旧界面一致）。
      title={
        used === null
          ? undefined
          : `用时 ${used}（从发出这条消息到这一轮最后一次写入，中间的工具调用与思考都算在内）`
      }
    >
      {copy ? (
        <button
          type="button"
          className="round-act"
          title="复制这条回复的原文"
          aria-label="复制这条回复的原文"
          onClick={() => {
            // 剪贴板被浏览器拒绝（非安全上下文）时不给假反馈，所以 .catch 里什么都不做。
            void navigator.clipboard.writeText(props.copyText ?? '').catch(() => undefined)
          }}
        >
          <IconCopy size={17} />
        </button>
      ) : null}
      {fork ? (
        <button
          type="button"
          className="user-act"
          title="以这条消息为界分叉出新会话"
          aria-label="以这条消息为界分叉出新会话"
          disabled={props.running}
          onClick={props.onFork}
        >
          {/* 图标 15px：方向性动作用小图标（与旧界面同一档），读数（用量、时刻）才用大的。 */}
          <IconBranch size={15} />
        </button>
      ) : null}
      {real !== null ? (
        <span
          className="round-tokens"
          title="这一轮所有模型请求的 prompt 与 completion 之和（宿主上报的真实用量）"
        >
          用量 {formatTokens(real)} tok
        </span>
      ) : null}
      {estimated !== null ? (
        <span
          className="round-tokens"
          title="助手正文的 token 估算值（老会话无宿主上报用量）"
        >
          ~{formatTokens(estimated)} tok
        </span>
      ) : null}
      {clock !== null && (real !== null || estimated !== null) ? (
        <span className="round-sep" aria-hidden="true">
          ·
        </span>
      ) : null}
      {clock !== null ? (
        <span className="round-clock" title="这条消息发出的时刻（本机时区）">
          {clock}
        </span>
      ) : null}
    </div>
  )
}

/**
 * 助手回合进行中的状态行：**只有一行**——转圈 + 一句话 + 尾部三点动画。
 *
 * 为什么从两行改成一行（2026-10-30 报障）：原来第一行「正在执行工具」、第二行
 * 「正在调用 bash，用时 10 分 41 秒」说的是同一件事；有过程组头时更是同一条信息出现三处
 * （组头「正在运行命令 · bash」+ 这两行）。现在的分工是：工具在跑时由组头说，这一行只在
 * 没有组头可依的阶段（分析 / 整理回复 / 等确认 / 压缩）露脸（见 timing.liveActivity 的 covered）。
 *
 * 用时不再挂在这里：它挪到底部状态栏（「N 轮 M 步 · 用时 X」），一轮跑了多久在那儿一直看得见，
 * 不必让消息流末尾的这半句话每秒重排一次。
 */
export function TurnStatusLine(props: { text: string }): ReactNode {
  return (
    <div className="turn-status">
      <span className="turn-status-spin" aria-hidden="true" />
      <span className="turn-status-stage" role="status">
        {props.text}
      </span>
      <span className="turn-status-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  )
}

