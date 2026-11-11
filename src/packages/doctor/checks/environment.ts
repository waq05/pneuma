/**
 * 环境类四项：安装、配置、认证、终端。
 *
 * **为什么认证与配置分开查**：配置文件能解析不等于有 key，有 key 不等于端点填对了。
 * 合成一项的话，用户只会看到「配置有问题」，还得自己一项项试。
 *
 * @module pneuma/doctor/checks/environment
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { detectShells } from '@pneuma/runtime/core/terminal-env.js'
import type { HealthCheck, SettingsService } from '@pneuma/runtime/services/types.js'
import { appRoot, appVersion } from './util.js'

/** 安装：版本、Node、产物完整性。 */
export function installCheck(): HealthCheck {
  return {
    id: 'install',
    title: '安装',
    order: 10,
    run() {
      const version = appVersion()
      const root = appRoot()
      const basePatch = join(root, 'lib', 'node_modules', '@pneuma', 'base', 'cordis.patch.yml')
      const hasBase = existsSync(basePatch)
      const detail = [
        `版本：${version ?? '未知'}`,
        `Node：${process.version}`,
        `平台：${process.platform} ${process.arch}`,
        `应用根：${root}`,
        `基础包清单：${hasBase ? '在' : '缺失'}`,
      ].join('\n')
      if (version === undefined) {
        return { status: 'warn', summary: '读不到应用版本', detail, fix: '开发态请先 pnpm build；安装态请重装' }
      }
      if (!hasBase) {
        return { status: 'warn', summary: '基础包清单缺失，可能是没构建或装不完整', detail, fix: '执行 pnpm build；安装态请重装' }
      }
      return { status: 'ok', summary: `${version} · node ${process.version}`, detail }
    },
  }
}

/** 配置：config.yaml 能不能读、有几个端点。读不出来就是失败，不是警告。 */
export function configCheck(settings: SettingsService): HealthCheck {
  return {
    id: 'config',
    title: '配置',
    order: 20,
    run() {
      try {
        const mc = settings.modelConfig()
        const detail = [
          `配置文件：${mc.configFile}`,
          `凭据文件：${mc.credentialsFile}`,
          `端点：${mc.providers.length} 个`,
          `默认：${mc.defaultProvider} / ${mc.defaultModel}`,
        ].join('\n')
        if (mc.providers.length === 0) {
          return { status: 'warn', summary: '还没有配置任何模型端点', detail, fix: '在「设置 → 模型」里添加一个端点' }
        }
        return { status: 'ok', summary: `${mc.providers.length} 个端点，默认 ${mc.defaultModel}`, detail }
      } catch (error) {
        return {
          status: 'fail',
          summary: '配置读不出来',
          detail: error instanceof Error ? error.message : String(error),
          fix: '检查 config.yaml 的语法后重试',
        }
      }
    },
  }
}

/** 认证：只报「有没有」，一个字符的 key 都不打印。 */
export function authCheck(settings: SettingsService): HealthCheck {
  return {
    id: 'auth',
    title: '认证',
    order: 30,
    run() {
      let mc
      try {
        mc = settings.modelConfig()
      } catch (error) {
        return { status: 'skip', summary: '配置读不出来，跳过认证检查', detail: error instanceof Error ? error.message : String(error) }
      }
      const total = mc.providers.length
      const configured = mc.providers.filter((provider) => provider.keyConfigured)
      const detail = mc.providers
        .map((provider) => `${provider.keyConfigured ? '✓' : '·'} ${provider.displayName || provider.name}（${provider.keyRef || '未声明 key 名'}）`)
        .join('\n')
      if (total === 0) return { status: 'skip', summary: '没有端点可查', detail }
      if (configured.length === 0) {
        return {
          status: 'fail',
          summary: `${total} 个端点都没有可用密钥`,
          detail,
          fix: '在「设置 → 模型」给要用的端点填 key，或设置对应的环境变量',
        }
      }
      if (configured.length < total) {
        return { status: 'warn', summary: `${configured.length}/${total} 个端点已配密钥`, detail, fix: '不需要的端点可以在设置里删掉，留着容易选错' }
      }
      return { status: 'ok', summary: `${total} 个端点均已配密钥`, detail }
    },
  }
}

/** 终端：能不能探到一个可用的 shell。force 绕开 7 天缓存——体检就是要看此刻的真相。 */
export function terminalCheck(): HealthCheck {
  return {
    id: 'terminal',
    title: '终端',
    order: 90,
    run() {
      let shells
      try {
        shells = detectShells(true)
      } catch (error) {
        return { status: 'warn', summary: '终端探测本身报错', detail: error instanceof Error ? error.message : String(error) }
      }
      const usable = shells.filter((shell) => shell.available)
      const detail = shells.map((shell) => `${shell.available ? '✓' : '·'} ${shell.label} — ${shell.detail}`).join('\n')
      if (usable.length === 0) {
        return { status: 'fail', summary: '没探到任何可用 shell', detail, fix: '在「设置 → 终端环境」里手动指定一个 shell' }
      }
      return { status: 'ok', summary: `${usable.length} 个可用：${usable.map((shell) => shell.label).join('、')}`, detail }
    },
  }
}
