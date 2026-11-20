/**
 * `core/ui-bundles.ts` 的缺口补齐：第三方产物读不到、产物声明把文件指到目录外。
 *
 * 夹具全部是临时 DSC_HOME 下的手写清单与 bundle.json（同 `ui-bundles.spec.ts` 的口径）。
 *
 * @module dsc/core/w14b-ui-bundles-edges.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14b-ui-bundles-'))
process.env['DSC_HOME'] = HOME

type Ui = typeof import('./ui-bundles.js')
let ui: Ui
let serial = 0

beforeAll(async () => {
  ui = await import('./ui-bundles.js')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5 })
})

/** 一个新的插件根目录（只写壳契约版本）。 */
function builtinRoot(): string {
  serial += 1
  const dir = mkdtempSync(join(HOME, `root-${String(serial)}-`))
  writeFileSync(join(dir, ui.UI_PLUGIN_MANIFEST), JSON.stringify({ apiVersion: '2.0.0' }), 'utf8')
  return dir
}

/** 在插件根下写一个产物目录。 */
function addBundle(root: string, id: string, bundle: Record<string, unknown>, client = `console.log('${id}')\n`): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, ui.UI_PLUGIN_BUNDLE), JSON.stringify({ apiVersion: '2.0.0', ...bundle }), 'utf8')
  if (client !== '') writeFileSync(join(dir, 'client.js'), client, 'utf8')
  return dir
}

describe('第三方产物读不到', () => {
  test('id 成形、目录在、文件不在：给 null 而不是抛', () => {
    serial += 1
    const dir = mkdtempSync(join(HOME, `third-${String(serial)}-`))
    mkdirSync(join(dir, 'demo-plugin', 'ui'), { recursive: true })
    expect(ui.readThirdPartyUiPluginBundle('demo-plugin', dir)).toBeNull()
  })
})

describe('内置产物声明越界', () => {
  test('file 带路径分隔符：进声明层就被拒（所以收集阶段的 inside 围栏是第二道，见报告）', () => {
    const root = builtinRoot()
    addBundle(root, 'alpha', { file: '../escape.js' })
    const artifacts = ui.collectUiPluginArtifacts(root, 'web')
    expect(artifacts.entries).toEqual([])
    expect(artifacts.problems.some((line) => line.includes('文件名不成形'))).toBe(true)
  })
})
