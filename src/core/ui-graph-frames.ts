/**
 * 启动图帧（SSE 的 `event: plugins`）的组装与扇出。
 *
 * 为什么抽出来：本地壳（webserver）与手机壳（remote）用的是**同一份壳产物**，客户端那边
 * 也是同一个监听（`ui-runtime/ui/host-channel.ts` 认 `event: plugins`）。宿主这侧如果各写一份
 * 「算帧 + 广播」，迟早一边忘了 `removed`、一边忘了「换图之后一定推一帧」。
 *
 * 帧的形状见 {@link UiHmrFrame}：`graph` 是新图（页面按它核对），`changed` / `removed` 只作
 * 说明用——页面那边按 id 对账，多推一帧的代价只有一次空对账。
 *
 * @module dsc/core/ui-graph-frames
 */
import type { UiBootGraph } from './ui-manifest.js'
import type { UiHmrFrame } from './ui-hmr.js'

/**
 * 把「这一刻的图」包成一帧。
 *
 * `removed` 由前后两帧的 id 差算：只作说明，所以没有上一帧（页面刚连上）时留空，不报错。
 * @param graph - 这一刻的图
 * @param previous - 上一次推给页面的帧；没有就传 null
 * @returns 可以直接交给通道推送的一帧
 */
export function graphFrameOf(graph: UiBootGraph, previous: UiHmrFrame | null): UiHmrFrame {
  const before = new Set((previous?.graph.entries ?? []).map((entry) => entry.id))
  const after = new Set(graph.entries.map((entry) => entry.id))
  return {
    rev: graph.rev,
    changed: [],
    removed: before.size === 0 ? [] : [...before].filter((id) => !after.has(id)),
    graph,
  }
}

/** 帧的当前值 + 订阅者。 */
export interface UiGraphFrames {
  /** 最近一次推给页面的帧（还没推过就是 null）；算 `removed` 时要它。 */
  readonly current: UiHmrFrame | null
  /** 记下这一帧并广播。 */
  push(frame: UiHmrFrame): void
  /**
   * 只记下、不广播：用于「每个连接建起来时单独发的那一帧」（initial）。
   *
   * 为什么必须记：下一帧的 `removed` 是拿它做基准算的；不记的话第一次推帧就只知道
   * 「没有上一帧」，少掉的那一条永远点不出来（真机上正是这样：手机收到帧了，removed 是空的）。
   */
  remember(frame: UiHmrFrame): void
  /** 订下来；返回退订函数。 */
  listen(listener: (frame: UiHmrFrame) => void): () => void
}

/**
 * 造一个帧通道。
 *
 * 订阅者抛错只丢它自己那一条——与壳里其他扇出（旁问增量、浏览器事件）同一条纪律：
 * 一个页面连接写失败不该让宿主这边炸掉，也不该让别的页面收不到帧。
 * @returns 帧通道
 */
export function createUiGraphFrames(): UiGraphFrames {
  let current: UiHmrFrame | null = null
  const listeners = new Set<(frame: UiHmrFrame) => void>()
  return {
    get current(): UiHmrFrame | null {
      return current
    },
    push(frame: UiHmrFrame): void {
      current = frame
      for (const listener of [...listeners]) {
        try {
          listener(frame)
        } catch {
          // 一个订阅者炸了不该拖垮别的
        }
      }
    },
    remember(frame: UiHmrFrame): void {
      current = frame
    },
    listen(listener: (frame: UiHmrFrame) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
