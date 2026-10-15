/**
 * 内置插件：浏览器（右侧栏的浏览器页签，**可多开**）——旧桌面版 `Dock.tsx` 的 BrowserPane
 * 同构，形态对齐 dsh（浏览器的页签条就是右侧栏的页签条，一张页签一台视图）。
 *
 * 内容不是 web 文档里的 iframe，而是**主进程的原生 `WebContentsView` 覆盖层**：
 * 视图 id 就是页签 id，页面只报「哪一台、摆哪儿」——
 *   - `dockBrowser` 显示/摆位（矩形是页面坐标 = 窗口内容坐标），隐藏时只摘下来不销毁；
 *   - `browserNav` 导航（load / back / forward / reload）；
 *   - `browserClose` 关页签 / 切会话时销毁那一台（不然渲染进程会一路攒下去）；
 *   - `browser-state` 把地址 / 标题 / 前后退 / 加载中推回来；
 *   - `browser-open-requested` 把网页自己要开的窗口推回来 → 转成一张新页签（对齐 dsh：
 *     主进程 deny 原生弹窗，壳开新页签；旧做法是就地 loadURL，等于把当前页顶掉）。
 * 全走原生桥（白名单 + 校验），与终端同一条通道；浏览器里（没有桥）这一页给一句人话。
 *
 * 三条状态纪律：
 *   - **地址栏的草稿与页面地址分开**：正在编辑时不被页面跳转覆盖，不然打字打到一半就被冲掉；
 *   - **地址与标题回填到页签**（`setTabInfo`）：chip 上看到网页标题，重开那张页签回到那个
 *     地址（布局按会话落盘）；
 *   - **隐藏的页签不加载**：切走只把视图摘下来（页面留着），第一次露出来才 load。
 *     否则光打开一个会话就会把一堆网页拉起来。
 *
 * 空态：新页签不自动加载任何页面（对齐 dsh，旧版是硬开 bing），地址栏回车才进。
 *
 * @module dsc-ui-shell/plugins/browser
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  defineUiPlugin,
  dockActions,
  getHostNative,
  IconGlobe,
  IconRefresh,
  openDockBrowserTab,
  registerDockTab,
  type DockTabBodyProps,
} from '@dsc/ui'
import { normalizeAddress } from './address'

/** 这一台页签现在看到的页面状态（原生层推上来的那份）。 */
interface PageState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

const NO_PAGE: PageState = { url: '', title: '', canGoBack: false, canGoForward: false, loading: false }

export default defineUiPlugin({
  name: '浏览器',
  apply() {
    registerDockTab({
      kind: 'browser',
      label: '浏览器',
      icon: <IconGlobe size={13} />,
      component: BrowserTab,
      // 切页签只藏不卸：视图留着，切回来页面还在（与终端同一条）
      keepMounted: true,
    })
    // 桌面主进程 → 壳的两条**全局**事件（agent 那条链路的开户通路）：
    //   - `browser-tab-open-request`  `{ id, url? }`：请壳开一张页签并聚焦，
    //     id 由桌面侧发号（`agent-N`），壳必须照用——宿主的视图台账按这个 id 认台；
    //   - `browser-tab-close-request` `{ id }`：请壳关掉那张页签（免得留下一个点不开的空页签）。
    //
    // 为什么订阅挂在**插件注册处**而不是 BrowserTab 那个 React 组件里：这两条事件是全局的
    // （载荷里的 id 指名要动哪一张），而组件是**每张页签一份**——写在组件里的话，N 张页签
    // 会各收到一次、同一张页签被开/关 N 次（既有的 `browser-open-requested` 是 per-tab 的，
    // 它按 `payload.id !== viewId` 过滤，语义不同，别混）。
    const native = getHostNative()
    const offOpen = native.on('browser-tab-open-request', (request) => {
      if (request === null || typeof request !== 'object') return
      const payload = request as Record<string, unknown>
      const id = payload['id']
      if (typeof id !== 'string' || id === '') return
      // 地址可能是空串 / 非字符串（新页签可以是空态，也可以随后由 browser-call 导航过去）：
      // 与既有 `browser-open-requested` 同一条校验口径，整不出地址就当空态开出来。
      const url = payload['url']
      openDockBrowserTab(typeof url === 'string' && url !== '' ? url : undefined, id)
    })
    const offClose = native.on('browser-tab-close-request', (request) => {
      if (request === null || typeof request !== 'object') return
      const payload = request as Record<string, unknown>
      const id = payload['id']
      if (typeof id !== 'string' || id === '') return
      dockActions.closeTab(id)
    })
    // 退订交回装载器（`apply` 的返回值就是「卸载这个插件时调」的清理函数，见 UiPluginModule）。
    return () => {
      offOpen()
      offClose()
    }
  },
})

/** 浏览器页签体：工具条 + 原生视图的占位区（视图画在占位区之上）。 */
function BrowserTab({ tab, active, expanded }: DockTabBodyProps): ReactNode {
  const native = getHostNative()
  const holder = useRef<HTMLDivElement | null>(null)
  const [page, setPage] = useState<PageState>(NO_PAGE)
  const [draft, setDraft] = useState(tab.path ?? '')
  const [error, setError] = useState('')
  /** 这一张页签进过页面没有（进过就不再重复 load，切回来是接着看而不是重新加载）。 */
  const loaded = useRef(false)
  /** 视图已经在窗口上摆好了没有（决定「回车」是直接导航还是等视图起来）。 */
  const bound = useRef(false)
  /** 视图还没起来时先记下要去的地址，等它起来再 load。 */
  const pending = useRef<string | null>(null)
  /** 光标在地址栏里（这期间页面跳转不许覆盖草稿）。 */
  const editing = useRef(false)
  /** 地址栏现在非空就该把视图挂出来（空态不挂：挂了空白页会盖住那行提示）。 */
  const [started, setStarted] = useState(tab.path !== undefined && tab.path !== '')
  const viewId = tab.id
  const visible = active && expanded

  // 装配：订阅这一台的推送 + 卸载时销毁视图。装配只做一次——viewId 是页签 id，
  // 页签的生灭就是这块组件的生灭（切页签只藏不卸，切会话才真的重挂）。
  useEffect(() => {
    if (!native.available) return undefined
    const offState = native.on('browser-state', (state) => {
      if (state === null || typeof state !== 'object') return
      const payload = state as Record<string, unknown>
      // 事件是所有页签共用的一条通道：只认自己这一台
      if (payload['id'] !== viewId) return
      const url = typeof payload['url'] === 'string' ? payload['url'] : ''
      const title = typeof payload['title'] === 'string' ? payload['title'] : ''
      setPage({
        url,
        title,
        canGoBack: payload['canGoBack'] === true,
        canGoForward: payload['canGoForward'] === true,
        loading: payload['loading'] === true,
      })
      if (!editing.current) setDraft(url)
      // 回填页签：标题进 chip、地址存回页签（重开这张回到这一页）。
      // 空值不覆盖已有值——加载中的那几拍 url/title 可能是空的。
      if (url !== '' || title !== '') {
        dockActions.setTabInfo(viewId, {
          ...(title === '' ? {} : { label: title }),
          ...(url === '' ? {} : { path: url }),
        })
      }
    })
    const offOpen = native.on('browser-open-requested', (request) => {
      if (request === null || typeof request !== 'object') return
      const payload = request as Record<string, unknown>
      if (payload['id'] !== viewId) return
      const url = payload['url']
      // 网页自己开的窗口 → 新页签（不是顶掉当前页）
      if (typeof url === 'string' && url !== '') openDockBrowserTab(url)
    })
    return () => {
      offState()
      offOpen()
      void native.invoke('browserClose', [viewId]).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 可见性 / 几何 / 首次加载：露出来才摆位置并进页面，藏起来只摘下视图。
  useEffect(() => {
    if (!native.available) return undefined
    const element = holder.current
    if (element === null) return undefined
    if (!visible || !started) {
      bound.current = false
      void native.invoke('dockBrowser', [viewId, false]).catch(() => undefined)
      return undefined
    }
    /**
     * 这一块的几何还没落定之前不许上报。
     *
     * 为什么：侧栏展开是从右缘**滑进来**的（靠 transform 做过渡），而
     * `getBoundingClientRect()` 会把变换算进去——实测在过渡那一拍量到的是窗口外的
     * 矩形（窗口 1440 宽、报出去 x=1861）。原生视图一旦被摆到窗口外，Chromium 会把
     * 它的视口塌成 0×0（页面 `document.hidden` 变 true、`elementFromPoint` 恒 null），
     * 于是**点击落在空处、截图一片空白**。而 transform 变化既不触发 ResizeObserver
     * 也不触发 window resize——不在这里重试，这一错会一直错到底（实测：整轮走查都停在
     * 那次错的摆位上，侧栏里那块是空的）。
     *
     * 到帧数上限就照报：宁可让主进程拿到一个坏矩形（它那边有诊断行），也不能把
     * 「摆位」这件事永远挂着不办。
     */
    const RECT_SETTLE_FRAMES = 120
    let settleFrames = 0
    let settleRaf: number | null = null
    const reportNow = (rect: DOMRect): void => {
      void native
        .invoke<boolean>('dockBrowser', [
          viewId,
          true,
          { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        ])
        .then((ok) => {
          // 回执写进 data 属性：自检靠它证「原生视图层真的接住了」（拍不到原生层，
          // DOM 里只看得到占位区；false 说明主进程没接住——窗口引用/桥版本问题）。
          element.dataset.browserBound = ok === false ? '0' : '1'
          bound.current = ok !== false
          if (!bound.current || loaded.current) return
          const target = pending.current ?? (tab.path === undefined || tab.path === '' ? null : tab.path)
          if (target === null) return
          pending.current = null
          loaded.current = true
          void native.invoke('browserNav', [target, 'load', viewId]).catch(() => undefined)
        })
        .catch(() => {
          element.dataset.browserBound = '0'
          bound.current = false
        })
    }
    const report = (): void => {
      const rect = element.getBoundingClientRect()
      // 「至少有一块落在视口里」才算可用：完全落在外面的矩形会让原生视图的视口塌成 0。
      const usable =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.x < window.innerWidth &&
        rect.y < window.innerHeight
      if (!usable && settleFrames < RECT_SETTLE_FRAMES) {
        settleFrames += 1
        if (settleRaf === null) {
          settleRaf = requestAnimationFrame(() => {
            settleRaf = null
            report()
          })
        }
        return
      }
      reportNow(rect)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      if (settleRaf !== null) cancelAnimationFrame(settleRaf)
    }
    // tab.path 只在「切到可见」这一刻读一次：之后地址由页面自己推回来（browser-state），
    // 把它放进依赖会让每次导航都重跑一遍挂卸。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, started])

  if (!native.available) {
    return (
      <p className="shell-term-empty">
        内置浏览器来自桌面外壳的原生视图，浏览器里没有它。要用请打开桌面版（或者用「系统打开」跳出去看）。
      </p>
    )
  }

  const navigate = (action: 'load' | 'back' | 'forward' | 'reload', url?: string): void => {
    void native
      .invoke('browserNav', [action === 'load' ? (url ?? page.url) : page.url, action, viewId])
      .catch((reason: unknown) => {
        setError(`浏览器：${reason instanceof Error ? reason.message : String(reason)}`)
      })
  }

  /** 地址栏回车：整成可加载地址再进；整不出来就地给一句人话。 */
  const go = (): void => {
    const target = normalizeAddress(draft)
    if (target === null) {
      setError(draft.trim() === '' ? '先输一个地址' : '只支持 http/https 地址')
      return
    }
    setError('')
    setDraft(target)
    if (bound.current) {
      loaded.current = true
      navigate('load', target)
      return
    }
    // 视图还没起来（空态第一跳）：记下地址，等它起来那一刻再 load
    pending.current = target
    setStarted(true)
  }

  /** 用系统浏览器打开当前页（桥的 openExternal，实参过白名单校验）。 */
  const openOutside = (): void => {
    if (page.url === '') return
    void native.invoke('openExternal', [page.url]).catch((reason: unknown) => {
      setError(`打开失败：${reason instanceof Error ? reason.message : String(reason)}`)
    })
  }

  return (
    <div className="browser-pane">
      <div className="browser-bar">
        <button
          type="button"
          className="icon-btn"
          data-tip="后退"
          aria-label="后退"
          disabled={!page.canGoBack}
          onClick={() => navigate('back')}
        >
          ‹
        </button>
        <button
          type="button"
          className="icon-btn"
          data-tip="前进"
          aria-label="前进"
          disabled={!page.canGoForward}
          onClick={() => navigate('forward')}
        >
          ›
        </button>
        <button
          type="button"
          className="icon-btn"
          data-loading={page.loading ? '1' : undefined}
          data-tip={page.loading ? '正在加载…' : '刷新'}
          aria-label="刷新"
          disabled={!started}
          onClick={() => navigate('reload')}
        >
          <IconRefresh size={13} />
        </button>
        <input
          className="browser-url"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => {
            editing.current = true
          }}
          onBlur={() => {
            editing.current = false
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') go()
          }}
          placeholder="输入 HTTP(S) 地址，回车打开"
          spellCheck={false}
          aria-label="地址"
        />
        <button
          type="button"
          className="icon-btn"
          data-tip="用系统浏览器打开"
          aria-label="用系统浏览器打开"
          disabled={page.url === ''}
          onClick={openOutside}
        >
          <OpenOutsideGlyph />
        </button>
      </div>
      {error === '' ? null : <div className="browser-error">{error}</div>}
      {/* WebContentsView 原生层渲染在这块区域之上 */}
      <div ref={holder} className="browser-holder" data-browser-view={viewId}>
        {started ? null : <p className="browser-empty">输入 HTTP(S) 地址开始浏览</p>}
      </div>
    </div>
  )
}

/** 「用系统浏览器打开」的图形（方框右下角一支向外的箭头）。 */
function OpenOutsideGlyph(): ReactNode {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M9.6 3.2h3.2v3.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.8 3.2 7.6 8.4" strokeLinecap="round" />
      <path d="M6.4 4.4H4.2a1.4 1.4 0 0 0-1.4 1.4v6a1.4 1.4 0 0 0 1.4 1.4h6a1.4 1.4 0 0 0 1.4-1.4v-2.2" strokeLinecap="round" />
    </svg>
  )
}
