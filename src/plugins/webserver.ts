/**
 * webserver 插件：宿主常驻的本机界面服务（插件版界面的入口）。
 *
 * 三条设计约束：
 *
 * 1. **默认不占端口**。挂载本身是零成本的（只是 provide 一个服务），
 *    真正监听要有人要：桌面主进程拿 URL、`DSC_UI_SERVER=1` 自检、或者插件配置里
 *    写 `enabled: true`。终端里跑 `msc` 的人不该平白多出一个监听端口。
 *
 * 2. **地址只打印一次，且是带一次性令牌的那条**。用户复制到浏览器换 Cookie；
 *    令牌用一次作废。桌面主进程将来从这里拿地址（走宿主协议，不解析 stdout）。
 *
 * 3. **配置与实现分家**：服务本体在 `core/ui-server.ts`，不依赖 cordis，
 *    单元测试可以直接起一个真服务来验（不必装配整个内核）。
 *
 * @module dsc/plugins/webserver
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { resolvePluginConfig } from '../core/plugin-registry.js'
import { createUiServer, type UiServerHandle } from '../core/ui-server.js'
import { DSC_VERSION } from '../core/version.js'

/** 配置键（`~/.dsc/plugins.json` 里 file 等于这个名字的那一项）。 */
const CONFIG_KEY = 'webserver'

/** 这个插件暴露给别的插件的服务。 */
export interface WebServerService {
  /**
   * 要服务（幂等）：已经起来就直接给地址，没起来就现在起。
   * @returns 本机入口地址与启动图信息
   */
  ensure(): Promise<{ url: string; port: number; origin: string }>
  /** 已经起来的那个句柄；没起来给 null。 */
  readonly running: UiServerHandle | null
}

/** 读配置：`enabled` 布尔，`port` 整数（0 = 系统分配）。 */
function readConfig(passed: unknown): { enabled: boolean; port: number } {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const port = Number(raw.port)
  return {
    // 环境变量优先：自检脚本与桌面调试用它，不必去改用户配置文件。
    enabled: raw.enabled === true || process.env['DSC_UI_SERVER'] === '1',
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0,
  }
}

export const webserverPlugin: Plugin.Object = {
  name: 'webserver',
  provide: 'webServer',
  apply(ctx, passed) {
    const config = readConfig(passed)
    let handle: UiServerHandle | null = null
    let starting: Promise<UiServerHandle> | null = null

    const start = async (): Promise<UiServerHandle> => {
      const server = await createUiServer({
        host: { name: 'Muse Code', version: DSC_VERSION },
        port: config.port,
      })
      handle = server
      // 这条打印是「界面可以访问了」的就绪信号：用户拿它进浏览器，
      // 桌面主进程将来走协议拿同一个地址（不解析这行）。
      console.log(`Muse Code 界面： ${server.url}`)
      return server
    }

    const service: WebServerService = {
      async ensure() {
        if (handle !== null) return { url: handle.url, port: handle.port, origin: handle.origin }
        starting ??= start()
        const server = await starting
        return { url: server.url, port: server.port, origin: server.origin }
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
