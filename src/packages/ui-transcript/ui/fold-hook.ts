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
 * 纯逻辑留在 fold-state.ts（{@link foldStateOf}），本文件只包一层 React state，
 * 这样探针能在 Node 里直接 import 前者、不用碰 JSX 与 React。
 *
 * @module dsc-ui-shell/plugins/transcript/fold-hook
 */
import { useCallback, useEffect, useState } from 'react'
import { foldStateOf, followFallback, writeFold } from './fold-state'

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
