/**
 * 文件面板的「变更」页签：git 状态三分组 + 每文件增删行数 + 「全部未提交改动」的合并 diff
 * + 暂存/取消暂存 + 提交对话框 + 提交历史。点一行文件在右侧栏开它的预览页签。
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
import {
  DiffRows,
  HUMAN_WAIT_TIMEOUT_MS,
  IconChevronDown,
  IconChevronRight,
  createT,
  setDockFileView,
  setDockPreview,
  toastErr,
  toastOk,
  useHostChannel,
  useHostSelector,
} from '@dsc/ui'
import {
  parseUnifiedDiff,
  readCwd,
  splitUnifiedDiffByFile,
  useDialogFocus,
  type UnifiedFileDiff,
} from '@dsc/ui-primitives'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
// 构建时 JSON 直接内联进 `client.js`，运行期不需要宿主下发文件。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

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
  /** 面板底部的「全部未提交改动」diff 是否展开。 */
  const [allDiffOpen, setAllDiffOpen] = useState(false)
  const [diffData, setDiffData] = useState<DiffData>({ loading: false, text: '', note: '' })
  /** 提交对话框的开合（里面的文件清单与信息草稿由对话框自己持有）。 */
  const [commitOpen, setCommitOpen] = useState(false)
  const [committing, setCommitting] = useState(false)
  /** 提交历史（面板第一次打开时读一次；提交/刷新后重读）。 */
  const [log, setLog] = useState<LogLine[] | null>(null)
  /** 预览页签按绝对路径登记（宿主 git 回的是 cwd 相对路径，fs-read 才接受相对）。 */
  const cwd = useHostSelector(readCwd) ?? ''

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
   * 展开/收起「全部未提交改动」的 diff（落在面板底部，不就地展开单个文件）。
   * 已开则收起；未开则开并拉一次 `git-diff`（payload 就是 `{}`，宿主给全量）。
   * 宿主回的 `note` 是「这一段合成不出来」的说明（未跟踪的二进制 / 过大 / 目录条目），
   * 单独一行显示，不和 diff 正文混在一起。
   */
  const toggleAllDiff = (): void => {
    if (allDiffOpen) {
      setAllDiffOpen(false)
      return
    }
    setAllDiffOpen(true)
    setDiffData({ loading: true, text: '', note: '' })
    void channel
      .invoke<{ diff: string; note?: string }>('dock', ['git-diff', {}])
      .then((data) => {
        setDiffData({ loading: false, text: String(data?.diff ?? ''), note: String(data?.note ?? '') })
      })
      .catch((cause: unknown) => {
        setAllDiffOpen(false)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  /** git 的 cwd 相对路径 → 预览页签登记的绝对路径（页签去重与 fs-read 都认绝对路径最稳）。 */
  const absoluteOf = (relative: string): string => {
    if (cwd === '') return relative
    return `${cwd.replace(/[\\/]+$/, '')}/${relative.replace(/^[\\/]+/, '')}`
  }

  /**
   * 点一行文件：在右侧栏开这个文件的**预览页签**（渲染好的 markdown / 代码 / 表格），
   * 并把这一份改动挂成页签里的「改动」视图。
   *
   * 宿主合成不出 diff 的情形（二进制 / 超过上限 / 未跟踪目录整条）只开预览页签，
   * 那句说明留在面板 notice 上——不给出一个空白的 diff。
   */
  const openFileView = (group: string, relative: string): void => {
    const payload = group === 'staged' ? { file: relative, staged: true } : { file: relative }
    void channel
      .invoke<{ diff: string; note?: string }>('dock', ['git-diff', payload])
      .then((data) => {
        const note = String(data?.note ?? '')
        const path = absoluteOf(relative)
        if (note !== '') setError(note)
        const hunks = parseUnifiedDiff(String(data?.diff ?? ''))
        if (hunks.length === 0) {
          setDockPreview({ path })
          return
        }
        let added = 0
        let removed = 0
        for (const hunk of hunks) {
          for (const line of hunk.lines) {
            if (line.kind === 'add') added += 1
            else if (line.kind === 'remove') removed += 1
          }
        }
        setDockFileView({
          path,
          patch: { path, added, removed, hunks, status: group === 'untracked' ? 'added' : 'modified' },
        })
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
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
        setAllDiffOpen(false)
      })
      .catch((cause: unknown) =>
        toastErr(
          t('files.toast.opFailed', {
            action: op === 'git-stage' ? t('files.action.stage') : t('files.action.unstage'),
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        ),
      )
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
        toastOk(t('files.commit.done'))
        setCommitOpen(false)
        refresh()
        setAllDiffOpen(false)
      })
      .catch((cause: unknown) => toastErr(t('files.commit.failed', { message: cause instanceof Error ? cause.message : String(cause) })))
      .finally(() => setCommitting(false))
  }

  if (status === null) {
    return (
      <div className="git-pane">
        {error === '' ? (
          <div className="trace-empty">{t('files.state.loading')}</div>
        ) : (
          <>
            <div className="notice">{error}</div>
            <div className="trace-empty">{t('files.git.notRepo')}</div>
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
        <span className="git-count">{t('files.git.changes', { count: total })}</span>
        <button
          type="button"
          className="icon-btn git-diff-all"
          data-tip={t('files.git.allDiffTip')}
          onClick={() => {
            toggleAllDiff()
          }}
        >
          {t('files.git.allDiff')}
        </button>
        <button
          type="button"
          className="icon-btn"
          data-tip={t('files.git.refresh')}
          aria-label={t('files.git.refresh')}
          onClick={refresh}
        >
          ↻
        </button>
      </div>
      {error === '' ? null : <div className="notice">{error}</div>}
      <GitGroup
        id="staged"
        title={t('files.group.staged', { count: status.staged.length })}
        files={status.staged}
        stats={status.stagedStats}
        onOpenFile={(file) => openFileView('staged', file)}
        onStage={(files) => stage('git-unstage', files, t('files.toast.unstaged'))}
        stageTip={t('files.action.unstage')}
      />
      <GitGroup
        id="unstaged"
        title={t('files.group.unstaged', { count: status.unstaged.length })}
        files={status.unstaged}
        stats={status.unstagedStats}
        onOpenFile={(file) => openFileView('unstaged', file)}
        onStage={(files) => stage('git-stage', files, t('files.toast.staged'))}
        stageTip={t('files.action.stage')}
      />
      <GitGroup
        id="untracked"
        title={t('files.group.untracked', { count: status.untracked.length })}
        files={status.untracked}
        stats={status.untrackedStats}
        onOpenFile={(file) => openFileView('untracked', file)}
        bare
      />
      {/* 提交区：打开提交对话框（列出将提交的文件 = 已暂存 + 可选未暂存，走写类 op 的审批）。 */}
      <div className="git-commit">
        <span className="git-commit-hint">
          {status.staged.length === 0 ? t('files.commit.none') : t('files.commit.stagedCount', { count: status.staged.length })}
        </span>
        <button
          type="button"
          className="btn-primary"
          disabled={committing || (status.staged.length === 0 && status.unstaged.length === 0)}
          onClick={() => setCommitOpen(true)}
        >
          {t('files.commit.open')}
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
      {/* 「全部未提交改动」的 diff 落在面板底部；点文件是在右侧栏开预览页签，不就地展开。 */}
      {allDiffOpen ? <GitDiffView diff={diffData} onClose={() => setAllDiffOpen(false)} /> : null}
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

/** 一组文件行：点一行文件在右侧栏开它的预览页签（未跟踪的也点得开——宿主按内容合成）；
    行尾带 +N/−N；给了 onStage 时行尾再带一颗暂存/取消暂存钮（写类 op，走宿主审批）。 */
function GitGroup(props: {
  id: string
  title: string
  files: readonly string[]
  stats?: Record<string, GitFileStat>
  /** 点一行文件：在右侧栏开它的预览页签（渲染好的文件 + 可切的「改动」视图）。 */
  onOpenFile?: (file: string) => void
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
          return (
            <div className="git-file-block" key={file}>
              <div className="git-file">
                <button
                  type="button"
                  className="git-file-name"
                  data-tip={file}
                  disabled={props.onOpenFile === undefined}
                  onClick={() => {
                    props.onOpenFile?.(path)
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
                    {props.stageTip === t('files.action.stage') ? '+' : '−'}
                  </button>
                )}
              </div>
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
  // 条件渲染（打开才挂载），所以这里常 true：Esc 关、Tab 圈在弹层里、关掉把焦点还给来源。
  const dialog = useDialogFocus(true, props.onClose)
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
        aria-modal="true"
        aria-label={t('files.commit.title')}
        ref={dialog.ref}
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="git-dialog-head">{t('files.commit.title')}</div>
        <div className="git-dialog-files">
          <label className="git-dialog-include">
            <input
              type="checkbox"
              checked={includeUnstaged}
              disabled={props.unstaged.length === 0}
              onChange={(event) => toggleUnstagedAll(event.target.checked)}
            />
            {t('files.commit.include', { count: props.unstaged.length })}
          </label>
          {props.staged.map((file) => {
            const path = fileOf(file)
            const stat = props.stagedStats?.[path]
            return (
              <div className="git-dialog-file" key={`staged:${file}`}>
                <input type="checkbox" checked disabled readOnly aria-label={t('files.commit.fileAria', { path })} />
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
                  aria-label={t('files.commit.includeAria', { path })}
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
            <div className="trace-empty">{t('files.commit.nothing')}</div>
          ) : null}
        </div>
        <textarea
          className="git-dialog-message"
          data-autofocus
          rows={3}
          placeholder={t('files.commit.placeholder')}
          value={message}
          aria-label={t('files.commit.messageLabel')}
          onChange={(event) => setMessage(event.target.value)}
        />
        <div className="git-dialog-foot">
          <button type="button" className="icon-btn" onClick={props.onClose} disabled={props.busy}>
            {t('files.common.cancel')}
          </button>
          <button type="button" className="btn-primary" disabled={!canSubmit} onClick={submit}>
            {props.busy ? t('files.commit.busy') : t('files.commit.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 「全部未提交改动」的 diff 视图：按 `diff --git` 切成多段，每段一份路径 + 增删行数 + hunk。
    宿主回的 `note` 是「这一段合成不出来」的说明，单独一行显示，不和 diff 正文混在一起。 */
function GitDiffView(props: { diff: DiffData; onClose: () => void }): ReactNode {
  const sections: UnifiedFileDiff[] = props.diff.loading ? [] : splitUnifiedDiffByFile(props.diff.text)
  return (
    <div className="git-diff-view">
      <div className="git-diff-head">
        <span className="git-diff-title">{t('files.diff.allTitle')}</span>
        <button
          type="button"
          className="icon-btn"
          data-tip={t('files.diff.closeTip')}
          aria-label={t('files.diff.close')}
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
      {props.diff.loading ? (
        <div className="trace-empty">{t('files.state.loading')}</div>
      ) : (
        <>
          {props.diff.note === '' ? null : <div className="trace-empty">{props.diff.note}</div>}
          {sections.length === 0 ? (
            props.diff.note === '' ? <div className="trace-empty">{t('files.diff.empty')}</div> : null
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
