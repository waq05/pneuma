/**
 * 「文件更改预览」通知卡片：把 {@link parseReviewNotice} 拆出来的素材画成一张
 * **左对齐**的卡——头行（文件图标 + 路径 + 新建/修改徽章 + 增删计数）加一块
 * 等宽、限高滚动的 diff 正文。
 *
 * 为什么单独一种渲染而不是继续走 `.entry-system`：那条样式是「一行居中的灰字」，
 * 短通知（「这一轮被中断」）居中读着舒服，几十行 diff 居中就成了一坨（用户的报障）。
 * dsh 的对话内 diff 同样左对齐、等宽、限高（`CHAT_DIFF_MAX_LINES = 9`）；这边高度档
 * 取 260px，和 `.turn-trigger-text` 的限高同一档。
 *
 * @module dsc-ui-shell/plugins/transcript/review-notice-card
 */
import type { ReactNode } from 'react'
import { FileIcon } from '@dsc/ui'
// 路径展示口径从平台种子取：与工具卡、悬停预览同一份实现（相对化 + 反斜杠统一成 /）。
import { displayPathOf } from '@dsc/ui-primitives'
import { REVIEW_ACTION_TEXT, type ReviewNotice } from './review-notice'

export function ReviewNoticeCard({ notice, cwd }: { notice: ReviewNotice; cwd: string }): ReactNode {
  const path = notice.path
  return (
    <div className="entry-review" data-review-notice="" data-action={notice.action ?? undefined}>
      <div className="entry-review-head">
        <FileIcon name={path ?? ''} size={14} className="entry-review-icon" />
        {/* 路径文本：宿主已经按自己那一侧的 cwd 相对化过，这里再过一道壳的 cwd
            （相对路径原样返回，绝对路径能缩就缩）——两边 cwd 正常情况下是同一个。 */}
        <span className="entry-review-path" title={path ?? notice.head}>
          {path === null ? notice.head : displayPathOf(path, cwd)}
        </span>
        {notice.action !== null ? (
          <span className={notice.action === 'create' ? 'diff-badge' : 'entry-review-badge'}>
            {REVIEW_ACTION_TEXT[notice.action]}
          </span>
        ) : null}
        {notice.counts !== null ? (
          <span className="changes-counts">
            <span className="changes-added">{`+${String(notice.counts.added)} 行`}</span>
            <span className="changes-removed">{`-${String(notice.counts.removed)} 行`}</span>
          </span>
        ) : notice.countsText === null || notice.countsText === '' ? null : (
          // 算不出逐行 diff 时宿主写「逐行 diff 未给出」——中性一行，不装成计数。
          <span className="entry-review-counts">{notice.countsText}</span>
        )}
      </div>
      {notice.lines.length === 0 ? null : (
        <div className="entry-review-diff">
          {notice.lines.map((line, at) => (
            <div className="entry-review-line" data-kind={line.kind} key={String(at)}>
              {line.text}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
