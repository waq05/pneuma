/**
 * 空会话首屏：一句招呼 + 四张能力卡 + 「接着上次」。
 *
 * 那句招呼不再是固定的一句：按时间段、周末、久未使用、头一回打开分九组，每组五句，
 * 组与组内第几句怎么挑见 `./greeting`（纯函数，自检能钉边界）。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/welcome
 */
import type { ReactNode } from 'react'
import { IconClock, IconCode, IconDiff, IconSpark, IconTarget, createT } from '@dsc/ui'
import { ReviewNoticeCard, parseReviewNotice } from '@dsc/ui-primitives'
import type { GreetingPick } from './greeting'
import { keyOf, type Row } from './shared'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 首屏招呼语的文案表：九个组，每组五句。组与组内第几句怎么挑见 `./greeting`。
 *
 * 为什么是一张显式的表、而不是 `t('...' + 组 + '.' + 句)` 拼键名：文案闸
 * （`scripts/ui-locale-test.mjs`）只认字面量 `t('...')`，拼出来的键在它眼里没人用，
 * 那 45 行文案会被判成死键。而且这样改一句只需要动一行。
 */
const GREETING_TEXT: Readonly<Record<GreetingPick['slot'], readonly string[]>> = {
  earlyMorning: [
    t('transcript.welcome.hello.earlyMorning.1'),
    t('transcript.welcome.hello.earlyMorning.2'),
    t('transcript.welcome.hello.earlyMorning.3'),
    t('transcript.welcome.hello.earlyMorning.4'),
    t('transcript.welcome.hello.earlyMorning.5'),
  ],
  morning: [
    t('transcript.welcome.hello.morning.1'),
    t('transcript.welcome.hello.morning.2'),
    t('transcript.welcome.hello.morning.3'),
    t('transcript.welcome.hello.morning.4'),
    t('transcript.welcome.hello.morning.5'),
  ],
  noon: [
    t('transcript.welcome.hello.noon.1'),
    t('transcript.welcome.hello.noon.2'),
    t('transcript.welcome.hello.noon.3'),
    t('transcript.welcome.hello.noon.4'),
    t('transcript.welcome.hello.noon.5'),
  ],
  afternoon: [
    t('transcript.welcome.hello.afternoon.1'),
    t('transcript.welcome.hello.afternoon.2'),
    t('transcript.welcome.hello.afternoon.3'),
    t('transcript.welcome.hello.afternoon.4'),
    t('transcript.welcome.hello.afternoon.5'),
  ],
  evening: [
    t('transcript.welcome.hello.evening.1'),
    t('transcript.welcome.hello.evening.2'),
    t('transcript.welcome.hello.evening.3'),
    t('transcript.welcome.hello.evening.4'),
    t('transcript.welcome.hello.evening.5'),
  ],
  lateNight: [
    t('transcript.welcome.hello.lateNight.1'),
    t('transcript.welcome.hello.lateNight.2'),
    t('transcript.welcome.hello.lateNight.3'),
    t('transcript.welcome.hello.lateNight.4'),
    t('transcript.welcome.hello.lateNight.5'),
  ],
  weekend: [
    t('transcript.welcome.hello.weekend.1'),
    t('transcript.welcome.hello.weekend.2'),
    t('transcript.welcome.hello.weekend.3'),
    t('transcript.welcome.hello.weekend.4'),
    t('transcript.welcome.hello.weekend.5'),
  ],
  returning: [
    t('transcript.welcome.hello.returning.1'),
    t('transcript.welcome.hello.returning.2'),
    t('transcript.welcome.hello.returning.3'),
    t('transcript.welcome.hello.returning.4'),
    t('transcript.welcome.hello.returning.5'),
  ],
  firstRun: [
    t('transcript.welcome.hello.firstRun.1'),
    t('transcript.welcome.hello.firstRun.2'),
    t('transcript.welcome.hello.firstRun.3'),
    t('transcript.welcome.hello.firstRun.4'),
    t('transcript.welcome.hello.firstRun.5'),
  ],
}

/** 取这一句招呼语：组和序号都已经定好，这里只负责查表。 */
function greetingLine(pick: GreetingPick): string {
  return GREETING_TEXT[pick.slot][pick.index] ?? GREETING_TEXT[pick.slot][0]
}

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
  {
    id: 'read',
    Icon: IconCode,
    title: t('transcript.welcome.read.title'),
    hint: t('transcript.welcome.read.hint'),
    prompt: t('transcript.welcome.read.prompt'),
  },
  {
    id: 'build',
    Icon: IconSpark,
    title: t('transcript.welcome.build.title'),
    hint: t('transcript.welcome.build.hint'),
    prompt: t('transcript.welcome.build.prompt'),
  },
  {
    id: 'review',
    Icon: IconDiff,
    title: t('transcript.welcome.review.title'),
    hint: t('transcript.welcome.review.hint'),
    prompt: t('transcript.welcome.review.prompt'),
  },
  {
    id: 'fix',
    Icon: IconTarget,
    title: t('transcript.welcome.fix.title'),
    hint: t('transcript.welcome.fix.hint'),
    prompt: t('transcript.welcome.fix.prompt'),
  },
]

/** 动作 id → 图标：动作表里只存文案与动作，图标是转录插件自己的资产（见下面的登记）。 */
export const WELCOME_ICON_BY_ID: ReadonlyMap<string, (props: { size?: number }) => ReactNode> = new Map(
  WELCOME_CARDS.map((card) => [`welcome.${card.id}`, card.Icon] as const),
)


/** 相对时间（分钟 / 小时 / 天）：首屏那一行只需要「多久以前」，精确到秒没有意义。 */
export function elapsedLabel(at: number): string {
  const minutes = Math.max(Math.round((Date.now() - at) / 60_000), 0)
  if (minutes < 1) return t('transcript.time.justNow')
  if (minutes < 60) return t('transcript.time.minutesAgo', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('transcript.time.hoursAgo', { count: hours })
  return t('transcript.time.daysAgo', { count: Math.round(hours / 24) })
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
  /** 首屏那句招呼语落在哪一组、组里第几句（见 `./greeting`）。 */
  greeting: GreetingPick
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
export function WelcomeState({ cards, greeting, resume, leading, sessionKey, cwd, composerReady, onResume }: WelcomeStateProps): ReactNode {
  return (
    <div className="welcome">
      <h1>{greetingLine(greeting)}</h1>
      <p>
        {t('transcript.welcome.lead')} <code>/</code> {t('transcript.welcome.leadTail')}
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
          <span className="welcome-resume-title">{t('transcript.welcome.resume', { title: resume.title ?? '' })}</span>
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
