/**
 * core/plugin-npm 的包级测试：钉住「按 npm 包形态装插件包」的四条不变量。
 *
 * 为什么用临时 profile 目录：这一层真的会跑 `pnpm add`、真的写 package.json 与
 * node_modules。绝不能在真实的 `~/.dsc` 上试，也不该依赖仓库自己的依赖树。
 *
 * 为什么断言「逐字节相同」而不是「JSON 深相等」：回滚的意义就是磁盘回到原样，
 * 格式化差异也算没还原干净。
 *
 * 迁移说明：入口改成 import 源码（`../../../core/plugin-npm.js`），不再依赖 `lib/` 产物。
 * @module @pneuma/plugin-manager/tests
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { installNpmBundle, removeNpmBundle } from '../../../core/plugin-npm.js'
import { pluginManagerPlugin } from '../index.js'

/** 工具声明里测试用得到的部分。 */
interface CapturedTool {
  name: string
  description: string
  parameters: {
    properties: Record<string, { type?: string; enum?: string[]; description?: string }>
    required?: string[]
  }
}

const root = mkdtempSync(join(tmpdir(), 'pneuma-plugin-npm-'))
const profileDir = join(root, 'profile')
const packageDir = join(root, 'probe-hello')

/** 造一个最小组合包：一个清单、一份 patch、一个入口。 */
function makeProbePackage(): void {
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: 'probe-hello',
        version: '1.0.0',
        main: 'index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  writeFileSync(join(packageDir, 'cordis.patch.yml'), "- insert:\n    - id: probe-hello\n      name: 'probe-hello'\n", 'utf8')
  writeFileSync(join(packageDir, 'index.js'), 'export default {}\n', 'utf8')
}

/** 造一个临时 profile 目录（最小 package.json）。 */
function makeProfile(): void {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{"name":"probe-profile","private":true}\n', 'utf8')
}

/** profile 清单的形状（测试读得到的部分）。 */
interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

/** 读 profile 的 package.json（每次都重读，断言的是磁盘上的现状）。 */
function profileManifest(): ProfileManifest {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as ProfileManifest
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

test('工具接线：action 枚举里有 install_package / remove_package，spec 参数在', () => {
  let tool: CapturedTool | undefined
  pluginManagerPlugin.apply({
    tools: {
      register(entry: CapturedTool) {
        tool = entry
        return () => {}
      },
    },
    effect(fn: () => unknown) {
      return fn()
    },
  } as unknown as Context, undefined)
  expect(tool, 'plugin_manager 工具没注册出来').toBeDefined()
  if (tool === undefined) throw new Error('plugin_manager 工具没注册出来')
  const actions = tool.parameters.properties['action']?.enum ?? []
  for (const action of ['install_package', 'remove_package']) {
    expect(actions, `缺少 action ${action}`).toContain(action)
    expect(tool.description).toContain(action)
  }
  expect(tool.parameters.properties['spec'], '缺少 spec 参数').toBeDefined()
  expect(actions).toContain('list')
  expect(actions).toContain('install')
})

test('装本地插件包：name/version/patch 都对，清单与 node_modules 落盘', async () => {
  makeProfile()
  makeProbePackage()
  const outcome = await installNpmBundle('file:' + packageDir, { profileDir })
  expect(outcome.ok, outcome.detail).toBe(true)
  expect(outcome.name).toBe('probe-hello')
  expect(typeof outcome.version === 'string' && outcome.version.length > 0).toBe(true)
  expect((outcome.patches ?? 0) >= 1).toBe(true)
  expect(existsSync(join(profileDir, 'node_modules', 'probe-hello', 'package.json'))).toBe(true)
  const manifest = profileManifest()
  expect(manifest.dsh?.profile?.bundles).toContain('probe-hello')
  expect(manifest.dependencies?.['probe-hello']).toBeTruthy()
})

test('pnpm 失败：清单与 lockfile 回到调用前（真回滚，不是只报错）', async () => {
  const before = readFileSync(join(profileDir, 'package.json'))
  const hadLock = existsSync(join(profileDir, 'pnpm-lock.yaml'))
  const outcome = await installNpmBundle('file:' + join(root, 'no-such-package-dir'), { profileDir })
  expect(outcome.ok, outcome.detail).toBe(false)
  expect(outcome.restored).toBe(true)
  expect(readFileSync(join(profileDir, 'package.json'))).toStrictEqual(before)
  expect(existsSync(join(profileDir, 'pnpm-lock.yaml'))).toBe(hadLock)
})

test('非法 spec：拒绝且 package.json 逐字节不变', async () => {
  const before = readFileSync(join(profileDir, 'package.json'))
  const outcome = await installNpmBundle('bad spec!!', { profileDir })
  expect(outcome.ok).toBe(false)
  expect(outcome.restored).not.toBe(false)
  const afterBytes = readFileSync(join(profileDir, 'package.json'))
  expect(afterBytes).toStrictEqual(before)
})

test('以 - 开头的 spec 被拒：那是 pnpm 的选项，不是包名', async () => {
  const before = readFileSync(join(profileDir, 'package.json'))
  const outcome = await installNpmBundle('-g', { profileDir })
  expect(outcome.ok).toBe(false)
  // 要点名「选项」，否则用户会以为只是包名写错了
  expect(outcome.detail).toMatch(/选项/)
  expect(readFileSync(join(profileDir, 'package.json'))).toStrictEqual(before)
})

test('找不到 pnpm：报人话，不动 profile', async () => {
  const before = readFileSync(join(profileDir, 'package.json'))
  const outcome = await installNpmBundle('probe-hello', {
    profileDir,
    pnpmPath: join(root, 'no-such-bin', 'pnpm'),
  })
  expect(outcome.ok).toBe(false)
  expect(outcome.detail, outcome.detail).toContain('找不到 pnpm')
  expect(readFileSync(join(profileDir, 'package.json'))).toStrictEqual(before)
})

test('卸载：bundles 与 dependencies 都不再含它', async () => {
  const outcome = await removeNpmBundle('probe-hello', { profileDir })
  expect(outcome.ok, outcome.detail).toBe(true)
  const manifest = profileManifest()
  expect(manifest.dsh?.profile?.bundles ?? []).not.toContain('probe-hello')
  expect(manifest.dependencies?.['probe-hello']).toBeUndefined()
})
