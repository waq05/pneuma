/**
 * 概览页（U4）：顶部三格计数 + 最近动态；一张工单都没有时，下半段换成能直接行动的空态。
 * 底部（U5）是「来源」区块：GitHub / 飞书各一行，回答「上次轮询是什么时候、错在哪」。
 *
 * 数据只读快照面（`counts` / `recent` / `sources`），不拿 `tickets` 再聚合一遍：宿主
 * `buildSurface` 已经算好三组，界面再算一份，两边口径一漂用户就会在同一页看到两个不同的数字。
 *
 * 与上游 `client/overview.tsx` 的取舍（上游读 HTTP `GET overview`，我们只有快照面）：
 * - 保留三格计数（需要你 / 进行中 / 已完成）与最近动态清单；
 * - 上游实际是「待你处理清单 / 问题清单 / 24 小时流量 / 执行器负载」四段，并没有单独的
 *   「最近动态」：这份清单来自我们的 `recent` 快照字段，是任务要求里本页唯一的动态落点；
 * - 不搬「待你处理清单」：工单页已经按三组分好了完整清单，概览再列一遍只是换个地方重复；
 * - 不搬「问题清单」：上游的 setup / source / executor 问题我们快照面没有对应字段，
 *   页体已经在 `ready:false` 时摊开 `problem`，这里不编造第二套问题面；
 *   来源自身的状态改由底部的「来源」区块回答（U5）；
 * - 不搬「24 小时流量」与「执行器负载」：`counts` 里没有这两个口径，硬凑会画假数字。
 *
 * 上游的计数可以点进筛选后的视图；我们工单页没有按组筛选，跳过去仍是一整张列表，
 * 点了等于没点，所以这里的三格只展示、不做成假链接。
 *
 * 空态为什么放在计数下面：0/0/0 本身也是信息（确认「真的没有工单」），
 * 空态只替换下半部分，告诉用户下一步能做什么。
 *
 * @module dsc-ui-shell/superagent/overview
 */
import type { ReactNode } from 'react'
import { IconBolt, createT } from '@dsc/ui'
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'
import { formatAt, setSuperagentTab, type SuperagentSource, type SuperagentView } from './state'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 最近动态最多画几条。
 *
 * 契约说宿主已截到 20 条；这里再截一次，是防宿主实现多给时页面被动态撑长。
 * 取尾部而不是头部：宿主约定最旧在前，尾部才是最新的 20 条。
 */
const RECENT_LIMIT = 20

/**
 * 三格计数的宽度上限。
 *
 * `.plugins-inner` 版心 1080，三格铺满时每格近 350px，数字和标签会被拉开到看不清关系；
 * 560 ≈ 3×180 加间距，与设置页用量统计那排卡同一档宽度。
 */
const COUNTS_STYLE = { maxWidth: 560 } as const

/**
 * 来源名称：宿主只给稳定 id（契约 `SuperagentSourceView` 没有 `label`），名称在这里取词。
 *
 * 为什么用「取词函数」而不是字典键：文案闸只认字面量 `t('…')`，动态拼键会被判成
 * 「字典里没人用」——那两个键就白写了（与 `tickets.tsx` 的 `GROUPS` 同一手法）。
 */
const SOURCE_LABELS: Record<string, () => string> = {
  github: () => t('superagent.overview.sources.github'),
  feishu: () => t('superagent.overview.sources.feishu'),
}

/**
 * 一行状态的版式：右栏从 52% 放宽到 72%。
 *
 * 错误原文可能是一整句「401 Unauthorized: ...」，52% 会折成四五行走廊；来源名只有几个字，
 * 多让一点宽度给它，错误才读得出来。
 */
const SOURCE_CONTROL_STYLE = { maxWidth: '72%' } as const

/** 错误原文的红色：用壳的语义色，不另开一档（深色主题下也自动换）。 */
const SOURCE_ERROR_STYLE = { color: 'var(--dsc-red)', wordBreak: 'break-word' } as const

/** 一行里「从未成功」那类弱化的状态：与设置页的空态同一档灰度。 */
const SOURCE_MUTED_STYLE = { color: 'var(--dsc-text-quaternary)' } as const

/** 概览页。
 * @param surface - 当前面板视图（`ready` 已由页体保证）
 */
export function OverviewPage({ surface }: { surface: SuperagentView }): ReactNode {
  // 仍保持「最旧在前」：只留最新 20 条，不为了读最近而把整列倒过来。
  const recent = surface.recent.slice(-RECENT_LIMIT)
  // 来源清单：`undefined` = 旧快照没有这一格，整块不画；空数组 = 宿主给了但一条来源都没有。
  const sources = surface.sources
  return (
    <div>
      <div className="usage-cards" style={COUNTS_STYLE}>
        <CountCard label={t('superagent.overview.counts.needsYou')} value={surface.counts.needsYou} />
        <CountCard label={t('superagent.overview.counts.running')} value={surface.counts.running} />
        <CountCard label={t('superagent.overview.counts.done')} value={surface.counts.done} />
      </div>
      {surface.tickets.length === 0 ? <EmptyState /> : <RecentList recent={recent} />}
      {sources === undefined ? null : <SourcesBlock sources={sources} />}
    </div>
  )
}

/** 一格计数：数字在上、组名在下，与设置页用量统计的卡面同款。 */
function CountCard({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <div className="usage-card">
      <div className="usage-card-value">{value}</div>
      <div className="usage-card-label">{label}</div>
    </div>
  )
}

/** 一张工单都没有时的空态：一句话 + 一颗直接切到发布页的按钮。 */
function EmptyState(): ReactNode {
  return (
    <div className="empty-card compact">
      <span className="empty-card-icon">
        <IconBolt size={18} />
      </span>
      <div className="empty-card-title">{t('superagent.overview.empty')}</div>
      <div className="empty-card-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            setSuperagentTab('publish')
          }}
        >
          {t('superagent.overview.emptyAction')}
        </button>
      </div>
    </div>
  )
}

/** 最近动态：正文在左、时刻在右，一行一条（与发布页底部那份清单同一版式）。 */
function RecentList({ recent }: { recent: readonly { at: string; text: string }[] }): ReactNode {
  return (
    <div className="plugin-detail-config">
      <div className="settings-group-title">{t('superagent.overview.recent')}</div>
      {recent.length === 0 ? (
        <div className="settings-empty">{t('superagent.overview.recentEmpty')}</div>
      ) : (
        recent.map((item, index) => {
          // 时刻认不出就不画那一格，别留一条空的右栏。
          const at = formatAt(item.at)
          return (
            <div className="setting-row" key={`${item.at}-${String(index)}`}>
              <div className="setting-text">
                <div className="setting-label">{item.text}</div>
              </div>
              {at === '' ? null : (
                <div className="setting-control">
                  <span className="mono">{at}</span>
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}

/**
 * 「来源」区块：GitHub / 飞书各一行，左边名称、右边状态。
 *
 * 为什么放在概览页底部而不是新开一个页签：这一块只有两行、一年也点不了几次；单开一页会
 * 把四页签变成五页签，用户为了看一个「上次轮询」要多跳一层。上游 `client/source.tsx` 独立
 * 成页是因为它还要管游标与开关，我们这两件事都在设置页里。
 *
 * 已知限制：来源状态变化**不会主动推快照**——`service.tick()` 的指纹只算工单阶段与最近
 * 动态（`service.ts:46-51`、`150-158`），所以错误要等下一次 `dsc/changed`（别的插件推快照）
 * 或用户重进页面才会更新。要实时推，得把来源状态也算进那个指纹，本轮没做。
 */
function SourcesBlock({ sources }: { sources: readonly SuperagentSource[] }): ReactNode {
  return (
    <div className="plugin-detail-config">
      <div className="settings-group-title">{t('superagent.overview.sources')}</div>
      {sources.map((source) => (
        <div className="setting-row" key={source.id}>
          <div className="setting-text">
            <div className="setting-label">{sourceLabelOf(source.id)}</div>
          </div>
          <div className="setting-control" style={SOURCE_CONTROL_STYLE}>
            <SourceState source={source} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** 认不出的来源原样显示 id：将来宿主加来源时，界面至少不是一片空白。 */
function sourceLabelOf(id: string): string {
  return SOURCE_LABELS[id]?.() ?? id
}

/**
 * 一行右边的状态。
 *
 * 优先级是「未启用 → 上次轮询 → 错误」：错误原文永远画在最后（它可能很长），但一定画——
 * U5 要解决的就是「令牌过期只有宿主日志里一行」。没失败过就不画错误那一截，不写「正常」
 * 这种没有信息量的词：跑没跑过由「上次轮询」说清了。
 *
 * 为什么文案是「上次轮询」而不是「上次成功」：两个适配器都在每轮**开始时**记 lastPollAt
 * （`github/source.ts:495`、`feishu/loops.ts:502`），失败的那轮也会更新它。写成「上次成功」
 * 就会出现「上次成功：刚刚 · 401」这种自相矛盾的一行。
 */
function SourceState({ source }: { source: SuperagentSource }): ReactNode {
  // 关着的来源也占一行：用户要先知道「这个东西存在、但没开」，才会去设置里找它。
  if (!source.enabled) {
    return <span style={SOURCE_MUTED_STYLE}>{t('superagent.overview.sources.disabled')}</span>
  }
  const lastPollAt = source.lastPollAt
  const when = lastPollAt === undefined ? '' : relativeTime(lastPollAt)
  const lastPoll = lastPollAt === undefined
    ? <span style={SOURCE_MUTED_STYLE}>{t('superagent.overview.sources.never')}</span>
    // 时刻读不懂就原样显示 ISO：总比把「有过轮询」说成「从未成功」强。
    : <span>{t('superagent.overview.sources.lastPoll', { when: when === '' ? lastPollAt : when })}</span>
  if (source.lastError === undefined) return lastPoll
  return (
    <span>
      {lastPoll}
      {' · '}
      <span style={SOURCE_ERROR_STYLE}>{source.lastError}</span>
    </span>
  )
}

/**
 * 「上次轮询」距现在多久。
 *
 * 只给粗档（刚刚 / 分钟 / 小时 / 天）：这一格要回答的是「还活着吗」，精确到秒反而让人
 * 以为它是实时读数，而它其实要等下一次快照才更新。`iso` 认不出给空串，调用方据此退回
 * 原样显示 ISO（不拿「刚刚」冒充一个读不懂的时刻）。
 */
function relativeTime(iso: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const minutes = Math.floor((Date.now() - at) / 60_000)
  if (minutes < 1) return t('superagent.overview.sources.justNow')
  if (minutes < 60) return t('superagent.overview.sources.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('superagent.overview.sources.hoursAgo', { count: hours })
  return t('superagent.overview.sources.daysAgo', { count: Math.floor(hours / 24) })
}
