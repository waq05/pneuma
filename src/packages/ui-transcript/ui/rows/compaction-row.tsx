/**
 * 历史压缩的落点：一条带上下分隔线的窄行，说清「这是第几次压缩」（对照 dsh 的 CompactionItem）。
 *
 * 为什么单独一行、而不是把压缩提示的正文照原样铺出来：那条 system 正文是给轨迹页取证用的
 * （「上下文接近模型上限，已自动压缩历史」这类整句），对话流里读者只需要知道**历史在这里
 * 断过一次**——一行分隔 + 一个次数就够，整句塞进去反而像一条错误的正文混在对话里。
 * 正文连同「只保留摘要、原文不再发给模型」这层含义一起压进 `data-tip`，悬停可读。
 *
 * 为什么次数要画出来：一次会话可能压过好几次（每次压缩都会留下一个落点），
 * 读者靠它能数清「翻了几页摘要」，也对得上轨迹页里切出来的区段。
 *
 * @module dsc-ui-shell/plugins/transcript/rows/compaction-row
 */
import type { ReactNode } from 'react'
import { createT, type TranscriptEntry } from '@dsc/ui'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../../locale/ui.zh.json'
import en from '../../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 压缩落点标记（`count` = 本会话第几次压缩，1 基）。
 *
 * 类型从条目上就地取：契约里这个字段只有这一个形状，而 `@dsc/ui` 的公开面只转出条目本身
 * （`CompactionMark` 没进 `@dsc/ui-core` 的转出清单）。就地取一份，免得为一个两字段的类型
 * 去改壳的公开 API——那层一改，所有插件都跟着重新对表。
 */
export type CompactionMark = NonNullable<Extract<TranscriptEntry, { kind: 'system' }>['compaction']>

/**
 * 压缩落点行。
 *
 * @param props.mark - 压缩标记（次数）
 * @returns 两侧细线夹着的一行小字
 */
export function CompactionRow({ mark }: { mark: CompactionMark }): ReactNode {
  // `title` 而不是只有 `data-tip`：气泡那一层 0.6.37 起已经下线，全仓没有代码读 `data-tip`
  // （`grep dataset.tip` 无命中），只写它等于把说明藏进 DOM。原生 title 至少悬停看得见。
  const tip = t('transcript.compaction.tip')
  return (
    <div className="entry-compaction" data-compaction-count={mark.count} data-tip={tip} title={tip}>
      <span className="entry-compaction-line" aria-hidden="true" />
      <span className="entry-compaction-text">{t('transcript.compaction.mark', { count: mark.count })}</span>
      <span className="entry-compaction-line" aria-hidden="true" />
    </div>
  )
}
