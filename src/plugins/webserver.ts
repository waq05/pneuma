/**
 * webserver 插件：宿主常驻的本机界面服务（插件版界面的入口）。
 *
 * 三条设计约束：
 *
 * 1. **默认不占端口**。挂载本身是零成本的（只是 provide 一个服务），
 *    真正监听要有人要：桌面主进程经宿主协议拿地址、`DSC_UI_SERVER=1` 自检、
 *    或者插件配置里写 `enabled: true`。终端里跑 `msc` 的人不该平白多出一个监听端口。
 *
 * 2. **地址只打印一次，且是带一次性令牌的那条**。用户复制到浏览器换 Cookie；
 *    桌面主进程从服务上拿同一个地址（不解析 stdout）。
 *
 * 3. **配置与实现分家**：服务本体在 `core/ui-server.ts`，不依赖 cordis，
 *    单元测试可以直接起一个真服务来验（不必装配整个内核）。
 *
 * 4. **伺服哪份界面由配置说了算**（`assetsDir` 或 `DSC_UI_ASSETS`）：
 *    迁移期桌面窗口伺服的是桌面渲染层自己的产物（`desktop/out/renderer`），
 *    插件版壳的产物默认在 `lib/ui/assets`——两者用同一个服务，靠这两个开关区分。
 *
 * @module dsc/plugins/webserver
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { bootNoticeOnce } from '../core/boot-notices.js'
import { resolvePluginConfig } from '../core/plugin-registry.js'
import { createUiEvents, type UiEventsHandle } from '../core/ui-events.js'
import { createUiHmr, type UiHmrFrame, type UiHmrHandle } from '../core/ui-hmr.js'
import { UI_PLUGIN_MANIFEST, uiPluginsDir } from '../core/ui-bundles.js'
import { isUiMethod, UI_METHODS, validateUiArgs } from '../core/ui-methods.js'
import { createUiServer, type UiServerHandle } from '../core/ui-server.js'
import { DSC_VERSION } from '../core/version.js'
import type { WebServerService } from '../services/types.js'

/** 配置键（`~/.dsc/plugins.json` 里 file 等于这个名字的那一项）。 */
const CONFIG_KEY = 'webserver'

/**
 * 数据通道的协议版本：加字段不涨，改字段含义/删字段才涨（界面壳按它决定认不认这份宿主）。
 * 1 = SSE 推帧（全量/增量）+ POST invoke，另含 `event: plugins` 启动图热更帧——
 * 新增事件名不进版本号：旧壳对没监听的事件名直接忽略，向前兼容。
 */
export const UI_EVENTS_PROTOCOL_VERSION = 1

/** 这个插件最终要用的四样配置。 */
export interface UiServerConfig {
  /** 挂载时就起来（环境变量或配置里点了头）。 */
  enabled: boolean
  /** 监听端口，0 = 让系统分配。 */
  port: number
  /** 伺服哪份界面；缺省用 `lib/ui/assets`。 */
  assetsDir: string | undefined
  /** 插件 bundle 热更（轮询产物 + SSE 推帧）。 */
  hmr: { enabled: boolean; pollIntervalMs: number }
}

/** 端口取值：环境变量优先，其次配置；非法或越界一律回落到 0（系统分配）。 */
function pickPort(value: unknown): number {
  const port = Number(value)
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0
}

/** 取一段非空字符串配置，空串当没配。 */
function pickDir(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** 轮询间隔（毫秒）：环境变量优先于配置；非法值回落到 500。 */
function pickHmrInterval(value: unknown): number {
  const ms = Number(value)
  return Number.isInteger(ms) && ms >= 50 && ms <= 60_000 ? ms : 500
}

/**
 * 热更开不开：环境变量 `DSC_UI_HMR` 优先（`1` 强开 / `0` 强关，多探针并行时互不打扰），
 * 否则跟着**既有开发态语义**走——`DSC_UI_SERVER=1` 就是 `_ui-shell-serve.mjs` 那条
 * 「本地起宿主伺服界面」的开发/自检轨（`readUiServerConfig` 的 enabled 同源），
 * 插件配置里写 `hmr: true` 也可显式打开。打包态默认关：`lib/ui/plugins` 是 extraResources
 * 里的只读产物，常驻 500ms 轮询白烧且不该有「手改安装目录当场换装」这种行为。
 */
function pickHmr(raw: Record<string, unknown>): { enabled: boolean; pollIntervalMs: number } {
  const env = process.env['DSC_UI_HMR']
  const enabled = env === '1' || env === 'true'
    ? true
    : env === '0' || env === 'false'
      ? false
      : raw.hmr === true || process.env['DSC_UI_SERVER'] === '1'
  return { enabled, pollIntervalMs: pickHmrInterval(process.env['DSC_UI_HMR_POLL_MS'] ?? raw.hmrPollIntervalMs) }
}

/**
 * 读配置：环境变量（自检与桌面调试用，不必改用户配置文件）优先于插件配置。
 * @param passed - 装配时传进来的第二参数（`apply(ctx, passed)`）
 */
export function readUiServerConfig(passed: unknown): UiServerConfig {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  return {
    enabled: raw.enabled === true || process.env['DSC_UI_SERVER'] === '1',
    port: pickPort(process.env['DSC_UI_PORT'] ?? raw.port),
    assetsDir: pickDir(process.env['DSC_UI_ASSETS']) ?? pickDir(raw.assetsDir),
    hmr: pickHmr(raw),
  }
}

export const webserverPlugin: Plugin.Object = {
  name: 'webserver',
  provide: 'webServer',
  // transcript 是给「装载问题进会话流」那段用的（下面 start 里的 problems 循环）——
  // 少了它，只要界面上有任何一条问题（比如一个没信任的第三方插件目录），
  // `ctx.transcript.system` 就会抛「cannot get property "transcript" without inject」，
  // ensure() 整个 reject：桌面壳收不到界面地址，**静默回落旧渲染层**（真踩过）。
  inject: ['ui', 'transcript'],
  apply(ctx, passed) {
    const config = readUiServerConfig(passed)
    const runtime = ctx.ui
    let handle: UiServerHandle | null = null
    let events: UiEventsHandle | null = null
    let hmr: UiHmrHandle | null = null
    let starting: Promise<UiServerHandle> | null = null

    const start = async (): Promise<UiServerHandle> => {
      /**
       * 启动图帧的当前值 + 订阅者。通道先建、轮询器后建，中间用这个盒子接上：
       * 连接建立时先发 `current ?? 现取一份图`，之后轮询器推一帧就广播一帧。
       */
      const pluginFrames: {
        current: UiHmrFrame | null
        listeners: Set<(frame: UiHmrFrame) => void>
      } = { current: null, listeners: new Set() }
      const pushPlugins = (frame: UiHmrFrame): void => {
        pluginFrames.current = frame
        for (const listener of [...pluginFrames.listeners]) {
          try {
            listener(frame)
          } catch {
            // 一个订阅者炸了不该拖垮别的（与通道里其他 fan-out 同一条纪律）
          }
        }
      }
      const currentGraph = (): { rev: string; graph: unknown } => {
        const graph = handle?.boot()
        if (graph === undefined) return { rev: '', graph: null }
        return { rev: graph.rev, graph }
      }

      // 数据通道：帧的产生与缓冲复用遥控端那一套（core/remote/frames.ts）。
      // 白名单**不是**整张 INVOKABLE_METHODS：页面里跑着第三方插件 bundle，与壳同源，
      // 任一插件被投毒就等于拿到 Cookie；所以只放界面真正要用的子集，凭据类 / 破坏性 /
      // 任意命令执行 / 策略写入一律排除，理由逐条写在 core/ui-methods.ts 的文件头。
      // 实参也不再原样铺开：先过 validateUiArgs 的个数 / 类型 / 长度 / 枚举校验。
      const channel = createUiEvents({
        // 帧的形状与遥控端同一份契约：已定稿条目（正 id）与直播尾（负 id）分开放，
        // sessionId 从状态里取（会话切换时 hub 据此立刻发全量）。
        snapshot: () => {
          const base = runtime.getSnapshot()
          return {
            ...base,
            sessionId: base.status.sessionId ?? '',
            entries: base.entries.filter((entry) => entry.id > 0),
            liveEntries: base.entries.filter((entry) => entry.id < 0),
          }
        },
        invoke: async (method, args) => {
          if (!isUiMethod(method)) throw new Error(`界面通道不允许调用的方法：${method}`)
          const checked = validateUiArgs(method, args)
          if (!checked.ok) throw new Error(checked.error)
          // 方法名已经收窄成 DscRuntime 的键（与 host-stdio 同一处惯例）。
          return (await Reflect.apply(runtime[method], runtime, checked.args)) ?? null
        },
        methods: UI_METHODS,
        hello: () => ({
          protocolVersion: UI_EVENTS_PROTOCOL_VERSION,
          methods: [...UI_METHODS],
          host: { name: 'Muse Code', version: DSC_VERSION },
        }),
        subscribe: (onChange) => runtime.subscribe(onChange),
        // 启动图热更帧：`event: plugins`（不进 frame 帧的 seq/补帧语义）。
        plugins: {
          initial: () => {
            const { rev, graph } = currentGraph()
            return { rev, changed: [], removed: [], graph }
          },
          subscribe: (listener) => {
            pluginFrames.listeners.add(listener)
            return () => {
              pluginFrames.listeners.delete(listener)
            }
          },
        },
        // 通道自己的异常（对端不读、造帧失败、连接数超限）走宿主 logger：
        // 不接的话只写 stderr，进不了统一日志，线上排查看不到。
        log: (line) => {
          ctx.logger.warn(line)
        },
      })
      const server = await createUiServer({
        host: { name: 'Muse Code', version: DSC_VERSION },
        port: config.port,
        events: channel,
        ...(config.assetsDir === undefined ? {} : { assetsDir: config.assetsDir }),
      })
      handle = server
      events = channel
      // 开发态热更：轮询插件产物 → 换代 → 推 `plugins` 帧。默认只在开发态开（见 pickHmr）。
      if (config.hmr.enabled) {
        hmr = createUiHmr({
          watches: () => [
            ...server.watchRows().map((row) => ({ id: row.id, path: row.path })),
            // 清单是一等信号：新增/删掉一个插件时成员文件的 stat 不会变。
            { id: 'manifest', path: join(uiPluginsDir(), UI_PLUGIN_MANIFEST) },
          ],
          graph: () => server.boot(),
          refresh: () => {
            server.refresh()
          },
          onFrame: pushPlugins,
          pollIntervalMs: config.hmr.pollIntervalMs,
          log: (line) => {
            ctx.logger.warn(line)
          },
        })
        ctx.logger.info(
          `webserver: 插件 bundle 热更已开（轮询 ${String(config.hmr.pollIntervalMs)}ms；DSC_UI_HMR=0 可关）`,
        )
      }
      // 插件装载的问题（第三方没信任、api 不匹配、bundle 缺失…）进会话流：
      // 「插件怎么不见了」不能只写在日志里。bootNoticeOnce 按文本去重——
      // 同一句话（重启后重新发现也一样）只报一次。
      for (const problem of server.problems()) {
        if (bootNoticeOnce(`ui-server.problem:${problem}`, problem)) ctx.transcript.system(problem)
      }
      // 这条打印是「界面可以访问了」的就绪信号：用户拿它进浏览器。
      // 桌面主进程不走这条（它从服务上取地址），这样 stdout 是否被 TUI 接管都无所谓。
      console.log(`Muse Code 界面： ${server.url}`)
      return server
    }

    const service: WebServerService = {
      async ensure() {
        if (handle !== null) return { url: handle.url, origin: handle.origin, port: handle.port }
        starting ??= start()
        const server = await starting
        return { url: server.url, origin: server.origin, port: server.port }
      },
      get running() {
        return handle
      },
    }

    ctx.provide('webServer', service)

    // 插件卸载时把服务关掉：端口不该留在已经卸掉的插件手里。
    // 数据通道先停（它订阅着宿主变化），再关服务。
    ctx.effect(() => () => {
      const channel = events
      const server = handle
      const watcher = hmr
      handle = null
      events = null
      hmr = null
      starting = null
      if (watcher !== null) watcher.stop()
      if (channel !== null) channel.stop()
      if (server !== null) void server.close()
    }, 'webserver: 关闭界面服务')

    if (config.enabled) {
      void service.ensure().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`webserver: 起不来（${reason}）`)
      })
    }
  },
}
