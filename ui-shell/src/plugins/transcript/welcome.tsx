/**
 * 空会话首屏：一句招呼 + 四张能力卡 + 「接着上次」。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/welcome
 */
import type { ReactNode } from 'react'
import { IconClock, IconCode, IconDiff, IconSpark, IconTarget } from '@dsc/ui'
import { ReviewNoticeCard, parseReviewNotice } from '@dsc/ui-primitives'
import { keyOf, type Row } from './shared'

/**
 * 首屏四张能力卡（对照 Codex UI 的 home cards）：点一下把提示词写进输入框，不直接发送——
 * 提示词里带冒号的留了下一句的位置，用户可以接着补。
 *
 * 图标只用壳里已有的（IconCode / IconSpark / IconDiff / IconTarget），不新画一套。
 */

export const WELCOME_CARDS: ReadonlyArray<{
  id: string
  Icon: (props: { size?: number }) => ReactNode
  title: string
  hint: string
  prompt: string
}> = [
  { id: 'read', Icon: IconCode, title: '看懂代码', hint: '解释一处实现的来龙去脉', prompt: '帮我讲清楚这段代码在做什么：\n' },
  { id: 'build', Icon: IconSpark, title: '做点东西', hint: '从需求一路写到能跑', prompt: '帮我实现：' },
  {
    id: 'review',
    Icon: IconDiff,
    title: '审查改动',
    hint: '看未提交的改动有没有坑',
    prompt: '审查当前未提交的改动，指出风险、遗漏和可以简化的地方。',
  },
  { id: 'fix', Icon: IconTarget, title: '排查问题', hint: '从一个报错查到根因', prompt: '帮我排查一下这个问题：\n' },
]

/** 动作 id → 图标：动作表里只存文案与动作，图标是转录插件自己的资产（见下面的登记）。 */
export const WELCOME_ICON_BY_ID: ReadonlyMap<string, (props: { size?: number }) => ReactNode> = new Map(
  WELCOME_CARDS.map((card) => [`welcome.${card.id}`, card.Icon] as const),
)


/** 相对时间（分钟 / 小时 / 天）：首屏那一行只需要「多久以前」，精确到秒没有意义。 */
export function elapsedLabel(at: number): string {
  const minutes = Math.max(Math.round((Date.now() - at) / 60_000), 0)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时前`
  return `${String(Math.round(hours / 24))} 天前`
}

/** 首屏卡片的一格（内置清单与动作表两种来源在这里合成同一种形状）。 */
export interface WelcomeCard {
  id: string
  Icon: (props: { size?: number }) => ReactNode
  title: string
  hint: string
  run: () => void
}

/** 「接着上次」那一行要的会话读数（只取标题、id 与更新时刻）。 */
export interface WelcomeResume {
  id: string
  title?: string
  updatedAt: number
}

export interface WelcomeStateProps {
  cards: readonly WelcomeCard[]
  /** 最近七天内改过、有标题的那条会话；null = 不画这一行。 */
  resume: WelcomeResume | null
  /** 开场区的条目（首屏只画命令输出与写前预览卡，其余不铺）。 */
  leading: readonly Row[]
  /** 行 key 的会话那一半。 */
  sessionKey: string
  /** 会话工作目录（写前预览卡推演相对路径用）。 */
  cwd: string
  /** composer 的「往输入框写字」服务在不在；不在就把卡片置灰。 */
  composerReady: boolean
  onResume: (id: string) => void
}

/**
 * 空会话首屏：一句招呼 + 四张能力卡 + 「接着上次」+ 开场区里该露的那几行。
 *
 * 为什么不放 logo（2026-10-27 用户：中间这个图标有点突兀）：空态的第一眼该落在
 * 「有什么可以帮忙的？」这句话上；品牌声部留给侧栏与收起的窄栏。
 */
export function WelcomeState({ cards, resume, leading, sessionKey, cwd, composerReady, onResume }: WelcomeStateProps): ReactNode {
  return (
    <div className="welcome">
      <h1>有什么可以帮忙的？</h1>
      <p>
        输入 <code>/</code> 查看可用指令 · 消息会携带当前工作目录上下文
      </p>
      <div className="welcome-cards">
        {cards.map((card) => (
          <button
            key={card.id}
            type="button"
            className="welcome-card"
            disabled={!composerReady}
            onClick={card.run}
          >
            <card.Icon size={16} />
            <span className="welcome-card-text">
              <span className="welcome-card-title">{card.title}</span>
              <span className="welcome-card-hint">{card.hint}</span>
            </span>
          </button>
        ))}
      </div>
      {resume === null ? null : (
        <button type="button" className="welcome-resume" onClick={() => onResume(resume.id)}>
          <IconClock size={13} />
          <span className="welcome-resume-title">接着上次：{resume.title}</span>
          <span className="welcome-resume-time">{elapsedLabel(resume.updatedAt)}</span>
        </button>
      )}
      {leading.map((row) => {
        if (row.entry.kind !== 'system') return null
        // 命令输出（/help、/status…）是用户主动要的东西，空会话首屏也要画出来：
        // 这一支原先只画写前预览卡，于是新会话里打第一条命令什么都看不到（2026-10-27 查账）。
        if (row.entry.command === true) {
          return (
            <div key={keyOf(row, sessionKey)} className="entry-system-command">
              {row.entry.text}
            </div>
          )
        }
        // 自动跑起来的那一轮（定点任务之类）没有用户消息，它的写前预览会落在开场区；
        // 这里同样走卡片——同一条通知在哪个位置都不该变成居中的一大坨。
        const notice = parseReviewNotice(row.entry.text)
        if (notice === null) return null
        return <ReviewNoticeCard key={keyOf(row, sessionKey)} notice={notice} cwd={cwd} />
      })}
    </div>
  )
}
