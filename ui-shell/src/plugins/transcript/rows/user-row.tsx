/**
 * 用户消息那一行：气泡 + 贴图 + 附件条 + 悬停浮出的「编辑并重发」，以及只读出口的同一气泡。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/rows/user-row
 */
import { useContext, useState, type ReactNode } from 'react'
import { FileIcon, IconEdit, type TranscriptEntry, type UserFileAttachment } from '@dsc/ui'
import { FlowActionsContext } from '../shared'
import { teammateReportLabel } from '../rounds'

/**
 * 用户消息的附件条（贴图条之后、正文之前）：视频能就地播放，其余文件给一张可点开的文件卡。
 *
 * 卡片只是一层结构+类名，排版全在 `styles.css` 的 `.entry-user-files` / `.user-file-card` 里；
 * 视频没有 `url`（宿主只给了路径句柄）时降级成普通文件卡，不留一个播不了的空播放器。
 *
 * @param props - `files` 是宿主给的用户附件清单，缺省/空数组时整块不渲染。
 * @returns 附件条，或 null。
 */
export function UserFileCards({ files }: { files?: readonly UserFileAttachment[] }): ReactNode {
  if (files === undefined || files.length === 0) return null
  return (
    <div className="entry-user-files">
      {files.map((file) =>
        file.kind === 'video' && file.url !== undefined && file.url !== '' ? (
          <figure key={file.sha} className="user-file-card user-video-card" data-file-kind="video">
            <video src={file.url} controls playsInline preload="metadata" aria-label={file.name} />
            <figcaption className="user-file-name" title={file.path}>
              {file.name}
            </figcaption>
            <span className="user-file-meta">{formatBytes(file.bytes)}</span>
          </figure>
        ) : (
          <FileAttachmentCard key={file.sha} file={file} />
        ),
      )}
    </div>
  )
}

/**
 * 一个非视频附件的卡片：文档图标 + 文件名 + 体积。有 `url` 时整卡是下载链接，没有就是死卡片。
 *
 * @param props - `file` 是宿主给的用户附件。
 * @returns 文件卡（`<a>` 或 `<div>`）。
 */
function FileAttachmentCard({ file }: { file: UserFileAttachment }): ReactNode {
  const body = (
    <>
      <FileIcon name={file.name} size={16} />
      <span className="user-file-name" title={file.path}>
        {file.name}
      </span>
      <span className="user-file-meta">{formatBytes(file.bytes)}</span>
    </>
  )
  if (file.url === undefined || file.url === '') {
    return (
      <div className="user-file-card" data-file-kind="file">
        {body}
      </div>
    )
  }
  return (
    <a className="user-file-card" data-file-kind="file" href={file.url} target="_blank" rel="noreferrer" title={file.path}>
      {body}
    </a>
  )
}

/** 用户消息：气泡 + 贴图条 + hover 浮出的「编辑」钮（编辑重发 = 分叉新会话重发，原会话保留）。 */
export function UserRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'user' }> }): ReactNode {
  const actions = useContext(FlowActionsContext)
  // 编辑中的草稿（null = 没在编辑）。Enter 提交 / Shift+Enter 换行 / Esc 取消。
  const [draft, setDraft] = useState<string | null>(null)
  // 运行时投递进来的消息（队友汇报）不拿它当人打的字渲染，也不压成居中的 system 断句：
  // 按 dsh 的 turn-trigger 画成一行「触发行」——一句话说清是谁的汇报（队友名 / 状态都从
  // body 头里解出来，见 rounds.ts 的 teammateReportLabel）。`data-internal="1"` 属性留着
  // （样式与探针认它）。完整汇报仍挂在 title 上，需要时悬停可看。
  if (entry.internal === true) {
    return (
      <div className="entry-system" data-internal="1" title={entry.text}>
        {teammateReportLabel(entry.text)}
      </div>
    )
  }
  return (
    <div className="user-turn">
      <div className={`entry-user${draft === null ? '' : ' editing'}`}>
        {entry.images === undefined || entry.images.length === 0 ? null : (
          <div className="entry-user-images">
            {entry.images.map((url, index) => (
              <a key={index} href={url} target="_blank" rel="noreferrer" data-tip="点开看原图">
                <img src={url} alt={`第 ${String(index + 1)} 张贴图`} />
              </a>
            ))}
          </div>
        )}
        <UserFileCards files={entry.files} />
        {draft === null ? (
          entry.text
        ) : (
          <div className="user-edit">
            <textarea
              className="user-edit-box"
              value={draft}
              autoFocus
              rows={Math.min(10, Math.max(2, draft.split('\n').length))}
              aria-label="编辑这条消息"
              onChange={(event) => {
                setDraft(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setDraft(null)
                  return
                }
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
                event.preventDefault()
                const text = draft.trim()
                if (text === '') return
                setDraft(null)
                actions.editRefork(entry, text)
              }}
            />
            <p className="user-edit-note">Enter 重发（分叉出新会话，原会话保留） · Shift+Enter 换行 · Esc 取消</p>
            <div className="user-edit-actions">
              <button
                type="button"
                className="dsc-btn"
                data-variant="ghost"
                data-size="xs"
                onClick={() => {
                  setDraft(null)
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="dsc-btn"
                data-variant="primary"
                data-size="xs"
                disabled={draft.trim() === ''}
                onClick={() => {
                  const text = draft.trim()
                  if (text === '') return
                  setDraft(null)
                  actions.editRefork(entry, text)
                }}
              >
                重发
              </button>
            </div>
          </div>
        )}
      </div>
      {draft === null ? (
        <div className="user-actions">
          <button
            type="button"
            className="user-act"
            title={actions.busy ? '这一轮还在跑，先等它结束或打断再编辑' : '编辑这条消息并重发（会分叉出新会话，原会话保留）'}
            aria-label="编辑并重发这条消息"
            disabled={actions.busy}
            onClick={() => {
              setDraft(entry.text)
            }}
          >
            <IconEdit size={15} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** 首行：直到第一个换行为止（旧版 ThinkingBlock.tsx:42-45）。 */

/** 只读用户消息：UserRow 的同款气泡，去掉 hover 浮出的「编辑并重发」。 */
export function ReadonlyUserRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'user' }> }): ReactNode {
  // 运行时投递进来的消息（队友汇报）整条交给 UserRow：它对这个 kind 提前 return「触发行」，
  // 本来就不带编辑钮，所以只读出口可以原样复用——文案只有一处（rounds.ts 的
  // teammateReportLabel），不会出现主会话与右栏对同一件事说两句话。
  if (entry.internal === true) return <UserRow entry={entry} />
  return (
    <div className="user-turn">
      <div className="entry-user">
        {entry.images === undefined || entry.images.length === 0 ? null : (
          <div className="entry-user-images">
            {entry.images.map((url, index) => (
              <a key={index} href={url} target="_blank" rel="noreferrer" data-tip="点开看原图">
                <img src={url} alt={`第 ${String(index + 1)} 张贴图`} />
              </a>
            ))}
          </div>
        )}
        <UserFileCards files={entry.files} />
        {entry.text}
      </div>
    </div>
  )
}

/**
 * 附件体积的人话读法（1024 进制）：不到 1KB 给整数 B，不到 1MB 给一位小数 KB，再往上一位小数 MB。
 *
 * @param bytes - 字节数。
 * @returns 形如 `512 B` / `3.4 KB` / `1.2 MB`；数字不合法时给一个破折号，不显示 NaN。
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${String(Math.round(bytes))} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
