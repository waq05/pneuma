/**
 * 审查面板（桌面渲染层 `DiffPane.tsx` 的同构移植）：轮尾「文件已更改」卡点「审查」后，
 * 在正文右侧**并排**显示那一轮的文件清单 + 选中文件的差异段。
 *
 * 数据全部来自卡带上的 `hunks`（宿主在工具执行层算好的差异）——这里不读文件系统，
 * 审的是「那一刀改了什么」的快照；要看文件当前内容走「打开」进预览页签（旧界面同款）。
 *
 * 与旧界面同宽同拖法：左缘拖拽调宽（localStorage `dsc.diffPaneWidth`，
 * CSS 变量 `--dsc-diff-pane-w`，区间 320–900，双击复位）；视图状态记忆在
 * `dsc.diffView`（unified ⇄ split）与 `dsc.diffWrap`（自动换行），键与旧界面一模一样。
 *
 * @module dsc-ui-shell/review-pane
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { ChangedFileView } from '@dsc/ui-core'
import {
  DiffRows,
  FileIcon,
  PANEL_KEYS,
  Select,
  displayPathOf,
  readRootPx,
  readStoredPx,
  setRootVar,
  toastErr,
  useWidthDrag,
  writeStoredPx,
} from '@dsc/ui-primitives'
import { getHostNative } from '@dsc/ui'
import { dockActions, setDockReview, useDockReview } from '@dsc/ui-dockkit'

/** 视图 / 换行 / 宽度的键与变量名（与旧界面同一份，两个界面共享用户习惯）。 */
const VIEW_KEY = 'dsc.diffView'
const WRAP_KEY = 'dsc.diffWrap'
const PANE_W_VAR = '--dsc-diff-pane-w'
/** 面板宽度拖拽区间（px），与 CSS 的回退 clamp 同源。 */
const PANE_W_MIN = 320
const PANE_W_MAX = 900

/**
 * 右侧审查栏：读壳的审查目标画；没点过「审查」时壳根本不渲染它（见 app.tsx）。
 *
 * 判空与旧界面不同的一点：旧界面 `review` 是 App 的 state（非空才挂载），壳的审查目标
 * 住在 dock-state——这里再判一次是为了防「关掉面板那一下」的中间帧画出空白栏。
 */
export function ReviewPane(): ReactNode {
  const review = useDockReview()
  const [index, setIndex] = useState(0)
  const [split, setSplit] = useState(() => localStorage.getItem(VIEW_KEY) === 'split')
  const [wrap, setWrap] = useState(() => localStorage.getItem(WRAP_KEY) === 'wrap')

  // 审查目标一换（点了另一轮的「审查」，或同一张卡又点了另一行）就回到它指定的那一份文件
  // （旧界面同款：onReview(files, index) 带着下标重开）。payload 每次点击都是新对象，
  // 认对象引用而不是内容：重复点同一行也重定位一次，下拉里手动切过的位置因此不会打架。
  useEffect(() => {
    if (review !== null) setIndex(Math.min(review.index, Math.max(0, review.files.length - 1)))
  }, [review])

  // 挂载时把存档宽度回灌进 CSS 变量（flex-basis 走 var）；没存档就是 CSS 里的默认值。
  useEffect(() => {
    const saved = readStoredPx(PANEL_KEYS.diffPaneWidth, PANE_W_MIN, PANE_W_MAX)
    if (saved !== null) setRootVar(PANE_W_VAR, `${String(saved)}px`)
  }, [])
  const drag = useWidthDrag({
    getBase: () => readRootPx(PANE_W_VAR, 480),
    // 面板在右、热区在左缘：指针向左移（dx 为负）面板变宽，方向取反
    sign: -1,
    clamp: (px) => Math.min(PANE_W_MAX, Math.max(PANE_W_MIN, px)),
    onDrag: (px) => setRootVar(PANE_W_VAR, `${String(px)}px`),
    onCommit: (px) => writeStoredPx(PANEL_KEYS.diffPaneWidth, px),
  })
  const resetWidth = (): void => {
    writeStoredPx(PANEL_KEYS.diffPaneWidth, null)
    setRootVar(PANE_W_VAR, null)
  }

  const toggleSplit = (): void => {
    setSplit((current) => {
      try {
        localStorage.setItem(VIEW_KEY, current ? 'unified' : 'split')
      } catch {
        // 存不下就只影响下次启动的默认视图，不该打断切换
      }
      return !current
    })
  }
  const toggleWrap = (): void => {
    setWrap((current) => {
      try {
        localStorage.setItem(WRAP_KEY, current ? 'nowrap' : 'wrap')
      } catch {
        // 同上
      }
      return !current
    })
  }

  if (review === null) return null
  const file = review.files[index] ?? review.files[0]
  const native = getHostNative()
  return (
    <aside className="diff-pane" data-diff-pane>
      <div
        className="diff-resizer"
        {...drag}
        onDoubleClick={resetWidth}
        data-tip="拖拽调宽 · 双击复位"
        aria-label="调整审查面板宽度"
      />
      <div className="diff-head">
        {review.files.length > 1 ? (
          <Select
            className="diff-file-select"
            ariaLabel="选择要审查的文件"
            value={String(index)}
            options={review.files.map((entry, at) => ({
              value: String(at),
              label: displayPathOf(entry.path, review.cwd),
            }))}
            onPick={(next) => {
              setIndex(Number(next))
            }}
          />
        ) : (
          file !== undefined && (
            <span className="diff-file-name" title={file.path}>
              {displayPathOf(file.path, review.cwd)}
            </span>
          )
        )}
        {file !== undefined && (
          <span className="changes-counts">
            {file.status === 'added' && <span className="diff-badge">新增</span>}
            <span className="changes-added">{`+${String(file.added)}`}</span>
            <span className="changes-removed">{`-${String(file.removed)}`}</span>
          </span>
        )}
        <span className="diff-tools">
          <button type="button" className="diff-tool" aria-pressed={split} data-tip="分栏 / 合并视图" onClick={toggleSplit}>
            {split ? '合并' : '分栏'}
          </button>
          <button type="button" className="diff-tool" aria-pressed={wrap} data-tip="长行自动换行" onClick={toggleWrap}>
            换行
          </button>
          {file !== undefined && (
            <>
              <FileIcon name={file.path} size={15} />
              {native.available ? (
                <button
                  type="button"
                  className="diff-tool"
                  data-tip="用系统默认程序打开"
                  onClick={() => {
                    void native.invoke('openPath', [file.path]).catch((reason: unknown) => {
                      toastErr(`系统打开失败：${reason instanceof Error ? reason.message : String(reason)}`)
                    })
                  }}
                >
                  系统打开
                </button>
              ) : null}
              <button
                type="button"
                className="diff-tool"
                data-tip="在预览页签里打开当前文件（审查内容是修改当时的快照）"
                onClick={() => {
                  dockActions.openPreview(file.path)
                }}
              >
                打开
              </button>
            </>
          )}
          <button
            type="button"
            className="diff-tool"
            data-tip="关闭审查"
            onClick={() => {
              setDockReview(null)
            }}
          >
            关闭
          </button>
        </span>
      </div>
      {file === undefined ? (
        <p className="diff-note">这一轮没有可审查的改动。</p>
      ) : (
        <FileDiff file={file} split={split} wrap={wrap} />
      )}
    </aside>
  )
}

/** 审查面板里单个文件：截断提示 + 差异正文。 */
function FileDiff({ file, split, wrap }: { file: ChangedFileView; split: boolean; wrap: boolean }): ReactNode {
  return (
    <>
      {file.truncated === true && (
        <p className="diff-note">改动较大，这里只显示了前一部分（完整改动以文件当前内容为准）。</p>
      )}
      <DiffRows hunks={file.hunks} path={file.path} split={split} wrap={wrap} />
    </>
  )
}
