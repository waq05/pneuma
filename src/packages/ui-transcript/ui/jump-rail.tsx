/**
 * 会话右侧回合刻度条（对照 dsh 的 TurnNavigator 全套：每轮一枚 20×2px 短横，
 * 右缘竖排、垂直居中；当前读到的轮加亮、悬停出题面/回复摘要预览卡、点击跳转；
 * 刻度多到装不下时轨道内滚动，两头渐隐；未画出来的轮更短更淡，点了先放出来再滚）。
 *
 * 与旧桌面渲染层 `JumpStrip.tsx` 的差异（这一版按 dsh 重做样式与布局）：
 * - 刻度从「16px 宽实心条 + accent 高亮」换成 dsh 的「20px×2px、静息 scaleX(0.6)、
 *   悬停 0.9、当前 1，颜色三级递进（stroke-1 → tertiary → primary）」；
 * - 轨道几何照 dsh 的 .frame：28px 宽、右缘让开滚动条 12px、垂直居中于消息区
 *   （壳里 .chat-wrap 的高度已排除输入区，等价于 dsh 的 band）、
 *   最高 min(高度 − 64px, 420px)，溢出在轨道内滚动并加 24px 渐隐；
 * - 新增悬停预览卡（dsh 的一行题面 + 最多三行回复摘要）；
 * - 新增「未加载轮」态：壳的早轮分页没画进 DOM 的那些轮刻度更短更淡，
 *   点击先请求扩展分页、等锚点出现再滚（dsh 的 loadThrough + busy 闪烁同义）。
 *
 * 它**portal 到 `.chat-wrap`**（滚动容器 `.chat` 之外）：旧桌面渲染层把刻度条渲染成
 * `.chat` 的兄弟，跨轮跳转时它有自己独立的滚动轨道、不跟消息一起滚。组件自己从
 * 宿主找 `.chat-wrap` 当 portal 宿主；滚动容器的几何与「到底」判定**不再自己量**——
 * 由 `ui.tsx` 传进来的视口（`ChatViewport`）给（见 `viewport.ts` 模块头：`floor()` 是
 * 全仓唯一的「到底」，占位非 0 时也不许有第二套口径）。
 *
 * 当前轮的判定沿用旧 JumpStrip 的探针口径（它是跟着真实滚动状态量的，比百分比准）：
 * 贴底（`viewport.atFloor()`）→ 最后一轮；否则在滚动容器上缘往里 8px 的探针线上做命中
 * 测试（条目的 `data-round` 认轮），命中不到再用真实 `scrollTop` 与各轮锚点
 * （`viewport.offsetOf()`）的实际位置兜底。
 *
 * 跳轮也不再用 `scrollIntoView`：它会把祖先滚动一起带动、也不经过视口。现在是
 * 「算出这一轮首行相对内容顶端的偏移 → `viewport.scrollToOffset()`」。
 *
 * @module dsc-ui-shell/plugins/transcript/jump-rail
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { createT } from '@dsc/ui'
import { dedupeByRound, pickCurrentRound, type RailAnchor } from './rail-window'
import type { ChatViewport } from './viewport'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 一枚刻度要的轮数据：题面与回复摘要（预览卡显示用，都已压平并截断）。 */
export interface JumpRailRound {
  /** 轮序号（0 基）。 */
  round: number
  /** 用户消息压平成一行（dsh 截 50 字）。 */
  prompt: string
  /** 该轮最终回答压平（dsh 截 120 字、显示三行）；没有定稿正文就是空串。 */
  response: string
}

/** 探针线离滚动容器上缘的距离（旧 JumpStrip 同款：用户最先看到的那条内容线）。 */
const PROBE_INSET = 8
/** 贴到底部的判定阈值（与消息流跟随同一档）。 */
const AT_BOTTOM_EPS = 32
/**
 * 容器窄于这个宽度就不画（dsh 的 `@container (max-width: 900px) { .frame { display: none } }`）。
 * 壳里用 JS 量而不是容器查询：这条轨道是绝对定位的浮层，量 .chat-wrap 的实际宽度最直接。
 */
const RAIL_MIN_WIDTH = 900
/** 刻度步距（dsh 的 TURN_SPACING_PX = 10）：hit 区 10px 高、可视线 2px 居中。 */
const TICK_STEP = 10
/** 渐隐带的宽度（dsh 的 FADE_PX = 24）。 */
const FADE_PX = 24
/** 未加载轮等待分页放出来的最长帧数（40 帧约 0.7s，超过就放弃滚动）。 */
const REVEAL_TRIES = 40

/**
 * 视口顶部那一条属于哪一轮——判定本身在 `./rail-window`（纯函数，探针直读），
 * 这里只负责两件它做不了的事：
 *
 * 1. 量锚点：按 `[data-round]` 收（每一轮至少有一条行带这个属性），**不再只认用户气泡**
 *    `.entry-user`。子代理汇报（`internal` 的 user 条目）渲染成一行触发行，没有用户气泡，
 *    旧写法数不到它，滑到底部时"最新一轮"就停在上一个有人说话的轮上（2026-10-28 报障）。
 * 2. 贴底判定：「最新一轮是哪一轮」从轮清单给（`lastRound`），不从 DOM 里数；
 *    「是不是在底」问视口（`viewport.atFloor()`），不再拿 `scrollHeight − clientHeight`
 *    自己算——那个算式没减底部占位，占位一旦非 0 就与 `viewport.floor()` 分叉。
 *
 * 几何一律经视口：`offsetOf()` 给锚点在内容坐标里的位置，`rect()` 给命中测试要的屏幕坐标。
 */
function measureCurrent(viewport: ChatViewport, rounds: readonly { round: number }[]): number {
  const scroller = viewport.scroller
  const box = viewport.rect()
  if (scroller === null || box === null) return -1
  const scrollTop = viewport.scrollTop()
  const rows: RailAnchor[] = []
  for (const row of scroller.querySelectorAll<HTMLElement>('[data-round]')) {
    const value = Number(row.getAttribute('data-round'))
    if (!Number.isInteger(value) || value < 0) continue
    // 整轮收起时过程行是 hidden（没有盒子）：量出来是 0，会把它当成"在最上面"。
    if (row.getClientRects().length === 0) continue
    const top = viewport.offsetOf(row)
    if (top === null) continue
    rows.push({ round: value, top })
  }

  // x 取横向中点：正文列是居中的，固定左缘 + 常量在宽窗口下会落进空白里。
  const probeY = box.top + PROBE_INSET
  const probeX = box.left + viewport.clientWidth() / 2
  const hit = document.elementFromPoint(probeX, probeY)
  let hitRound: number | null = null
  if (hit !== null && scroller.contains(hit)) {
    const row = hit.closest('[data-round]')
    const value = row === null ? Number.NaN : Number(row.getAttribute('data-round'))
    if (Number.isInteger(value) && value >= 0) hitRound = value
  }

  return pickCurrentRound({
    atBottom: viewport.atFloor(AT_BOTTOM_EPS),
    lastRound: rounds.at(-1)?.round ?? -1,
    hitRound,
    anchors: dedupeByRound(rows),
    probeTop: scrollTop + PROBE_INSET,
  })
}

/** 把多行文本压成一行摘要（预览卡用；与 dsh 的截断口径一致）。 */
function flatten(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** 预览摘要的截断口径（dsh：题面 50 字、回复 120 字）。 */
export const PREVIEW_LIMITS = { prompt: 50, response: 120 } as const

/** 供调用方压平文本用（导出让截断口径只有一份）。 */
export function previewText(text: string, kind: 'prompt' | 'response'): string {
  return flatten(text, PREVIEW_LIMITS[kind])
}

/**
 * 右侧回合刻度条。先渲染一枚不可见的哨兵，从它找到 `.chat-wrap`（portal 宿主），
 * 再 portal 上去——对壳的 DOM 只依赖 `.chat-wrap` 与视口给的滚动容器。
 *
 * @param props.rounds     全部轮的预览数据（含还没画出来的轮）
 * @param props.renderedFrom 已画出来的第一轮（更早的轮点了先请求放出来）
 * @param props.onReveal   请求把更早的轮放出来（把分页阈值提到能包含该轮）
 * @param props.viewport   会话区视口（`ui.tsx` 那个）：量位置、「到底」判定、跳轮都走它
 */
export function JumpRail(props: {
  rounds: readonly JumpRailRound[]
  renderedFrom: number
  onReveal(round: number): void
  viewport: ChatViewport
}): ReactNode {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [current, setCurrent] = useState(-1)
  const [wide, setWide] = useState(true)
  const [edges, setEdges] = useState({ up: false, down: false })
  const [preview, setPreview] = useState<number | null>(null)
  const [previewCenter, setPreviewCenter] = useState(0)
  /** 正在等待放出来的轮（点了没画出来的刻度）：期间那枚刻度闪烁（dsh 的 busy 同款）。 */
  const [busy, setBusy] = useState<number | null>(null)
  /** 指针在轨道里时不自动居中（dsh 的 pointerInsideRef）：别把刻度从手底下挪走。 */
  const pointerInside = useRef(false)

  // 哨兵一上屏就找 portal 宿主（`.chat-wrap`）。滚动容器不在这里找：它是视口的（ref
  // 挂载先于被动效果发生，视口这一拍已经 attach 完了），避免两处各持一个 `.chat` 引用。
  useEffect(() => {
    const wrap = wrapRef.current?.closest('.chat-wrap')
    if (!(wrap instanceof HTMLElement)) return
    setHost(wrap)
  }, [])

  /** 当前轮判定：滚动/尺寸一变就重测（rAF 合并；观察器补「内容异步撑高」那半）。 */
  useEffect(() => {
    const scroller = props.viewport.scroller
    if (host === null || scroller === null) return undefined
    let raf = 0
    const measure = (): void => {
      raf = 0
      setCurrent(measureCurrent(props.viewport, props.rounds))
    }
    const schedule = (): void => {
      if (raf === 0) raf = requestAnimationFrame(measure)
    }
    schedule()
    scroller.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(scroller)
    const inner = scroller.firstElementChild
    if (inner !== null) observer.observe(inner)
    return () => {
      scroller.removeEventListener('scroll', schedule)
      observer.disconnect()
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [host, props.viewport, props.rounds.length, props.renderedFrom])

  /** 窄容器整条收起（dsh 的 900px 规则；用观察器跟着 .chat-wrap 的实际宽度走）。 */
  useEffect(() => {
    if (host === null) return undefined
    const measure = (): void => setWide(host.clientWidth >= RAIL_MIN_WIDTH)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [host])

  /** 两条渐隐边的显隐：轨道自己滚动时同步。 */
  const syncEdges = useCallback((): void => {
    const scroll = scrollRef.current
    if (scroll === null) return
    const limit = scroll.scrollHeight - scroll.clientHeight
    const up = scroll.scrollTop > 1
    const down = limit > 0 && scroll.scrollTop < limit - 1
    setEdges((prev) => (prev.up === up && prev.down === down ? prev : { up, down }))
  }, [])
  useEffect(syncEdges, [syncEdges, props.rounds.length])

  /** 预览卡的垂直中心：刻度在轨道里的实际可视位置（内容坐标 − 轨道滚动量）。 */
  useEffect(() => {
    if (preview === null) return
    const scroll = scrollRef.current
    const tick = scroll?.querySelector<HTMLElement>(`[data-turn="${String(preview)}"]`)
    if (scroll === null || tick === null || tick === undefined) return
    setPreviewCenter(tick.offsetTop + TICK_STEP / 2 - scroll.scrollTop)
  }, [preview])

  /**
   * 当前轮自动居中（dsh：只在刻度跑出「可视带 + 24px 留白」时滚，指针在轨道里不打扰）。
   *
   * 这里滚的是刻度**自己的轨道**（`.jump-rail-scroll`），不是 `.chat`：轨道里没有底部占位，
   * `scrollHeight − clientHeight` 就是它的底，所以不用、也不该走会话视口。会话区的
   * 「到底」与跳轮在下面 `jump` 里，那条才走 `props.viewport`。
   */
  useEffect(() => {
    if (current < 0 || pointerInside.current) return
    const scroll = scrollRef.current
    const tick = scroll?.querySelector<HTMLElement>(`[data-turn="${String(current)}"]`)
    if (scroll === null || tick === null || tick === undefined) return
    const height = scroll.clientHeight
    const limit = scroll.scrollHeight - height
    if (limit <= 0) return
    const center = tick.offsetTop + TICK_STEP / 2
    if (center >= scroll.scrollTop + FADE_PX && center <= scroll.scrollTop + height - FADE_PX) return
    const target = Math.max(0, Math.min(limit, center - height / 2))
    scroll.scrollTo({ top: target, behavior: 'smooth' })
  }, [current])

  /** 点刻度跳转：已画出来的直接滚；早轮分页还没画的先请求放出来，等锚点出现再滚。 */
  const jump = useCallback(
    (round: number): void => {
      const scroller = props.viewport.scroller
      if (scroller === null) return
      const find = (): HTMLElement | null =>
        scroller.querySelector<HTMLElement>(`[data-round="${String(round)}"] .entry-user`) ??
        scroller.querySelector<HTMLElement>(`[data-round="${String(round)}"]`)
      void (async (): Promise<void> => {
        let node = find()
        if (node === null && round < props.renderedFrom) {
          setBusy(round)
          props.onReveal(round)
          for (let i = 0; i < REVEAL_TRIES && node === null; i += 1) {
            await new Promise((resolve) => requestAnimationFrame(resolve))
            node = find()
          }
          setBusy(null)
        }
        if (node === null) return
        // 落点由视口算：这一行相对内容顶端的偏移 —— 滚到它等于把它顶到容器上缘
        // （旧写法 `scrollIntoView({ block:'start' })` 的同义动作，但不连带滚祖先、
        // 也经过视口的写入通道，跟随策略认得出「这是我们自己滚的」）。
        //
        // 第三个参数 `'jump'` 是**跟随的交接**：这次写是读者的意图，不是跟随的意图。
        // 视口补间收尾时会把落点交回跟随策略（`following = atFloor(阈值)`），落点不在底
        // 就脱离跟随；少了这一条，补间收尾的 `scrollend` 会按「还在跟随」把位置钉回 floor
        // ——贴底点早轮刻度，跳上去一百毫秒后被拽回底部（2026-11-12 报障）。
        const offset = props.viewport.offsetOf(node)
        if (offset !== null) props.viewport.scrollToOffset(offset, 'smooth', 'jump')
      })()
    },
    [props],
  )

  const previewRound = preview === null ? undefined : props.rounds.find((item) => item.round === preview)
  const visible = host !== null && wide && props.rounds.length >= 2
  const rail = (
    <div
      className="jump-rail"
      role="navigation"
      aria-label={t('transcript.rail.aria')}
      hidden={!visible}
      onPointerEnter={() => {
        pointerInside.current = true
      }}
      onPointerLeave={() => {
        pointerInside.current = false
        setPreview(null)
      }}
    >
      <div
        ref={scrollRef}
        className="jump-rail-scroll"
        data-fade-up={edges.up ? '' : undefined}
        data-fade-down={edges.down ? '' : undefined}
        onScroll={syncEdges}
      >
        {props.rounds.map((item) => {
          const active = item.round === current
          const unloaded = item.round < props.renderedFrom
          return (
            <button
              key={item.round}
              type="button"
              className={`jump-tick${active ? ' on' : ''}${unloaded ? ' is-unloaded' : ''}${
                busy === item.round ? ' is-busy' : ''
              }`}
              data-turn={item.round}
              aria-label={
                unloaded
                  ? t('transcript.rail.tickUnloaded', { round: item.round + 1, prompt: item.prompt })
                  : t('transcript.rail.tick', { round: item.round + 1, prompt: item.prompt })
              }
              aria-current={active ? 'true' : undefined}
              aria-busy={busy === item.round ? 'true' : undefined}
              onPointerEnter={() => setPreview(item.round)}
              onFocus={() => {
                setPreview(item.round)
              }}
              onBlur={() => setPreview(null)}
              onClick={() => {
                jump(item.round)
              }}
            />
          )
        })}
      </div>
      {previewRound === undefined ? null : (
        <div
          className="jump-preview"
          role="tooltip"
          style={{ '--jump-preview-center': `${String(previewCenter)}px` } as CSSProperties}
        >
          <div className="jump-preview-prompt">
            {previewRound.prompt === '' ? t('transcript.rail.roundOnly', { round: previewRound.round + 1 }) : previewRound.prompt}
          </div>
          {previewRound.response === '' ? null : (
            <div className="jump-preview-response">{previewRound.response}</div>
          )}
        </div>
      )}
    </div>
  )
  return (
    <>
      <div ref={wrapRef} hidden />
      {host === null ? null : createPortal(rail, host)}
    </>
  )
}

