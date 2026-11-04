/**
 * 一轮结束时的「文件已更改」卡：合并本轮改动、悬停看 diff、折叠展开。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/rows/changes-card
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DiffRows, FileIcon, setDockPreview, setDockReview, type ChangedFileView } from '@dsc/ui'
import { baseNameOf, displayPathOf, findLast, useHoverDelay } from '@dsc/ui-primitives'
import type { Row } from '../shared'

/**
 * 把本轮改动合成一份清单。
 *
 * 优先级照旧界面：先看有没有 `turnDiff`（回合基线的聚合差异），有就只用它；否则把逐条
 * `changes` 按路径合并（同文件多刀把增删行数相加、差异段顺次拼起来）。
 */
function mergeChanges(rows: readonly Row[]): ChangedFileView[] {
  const turnDiff = findLast(rows, (row) => row.entry.kind === 'turnDiff')
  if (turnDiff !== undefined && turnDiff.entry.kind === 'turnDiff') return turnDiff.entry.files
  const byPath = new Map<string, ChangedFileView>()
  for (const row of rows) {
    if (row.entry.kind !== 'changes') continue
    const file = row.entry.file
    const existing = byPath.get(file.path)
    byPath.set(
      file.path,
      existing === undefined
        ? file
        : {
            ...existing,
            added: existing.added + file.added,
            removed: existing.removed + file.removed,
            hunks: [...existing.hunks, ...file.hunks],
            ...(existing.truncated === true || file.truncated === true ? { truncated: true } : {}),
          },
    )
  }
  return [...byPath.values()]
}

/** 折叠阈值之下的行数（对照旧界面 ChangedFiles 的 COLLAPSED_ROWS = 4）。 */
const COLLAPSED_ROWS = 4

/** 增删计数（绿 + / 红 -；与旧界面同款结构）。 */
function Counts({ added, removed }: { added: number; removed: number }): ReactNode {
  return (
    <span className="changes-counts">
      <span className="changes-added">{`+${String(added)}`}</span>
      <span className="changes-removed">{`-${String(removed)}`}</span>
    </span>
  )
}

/**
 * 悬停预览浮层（旧界面 `DiffHoverCard` 的同构移植）：显示**该文件的 diff**——hunks 数据
 * 就在条目上，不读盘、没有工作目录限制；宽 = 聚合卡宽 − 48，锚上方优先、放不下落下方，
 * maxHeight 420。挂在 body 下，不被聊天区的滚动/裁剪框住。
 *
 * Escape 关闭走 capture：审批卡在冒泡阶段监听 Esc=拒绝，预览开着时按 Esc 只该收预览。
 * 鼠标进卡 keep()、出卡 onLeave() 起同一条收卡倒计时——只挂 onKeep 会让卡**永远粘住**
 * （行上的 mouseleave 早在鼠标进卡那一刻就烧掉了），这是 2026-10-14 用户报的毛病之一。
 */
export function DiffHoverCard({
  file,
  anchor,
  cardWidth,
  cwd,
  onKeep,
  onLeave,
  onClose,
}: {
  file: ChangedFileView
  anchor: DOMRect
  cardWidth: number
  cwd: string
  /** 鼠标移进卡里：取消「移开后收卡」的倒计时，用户能与卡内容交互。 */
  onKeep: () => void
  /** 鼠标离开卡：起收卡倒计时（与「从行上移开」同一条，1s 后收）。 */
  onLeave: () => void
  onClose: () => void
}): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const width = Math.max(320, Math.min(cardWidth - 48, window.innerWidth - 16))
  const maxHeight = Math.min(420, window.innerHeight - 24)
  // 上方放得下（按上限估）就贴行上方，否则落行下方；横向夹进视口。
  const left = Math.min(Math.max(8, anchor.left - 24), Math.max(8, window.innerWidth - width - 8))
  const style: CSSProperties =
    anchor.top - 12 >= maxHeight
      ? { left: `${String(left)}px`, bottom: `${String(window.innerHeight - anchor.top + 6)}px`, width: `${String(width)}px`, maxHeight: `${String(maxHeight)}px` }
      : { left: `${String(left)}px`, top: `${String(anchor.bottom + 6)}px`, width: `${String(width)}px`, maxHeight: `${String(maxHeight)}px` }
  return createPortal(
    <div className="hover-preview" style={style} onMouseEnter={onKeep} onMouseLeave={onLeave}>
      <div className="hover-preview-head">
        <FileIcon name={file.path} size={14} />
        <span className="hover-preview-name" title={file.path}>
          {displayPathOf(file.path, cwd)}
        </span>
        <span className="hover-preview-stat">
          {file.status === 'added' && <span className="diff-badge">新增</span>}
          <span className="changes-added">{`+${String(file.added)}`}</span>
          <span className="changes-removed">{`-${String(file.removed)}`}</span>
        </span>
      </div>
      <div className="hover-preview-diff">
        <DiffRows hunks={file.hunks} path={file.path} />
      </div>
    </div>,
    document.body,
  )
}

/**
 * 轮尾的「文件已更改」聚合卡（旧界面 `ChangedFilesCard` 的同构移植）。
 *
 * 数据是同一轮里成功落盘的文件改动（`kind: 'changes'` 逐刀条目 + `kind: 'turnDiff'`
 * 回合聚合条目）：有聚合条目就用它，没有就回退逐条合并。界面只做聚合与展示，不碰文件
 * 系统——悬停预览也只用 hunks：行上停 500ms 出该文件的 diff（不读盘、无工作目录限制）。
 *
 * 交互照旧界面：卡头点击审查、每行「审查」开审查面板并定位到该文件、「打开」进文件
 * 预览页签、超过 {@link COLLAPSED_ROWS} 行时列表折起、靠底部按钮放全。
 */
export function ChangesCard({ rows, cwd }: { rows: readonly Row[]; cwd: string }): ReactNode {
  const files = useMemo(() => mergeChanges(rows), [rows])
  const [expanded, setExpanded] = useState(true)
  // 悬停预览：行上停够 500ms 才出卡（避免划过一路闪卡）；移开 1s 后收（行上移开、
  // 鼠标离开卡各自起同一条倒计时），移进卡里续命。
  const cardRef = useRef<HTMLDivElement | null>(null)
  const hoverDelay = useHoverDelay<ChangedFileView>()
  const { hover } = hoverDelay
  // 行数换了（换轮/会话重放）就按新条数重置折起态：≤4 行直接全露。
  useEffect(() => {
    setExpanded(files.length <= COLLAPSED_ROWS)
  }, [files.length])
  if (files.length === 0) return null
  const totalAdded = files.reduce((sum, file) => sum + file.added, 0)
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0)
  const single = files.length === 1 ? files[0] : undefined
  const visible = expanded ? files : files.slice(0, COLLAPSED_ROWS)
  /** 开审查栏：把这一轮的清单与下标交给它（旧界面：并排右栏定位到该文件）。 */
  const reviewAt = (index: number): void => {
    setDockReview({ files, index, cwd })
  }
  /** 进文件预览页签（看文件当前内容，审查看的是修改当时的快照）。 */
  const openAt = (path: string): void => {
    setDockPreview({ path, cwd })
  }
  const armHover = (file: ChangedFileView, anchor: DOMRect): void => {
    hoverDelay.arm(file, anchor, cardRef.current?.offsetWidth ?? 480)
  }
  return (
    // 不再包 `.entry-row`：旧版里 `.changes-card` 是 `.turn-seat` 的直接子项，间距靠
    // `.turn-seat > .changes-card` 那条规则给（多包一层会让选择器失配）。
    <div className="changes-card" ref={cardRef} data-changed-files="" {...(single === undefined ? {} : { 'data-single': '1' })}>
        <button
          type="button"
          className="changes-head"
          onClick={() => {
            reviewAt(files.indexOf(single ?? files[0]!))
          }}
        >
          <span className="changes-tile">
            {/* 卡头是文件自己的彩色图标（单文件用它，多文件用第一个）——旧界面同款。 */}
            <FileIcon name={(single ?? files[0]!).path} size={20} />
          </span>
          <span className="changes-titles">
            {/* 措辞照 dsh 的「已编辑 N 个文件」：这一轮的动作是编辑，不是「文件自己变了」。 */}
            <span className="changes-title">{single === undefined ? `已编辑 ${String(files.length)} 个文件` : baseNameOf(single.path)}</span>
            <span className="changes-stat">
              <Counts added={totalAdded} removed={totalRemoved} />
              <span className="changes-hint">点击审查改动</span>
            </span>
          </span>
        </button>
        {single === undefined ? (
          <ul className="changes-list">
            {visible.map((file) => (
              <li
                className="changes-row-wrap"
                key={file.path}
                onMouseEnter={(event) => armHover(file, event.currentTarget.getBoundingClientRect())}
                onMouseLeave={hoverDelay.disarm}
              >
                <button
                  type="button"
                  className="changes-row"
                  onClick={() => {
                    reviewAt(files.indexOf(file))
                  }}
                >
                  <span className="changes-path" title={file.path}>
                    {file.status === 'added' && <span className="changes-badge">新增</span>}
                    {displayPathOf(file.path, cwd)}
                  </span>
                  <Counts added={file.added} removed={file.removed} />
                </button>
                <span className="changes-act">
                  <button
                    type="button"
                    className="changes-btn"
                    onClick={() => {
                      reviewAt(files.indexOf(file))
                    }}
                  >
                    审查
                  </button>
                  <button
                    type="button"
                    className="changes-btn"
                    onClick={() => {
                      openAt(file.path)
                    }}
                  >
                    打开
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {single === undefined && files.length > COLLAPSED_ROWS ? (
          <button
            type="button"
            className="changes-toggle"
            onClick={() => {
              setExpanded((value) => !value)
            }}
          >
            {expanded ? '收起' : `展开全部 ${String(files.length)} 个文件`}
          </button>
        ) : null}
        {single !== undefined ? (
          <div className="changes-act changes-act-single">
            <button
              type="button"
              className="changes-btn"
              onClick={() => {
                reviewAt(0)
              }}
            >
              审查
            </button>
            <button
              type="button"
              className="changes-btn"
              onClick={() => {
                openAt(single.path)
              }}
            >
              打开
            </button>
          </div>
        ) : null}
        {hover !== null ? (
          <DiffHoverCard
            file={hover.item}
            anchor={hover.anchor}
            cardWidth={hover.cardWidth}
            cwd={cwd}
            onKeep={hoverDelay.keep}
            onLeave={hoverDelay.disarm}
            onClose={hoverDelay.close}
          />
        ) : null}
    </div>
  )
}

