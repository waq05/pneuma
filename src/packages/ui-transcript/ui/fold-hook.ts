/**
 * 折叠行的开合状态钩子：挂载读存档，设置变了只跟「没手动调过」的行走。
 *
 * 为什么要有它：设置页的两个开关（定稿的思考行 / 工具卡默认展开）改完之后，屏幕上已经
 * 画出来的行原来只在挂载时算一次初值，于是老行纹丝不动，用户以为设置没生效。
 * 但直接让所有行跟着设置翻也不行——用户亲手点开的那一条会被无端合上。
 *
 * 分工：**存档（fold-state）**记「用户手动调过什么」，**fallback**（context 下发的设置默认态）
 * 记「没调过时该是什么」。这条钩子只做一件事：fallback 变化时，没有手动存档的行跟着切。
 *
 * ## 复位代次（2026-11-12）
 *
 * 存档只在**重挂**时起作用，同一次挂载里的行自己还开着：整轮收起时行座位把存档抹掉了
 * （`fold-seats.tsx` 的 `onHidden`），可那一份 state 还在——收起整轮再展开，那条思考行
 * 照样摊着，只有切走再切回来（重挂）才回默认态。参考实现靠一个「复位代次」解决
 * （dsh 的 `use-disclosure.ts:11-21`：`expanded = expandedVersion === version`；代次一变，
 * **已挂载的**展开态当场失效）。
 *
 * 这里同样：座位实例持有一个代次（{@link createFoldReset}），在**真的挂上 `hidden`** 那一拍
 * 推进一位；行用 `useSyncExternalStore` 订阅它。为什么用订阅而不是在 context 里放一个每次
 * 变化的新对象：后者会让每一行（以及它们 memo 过的子层）跟着重渲染，本线前面那批「流式
 * 每帧只重画一行」的成果就白做了。订阅只在代次推进时惊动真正用到它的那几行。
 *
 * 复位读的是**抹过存档之后**的默认态（`foldStateOf`），所以它等价于「这一行重挂之后会是
 * 什么样」；并且这条路上**不写**任何手动存档——复位不是用户的选择。
 *
 * 纯逻辑留在 fold-state.ts（{@link foldStateOf}），本文件只包一层 React state，
 * 这样探针能在 Node 里直接 import 前者、不用碰 JSX 与 React。
 *
 * @module dsc-ui-shell/plugins/transcript/fold-hook
 */
import {
  createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore,
} from 'react'
import { foldStateOf, followFallback, writeFold } from './fold-state'

/**
 * 一条「复位代次」：只读的订阅源。代次推进 = 订阅者脚下那一份展开态作废。
 *
 * 形状照参考实现的 `ObservableSnapshot`（`client-store`）：`subscribe` + `getSnapshot`。
 * 推进的动作只交给持有它的座位（{@link FoldResetOwner}），行只能读。
 */
export interface FoldReset {
  /** 订阅代次变化；返回退订函数。 */
  subscribe(listener: () => void): () => void
  /** 此刻的代次（单调递增的整数）。 */
  getSnapshot(): number
}

/** 座位手上的那一份：比 {@link FoldReset} 多一个「推进一位」（只有座位自己能推）。 */
export interface FoldResetOwner extends FoldReset {
  /** 这一层**真的**被藏起来了：推进一位，让已挂载的行当场回默认态。 */
  bump(): void
}

/**
 * 造一份复位代次（一个座位实例一份，别做成模块级全局：那样一轮收起会把整屏的行都惊动）。
 *
 * @returns 可订阅、可推进的代次
 */
export function createFoldReset(): FoldResetOwner {
  /** 当前代次。只在本模块里加，对外只读。 */
  let version = 0
  /** 订阅者。推进时**先拷一份再遍历**：监听器里退订不会漏掉后面的。 */
  const listeners = new Set<() => void>()
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return (): void => {
        listeners.delete(listener)
      }
    },
    getSnapshot(): number {
      return version
    },
    bump(): void {
      version += 1
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * 最近一个座位的复位代次。
 *
 * `undefined` = 这一行不在任何座位上（前导行、团队页签的子代理流直接画 RowBody）——
 * 那些地方没有「整轮收起」，代次也就永远不会推进。
 *
 * 类型带上 `bump`：外层座位那一份要能原样交给里层座位（阶段组里的成员行沿用组那一份）。
 * 约定仍是「只有持有它的座位推进」——行只订阅，行体会话里也不该去推。
 */
export const FoldResetContext = createContext(undefined as FoldResetOwner | undefined)

/**
 * @param storeKey 存档键（undefined = 这个视图不存档，只活在本次挂载里）
 * @param fallback 没手动存档时的展开态，即设置里的默认档
 * @returns [当前展开态, 改展开态的函数]；后者会把选择写进存档（从此算「手动调过」）
 */
export function useFoldState(
  storeKey: string | undefined,
  fallback: boolean,
): [open: boolean, setOpen: (next: boolean) => void] {
  // 初值只在挂载那一刻算：有存档读存档，没有才用设置默认态。
  const [open, setOpen] = useState(() => foldStateOf(storeKey, fallback).open)

  // 座位给的复位代次。没有座位时钉成常量（0），订阅是个空函数——两者都按引用固定，
  // `useSyncExternalStore` 才不会每次渲染重订阅一遍。
  const reset = useContext(FoldResetContext)
  const subscribe = useCallback(
    (notify: () => void): (() => void) => (reset === undefined ? () => {} : reset.subscribe(notify)),
    [reset],
  )
  const snapshot = useCallback((): number => (reset === undefined ? 0 : reset.getSnapshot()), [reset])
  const version = useSyncExternalStore(subscribe, snapshot, snapshot)

  /**
   * 设置默认态（或存档键）变了：只有这条键没有手动存档时才跟随。
   *
   * 挂载时这个 effect 也会跑一次，但那次算出来的和初值一样，不会多画一帧。
   * 读存档而不是直接 setOpen(fallback)，是为了「键换了但新键有人手动存过」时
   * 仍能读回那一位用户的选择。
   */
  useEffect(() => {
    setOpen((current) => followFallback(current, storeKey, fallback))
  }, [storeKey, fallback])

  /** 上一次见到的代次：初值是挂载那一刻的，于是挂载本身不算「推进」。 */
  const seenVersion = useRef(version)
  /**
   * 代次推进：这一行刚被座位**真的**藏起来过（整轮收起落了地），当场回默认态。
   *
   * 为什么读 `foldStateOf` 而不是直接 `setOpen(false)`：座位在推进代次之前已经抹掉了这一行
   * 的手动存档（`RowSeat` 的 `onHidden`），此刻的默认态就是「重挂之后会读到的值」；兜底是
   * 展开档的视图（设置里开着「默认展开」）也就不会被这条复位反着合上。
   *
   * 为什么这里**不写存档**：复位是座位的动作，不是用户的选择；写成手动存档的话，
   * 兜底（collapseTiming 等）以后就再也翻不动这一行了。
   */
  useEffect(() => {
    if (seenVersion.current === version) return
    seenVersion.current = version
    setOpen(foldStateOf(storeKey, fallback).open)
  }, [version, storeKey, fallback])

  /** 用户点击：先写存档（重挂后读得回来），再改当场这份 state。 */
  const set = useCallback(
    (next: boolean): void => {
      writeFold(storeKey, next)
      setOpen(next)
    },
    [storeKey],
  )

  return [open, set]
}
