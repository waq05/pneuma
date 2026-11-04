/**
 * `/review` findings 卡（T45）：审查队友交回的那段 `<review-findings>` 汇报在对话流里的
 * 展示形态——卡头（队友名 + 收工状态）+ 引言 + 按条渲染（优先级徽标、标题、可点的位置、
 * 说明、建议）。位置点开走右侧预览页签并定位到行。
 *
 * 解析在 `./review-findings`（零依赖纯模块，探针直测）；本组件只管画。
 * 样式全用 `src/packages/ui-renderer/ui/styles/legacy/views.css` 里已有的 `.review-findings*` / `.review-finding*`
 * 那一套（含 `data-priority='P0'…'P3'` 四档徽标），这里不新造样式。
 *
 * @module dsc-ui-shell/ui-primitives/review-findings-card
 */
import type { ReactNode } from 'react'
import { createT } from '@dsc/ui-core'
import { IconSearch } from './icons'
import { joinPath } from './paths'
import type { ReviewFinding, ReviewFindingPriority, ReviewFindingsView } from './review-findings'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui-core` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 徽标文案：档位越靠前越重。
 * 写中文短名而不是光一个 `P0`：审查结论是给人看的，光看 P 几还得回查一遍约定。
 */
const PRIORITY_LABEL: Readonly<Record<ReviewFindingPriority, string>> = {
  0: t('primitives.priority.p0'),
  1: t('primitives.priority.p1'),
  2: t('primitives.priority.p2'),
  3: t('primitives.priority.p3'),
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
                ? t('primitives.review.openFile')
                : t('primitives.review.openAt', { path: location.path, line: String(location.line) })
          }
          onClick={open}
        >
          {location.path}
          {location.line === undefined ? '' : `:${String(location.line)}`}
        </button>
      )}
      {finding.detail === '' ? null : <p className="review-finding-detail">{finding.detail}</p>}
      {finding.suggestion === undefined || finding.suggestion === '' ? null : (
        <p className="review-finding-suggest">{t('primitives.review.suggestion', { text: finding.suggestion })}</p>
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
        <span className="review-findings-title">{t('primitives.review.title', { teammate: doc.teammate === '' ? t('primitives.review.teammate') : doc.teammate })}</span>
        {doc.state === undefined ? null : <span className="review-findings-state">{doc.state}</span>}
        {doc.findings.length === 0 ? null : <span>{t('primitives.review.count', { n: doc.findings.length })}</span>}
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
