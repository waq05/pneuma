/**
 * 文件面板的「变更」页签：git 状态三分组 + 每文件增删行数 + 就地展开该文件 diff
 * + 暂存/取消暂存 + 提交对话框 + 提交历史。
 *
 * 读类 op（`git-status` / `git-diff` / `git-log`）直接放行，浏览器里也能用；
 * 写类 op（`git-stage` / `git-unstage` / `git-commit`）在界面通道**过审批**——
 * 面板只管发调用，宿主的权限裁决与审批卡（prompt 插件）走同一套，与工具调用同口径。
 * 提交对话框把「勾选的未暂存文件」随 `git-commit` 一起带过去：宿主先暂存这批路径再
 * 提交（两步同属一条写类 op，一张审批卡覆盖）。
 *
 * 样式零新写：`.git-*` 与 `.diff-*` 全在 legacy/views.css 里（整份搬运时的伏笔）。
 *
 * @module dsc-ui-shell/plugins/files/changes
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { DiffRows, HUMAN_WAIT_TIMEOUT_MS, IconChevronDown, IconChevronRight, toastErr, toastOk, useHostChannel } from '@dsc/ui'
import {
  parseUnifiedDiff,
  splitUnifiedDiffByFile,
  type UnifiedFileDiff,
} from './diff'

/** 单文件的增删行数（`git-status` 的 stats 档按 cwd 相对路径给）。 */
interface GitFileStat {
  added: number
  removed: number
}

/** `git-status` 的回包（宿主 desktop-dock 插件的形状）。 */
interface GitStatus {
  branch: string
  staged: string[]
  unstaged: string[]
  untracked: string[]
  stagedStats?: Record<string, GitFileStat>
  unstagedStats?: Record<string, GitFileStat>
  untrackedStats?: Record<string, GitFileStat>
}

/** 提交历史的一行（`git-log` 的 `%h%x09%an%x09%ad%x09%s` 切出来）。 */
interface LogLine {
  hash: string
  author: string
  date: string
  subject: string
}

/** 展开的 diff 读数（宿主 `git-diff` 回的一段文本 + 一句说明）。 */
interface DiffData {
  loading: boolean
  text: string
  note: string
}

/** 展开态：`group` 是分组 id（staged / unstaged / untracked / all），`file` 为 null 表示「全部改动」。 */
interface Expanded {
  group: string
  file: string | null
}

/** git status 行里的状态码前缀剥掉，剩下的才是文件路径（照旧渲染层 fileOf 的字符类：
    unstaged 行以空格开头，字符类里必须带空格，否则剥不掉——带着前缀去查 diff，
    git 只会回空 diff）。未跟踪组给的是裸路径，不走这一步。 */
function fileOf(entry: string): string {
  return entry.replace(/^[ AMDRCU?]+\s+/, '')
}

/** 「变更」页签的主体：挂载即取一次状态，刷新按钮手动重取。 */
export function ChangesPanel(): ReactNode {
  const channel = useHostChannel()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState('')
  /**
   * 就地展开的 diff：点文件行在该行下方展开该文件的 diff（再点一次收起）；
   * `file === null` = 「全部改动」，落在面板底部。
   * `note` = 宿主对这一段的一句说明（未跟踪的二进制 / 过大 / 目录条目合成不出 diff）。
   */
  const [expanded, setExpanded] = useState<Expanded | null>(null)
  const [diffData, setDiffData] = useState<DiffData>({ loading: false, text: '', note: '' })
  /** 提交对话框的开合（里面的文件清单与信息草稿由对话框自己持有）。 */
  const [commitOpen, setCommitOpen] = useState(false)
  const [committing, setCommitting] = useState(false)
  /** 提交历史（面板第一次打开时读一次；提交/刷新后重读）。 */
  const [log, setLog] = useState<LogLine[] | null>(null)

  const refresh = useCallback((): void => {
    void channel
      .invoke<GitStatus>('dock', ['git-status', { stats: true }])
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

  /**
   * 展开/收起一个文件（或全部改动）的 diff。
   * 未跟踪文件也能点：宿主按文件内容合成一段「全是新增行」的 diff（二进制 / 过大
   * 的合成不出来，回一句 note）；未跟踪的目录整条只有 note。
   * 已暂存组走 `staged:true`（只取已暂存段），其余组取未暂存 / 合成段。
   */
  const toggleDiff = (group: string, file: string | null): void => {
    if (expanded !== null && expanded.group === group && expanded.file === file) {
      setExpanded(null)
      return
    }
    setExpanded({ group, file })
    setDiffData({ loading: true, text: '', note: '' })
    const payload = file === null ? {} : group === 'staged' ? { file, staged: true } : { file }
    void channel
      .invoke<{ diff: string; note?: string }>('dock', ['git-diff', payload])
      .then((data) => {
        setDiffData({ loading: false, text: String(data?.diff ?? ''), note: String(data?.note ?? '') })
      })
      .catch((cause: unknown) => {
        setExpanded(null)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  /** 暂存 / 取消暂存一批文件（写类 op：宿主侧过审批，界面等回执）。 */
  const stage = (op: 'git-stage' | 'git-unstage', files: string[], tip: string): void => {
    void channel
      // 写类 op 在宿主侧挂着审批卡，卡能等 5 分钟：默认那 30 秒会在用户还在读卡时
      // 先把这次调用报成「宿主超时」（见 HUMAN_WAIT_TIMEOUT_MS）。
      .invoke('dock', [op, { files }], { timeoutMs: HUMAN_WAIT_TIMEOUT_MS })
      .then(() => {
        toastOk(tip)
        refresh()
        // 暂存状态变了，刚展开的 diff 已经过期，收掉它免得误导。
        setExpanded(null)
      })
      .catch((cause: unknown) => toastErr(`${op === 'git-stage' ? '暂存' : '取消暂存'}失败：${cause instanceof Error ? cause.message : String(cause)}`))
  }

  /**
   * 提交（写类 op：过审批）。`paths` 是对话框勾选的未暂存文件——宿主先暂存它们再提交，
   * 两步同一张审批卡。提交完清草稿、刷新状态与历史、收起过期 diff。返回 promise 供对话框等回执。
   */
  const commit = (message: string, paths: readonly string[]): Promise<void> => {
    const text = message.trim()
    if (text === '' || committing) return Promise.resolve()
    setCommitting(true)
    const payload: Record<string, unknown> = { message: text }
    if (paths.length > 0) payload['paths'] = [...paths]
    return channel
      .invoke<{ output: string }>('dock', ['git-commit', payload], { timeoutMs: HUMAN_WAIT_TIMEOUT_MS })
      .then(() => {
        toastOk('已提交')
        setCommitOpen(false)
        refresh()
        setExpanded(null)
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
          data-tip="查看全部改动"
          onClick={() => {
            toggleDiff('all', null)
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
        id="staged"
        title={`已暂存（${String(status.staged.length)}）`}
        files={status.staged}
        stats={status.stagedStats}
        expanded={expanded}
        diffData={diffData}
        onShowDiff={(file) => toggleDiff('staged', file)}
        onStage={(files) => stage('git-unstage', files, '已取消暂存')}
        stageTip="取消暂存"
      />
      <GitGroup
        id="unstaged"
        title={`未暂存（${String(status.unstaged.length)}）`}
        files={status.unstaged}
        stats={status.unstagedStats}
        expanded={expanded}
        diffData={diffData}
        onShowDiff={(file) => toggleDiff('unstaged', file)}
        onStage={(files) => stage('git-stage', files, '已暂存')}
        stageTip="暂存"
      />
      <GitGroup
        id="untracked"
        title={`未跟踪（${String(status.untracked.length)}）`}
        files={status.untracked}
        stats={status.untrackedStats}
        expanded={expanded}
        diffData={diffData}
        onShowDiff={(file) => toggleDiff('untracked', file)}
        bare
      />
      {/* 提交区：打开提交对话框（列出将提交的文件 = 已暂存 + 可选未暂存，走写类 op 的审批）。 */}
      <div className="git-commit">
        <span className="git-commit-hint">
          {status.staged.length === 0 ? '尚无已暂存的改动' : `已暂存 ${String(status.staged.length)} 个文件`}
        </span>
        <button
          type="button"
          className="btn-primary"
          disabled={committing || (status.staged.length === 0 && status.unstaged.length === 0)}
          onClick={() => setCommitOpen(true)}
        >
          提交…
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
      {/* 「全部改动」的 diff 落在面板底部；单文件的 diff 就地展开在各自分组里。 */}
      {expanded !== null && expanded.file === null ? (
        <GitDiffView
          title="全部未提交改动"
          all
          diff={diffData}
          onClose={() => setExpanded(null)}
        />
      ) : null}
      {commitOpen ? (
        <CommitDialog
          staged={status.staged}
          unstaged={status.unstaged}
          stagedStats={status.stagedStats}
          unstagedStats={status.unstagedStats}
          busy={committing}
          onClose={() => setCommitOpen(false)}
          onSubmit={commit}
        />
      ) : null}
    </div>
  )
}

/** 一组文件行：可点的就近展开该文件的 diff（未跟踪的也点得开——宿主按内容合成）；
    行尾带 +N/−N；给了 onStage 时行尾再带一颗暂存/取消暂存钮（写类 op，走宿主审批）。 */
function GitGroup(props: {
  id: string
  title: string
  files: readonly string[]
  stats?: Record<string, GitFileStat>
  expanded: Expanded | null
  diffData: DiffData
  onShowDiff?: (file: string) => void
  /** 行尾的暂存/取消暂存动作（未给就不画这颗钮）。 */
  onStage?: (files: string[]) => void
  /** 那颗钮的提示词（「暂存」/「取消暂存」）。 */
  stageTip?: string
  /** files 给的是裸路径（未跟踪组）——别再剥状态码前缀。 */
  bare?: boolean
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
          const path = props.bare === true ? file : fileOf(file)
          const stat = props.stats?.[path]
          const isOpen = props.expanded !== null && props.expanded.group === props.id && props.expanded.file === path
          return (
            <div className="git-file-block" key={file}>
              <div className="git-file" data-expanded={isOpen || undefined}>
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
                {stat === undefined ? null : (
                  <span className="git-file-counts">
                    <span className="changes-added">{`+${String(stat.added)}`}</span>
                    <span className="changes-removed">{`−${String(stat.removed)}`}</span>
                  </span>
                )}
                {props.onStage === undefined ? null : (
                  <button
                    type="button"
                    className="icon-btn"
                    data-tip={props.stageTip}
                    aria-label={`${String(props.stageTip)} ${path}`}
                    onClick={() => props.onStage?.([path])}
                  >
                    {props.stageTip === '暂存' ? '+' : '−'}
                  </button>
                )}
              </div>
              {isOpen ? (
                <GitDiffView
                  title={path}
                  all={false}
                  inline
                  diff={props.diffData}
                  onClose={() => props.onShowDiff?.(path)}
                />
              ) : null}
            </div>
          )
        })}
    </div>
  )
}

/** 提交对话框：列出将提交的文件 = 已暂存的（恒选中）+ 可勾选的未暂存；填信息后提交。
    写类 op 的审批由宿主负责（提交那一下弹同一套审批卡）。 */
function CommitDialog(props: {
  staged: readonly string[]
  unstaged: readonly string[]
  stagedStats?: Record<string, GitFileStat>
  unstagedStats?: Record<string, GitFileStat>
  busy: boolean
  onClose: () => void
  onSubmit: (message: string, paths: readonly string[]) => Promise<void>
}): ReactNode {
  const [message, setMessage] = useState('')
  const [includeUnstaged, setIncludeUnstaged] = useState(false)
  const [selected, setSelected] = useState<readonly string[]>([])
  const unstagedPaths = props.unstaged.map((entry) => fileOf(entry))

  const toggleUnstagedAll = (next: boolean): void => {
    setIncludeUnstaged(next)
    setSelected(next ? unstagedPaths : [])
  }
  const toggleOne = (path: string): void => {
    setSelected((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
    )
  }

  const canSubmit = message.trim() !== '' && (props.staged.length > 0 || selected.length > 0) && !props.busy
  const submit = (): void => {
    if (!canSubmit) return
    void props.onSubmit(message, selected)
  }

  return (
    <div className="git-dialog-backdrop" role="presentation" onClick={props.onClose}>
      <div
        className="git-dialog"
        role="dialog"
        aria-label="提交"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="git-dialog-head">提交</div>
        <div className="git-dialog-files">
          <label className="git-dialog-include">
            <input
              type="checkbox"
              checked={includeUnstaged}
              disabled={props.unstaged.length === 0}
              onChange={(event) => toggleUnstagedAll(event.target.checked)}
            />
            包含未暂存（{String(props.unstaged.length)}）
          </label>
          {props.staged.map((file) => {
            const path = fileOf(file)
            const stat = props.stagedStats?.[path]
            return (
              <div className="git-dialog-file" key={`staged:${file}`}>
                <input type="checkbox" checked disabled readOnly aria-label={`将提交 ${path}`} />
                <span className="git-dialog-file-name" data-tip={file}>
                  {file}
                </span>
                {stat === undefined ? null : (
                  <span className="git-file-counts">
                    <span className="changes-added">{`+${String(stat.added)}`}</span>
                    <span className="changes-removed">{`−${String(stat.removed)}`}</span>
                  </span>
                )}
              </div>
            )
          })}
          {props.unstaged.map((file) => {
            const path = fileOf(file)
            const stat = props.unstagedStats?.[path]
            return (
              <div className="git-dialog-file" key={`unstaged:${file}`}>
                <input
                  type="checkbox"
                  checked={selected.includes(path)}
                  onChange={() => toggleOne(path)}
                  aria-label={`包含 ${path}`}
                />
                <span className="git-dialog-file-name" data-tip={file}>
                  {file}
                </span>
                {stat === undefined ? null : (
                  <span className="git-file-counts">
                    <span className="changes-added">{`+${String(stat.added)}`}</span>
                    <span className="changes-removed">{`−${String(stat.removed)}`}</span>
                  </span>
                )}
              </div>
            )
          })}
          {props.staged.length === 0 && props.unstaged.length === 0 ? (
            <div className="trace-empty">没有可提交的改动。</div>
          ) : null}
        </div>
        <textarea
          className="git-dialog-message"
          rows={3}
          placeholder="遵循 feat:/fix:/chore: 规范"
          value={message}
          aria-label="提交信息"
          onChange={(event) => setMessage(event.target.value)}
        />
        <div className="git-dialog-foot">
          <button type="button" className="icon-btn" onClick={props.onClose} disabled={props.busy}>
            取消
          </button>
          <button type="button" className="btn-primary" disabled={!canSubmit} onClick={submit}>
            {props.busy ? '提交中…' : '提交'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** diff 视图：单文件一段、全量（all）按 `diff --git` 切成多段；`inline` 时挂在文件行下方。
    宿主回的 `note` 是「这一段合成不出来」的说明，单独一行显示，不和 diff 正文混在一起。 */
function GitDiffView(props: {
  title: string
  all: boolean
  diff: DiffData
  onClose: () => void
  inline?: boolean
}): ReactNode {
  const sections: UnifiedFileDiff[] = props.diff.loading
    ? []
    : props.all
      ? splitUnifiedDiffByFile(props.diff.text)
      : (() => {
          // 单文件：全部 hunk 归一段
          const hunks = parseUnifiedDiff(props.diff.text)
          const added = hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.kind === 'add').length, 0)
          const removed = hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.kind === 'remove').length, 0)
          return hunks.length === 0 ? [] : [{ path: props.title, added, removed, hunks }]
        })()
  return (
    <div className={`git-diff-view${props.inline === true ? ' git-diff-inline' : ''}`}>
      <div className="git-diff-head">
        <span className="git-diff-title">{props.title}</span>
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
      ) : (
        <>
          {props.diff.note === '' ? null : <div className="trace-empty">{props.diff.note}</div>}
          {sections.length === 0 ? (
            props.diff.note === '' ? <div className="trace-empty">没有可显示的改动。</div> : null
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
        </>
      )}
    </div>
  )
}
