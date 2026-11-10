/**
 * 用户消息那一行：气泡 + 贴图 + 附件条 + 悬停浮出的「编辑并重发」，以及只读出口的同一气泡。
 * 贴图点一下开浮层看大图（与输入框待发贴图同一个 `ImageLightbox`），不再是另开窗口的链接。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/rows/user-row
 */
import { useContext, useState, type ReactNode } from 'react'
import { FileIcon, IconEdit, createT, setDockPreview, type TranscriptEntry, type UserFileAttachment } from '@dsc/ui'
// 体积读数与文件树、预览面板、输入区附件同一份实现（壳里唯一一份）。
import { formatBytes, ImageLightbox, parseReviewFindings, ReviewFindingsCard } from '@dsc/ui-primitives'
import { FlowActionsContext, ShellCwdContext } from '../shared'
import type { CompactionMark } from './compaction-row'
import { TriggerRow } from './trigger-row'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../../locale/ui.zh.json'
import en from '../../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

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

/**
 * 这条用户消息上带的压缩标记：气泡**上方**一行 16px 的小字（「历史已压缩（第 N 次）」）。
 *
 * 什么时候会有：重放出来的压缩摘要本身就是一条 `role: 'user'` 的消息（宿主 compact 造的），
 * 适配器靠正文前缀认出它、在原 kind 上打 `compaction` 标记（见 `contract` 的 CompactionMark）。
 * 所以会话流里「压缩落点」有两种画法：实时的 system 通知走 `CompactionRow`（一条分隔线，
 * 见 render.tsx），重放的摘要走这里——摘要正文本身还要当气泡看，只能在它上面加一枚小标。
 *
 * 为什么是气泡外面的一行、而不是塞进气泡：气泡是右对齐的软填充块（`max-width: 78%`），
 * 往里加一行字会把它撑宽、正文跟着重排。放在 `.user-turn` 的第一行（这一层是
 * `align-items: flex-end` 的纵列）右对齐、高度固定 16px，气泡的尺寸与对齐一个像素都不动。
 *
 * @param props.mark - 压缩标记（次数）
 * @returns 一行小字
 */
function UserCompactionMark({ mark }: { mark: CompactionMark }): ReactNode {
  // 与 `CompactionRow` 同一条理由：`data-tip` 的气泡层已下线，说明要靠原生 `title` 才看得见。
  const tip = t('transcript.compaction.tip')
  return (
    <span
      className="entry-user-compaction"
      data-compaction-count={mark.count}
      data-tip={tip}
      title={tip}
    >
      {t('transcript.compaction.mark', { count: mark.count })}
    </span>
  )
}

/** 用户消息：气泡 + 贴图条 + hover 浮出的「编辑」钮（编辑重发 = 在当前会话里截断到这条再重发）。 */
export function UserRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'user' }> }): ReactNode {
  const actions = useContext(FlowActionsContext)
  const cwd = useContext(ShellCwdContext)
  // 编辑中的草稿（null = 没在编辑）。Enter 提交 / Shift+Enter 换行 / Esc 取消。
  const [draft, setDraft] = useState<string | null>(null)
  // 正在放大查看的那张贴图（null = 没开浮层）。两处气泡各存一份，谁点开都不影响对方。
  const [zoom, setZoom] = useState<string | null>(null)
  // 审查队友的 findings：宿主也当成一条 role:'user' 的消息投进来（模型要看），但它不是人打的字，
  // 解析成卡片——徽标、位置、说明、建议按条摆开，比整段 `<review-findings …>` 标记文本好读。
  // 位置点开走预览页签：`setDockPreview` 这一侧没有行号参数，先只打开文件（行号仍写在按钮上）。
  const findings = parseReviewFindings(entry.text)
  if (findings !== null) {
    return <ReviewFindingsCard doc={findings} cwd={cwd} onOpenLocation={(path) => setDockPreview({ path })} />
  }
  // 运行时投递进来的消息（队友汇报、后台作业完成通知……）不拿它当人打的字渲染，
  // 也不压成居中的 system 断句：按 dsh 的 TurnTriggerNodeView 画成一张可展开的小卡
  // （见 trigger-row.tsx）——头行说清「刚刚发生了什么」，点开才看模型收到的原文。
  // 原来的灰行（`.entry-system[data-internal]`）说得出一句话、没有时间、也点不开，2026-11-08 换掉。
  if (entry.internal === true) return <TriggerRow entry={entry} />
  return (
    <>
      <div className="user-turn">
        {entry.compaction === undefined ? null : <UserCompactionMark mark={entry.compaction} />}
        <div className={`entry-user${draft === null ? '' : ' editing'}`}>
          {entry.images === undefined || entry.images.length === 0 ? null : (
            <div className="entry-user-images">
              {entry.images.map((url, index) => (
                <button
                  key={index}
                  type="button"
                  className="entry-shot"
                  data-tip={t('transcript.user.imageTip')}
                  aria-label={t('transcript.user.zoom', { index: index + 1 })}
                  onClick={() => {
                    setZoom(url)
                  }}
                >
                  <img src={url} alt={t('transcript.user.imageAlt', { index: index + 1 })} />
                </button>
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
                aria-label={t('transcript.user.editAria')}
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
                  actions.editAndResend(entry, text)
                }}
              />
              <p className="user-edit-note">{t('transcript.user.editNote')}</p>
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
                  {t('transcript.common.cancel')}
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
                    actions.editAndResend(entry, text)
                  }}
                >
                  {t('transcript.user.resend')}
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
              title={actions.busy ? t('transcript.user.editBusyTip') : t('transcript.user.editTip')}
              aria-label={t('transcript.user.editResendAria')}
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
      {zoom === null ? null : <ImageLightbox src={zoom} alt={t('transcript.user.lightboxAlt')} onClose={() => { setZoom(null) }} />}
    </>
  )
}

/** 首行：直到第一个换行为止（旧版 ThinkingBlock.tsx:42-45）。 */

/** 只读用户消息：UserRow 的同款气泡，去掉 hover 浮出的「编辑并重发」。 */
export function ReadonlyUserRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'user' }> }): ReactNode {
  const cwd = useContext(ShellCwdContext)
  // 正在放大查看的那张贴图（只读出口自己一份，与 UserRow 互不影响）。
  const [zoom, setZoom] = useState<string | null>(null)
  // 审查结论同样画成卡（右栏看队友记录时也是同一种展示，不退回标记文本）
  const findings = parseReviewFindings(entry.text)
  if (findings !== null) {
    return <ReviewFindingsCard doc={findings} cwd={cwd} onOpenLocation={(path) => setDockPreview({ path })} />
  }
  // 运行时投递进来的消息（队友汇报、后台作业通知……）整条交给 UserRow：它对这个 kind
  // 提前 return「触发行」，本来就不带编辑钮，所以只读出口可以原样复用——文案只有一处
  // （rounds.ts 的 internalLabel），不会出现主会话与右栏对同一件事说两句话。
  if (entry.internal === true) return <UserRow entry={entry} />
  return (
    <>
      <div className="user-turn">
        {entry.compaction === undefined ? null : <UserCompactionMark mark={entry.compaction} />}
        <div className="entry-user">
          {entry.images === undefined || entry.images.length === 0 ? null : (
            <div className="entry-user-images">
              {entry.images.map((url, index) => (
                <button
                  key={index}
                  type="button"
                  className="entry-shot"
                  data-tip={t('transcript.user.imageTip')}
                  aria-label={t('transcript.user.zoom', { index: index + 1 })}
                  onClick={() => {
                    setZoom(url)
                  }}
                >
                  <img src={url} alt={t('transcript.user.imageAlt', { index: index + 1 })} />
                </button>
              ))}
            </div>
          )}
          <UserFileCards files={entry.files} />
          {entry.text}
        </div>
      </div>
      {zoom === null ? null : <ImageLightbox src={zoom} alt={t('transcript.user.lightboxAlt')} onClose={() => { setZoom(null) }} />}
    </>
  )
}

