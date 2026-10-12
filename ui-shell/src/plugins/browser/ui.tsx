/**
 * 内置插件：浏览器（右侧栏的浏览器页签）——旧桌面版 `Dock.tsx` 的 BrowserPane 同构。
 *
 * 内容不是 web 文档里的 iframe，而是**主进程的原生 `WebContentsView` 覆盖层**：
 * 页面只报「显示在哪」——`dockBrowser` 打开/摆位（矩形是页面坐标 = 窗口内容坐标），
 * `browserNav` 导航，地址变化经 `browser-state` 事件推回来。全走原生桥（白名单 + 校验），
 * 与终端同一条通道；浏览器里（没有桥）这一页给一句人话。
 *
 * URL 记忆在 localStorage（`dsc.dock.browserUrl`，与旧界面同键）：页签切走会卸载
 * 这块面板（原生视图跟着收起），重开时回到上次浏览的地址，而不是每次都回首页。
 *
 * @module dsc-ui-shell/plugins/browser
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  defineUiPlugin,
  getHostNative,
  IconGlobe,
  IconRefresh,
  registerDockTab,
  toastErr,
  type DockTabBodyProps,
} from '@dsc/ui'

/** URL 记忆键（与旧界面同一份，两个界面共享用户习惯）。 */
const URL_KEY = 'dsc.dock.browserUrl'
/** 没存过时的首页（旧界面同款）。 */
const HOME_URL = 'https://www.bing.com'

export default defineUiPlugin({
  name: '浏览器',
  apply() {
    registerDockTab({ kind: 'browser', label: '浏览器', icon: <IconGlobe size={13} />, component: BrowserTab })
  },
})

/** 浏览器页签体：地址栏 + 原生视图的占位区（视图画在占位区之上）。 */
function BrowserTab(_props: DockTabBodyProps): ReactNode {
  const native = getHostNative()
  const holder = useRef<HTMLDivElement | null>(null)
  // URL 记忆在 localStorage：页签切走会卸载这块面板（WebContentsView 收起），
  // 重开时回到上次浏览的地址，而不是每次都回首页
  const [url, setUrl] = useState(readSavedUrl)
  const [address, setAddress] = useState(readSavedUrl)

  useEffect(() => {
    if (!native.available) return undefined
    const element = holder.current
    if (element === null) return undefined
    const report = (): void => {
      const rect = element.getBoundingClientRect()
      void native
        .invoke('dockBrowser', [true, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }])
        .catch(() => undefined)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    const offState = native.on('browser-state', (state) => {
      if (state === null || typeof state !== 'object') return
      const next = (state as { url?: unknown }).url
      if (typeof next !== 'string' || next === '') return
      setUrl(next)
      setAddress(next)
      try {
        localStorage.setItem(URL_KEY, next)
      } catch {
        // 存不下就只影响下次打开浏览器页签时的记忆地址
      }
    })
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      offState()
      void native.invoke('dockBrowser', [false]).catch(() => undefined)
    }
    // native 每次渲染都是新对象，但行为只取决于全局桥；装配只做一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!native.available) {
    return (
      <p className="shell-term-empty">
        内置浏览器来自桌面外壳的原生视图，浏览器里没有它。要用请打开桌面版（或者用「用系统程序打开」跳出去看）。
      </p>
    )
  }

  const navigate = (action: 'load' | 'back' | 'forward' | 'reload'): void => {
    void native.invoke('browserNav', [action === 'load' ? address : url, action]).catch((reason: unknown) => {
      toastErr(`浏览器：${reason instanceof Error ? reason.message : String(reason)}`)
    })
  }

  return (
    <div className="browser-pane">
      <div className="browser-bar">
        <button type="button" className="icon-btn" data-tip="后退" aria-label="后退" onClick={() => navigate('back')}>
          ‹
        </button>
        <button type="button" className="icon-btn" data-tip="前进" aria-label="前进" onClick={() => navigate('forward')}>
          ›
        </button>
        <button type="button" className="icon-btn" data-tip="刷新" aria-label="刷新" onClick={() => navigate('reload')}>
          <IconRefresh size={13} />
        </button>
        <input
          className="browser-url"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') navigate('load')
          }}
          spellCheck={false}
          aria-label="地址"
        />
      </div>
      {/* WebContentsView 原生层渲染在这块区域之上 */}
      <div ref={holder} className="browser-holder" />
    </div>
  )
}

/** 读存过的地址（没有/存坏就回首页）。 */
function readSavedUrl(): string {
  try {
    const saved = localStorage.getItem(URL_KEY)
    return saved !== null && saved !== '' ? saved : HOME_URL
  } catch {
    return HOME_URL
  }
}
