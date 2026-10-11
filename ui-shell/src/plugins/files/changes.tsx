/**
 * 文件面板的「变更」页签：git 状态三分组 + 暂存/提交 + 提交历史 + diff 视图。
 *
 * 读类 op（`git-status` / `git-diff` / `git-log`）直接放行，浏览器里也能用；
 * 写类 op（`git-stage` / `git-unstage` / `git-commit`）在界面通道**过审批**——
 * 面板只管发调用，宿主的权限裁决与审批卡（prompt 插件）走同一套，与工具调用同口径。
 *
 * 样式零新写：`.git-*` 与 `.diff-*` 全在 legacy/views.css 里（整份搬运时的伏笔）。
 *
 * @module dsc-ui-shell/plugins/files/changes
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  IconChevronDown,
  IconChevronRight,
  highlightLines,
  toastErr,
  toastOk,
  useHostChannel,
  type HighlightedLine,
} from '@dsc/ui'
import {
  parseUnifiedDiff,
  splitUnifiedDiffByFile,
  type DiffHunkView,
  type UnifiedFileDiff,
} from './diff'

/** `git-status` 的回包（宿主 desktop-dock 插件的形状）。 */
interface GitStatus {
  branch: string
  staged: string[]
  unstaged: string[]
  untracked: string[]
}

/** 提交历史的一行（`git-log` 的 `%h%x09%an%x09%ad%x09%s` 切出来）。 */
interface LogLine {
  hash: string
  author: string
  date: string
  subject: string
}

/** git status 行里的状态码前缀剥掉，剩下的才是文件路径（照旧渲染层 fileOf 的字符类：
    unstaged 行以空格开头，字符类里必须带空格，否则剥不掉——带着前缀去查 diff，
    git 只会回空 diff）。 */
function fileOf(entry: string): string {
  return entry.replace(/^[ AMDRCU?]+\s+/, '')
}

/** 「变更」页签的主体：挂载即取一次状态，刷新按钮手动重取。 */
export function ChangesPanel(): ReactNode {
  const channel = useHostChannel()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState('')
  /**
   * 底部 diff 视图：点文件行（或「全部改动」）展开，再点一次收起。
   * `file === null` = 全量未提交改动。
   */
  const [diff, setDiff] = useState<{ file: string | null; loading: boolean; text: string } | null>(null)
  /** 提交信息的草稿（遵循 feat:/fix:/chore: 规范的占位提示）。 */
  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  /** 提交历史（面板第一次打开时读一次；提交/刷新后重读）。 */
  const [log, setLog] = useState<LogLine[] | null>(null)

  const refresh = useCallback((): void => {
    void channel
      .invoke<GitStatus>('dock', ['git-status', {}])
      .then((data) => {
        setStatus(data)
        setError('')
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
    void channel
      .invoke<{ log: string }>('dock', ['git-log', {}])
      .then((data) => {
        setLog(
          String(data?.log ?? '')
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => {
              const [hash, author, date, ...rest] = line.split('\t')
              return { hash: hash ?? '', author: author ?? '', date: date ?? '', subject: rest.join('\t') }
            }),
        )
      })
      .catch(() => {
        setLog([])
      })
  }, [channel])

  useEffect(() => {
    refresh()
  }, [refresh])

  /** 展开/收起一个文件的 diff；null = 全量。untracked 组不可点（untracked 没有 diff）。 */
  const toggleDiff = (file: string | null): void => {
    if (diff !== null && diff.file === file) {
      setDiff(null)
      return
    }
    setDiff({ file, loading: true, text: '' })
    void channel
      .invoke<{ diff: string }>('dock', ['git-diff', file === null ? {} : { file }])
      .then((data) => {
        setDiff({ file, loading: false, text: String(data?.diff ?? '') })
      })
      .catch((cause: unknown) => {
        setDiff(null)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  /** 暂存 / 取消暂存一批文件（写类 op：宿主侧过审批，界面等回执）。 */
  const stage = (op: 'git-stage' | 'git-unstage', files: string[], tip: string): void => {
    void channel
      .invoke('dock', [op, { files }])
      .then(() => {
        toastOk(tip)
        refresh()
        // 暂存状态变了，刚展开的 diff 已经过期，收掉它免得误导。
        setDiff(null)
      })
      .catch((cause: unknown) => toastErr(`${op === 'git-stage' ? '暂存' : '取消暂存'}失败：${cause instanceof Error ? cause.message : String(cause)}`))
  }

  /** 提交（写类 op：过审批）。提交完清空草稿、刷新状态与历史、收起过期 diff。 */
  const commit = (): void => {
    const text = message.trim()
    if (text === '' || committing) return
    setCommitting(true)
    void channel
      .invoke<{ output: string }>('dock', ['git-commit', { message: text }])
      .then(() => {
        toastOk('已提交')
        setMessage('')
        refresh()
        setDiff(null)
      })
      .catch((cause: unknown) => toastErr(`提交失败：${cause instanceof Error ? cause.message : String(cause)}`))
      .finally(() => setCommitting(false))
  }

  if (status === null) {
    return (
      <div className="git-pane">
        {error === '' ? (
          <div className="trace-empty">读取中…</div>
        ) : (
          <>
            <div className="notice">{error}</div>
            <div className="trace-empty">此目录不是 git 仓库，或读取失败。</div>
          </>
        )}
      </div>
    )
  }

  const total = status.staged.length + status.unstaged.length + status.untracked.length
  return (
    <div className="git-pane">
      <div className="git-branch">
        <span className="round-no">{status.branch}</span>
        <span className="git-count">{String(total)} 处更改</span>
        <button
          type="button"
          className="icon-btn git-diff-all"
          data-tip="看全部未提交改动的 diff"
          onClick={() => {
            toggleDiff(null)
          }}
        >
          全部改动
        </button>
        <button
          type="button"
          className="icon-btn"
          data-tip="刷新状态"
          aria-label="刷新状态"
          onClick={refresh}
        >
          ↻
        </button>
      </div>
      {error === '' ? null : <div className="notice">{error}</div>}
      <GitGroup
        title={`已暂存（${String(status.staged.length)}）`}
        files={status.staged}
        expandedFile={diff?.file ?? undefined}
        onShowDiff={toggleDiff}
        onStage={(files) => stage('git-unstage', files, '已取消暂存')}
        stageTip="取消暂存"
      />
      <GitGroup
        title={`未暂存（${String(status.unstaged.length)}）`}
        files={status.unstaged}
        expandedFile={diff?.file ?? undefined}
        onShowDiff={toggleDiff}
        onStage={(files) => stage('git-stage', files, '已暂存')}
        stageTip="暂存"
      />
      <GitGroup title={`未跟踪（${String(status.untracked.length)}）`} files={status.untracked} />
      {/* 提交区：无暂存禁用（旧界面同款）；提交信息走写类 op 的审批。 */}
      <div className="git-commit">
        <textarea
          rows={2}
          placeholder="遵循 feat:/fix:/chore: 规范"
          value={message}
          aria-label="提交信息"
          onChange={(event) => setMessage(event.target.value)}
        />
        <button
          type="button"
          className="btn-primary"
          disabled={committing || status.staged.length === 0 || message.trim() === ''}
          onClick={commit}
        >
          {committing ? '提交中…' : '提交'}
        </button>
      </div>
      {/* 提交历史：hash + 信息 + 作者 · 日期（旧界面同一行结构）。 */}
      {log === null || log.length === 0 ? null : (
        <div className="git-log">
          {log.map((line) => (
            <div className="git-log-row" key={line.hash + line.date + line.subject} title={`${line.hash} ${line.author} ${line.date}`}>
              <code>{line.hash}</code>
              <span className="git-log-msg">{line.subject}</span>
              <span className="git-log-meta">
                {line.author} · {line.date}
              </span>
            </div>
          ))}
        </div>
      )}
      {diff === null ? null : <GitDiffView diff={diff} onClose={() => setDiff(null)} />}
    </div>
  )
}

/** 一组文件行：可点的展开该文件的 diff；不可点的（untracked）给禁用态。
    给了 onStage 时行尾带一颗暂存/取消暂存钮（写类 op，走宿主审批）。 */
function GitGroup(props: {
  title: string
  files: readonly string[]
  onShowDiff?: (file: string) => void
  /** 当前 diff 视图正显示的文件（行高亮用）。 */
  expandedFile?: string
  /** 行尾的暂存/取消暂存动作（未给就不画这颗钮）。 */
  onStage?: (files: string[]) => void
  /** 那颗钮的提示词（「暂存」/「取消暂存」）。 */
  stageTip?: string
}): ReactNode {
  const [open, setOpen] = useState(true)
  if (props.files.length === 0) return null
  return (
    <div className="git-group">
      <button
        type="button"
        className="git-group-head"
        onClick={() => {
          setOpen((current) => !current)
        }}
      >
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />} {props.title}
      </button>
      {open &&
        props.files.map((file) => {
          const path = fileOf(file)
          return (
            <div key={file} className="git-file" data-expanded={props.expandedFile === path || undefined}>
              <button
                type="button"
                className="git-file-name"
                data-tip={file}
                disabled={props.onShowDiff === undefined}
                onClick={() => {
                  props.onShowDiff?.(path)
                }}
              >
                {file}
              </button>
              {props.onStage === undefined ? null : (
                <button
                  type="button"
                  className="icon-btn"
                  data-tip={props.stageTip}
                  aria-label={`${props.stageTip} ${path}`}
                  onClick={() => props.onStage?.([path])}
                >
                  {props.stageTip === '暂存' ? '+' : '−'}
                </button>
              )}
            </div>
          )
        })}
    </div>
  )
}

/** 底部 diff 视图：单文件一段、全量按 `diff --git` 切成多段（照旧渲染层 GitDiffView 的结构）。 */
function GitDiffView(props: {
  diff: { file: string | null; loading: boolean; text: string }
  onClose: () => void
}): ReactNode {
  const sections: UnifiedFileDiff[] = props.diff.loading
    ? []
    : props.diff.file === null
      ? splitUnifiedDiffByFile(props.diff.text)
      : (() => {
          // 单文件：全部 hunk 归一段
          const hunks = parseUnifiedDiff(props.diff.text)
          const added = hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.kind === 'add').length, 0)
          const removed = hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.kind === 'remove').length, 0)
          return hunks.length === 0 ? [] : [{ path: props.diff.file ?? '', added, removed, hunks }]
        })()
  return (
    <div className="git-diff-view">
      <div className="git-diff-head">
        <span className="git-diff-title">{props.diff.file === null ? '全部未提交改动' : props.diff.file}</span>
        <button
          type="button"
          className="icon-btn"
          data-tip="关闭"
          aria-label="关闭 diff 视图"
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
      {props.diff.loading ? (
        <div className="trace-empty">读取中…</div>
      ) : sections.length === 0 ? (
        <div className="trace-empty">没有可显示的改动（未跟踪文件不会出现在 diff 里）。</div>
      ) : (
        <div className="git-diff-body">
          {sections.map((section) => (
            <div key={section.path} className="git-diff-file">
              <div className="git-diff-file-head">
                <span className="git-diff-path">{section.path}</span>
                <span className="changes-counts">
                  <span className="changes-added">{`+${String(section.added)}`}</span>
                  <span className="changes-removed">{`-${String(section.removed)}`}</span>
                </span>
              </div>
              <DiffRows hunks={section.hunks} path={section.path} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 结构化 hunk → unified 行（照旧渲染层 DiffPane.tsx 的 DiffRow：旧行号/新行号/记号/内容），
 * 逐 token 上色走壳平台层的 `highlightLines`（按文件扩展名挑语法，装不上回落纯文本）。
 */
function DiffRows({ hunks, path }: { hunks: readonly DiffHunkView[]; path: string }): ReactNode {
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
    <div className="diff-body">
      {hunks.map((hunk, index) => {
        const head = cursor
        cursor += hunk.lines.length
        return (
          <div className="diff-hunk" key={String(index)}>
            <div className="diff-hunk-head">
              {`@@ -${String(hunk.oldStart)},${String(hunk.oldCount)} +${String(hunk.newStart)},${String(hunk.newCount)} @@`}
            </div>
            {hunk.lines.map((line, at) => {
              const kind = line.kind === 'add' ? 'add' : line.kind === 'remove' ? 'del' : 'ctx'
              const highlight = highlights?.[head + at]
              return (
                <div className={`diff-line diff-${kind}`} key={String(at)}>
                  <span className="diff-no">{line.oldLine === null ? '' : String(line.oldLine)}</span>
                  <span className="diff-no">{line.newLine === null ? '' : String(line.newLine)}</span>
                  <span className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ''}</span>
                  {highlight === undefined ? (
                    <span className="diff-text">{line.text}</span>
                  ) : (
                    <span className="diff-text" dangerouslySetInnerHTML={{ __html: highlight.segments.join('') }} />
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
