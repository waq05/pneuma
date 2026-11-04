/**
 * 弹层的焦点管理（2026-10-25，P0-1）。
 *
 * 为什么要有它：壳里 9 个 `role="dialog"` 的弹层，只有 `confirm.ts` 会归还焦点。其余弹层
 * 打开时焦点还停在被点的按钮上（Tab 于是从页面顶部往后走，走的是`遮罩底下的内容`），
 * 关掉时焦点掉进 `<body>`——键盘用户下一步按 Tab 是从头开始，读屏也读不到"弹层开了"。
 *
 * 四件事，一件不多：
 *   1. 打开时记下来源焦点，把焦点移进弹层（`[data-autofocus]` → 第一个可聚焦元素 → 弹层本身）；
 *   2. Tab / Shift+Tab 在弹层内循环，不跑到遮罩底下；
 *   3. Esc 交给调用方（`onClose`），并 `stopPropagation`——嵌套弹层（设置里开模型详情）
 *      先收到 Esc，外层不会跟着关；
 *   4. 关闭时把焦点还给来源（来源已经不在 DOM 里就不还，别把焦点丢进虚空）。
 *
 * 可聚焦判定用 `offsetParent`：壳里藏元素用 `display: none` / `hidden`（不是 `visibility`），
 * 拿它筛一遍就够；`inert` 容器里的元素浏览器自己不让聚焦，不用再判。
 *
 * @module dsc-ui-shell/ui-primitives/dialog-focus
 */
import { useEffect, useRef, type RefObject } from 'react'

/** 能接焦点的元素。`[tabindex="-1"]` 只用于编程式聚焦，不进 Tab 循环。 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * 给一个弹层接上焦点管理。
 *
 * @param active   弹层是否开着（false 时什么都不做，也不还原焦点）
 * @param onClose  Esc 时调它；不传就只做焦点循环（例如只读浮层）
 * @returns `ref` 挂到弹层根元素上
 */
export function useDialogFocus(
  active: boolean,
  onClose?: () => void,
): { ref: RefObject<HTMLDivElement | null> } {
  const ref = useRef<HTMLDivElement | null>(null)
  // 回调走 ref：调用方几乎都传内联箭头，直接进依赖会让 effect 每次渲染重跑——
  // 重跑就会「再记一次来源焦点、再把焦点拽回来」，用户刚点进输入框就被抢走。
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    if (!active) return undefined
    const dialog = ref.current
    if (dialog === null) return undefined

    const last = document.activeElement instanceof HTMLElement ? document.activeElement : null
    /** 当前 Tab 循环里的元素（每次按键重算：弹层里的列表会变长变短）。 */
    const items = (): HTMLElement[] =>
      Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === dialog,
      )

    // 初始焦点：显式标注的优先（比如搜索框），否则第一个可聚焦元素，再不行就弹层本身。
    const explicit = dialog.querySelector<HTMLElement>('[data-autofocus]')
    const first = explicit ?? items()[0] ?? dialog
    if (first === dialog && dialog.tabIndex < 0) dialog.tabIndex = -1
    first.focus({ preventScroll: true })

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (close.current === undefined || event.defaultPrevented) return
        event.preventDefault()
        // 嵌套弹层：里层先处理，外层不再跟着关。
        event.stopPropagation()
        close.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = items()
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const head = focusable[0] as HTMLElement
      const tail = focusable[focusable.length - 1] as HTMLElement
      const current = document.activeElement
      if (event.shiftKey && (current === head || current === dialog)) {
        event.preventDefault()
        tail.focus()
      } else if (!event.shiftKey && current === tail) {
        event.preventDefault()
        head.focus()
      }
    }

    // 挂在弹层自己身上（不是 document）：嵌套弹层的按键先过里层，stopPropagation 之后外层收不到。
    dialog.addEventListener('keydown', onKeyDown)
    return () => {
      dialog.removeEventListener('keydown', onKeyDown)
      if (last !== null && last.isConnected) last.focus({ preventScroll: true })
    }
  }, [active])

  return { ref }
}
