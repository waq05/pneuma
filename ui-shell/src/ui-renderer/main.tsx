/**
 * 界面壳入口：建通道 → 建注册表 → 声明槽 → 装插件 → 挂载。
 *
 * 顺序不能反：槽必须**先声明**再让插件注册（注册到未声明的槽当场报错，
 * 这是刻意设计的——拼错槽名不该静默丢掉一整块界面）。所以这里的次序是
 * 声明 → 加载 → 渲染，而不是先渲染再补插件。
 *
 * 数据通道（SSE）与启动清单（`__DSC_BOOT__`）是两件事：清单决定装哪些插件，
 * 通道决定界面上显示什么状态。通道先建（它自己异步连），装插件时一并交给它们。
 *
 * @module dsc-ui-shell/ui-renderer/main
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SlotRegistry, ServiceRegistry, ServicesProvider, type UiBootGraph, type UiPrefsView } from '@dsc/ui-core'
import { onAppearanceRequest, type SlotFactoryMap, type SlotMap } from '@dsc/ui'
// 面板几何直接按包名取：App（@dsc/ui-layout）读的也是这个包，同一份模块实例才拿得到
// 启动时灌进去的那份值。
import { primePanelGeometry, setPanelGeometrySaver } from '@dsc/ui-primitives'
import { ALLOWED_MODULES, createBootSession, readBootGraph, type UiBootSession } from './boot'
import { startPluginHmr, type UiPluginHmr } from './hmr'
// 骨架与运行时（App、宿主通道、外观落地）住 `@dsc/ui-layout`；槽位契约与出口住 `@dsc/ui-slots`。
import { App, createHostChannel, RuntimeProvider } from '@dsc/ui-layout'
import { SHELL_SLOTS, type ShellSlot } from '@dsc/ui-slots'
import type { UiComponent, UiSlots } from '@dsc/ui'
import {
  applyAppearance,
  appearanceFromPrefs,
  DEFAULT_APPEARANCE,
  loadCachedAppearance,
  saveCachedAppearance,
  type Appearance,
} from '@dsc/ui-layout'
// 顺序即层叠：令牌 → 全局基线 → 原语 → 各视图（从旧渲染层原样搬来的四份）
// → 壳自己的补充。反了就会互相覆盖，与旧渲染层 main.tsx:6-9 同一套次序。
// E4 起入口住 ui-renderer 包，样式仍在壳根（`legacy/` 与 `styles.css`）——相对路径退一层。
import '../legacy/tokens.css'
import '../legacy/base.css'
import '../legacy/primitives.css'
import '../legacy/views.css'
// 终端（xterm）的样式必须由**壳**加载：插件 bundle 是纯 JS，带不了 CSS 文件，
// 而 xterm 的网格与滚动条要靠它自己的样式表才画得对。放在 legacy 之后、styles.css 之前。
import '@xterm/xterm/css/xterm.css'
import '../styles.css'
// 老内核的调色板兜底（**生成物**，见 ui-shell/scripts/build-color-fallback.mjs）。
// 必须排在最后：它整块包在 `@supports not (color: color-mix(...))` 里，靠**源码序**压过
// tokens.css 那批 color-mix 令牌（同特异性，后写的赢）；认得 color-mix 的内核整块不生效。
import '../legacy-color-fallback.css'

/** 取不到清单时的启动图（空壳 + 一条诊断，比白屏好查）。 */
const UNAVAILABLE_BOOT: UiBootGraph = {
  rev: 'unavailable',
  entries: [],
  batches: [],
  host: { name: 'Pneuma', version: '未知版本' },
}

/**
 * 首帧先按上次的外观镜像上色，再向宿主问一次真值。
 *
 * 为什么要有镜像这一手：宿主回读是异步的，等它回来才上色的话，浅色主题的用户每次
 * 打开都会先闪一下深色。镜像读不出来就按默认深色起，不影响后面这一次覆盖。
 *
 * 为什么失败只告警不抛：外观拿不到顶多是配色不对，界面还能用；把启动卡死在这里
 * 才是真的用不了。
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

/** 最后一次生效的外观：设置面板改一项时以它为底（见下面那个注册）。 */
let appearance: Appearance = DEFAULT_APPEARANCE

/**
 * 把「外观改动的请求」接到真正的那份实现上。
 *
 * 为什么绕一道（`requestAppearance` → 这里）：`applyAppearance` 带着模块级状态
 * （最近报出去的控件条颜色、跟随系统的监听），**只该有一份**。插件 bundle 里内联一份
 * 就会出现两个 applier；而外观又是"插件改、壳落地"的事，所以插件只发请求。
 *
 * 写盘由插件自己做（它调 `setUiPrefs`）——这里只负责让界面立刻跟上与记住镜像。
 */
onAppearanceRequest((patch) => {
  appearance = { ...appearance, ...patch }
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

async function bootstrap(): Promise<void> {
  const container = document.getElementById('root')
  if (container === null) throw new Error('页面里没有 #root')

  // 1. 槽位注册表：壳认识位置，不认识功能。
  const slots: UiSlots = new SlotRegistry<UiComponent, SlotMap, SlotFactoryMap>()
  // 键的联合类型在 Object.keys 上会退化成 string，这里显式收回来（槽名与形态一一对应）。
  const declared = (Object.keys(SHELL_SLOTS) as ShellSlot[]).map((slot) =>
    slots.declare(slot, SHELL_SLOTS[slot]),
  )

  // 2. 宿主数据通道（异步连，失败也会自己重连）+ 外观 + 面板几何。
  // 外观**不 await**：函数体在第一个 await 之前就把上次的镜像涂上去了，首帧已经是对的颜色，
  // 等宿主回读回来再覆盖一次。await 的话，宿主卡住时最坏要等一次 invoke 超时（30 秒）才出首帧。
  //
  // 同一次 getUiPrefs 也喂面板几何（侧栏宽 / 正文列宽 / 右侧栏宽 / 并排审查宽）：那几项
  // 只存在 localStorage 的话，宿主一换端口（每次启动、每次切工作目录都换）就全丢。几何
  // 要赶在渲染前灌进面板模块（见下面第 4 步前那几行），否则用户先看到默认宽再跳一下。
  const channel = createHostChannel()
  const prefs = channel.invoke<UiPrefsView>('getUiPrefs').catch((error: unknown) => {
    console.warn('[ui-shell] 读界面偏好失败，沿用上次的外观镜像与默认宽度', error)
    return null
  })
  void syncAppearance(prefs)

  // 3. 启动清单 + 装**第一批**（early）。清单取不到也要起壳：空壳 + 一条诊断，比白屏好查。
  // 第二批（application）不在这里装：画完首帧后由 session.startApplication() 推到空闲时刻。
  let boot: UiBootGraph = UNAVAILABLE_BOOT
  let session: UiBootSession | null = null
  let bootError: string | null = null
  try {
    boot = await readBootGraph()
    session = await createBootSession(boot, { slots, host: boot.host, runtime: channel })
  } catch (error) {
    bootError = error instanceof Error ? error.message : String(error)
  }
  void declared

  // 壳侧热更：连接上来之后宿主的 `plugins` 帧都会走对账（失败只记在页内诊断区）。
  const hmr: UiPluginHmr | null = session === null ? null : startPluginHmr({ channel, session })
  // 服务表（A1）：会话里那份就是装载期真用的表；清单取不到时给一张空表（壳照样起）。
  const serviceRegistry = session?.services ?? new ServiceRegistry()

  // 3.5 首帧的宽度：偏好通常在装插件这几百毫秒里就回来了，这里只是把它灌进面板模块。
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

  // 4. 渲染。服务表经 context 交给条目组件（插件用 `useService` 读服务、跟着出现/消失换源）；
  // 第一批已在注册表里，首帧就能画出它。
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
