/**
 * `/` 命令菜单的状态与动作（Composer 挂一份；纯逻辑在 `./commands`）。
 *
 * 候选表来自宿主的界面通道 `listUiCommands`（标了 `shell: true` 的那批命令），
 * **一次取、模块级缓存**：清单是静态数据（除非宿主升级），每次打开菜单都问一遍纯属
 * 浪费；取不到（宿主没这条通道、或请求被拒）就整会话记住不可用，菜单不再弹——
 * 比弹一个空面板诚实。
 *
 * 交互口径照 TUI（`src/app/Composer.tsx`）：↑↓ 选、Tab 补全、Esc 关且同一前缀不再弹；
 * Enter 由调用方处理（选中项在菜单开着时先采纳，见 Composer 的按键分支）。
 *
 * @module dsc-ui-shell/plugins/composer/command-menu
 */
import { useRef, useState } from 'react'
import type { useHostChannel } from '@dsc/ui'
import { claimInput, commandQuery, filterCommands, insertCommand, type ShellCommandView } from './commands'

/** 候选缓存：抓到一次就够（模块级，全壳共用一份）。 */
let cache: ShellCommandView[] | null = null
/** 取不到时记住「这条通道不可用」，不再反复问（宿主老版本 / 远程档没放行）。 */
let unavailable = false

export interface CommandMenuApi {
  open: boolean
  rows: readonly ShellCommandView[]
  loading: boolean
  at: number
  /** 输入一变就问一句：光标处是不是在打命令名（是就开面板并过滤）。 */
  track(value: string, caret: number): void
  move(delta: number): void
  /** 补全选中项到输入框（Tab / 点击）。 */
  pick(): void
  /** Esc：关上，并且同一个前缀在这轮里不再自己弹出来。 */
  close(): void
  /**
   * 程序性收面板（跑完一条命令之后）：只关，不记「这个前缀别再弹」。
   *
   * 与 {@link close} 分开的原因：Esc 是用户明确说「别烦我」，那要记住；回车执行是
   * 「我选了这一条」，文本随即被清空——两件事混用一个口子的话，未成而留在框里的
   * 那半行命令会再也弹不出候选。
   */
  hide(): void
  /**
   * 高亮那一项补全进输入框要填的文本（`/名字` + 有参数时一个空格），没有就不给。
   * 「Enter 采纳选中项」那条路取它来当要执行的原文——与 TUI 的 panelOpen 分支同口径。
   */
  insertText(): string | null
  /**
   * 这条输入是不是「要收输入」的命令（只有名字、没参数）——是就给出要填的文本与提示。
   *
   * 只查已经取到的清单（模块级 `cache`）：**不为这件事去请求宿主**。还没取过清单
   * （菜单没打开过）就返回 null，行为与改造前一模一样（回车直接执行）。
   */
  claim(value: string): { insert: string; hint: string } | null
  /**
   * 把一段文本直接补进输入框并把菜单收起来（`/review` 那条「先补全、不执行」的落点）。
   * 形状与 {@link pick} 一致：走同一个 `apply`，光标落在文本末尾。
   */
  adopt(text: string): void
}

export function useCommandMenu(options: {
  channel: ReturnType<typeof useHostChannel>
  apply(next: string, caret: number): void
  onUnavailable?: () => void
}): CommandMenuApi {
  const { channel, apply, onUnavailable } = options
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<readonly ShellCommandView[]>([])
  const [loading, setLoading] = useState(false)
  const [at, setAt] = useState(0)
  /** 最近一次输入的上下文（value/caret/查询词）：pick 与「取高亮项」都要用。 */
  const latest = useRef<{ value: string; caret: number; query: string } | null>(null)
  /** 用户对这个前缀明确按过 Esc：同一前缀不再弹（与 @ 提及同款）。 */
  const dismissed = useRef<string | null>(null)
  /** 当前候选（pick 从这里取，避开 state 时序）。 */
  const current = useRef<readonly ShellCommandView[]>([])

  const show = (query: string): void => {
    const filtered = filterCommands(cache ?? [], query)
    current.current = filtered
    setRows(filtered)
    setAt(0)
  }

  const track = (value: string, caret: number): void => {
    const query = commandQuery(value, caret)
    if (query === null || unavailable) {
      latest.current = null
      if (open) setOpen(false)
      return
    }
    // 已经取到清单：就地过滤，不问宿主（打字每一拍都发请求是没必要的）。
    if (cache !== null) {
      if (dismissed.current === query) return
      latest.current = { value, caret, query }
      setOpen(true)
      show(query)
      return
    }
    if (dismissed.current === query) return
    latest.current = { value, caret, query }
    setOpen(true)
    setLoading(true)
    void channel
      .invoke<ShellCommandView[]>('listUiCommands')
      .then((list) => {
        cache = Array.isArray(list) ? list : []
        setLoading(false)
        // 这一拍用户可能已经又改了几个字：按最新的查询词过滤，别把旧结果画上去。
        const now = latest.current
        if (now !== null) show(now.query)
      })
      .catch(() => {
        unavailable = true
        setLoading(false)
        latest.current = null
        setOpen(false)
        onUnavailable?.()
      })
  }

  const move = (delta: number): void => {
    const count = current.current.length
    if (count === 0) return
    setAt((index) => (index + delta + count) % count)
  }

  const close = (): void => {
    const token = latest.current
    if (token !== null) dismissed.current = token.query
    latest.current = null
    setOpen(false)
  }

  const hide = (): void => {
    latest.current = null
    dismissed.current = null
    setOpen(false)
  }

  const pick = (): void => {
    const inserted = insertText()
    if (inserted === null) return
    adopt(inserted)
  }

  const adopt = (text: string): void => {
    latest.current = null
    dismissed.current = null
    setOpen(false)
    apply(text, text.length)
  }

  const claim = (value: string): { insert: string; hint: string } | null => {
    // 清单还没取过：不为了这一条去请求宿主，直接按老行为放行（回车执行）。
    if (cache === null) return null
    return claimInput(cache, value)
  }

  const insertText = (): string | null => {
    if (latest.current === null) return null
    const command = current.current[at]
    return command === undefined ? null : insertCommand(command)
  }

  return { open, rows, loading, at, track, move, pick, close, hide, insertText, claim, adopt }
}
