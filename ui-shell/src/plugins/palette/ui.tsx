/**
 * 全局命令面板（Ctrl+K）：一处搜「动作 / 会话 / 页面 / 设置」。
 *
 * 条目从**动作表**读（`@dsc/ui` 的 `useActions`）：面板自己一条动作都不硬编码，
 * 谁提供这个能力谁登记——会话插件登记「新会话」、设置插件登记各分区、首屏提示词由
 * 转录插件登记。这样加一条动作只改声明它的那个插件，面板会自动多一行。
 *
 * 会话列表仍然是面板自己拼的：它来自宿主快照（最近的 8 条），不属于「全局动作」。
 *
 * 为什么注册进 `shell.header`：那个槽常挂载（设置面板也住这儿），面板自己按开合渲染
 * 遮罩，不用壳另开一个全局层。
 *
 * 滚动：结果列表是面板里唯一能滚的一列（`.palette-list`，flex 撑满、min-height: 0）。
 * 指针不在列表上（搜索栏 / 底栏 / 面板外的遮罩）时滚轮由 `wheelToList` 折算进去；
 * 键盘 ↑↓ 挪到框外会跟着滚（`scrollIntoView` block:'nearest'），PgUp / PgDn 整页跳，
 * Home / End 到首尾。
 *
 * @module dsc-ui-shell/plugins/palette
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type WheelEvent } from 'react'
import {
  IconClose,
  IconSearch,
  defineUiPlugin,
  useActions,
  useHostChannel,
  useHostSelector,
  type HostSnapshot,
  type SessionSummary,
  type UiAction,
} from '@dsc/ui'

const NO_SESSIONS: readonly SessionSummary[] = Object.freeze([])

function readSessions(snapshot: HostSnapshot | null): readonly SessionSummary[] {
  const value = snapshot?.['sessions']
  return Array.isArray(value) ? (value as SessionSummary[]) : NO_SESSIONS
}

/** 面板打开的事件名（别处想给面板加入口时发它，不需要 import 本插件）。 */
const OPEN_EVENT = 'shell.palette.open'
/** 键位表打开的事件名（`?` 之外的第二条入口，例如侧栏的帮助行）。 */
const HELP_EVENT = 'shell.shortcuts.open'

/** 面板里的一行：动作表的一条，或一条最近会话。 */
interface PaletteItem {
  id: string
  label: string
  hint: string
  group: string
  shortcut?: string
  /** 搜索时额外算进去的字（动作的 keywords）。 */
  keywords: readonly string[]
  run(): void
}

export default defineUiPlugin({
  name: '命令面板',
  apply(ui) {
    // order 70：排在设置面板（31）之后，两个都常挂载、互不遮挡。
    ui.slots.register('shell.header', { id: 'palette.panel', order: 70 }, PalettePanel)
  },
})

function PalettePanel(): ReactNode {
  const channel = useHostChannel()
  const sessions = useHostSelector(readSessions)
  const actions = useActions()
  const [open, setOpen] = useState(false)
  const [help, setHelp] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement | null>(null)
  const list = useRef<HTMLDivElement | null>(null)

  // Ctrl+K / ⌘K 开合；Esc 关。面板关着也听，否则没有入口能打开它。
  useEffect(() => {
    const toggle = (): void => {
      setQuery('')
      setActive(0)
      setOpen((value) => !value)
    }
    /** 焦点在输入框里时 `?` 是文字，不是快捷键。 */
    const typing = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
    }
    const onKey = (event: KeyboardEvent): void => {
      // Ctrl+Shift+K 归旁问（2026-10-25）：带 Shift 的那一下不算命令面板，否则两个面板一起弹。
      if (event.shiftKey && event.key.toLowerCase() === 'k') return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setHelp(false)
        toggle()
        return
      }
      // `?` 开键位表（Shift+/）：没有输入焦点时才响应，否则会和正文里的问号打架。
      if (event.key === '?' && !event.ctrlKey && !event.metaKey && !typing(event.target)) {
        event.preventDefault()
        setOpen(false)
        setHelp(true)
        return
      }
      if (event.key === 'Escape' && (open || help)) {
        event.preventDefault()
        setOpen(false)
        setHelp(false)
      }
    }
    const onEvent = (): void => {
      setQuery('')
      setActive(0)
      setHelp(false)
      setOpen(true)
    }
    // 键位表可以单独被叫出来（侧栏入口 / 未来的帮助菜单），不经过命令面板。
    const onHelp = (): void => {
      setOpen(false)
      setHelp(true)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_EVENT, onEvent)
    window.addEventListener(HELP_EVENT, onHelp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_EVENT, onEvent)
      window.removeEventListener(HELP_EVENT, onHelp)
    }
  }, [open, help])

  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = actions
      .filter((action: UiAction) => action.palette !== false)
      .map((action) => ({
        id: action.id,
        label: action.label,
        hint: action.hint ?? '',
        group: action.group ?? '动作',
        ...(action.shortcut === undefined ? {} : { shortcut: action.shortcut }),
        keywords: action.keywords ?? [],
        run: action.run,
      }))
    // 会话按最近更新排，只放前 8 条——面板是「跳转」不是「浏览」，再多就该去侧栏了。
    // 单列一组：与动作表里的「新会话」分开，免得两条都叫「新会话」挨在一起。
    const recent = [...sessions]
      .filter((session) => session.archivedAt === undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8)
    for (const session of recent) {
      list.push({
        id: `session.${session.id}`,
        label: session.title ?? '新会话',
        hint: session.cwd,
        group: '最近会话',
        keywords: [],
        run: () => {
          void channel.invoke('openSession', [session.id])
          void channel.invoke('refreshSessions', [])
          setOpen(false)
        },
      })
    }
    return list
  }, [actions, channel, sessions])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return items
    return items.filter((item) => matches(item, needle))
  }, [items, query])

  // 结果变了要把高亮拉回第一条，否则会出现「输入后高亮停在越界的那条」。
  useEffect(() => {
    setActive(0)
  }, [query])

  /**
   * 高亮走到哪，列表就滚到哪。
   *
   * 没有这一条，连按十几次 ↓ 之后高亮会跑到框外——键盘看着像「翻不动页」，
   * 按回车选中的还是看不见的那条。用 block: 'nearest'：只滚到刚好露出来，
   * 不做居中抖动（与 ui-primitives/select 同一口径）。
   */
  useEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>('[data-active="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, query, open])

  /** 一页盖得住几行：用可视高除以行高（含组标题），PageDown/PageUp 用它跳。 */
  const pageRows = (): number => {
    const node = list.current
    if (node === null) return 5
    const row = node.querySelector<HTMLElement>('.palette-row')
    const rowHeight = row === null ? 35 : row.getBoundingClientRect().height + 1
    return Math.max(1, Math.floor((node.clientHeight - rowHeight) / rowHeight))
  }

  if (help) {
    return (
      <ShortcutSheet
        onClose={() => {
          setHelp(false)
        }}
      />
    )
  }
  if (!open) return null

  const pick = (item: PaletteItem | undefined): void => {
    if (item === undefined) return
    item.run()
    // 动作自己可能忘了关门（run 里干什么由登记方决定），面板统一在选中后收起。
    setOpen(false)
  }

  return (
    <div
      className="palette-mask"
      onMouseDown={() => {
        setOpen(false)
      }}
      onWheel={(event) => {
        wheelToList(event, list.current)
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onMouseDown={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="palette-search">
          <IconSearch size={15} />
          <input
            ref={input}
            value={query}
            placeholder="搜索动作、会话或设置…"
            aria-label="搜索动作、会话或设置"
            onChange={(event) => {
              setQuery(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActive((index) => Math.min(index + 1, shown.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActive((index) => Math.max(index - 1, 0))
              } else if (event.key === 'PageDown' || event.key === 'PageUp') {
                // 一次翻一页：键盘用户不该只能一行一行挪（用户报告：不能翻页）。
                event.preventDefault()
                const step = pageRows()
                const delta = event.key === 'PageDown' ? step : -step
                setActive((index) => Math.max(0, Math.min(shown.length - 1, index + delta)))
              } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault()
                setActive(event.key === 'Home' ? 0 : Math.max(0, shown.length - 1))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                pick(shown[active])
              } else if (event.key === 'Tab') {
                // Tab 别跑出面板：焦点只有一个输入框，左右键让位给光标。
                event.preventDefault()
              }
            }}
          />
          <kbd className="palette-key">Esc</kbd>
          {/* 看得见的关法：只知道 Ctrl+K 打开、不知道 Esc 关的人会卡在这儿。
              真机上遮罩以前还在窗口拖拽区里，这颗按钮曾经也是「按了没反应」。 */}
          <button
            type="button"
            className="palette-close"
            title="关闭，快捷键 Esc"
            aria-label="关闭命令面板"
            onClick={() => {
              setOpen(false)
            }}
          >
            <IconClose size={15} />
          </button>
        </div>
        <div className="palette-list" ref={list} role="listbox" aria-label="匹配项">
          {shown.length === 0 ? <div className="palette-empty">没有匹配项</div> : null}
          {shown.map((item, index) => (
            <ItemRow
              key={item.id}
              item={item}
              active={index === active}
              // 第一行、以及与上一行不同组时才插小标题（组标题不参与上下键）。
              header={index === 0 ? item.group : shown[index - 1]?.group === item.group ? undefined : item.group}
              onHover={() => {
                setActive(index)
              }}
              onPick={() => {
                pick(item)
              }}
            />
          ))}
        </div>
        <div className="palette-foot">
          <span>上下键选择</span>
          <span>PgUp / PgDn 翻页</span>
          <span>回车打开</span>
          <span>Esc 关闭</span>
          <button
            type="button"
            className="palette-foot-link"
            onClick={() => {
              setOpen(false)
              setHelp(true)
            }}
          >
            键盘快捷键 <kbd className="palette-key">?</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 键位表：把所有全局快捷键列成一张两列的表。
 *
 * 为什么硬编码在这一份里：键位由各自的插件监听（壳的布局、命令面板、会话行），
 * **没有一处运行期注册表**——这里是一张给人看的清单，加新快捷键时顺手补一行；
 * 行尾的「焦点」说明哪些键只在特定位置上生效，免得读者在任意位置按了没反应。
 */
const SHORTCUTS: ReadonlyArray<{ keys: string; label: string; note?: string }> = [
  { keys: 'Ctrl K', label: '命令面板', note: '搜动作、会话与设置' },
  { keys: 'Ctrl B', label: '收起 / 展开侧栏' },
  { keys: 'Ctrl P', label: '文件页签' },
  { keys: 'Ctrl `', label: '终端页签' },
  { keys: 'Ctrl T', label: '浏览器页签' },
  { keys: 'Ctrl Enter', label: '插话', note: '回合进行中补一句' },
  { keys: 'Ctrl Alt R', label: '重命名会话', note: '焦点在会话行上' },
  { keys: 'Ctrl Alt F', label: '分叉会话', note: '焦点在会话行上' },
  { keys: 'Ctrl Shift A', label: '归档会话', note: '焦点在会话行上' },
  { keys: 'Esc', label: '关闭浮层' },
]

/** 键位表面板：与命令面板同一种遮罩和浮层几何，只是内容换成一张表。 */
function ShortcutSheet({ onClose }: { onClose: () => void }): ReactNode {
  const list = useRef<HTMLDivElement | null>(null)
  return (
    <div
      className="palette-mask"
      onMouseDown={onClose}
      onWheel={(event) => {
        wheelToList(event, list.current)
      }}
    >
      <div
        className="palette shortcut-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="键盘快捷键"
        onMouseDown={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="shortcut-head">
          <span>键盘快捷键</span>
          <kbd className="palette-key">Esc</kbd>
          <button
            type="button"
            className="palette-close"
            title="关闭，快捷键 Esc"
            aria-label="关闭键位表"
            onClick={onClose}
          >
            <IconClose size={15} />
          </button>
        </div>
        <div className="shortcut-list" ref={list}>
          {SHORTCUTS.map((row) => (
            <div className="shortcut-row" key={row.keys}>
              <span className="shortcut-label">
                {row.label}
                {row.note === undefined ? null : <span className="shortcut-note">{row.note}</span>}
              </span>
              <kbd className="shortcut-keys">{row.keys}</kbd>
            </div>
          ))}
        </div>
        <div className="shortcut-foot">按 ? 随时打开这张表</div>
      </div>
    </div>
  )
}

/**
 * 把「不在列表上」的滚轮补到列表里。
 *
 * 面板里真正能滚的只有中间那一列；指针停在搜索栏、底栏、或面板外的遮罩上时，
 * 轮子转得再快也一动不动（用户报告：滚轮滑不动）。这里把这几处的滚轮折算成
 * 列表的 scrollTop——指针本来就在列表里时直接放行，交给浏览器原生滚动，
 * 免得自己加一份速度和惯性、跟系统打架。
 */
function wheelToList(event: WheelEvent<HTMLElement>, node: HTMLDivElement | null): void {
  if (node === null) return
  if (event.target instanceof Node && node.contains(event.target)) return
  if (node.scrollHeight <= node.clientHeight) return
  node.scrollTop += event.deltaY
}

/** 一行结果（带组小标题与右侧键位）。 */
function ItemRow({
  item,
  active,
  header,
  onHover,
  onPick,
}: {
  item: PaletteItem
  active: boolean
  header: string | undefined
  onHover: () => void
  onPick: () => void
}): ReactNode {
  return (
    <>
      {header === undefined ? null : <div className="palette-group">{header}</div>}
      <button
        type="button"
        role="option"
        aria-selected={active}
        className="palette-row"
        data-active={active ? '1' : undefined}
        onMouseEnter={onHover}
        onClick={onPick}
      >
        <span className="palette-label">{item.label}</span>
        {item.hint === '' ? null : <span className="palette-hint">{item.hint}</span>}
        {item.shortcut === undefined ? null : <kbd className="palette-key">{item.shortcut}</kbd>}
      </button>
    </>
  )
}

/** 标签 / 说明 / 额外搜索词任一命中即算（不分大小写）。 */
function matches(item: PaletteItem, needle: string): boolean {
  if (item.label.toLowerCase().includes(needle)) return true
  if (item.hint.toLowerCase().includes(needle)) return true
  return item.keywords.some((word) => word.toLowerCase().includes(needle))
}
