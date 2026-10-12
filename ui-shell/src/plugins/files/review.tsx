/**
 * 审查面板（桌面渲染层 `DiffPane.tsx` 的同构移植）：轮尾「文件已更改」卡点「审查」后，
 * 停靠区里显示那一轮的文件清单 + 选中文件的差异段。
 *
 * 数据全部来自卡带上的 `hunks`（宿主在工具执行层算好的差异）——这里不读文件系统，
 * 审的是「那一刀改了什么」的快照；要看文件当前内容走「打开」进预览页签（旧界面同款）。
 *
 * 与旧界面的形态差异只有一处：旧界面是正文右侧的并排栏（自带宽度拖拽与
 * `--dsc-diff-pane-w`），壳里并进停靠区当一块面板——宽度归停靠区（同一根拖宽条），
 * 面板本体与旧界面同一份 class 与 render 结构，样式零新写。
 *
 * 视图状态记忆在 localStorage，键与旧界面一模一样：unified ⇄ split（`dsc.diffView`）、
 * 自动换行（`dsc.diffWrap`）。
 *
 * @module dsc-ui-shell/plugins/files/review
 */
import { useEffect, useState, type ReactNode } from 'react'
import { DiffRows, FileIcon, getHostNative, setDockPanel, setDockPreview, toastErr, useDockPanel, useDockReview } from '@dsc/ui'
import { displayPathOf } from '../../platform/paths'

/** 这一块面板在停靠区里的 id（壳拿它决定同一时刻显示哪一块）。 */
const PANEL = 'review'

/** 视图 / 换行的 localStorage 键（与旧界面同一份，两个界面共享用户习惯）。 */
const VIEW_KEY = 'dsc.diffView'
const WRAP_KEY = 'dsc.diffWrap'

/** 审查面板：读停靠区的审查目标画（没点过「审查」时给一句空态）。 */
export function ReviewPanel(): ReactNode {
  const active = useDockPanel() === PANEL
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

  const file = review === null ? undefined : (review.files[index] ?? review.files[0])
  const native = getHostNative()

  return (
    <aside className="dock" style={{ width: '100%' }} data-hidden={active ? undefined : '1'}>
      <div className="dock-body">
        <div className="diff-pane" data-diff-pane data-embed="1">
          <div className="diff-head">
            {review !== null && review.files.length > 1 ? (
              <select
                className="diff-file-select"
                value={String(index)}
                onChange={(event) => {
                  setIndex(Number(event.target.value))
                }}
                aria-label="选择要审查的文件"
              >
                {review.files.map((entry, at) => (
                  <option key={entry.path} value={String(at)} title={entry.path}>
                    {displayPathOf(entry.path, review.cwd)}
                  </option>
                ))}
              </select>
            ) : (
              file !== undefined && (
                <span className="diff-file-name" title={file.path}>
                  {displayPathOf(file.path, review?.cwd ?? '')}
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
                    data-tip="在文件面板中打开当前文件（审查内容是修改当时的快照）"
                    onClick={() => {
                      setDockPreview({ path: file.path, cwd: review?.cwd ?? '' })
                      setDockPanel('preview')
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
                  setDockPanel(null)
                }}
              >
                关闭
              </button>
            </span>
          </div>
          {file === undefined ? (
            <p className="diff-note">这一轮没有可审查的改动。</p>
          ) : (
            <>
              {file.truncated === true && (
                <p className="diff-note">改动较大，这里只显示了前一部分（完整改动以文件当前内容为准）。</p>
              )}
              <DiffRows hunks={file.hunks} path={file.path} split={split} wrap={wrap} />
            </>
          )}
        </div>
      </div>
    </aside>
  )
}
