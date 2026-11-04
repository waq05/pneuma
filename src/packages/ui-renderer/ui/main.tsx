/**
 * 界面壳入口：取启动图 → 取骨架 → 建通道 → 建注册表 → 声明槽 → 装插件 → 挂载。
 *
 * 顺序不能反，而且现在多了一环「骨架」：
 *
 *   1. **启动图**先取（骨架从图里拿，与其它插件同一条路）；
 *   2. **骨架**（布局插件 `layout` 的产物）在首帧之前**显式 await**——它不是静态 import
 *      进壳的，而是 `lib/ui/plugins/layout/client.js`，装载器那条 require 表交给它的还是
 *      壳里那一份实例（`@dsc/ui` 已经把它的读 hook 转出给插件了，不能有第二份）；
 *   3. 通道由骨架提供，所以通道只能排在建完骨架之后；
 *   4. 槽必须**先声明**再让插件注册（注册到未声明的槽当场报错，这是刻意设计的——
 *      拼错槽名不该静默丢掉一整块界面），所以整体次序是 声明 → 加载 → 渲染。
 *
 * 骨架缺席（被停用、产物没构建、取字节失败）时**不画白屏**：{@link LayoutUnavailable}
 * 画一块诊断页，说清是哪一种、以及去哪把开关打开。
 *
 * 数据通道（SSE）与启动清单（`__DSC_BOOT__`）是两件事：清单决定装哪些插件，
 * 通道决定界面上显示什么状态。通道先建（它自己异步连），装插件时一并交给它们。
 *
 * @module dsc-ui-shell/ui-renderer/main
 */
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { SlotRegistry, ServiceRegistry, ServicesProvider, type UiBootGraph, type UiPrefsView } from '@dsc/ui-core'
import { onAppearanceRequest, type SlotFactoryMap, type SlotMap } from '@dsc/ui'
// 面板几何直接按包名取：骨架（布局插件里那份 @dsc/ui-layout）读的也是这个包，
// 同一份模块实例才拿得到启动时灌进去的那份值。
import { primePanelGeometry, setPanelGeometrySaver } from '@dsc/ui-primitives'
import {
  ALLOWED_MODULES,
  createBootSession,
  loadPluginModule,
  readBootGraph,
  type UiBootSession,
} from './boot'
import { startPluginHmr, type UiPluginHmr } from './hmr'
import { SHELL_SLOTS, type ShellSlot } from '@dsc/ui-slots'
import type { UiComponent, UiSlots } from '@dsc/ui'
// 顺序即层叠：令牌 → 全局基线 → 原语 → 各视图（从旧渲染层原样搬来的四份）
// → 壳自己的补充。反了就会互相覆盖，与旧渲染层 main.tsx:6-9 同一套次序。
// 样式随入口一起住本包的 `styles/`：`legacy/` 是从旧渲染层逐字节搬来的四份
// （改它们等于改旧界面，走 `src/packages/ui-renderer/ui/styles/legacy/PROVENANCE.md` 的规矩），`styles.css`
// 是壳新增的补充层。层叠顺序不能反，理由见 `styles/styles.css` 抬头。
import './styles/legacy/tokens.css'
import './styles/legacy/base.css'
import './styles/legacy/primitives.css'
import './styles/legacy/views.css'
// 终端（xterm）的样式必须由**壳**加载：插件 bundle 是纯 JS，带不了 CSS 文件，
// 而 xterm 的网格与滚动条要靠它自己的样式表才画得对。放在 legacy 之后、styles.css 之前。
import '@xterm/xterm/css/xterm.css'
import './styles/styles.css'
// 老内核的调色板兜底（**生成物**，见 ui-shell/scripts/build-color-fallback.mjs）。
// 必须排在最后：它整块包在 `@supports not (color: color-mix(...))` 里，靠**源码序**压过
// tokens.css 那批 color-mix 令牌（同特异性，后写的赢）；认得 color-mix 的内核整块不生效。
import './styles/legacy-color-fallback.css'

/** 取不到清单时的启动图（空壳 + 一条诊断，比白屏好查）。 */
const UNAVAILABLE_BOOT: UiBootGraph = {
  rev: 'unavailable',
  entries: [],
  batches: [],
  host: { name: 'Pneuma', version: '未知版本' },
}

/**
 * 布局插件的**产物 id**（`lib/ui/plugins/layout/`）。
 *
 * 与行 id `ui-layout` 差一个 `ui-` 前缀：产物目录名 / 启动图条目用前者，插件开关用后者
 * （换算只写在 `src/core/ui-bundles.ts` 的 `builtinSwitchKey`）。
 */
const LAYOUT_ID = 'layout'

/**
 * 布局产物的导出面：就是 `@dsc/ui-layout` 那棵树。
 *
 * 这里只借**类型**（`typeof import()` 在编译期擦除、运行期不产生 import）——实现必须来自
 * 启动图里那一份，否则「停用就真的不装」这条开关就是假的。
 */
type LayoutSurface = typeof import('@dsc/ui-layout')

/** 骨架缺席的三种来路（诊断页按它写标题与下一步）。 */
interface LayoutFailure {
  /** 一句话说清是哪一种。 */
  reason: string
  /** 更细的原因（错误原文 / 缺哪一条），没有就是 null。 */
  detail: string | null
}

/**
 * 首帧先按上次的外观镜像上色，再向宿主问一次真值。
 *
 * 为什么要有镜像这一手：宿主回读是异步的，等它回来才上色的话，浅色主题的用户每次
 * 打开都会先闪一下深色。镜像读不出来就按默认深色起，不影响后面这一次覆盖。
 *
 * 为什么失败只告警不抛：外观拿不到顶多是配色不对，界面还能用；把启动卡死在这里
 * 才是真的用不了。
 *
 * @param layout - 启动图里取回来的骨架导出面（外观落地只有这一份实现）
 * @param prefs - 已经发出去的那次 `getUiPrefs`
 */
async function syncAppearance(
  layout: LayoutSurface,
  prefs: Promise<UiPrefsView | null>,
): Promise<void> {
  layout.applyAppearance(layout.loadCachedAppearance())
  const loaded = await prefs
  if (loaded === null) return
  appearance = layout.appearanceFromPrefs(loaded)
  layout.applyAppearance(appearance)
  layout.saveCachedAppearance(appearance)
}

/**
 * 给一个可能永远不回的请求加个期限。
 *
 * 面板几何必须在上屏前拿到（否则先画默认宽再跳一下），但宿主真卡住时也不能让页面
 * 一直空着——过期就当没读到，按默认宽起。
 */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      window.setTimeout(() => {
        resolve(null)
      }, ms)
    }),
  ])
}

/**
 * 最后一次生效的外观：设置面板改一项时以它为底。
 *
 * `null` = 骨架还没装上来（那时候也不该有插件在改外观）。类型按骨架导出的默认值取，
 * 免得在这里另抄一份形状。
 */
type Appearance = LayoutSurface['DEFAULT_APPEARANCE']
let appearance: Appearance | null = null

/** 骨架装上来之后的导出面：外观落地与诊断两处都要按它走。 */
let layoutSurface: LayoutSurface | null = null

/**
 * 把「外观改动的请求」接到真正的那份实现上。
 *
 * 为什么绕一道（`requestAppearance` → 这里）：`applyAppearance` 带着模块级状态
 * （最近报出去的控件条颜色、跟随系统的监听），**只该有一份**。插件 bundle 里内联一份
 * 就会出现两个 applier；而外观又是"插件改、壳落地"的事，所以插件只发请求。
 *
 * 这一条在模块加载时就注册（早于任何插件 apply），骨架还没取回来时是空操作。
 *
 * 写盘由插件自己做（它调 `setUiPrefs`）——这里只负责让界面立刻跟上与记住镜像。
 */
onAppearanceRequest((patch) => {
  const layout = layoutSurface
  if (layout === null) return
  appearance = { ...(appearance ?? layout.DEFAULT_APPEARANCE), ...patch }
  layout.applyAppearance(appearance)
  layout.saveCachedAppearance(appearance)
})

/**
 * 让出启动占位（`index.html` 里那块盖在上面的 `#boot-splash`）。
 *
 * 为什么要等两帧：`createRoot().render()` 的首次提交是排队的，立刻删会让占位在界面
 * 画出来之前就消失——那正是要避免的「中间空一帧」。两帧之后界面已经在下面了，淡出
 * 160ms 把「换文档」和「第二批插件装上来」这两跳一起盖过去。
 */
function dismissBootSplash(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const splash = document.getElementById('boot-splash')
      if (splash === null) return
      splash.classList.add('boot-splash--done')
      window.setTimeout(() => {
        splash.remove()
      }, 240)
    })
  })
}

/**
 * 骨架缺席时的诊断页。
 *
 * 为什么一定要有它：`ui-layout` 现在是**能停用的插件**，开关的意义就在于关掉之后还能
 * 看见东西——白屏会让人以为是壳坏了，而实际只是一行开关。这里给三样：哪一行没了、
 * 为什么、去哪儿打开它。
 *
 * 样式全内联：这一页在骨架之外运行，不能依赖 `styles/` 里那套（那些类名是给 App 用的）。
 */
function LayoutUnavailable({ failure }: { failure: LayoutFailure }): ReactNode {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 24px',
        boxSizing: 'border-box',
        background: '#1b1b1c',
        color: '#e8e6e1',
        font: '14px/1.7 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      }}
    >
      <div style={{ maxWidth: 640, width: '100%' }}>
        <h1 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 600 }}>
          界面布局（ui-layout）{failure.reason}
        </h1>
        <p style={{ margin: '0 0 12px', color: '#b9b5ad' }}>
          整张页面只有骨架能画出来。骨架没装上来，所以这里只剩这条说明——不是白屏，是它真的不在。
        </p>
        <p style={{ margin: '0 0 12px', color: '#b9b5ad' }}>
          打开它的地方：编辑 <code style={{ color: '#e8e6e1' }}>~/.dsc/plugins.json</code>，找到{' '}
          <code style={{ color: '#e8e6e1' }}>&quot;file&quot;: &quot;ui-layout&quot;</code> 那一条，
          把 <code style={{ color: '#e8e6e1' }}>&quot;disabled&quot;</code> 改成{' '}
          <code style={{ color: '#e8e6e1' }}>false</code>（或删掉那一条），然后刷新本页。
          宿主重启后它也会回到插件中心的内置插件列表里。
        </p>
        {failure.detail === null ? null : (
          <pre
            style={{
              margin: '16px 0 0',
              padding: '12px 14px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: '#232324',
              border: '1px solid #343436',
              borderRadius: 6,
              color: '#d8d3c8',
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            {failure.detail}
          </pre>
        )}
      </div>
    </div>
  )
}

/** 把诊断页画到 #root 上，并且让启动占位退场（否则它盖住诊断）。 */
function renderLayoutUnavailable(container: HTMLElement, failure: LayoutFailure): void {
  createRoot(container).render(
    <StrictMode>
      <LayoutUnavailable failure={failure} />
    </StrictMode>,
  )
  dismissBootSplash()
}

async function bootstrap(): Promise<void> {
  const container = document.getElementById('root')
  if (container === null) throw new Error('页面里没有 #root')

  // 1. 槽位注册表：壳认识位置，不认识功能。
  const slots: UiSlots = new SlotRegistry<UiComponent, SlotMap, SlotFactoryMap>()
  // 键的联合类型在 Object.keys 上会退化成 string，这里显式收回来（槽名与形态一一对应）。
  const declared = (Object.keys(SHELL_SLOTS) as ShellSlot[]).map((slot) =>
    slots.declare(slot, SHELL_SLOTS[slot]),
  )

  // 2. 启动清单：骨架也从这里取（与其它插件同一条路，没有第二套地址）。
  //    清单取不到也要起壳：诊断页会说明是哪一步断的，比白屏好查。
  let boot: UiBootGraph = UNAVAILABLE_BOOT
  let bootError: string | null = null
  try {
    boot = await readBootGraph()
  } catch (error) {
    bootError = error instanceof Error ? error.message : String(error)
  }

  // 3. 骨架：**首帧之前就位**（显式 await，不靠批调度）。取不到就不画 App——
  //    白屏会让人以为壳坏了，而实际可能只是 `ui-layout` 那一行被停用了。
  const layoutEntry = boot.entries.find((entry) => entry.id === LAYOUT_ID)
  let layout: LayoutSurface | null = null
  let failure: LayoutFailure | null =
    layoutEntry === undefined
      ? boot.disabled?.includes(LAYOUT_ID) === true
        ? { reason: '已停用', detail: bootError }
        : {
            reason: '没有进启动清单',
            detail:
              bootError ??
              `启动图里没有 ${LAYOUT_ID} 这一条：产物没构建，或被 API 门禁拦下了。` +
                '跑 `pnpm -C ui-shell build` 后刷新本页；插件中心 → 内置插件里也能看到它的开关。',
          }
      : null
  if (layoutEntry !== undefined) {
    try {
      const loaded = (await loadPluginModule(layoutEntry)) as LayoutSurface
      if (typeof loaded.App !== 'function') {
        throw new Error('产物里没有 App（client.js 的形状不对：期望导出 App 组件）')
      }
      layout = loaded
    } catch (error) {
      failure = {
        reason: '加载失败',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }
  if (layout === null) {
    renderLayoutUnavailable(container, failure ?? { reason: '加载失败', detail: null })
    return
  }
  layoutSurface = layout
  const { App, RuntimeProvider } = layout

  // 4. 宿主数据通道（异步连，失败也会自己重连）+ 外观 + 面板几何。
  // 外观**不 await**：函数体在第一个 await 之前就把上次的镜像涂上去了，首帧已经是对的颜色，
  // 等宿主回读回来再覆盖一次。await 的话，宿主卡住时最坏要等一次 invoke 超时（30 秒）才出首帧。
  //
  // 同一次 getUiPrefs 也喂面板几何（侧栏宽 / 正文列宽 / 右侧栏宽 / 并排审查宽）：那几项
  // 只存在 localStorage 的话，宿主一换端口（每次启动、每次切工作目录都换）就全丢。几何
  // 要赶在渲染前灌进面板模块（见下面第 6 步前那几行），否则用户先看到默认宽再跳一下。
  const channel = layout.createHostChannel()
  const prefs = channel.invoke<UiPrefsView>('getUiPrefs').catch((error: unknown) => {
    console.warn('[ui-shell] 读界面偏好失败，沿用上次的外观镜像与默认宽度', error)
    return null
  })
  void syncAppearance(layout, prefs)

  // 5. 装**第一批**（early）。第二批（application）不在这里装：画完首帧后由
  //    session.startApplication() 推到空闲时刻。骨架这一行也在第一批里（`phase: early`）——
  //    它的产物刚才已经物化过一次，这里走同一个物化缓存，工厂不会再执行第二遍。
  let session: UiBootSession | null = null
  try {
    session = await createBootSession(boot, { slots, host: boot.host, runtime: channel })
  } catch (error) {
    bootError = error instanceof Error ? error.message : String(error)
  }
  void declared

  // 壳侧热更：连接上来之后宿主的 `plugins` 帧都会走对账（失败只记在页内诊断区）。
  const hmr: UiPluginHmr | null = session === null ? null : startPluginHmr({ channel, session })
  // 服务表（A1）：会话里那份就是装载期真用的表；装载失败时给一张空表（壳照样起）。
  const serviceRegistry = session?.services ?? new ServiceRegistry()

  // 6. 首帧的宽度：偏好通常在装插件这几百毫秒里就回来了，这里只是把它灌进面板模块。
  // 灌进去之后 `readStoredPx` / `readStoredFlag` 在 localStorage 空着时（换过端口）回落到这一份；
  // 再注册落盘出口，拖动松手时整份发给 `setUiPrefs`（见 ui-primitives/panels.ts）。
  const loaded = await within(prefs, 1500)
  primePanelGeometry(loaded?.panelWidths ?? {})
  /**
   * 注册落盘出口。**拿到过宿主那份才注册**：宿主是整键替换的补丁语义，只发手里这一份
   * 会把没读到的另外几项从 settings.json 抹掉（超时的场合手里只有地址里那几项）。
   */
  const openSaver = (): void => {
    setPanelGeometrySaver((geometry) => {
      void channel.invoke('setUiPrefs', [{ panelWidths: geometry }]).catch((error: unknown) => {
        console.warn('[ui-shell] 面板几何没写成，下次启动会回默认宽', error)
      })
    })
  }
  if (loaded !== null) {
    openSaver()
  } else {
    // 超时只是「这一帧没等到」，回读本身还在路上：到了再灌一次并开写盘。
    void prefs.then((late) => {
      if (late === null) return
      primePanelGeometry(late.panelWidths ?? {})
      openSaver()
    })
  }

  // 7. 渲染。服务表经 context 交给条目组件（插件用 `useService` 读服务、跟着出现/消失换源）；
  // 第一批已在注册表里，首帧就能画出它。App 与 RuntimeProvider 必须来自**同一份**骨架导出
  // （同一个模块实例）：插件的 `useHostSnapshot` 读的是那份 RuntimeContext。
  createRoot(container).render(
    <StrictMode>
      <RuntimeProvider channel={channel}>
        <ServicesProvider services={serviceRegistry}>
          <App
            slots={slots}
            boot={boot}
            serviceRegistry={serviceRegistry}
            session={session}
            hmr={hmr}
            bootError={bootError}
            // 平台模块白名单的读数由这里给：白名单住在装载器（本包），诊断区住在骨架 ——
            // 传值而不是让骨架反向 import 本包，两包之间就没有反向边（E4 的成环剪法）。
            allowedModules={ALLOWED_MODULES}
          />
        </ServicesProvider>
      </RuntimeProvider>
    </StrictMode>,
  )
  // 首帧打点：A2 的时序证据是「early 装完 ≤ 这一刻 ≤ application 开始」。
  session?.markFirstFrame()
  // 首帧之后的空闲时刻继续装第二批——「第二批未物化时第一批已可交互」就是这两行的产品形态。
  session?.startApplication()
  dismissBootSplash()
}

void bootstrap()
