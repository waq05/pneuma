/**
 * 思考强度滑杆（2026-10-26，照用户给的参考图做的）。
 *
 * 为什么换掉原来那一列按钮：档位本身是有顺序的（关 < 低 < 高 < 最大），一列按钮看不出
 * 顺序，也看不出「往上还有一档」。滑杆把顺序画成一条轨道：点亮到哪里、还能往哪边推，
 * 一眼就看得见。
 *
 * **没有「默认」这一档**（用户 2026-10-26 定的）：默认 = 不发思考字段、由端点自己定，
 * 它不在刻度上，摆进滑杆会被当成一个真实档位。宿主仍停在「默认」时，轨道画成没落点的
 * 空态（滑钮不出现、轨道淡着），推一下才落到具体档位；要回到默认去 设置 → 思考强度。
 *
 * 动画按档位分四套（样式在壳的 styles.css 的 .effort-track[data-level] 一节）：
 * 关＝灰轨道、不动；低＝慢呼吸；高＝渐变缓慢流动；最大＝流动更快 + 一道扫光 + 滑钮外圈
 * 呼吸。prefers-reduced-motion 下四套全停。
 *
 * 底下那排刻度字（关 / 低 / 高 / 最大）2026-10-26 第二轮去掉了：轨道上的停点已经把位置说清，
 * 当前档又在卡头右侧写着，再排一行字只是把卡片撑高。要认某个停点是什么档，拖过去看卡头的字。
 *
 * 手感（2026-10-26 第二轮）：
 *   - 拖动中只改本地预览、松手才 onCommit，拖着扫过四档不会连着打四个请求；
 *   - 指针位置记在 ref 里而不是只记在 state：同一帧里按下再松开（快速点一下）时，
 *     state 还没刷新，旧写法会直接把这一下吞掉、滑钮卡在预览位；
 *   - 滑钮的 left 与点亮段的 clip-path 都带 120ms 过渡，档位变化是滑过去而不是跳过去。
 *
 * @module dsc-ui-shell/plugins/composer/effort-slider
 */
import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import type { EffortLevel } from '@dsc/ui'
import { effortLabel } from './model-picker'

/** 一档在轨道上的百分比位置（第一档贴左、最后一档贴右）。 */
function percentOf(index: number, count: number): number {
  if (count <= 1) return 100
  return (Math.max(0, Math.min(index, count - 1)) / (count - 1)) * 100
}

export function EffortSlider({
  levels,
  value,
  note,
  onCommit,
}: {
  /** 模型声明的档位（**不含 default**，见文件头）。至少一档。 */
  levels: readonly EffortLevel[]
  /** 当前显示的档位；停在「默认」或不在清单里，都按「没落点」画。 */
  value: string
  /** 卡片里那句小字说明（模型不在清单里时用），null = 不画。 */
  note: string | null
  onCommit(level: EffortLevel): void
}): ReactNode {
  const railRef = useRef<HTMLDivElement | null>(null)
  /**
   * 拖动中的档位下标（ref 是给事件处理读的同步值，state 只负责重画）。
   * 为什么两份：React 的 setState 不是同步生效的，同一帧里 down 完紧接 up 时，
   * 处理函数读到的 state 还是 null——那一下就被吞掉，滑钮停在预览位不动。
   */
  const dragRef = useRef<number | null>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const selected = levels.indexOf(value as EffortLevel)
  const index = drag ?? selected
  const unset = index < 0
  /** 动画按哪一档走：拖动中跟着手指，松手后跟着宿主（所以预览也能看见对应的动效）。 */
  const activeLevel = unset ? 'unset' : levels[Math.min(index, levels.length - 1)]

  /** 指针横坐标 → 档位下标（夹到 0..n-1，四舍五入到最近一格）。 */
  const indexAt = (clientX: number): number => {
    const rail = railRef.current
    if (rail === null) return 0
    const box = rail.getBoundingClientRect()
    if (box.width === 0 || levels.length <= 1) return 0
    const ratio = Math.max(0, Math.min(1, (clientX - box.left) / box.width))
    return Math.round(ratio * (levels.length - 1))
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    // 捕获失败不影响滑杆（合成事件没有活动指针，setPointerCapture 会抛 NotFoundError）。
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 没有捕获时指针移出轨道就不再跟手——比整条交互炸掉好。
    }
    const next = indexAt(event.clientX)
    dragRef.current = next
    setDrag(next)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return
    const next = indexAt(event.clientX)
    if (next === dragRef.current) return
    dragRef.current = next
    setDrag(next)
  }
  /** 松手：落盘一次（同一个档位不重复发）。 */
  const finish = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const at = dragRef.current
    if (at === null) return
    dragRef.current = null
    setDrag(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const level = levels[at]
    if (level !== undefined && level !== value) onCommit(level)
  }

  /** 键盘：←/→ 与 Home/End，一下一档，直接落盘（不经过拖动预览）。 */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const from = unset ? 0 : selected
    let next: number | null = null
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, from - 1)
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(levels.length - 1, from + 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = levels.length - 1
    if (next === null) return
    event.preventDefault()
    const level = levels[next]
    if (level !== undefined && level !== value) onCommit(level)
  }

  return (
    <div className="effort-slider" data-effort-slider="">
      <div className="effort-slider-head">
        <span className="effort-slider-title">思考强度</span>
        <span className={'effort-now' + (unset ? ' unset' : '')} data-effort-now={unset ? 'unset' : value}>
          {unset ? '未设置' : effortLabel(value)}
        </span>
      </div>
      {note === null ? null : <p className="effort-note">{note}</p>}
      <div
        className="effort-track"
        data-level={activeLevel}
        data-unset={unset ? '1' : undefined}
        data-dragging={drag === null ? undefined : '1'}
        data-effort-track=""
        role="slider"
        tabIndex={0}
        aria-label="思考强度"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, levels.length - 1)}
        aria-valuenow={unset ? 0 : index}
        aria-valuetext={unset ? '未设置' : effortLabel(value)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onKeyDown={onKeyDown}
      >
        <div className="effort-rail" ref={railRef}>
          <span
            className="effort-rail-fill"
            data-effort-fill=""
            style={{ '--effort-fill': (unset ? 0 : percentOf(index, levels.length)) + '%' } as CSSProperties}
          />
          {levels.map((level, at) => (
            <span
              key={level}
              className="effort-dot"
              data-effort-dot={level}
              data-lit={!unset && at <= index ? '1' : undefined}
              style={{ left: percentOf(at, levels.length) + '%' }}
            />
          ))}
          {unset ? null : (
            <span
              className="effort-knob"
              data-effort-knob=""
              style={{ left: percentOf(index, levels.length) + '%' }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
