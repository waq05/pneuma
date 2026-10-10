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
import { resolvePluginConfig } from '../core/plugin-registry.js'
import { createUiServer, type UiServerHandle } from '../core/ui-server.js'
import { DSC_VERSION } from '../core/version.js'
import type { WebServerService } from '../services/types.js'

/** 配置键（`~/.dsc/plugins.json` 里 file 等于这个名字的那一项）。 */
const CONFIG_KEY = 'webserver'

/** 这个插件最终要用的三样配置。 */
export interface UiServerConfig {
  /** 挂载时就起来（环境变量或配置里点了头）。 */
  enabled: boolean
  /** 监听端口，0 = 让系统分配。 */
  port: number
  /** 伺服哪份界面；缺省用 `lib/ui/assets`。 */
  assetsDir: string | undefined
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
  }
}

export const webserverPlugin: Plugin.Object = {
  name: 'webserver',
  provide: 'webServer',
  apply(ctx, passed) {
    const config = readUiServerConfig(passed)
    let handle: UiServerHandle | null = null
    let starting: Promise<UiServerHandle> | null = null

    const start = async (): Promise<UiServerHandle> => {
      const server = await createUiServer({
        host: { name: 'Muse Code', version: DSC_VERSION },
        port: config.port,
        ...(config.assetsDir === undefined ? {} : { assetsDir: config.assetsDir }),
      })
      handle = server
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
    ctx.effect(() => () => {
      const server = handle
      handle = null
      starting = null
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
