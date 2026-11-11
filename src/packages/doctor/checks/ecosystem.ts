/**
 * 生态类三项：插件清单、沙箱状态、端点连通性。
 *
 * **连通性为什么不算进「认证」**：认证问的是「有没有钥匙」，连通性问的是「门开不开」。
 * 分开之后，用户能一眼看出是没配 key，还是配了但网络/代理/地址不对。
 *
 * @module pneuma/doctor/checks/ecosystem
 */
import { listPluginInfos } from '@pneuma/runtime/core/plugin-registry.js'
import type { HealthCheck, SandboxService, SettingsService } from '@pneuma/runtime/services/types.js'

/** 插件：清单能不能列出来、多少启用、多少停用。 */
export function pluginsCheck(): HealthCheck {
  return {
    id: 'plugins',
    title: '插件',
    order: 40,
    run() {
      let infos
      try {
        infos = listPluginInfos()
      } catch (error) {
        return {
          status: 'fail',
          summary: '插件清单读不出来',
          detail: error instanceof Error ? error.message : String(error),
          fix: '检查 ~/.dsc/plugins.json 的语法',
        }
      }
      const enabled = infos.filter((info) => info.enabled)
      const disabled = infos.filter((info) => !info.enabled)
      const detail = [
        `合计：${infos.length} 个（内置 ${infos.filter((info) => info.source === 'builtin').length}、外部 ${infos.filter((info) => info.source === 'external').length}）`,
        `启用：${enabled.length}，停用：${disabled.length}`,
        ...(disabled.length > 0 ? ['停用的：' + disabled.map((info) => info.name).join('、')] : []),
      ].join('\n')
      // 停用本身不是问题（用户自己关的），只是列出来方便对照「我是不是忘了开」
      return { status: 'ok', summary: `${infos.length} 个插件，${enabled.length} 个启用`, detail }
    },
  }
}

/**
 * 沙箱：报当前档位、强制等级、网络放行。
 *
 * 只读 `ctx.get('sandbox')` 暴露的那几个字段，不去碰它的策略内部——白名单只有持有者
 * 该认识，体检也不该成为第二个真相来源。
 */
export function sandboxCheck(getSandbox: () => SandboxService | undefined): HealthCheck {
  return {
    id: 'sandbox',
    title: '沙箱',
    order: 70,
    run() {
      const sandbox = getSandbox()
      if (sandbox === undefined) {
        return { status: 'skip', summary: '沙箱插件未启用，没有状态可查' }
      }
      const detail = [
        `档位：${sandbox.mode}`,
        `强制等级：${sandbox.enforcement}`,
        `网络：${sandbox.networkAccess ? '放行' : '不放行'}`,
        `可写根：${sandbox.writableRoots.length} 个`,
        ...sandbox.writableRoots.map((root) => `  ${root}`),
        `摘要：${sandbox.describe()}`,
      ].join('\n')
      // 完全访问是用户自己选的，不算错；只在「策略后端 + 网络放行」这种组合上提醒一句
      if (sandbox.mode === 'danger-full-access') {
        return { status: 'warn', summary: '当前是完全访问档，不拦写入与网络', detail, fix: '不需要时在设置里降回「工作区可写」' }
      }
      return { status: 'ok', summary: `${sandbox.mode} · ${sandbox.enforcement}`, detail }
    },
  }
}

/** 端点连通性：对默认端点的 `/models` 发一次无密钥请求，3 秒不见人就判失败。 */
export function reachabilityCheck(settings: SettingsService): HealthCheck {
  return {
    id: 'reachability',
    title: '连通性',
    order: 80,
    async run() {
      let mc
      try {
        mc = settings.modelConfig()
      } catch (error) {
        return { status: 'skip', summary: '配置读不出来，跳过连通性', detail: error instanceof Error ? error.message : String(error) }
      }
      const provider = mc.providers.find((item) => item.name === mc.defaultProvider) ?? mc.providers[0]
      if (provider === undefined) {
        return { status: 'skip', summary: '没有端点可测' }
      }
      const url = `${provider.baseUrl.replace(/\/+$/, '')}/models`
      const started = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      try {
        const response = await fetch(url, { method: 'GET', signal: controller.signal })
        const ms = Date.now() - started
        const detail = [`端点：${provider.displayName || provider.name}`, `地址：${url}`, `耗时：${ms} ms`, `HTTP：${response.status}`].join('\n')
        if (response.ok) return { status: 'ok', summary: `${ms} ms 可达`, detail }
        // 401/403 说明网络是通的，只是这次故意没带密钥——这正是我们要的结论
        if (response.status === 401 || response.status === 403) {
          return { status: 'ok', summary: `可达（HTTP ${response.status}，未带密钥）`, detail }
        }
        if (response.status >= 500) {
          return { status: 'warn', summary: `服务端 ${response.status}`, detail, fix: '过一会儿再试；持续如此可能是端点侧故障' }
        }
        return { status: 'warn', summary: `端点返回 HTTP ${response.status}`, detail, fix: '检查 baseUrl 是否指向 OpenAI 兼容接口' }
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError'
        const detail = [`端点：${provider.displayName || provider.name}`, `地址：${url}`].join('\n')
        return {
          status: 'fail',
          summary: aborted ? '3 秒内没有响应' : `连不上：${error instanceof Error ? error.message : String(error)}`,
          detail,
          fix: '检查网络/代理设置，以及「设置 → 模型」里的 baseUrl',
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
