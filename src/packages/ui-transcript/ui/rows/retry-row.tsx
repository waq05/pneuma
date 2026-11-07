/**
 * 模型重试行（对照 dsh 的 ModelRetryItem，MessageItem.tsx:63-129）。
 *
 * 一行小字 + 可展开的两行明细：
 *   已重试模型请求（3/5） · 2s
 *     重试延迟：1847 毫秒
 *     失败原因：429: {"type":"server_error",...}
 *
 * 为什么要折叠而不是把失败原因摊在会话里：一次限流可能连着重试四五次，每条都把
 * 整段上游报文铺出来，会话流会被几十行 JSON 糊满，真正的内容反而被挤到屏幕外。
 * 收起时只说「第几次、还剩几次、等了多久」，要看原因点一下。
 *
 * 两种状态的判定不靠外部传参：退避是「写入时刻 + 等待时长」，此刻还没到点就是正在重试
 * （倒计时），到点就是已经重试过（等的是一个不动的数字）。刷新后从日志重放出来的条目
 * 一律是后一种——它描述的是过去发生的事。
 *
 * @module dsc-ui-shell/plugins/transcript/rows/retry-row
 */
import { useEffect, useState, type ReactNode } from 'react'
import { IconChevronDown, createT, type TranscriptEntry } from '@dsc/ui'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../../locale/ui.zh.json'
import en from '../../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 倒计时刷新间隔（毫秒）：250 毫秒足够让「还剩几秒」读起来是活的，又不至于每帧重排。 */
const COUNTDOWN_TICK_MS = 250

/** 模型重试行。 */
export function RetryRow({
  entry,
}: {
  entry: Extract<TranscriptEntry, { kind: 'model-retry' }>
}): ReactNode {
  // 退避的终点。窗口刷新过、重放出来的条目 ts 是写日志那一刻，deadline 早已过去，
  // 于是直接落在「已重试」——这正是我们要的：那一次等待确实已经结束了。
  const deadline = (entry.ts ?? 0) + entry.delayMs
  const [now, setNow] = useState(() => Date.now())
  const remaining = deadline - now
  const active = entry.ts !== undefined && remaining > 0
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, COUNTDOWN_TICK_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [active, deadline])
  // 正在重试时读倒计时（「还剩 1 秒」），已经重试过时读这次一共等了多久（「2s」）。
  const seconds = Math.max(0, Math.round((active ? remaining : entry.delayMs) / 1000))
  const label = active ? t('transcript.retry.active') : t('transcript.retry.started')
  return (
    <details className="retry-row" data-active={active ? '1' : undefined}>
      <summary className="retry-summary">
        <span
          className="retry-text"
          role="status"
          // 跑动中扫光（与思考行摘要、阶段组头同一套 CSS）：这一行是「现在就卡在这儿」的
          // 唯一线索，得有活着的迹象；收起态的旧记录不扫——它已经不动了。
          data-shimmer={active ? label : undefined}
        >
          {t('transcript.retry.status', {
            label,
            retry: entry.attempt,
            maximum: entry.maxRetries,
            seconds,
          })}
        </span>
        <span className="retry-chevron" aria-hidden="true">
          <IconChevronDown size={12} />
        </span>
      </summary>
      <div className="retry-details">
        <div className="retry-detail">
          <span className="retry-detail-label">{t('transcript.retry.delay')}</span>
          <span className="retry-detail-value">
            {t('transcript.retry.milliseconds', { milliseconds: Math.round(entry.delayMs) })}
          </span>
        </div>
        <div className="retry-detail">
          <span className="retry-detail-label">{t('transcript.retry.failure')}</span>
          <span className="retry-detail-value">{entry.text}</span>
        </div>
      </div>
    </details>
  )
}
