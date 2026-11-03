/**
 * 默认 profile：首启在 `~/.dsc/profiles/default` 铺一份清单。
 *
 * 为什么需要：0.9 起功能包从应用里挂，用户装的第三方包与「覆盖版」官方包都放 profile。
 * 没有这个目录时，用户得先跑一次 `numa plugin add` 才知道路径；有它之后，
 * `activeProfileDir()` 直接认这个目录，解析顺序（profile 优先 / 应用优先）才有地方生效。
 *
 * 只写一次：目录里已有 package.json 就一个字节都不动。
 *
 * @module dsc/core/profile-bootstrap
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dscPath } from './path-policy.js'

/** 默认 profile 的清单内容（bundles 为空：基础行从应用里读，这里只放用户装的包）。 */
const DEFAULT_MANIFEST = {
  name: 'pneuma-profile',
  private: true,
  dsh: { profile: { bundles: [] as string[] } },
}

/**
 * 确保默认 profile 存在。
 * @returns profile 目录（绝对路径）
 */
export function ensureDefaultProfile(): string {
  const dir = dscPath('profiles', 'default')
  const manifest = join(dir, 'package.json')
  if (existsSync(manifest)) return dir
  mkdirSync(dir, { recursive: true })
  writeFileSync(manifest, JSON.stringify(DEFAULT_MANIFEST, null, 2) + '\n', 'utf8')
  return dir
}
