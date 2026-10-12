/**
 * 内置插件：终端（停靠面板里的那一个页签）。
 *
 * ## 与旧界面一致、改的时候别破坏的事
 *
 * 1. **管道模式**：宿主的 `term-spawn` 起的是非交互子进程（pwsh / cmd / bash / node，
 *    见 `src/plugins/desktop-dock.ts`），没有 tty，所以**行编辑由界面自己做**——
 *    回车前由这里维护输入行、本地回显、退格本地编辑，回车才把整行 + `\n` 发下去。
 *    交互式全屏程序（vim、top）在这个模式下不可用，这是管道模式的固有代价。
 * 2. **首次可见即起 shell**（旧界面 `Dock.tsx` 的 TerminalPane 同款）：面板第一次被
 *    翻开就 spawn 一个 shell，栏里只留一枚 Shell 下拉（切换 = 杀旧起新）；不摆
 *    「启动 / 结束」两颗钮。这条 2026-10 按用户「完全复刻旧版」的裁定回改过一版
 *    （更早的形态是显式点「启动」），别改回显式按钮。
 * 3. **终端只走原生桥**：界面 HTTP 面里没有 `term-*`（放行面的 op 枚举是读 + 写），
 *    所以浏览器 / 远程壳里这一块**必然**缺席——那时显示一句话，而不是报错崩掉。
 * 4. **shell 选择记在 localStorage**（`dsc.dockShell`，与旧界面同键）：重开界面回到
 *    上次那个 shell。
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
import {
  defineUiPlugin,
  getHostNative,
  IconTerminal,
  readCssColor,
  readCssValue,
  registerDockTab,
  useHostSelector,
  type DockTabBodyProps,
  type HostSnapshot,
} from '@dsc/ui'
import { Select } from '../../platform/select'

/** 终端 shell 候选：与宿主 `spawnShell` 的白名单一致（对不上会被宿主回落成 PowerShell）。 */
const SHELL_OPTIONS = [
  { value: 'powershell', label: 'PowerShell', prompt: 'PS>' },
  { value: 'pwsh', label: 'PowerShell 7 (pwsh)', prompt: 'PS>' },
  { value: 'cmd', label: 'CMD', prompt: '>' },
  { value: 'bash', label: 'Git Bash', prompt: '$' },
  { value: 'node', label: 'Node REPL', prompt: '>' },
] as const

type ShellValue = (typeof SHELL_OPTIONS)[number]['value']

/** shell 记忆键：与旧界面同一份（两个界面共享用户习惯）。 */
const SHELL_KEY = 'dsc.dockShell'

export default defineUiPlugin({
  name: '终端',
  apply() {
    // 报名一种页签界面（kind = 'terminal'）：壳的页签条与页签体照它画，多开由壳
    // 按页签各挂一个实例（旧桌面版「终端可无限多开」同款）。keepMounted：切页签 /
    // 切窗格 / 收起侧栏都只藏不卸，spawn 出来的 shell 与输出缓冲都活着。
    registerDockTab({
      kind: 'terminal',
      label: '终端',
      icon: <IconTerminal size={13} />,
      component: TerminalTab,
      keepMounted: true,
    })
  },
})

/**
 * 终端页签体：原生桥不在（浏览器 / 远程壳）时给一句人话；桌面窗口里是一台完整终端。
 *
 * 保活对齐旧桌面版（「收起=滑出右缘不卸载」）：内容永远渲染，不是自己回合时由壳
 * 用 display:none 藏住——组件树与 spawn 出来的进程都活着，重新展开原样接上。
 * 卸载只发生在整壳关闭（或这张页签被关掉）。
 */
function TerminalTab({ active }: DockTabBodyProps): ReactNode {
  const native = getHostNative()
  const [shell, setShell] = useState<ShellValue>(() => {
    let saved: string | null = null
    try {
      saved = localStorage.getItem(SHELL_KEY)
    } catch {
      // 隐私模式读不到就当没存过
    }
    return SHELL_OPTIONS.some((option) => option.value === saved) ? (saved as ShellValue) : 'powershell'
  })

  if (!native.available) {
    return (
      <p className="shell-term-empty">
        终端来自桌面外壳的原生桥，浏览器里没有它。要用终端请打开桌面版（或者在终端里跑
        <code> msc</code>）。
      </p>
    )
  }
  return <TerminalPane shell={shell} visible={active} onShell={setShell} />
}

/**
 * 一台终端：首次可见起 shell → 输入 → 收输出。
 *
 * 生命周期与桌面端一致（收起仍保活）：面板收起或被别的面板顶替时组件只是被
 * `data-hidden` 藏住，spawn 出来的进程与终端缓冲都活着；整个壳卸载才会杀会话。
 * 切换 Shell 下拉 = 杀旧会话、按新 shell 重开（旧界面 pickShell 同款）。 */
function TerminalPane({ shell, visible, onShell }: { shell: ShellValue; visible: boolean; onShell: (next: ShellValue) => void }): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const native = getHostNative()
  const cwd = useHostSelector(readCwd)
  // 会话 id、终端实例与当前 shell 都放在 ref 里：它们跨渲染存活，且改动不该触发重画。
  const sessionRef = useRef('')
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const shellRef = useRef(shell)
  shellRef.current = shell
  const [error, setError] = useState('')
  // 首次可见才起进程（旧界面同款：dock 常驻挂载，不能一开应用就 spawn）。
  const [booted, setBooted] = useState(false)
  useEffect(() => {
    if (visible && !booted) setBooted(true)
  }, [visible, booted])

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
    // 面板宽度会变（窗口大小、拖宽），不重排的话 xterm 的网格还是旧的。
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

    // 行缓冲：管道 stdin 没有行编辑，回车之前这一行由界面自己维护。
    let line = ''
    let promptShown = false
    const promptOf = (): string => SHELL_OPTIONS.find((option) => option.value === shellRef.current)?.prompt ?? ''
    const shellLabelOf = (): string => SHELL_OPTIONS.find((option) => option.value === shellRef.current)?.label ?? ''
    const showPrompt = (): void => {
      if (!promptShown && sessionRef.current !== '') {
        term.write(`\x1b[90m${promptOf()}\x1b[0m `)
        promptShown = true
      }
    }
    const onData = term.onData((data) => {
      const id = sessionRef.current
      if (id === '') return
      for (const char of data) {
        if (char === '\r') {
          // 回车：本地回显换行，发送整行；空行也发一个换行（shell 会重画提示符）
          term.write('\r\n')
          const command = line
          line = ''
          promptShown = false
          void native.invoke('terminal', ['term-input', { id, data: `${command}\n` }]).catch(() => undefined)
        } else if (char === '\u007f') {
          if (line.length > 0) {
            line = line.slice(0, -1)
            term.write('\b \b')
          }
        } else if (char === '\u0003') {
          // Ctrl+C：取消当前行（管道模式无法中断运行中的命令）
          term.write('^C')
          line = ''
          promptShown = false
          showPrompt()
        } else {
          line += char
          term.write(char)
        }
      }
    })

    // 宿主推上来的输出只认自己那个会话 id；输出落定后再补提示符（管道模式不回显命令）。
    const offData = native.on('dock-data', (data) => {
      if (data === null || typeof data !== 'object') return
      const record = data as { id?: unknown; data?: unknown }
      if (typeof record.id !== 'string' || record.id !== sessionRef.current) return
      if (typeof record.data !== 'string') return
      term.write(record.data.replace(/\n/g, '\r\n'))
      if (record.data.includes('\n')) {
        promptShown = false
        showPrompt()
      }
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

  // 起 shell：首次可见、或切了 Shell 下拉时（切 = 杀旧起新）。
  useEffect(() => {
    if (!booted || cwd === null || cwd === '') return
    const term = termRef.current
    if (term === null) return
    const previous = sessionRef.current
    sessionRef.current = ''
    if (previous !== '') void native.invoke('terminal', ['term-kill', { id: previous }]).catch(() => undefined)
    setError('')
    const meta = SHELL_OPTIONS.find((option) => option.value === shell) ?? SHELL_OPTIONS[0]
    term.writeln(`\x1b[90m${meta.label} · 管道模式：输入命令回车执行，不支持交互式全屏程序\x1b[0m\r\n`)
    void native
      .invoke<{ id: string }>('terminal', ['term-spawn', { cwd, shell }])
      .then((spawned) => {
        sessionRef.current = spawned.id
        try {
          fitRef.current?.fit()
        } catch {
          // 面板此刻不可见时忽略
        }
        term.write(`\x1b[90m${meta.prompt}\x1b[0m `)
      })
      .catch((reason: unknown) => {
        // 常见失败：目标 shell 没装（pwsh 未装、Git Bash 不在 PATH）
        const message = reason instanceof Error ? reason.message : String(reason)
        setError(`${meta.label} 启动失败：${message}`)
        term.write(`\r\n\x1b[31m${meta.label} 启动失败：${message}\x1b[0m\r\n`)
      })
    // cwd 只在切工作区时变（那时旧 shell 的目录已经不对了，重开一个在新目录）。
  }, [booted, cwd, shell, native])

  // 重新可见时重排：display:none 期间 xterm 量到的尺寸是 0。
  useEffect(() => {
    if (visible) {
      try {
        fitRef.current?.fit()
      } catch {
        // 忽略（下一轮 ResizeObserver 会再排）
      }
    }
  }, [visible])

  const pickShell = (value: ShellValue): void => {
    try {
      localStorage.setItem(SHELL_KEY, value)
    } catch {
      // 存不下（隐私模式/配额满）只影响下次启动的默认 shell，不该打断选择
    }
    onShell(value)
  }

  return (
    <div className="term-pane">
      <div className="term-bar">
        <span className="term-bar-label">Shell</span>
        <Select
          value={shell}
          options={SHELL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          onPick={pickShell}
          className="term-select"
          ariaLabel="终端 Shell"
        />
      </div>
      <div className="term-host" ref={hostRef} />
      {error === '' ? null : <div className="notice">{error}</div>}
    </div>
  )
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

/** 当前会话的工作目录（终端起 shell 的 cwd；与侧栏底部同一字段）。 */
function readCwd(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const value = (status as Record<string, unknown>)['cwd']
  return typeof value === 'string' && value !== '' ? value : null
}
