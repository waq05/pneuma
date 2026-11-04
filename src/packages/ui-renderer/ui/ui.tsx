/**
 * 界面渲染器的界面半（插件入口）：`lib/ui/plugins/renderer/client.js`。
 *
 * 2026-11-04 起「引导」与「渲染器」分家：引导（`@pneuma/ui-boot`）读启动图、建 cordis 根，
 * 再把 {@link UiRendererApi} 交给本文件的 {@link start}。渲染器负责首帧之前的那一段：
 *
 *   1. **骨架**（布局插件 `layout` 的产物）在首帧之前**显式 await**——它不是静态 import
 *      进壳的，而是 `lib/ui/plugins/layout/client.js`；
 *   2. 通道与 `RuntimeProvider` 由**平台种子** `@dsc/ui-runtime` 提供（那份状态全页只有
 *      一份，布局 bundle 里的 App 与插件读的是同一份）；建好通道立刻 `bindRuntime` 回填给
 *      引导的 cordis 根（插件拿到的 `ui.runtime` 读的就是它）；
 *   3. 槽由引导声明好（`api.slots`），插件按批装进 cordis，然后渲染 <App/>、打首帧、
 *      在空闲时刻装第二批。
 *
 * 骨架缺席（被停用、产物没构建、取字节失败）时**不画白屏**：{@link LayoutUnavailable}
 * 画一块诊断页，说清是哪一种、以及去哪把开关打开——与引导那张（渲染器缺席）同一套措辞。
 *
 * 本文件是**插件入口**：产物是纯 JS 的 CommonJS 工厂，`@dsc/ui` / `@dsc/ui-primitives`
 * 走 require 表拿壳里那一份；引导的能力只能从 `start(api)` 的入参拿（类型走
 * `import type`，编译期擦除，运行期不产生跨包 import）。
 *
 * @module @pneuma/ui-renderer/client
 */
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createT, defineUiPlugin, onAppearanceRequest } from '@dsc/ui'
import type { UiPrefsView } from '@dsc/ui-core'
import { primePanelGeometry, setPanelGeometrySaver } from '@dsc/ui-primitives'
// 共享运行时（平台种子）：通道工厂、RuntimeProvider、外观落地。它们由 **shell** 提供，
// 布局插件的 bundle 里读的也是这一份——这正是「状态只许一份」那条纪律的落点。
import {
  DEFAULT_APPEARANCE,
  RuntimeProvider,
  applyAppearance,
  appearanceFromPrefs,
  createHostChannel,
  loadCachedAppearance,
  saveCachedAppearance,
} from '@dsc/ui-runtime'
/// <reference path="./boot-types.d.ts" />
// 引导的类型面按**发布包的子路径**取（本地类型桥见 boot-types.d.ts）；运行期能力全从
// `start(api)` 的入参拿，插件 bundle 不 import 引导。
import type { UiBootSession, UiRendererApi } from '@pneuma/ui-boot/boot.js'
import type { UiPluginHmr } from '@pneuma/ui-boot/hmr.js'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
// 构建时 JSON 直接内联进 `client.js`，运行期不需要宿主下发文件。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 布局插件的**产物 id**（`lib/ui/plugins/layout/`）。
 *
 * 与行 id `ui-layout` 差一个 `ui-` 前缀：产物目录名 / 启动图条目用前者，插件开关用后者
 * （换算只写在 `src/core/ui-bundles.ts` 的 `builtinSwitchKey`）。
 */
const LAYOUT_ID = 'layout'

/**
 * 布局产物的导出面：只有 `App` 一项。
 *
 * 2026-11-04 夜起，通道 / RuntimeProvider / 外观落地都从 `@dsc/ui-runtime`（平台种子）取，
 * 布局的 bundle 里只留它自己的组件；这里只借**类型**（`typeof import()` 在编译期擦除、
 * 运行期不产生 import）——实现必须来自启动图里那一份，否则「停用就真的不装」这条开关就是假的。
 */
type LayoutSurface = Pick<typeof import('@dsc/ui-layout'), 'App'>

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
async function syncAppearance(prefs: Promise<UiPrefsView | null>): Promise<void> {
  applyAppearance(loadCachedAppearance())
  const loaded = await prefs
  if (loaded === null) return
  appearance = appearanceFromPrefs(loaded)
  applyAppearance(appearance)
  saveCachedAppearance(appearance)
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
type Appearance = typeof DEFAULT_APPEARANCE
let appearance: Appearance | null = null

/** 骨架装上来之后的导出面：诊断一处要按它走（通道与外观已不从它取）。 */
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
  if (layoutSurface === null) return
  appearance = { ...(appearance ?? DEFAULT_APPEARANCE), ...patch }
  applyAppearance(appearance)
  saveCachedAppearance(appearance)
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
          {t('renderer.diag.title')}{failure.reason}
        </h1>
        <p style={{ margin: '0 0 12px', color: '#b9b5ad' }}>{t('renderer.diag.lead')}</p>
        <p style={{ margin: '0 0 12px', color: '#b9b5ad' }}>
          {t('renderer.diag.where')} <code style={{ color: '#e8e6e1' }}>~/.dsc/plugins.json</code>
          {t('renderer.diag.find')} <code style={{ color: '#e8e6e1' }}>&quot;file&quot;: &quot;ui-layout&quot;</code>{' '}
          {t('renderer.diag.andSet')} <code style={{ color: '#e8e6e1' }}>&quot;disabled&quot;</code>{' '}
          {t('renderer.diag.toFalse')} <code style={{ color: '#e8e6e1' }}>false</code>
          {t('renderer.diag.rest')}
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

/**
 * 渲染器入口：引导把启动图、槽位表、cordis 根与装载能力一起交进来，这里负责首帧。
 *
 * @param api - 引导交来的入口面（槽位表、启动图、cordis 根、装载会话与热更）
 */
export async function start(api: UiRendererApi): Promise<void> {
  const { container, boot } = api

  // 1. 骨架：**首帧之前就位**（显式 await，不靠批调度）。取不到就不画 App——
  //    白屏会让人以为壳坏了，而实际可能只是 `ui-layout` 那一行被停用了。
  const layoutEntry = boot.entries.find((entry) => entry.id === LAYOUT_ID)
  let layout: LayoutSurface | null = null
  let failure: LayoutFailure | null =
    layoutEntry === undefined
      ? boot.disabled?.includes(LAYOUT_ID) === true
        ? { reason: t('renderer.reason.disabled'), detail: api.bootError }
        : {
            reason: t('renderer.reason.missing'),
            detail: api.bootError ?? t('renderer.reason.missingDetail', { id: LAYOUT_ID }),
          }
      : null
  if (layoutEntry !== undefined) {
    try {
      const loaded = (await api.loadPluginModule(layoutEntry)) as LayoutSurface
      if (typeof loaded.App !== 'function') {
        throw new Error('产物里没有 App（client.js 的形状不对：期望导出 App 组件）')
      }
      layout = loaded
    } catch (error) {
      failure = {
        reason: t('renderer.reason.loadFailed'),
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }
  if (layout === null) {
    renderLayoutUnavailable(container, failure ?? { reason: t('renderer.reason.loadFailed'), detail: null })
    return
  }
  layoutSurface = layout
  const { App } = layout

  // 2. 宿主数据通道（异步连，失败也会自己重连）+ 外观 + 面板几何。
  // 外观**不 await**：函数体在第一个 await 之前就把上次的镜像涂上去了，首帧已经是对的颜色，
  // 等宿主回读回来再覆盖一次。await 的话，宿主卡住时最坏要等一次 invoke 超时（30 秒）才出首帧。
  //
  // 同一次 getUiPrefs 也喂面板几何（侧栏宽 / 正文列宽 / 右侧栏宽 / 并排审查宽）：那几项
  // 只存在 localStorage 的话，宿主一换端口（每次启动、每次切工作目录都换）就全丢。几何
  // 要赶在渲染前灌进面板模块（见下面第 5 步前那几行），否则用户先看到默认宽再跳一下。
  const channel = createHostChannel()
  // 通道建好就回填给引导的 cordis 根：插件拿到的 `ui.runtime` 与 App 读的必须是同一条。
  api.bindRuntime(channel)
  const prefs = channel.invoke<UiPrefsView>('getUiPrefs').catch((error: unknown) => {
    console.warn('[ui-shell] 读界面偏好失败，沿用上次的外观镜像与默认宽度', error)
    return null
  })
  void syncAppearance(prefs)

  // 3. 装**第一批**（early）。第二批（application）不在这里装：画完首帧后由
  //    session.startApplication() 推到空闲时刻。骨架这一行也在第一批里（`phase: early`）——
  //    它的产物刚才已经物化过一次，这里走同一个物化缓存，工厂不会再执行第二遍。
  let bootError = api.bootError
  let session: UiBootSession | null = null
  try {
    session = await api.createBootSession(boot, { host: boot.host, runtime: channel })
  } catch (error) {
    bootError = error instanceof Error ? error.message : String(error)
  }
  // 壳侧热更：连接上来之后宿主的 `plugins` 帧都会走对账（失败只记在页内诊断区）。
  const hmr: UiPluginHmr | null = session === null ? null : api.startPluginHmr({ channel, session })
  // 服务表（A1）：会话里那份就是装载期真用的表；装载失败时给引导那份（壳照样起）。
  const serviceRegistry = session?.services ?? api.services

  // 4. 首帧的宽度：偏好通常在装插件这几百毫秒里就回来了，这里只是把它灌进面板模块。
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

  // 5. 渲染。服务表经 context 交给条目组件（插件用 `useService` 读服务、跟着出现/消失换源）；
  // 第一批已在注册表里，首帧就能画出它。RuntimeProvider 与插件的 `useHostSnapshot` 都取自
  // 平台种子 `@dsc/ui-runtime`（同一份模块实例）——**不是**布局 bundle 里又内联的一份。
  //
  // 服务表的 React 面包在引导里（`@dsc/ui-core` 故意不下发给插件），所以从 api 取。
  const ServicesProvider = api.servicesProvider
  createRoot(container).render(
    <StrictMode>
      <RuntimeProvider channel={channel}>
        <ServicesProvider services={serviceRegistry}>
          <App
            slots={api.slots}
            boot={boot}
            serviceRegistry={serviceRegistry}
            session={session}
            hmr={hmr}
            bootError={bootError}
            // 平台模块白名单的读数由引导给：白名单住在装载器，诊断区住在骨架 ——
            // 传值而不是让骨架反向 import 引导，两包之间就没有反向边（E4 的成环剪法）。
            allowedModules={api.allowedModules}
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

/**
 * 渲染器这一行的插件本体。
 *
 * `apply` 里不登记任何东西：渲染器的实体是上面的 `start`，由引导按启动图调它；这一行
 * 的意义是**可停用**——停用后产物不进启动图，引导画诊断页而不是白屏（见
 * `cordis.patch.yml` 与 `ui-boot/ui/main.tsx`）。
 */
export default defineUiPlugin({
  name: t('renderer.plugin.name'),
  apply() {
    // 没有要登记的东西：渲染器不是「往槽里放一块」，它就是画那张纸的手。
  },
})
