/**
 * 差异行渲染（桌面渲染层 `DiffPane.tsx` 的 DiffRows 同构移植）：hunk 头 + unified/split 正文，
 * 逐 token 上色走壳平台层的 `highlightLines`（按文件扩展名挑语法，装不上回落纯文本）。
 *
 * 四个复用点共用这一份：审查面板、工具卡的「将做的改动」、悬停预览、变更页签的 git diff
 * （dsh 的 CHAT_DIFF 渲染口径：同一套行样式走天下）。高亮是异步的——先出纯文本，
 * tokens 回来后重绘；所有 hunk 的行按顺序拼成一段代码整块喂 shiki（保解析器跨行状态），
 * 按行映射回各处。`wrap` 控制长行折行还是横向滚，由各复用点自己决定。
 *
 * @module dsc-ui-shell/platform/diff-rows
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { DiffHunkView, DiffLineView } from '@dsc/ui-core'
import { highlightLines, type HighlightedLine } from './highlight'

/** 一行内容（高亮或纯文本回落，渲染共用）。 */
function LineText({ text, highlight }: { text: string; highlight?: HighlightedLine }): ReactNode {
  if (highlight === undefined) return <span className="diff-text">{text}</span>
  return <span className="diff-text" dangerouslySetInnerHTML={{ __html: highlight.segments.join('') }} />
}

/** 一行差异（unified 视图）：旧行号 / 新行号 / 记号 / 内容，底色按增删着。 */
function DiffRow({ line, highlight }: { line: DiffLineView; highlight?: HighlightedLine }): ReactNode {
  const kind = line.kind === 'add' ? 'add' : line.kind === 'remove' ? 'del' : 'ctx'
  return (
    <div className={`diff-line diff-${kind}`}>
      <span className="diff-no">{line.oldLine === null ? '' : String(line.oldLine)}</span>
      <span className="diff-no">{line.newLine === null ? '' : String(line.newLine)}</span>
      <span className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ''}</span>
      <LineText text={line.text} highlight={highlight} />
    </div>
  )
}

/** split 视图的行对：左 = 旧文件（context+remove），右 = 新文件（context+add），缺的一侧补空。 */
interface SplitPair {
  left: DiffLineView | null
  right: DiffLineView | null
}

/**
 * 把 hunk 的行配成 split 行对：连续的 remove 段与 add 段按顺序 zip（多余一侧补空行），
 * context 行左右各一份。
 */
function hunkPairs(lines: readonly DiffLineView[]): SplitPair[] {
  const pairs: SplitPair[] = []
  let at = 0
  while (at < lines.length) {
    const line = lines[at]!
    if (line.kind === 'context') {
      pairs.push({ left: line, right: line })
      at += 1
      continue
    }
    let removes = 0
    let cursor = at
    while (cursor < lines.length && lines[cursor]!.kind === 'remove') {
      removes += 1
      cursor += 1
    }
    let adds = 0
    while (cursor < lines.length && lines[cursor]!.kind === 'add') {
      adds += 1
      cursor += 1
    }
    const count = Math.max(removes, adds)
    for (let offset = 0; offset < count; offset += 1) {
      pairs.push({
        left: offset < removes ? lines[at + offset]! : null,
        right: offset < adds ? lines[at + removes + offset]! : null,
      })
    }
    at = cursor
  }
  return pairs
}

/** split 行的半边（一列）：行号 / 记号 / 内容，空半边画淡占位。 */
function HalfCell({ line, show, highlight }: { line: DiffLineView | null; show: 'old' | 'new'; highlight?: HighlightedLine }): ReactNode {
  if (line === null) {
    return (
      <span className="diff-half diff-half-empty">
        <span className="diff-no" />
        <span className="diff-sign" />
        <span className="diff-text" />
      </span>
    )
  }
  const kind = line.kind === 'add' ? 'add' : line.kind === 'remove' ? 'del' : 'ctx'
  return (
    <span className={`diff-half diff-half-${kind}`}>
      <span className="diff-no">{(show === 'old' ? line.oldLine : line.newLine) ?? ''}</span>
      <span className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ''}</span>
      <LineText text={line.text} highlight={highlight} />
    </span>
  )
}

/** 一个 hunk：头行 + 正文（unified 或 split）。 */
function HunkBlock({
  hunk,
  split,
  highlights,
  head,
}: {
  hunk: DiffHunkView
  split: boolean
  highlights: HighlightedLine[] | null
  head: number
}): ReactNode {
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-head">{`@@ -${String(hunk.oldStart)},${String(hunk.oldCount)} +${String(hunk.newStart)},${String(hunk.newCount)} @@`}</div>
      {split ? (
        hunkPairs(hunk.lines).map((pair, at) => (
          <span className="diff-split-row" key={String(at)}>
            <HalfCell line={pair.left} show="old" highlight={highlights?.[head + at]} />
            <HalfCell line={pair.right} show="new" highlight={highlights?.[head + at]} />
          </span>
        ))
      ) : (
        hunk.lines.map((line, at) => <DiffRow line={line} highlight={highlights?.[head + at]} key={String(at)} />)
      )}
    </div>
  )
}

export function DiffRows({
  hunks,
  path,
  split = false,
  wrap = false,
}: {
  hunks: readonly DiffHunkView[]
  /** 文件路径：给 shiki 推断高亮语言；拿不到就传空串（不出高亮）。 */
  path: string
  split?: boolean
  wrap?: boolean
}): ReactNode {
  const [highlights, setHighlights] = useState<HighlightedLine[] | null>(null)
  // 拼接放渲染体里、effect 认字符串：hunks 数组每次渲染都是新引用时也不会反复触发高亮。
  const code = hunks.map((hunk) => hunk.lines.map((line) => line.text).join('\n')).join('\n')
  useEffect(() => {
    let on = true
    setHighlights(null)
    void highlightLines(code, path).then((result) => {
      if (on) setHighlights(result)
    })
    return () => {
      on = false
    }
  }, [code, path])
  /** 当前 hunk 起始行在整块高亮结果里的下标。 */
  let cursor = 0
  return (
    <div className="diff-body" data-split={split || undefined} data-wrap={wrap || undefined}>
      {hunks.map((hunk, index) => {
        const head = cursor
        cursor += hunk.lines.length
        return <HunkBlock hunk={hunk} key={String(index)} split={split} highlights={highlights} head={head} />
      })}
    </div>
  )
}
