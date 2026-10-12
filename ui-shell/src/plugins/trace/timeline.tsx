/**
 * 轨迹页的时间概览条：把整个会话的步骤按「(时刻 − 首条时刻) / 总时长」投影成一条横向时间轴。
 *
 * 这是旧桌面渲染层 `TraceTimeline.tsx` 的同构移植，并补上缩放/平移（旧版当时留的
 * 「这一轮不做」）——长会话里步骤全挤在几像素内，放大了才看得清。
 *
 * 三条诚实规矩（不许破）：
 * 1. 只有拿得到 `durationMs` 的工具才画**有宽度**的条；思考 / 系统 / 计划卡只画一条起点刻度。
 *    绝不拿「总时长 ÷ 步骤数」之类的平均宽度充数——那是编出来的宽度；
 * 2. 没有耗时就不写耗时：悬停提示里给「耗时未记录」，不给 0s，也不给估算值；
 * 3. 一条带时间的记录都没有（2026-09 之前的老会话）时，整条时间轴不画，只留一句说明。
 *
 * 交互：悬停 500ms 出精确时刻与耗时；在轨道上拖选一段区间，下方记录表据此聚焦；
 * 点一下（没拖动）或右键单击清除；**滚轮缩放**（指针位置为锚点）、**右键拖拽平移**、
 * 头部「全览」一键复位。缩放只改可视窗口，不改任何数据。
 *
 * @module dsc-ui-shell/plugins/trace/timeline
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { formatClockSeconds, formatTraceDuration } from './trace-format'
import type { TraceBoundary, TraceMark, TraceRange } from './trace-format'

/** 悬停多久才弹提示：500ms 是「停下来看」与「扫过去」的分界（需求指定）。 */
const HOVER_DELAY_MS = 500
/** 拖动多少像素才算拖选：小于这个数当点击处理（点击 = 清除区间）。 */
const DRAG_MIN_PX = 4
/** 判定「这是平移不是右键单击」的位移门槛（px）。 */
const PAN_MIN_PX = 3
/** 最窄视窗：总跨度的 1/50（再放大没有信息量），且不小于 1 秒。 */
const MIN_ZOOM_DENOM = 50

interface Viewport {
  start: number
  end: number
}

export function TraceTimeline(props: {
  marks: TraceMark[]
  boundaries: TraceBoundary[]
  spanStart: number | null
  spanEnd: number | null
  selected: TraceRange | null
  /** 选中的区间里有多少条步骤（计数在 TraceView 里算，两处不重复实现命中判定）。 */
  selectedCount: number
  /** 换会话时清掉缩放窗口（窗口是「这个会话的时间轴」上的一次取景）。 */
  resetKey: string
  onSelect: (range: TraceRange | null) => void
}): ReactNode {
  const trackRef = useRef<HTMLDivElement | null>(null)
  /** 悬停提示：延迟到点才设置，鼠标走开就清掉。 */
  const [hover, setHover] = useState<TraceMark | null>(null)
  const hoverTimer = useRef<number | null>(null)
  /** 正在拖的区间（本地即时反馈；松手后才上报给 TraceView）。 */
  const [drag, setDrag] = useState<TraceRange | null>(null)
  const dragRef = useRef<{ pointerId: number; anchorTs: number; moved: boolean } | null>(null)
  /** 缩放窗口（null = 全览）。 */
  const [viewport, setViewport] = useState<Viewport | null>(null)
  /** 右键平移：按下时的指针与窗口。 */
  const panRef = useRef<{ pointerId: number; startX: number; from: Viewport; moved: boolean } | null>(null)
  /** 刚做完一次平移：松手后紧跟的 contextmenu 不该再清掉区间。 */
  const suppressMenu = useRef(false)

  // 换会话：取景复位（不清的话会拿着上一个会话的时间窗去看新会话的轴）。
  useEffect(() => {
    setViewport(null)
  }, [props.resetKey])

  const fullSpan = props.spanStart !== null && props.spanEnd !== null ? props.spanEnd - props.spanStart : 0
  /** 投影得出来吗：要有起止时刻，而且真的跨了一段时间。跨度为 0 时所有标记都会叠在最左端。 */
  const projectable = props.spanStart !== null && fullSpan > 0
  /** 当前取景窗口（epoch ms）；投影不出来时为 null。 */
  const domain: Viewport | null =
    props.spanStart === null || props.spanEnd === null
      ? null
      : (viewport ?? { start: props.spanStart, end: props.spanEnd })
  const domainSpan = domain === null ? 0 : domain.end - domain.start

  /** 时刻 → 轨道上的百分比（不 clamp：界外的标记由渲染侧跳过或裁剪）。 */
  const percent = (ts: number): number => {
    if (!projectable || domain === null || domainSpan <= 0) return 0
    return ((ts - domain.start) / domainSpan) * 100
  }
  /** 百分比 → 时刻（拖选与缩放锚点用；ratio 已 clamp 到 [0,1]）。 */
  const timeAt = (clientX: number): number | null => {
    const track = trackRef.current
    if (track === null || !projectable || domain === null) return null
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return null
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return domain.start + ratio * domainSpan
  }

  /**
   * 滚轮缩放：以指针位置为锚点（指针下的那个时刻保持不动）。
   * 用原生监听挂 `{ passive: false }`——React 的 onWheel 走被动监听，
   * 里面 preventDefault 不生效，页面会跟着滚。
   */
  useEffect(() => {
    const track = trackRef.current
    const hardStart = props.spanStart
    const hardEnd = props.spanEnd
    if (track === null || !projectable || hardStart === null || hardEnd === null) return undefined
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const trackRect = track.getBoundingClientRect()
      if (trackRect.width <= 0) return
      const ratio = Math.min(1, Math.max(0, (event.clientX - trackRect.left) / trackRect.width))
      const from = viewport ?? { start: hardStart, end: hardEnd }
      const fromSpan = from.end - from.start
      const anchor = from.start + ratio * fromSpan
      const factor = event.deltaY < 0 ? 0.8 : 1.25
      const minSpan = Math.max(1000, fullSpan / MIN_ZOOM_DENOM)
      const nextSpan = Math.min(fullSpan, Math.max(minSpan, fromSpan * factor))
      let nextStart = anchor - ratio * nextSpan
      nextStart = Math.min(hardEnd - nextSpan, Math.max(hardStart, nextStart))
      setViewport(nextSpan >= fullSpan * 0.999 ? null : { start: nextStart, end: nextStart + nextSpan })
    }
    track.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      track.removeEventListener('wheel', onWheel)
    }
  }, [projectable, viewport, props.spanStart, props.spanEnd, fullSpan])

  const clearHover = (): void => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }
  /** 悬停满 500ms 才出提示；期间移开就撤掉计时器，一次都不弹。 */
  const armHover = (mark: TraceMark): void => {
    clearHover()
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null
      setHover(mark)
    }, HOVER_DELAY_MS)
  }
  const disarmHover = (): void => {
    clearHover()
    setHover(null)
  }
  useEffect(() => clearHover, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button === 2) {
      // 右键：按下先记着，拖动 = 平移，没拖动 = 单击（见 onContextMenu）。
      if (domain === null) return
      disarmHover()
      panRef.current = { pointerId: event.pointerId, startX: event.clientX, from: domain, moved: false }
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // 拿不到指针捕获时轨道内的拖动照旧生效（与拖选同款兜底）。
      }
      return
    }
    if (event.button !== 0) return
    const at = timeAt(event.clientX)
    if (at === null) return
    disarmHover()
    dragRef.current = { pointerId: event.pointerId, anchorTs: at, moved: false }
    setDrag({ start: at, end: at })
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 指针捕获只是为了让手指拖出轨道后仍继续收 pointermove；拿不到捕获时（合成事件、
      // 个别触控实现）轨道内的拖动照旧生效，不该因为这一步把整段选择逻辑打断。
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current
    if (pan !== null && pan.pointerId === event.pointerId) {
      const dx = event.clientX - pan.startX
      if (!pan.moved && Math.abs(dx) < PAN_MIN_PX) return
      pan.moved = true
      const track = trackRef.current
      const width = track?.getBoundingClientRect().width ?? 0
      if (width <= 0 || props.spanStart === null || props.spanEnd === null) return
      const shift = (dx / width) * (pan.from.end - pan.from.start)
      const span = pan.from.end - pan.from.start
      let nextStart = pan.from.start - shift
      nextStart = Math.min(props.spanEnd - span, Math.max(props.spanStart, nextStart))
      setViewport(span >= fullSpan * 0.999 ? null : { start: nextStart, end: nextStart + span })
      return
    }
    const held = dragRef.current
    if (held === null || held.pointerId !== event.pointerId) return
    const at = timeAt(event.clientX)
    if (at === null) return
    if (!held.moved && Math.abs(at - held.anchorTs) > 0) {
      const rect = trackRef.current?.getBoundingClientRect()
      const movedPx = rect === undefined ? 0 : Math.abs(((at - held.anchorTs) / domainSpan) * rect.width)
      if (movedPx >= DRAG_MIN_PX) held.moved = true
    }
    setDrag({ start: Math.min(held.anchorTs, at), end: Math.max(held.anchorTs, at) })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current
    if (pan !== null && pan.pointerId === event.pointerId) {
      panRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      // 真的拖了：吃掉紧随其后的 contextmenu（不清区间、不弹系统菜单）。
      suppressMenu.current = pan.moved
      return
    }
    const held = dragRef.current
    if (held === null || held.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const at = timeAt(event.clientX) ?? held.anchorTs
    const range = { start: Math.min(held.anchorTs, at), end: Math.max(held.anchorTs, at) }
    setDrag(null)
    // 没拖动 = 一下点击 = 清除已有区间（需求：再点一次清除）。
    if (!held.moved) {
      props.onSelect(null)
      return
    }
    props.onSelect(range)
  }

  const range = drag ?? props.selected
  const rangeLabel =
    range === null
      ? null
      : `${formatTraceDuration(range.end - range.start) ?? '0.0s'} · ${String(props.selectedCount)} 步`

  if (props.spanStart === null || props.spanEnd === null) {
    return (
      <div className="trace-timeline is-empty" data-trace-timeline="empty">
        <span className="ttl-title">时间概览</span>
        <span className="ttl-note">本会话没有记录时间戳（2026-09 之前的老会话），时间条不画。</span>
      </div>
    )
  }

  /** 一条标记的投影：完全落在取景窗外的跳过；跨界的裁到边上。 */
  const project = (start: number, end: number | null): { left: number; width: number } | null => {
    const rawLeft = percent(start)
    const rawRight = end === null ? rawLeft : percent(end)
    const left = Math.max(0, rawLeft)
    const right = Math.min(100, rawRight)
    if (rawRight < 0 || rawLeft > 100) return null
    return { left, width: end === null ? 0 : Math.max(0.4, right - left) }
  }

  return (
    <div className="trace-timeline" data-trace-timeline="1" data-marks={String(props.marks.length)}>
      <div className="ttl-head">
        <span className="ttl-title">时间概览</span>
        <span className="ttl-range">
          {formatClockSeconds(props.spanStart)} → {formatClockSeconds(props.spanEnd)} ·{' '}
          {formatTraceDuration(fullSpan) ?? '不足 0.1s'}
        </span>
        {viewport !== null && (
          <button
            type="button"
            className="ttl-chip ttl-zoom-reset"
            data-trace-zoom-reset="1"
            data-tip="回到全览（滚轮缩放、右键拖动平移）"
            onClick={() => {
              setViewport(null)
            }}
          >
            已缩放 {formatTraceDuration(domainSpan) ?? ''} · 全览
          </button>
        )}
        {rangeLabel !== null && props.selected !== null && (
          <button
            type="button"
            className="ttl-chip"
            data-trace-selection-chip="1"
            data-tip="点这里清除区间（也可以在轨道上点一下、或右键单击清除）"
            onClick={() => props.onSelect(null)}
          >
            已选 {rangeLabel} · 清除
          </button>
        )}
      </div>
      <div
        className="ttl-track"
        ref={trackRef}
        data-trace-track="1"
        data-projectable={projectable ? '1' : '0'}
        data-zoomed={viewport === null ? undefined : '1'}
        role="group"
        aria-label="会话时间概览：横向为时间，拖选一段区间可聚焦下方记录；滚轮缩放，右键拖动平移"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragRef.current = null
          panRef.current = null
          setDrag(null)
        }}
        onPointerLeave={disarmHover}
        onContextMenu={(event) => {
          // 右键：拖动过 = 已平移（吃掉这一下）；没拖动 = 清除区间，不想为了取消一次拖选
          // 还得对准轨道点一下。
          event.preventDefault()
          if (suppressMenu.current) {
            suppressMenu.current = false
            return
          }
          props.onSelect(null)
        }}
      >
        {props.boundaries.map((boundary) => {
          const spot = project(boundary.ts, null)
          if (spot === null) return null
          return (
            <span
              key={`boundary-${String(boundary.round)}`}
              className="ttl-sep"
              data-trace-boundary={String(boundary.round)}
              style={{ left: `${String(spot.left)}%` }}
              data-tip={`第 ${String(boundary.round + 1)} 轮从这里开始`}
            />
          )
        })}
        {props.marks.map((mark) => {
          const spot = project(mark.start, mark.end)
          if (spot === null) return null
          return mark.end === null ? (
            // 没有耗时的步骤：只画起点刻度。宽度是 0，不是「很小」——不虚构。
            <span
              key={mark.id}
              className={`ttl-tick kind-${mark.kind}`}
              data-trace-mark={String(mark.id)}
              data-kind={mark.kind}
              style={{ left: `${String(spot.left)}%` }}
              onPointerEnter={() => armHover(mark)}
              onPointerLeave={disarmHover}
            />
          ) : (
            <span
              key={mark.id}
              className={`ttl-bar kind-${mark.kind}`}
              data-trace-mark={String(mark.id)}
              data-kind={mark.kind}
              data-duration={String(mark.durationMs ?? '')}
              style={{ left: `${String(spot.left)}%`, width: `${String(spot.width)}%` }}
              onPointerEnter={() => armHover(mark)}
              onPointerLeave={disarmHover}
            />
          )
        })}
        {range !== null && (
          <span
            className="ttl-sel"
            data-trace-selection="1"
            style={{
              left: `${String(Math.max(0, percent(range.start)))}%`,
              width: `${String(Math.max(0.3, Math.min(100, percent(range.end)) - Math.max(0, percent(range.start))))}%`,
            }}
          />
        )}
        {hover !== null && (
          <span
            className="ttl-tip"
            data-trace-tip="1"
            style={{
              left: `${String(Math.min(96, Math.max(4, percent((hover.start + (hover.end ?? hover.start)) / 2))))}%`,
            }}
          >
            <b>{hover.name}</b>
            <span>{formatClockSeconds(hover.ts ?? hover.start) ?? '时刻未记录'}</span>
            <span>
              {hover.durationMs === null
                ? '耗时未记录'
                : `耗时 ${formatTraceDuration(hover.durationMs) ?? '未记录'}`}
            </span>
          </span>
        )}
      </div>
    </div>
  )
}
