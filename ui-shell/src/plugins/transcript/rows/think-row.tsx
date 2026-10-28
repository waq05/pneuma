/**
 * 思考栏：流式期一行小字、定稿后折叠块；含两条「首行摘要」的算法。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/rows/think-row
 */
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconChevronDown, IconChevronUp, IconSpark, type TranscriptEntry } from '@dsc/ui'
import { readFold, writeFold } from '../fold-state'
import { BAR_MIN_CONTENT_H, expandedContentHeight } from './fold-body'
import { FoldPrefsContext } from '../shared'

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/**
 * 最新一个「已经写完的段落」的首行（旧版 `ThinkingBlock.tsx:54-70`，语义同 dsh 的
 * `latestCompletedParagraphFirstLine`）。
 *
 * 段落之间以空行（一行里只有空白）分隔。最后一个段落如果还没写到换行，说明它正在被吐字，
 * 不能拿来当摘要——所以从后往前找第一个「首行已经收尾」的段落。一段都没写完就返回空串，
 * 界面据此只画标题、不画分隔点与摘要。
 */
function latestCompletedParagraphFirstLine(text: string): string {
  let summary = ''
  let paragraphStart = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  while (true) {
    const nextParagraph = separator.exec(text)
    const paragraphEnd = nextParagraph === null ? text.length
      : nextParagraph.index + nextParagraph[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim()
      if (candidate !== '') summary = candidate
    }
    if (nextParagraph === null) return summary
    paragraphStart = nextParagraph.index + nextParagraph[0].length
  }
}

/**
 * 思考块（旧桌面渲染层 `ThinkingBlock.tsx` 的同构移植）：默认折叠成一行
 * 「星标 + 标题 + 分隔点 + 摘要」，点开才是完整思考原文；展开内容超过
 * {@link BAR_MIN_CONTENT_H} 时，展开区顶部吸附一条带「收起」的快捷栏。
 *
 * 三条与旧版一致、改的时候别破坏的事（前两条正是本批的两个报障）：
 *
 *  1. **展开区是有条件渲染的**（`open && …`）。少了这个条件，收起时正文照样在 DOM 里、
 *     照样占高度——点箭头只转个方向，「思考内容关不掉」。
 *  2. **跑动中的摘要取「最新一个写完的段落的首行」**，不是首行：直播时最后一段还在往外
 *     吐字，拿它当摘要会一个字跳一次（旧版 ThinkingBlock.tsx:7-8 的注释就是这条教训）。
 *     另一半防抖在行 key 上——直播尾的 `ts` 每口 delta 都刷新，键里带上它就会逐字重挂
 *     （见 {@link keyOf}）。
 *  3. **展开态走存档**（`fold-state`）：会话切换会重放历史、条目整表重建，重挂时从存档键
 *     读回用户上次的选择；不存的话「展开两条、切走再切回」就全合上了。
 *
 * 跑动中**保留**「收起」按钮（工具卡在 running 时藏起来是因为那里收起有「任务被中断」的
 * 歧义；思考段是只读文本，收起它不会被理解成取消）。
 */
export function ThinkRow({
  entry,
  live,
  storeKey,
}: {
  entry: Extract<TranscriptEntry, { kind: 'thinking' }>
  live: boolean
  /** 展开状态的存档键（`会话id:think:条目id`）；不传就不存档。 */
  storeKey?: string
}): ReactNode {
  const prefs = useContext(FoldPrefsContext)
  /**
   * 展开态：**一律从用户的默认档位起算，跑动中也不替用户展开**。
   *
   * 这里原来写的是 `readFold(storeKey, live || prefs.reasoningOpen)`（直播尾挂载即展开，
   * 当时认为它是「现在在干什么」的唯一线索）。它在**定稿那一瞬间**会制造一次很难受的
   * 抽动，也就是 0.6.67 的报障「思考完毕闪屏折叠」：直播尾是负 id 的条目，定稿后换成
   * 正 id 的新条目（`adapter/transcript.ts` 的 pushThinking），React key 跟着换 →
   * 旧实例卸载、新实例挂载 → 新实例按默认档位算出来是**收起**，于是用户眼前那段摊开的
   * 思考在定稿那一拍整体收拢（若开着动效还会从 0fr 重播一次高度过渡）。
   *
   * 参考实现从不这么做：dsh 的推理行**永远以收起态起步**，`running` 只改「折叠行右边那句
   * 预览」的取法（进行中取最新写完段落的首行，定稿后取首行，ReasoningRow.tsx:56），
   * 行的开合只由用户点击决定（use-disclosure.ts:12-13）。直播的「还活着」由扫光 + 摘要 +
   * 小圈承载（本组件三样都有），不需要把正文摊开。
   */
  const [open, setOpen] = useState(() => readFold(storeKey, prefs.reasoningOpen))
  const [barVisible, setBarVisible] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  /** 展开态一变就写回存档：组件被重挂时下一个实例才读得到。 */
  const setOpenPersisted = (next: boolean): void => {
    writeFold(storeKey, next)
    setOpen(next)
  }
  const toggle = (): void => {
    setOpenPersisted(!open)
  }

  // 摘要（折叠态那一行右边那一段）：跑动中只认写完的段落，收工后取首行；`**` 一律去掉。
  const summary = (live ? latestCompletedParagraphFirstLine(entry.text) : firstLine(entry.text)).replaceAll('**', '')
  // 这一行现在画不画摘要：空摘要不画；紧凑档的定稿条也不画（那一档的语义就是「只剩标题 + 箭头」，
  // 对照 dsh 的 settledReasoningPreview）。跑动中照画——正在写的那一句不能因为档位被藏了。
  const preview = summary !== '' && (live || prefs.policy.reasoningPreview)

  // 展开内容够长才给快捷栏；阈值判断放在布局之后量，量的是真实像素而不是估算。
  // 直播时 text 一直在变长，所以挂 ResizeObserver 跟着重量（不是只量一次）。
  useEffect(() => {
    const body = bodyRef.current
    if (body === null || !open) {
      setBarVisible(false)
      return undefined
    }
    const measure = (): void => {
      setBarVisible(expandedContentHeight(body) > BAR_MIN_CONTENT_H)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => {
      observer.disconnect()
    }
  }, [open, entry.text])

  return (
    <div
      className={`think-block${live ? ' live' : ''}${open ? ' open' : ''}`}
      // 两态走 data-state（dsh 的 ReasoningRow.tsx:80）；.live 是「直播尾」这个概念，样式里仍在用。
      data-state={live ? 'running' : 'ok'}
      // 折叠态有没有摘要可画（dsh 的 data-preview）：空摘要不占位。
      data-preview={preview ? '1' : undefined}
    >
      {/* 跑动这一态在视觉上是扫光 + 品牌色，读屏读不到「扫光」，所以补一句只给读屏的说明。 */}
      {live ? <span className="think-sr">正在思考</span> : null}
      <div
        className="think-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-tip={open ? '收起这段思考' : '展开这段思考'}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          // 空格按在 div 上默认会滚页面，先挡掉再自己处理（与工具卡紧凑行同款）。
          event.preventDefault()
          toggle()
        }}
      >
        <IconSpark size={12} className="think-star" />
        {/* 标题照 dsh 的 `message.think`（两个字「思考」）：2026-10-27 之前是「思考过程」，
            多出来的两个字在窄栏里会被浏览器按字断行（见 views.css 里标题防竖排那条），
            而且同一件事工具行说「读取」、这行说「思考过程」，字数与词性都对不齐。 */}
        <span className="think-label">思考</span>
        {/* 分隔点：只在真有摘要时画（紧凑档的定稿条不画，箭头因此紧跟在标题右边）。 */}
        {preview ? <span className="think-dot" aria-hidden="true" /> : null}
        {preview ? (
          <span className="think-summary" data-streaming={live ? '1' : undefined}>
            <span className="think-summary-text" data-shimmer={live ? summary : undefined}>
              {summary}
            </span>
          </span>
        ) : null}
        {/* 进行中的小圈：系统里说「少动」时扫光会停，这枚静态环就是那会儿唯一的活动标记。 */}
        <span className="think-status">{live ? <i className="think-spin" aria-hidden="true" /> : null}</span>
        <IconChevronDown size={11} className="think-chevron" />
      </div>
      {/* 吸附快捷栏：是 .think-block 的直接子项（不套在 .think-body 里），这样展开区可以
          放心用 overflow 裁剪做高度过渡，sticky 的参照系仍是滚动容器 .chat。 */}
      {open && barVisible ? (
        <div className="think-bar" data-think-chrome="1">
          <span className="think-bar-status">思考 · {live ? '进行中' : '已完成'}</span>
          <button
            type="button"
            className="think-collapse"
            title="收起这段思考"
            onClick={() => {
              setOpenPersisted(false)
            }}
          >
            收起
            <IconChevronUp size={11} />
          </button>
        </div>
      ) : null}
      {/* 展开区：**条件渲染**（见组件注释第 1 条）。高度过渡要裁剪，所以正文外面再包一层
          .think-body-clip；正文自己的左竖线留在 .think-text 上。 */}
      {open ? (
        <div className="think-body" ref={bodyRef}>
          <div className="think-body-clip">
            <div className="think-text">{entry.text}</div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

