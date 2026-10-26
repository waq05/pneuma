/**
 * 当前生效的 profile 目录（dsh 的安装形态里，组合包住在这里）。
 *
 * 为什么单独一个模块：组合包的**宿主半**（plugin-loader 挂插件）与**界面半**
 * （ui-bundles 收界面插件、ui-route 伺服 bundle）都要知道 profile 在哪。以前这函数住在
 * plugin-loader 里，界面产物表一 import 就把整个宿主装载器（连带 host Context 的类型面）
 * 拖进界面壳的编译单元——壳的 typecheck 因此报 `transcript` 不在 Context 上。
 *
 * 解析顺序：环境变量 `DSC_PROFILE` 优先（自检与多环境用它），否则看 `~/.dsc/config.yaml`
 * 的 `profile:` 字段。没配就是 null，整条组合包路径都不碰。
 *
 * @module dsc/core/profile-dir
 */
import { existsSync, readFileSync } from 'node:fs'
import { dscPath } from './path-policy.js'
import { activeConfigFile } from './config-store.js'
import { parseTolerantYaml } from './migrate.js'

/**
 * 当前生效的 profile 目录。
 * @returns 绝对路径；没配给 null
 */
export function activeProfileDir(): string | null {
  const fromEnv = process.env['DSC_PROFILE']
  const name = typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : readProfileNameFromConfig()
  if (name === null) return null
  return dscPath('profiles', name)
}

function readProfileNameFromConfig(): string | null {
  try {
    const file = activeConfigFile()
    if (!existsSync(file)) return null
    const doc = parseTolerantYaml(readFileSync(file, 'utf8')) as { profile?: unknown }
    return typeof doc.profile === 'string' && doc.profile.trim() !== '' ? doc.profile.trim() : null
  } catch {
    return null
  }
}
