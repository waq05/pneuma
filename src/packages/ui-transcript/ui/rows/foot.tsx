/**
 * 轮尾：用时 / 用量 / 复制 / 评价 / 分叉，以及回合进行中的状态行。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/rows/foot
 */
import { useEffect, useState, type ReactNode } from 'react'
import { IconBranch, IconCopy, createT } from '@dsc/ui'
import { formatTokens } from '@dsc/ui-primitives'
import { formatClock, formatDuration, roundDuration, type RoundInfo } from '../timing'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../../locale/ui.zh.json'
import en from '../../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

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
 * 反而乱；用量还在长，报半截数字没有意义。
 *
 * 复制与分叉**只在停止之后才画**（2026-11-02 报障）：这一轮还在跑时按「复制」拿到的是
 * 半截回答，按「分叉」分出来的是半截会话——两颗钮那会儿都是假的。原先的补救是把分叉
 * 置灰、复制留着，可一张灰钮摆在正在输出的正文下面，读起来仍是「这里能点」。
 * 停下之后它们也不常驻：默认透明，鼠标落到这一轮的输出上、或键盘 Tab 进这一轮才现
 * （样式见 legacy/views.css 末尾「轮尾的复制 / 分叉」那一段）。
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
  const copy = !props.running && props.copyText !== undefined && props.copyText !== ''
  const fork = !props.running && props.onFork !== undefined
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
        used === null ? undefined : t('transcript.foot.durationTip', { duration: used })
      }
    >
      {copy ? (
        <button
          type="button"
          className="round-act"
          title={t('transcript.foot.copy')}
          aria-label={t('transcript.foot.copy')}
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
          title={t('transcript.foot.fork')}
          aria-label={t('transcript.foot.fork')}
          onClick={props.onFork}
        >
          {/* 图标 15px：方向性动作用小图标（与旧界面同一档），读数（用量、时刻）才用大的。 */}
          <IconBranch size={15} />
        </button>
      ) : null}
      {real !== null ? (
        <span
          className="round-tokens"
          title={t('transcript.foot.usageTip')}
        >
          {t('transcript.foot.usage', { count: formatTokens(real) })}
        </span>
      ) : null}
      {estimated !== null ? (
        <span
          className="round-tokens"
          title={t('transcript.foot.estimateTip')}
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
        <span className="round-clock" title={t('transcript.foot.clockTip')}>
          {clock}
        </span>
      ) : null}
    </div>
  )
}

/**
 * 助手回合进行中的直播行：**只有一行**——转圈 + 一句话 + 用时 + 尾部三点动画。
 *
 * 形态对齐 dsh 的 `RunningStatus`（client-ui-chat 的 `.running`）：贴在流末尾、上面一条
 * 0.5px 细线、整句带扫光、后面跟着「用时 X」。dsh 那句是固定的「深度求索中，用时 X」——
 * 不报工具名，所以组头说「正在运行命令」时也不重复（这是 2026-10-30 去重的老教训）。
 * 这里照同一口径：行面只说状态 + 用时，具体在调什么收进悬停提示。
 *
 * 用时的时钟关在这个组件里（2026-11-08）：只有这一行每秒重排，消息流本身不跟着动。
 * 起点拿不到（2026-09 前的老会话没有 ts）就只报状态、不报时间，绝不显示 NaN 或 0 秒。
 */
export function TurnStatusLine(props: {
  /** 行面主文案：「Numa 工作中」/「等待你的确认」（等确认时不能谎称在工作）。 */
  text: string
  /** 本轮开始时刻（毫秒）：null = 这一轮没有可信起点，不报用时。 */
  startedAt: number | null
  /** 悬停提示：此刻具体在干什么（工具名这类细节，行面不重复组头）。 */
  hint?: string
}): ReactNode {
  const running = props.startedAt !== null
  // 每秒跳一次的「现在」；只在跑动时开 interval（回合结束这一行随之消失）。
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), LIVE_CLOCK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [running, props.startedAt])
  const used = props.startedAt === null
    ? null
    : formatDuration(Math.max(LIVE_CLOCK_INTERVAL_MS, now - props.startedAt))
  const line = used === null
    ? props.text
    : t('transcript.status.withDuration', { label: props.text, duration: used })
  return (
    <div className="turn-status" title={props.hint}>
      <span className="turn-status-spin" aria-hidden="true" />
      {/* data-shimmer 的值就是 ::after 要复制的那串文字（见 views.css 里那条共用规则）：
          扫光盖在整句上，用时跟着一起亮，读起来才是「还在往前走」。 */}
      <span className="turn-status-stage" data-shimmer={line} role="status">
        {line}
      </span>
      <span className="turn-status-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  )
}

/** 直播行用时跳一拍的间隔（毫秒）：与 dsh 的 `LIVE_RUN_CLOCK_INTERVAL_MS` 同值。 */
const LIVE_CLOCK_INTERVAL_MS = 1000

