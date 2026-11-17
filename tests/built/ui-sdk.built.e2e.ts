/**
 * 界面 SDK 类型产物层（B32/B49）：只验 `lib/ui/sdk/` 里真出来的那棵类型树。
 *
 * ## 为什么不能留在 check-ui
 *
 * `scripts/ui-sdk-types-test.mjs` 的断言是对的，但它是夜跑里的裸脚本：改坏了要等一夜，
 * 而且不在 JUnit 里。这里把它最关键的几段搬进 Vitest 的 built 层——被测对象仍是产物
 * （`lib/ui/sdk/@dsc/<包>/` + `examples/ui-sdk-types-demo` 的真 tsc），不碰 `src`。
 *
 * 与探针的分工：探针保留「第三方种子逐字节比对」与「临时工程 @ts-expect-error」两段
 * （它们依赖 `ui-shell` 的依赖树解析，迁移收益低）；本文件覆盖 1–5 段：
 * 树在不在、`@dsc/ui` 是不是合并锚点本体、包清单 types 落点、种子面一一对应、示例工程
 * 真 tsc 零错。
 *
 * 先 `pnpm run build && pnpm -C ui-shell build`；产物不在时整文件 skip 并写原因。
 *
 * @module dsc/tests/built/ui-sdk.built.e2e
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SDK_ROOT = join(ROOT, 'lib', 'ui', 'sdk')
const PACKAGES_JSON = join(ROOT, 'ui-shell', 'packages.json')
const PLATFORM_MODULES = join(ROOT, 'src', 'packages', 'ui-boot', 'ui', 'platform-modules.json')
const SAMPLE_DIR = join(ROOT, 'examples', 'ui-sdk-types-demo')

if (!existsSync(SDK_ROOT)) {
  console.warn(`ui-sdk built：类型树不在（${SDK_ROOT}）——先 pnpm run build && pnpm -C ui-shell build`)
}

describe.skipIf(!existsSync(SDK_ROOT))('界面 SDK 类型产物', () => {
  const declared = Object.keys(JSON.parse(readFileSync(PACKAGES_JSON, 'utf8')) as Record<string, string>)

  test('@dsc 作用域目录在，packages.json 里的每个包都有类型目录', () => {
    expect(existsSync(join(SDK_ROOT, '@dsc'))).toBe(true)
    const present = new Set(readdirSync(join(SDK_ROOT, '@dsc')))
    const missing = declared.filter((name) => !present.has(name.replace(/^@dsc\//, '')))
    expect(missing, `缺类型目录：${missing.join(', ')}`).toEqual([])
  })

  test('@dsc/ui 入口是 plugin-api 本体（合并锚点没被换成薄转发）', () => {
    const entry = join(SDK_ROOT, '@dsc', 'ui', 'index.d.ts')
    expect(existsSync(entry), entry).toBe(true)
    const body = readFileSync(entry, 'utf8')
    expect(body).toMatch(/interface SlotMap\b/)
    expect(body).toMatch(/interface SlotFactoryMap\b/)
    expect(body).toContain('defineUiPlugin')
    // plugin-api 独有的符号：出现说明入口不是一层壳。
    expect(body).toContain('HostStatusView')
    expect(body).toContain('requestAppearance')
  })

  test('每个包的 package.json 存在，types 指向真实文件', () => {
    for (const name of declared) {
      const dir = join(SDK_ROOT, '@dsc', name.replace(/^@dsc\//, ''))
      const manifestPath = join(dir, 'package.json')
      expect(existsSync(manifestPath), `${name} 缺 package.json`).toBe(true)
      const doc = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string
        version?: string
        files?: unknown
        types?: string
        exports?: Record<string, { types?: string }>
      }
      expect(doc.name, name).toBe(name)
      expect(typeof doc.version, `${name} 缺 version`).toBe('string')
      expect(Array.isArray(doc.files), `${name} 缺 files`).toBe(true)
      const entry = doc.exports?.['.']?.types ?? doc.types
      expect(typeof entry, `${name} 缺 types`).toBe('string')
      if (typeof entry === 'string') {
        expect(existsSync(join(dir, entry)), `${name} 的 types 指向不存在的 ${entry}`).toBe(true)
        expect(doc.types, `${name} 的 types 与 exports 不一致`).toBe(doc.exports?.['.']?.types)
      }
    }
  })

  test('平台种子面 ↔ 发布类型面一一对应', () => {
    const seeds = JSON.parse(readFileSync(PLATFORM_MODULES, 'utf8')) as unknown[]
    const dscSeeds = seeds.filter((seed): seed is string => typeof seed === 'string' && seed.startsWith('@dsc/'))
    expect(dscSeeds.length, JSON.stringify(seeds)).toBeGreaterThan(0)
    for (const seed of dscSeeds) {
      const dir = join(SDK_ROOT, '@dsc', seed.replace(/^@dsc\//, ''))
      expect(existsSync(dir), `种子 ${seed} 没有发布的类型包`).toBe(true)
    }
  })

  test('examples/ui-sdk-types-demo 对 SDK 真 tsc 零错', () => {
    expect(existsSync(join(SAMPLE_DIR, 'tsconfig.json')), SAMPLE_DIR).toBe(true)
    const require = createRequire(join(ROOT, 'package.json'))
    const tsc = require.resolve('typescript/lib/tsc.js')
    let output = ''
    try {
      output = execFileSync(process.execPath, [tsc, '-p', join(SAMPLE_DIR, 'tsconfig.json')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string }
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
    }
    expect(output.trim(), output.trim().split(/\r?\n/).slice(0, 6).join(' | ')).toBe('')
  })
})
