/**
 * `/review` findings 卡（T45）：审查队友交回的那段 `<review-findings>` 汇报在对话流里的
 * 展示形态——卡头（队友名 + 收工状态）+ 引言 + 按条渲染（优先级徽标、标题、可点的位置、
 * 说明、建议）。位置点开走右侧预览页签并定位到行。
 *
 * 解析在 `./review-findings`（零依赖纯模块，探针直测）；本组件只管画。
 * 样式全用 `ui-shell/src/legacy/views.css` 里已有的 `.review-findings*` / `.review-finding*`
 * 那一套（含 `data-priority='P0'…'P3'` 四档徽标），这里不新造样式。
 *
 * @module dsc-ui-shell/ui-primitives/review-findings-card
 */
import type { ReactNode } from 'react'
import { IconSearch } from './icons'
import { joinPath } from './paths'
import type { ReviewFinding, ReviewFindingPriority, ReviewFindingsView } from './review-findings'

/**
 * 徽标文案：档位越靠前越重。
 * 写中文短名而不是光一个 `P0`：审查结论是给人看的，光看 P 几还得回查一遍约定。
 */
const PRIORITY_LABEL: Readonly<Record<ReviewFindingPriority, string>> = {
  0: 'P0 必须修',
  1: 'P1 重要',
  2: 'P2 建议',
  3: 'P3 可选',
}

/**
 * 把位置变成绝对路径：审查队友写的是仓库相对路径；万一它写全了（`E:/a/b.ts`）就原样用。
 * @param cwd - 会话工作目录（仓库根）
 * @param path - 队友写的路径
 */
function absoluteOf(cwd: string, path: string): string {
  const windows = /^[a-zA-Z]:[\\/]/.test(path)
  const posix = path.startsWith('/') || path.startsWith('\\')
  if (windows || posix || cwd === '') return path
  return joinPath(cwd, path)
}

/** 一条 finding：徽标 + 标题、位置（可点）、说明、建议。 */
function FindingRow({ finding, cwd, onOpenLocation }: {
  finding: ReviewFinding
  cwd: string
  onOpenLocation?: (path: string, line?: number) => void
}): ReactNode {
  const priority = finding.priority
  const location = finding.location
  const open = location === undefined ? undefined : (): void => {
    onOpenLocation?.(absoluteOf(cwd, location.path), location.line)
  }
  return (
    <li className="review-finding" {...(priority === undefined ? {} : { 'data-priority': `P${String(priority)}` })}>
      <div className="review-finding-head">
        <span className="review-finding-badge">{priority === undefined ? 'P?' : PRIORITY_LABEL[priority]}</span>
        <span className="review-finding-title">{finding.title}</span>
      </div>
      {location === undefined ? null : (
        <button
          type="button"
          className="review-finding-loc"
          // 没有跳转通道时不要长得像能点：位置信息仍然完整显示
          disabled={onOpenLocation === undefined}
          title={
            onOpenLocation === undefined
              ? `${location.path}${location.line === undefined ? '' : `:${String(location.line)}`}`
              : location.line === undefined
                ? '在预览里打开这个文件'
                : `在预览里打开 ${location.path}:${String(location.line)}`
          }
          onClick={open}
        >
          {location.path}
          {location.line === undefined ? '' : `:${String(location.line)}`}
        </button>
      )}
      {finding.detail === '' ? null : <p className="review-finding-detail">{finding.detail}</p>}
      {finding.suggestion === undefined || finding.suggestion === '' ? null : (
        <p className="review-finding-suggest">建议：{finding.suggestion}</p>
      )}
    </li>
  )
}

/**
 * 审查结论卡。
 *
 * @param props.doc - `parseReviewFindings` 的解析结果
 * @param props.cwd - 会话工作目录（位置是仓库相对路径，点开预览要拼成绝对路径）
 * @param props.onOpenLocation - 点位置时打开预览；不给就只显示文本（不引入新的打开方式）
 */
export function ReviewFindingsCard({ doc, cwd = '', onOpenLocation }: {
  doc: ReviewFindingsView
  cwd?: string
  onOpenLocation?: (path: string, line?: number) => void
}): ReactNode {
  return (
    <div className="review-findings" data-review-findings="">
      <div className="review-findings-head">
        <IconSearch size={14} />
        <span className="review-findings-title">代码审查 · {doc.teammate === '' ? '审查队友' : doc.teammate}</span>
        {doc.state === undefined ? null : <span className="review-findings-state">{doc.state}</span>}
        {doc.findings.length === 0 ? null : <span>{`${String(doc.findings.length)} 条`}</span>}
      </div>
      {doc.note === '' ? null : <p className="review-findings-note">{doc.note}</p>}
      {doc.findings.length === 0 ? null : (
        <ul className="review-findings-list">
          {doc.findings.map((finding, at) => (
            <FindingRow key={`${String(at)}:${finding.title}`} finding={finding} cwd={cwd} {...(onOpenLocation === undefined ? {} : { onOpenLocation })} />
          ))}
        </ul>
      )}
    </div>
  )
}
