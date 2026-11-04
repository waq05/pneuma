/**
 * 轨迹页的检查器：点开一条记录后从右侧滑出的详情面板（对照 dsh 的检查器）。
 *
 * 这是旧桌面渲染层 `TraceInspector.tsx` 的同构移植。分区按需求的顺序来：
 * 输入 → 输出 → 思考全文 → 计时 → 用量。每一步的口径都是「有真值才画数，缺就写未记录」
 * ——尤其计时：`startedAt` / `durationMs` 老会话与 running 都没有，这里显示「未记录」，
 * 不拿条目的 `ts` 冒充发起时刻（`ts` 是最后写入时刻）。
 *
 * 用户消息条目给的是附件区（`entry.images` 缩略图网格）：缩略图复用对话页现成的
 * `.entry-user-images` 图片通道，点开进放大浮层。
 *
 * 关闭方式：右上角 × 与点遮罩（遮罩在 TraceView 里，跟面板同层），Esc 也行。
 *
 * @module dsc-ui-shell/plugins/trace/inspector
 */
import { useEffect, useState, type ReactNode } from 'react'
import { IconClose, IconCopy, createT, toastErr, toastOk, type TranscriptEntry } from '@dsc/ui'
// 时刻/用量口径从平台种子（`@dsc/ui-primitives`）取：与壳内部同一份实现，不再内联（E6）。
import { formatClock, formatTokens, useDialogFocus } from '@dsc/ui-primitives'
import { KIND_LABEL, entryUsage, formatClockSeconds, formatTraceDuration, prettyMaybeJson } from './trace-format'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
// 构建时 JSON 直接内联进 `client.js`，运行期不需要宿主下发文件。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

export function TraceInspector(props: {
  entry: TranscriptEntry
  /** 这一条属于第几轮（1 基显示用）；开场步骤与压缩摘要没有轮次，是 null。 */
  round: number | null
  /**
   * 这条条目的 usage 是不是本轮的整轮真值（轮内最后一条带 usage 的条目）。
   * 不是真值也不编：分区里说明「这是累计到这条为止的值」，避免把中间值读成整轮量。
   */
  usageIsRoundTotal: boolean
  onClose: () => void
}): ReactNode {
  const { entry } = props
  const [zoom, setZoom] = useState<string | null>(null)

  // Esc 与 × 同一条退路：键盘用户不该被迫去点右上角。焦点交给基元管：
  // 打开移进检查器、Tab 在里面循环、关掉还给刚才点的那条记录。
  const dialog = useDialogFocus(true, () => {
    setZoom(null)
    props.onClose()
  })

  const usage = entryUsage(entry)
  const usageTotal = usage === null ? null : usage.inputTokens + usage.outputTokens

  const title =
    entry.kind === 'tool'
      ? props.round === null
        ? entry.call.name
        : t('inspector.titleWithRound', { name: entry.call.name, n: props.round + 1 })
      : entry.kind === 'user' && props.round !== null
        ? t('round.title', { n: props.round + 1 })
        : entry.kind === 'plan'
          ? entry.plan.title
          : ''

  return (
    <aside
      className="trace-inspector"
      data-trace-inspector={String(entry.id)}
      data-kind={entry.kind}
      role="dialog"
      aria-modal="true"
      aria-label={t('inspector.aria')}
      ref={dialog.ref}
    >
      <div className="ti-head">
        <span className="ti-kind">{entry.kind === 'text' ? t('kind.text') : KIND_LABEL[entry.kind]}</span>
        {title !== '' && <span className="ti-title">{title}</span>}
        <button
          type="button"
          className="ti-close"
          data-trace-inspector-close="1"
          data-tip={t('inspector.closeTip')}
          aria-label={t('inspector.close')}
          onClick={props.onClose}
        >
          <IconClose size={14} />
        </button>
      </div>

      <div className="ti-body">
        {entry.kind === 'user' && (
          <Section label={t('sec.message')}>
            <pre className="ti-code" data-trace-code="user-text">
              {entry.text}
            </pre>
          </Section>
        )}

        {entry.kind === 'user' && (
          <Section
            label={
              entry.images === undefined
                ? t('sec.attachments')
                : t('sec.attachmentsCount', { count: entry.images.length })
            }
          >
            {entry.images === undefined || entry.images.length === 0 ? (
              <div className="ti-empty">{t('sec.noAttachments')}</div>
            ) : (
              <Attachments images={entry.images} onZoom={setZoom} />
            )}
          </Section>
        )}

        {entry.kind === 'tool' && <ArgsSection argsText={entry.call.argsText} />}

        {entry.kind === 'tool' && (
          <Section label={t('sec.output')}>
            {entry.call.resultText === undefined || entry.call.resultText === '' ? (
              <div className="ti-empty">
                {entry.call.status === 'running'
                  ? t('out.running')
                  : entry.call.status === 'preparing'
                    ? t('out.preparing')
                    : t('out.empty')}
              </div>
            ) : (
              <Block text={entry.call.resultText} marker="result" />
            )}
          </Section>
        )}

        {entry.kind === 'thinking' && (
          <Section label={t('sec.thinking')}>
            <pre className="ti-code" data-trace-code="thinking">
              {entry.text}
            </pre>
          </Section>
        )}

        {entry.kind === 'subagent' && (
          <Section label={t('kind.subagent')}>
            <dl className="ti-facts">
              <Fact label={t('fact.task')} value={entry.sub.task} />
              <Fact label={t('fact.name')} value={entry.sub.name} />
              <Fact label={t('fact.state')} value={entry.sub.state} />
              {entry.sub.model !== undefined && <Fact label={t('fact.model')} value={entry.sub.model} />}
              <Fact label={t('fact.rounds')} value={String(entry.sub.rounds)} />
              <Fact label={t('fact.toolCalls')} value={String(entry.sub.toolCalls)} />
              {entry.sub.tokens !== undefined && <Fact label="Token" value={String(entry.sub.tokens)} />}
            </dl>
          </Section>
        )}

        {entry.kind === 'system' && (
          <Section label={t('sec.notice')}>
            <pre className="ti-code" data-trace-code="system">
              {entry.text}
            </pre>
          </Section>
        )}

        {entry.kind === 'plan' && (
          <Section label={t('sec.plan')}>
            <pre className="ti-code" data-trace-code="plan">
              {entry.plan.text}
            </pre>
          </Section>
        )}

        <Section label={t('sec.timing')}>
          <dl className="ti-facts">
            {entry.kind === 'tool' ? (
              <Fact
                label={t('fact.startedAt')}
                value={formatClockSeconds(entry.call.startedAt ?? null) ?? t('common.notRecorded')}
                title={t('fact.startedAtTip')}
              />
            ) : (
              <Fact
                label={t('fact.recordedAt')}
                value={formatClockSeconds(entry.ts === undefined ? null : entry.ts) ?? t('common.notRecorded')}
                title={t('fact.recordedAtTip')}
              />
            )}
            <Fact
              label={t('fact.duration')}
              value={
                entry.kind === 'tool'
                  ? (formatTraceDuration(entry.call.durationMs ?? null) ?? t('common.notRecorded'))
                  : t('common.notRecorded')
              }
              title={t('fact.durationTip')}
            />
            {entry.kind === 'tool' && (
              <Fact
                label={t('fact.resultAt')}
                value={formatClock(entry.ts === undefined ? null : entry.ts) ?? t('common.notRecorded')}
                title={t('fact.resultAtTip')}
              />
            )}
          </dl>
        </Section>

        <Section label={t('sec.usage')}>
          {usage === null ? (
            <div className="ti-empty">{t('usage.missing')}</div>
          ) : (
            <dl className="ti-facts">
              <Fact label={t('sec.input')} value={`${formatTokens(usage.inputTokens)} tok`} />
              <Fact label={t('sec.output')} value={`${formatTokens(usage.outputTokens)} tok`} />
              <Fact
                label={t('fact.total')}
                value={`${formatTokens(usageTotal ?? 0)} tok`}
                title={props.usageIsRoundTotal ? t('fact.totalRoundTip') : t('fact.totalPartialTip')}
              />
            </dl>
          )}
        </Section>
      </div>

      {zoom !== null && (
        <div
          className="trace-lightbox"
          data-trace-lightbox="1"
          role="dialog"
          aria-modal="true"
          aria-label={t('lightbox.aria')}
          onClick={() => setZoom(null)}
        >
          <img src={zoom} alt={t('lightbox.alt')} />
          <button
            type="button"
            className="ti-close lightbox-close"
            data-tip={t('lightbox.close')}
            aria-label={t('lightbox.close')}
            onClick={(event) => {
              event.stopPropagation()
              setZoom(null)
            }}
          >
            <IconClose size={14} />
          </button>
        </div>
      )}
    </aside>
  )
}

/** 分区壳子：标题 + 内容，标题右侧可以挂工具条（复制 / 格式化）。 */
function Section({
  label,
  children,
  extra,
}: {
  label: string
  children: ReactNode
  extra?: ReactNode
}): ReactNode {
  return (
    <section className="ti-sec">
      <div className="ti-sec-head">
        <span className="ti-label">{label}</span>
        {extra}
      </div>
      {children}
    </section>
  )
}

/** 计时与用量的一行读数。 */
function Fact({ label, value, title }: { label: string; value: string; title?: string }): ReactNode {
  return (
    <div className="ti-fact" title={title} data-trace-fact={label}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

/**
 * 入参区：带「格式化」开关与「复制参数」。
 *
 * 格式化开关只在原文真的能解析成 JSON 时给出——半截 JSON（模型偶尔吐的那种）点了也不会有
 * 变化，给一个点了没反应的开关比不给更糟。
 */
function ArgsSection({ argsText }: { argsText: string }): ReactNode {
  const pretty = prettyMaybeJson(argsText)
  /** 能解析才默认美化；原样就是美化结果时开关初始为「原样」。 */
  const [formatted, setFormatted] = useState(pretty.formatted)
  const shown = formatted && pretty.formatted ? pretty.text : argsText

  const copy = (): void => {
    // 复制的是**原文**：JSON 美化过的那份带缩进，粘到别处反而多出空白。
    void navigator.clipboard.writeText(argsText).then(
      () => {
        toastOk(t('toast.copied'))
      },
      () => {
        toastErr(t('toast.copyFailed'))
      },
    )
  }

  return (
    <Section
      label={t('sec.input')}
      extra={
        <span className="ti-tools">
          {pretty.formatted && (
            <button
              type="button"
              className="ti-btn"
              data-trace-format-toggle="args"
              data-state={formatted ? 'pretty' : 'raw'}
              data-tip={t('args.formatTip')}
              onClick={() => {
                setFormatted((current) => !current)
              }}
            >
              {formatted ? t('args.raw') : t('args.format')}
            </button>
          )}
          <button
            type="button"
            className="ti-btn"
            data-trace-copy-args="1"
            data-tip={t('args.copy')}
            onClick={copy}
          >
            <IconCopy size={12} />
            {t('args.copy')}
          </button>
        </span>
      }
    >
      <Block text={shown} marker="args" formatted={formatted && pretty.formatted} />
    </Section>
  )
}

/** 原文块：父组件给什么画什么（格式化与否是 ArgsSection 的状态），等宽字体、可横向滚动。
 *  这里绝不能再自己美化一遍——那样「切回原文」会被悄悄格式化回去，开关就失效了。 */
function Block({
  text,
  marker,
  formatted = false,
}: {
  text: string
  marker: string
  formatted?: boolean
}): ReactNode {
  return (
    <pre className="ti-code" data-trace-code={marker} data-formatted={formatted ? '1' : '0'}>
      {text}
    </pre>
  )
}

/** 附件缩略图网格：图片通道复用对话页的 .entry-user-images（尺寸与圆角同款）。 */
function Attachments({
  images,
  onZoom,
}: {
  images: string[]
  onZoom: (url: string) => void
}): ReactNode {
  return (
    <div className="entry-user-images ti-shots" data-trace-attachments={String(images.length)}>
      {images.map((url, index) => (
        <button
          key={index}
          type="button"
          className="ti-shot"
          data-trace-shot={String(index)}
          data-tip={t('attach.openTip')}
          onClick={() => onZoom(url)}
        >
          <img src={url} alt={t('attach.alt', { n: index + 1 })} />
        </button>
      ))}
    </div>
  )
}
