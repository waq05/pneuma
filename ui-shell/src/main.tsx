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
 * @module dsc-ui-shell/main
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SlotRegistry, type UiBootGraph, type UiPluginLoadResult, type UiPrefsView } from '@dsc/ui-core'
import { onAppearanceRequest } from './plugin-api'
import { readBootGraph, loadUiPlugins } from './boot'
import { createHostChannel } from './host-channel'
import { RuntimeProvider } from './runtime-context'
import { SHELL_SLOTS } from './slots'
import { App } from './app'
import type { UiComponent, UiSlots } from './plugin-api'
import {
  applyAppearance,
  appearanceFromPrefs,
  DEFAULT_APPEARANCE,
  loadCachedAppearance,
  saveCachedAppearance,
  type Appearance,
} from './appearance'
// 顺序即层叠：令牌 → 全局基线 → 原语 → 各视图（从旧渲染层原样搬来的四份）
// → 壳自己的补充。反了就会互相覆盖，与旧渲染层 main.tsx:6-9 同一套次序。
import './legacy/tokens.css'
import './legacy/base.css'
import './legacy/primitives.css'
import './legacy/views.css'
// 终端（xterm）的样式必须由**壳**加载：插件 bundle 是纯 JS，带不了 CSS 文件，
// 而 xterm 的网格与滚动条要靠它自己的样式表才画得对。放在 legacy 之后、styles.css 之前。
import '@xterm/xterm/css/xterm.css'
import './styles.css'

/** 什么都没装上时的装载结果（清单取不到也要起壳，不能白屏）。 */
const NOTHING_LOADED: UiPluginLoadResult = { reports: [], disposeAll: () => undefined }

/**
 * 首帧先按上次的外观镜像上色，再向宿主问一次真值。
 *
 * 为什么要有镜像这一手：宿主回读是异步的，等它回来才上色的话，浅色主题的用户每次
 * 打开都会先闪一下深色。镜像读不出来就按默认深色起，不影响后面这一次覆盖。
 *
 * 为什么失败只告警不抛：外观拿不到顶多是配色不对，界面还能用；把启动卡死在这里
 * 才是真的用不了。
 */
async function syncAppearance(channel: ReturnType<typeof createHostChannel>): Promise<void> {
  applyAppearance(loadCachedAppearance())
  try {
    const prefs = await channel.invoke<UiPrefsView>('getUiPrefs')
    appearance = appearanceFromPrefs(prefs)
    applyAppearance(appearance)
    saveCachedAppearance(appearance)
  } catch (error) {
    console.warn('[ui-shell] 读界面偏好失败，沿用上次的外观镜像', error)
  }
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

async function bootstrap(): Promise<void> {
  const container = document.getElementById('root')
  if (container === null) throw new Error('页面里没有 #root')

  // 1. 槽位注册表：壳认识位置，不认识功能。
  const slots: UiSlots = new SlotRegistry<UiComponent>()
  const declared = Object.entries(SHELL_SLOTS).map(([slot, kind]) => slots.declare(slot, kind))

  // 2. 宿主数据通道（异步连，失败也会自己重连）+ 外观。
  // 外观**不 await**：函数体在第一个 await 之前就把上次的镜像涂上去了，首帧已经是对的颜色，
  // 等宿主回读回来再覆盖一次。await 的话，宿主卡住时最坏要等一次 invoke 超时（30 秒）才出首帧。
  const channel = createHostChannel()
  void syncAppearance(channel)

  // 3. 启动清单 + 装插件。清单取不到也要起壳：空壳 + 一条诊断，比白屏好查。
  let boot: UiBootGraph = { rev: 'unavailable', entries: [], host: { name: 'Muse Code', version: '未知版本' } }
  let loaded: UiPluginLoadResult = NOTHING_LOADED
  try {
    boot = await readBootGraph()
    loaded = await loadUiPlugins(boot, { slots, host: boot.host, runtime: channel })
  } catch (error) {
    loaded = {
      reports: [{ id: 'boot', ok: false, error: error instanceof Error ? error.message : String(error) }],
      disposeAll: () => undefined,
    }
  }
  void declared

  // 4. 渲染。
  createRoot(container).render(
    <StrictMode>
      <RuntimeProvider channel={channel}>
        <App slots={slots} boot={boot} reports={loaded.reports} />
      </RuntimeProvider>
    </StrictMode>,
  )
}

void bootstrap()
