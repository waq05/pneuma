/**
 * 「文件更改预览」通知卡片：把 {@link parseReviewNotice} 拆出来的素材画成一张
 * **左对齐**的卡——头行（文件图标 + 动作词 + 路径 + 增删计数 + 展开箭头）加一块
 * 等宽、限高滚动的 diff 正文。
 *
 * 为什么单独一种渲染而不是继续走 `.entry-system`：那条样式是「一行居中的灰字」，
 * 短通知（「这一轮被中断」）居中读着舒服，几十行 diff 居中就成了一坨（用户的报障）。
 * dsh 的对话内 diff 同样左对齐、等宽、限高（`CHAT_DIFF_MAX_LINES = 9`）；这边高度档
 * 取 260px，和 `.turn-trigger-text` 的限高同一档。
 *
 * **默认收起（2026-10-28 用户要求）**：这是「动手之前让你看一眼改什么」的预览，一个
 * 任务里写十几次文件，十几次都摊着几十行 diff，会把对话流冲成一片绿红块。收成一行头
 * 之后它和别的工具行一样只占一行，点开才看 diff；轮尾的「文件已更改」聚合卡照旧总结
 * 这一轮到底改了哪些文件（那是收尾的汇总，不是过程里的每一次）。收起**不是**删掉：
 * 审批卡弹出来之前，改动仍然在原来的位置等着你点开看。
 *
 * 住在基元包（2026-10-28）：对话流与轨迹页都要画这张卡，放在任一个插件里都逼另一个横穿过去，
 * 见 `./review-notice` 的头注释。
 *
 * @module dsc-ui-shell/ui-primitives/review-notice-card
 */
import { useId, useState, type ReactNode } from 'react'
import { FileIcon } from './file-icons'
import { IconChevronDown } from './icons'
// 路径展示口径：与工具卡、悬停预览同一份实现（相对化 + 反斜杠统一成 /）。
import { displayPathOf } from './paths'
import type { ReviewNotice } from './review-notice'

/** 动作词后面接的那个词：新建文件 / 编辑文件（与工具卡行头的「编辑文件」同一套说法）。 */
const REVIEW_VERB_TEXT: Readonly<Record<'create' | 'update', string>> = {
  create: '新建文件',
  update: '编辑文件',
}

export function ReviewNoticeCard({ notice, cwd }: { notice: ReviewNotice; cwd: string }): ReactNode {
  const path = notice.path
  // 默认收起；展开态不持久化——它是过程里的一条预览，会话切走重建时回到最省地方的样子。
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const hasBody = notice.lines.length > 0
  const verb = notice.action === null ? null : REVIEW_VERB_TEXT[notice.action]
  return (
    <div className="entry-review" data-review-notice="" data-action={notice.action ?? undefined} data-open={open}>
      <button
        type="button"
        className="entry-review-head"
        // 没有 diff 正文时头行不可点：点了也展不开，白给一个「点了没反应」。
        {...(hasBody ? { 'aria-expanded': open, 'aria-controls': bodyId } : { 'aria-expanded': false })}
        data-tip={hasBody ? (open ? '收起这份改动' : '展开看改了什么') : undefined}
        onClick={() => {
          if (hasBody) setOpen((value) => !value)
        }}
      >
        <FileIcon name={path ?? ''} size={14} className="entry-review-icon" />
        {verb === null ? null : <span className="entry-review-verb">{verb}</span>}
        {/* 路径文本：宿主已经按自己那一侧的 cwd 相对化过，这里再过一道壳的 cwd
            （相对路径原样返回，绝对路径能缩就缩）——两边 cwd 正常情况下是同一个。 */}
        <span className="entry-review-path" title={path ?? notice.head}>
          {path === null ? notice.head : displayPathOf(path, cwd)}
        </span>
        {notice.counts !== null ? (
          <span className="changes-counts">
            <span className="changes-added">{`+${String(notice.counts.added)} 行`}</span>
            <span className="changes-removed">{`-${String(notice.counts.removed)} 行`}</span>
          </span>
        ) : notice.countsText === null || notice.countsText === '' ? null : (
          // 算不出逐行 diff 时宿主写「逐行 diff 未给出」——中性一行，不装成计数。
          <span className="entry-review-counts">{notice.countsText}</span>
        )}
        {hasBody ? <IconChevronDown size={11} className="entry-review-chevron" /> : null}
      </button>
      {hasBody ? (
        <div className="entry-review-diff" id={bodyId} hidden={!open}>
          {notice.lines.map((line, at) => (
            <div className="entry-review-line" data-kind={line.kind} key={String(at)}>
              {line.text}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
