/**
 * 回合结束 / 等人卡的通知口径（纯函数，零运行时依赖）。
 *
 * 为什么单独成文件：桌面通知现在要分四种结局（完成 / 失败 / 输出超长 / 等用户），
 * 判定规则必须能被 `scripts/ui-turn-notify-test.mjs` 直接拉起来验——那条探针用 Node 的
 * 类型剥离跑本文件，一旦这里顺手 import 了 React 或 `@dsc/ui`，探针就起不来。所以本文件
 * 只做「`readonly Row[]` → 一条文案」的换算，弹通知与播声音都留在 ui.tsx。
 *
 * 口径来源：轮尾条目由 `src/adapter/transcript.ts:834-864` 落（只有非 completed 才落
 * `turn-end`），输出超长条目由同文件 `:610-625` 落（`finishReason === 'length'`）。
 * 也就是说：「没有 turn-end」和「turn-end 的 reason 认不出来」都是正常结束。
 *
 * @module @dsc/ui-transcript/turn-notify
 */
import type { Row } from './shared'

/**
 * 正文上限（字）。
 *
 * 系统通知的可读长度就这么点，120 字与旧界面（以及 remote 推送）一致；探针直接拿它当断言值，
 * 改这里就等于改了通知口径。
 */
export const NOTICE_BODY_LIMIT = 120

/** 一次回合收尾的四种结局，加上等人卡的三张。 */
export type TurnNoticeKind = 'done' | 'failed' | 'truncated' | 'question' | 'approval' | 'plan'

/** 一条待弹出的通知：文案键交给界面用 `t()` 取词，正文已经压好空白、截好长度。 */
export interface TurnNotice {
  kind: TurnNoticeKind
  titleKey: string
  body: string
}

/**
 * 快照里挂着的「等人的卡」（审批 → 计划评审 → 模型提问，同一时刻至多一张在前面挡着）。
 * 这是 ui.tsx 的选择器与纯函数之间的交界形状，字段与 `src/packages/remote/index.ts:692-703`
 * 的 `waitingCardOf` 同口径（除了提问那一路的键前缀，本包按界面自己的习惯写成 `question:`）。
 */
export interface WaitingCard {
  kind: 'question' | 'approval' | 'plan'
  key: string
  headline: string
}

/** 每种结局对应的文案键；`transcript.notify.done` 是既有键，其余四个是本轮新加的。 */
const TITLE_KEY: Record<TurnNoticeKind, string> = {
  done: 'transcript.notify.done',
  failed: 'transcript.notify.failed',
  truncated: 'transcript.notify.truncated',
  question: 'transcript.notify.question',
  approval: 'transcript.notify.approval',
  plan: 'transcript.notify.plan',
}

/** 空白压成一个空格：正文里可能带换行与缩进，系统通知只有一行。 */
function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 截到上限；没超就原样返回。 */
function clip(text: string): string {
  return text.length > NOTICE_BODY_LIMIT ? text.slice(0, NOTICE_BODY_LIMIT) : text
}

/**
 * 这一轮的最后一条正文。
 *
 * 优先 `process !== true` 的那条：带 `process` 标记的是「调工具之前的前言」，读者真正想看的
 * 是收尾那句；一句正经正文都没有（整轮只调了工具）时退回最后一条 `text`。
 */
function lastText(rows: readonly Row[]): string {
  let fallback = ''
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const entry = rows[index]?.entry
    if (entry === undefined || entry.kind !== 'text') continue
    if (entry.process !== true) return entry.text
    if (fallback === '') fallback = entry.text
  }
  return fallback
}

/** 这一轮最后一条错误 system 条目的正文（adapter 落的是「错误：<原文>」，前缀在这里去掉）。 */
function lastError(rows: readonly Row[]): string {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const entry = rows[index]?.entry
    if (entry === undefined || entry.kind !== 'system' || entry.level !== 'error') continue
    return entry.text.replace(/^错误[：:]\s*/, '')
  }
  return ''
}

/**
 * 一轮跑完该提示什么。
 *
 * 从后往前扫轮尾标记：先撞上 `turn-max-tokens` 就是超长，先撞上 `turn-end` 就按 reason 定
 * （error = 失败、aborted = 用户自己按了停止、不提示），两个都没有就是正常完成。
 * 顺序之所以从后往前：超长条目在轮中间落，`turn-end` 在最后落，扫到谁就是谁。
 *
 * @param rows - 这一轮的座位行（只要 `seats.rounds` 最后一轮那些）
 */
export function turnEndNotice(rows: readonly Row[]): TurnNotice | null {
  let kind: TurnNoticeKind = 'done'
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const entry = rows[index]?.entry
    if (entry === undefined) continue
    if (entry.kind === 'turn-end') {
      // 用户主动中断：界面上已经收好了，再响一声只是噪音。
      if (entry.reason === 'aborted') return null
      if (entry.reason === 'error') {
        kind = 'failed'
        break
      }
      continue
    }
    if (entry.kind === 'turn-max-tokens') {
      kind = 'truncated'
      break
    }
  }
  const body = kind === 'failed' ? lastError(rows) : lastText(rows)
  return { kind, titleKey: TITLE_KEY[kind], body: clip(compact(body)) }
}

/**
 * 一张等人的卡该提示什么。
 *
 * @param card - 快照里当前挂着的那张（没有就是 null）
 */
export function waitingNotice(card: WaitingCard | null): TurnNotice | null {
  if (card === null) return null
  return { kind: card.kind, titleKey: TITLE_KEY[card.kind], body: clip(compact(card.headline)) }
}
