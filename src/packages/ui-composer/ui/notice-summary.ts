/**
 * 「待投递通知」的纯解析：宿主把机器发起的唤醒（队友汇报、审查 findings、传话、
 * 后台作业完成、定时补投……）先投进会话收件箱，出账前界面在输入框上方画一条只读
 * 通知带。那条通知的正文是**给模型看的标记文本**（`<teammate-report …>` 之类），
 * 不能原样上屏——这里把它压成一句含来源的人话，正文只留一小段扁平摘要。
 *
 * **为什么在壳里认而不是让宿主换个形状**：同一段文本模型也要看（必须留在上下文里），
 * 改形状会连带影响模型侧；与 `review-notice.ts` 认「文件更改预览」同一条思路——
 * 壳按正文前缀认，压成给人看的一句话。认不出的通知退回一句中性话 + 扁平正文，
 * 绝不把原始标记当正文摆出来。
 *
 * 零 React、零 DOM：探针可按 Node 的类型擦除直接 import。那条路要靠
 * `scripts/_i18n-alias.mjs` 把 `@dsc/ui` 与 JSON 字典一起接上（探针批跑时由
 * `scripts/_check-runner.mjs` 统一挂），取词器仍是全项目共用的那一份。
 *
 * @module dsc-ui-shell/plugins/composer/notice-summary
 */
import { createT } from '@dsc/ui'
import zhMessages from '../locale/ui.zh.json'
import enMessages from '../locale/ui.en.json'

const t = createT({ zh: zhMessages, en: enMessages })

/** 队友汇报的前缀（宿主 `core/team-board.ts` 的 `TEAMMATE_REPORT_OPEN`）。 */
const TEAMMATE_REPORT_OPEN = '<teammate-report '
/** 审查 findings 的前缀（宿主 `core/team-board.ts` 的 `REVIEW_FINDINGS_OPEN`）。 */
const REVIEW_FINDINGS_OPEN = '<review-findings '
/** 队友间传话的前缀（宿主 subagent 插件拼的 `<message from="…">`）。 */
const MESSAGE_OPEN = '<message '

/**
 * 汇报正文的起点标记。宿主拼的是**中文原文**（与界面语言无关），所以两种写法都认：
 * 英文界面下 `t()` 给的是译文，对不上宿主那句话，得回落中文原文。
 */
const REPORT_MARKS: readonly string[] = [t('notice.reportMark'), zhMessages['notice.reportMark']]

/** 摘要正文的字数上限。 */
const DETAIL_CHARS = 120

/**
 * 一条待投递通知压出来的两件：`label` 是一句含来源的人话（直接上屏），
 * `detail` 是正文的扁平摘要（可为空串；只做悬浮说明，不摆原始标记）。
 */
export interface NoticeSummary {
  label: string
  detail: string
}

/** 从 `key="value"` 里取一个属性值（取不到给空串）。 */
function attrOf(text: string, key: string): string {
  const match = new RegExp(`${key}="([^"]*)"`).exec(text)
  return match?.[1] ?? ''
}

/** 去掉尖括号标记、折叠空白、截断：正文只留一小段能看懂的扁平文本。 */
function flatten(text: string): string {
  const flat = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > DETAIL_CHARS ? `${chars.slice(0, DETAIL_CHARS).join('')}…` : flat
}

/**
 * 把一条待投递通知的原文压成 {@link NoticeSummary}。
 *
 * 认不出前缀（宿主加了新的机器通知而壳还没跟上）也**照样返回一句中性话**：
 * 那总比把 `<xxx …>` 原样摆到输入框上方好。
 */
export function summarizeNotice(text: string): NoticeSummary {
  if (text.startsWith(TEAMMATE_REPORT_OPEN)) {
    const name = attrOf(text, 'from')
    const state = attrOf(text, 'state')
    const who = name === '' ? t('notice.teammate.one') : t('notice.teammate.named', { name })
    // 正文：`派给它的任务：…\n它的汇报：…` 之后那段；取不到就整段扁平。
    const mark = REPORT_MARKS.find((item) => text.includes(item))
    const body = mark === undefined ? text : text.slice(text.indexOf(mark) + mark.length)
    return {
      label: t('notice.teammate.label', { who: state === '' ? who : `${who} ${state}` }),
      detail: flatten(body),
    }
  }
  if (text.startsWith(REVIEW_FINDINGS_OPEN)) {
    const name = attrOf(text, 'teammate')
    const state = attrOf(text, 'state')
    const who = name === '' ? t('notice.review.who') : t('notice.review.named', { name })
    const open = text.indexOf('>')
    const close = text.lastIndexOf('</review-findings>')
    const body = open === -1 ? text : close === -1 ? text.slice(open + 1) : text.slice(open + 1, close)
    return {
      label: t('notice.review.label', { who: state === '' ? who : `${who} ${state}` }),
      detail: flatten(body),
    }
  }
  if (text.startsWith(MESSAGE_OPEN)) {
    const from = attrOf(text, 'from')
    const who = from === '' || from === 'user' ? t('notice.message.who') : t('notice.message.named', { name: from })
    const open = text.indexOf('>')
    const close = text.lastIndexOf('</message>')
    const body = open === -1 ? text : close === -1 ? text.slice(open + 1) : text.slice(open + 1, close)
    return {
      label: t('notice.message.label', { who }),
      detail: flatten(body),
    }
  }
  return { label: t('notice.fallback'), detail: flatten(text) }
}
