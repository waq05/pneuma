/**
 * 设置 → 用量统计：Token 活动热力图、每日趋势折线、模型用量环形图。
 *
 * 版式整体搬旧桌面端 `UsagePanel.tsx`（同一套 class：`usage-*` / `hm-*` / `trend-*` /
 * `donut-*`，样式在 `legacy/views.css` 里原样等着一笔；`dsc-segmented` 在
 * `legacy/primitives.css`）。图全用内联 SVG / CSS 网格手画，不引图表库；颜色全走
 * `--dsc-*` 令牌，深浅主题自动跟随。
 *
 * 与旧面板的差异只有一处：数据从 `proxy.usageStats()` 换成界面通道的
 * `usageStats`（零实参、只读，`core/ui-methods.ts` 白名单里）；读取失败就地显示
 * 原因与重试（旧面板同款，不走 Toast）。
 *
 * @module dsc-ui-shell/plugins/settings/usage
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { IconChart, IconRefresh, createT, useHostChannel, type UsageDayView, type UsageModelView, type UsageStatsView } from '@dsc/ui'
import { Skeleton, SkeletonText, errText as text, humanErrorText } from '@dsc/ui-primitives'
import { CELL, GAP, buildCells } from './heatmap'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 折线与环形的取色顺序：品牌蓝打头，后面用语义色顶上。
 *  深色主题的 --dsc-purple 本身是蓝（#7aaaff，见 tokens.css），排第三会和品牌蓝撞色，
 *  所以第三位给 orange，purple 只当第四条的兜底。 */
const SERIES_COLORS = [
  'var(--dsc-accent)',
  'var(--dsc-green)',
  'var(--dsc-orange)',
  'var(--dsc-purple)',
]

/** 数字压成中文习惯的「万 / 亿」。 */
function fmtTokens(value: number): string {
  if (value >= 1e8) return t('settings.usage.tokens.billions', { value: (value / 1e8).toFixed(value >= 1e9 ? 1 : 2) })
  if (value >= 1e4) return t('settings.usage.tokens.tenThousands', { value: (value / 1e4).toFixed(1) })
  return String(value)
}

function fmtDate(dateKey: string): string {
  const [, month, day] = dateKey.split('-')
  return t('settings.usage.date', { month: Number(month), day: Number(day) })
}

// ── 热力图 ────────────────────────────────────────────────────────────────────

function Heatmap(props: { days: UsageDayView[]; windowDays: number }): ReactNode {
  const { columns, months } = useMemo(() => buildCells(props.days, props.windowDays), [props.days, props.windowDays])
  // days 为空时宿主的聚合层就不该给出 sinceTs 以外的数据；这里防御一下不画格子。
  if (props.days.length === 0) return <div className="settings-empty">{t('settings.usage.heat.empty')}</div>
  return (
    <div className="hm">
      {/* 只有这一块自己横向滚：格子在手机上一定比卡片宽（一年 53 列 × 13px = 686px），
          以前没有容器，它把整个设置页一起撑宽了（实测 settings-body scrollWidth 731 / clientWidth 385）。 */}
      <div className="hm-scroll">
        <div className="hm-canvas">
          <div className="hm-months" style={{ marginLeft: 26 }}>
            {months.map((month) => (
              <span key={`${String(month.column)}-${month.label}`} style={{ left: month.column * (CELL + GAP) }}>
                {month.label}
              </span>
            ))}
          </div>
          <div className="hm-body">
            <div className="hm-weekdays">
              <span style={{ gridRow: 2 }}>{t('settings.usage.weekday.mon')}</span>
              <span style={{ gridRow: 4 }}>{t('settings.usage.weekday.wed')}</span>
              <span style={{ gridRow: 6 }}>{t('settings.usage.weekday.fri')}</span>
            </div>
            <div className="hm-grid" role="img" aria-label={t('settings.usage.heat.aria')}>
              {columns.map((column, columnIndex) =>
                column.map((cell, rowIndex) => {
                  if (cell === null) {
                    return <span key={`${String(columnIndex)}-${String(rowIndex)}`} className="hm-cell hm-l0" />
                  }
                  const tokens = cell.day.inputTokens + cell.day.outputTokens
                  return (
                    <span
                      key={`${String(columnIndex)}-${String(rowIndex)}`}
                      className={`hm-cell hm-l${String(cell.level)}`}
                      title={t('settings.usage.pointTitle', { date: cell.day.date, tokens: fmtTokens(tokens), turns: cell.day.turns })}
                    />
                  )
                }),
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="hm-legend">
        <span>{t('settings.usage.heat.less')}</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} className={`hm-cell hm-l${String(level)}`} />
        ))}
        <span>{t('settings.usage.heat.more')}</span>
      </div>
    </div>
  )
}

// ── 趋势折线 ──────────────────────────────────────────────────────────────────

const CHART_W = 640
const CHART_H = 210
const CHART_PAD = { left: 52, right: 12, top: 12, bottom: 26 }

/** 把 y 轴上限取到 1/2/2.5/5 × 10^k，刻度线读起来不别扭。 */
function niceCeiling(value: number): number {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (factor * power >= value) return factor * power
  }
  return 10 * power
}

function TrendChart(props: { days: UsageDayView[]; models: UsageModelView[] }): ReactNode {
  const shown = props.models.slice(0, SERIES_COLORS.length)
  const innerW = CHART_W - CHART_PAD.left - CHART_PAD.right
  const innerH = CHART_H - CHART_PAD.top - CHART_PAD.bottom
  const ceiling = niceCeiling(Math.max(1, ...props.days.map((day) => day.inputTokens + day.outputTokens)))
  const x = (index: number): number =>
    CHART_PAD.left + (props.days.length === 1 ? innerW / 2 : (index / (props.days.length - 1)) * innerW)
  const y = (tokens: number): number => CHART_PAD.top + innerH - (tokens / ceiling) * innerH
  const lineFor = (modelKey: string): string =>
    props.days
      .map((day, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)} ${y(day.byModel[modelKey] ?? 0).toFixed(1)}`)
      .join(' ')
  const labelEvery = Math.max(1, Math.round(props.days.length / 8))
  return (
    <div className="trend">
      <div className="trend-legend">
        {shown.map((model, index) => (
          <span key={model.key} className="trend-legend-item" title={model.key}>
            <i style={{ background: SERIES_COLORS[index] }} />
            {model.key.split('/').pop()}
          </span>
        ))}
        {shown.length === 0 && <span className="trend-legend-item">{t('settings.usage.trend.empty')}</span>}
      </div>
      <svg viewBox={`0 0 ${String(CHART_W)} ${String(CHART_H)}`} className="trend-svg" role="img" aria-label={t('settings.usage.trend.aria')}>
        {[0.25, 0.5, 0.75, 1].map((ratio) => (
          <g key={ratio}>
            <line
              x1={CHART_PAD.left}
              x2={CHART_W - CHART_PAD.right}
              y1={y(ceiling * ratio)}
              y2={y(ceiling * ratio)}
              className="trend-grid"
            />
            <text x={CHART_PAD.left - 6} y={y(ceiling * ratio) + 3} className="trend-tick" textAnchor="end">
              {fmtTokens(ceiling * ratio)}
            </text>
          </g>
        ))}
        <line x1={CHART_PAD.left} x2={CHART_W - CHART_PAD.right} y1={y(0)} y2={y(0)} className="trend-axis" />
        {shown.map((model, seriesIndex) => (
          <path key={model.key} d={lineFor(model.key)} className="trend-line" style={{ stroke: SERIES_COLORS[seriesIndex] }} />
        ))}
        {props.days.map((day, index) => {
          const shownAt = index % labelEvery === 0 || index === props.days.length - 1
          return (
            <g key={day.date}>
              {shownAt && (
                <text x={x(index)} y={CHART_H - 8} className="trend-tick" textAnchor="middle">
                  {fmtDate(day.date)}
                </text>
              )}
              <circle
                cx={x(index)}
                cy={y(day.inputTokens + day.outputTokens)}
                r="5"
                fill="transparent"
              >
                <title>{t('settings.usage.pointTitle', { date: fmtDate(day.date), tokens: fmtTokens(day.inputTokens + day.outputTokens), turns: day.turns })}</title>
              </circle>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ── 模型环形图 ────────────────────────────────────────────────────────────────

function Donut(props: { models: UsageModelView[] }): ReactNode {
  const total = props.models.reduce((sum, model) => sum + model.inputTokens + model.outputTokens, 0)
  if (total <= 0) return <div className="settings-empty">{t('settings.usage.donut.empty')}</div>
  const radius = 66
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return (
    <div className="donut-row">
      <svg viewBox="0 0 170 170" className="donut-svg" role="img" aria-label={t('settings.usage.donut.aria')}>
        <circle cx="85" cy="85" r={radius} className="donut-track" />
        {props.models.map((model, index) => {
          const share = (model.inputTokens + model.outputTokens) / total
          const dash = share * circumference
          const element = (
            <circle
              key={model.key}
              cx="85"
              cy="85"
              r={radius}
              className="donut-seg"
              style={{
                stroke: SERIES_COLORS[index % SERIES_COLORS.length],
                strokeDasharray: `${String(Math.max(dash - 2, 1))} ${String(circumference - Math.max(dash - 2, 1))}`,
                strokeDashoffset: -offset,
              }}
            />
          )
          offset += dash
          return element
        })}
        <text x="85" y="81" className="donut-total" textAnchor="middle">
          {fmtTokens(total)}
        </text>
        <text x="85" y="99" className="donut-unit" textAnchor="middle">
          tokens
        </text>
      </svg>
      <div className="donut-legend">
        {props.models.map((model, index) => {
          const tokens = model.inputTokens + model.outputTokens
          const share = tokens / total
          return (
            <div key={model.key} className="donut-legend-item" title={model.key}>
              <i style={{ background: SERIES_COLORS[index % SERIES_COLORS.length] }} />
              <div className="donut-legend-text">
                <span className="donut-legend-name">{model.key.split('/').pop()}</span>
                <span className="donut-legend-sub">
                  {t('settings.usage.donut.rowSub', { tokens: fmtTokens(tokens), turns: model.turns })}
                </span>
              </div>
              <span className="donut-legend-pct">{`${String(Math.round(share * 100))}%`}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 页面本体 ──────────────────────────────────────────────────────────────────

/** 趋势折线的窗口。 */
type Range = 7 | 30

/**
 * 热力图的窗口（天数）：今天一档也留着——刚接活的那一天，看到的就是一列。
 *
 * 为什么热力图也要能选：一年 53 列在手机上一定横出屏幕（实测 686px 塞进 323px 卡片），
 * 只能靠横滑看全；「今天到底跑了多少」这种问题不该靠滑到底去数格子。
 */
type HeatRange = 1 | 7 | 30 | 364

export function UsageGroup(): ReactNode {
  const channel = useHostChannel()
  const [stats, setStats] = useState<UsageStatsView | null>(null)
  const [error, setError] = useState('')
  const [range, setRange] = useState<Range>(7)
  const [heatRange, setHeatRange] = useState<HeatRange>(364)

  const reload = (): void => {
    channel
      .invoke<UsageStatsView>('usageStats')
      .then((next) => {
        setStats(next)
        setError('')
      })
      .catch((err: unknown) => setError(text(err)))
  }
  useEffect(reload, [channel])

  if (error !== '') {
    return (
      <div className="settings-empty">
        {t('settings.usage.loadFailed', { message: humanErrorText(error).text })}
        <button className="text-btn" onClick={reload} style={{ marginLeft: 8 }}>
          {t('settings.usage.retry')}
        </button>
      </div>
    )
  }
  if (stats === null) {
    // 用量是几张汇总卡 + 一条趋势：先把这两块的形状画出来，比一行灰字更像"马上就来"。
    return (
      <div className="settings-loading" role="status" aria-label={t('settings.usage.loadingAria')}>
        <div className="settings-loading-cards">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height={62} radius={12} />
          ))}
        </div>
        <Skeleton height={148} radius={12} />
        <SkeletonText lines={3} />
      </div>
    )
  }
  if (stats.sinceTs === null) {
    return (
      <div className="settings-empty usage-empty">
        <IconChart size={22} />
        {t('settings.usage.empty.title')}
        <p>{t('settings.usage.empty.hint')}</p>
      </div>
    )
  }
  const firstDay = stats.days[0]
  if (firstDay === undefined) {
    return <div className="settings-empty">{t('settings.usage.broken')}</div>
  }

  const total = stats.totalInputTokens + stats.totalOutputTokens
  const trendDays = stats.days.slice(-range)
  const heatDays = stats.days.slice(-heatRange)
  const cards: { label: string; value: string }[] = [
    { label: t('settings.usage.card.total'), value: fmtTokens(total) },
    {
      label: t('settings.usage.card.peak'),
      value: stats.peakDay === null ? '—' : fmtTokens(stats.peakDay.inputTokens + stats.peakDay.outputTokens),
    },
    { label: t('settings.usage.card.activeDays'), value: t('settings.usage.days', { count: stats.activeDays }) },
    { label: t('settings.usage.card.currentStreak'), value: t('settings.usage.days', { count: stats.currentStreakDays }) },
    { label: t('settings.usage.card.longestStreak'), value: t('settings.usage.days', { count: stats.longestStreakDays }) },
  ]
  // 前缀缓存明细（端点上报过才有）：命中率 = 命中 /（命中 + 未命中），只统计上报了的请求
  const cacheReported = stats.totalCacheHitTokens + stats.totalCacheMissTokens
  if (cacheReported > 0) {
    cards.push({
      label: t('settings.usage.card.cacheHit'),
      value: `${String(Math.round((stats.totalCacheHitTokens / cacheReported) * 100))}%`,
    })
  }

  return (
    <div className="usage">
      <div className="usage-cards">
        {cards.map((card) => (
          <div key={card.label} className="usage-card">
            <div className="usage-card-value">{card.value}</div>
            <div className="usage-card-label">{card.label}</div>
          </div>
        ))}
      </div>

      <section className="usage-block">
        <div className="usage-block-head">
          <h3>{t('settings.usage.block.activity')}</h3>
          <div className="dsc-segmented" role="group" aria-label={t('settings.usage.heat.rangeAria')}>
            {([1, 7, 30, 364] as HeatRange[]).map((value) => (
              <button
                key={value}
                type="button"
                className="dsc-segmented__btn"
                aria-selected={heatRange === value}
                title={t('settings.usage.heat.rangeTip', { since: fmtDate(firstDay.date), total: fmtTokens(total) })}
                onClick={() => {
                  setHeatRange(value)
                }}
              >
                {value === 1 ? t('settings.usage.range.today') : value === 364 ? t('settings.usage.range.year') : t('settings.usage.range.days', { count: value })}
              </button>
            ))}
          </div>
        </div>
        <Heatmap days={heatDays} windowDays={heatRange} />
      </section>

      <section className="usage-block">
        <div className="usage-block-head">
          <h3>{t('settings.usage.block.trend')}</h3>
          <div className="dsc-segmented" role="group">
            {([7, 30] as Range[]).map((value) => (
              <button
                key={value}
                type="button"
                className="dsc-segmented__btn"
                aria-selected={range === value}
                onClick={() => setRange(value)}
              >
                {value === 7 ? t('settings.usage.range.last7') : t('settings.usage.range.last30')}
              </button>
            ))}
          </div>
        </div>
        <TrendChart days={trendDays} models={stats.models} />
      </section>

      <section className="usage-block">
        <div className="usage-block-head">
          <h3>{t('settings.usage.block.models')}</h3>
        </div>
        <Donut models={stats.models} />
      </section>

      <div className="usage-foot">
        <span>
          {t('settings.usage.foot', { since: fmtDate(firstDay.date), turns: stats.totalTurns })}
        </span>
        <button className="text-btn" onClick={reload}>
          <IconRefresh size={13} /> {t('settings.usage.refresh')}
        </button>
      </div>
    </div>
  )
}
