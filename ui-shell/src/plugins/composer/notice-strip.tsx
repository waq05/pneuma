/**
 * 待投递通知条：回合跑动中到达的机器唤醒（队友汇报、后台作业完成…），只读。
 *
 * 从 `composer/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/composer/notice-strip
 */
import type { ReactNode } from 'react'
import { IconSpark } from '@dsc/ui'
import { useHostSelector } from '@dsc/ui'
import { summarizeNotice } from './notice-summary'
import { readNotices, sameNotices } from './surfaces'

/**
 * 待投递通知条（对照 dsh 的 turn-trigger 行）：回合跑动中到达的**机器**唤醒
 * （队友汇报、审查 findings、传话、后台作业完成、定时补投……）还没交给模型时，
 * 在输入框**上方**露一行。与下面的排队条（用户输入）分开：这一条**只读**——
 * 没有编辑 / 撤掉 / 插话三颗钮（机器消息不代表人的意图），也不把 `<teammate-report …>`
 * 这类原始标记上屏，由 {@link summarizeNotice} 压成一句含来源的人话。
 *
 * 队列空了整块不渲染（与排队条一致，不留空壳把输入框顶出一条间距）。
 */
export function NoticeStrip(): ReactNode {
  const notices = useHostSelector(readNotices, sameNotices)
  if (notices.length === 0) return null
  return (
    <div className="notice-strip" data-notice-strip="">
      {notices.map((item) => {
        const summary = summarizeNotice(item.text)
        return (
          <div className="notice-row" key={item.index}>
            <span className="notice-lead" aria-hidden="true">
              <IconSpark size={13} />
            </span>
            <span className="notice-label" data-tip={summary.detail === '' ? summary.label : summary.detail}>
              {summary.label}
            </span>
            {summary.detail === '' ? null : <span className="notice-detail">{summary.detail}</span>}
          </div>
        )
      })}
    </div>
  )
}
