/**
 * 内置插件：终端（停靠面板里的那一个页签）。
 *
 * ## 三件与旧界面一致、改的时候别破坏的事
 *
 * 1. **管道模式**：宿主的 `term-spawn` 起的是非交互子进程（pwsh / cmd / bash / node，
 *    见 `src/plugins/desktop-dock.ts`），没有 tty，所以**行编辑由界面自己做**——
 *    回车前由这里维护输入行、本地回显、退格本地编辑，回车才把整行 + `\n` 发下去。
 *    交互式全屏程序（vim、top）在这个模式下不可用，这是管道模式的固有代价。
 * 2. **spawn 必须由用户显式动作触发**：挂载时不自动起进程，界面上先给一颗「启动」。
 *    这条是阶段 5.2 定的（`core/dock-ops.ts` 的第三档），别为了"顺手"改成自动。
 * 3. **终端只走原生桥**：界面 HTTP 面里没有 `term-*`（放行面的 op 枚举是读 + 写），
 *    所以浏览器 / 远程壳里这一块**必然**缺席——那时显示一句话，而不是报错崩掉。
 *
 * ## 为什么 xterm 从 `@xterm/xterm` 拿
 *
 * 它在壳的平台模块表里（`ui-shell/src/platform-modules.json`），与 React 同一种用法：
 * 插件 bundle 里 `require('@xterm/xterm')` 由壳提供，于是**只有壳带一份 xterm**
 * （CSS 也由壳在 `main.tsx` 里静态 import，插件 bundle 带不了样式文件）。
 *
 * @module dsc-ui-shell/plugins/terminal
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { IconClose, IconTerminal } from '@dsc/ui'
import { defineUiPlugin, getHostNative, readCssColor, readCssValue, setDockOpen, useDockOpen } from '@dsc/ui'

/** 支持的 shell：与宿主 `spawnShell` 的白名单一字不差（对不上会被宿主回落成 PowerShell）。 */
const SHELLS = [
  { id: 'pwsh', label: 'PowerShell 7', prompt: 'PS>' },
  { id: 'powershell', label: 'Windows PowerShell', prompt: 'PS>' },
  { id: 'cmd', label: '命令提示符', prompt: '>' },
  { id: 'bash', label: 'Git Bash', prompt: '$' },
  { id: 'node', label: 'Node.js', prompt: '>' },
] as const

type ShellId = (typeof SHELLS)[number]['id']

/** 面板宽度记忆的键（与旧界面同一个键，但两者不同源，不会互相覆盖）。 */
const WIDTH_KEY = 'dsc.dockWidth'
/** 默认宽度：与旧界面一致（420，可调区间 300–820）。 */
const DEFAULT_WIDTH = 420

/** 记住的面板宽度：读不出来 / 越界就用默认值。 */
function readWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(saved) && saved >= 300 && saved <= 820 ? saved : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

export default defineUiPlugin({
  name: '终端',
  apply(ui) {
    // 顶栏那颗开合钮（`shell.header` 是 list 槽，可以有几个条目），
    // 与停靠面板本身（`shell.dock`）分注册两处——面板收起时那一槽整块不渲染。
    ui.slots.register('shell.header', { id: 'terminal.toggle', order: 20 }, TerminalToggle)
    ui.slots.register('shell.dock', { id: 'terminal.pane', order: 10 }, DockPanel)
  },
})

/** 顶栏里的开合钮：终端是"进得去出得来"的地方，入口放在常驻可见的顶栏。 */
function TerminalToggle(): ReactNode {
  const open = useDockOpen()
  return (
    <button
      type="button"
      className={`icon-btn dock-toggle${open ? ' on' : ''}`}
      title={open ? '收起终端面板' : '打开终端面板'}
      aria-label="终端面板"
      aria-pressed={open}
      onClick={() => {
        setDockOpen(!open)
      }}
    >
      <IconTerminal size={16} />
    </button>
  )
}

/** 停靠面板：标题条 + 终端。 */
function DockPanel(): ReactNode {
  const native = getHostNative()
  const [width] = useState(readWidth)
  const [shell, setShell] = useState<ShellId>('pwsh')

  return (
    <aside className="dock" style={{ width }} data-shell={shell}>
      <div className="dock-strip">
        <span className="shell-tab on">终端</span>
        <span className="dock-strip-fill" />
        {/* 浏览器里没有桥：把话说明白，别让人以为是"坏了"。 */}
        <span className="shell-term-note">{native.available ? '' : '只在桌面版里有'}</span>
        <button
          type="button"
          className="icon-btn"
          title="收起终端面板"
          aria-label="收起终端面板"
          onClick={() => {
            setDockOpen(false)
          }}
        >
          <IconClose size={15} />
        </button>
      </div>
      <div className="dock-body">
        {native.available ? (
          <TerminalPane shell={shell} onShell={setShell} />
        ) : (
          <p className="shell-term-empty">
            终端来自桌面外壳的原生桥，浏览器里没有它。要用终端请打开桌面版（或者在终端里跑
            <code> msc</code>）。
          </p>
        )}
      </div>
    </aside>
  )
}

/**
 * 一台终端：启动 → 输入 → 收输出 → 关掉。
 *
 * 生命周期与旧界面一致的点：**离开面板就杀掉会话**（这一版收起面板会卸载整块，
 * 与旧界面"收起仍保活"不同，写在 development-log 的诚实边界里）。
 */
function TerminalPane({ shell, onShell }: { shell: ShellId; onShell: (next: ShellId) => void }): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const native = getHostNative()
  // 会话 id 与终端实例都放在 ref 里：它们跨渲染存活，且改动不该触发重画。
  const sessionRef = useRef('')
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [note, setNote] = useState<{ tone: 'info' | 'error'; text: string }>({ tone: 'info', text: '点「启动」开一个 shell' })
  const [busy, setBusy] = useState(false)

  // 装配 xterm（只做一次）：字体与配色都从现有令牌读，不另起一套主题。
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    const term = new Terminal({
      fontSize: readFontSize(),
      fontFamily: 'Consolas, "Courier New", monospace',
      cursorBlink: true,
      theme: readTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    // 面板宽度会变（窗口大小、将来拖动调宽），不重排的话 xterm 的网格还是旧的。
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // 面板被隐藏时尺寸是 0，fit 会抛；下一轮可见时再来。
      }
    })
    observer.observe(host)
    termRef.current = term
    fitRef.current = fit
    term.writeln(`\x1b[90m管道模式：输入命令回车执行，交互式全屏程序（vim/top 之类）用不了\x1b[0m`)

    // 行缓冲：管道 stdin 没有行编辑，回车之前这一行由界面自己维护。
    let line = ''
    const onData = term.onData((data) => {
      const id = sessionRef.current
      if (id === '') return
      for (const char of data) {
        if (char === '\r') {
          term.write('\r\n')
          const command = line
          line = ''
          void native.invoke('terminal', ['term-input', { id, data: `${command}\n` }]).catch(() => undefined)
        } else if (char === '\u007f') {
          if (line.length > 0) {
            line = line.slice(0, -1)
            term.write('\b \b')
          }
        } else if (char === '\u0003') {
          term.write('^C\r\n')
          line = ''
        } else {
          line += char
          term.write(char)
        }
      }
    })

    // 宿主推上来的输出只认自己那个会话 id。
    const offData = native.on('dock-data', (data) => {
      if (data === null || typeof data !== 'object') return
      const record = data as { id?: unknown; data?: unknown }
      if (typeof record.id !== 'string' || record.id !== sessionRef.current) return
      if (typeof record.data === 'string') term.write(record.data)
    })

    return () => {
      onData.dispose()
      offData()
      observer.disconnect()
      const id = sessionRef.current
      sessionRef.current = ''
      if (id !== '') void native.invoke('terminal', ['term-kill', { id }]).catch(() => undefined)
      termRef.current = null
      fitRef.current = null
      term.dispose()
    }
    // native 每次渲染都是新对象，但它的行为只取决于全局桥；装配只做一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 起一个 shell。只有这一条路会调 term-spawn（用户显式动作）。 */
  const start = (): void => {
    const term = termRef.current
    if (term === null || sessionRef.current !== '') return
    setBusy(true)
    setNote({ tone: 'info', text: `正在启动 ${shellLabel(shell)}…` })
    void native
      .invoke<{ id: string; shell: string }>('terminal', ['term-spawn', { cwd: '.', shell }])
      .then((spawned) => {
        sessionRef.current = spawned.id
        setNote({ tone: 'info', text: `${shellLabel(shell)} 已就绪（${spawned.id}）` })
        try {
          fitRef.current?.fit()
        } catch {
          // 面板此刻不可见时忽略
        }
      })
      .catch((error: unknown) => {
        // 常见失败：目标 shell 没装（pwsh 未装、Git Bash 不在 PATH）
        setNote({ tone: 'error', text: `启动失败：${error instanceof Error ? error.message : String(error)}` })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  /** 关掉当前会话（进程被杀，面板留着，可以再启动）。 */
  const stop = (): void => {
    const id = sessionRef.current
    if (id === '') return
    sessionRef.current = ''
    setNote({ tone: 'info', text: '会话已结束' })
    void native.invoke('terminal', ['term-kill', { id }]).catch(() => undefined)
  }

  return (
    <div className="term-pane">
      <div className="term-bar">
        <span className="shell-term-note">Shell</span>
        <select
          className="shell-select"
          aria-label="选择 shell"
          value={shell}
          disabled={sessionRef.current !== ''}
          onChange={(event) => {
            onShell(event.target.value as ShellId)
          }}
        >
          {SHELLS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn-ghost" disabled={busy} onClick={start}>
          启动
        </button>
        <button type="button" className="btn-ghost" onClick={stop}>
          结束
        </button>
        <span className="shell-term-note" data-tone={note.tone}>
          {note.text}
        </span>
      </div>
      <div className="term-host" ref={hostRef} />
    </div>
  )
}

/** shell 的显示名（未知取值回落成它自己）。 */
function shellLabel(shell: ShellId): string {
  return SHELLS.find((item) => item.id === shell)?.label ?? shell
}

/** 终端字号跟着正文那一档走（`--dsc-fs-code`，实际值如 `11.2px`）。 */
function readFontSize(): number {
  const text = readCssValue('--dsc-fs-code', '12px')
  const value = Number.parseFloat(text)
  return Number.isFinite(value) && value >= 6 && value <= 40 ? value : 12
}

/**
 * 终端配色：从现有令牌读，不写死色值（换主题时终端跟着换）。
 * 读不出来的项**不塞进 theme**——塞 undefined 会被 xterm 当成一次非法赋值。
 */
function readTheme(): Record<string, string> {
  const theme: Record<string, string> = {}
  const pick = (key: string, token: string): void => {
    const color = readCssColor(token)
    if (color !== null) theme[key] = color
  }
  pick('background', '--dsc-bg-side')
  pick('foreground', '--dsc-text-primary')
  pick('cursor', '--dsc-accent')
  pick('selectionBackground', '--dsc-accent')
  pick('red', '--dsc-red')
  pick('green', '--dsc-green')
  pick('yellow', '--dsc-yellow')
  pick('blue', '--dsc-accent')
  pick('magenta', '--dsc-purple')
  pick('cyan', '--dsc-cyan')
  return theme
}
