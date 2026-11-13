/**
 * 工单页：三组（需要你处理 / 进行中 / 已完成），点一条进详情。
 *
 * 分组口径与宿主 `buildSurface` 的计数口径一致（`packages/superagent/surface.ts:39-56`）：
 * `person` 一组，`working` 与 `idle` 一起算「进行中」，`ended` 算「已完成」。
 * 组头里的数字用**这一组实际画出来的条数**，不读 `counts`——两处口径万一漂了，
 * 用户看到的组头与组内条数至少要能对上。
 *
 * 一条都没有时给可操作的空态：一句「发一条试试」+ 一颗直接切到发布页的按钮。
 *
 * @module dsc-ui-shell/superagent/tickets
 */
import { Fragment, useEffect, type ReactNode } from 'react'
import { IconBolt, IconChevronRight, createT } from '@dsc/ui'
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'
import { DetailPage } from './detail'
import {
  formatAt,
  openTicket,
  setHighlightedTicket,
  setSuperagentTab,
  stageGroupOf,
  stageLabelOf,
  useHighlightedTicket,
  useSelectedTicket,
  type SuperagentTicket,
  type SuperagentView,
} from './state'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 刚发布的工单高亮多久（毫秒）：够看清是哪一行，又不至于一直是花的。 */
const HIGHLIGHT_MS = 6000

/**
 * 三组的顺序：要人处理的最先，已完成的垫底。
 *
 * 组名写成「取词函数」而不是字典键：文案闸只认字面量 `t('…')`，动态拼键会被判成
 * 「字典里没人用」——那三个键就白写了。
 */
const GROUPS = [
  { id: 'person', label: (): string => t('superagent.tickets.group.person') },
  { id: 'working', label: (): string => t('superagent.tickets.group.working') },
  { id: 'ended', label: (): string => t('superagent.tickets.group.done') },
] as const

/** 高亮行的底色：与侧栏选中行同一档，只提一层。 */
const HIGHLIGHT_STYLE = { background: 'var(--dsc-row-active-bg)' } as const

/** 行的几何：`.plugin-row` 是给 div 写的，换成 button 后要自己补宽度与左对齐。 */
const ROW_STYLE = { width: '100%', textAlign: 'left' } as const

/** 工单页：有选中就画详情，否则画三组列表。 */
export function TicketsPage({ surface }: { surface: SuperagentView }): ReactNode {
  const selected = useSelectedTicket()
  if (selected !== null) return <DetailPage surface={surface} id={selected} />
  return <TicketList surface={surface} />
}

/** 列表：三组 + 空态。 */
function TicketList({ surface }: { surface: SuperagentView }): ReactNode {
  const highlight = useHighlightedTicket()

  // 高亮是「刚发布」的一次性提示：几秒后自己清掉，用户点进详情也顺带清掉。
  useEffect(() => {
    if (highlight === null) return undefined
    const timer = window.setTimeout(() => {
      setHighlightedTicket(null)
    }, HIGHLIGHT_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [highlight])

  if (surface.tickets.length === 0) {
    return (
      <div className="empty-card compact">
        <span className="empty-card-icon">
          <IconBolt size={18} />
        </span>
        <div className="empty-card-title">{t('superagent.tickets.empty')}</div>
        <div className="empty-card-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setSuperagentTab('publish')
            }}
          >
            {t('superagent.tickets.emptyAction')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      {GROUPS.map((group) => {
        const items = surface.tickets.filter((ticket) => stageGroupOf(ticket.stage) === group.id)
        if (items.length === 0) return null
        return (
          <Fragment key={group.id}>
            <div className="plugin-group-label">
              {group.label()} <span className="count">{items.length}</span>
            </div>
            {items.map((ticket) => (
              <TicketRow key={ticket.id} ticket={ticket} highlight={ticket.id === highlight} />
            ))}
          </Fragment>
        )
      })}
    </div>
  )
}

/** 一行工单：标题 + 摘要 + 阶段 + 时间，整行可点。 */
function TicketRow({ ticket, highlight }: { ticket: SuperagentTicket; highlight: boolean }): ReactNode {
  const title = ticket.title === '' ? ticket.id : ticket.title
  const at = formatAt(ticket.at)
  return (
    <button
      type="button"
      className="plugin-row"
      style={highlight ? { ...ROW_STYLE, ...HIGHLIGHT_STYLE } : ROW_STYLE}
      aria-label={t('superagent.tickets.openAria', { title })}
      onClick={() => {
        openTicket(ticket.id)
      }}
    >
      <div className="plugin-info">
        <div className="plugin-name">{title}</div>
        {ticket.summary === undefined ? null : <div className="plugin-desc">{ticket.summary}</div>}
      </div>
      <span className="plugin-detail-src">{stageLabelOf(ticket.stage)}</span>
      {at === '' ? null : <span className="mono">{at}</span>}
      <IconChevronRight size={14} />
    </button>
  )
}
