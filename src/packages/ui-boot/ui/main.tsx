/**
 * 界面引导的页面入口：HTML 里那一条 `<script type="module">` 指向它（`ui-shell/index.html`）。
 *
 * 2026-11-04 起「引导」与「渲染器」分成两个包（对应 dsh 的 `dsh-client-modules` +
 * `dsh-client-ui-renderer`）：
 *
 *   1. **引导**（本包）读启动图、建槽位表与 cordis 根；
 *   2. 按启动图找到 `renderer` 那一条，`loadPluginModule` 物化它，把 {@link UiRendererApi}
 *      交给它的 `start(api)`；
 *   3. 渲染器自己取骨架、建通道、装插件、画首帧——这些一步都不留在这里。
 *
 * 找不到渲染器 / 它被停用 / 加载或启动抛错时**不画白屏**：{@link RendererUnavailable}
 * 画一块诊断页，说清是哪一种、去哪把开关打开，并让启动占位退场。骨架（`layout`）缺席的
 * 诊断在渲染器那一侧画（那里才知道骨架为什么没取回来），措辞与本页同一套。
 *
 * 样式为什么由引导挂：渲染器的产物是插件 bundle（纯 JS，带不了 CSS），而样式要在渲染器
 * 停用、只剩诊断页时也照样生效。样式文件仍住在渲染器包里（`ui-renderer/ui/styles/`，
 * 老内核调色板兜底生成脚本按那个路径产出），这里按相对路径引入。
 *
 * @module dsc-ui-shell/ui-boot/main
 */
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createT,
  ServiceRegistry,
  SlotRegistry,
  ServicesProvider,
  type UiBootGraph,
  type UiRuntimeApi,
} from '@dsc/ui-core'
import { SHELL_SLOTS, type ShellSlot } from '@dsc/ui-slots'
import type { SlotFactoryMap, SlotMap, UiComponent, UiSlots } from '@dsc/ui'
import { createCordisRoot } from './cordis-host'
import {
  ALLOWED_MODULES,
  createBootSession,
  loadPluginModule,
  readBootGraph,
  type UiRendererApi,
} from './boot'
import { startPluginHmr } from './hmr'
// 顺序即层叠：令牌 → 全局基线 → 原语 → 各视图（从旧渲染层原样搬来的四份）
// → 壳自己的补充。反了就会互相覆盖，与旧渲染层 main.tsx:6-9 同一套次序。
// 父目录仍是渲染器包：样式是渲染产物的一部分，只是必须由**引导**这个 app bundle 挂上。
import '../../ui-renderer/ui/styles/legacy/tokens.css'
import '../../ui-renderer/ui/styles/legacy/base.css'
import '../../ui-renderer/ui/styles/legacy/primitives.css'
import '../../ui-renderer/ui/styles/legacy/views.css'
// 终端（xterm）的样式必须由**壳**加载：插件 bundle 是纯 JS，带不了 CSS 文件，
// 而 xterm 的网格与滚动条要靠它自己的样式表才画得对。放在 legacy 之后、styles.css 之前。
import '@xterm/xterm/css/xterm.css'
import '../../ui-renderer/ui/styles/styles.css'
// 老内核的调色板兜底（**生成物**，见 ui-shell/scripts/build-color-fallback.mjs）。
// 必须排在最后：它整块包在 `@supports not (color: color-mix(...))` 里，靠**源码序**压过
// tokens.css 那批 color-mix 令牌（同特异性，后写的赢）；认得 color-mix 的内核整块不生效。
import '../../ui-renderer/ui/styles/legacy-color-fallback.css'

// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
// 构建时 JSON 直接内联进 `client.js`，运行期不需要宿主下发文件。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui-core` 的 `createT`）。 */
const t = createT({ zh, en })

/** 取不到清单时的启动图（空壳 + 一条诊断，比白屏好查）。 */
const UNAVAILABLE_BOOT: UiBootGraph = {
  rev: 'unavailable',
  entries: [],
  batches: [],
  host: { name: 'Pneuma', version: t('boot.versionUnknown') },
}

/**
 * 渲染器插件的**产物 id**（`lib/ui/plugins/renderer/`）。
 *
 * 与行 id `ui-renderer` 差一个 `ui-` 前缀：产物目录名 / 启动图条目用前者，插件开关用后者
 * （换算只写在 `src/core/ui-bundles.ts` 的 `builtinSwitchKey`）。
 */
const RENDERER_ID = 'renderer'

/** 渲染器缺席的三种来路（诊断页按它写标题与下一步）。 */
interface RendererFailure {
  /** 一句话说清是哪一种。 */
  reason: string
  /** 更细的原因（错误原文 / 缺哪一条），没有就是 null。 */
  detail: string | null
}

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
 * 渲染器缺席时的诊断页。
 *
 * 为什么一定要有它：`ui-renderer` 现在是**能停用的插件**，开关的意义就在于关掉之后还能
 * 看见东西——白屏会让人以为是壳坏了，而实际只是一行开关。这里给三样：哪一行没了、
 * 为什么、去哪儿打开它。
 *
 * 样式全内联：这一页在 App 之外运行，不能依赖 `styles/` 里那套（那些类名是给 App 用的）。
 */
function RendererUnavailable({ failure }: { failure: RendererFailure }): ReactNode {
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
          {t('boot.diag.title')}{failure.reason}
        </h1>
        <p style={{ margin: '0 0 12px', color: '#b9b5ad' }}>{t('boot.diag.lead')}</p>
        <p style={{ margin: '0 0 12px', color: '#b9b5ad' }}>
          {t('boot.diag.where')} <code style={{ color: '#e8e6e1' }}>~/.dsc/plugins.json</code>
          {t('boot.diag.find')} <code style={{ color: '#e8e6e1' }}>&quot;file&quot;: &quot;ui-renderer&quot;</code>{' '}
          {t('boot.diag.andSet')} <code style={{ color: '#e8e6e1' }}>&quot;disabled&quot;</code>{' '}
          {t('boot.diag.toFalse')} <code style={{ color: '#e8e6e1' }}>false</code>
          {t('boot.diag.rest')}
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
function renderRendererUnavailable(container: HTMLElement, failure: RendererFailure): void {
  createRoot(container).render(
    <StrictMode>
      <RendererUnavailable failure={failure} />
    </StrictMode>,
  )
  dismissBootSplash()
}

async function bootstrap(): Promise<void> {
  const container = document.getElementById('root')
  if (container === null) throw new Error('页面里没有 #root')

  // 1. 启动清单：引导只做「取图 + 找一条」，装哪些插件由渲染器按这份图决定。
  let boot: UiBootGraph = UNAVAILABLE_BOOT
  let bootError: string | null = null
  try {
    boot = await readBootGraph()
  } catch (error) {
    bootError = error instanceof Error ? error.message : String(error)
  }

  // 2. 槽位表：壳认识位置，不认识功能（与以前同一份声明，只是搬到了引导里）。
  const slots: UiSlots = new SlotRegistry<UiComponent, SlotMap, SlotFactoryMap>()
  for (const slot of Object.keys(SHELL_SLOTS) as ShellSlot[]) slots.declare(slot, SHELL_SLOTS[slot])

  // 3. cordis 根：装配内核归引导。运行时通道由渲染器建（通道属于骨架），所以这里先拿
  //    一个取值函数建根，渲染器建好通道后经 api.bindRuntime 回填。
  const services = new ServiceRegistry()
  let runtime: UiRuntimeApi | null = null
  const cordis = createCordisRoot({
    slots,
    host: boot.host,
    services,
    runtime: () => {
      if (runtime === null) {
        throw new Error('运行时通道还没交进来：渲染器要先调 bindRuntime，再建装载会话')
      }
      return runtime
    },
  })

  // 4. 找渲染器这一条。缺失 / 停用要分开说：前者去构建，后者去开关。
  const rendererEntry = boot.entries.find((entry) => entry.id === RENDERER_ID)
  let failure: RendererFailure | null =
    rendererEntry === undefined
      ? boot.disabled?.includes(RENDERER_ID) === true
        ? { reason: t('boot.reason.disabled'), detail: bootError }
        : {
            reason: t('boot.reason.missing'),
            detail: bootError ?? t('boot.reason.missingDetail', { id: RENDERER_ID }),
          }
      : null

  // 5. 物化渲染器并交出入口面。加载与启动都算「失败」：两者都只会得到同一块诊断页。
  if (rendererEntry !== undefined) {
    try {
      const loaded = (await loadPluginModule(rendererEntry)) as { start?: unknown }
      if (typeof loaded.start !== 'function') {
        throw new Error('产物里没有 start（client.js 的形状不对：期望导出 start(api)）')
      }
      const api: UiRendererApi = {
        container,
        boot,
        bootError,
        slots,
        cordis,
        services,
        servicesProvider: ServicesProvider,
        allowedModules: ALLOWED_MODULES,
        bindRuntime: (next) => {
          runtime = next
        },
        loadPluginModule,
        startPluginHmr,
        createBootSession: (graph, options) =>
          createBootSession(graph, {
            slots,
            host: options.host,
            runtime: options.runtime,
            assembly: { cordis, services },
          }),
      }
      await (loaded.start as (value: UiRendererApi) => Promise<void>)(api)
      return
    } catch (error) {
      failure = {
        reason: t('boot.reason.loadFailed'),
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }
  renderRendererUnavailable(container, failure ?? { reason: t('boot.reason.loadFailed'), detail: null })
}

void bootstrap()
