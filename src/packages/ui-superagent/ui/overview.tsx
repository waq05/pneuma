/**
 * 概览页（U4）：顶部三格计数 + 最近动态；一张工单都没有时，下半段换成能直接行动的空态。
 *
 * 数据只读快照面（`counts` / `recent`），不拿 `tickets` 再聚合一遍：宿主 `buildSurface`
 * 已经算好三组，界面再算一份，两边口径一漂用户就会在同一页看到两个不同的数字。
 *
 * 与上游 `client/overview.tsx` 的取舍（上游读 HTTP `GET overview`，我们只有快照面）：
 * - 保留三格计数（需要你 / 进行中 / 已完成）与最近动态清单；
 * - 上游实际是「待你处理清单 / 问题清单 / 24 小时流量 / 执行器负载」四段，并没有单独的
 *   「最近动态」：这份清单来自我们的 `recent` 快照字段，是任务要求里本页唯一的动态落点；
 * - 不搬「待你处理清单」：工单页已经按三组分好了完整清单，概览再列一遍只是换个地方重复；
 * - 不搬「问题清单」：上游的 setup / source / executor 问题我们快照面没有对应字段，
 *   页体已经在 `ready:false` 时摊开 `problem`，这里不编造第二套问题面；
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
import { formatAt, setSuperagentTab, type SuperagentView } from './state'

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

/** 概览页。
 * @param surface - 当前面板视图（`ready` 已由页体保证）
 */
export function OverviewPage({ surface }: { surface: SuperagentView }): ReactNode {
  // 仍保持「最旧在前」：只留最新 20 条，不为了读最近而把整列倒过来。
  const recent = surface.recent.slice(-RECENT_LIMIT)
  return (
    <div>
      <div className="usage-cards" style={COUNTS_STYLE}>
        <CountCard label={t('superagent.overview.counts.needsYou')} value={surface.counts.needsYou} />
        <CountCard label={t('superagent.overview.counts.running')} value={surface.counts.running} />
        <CountCard label={t('superagent.overview.counts.done')} value={surface.counts.done} />
      </div>
      {surface.tickets.length === 0 ? <EmptyState /> : <RecentList recent={recent} />}
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
