/**
 * 「一个包两半」的真机走查（迁自 `scripts/ui-two-halves-e2e.mjs`，断言 1:1）：
 * 把 examples/plugin-two-halves 装进 profile，起真宿主 + 真 Chromium，
 * 断言界面半那段真的画到了状态栏上。
 *
 * 与探针的差异：读数/截图落 tmpdir；「Electron 在 / 界面壳产物在 / statusbar 产物在」
 * 由 freshness 与下面的产物检查承担；「宿主起来 / 驱动写出读数」两道 gate 在 beforeAll。
 *
 * @module dsc/tests/e2e/ui-two-halves.e2e
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import {
  ROOT,
  electronUserData,
  freePort,
  mkdtempHome,
  probeFreshness,
  runElectronDriver,
  skipReason,
  startUiHost,
  stopHost,
  type UiHost,
} from './support/host.js'

const DRIVER = join(ROOT, 'scripts', '_ui-cordis-main.cjs')
const STATUS_BUNDLE = join(ROOT, 'lib', 'ui', 'plugins', 'statusbar', 'client.js')
const ID = 'dsc-demo-two-halves'

interface TwoHalvesResult {
  steps?: Array<{
    probe?: {
      rows?: Record<string, { state?: string; via?: string; fiber?: number }>
      twoHalves?: number
      faults?: string[]
      syncFailures?: string[]
    }
  }>
  error?: string
}

const fresh = probeFreshness()
if (!fresh.ok) console.warn(skipReason(fresh))

describe.skipIf(!fresh.ok)('ui-two-halves e2e：一个包两半（宿主半 + 界面半，真机）', () => {
  const { home } = mkdtempHome('dsc-two-halves-e2e-')
  const outDir = join(home, 'out')
  const shot = join(outDir, 'two-halves.png')
  const resultPath = join(outDir, 'two-halves.json')

  let host: UiHost | null = null
  let result: TwoHalvesResult | null = null

  beforeAll(async () => {
    // profile 里装示例包：宿主半（工具）+ 界面半（状态栏）来自同一个 bundle。
    mkdirSync(join(home, '.dsc'), { recursive: true })
    writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
    const profile = join(home, '.dsc', 'profiles', 'demo')
    mkdirSync(profile, { recursive: true })
    cpSync(join(ROOT, 'examples', 'plugin-two-halves'), join(profile, 'node_modules', ID), { recursive: true })
    writeFileSync(
      join(profile, 'package.json'),
      JSON.stringify({ name: 'demo-profile', private: true, dsh: { profile: { bundles: [ID] } } }, null, 2),
      'utf8',
    )

    rmSync(resultPath, { force: true })
    const port = await freePort()
    host = await startUiHost({
      label: 'two-halves',
      envExtra: {
        HOME: home,
        USERPROFILE: home,
        DSC_HOME: join(home, '.dsc'),
        DSC_PROFILE: 'demo',
        DSC_UI_PORT: String(port),
      },
    })
    result = (await runElectronDriver({
      driver: DRIVER,
      url: host.url,
      resultPath,
      timeoutMs: 240_000,
      envExtra: {
        DSC_CORDIS_RESULT_FILE: resultPath,
        DSC_CORDIS_USER_DATA: electronUserData(home),
        DSC_CORDIS_BUNDLE: STATUS_BUNDLE,
        DSC_CORDIS_SHOT: shot,
      },
    })) as TwoHalvesResult
  }, 420_000)

  afterAll(async () => {
    await stopHost(host)
    if (result !== null && result.error === undefined) rmSync(home, { recursive: true, force: true })
  })

  const first = () => result?.steps?.[0]?.probe

  test('statusbar 产物在（驱动拿它做 HMR 轮）', () => {
    expect(existsSync(STATUS_BUNDLE), STATUS_BUNDLE).toBe(true)
  })
  test('驱动写出的读数没有报错', () => {
    expect(result?.error, String(result?.error ?? '')).toBeUndefined()
  })
  test('组合包的界面半被壳装上了', () => {
    const row = first()?.rows?.[ID]
    expect(row !== undefined && row.state === 'loaded', JSON.stringify(row)).toBe(true)
  })
  test('它走的是 cordis 纤维且已生效', () => {
    const row = first()?.rows?.[ID]
    expect(row?.via === 'cordis' && row?.fiber === 2, JSON.stringify(row)).toBe(true)
  })
  test('界面上真的画出了示例那一段（data-two-halves）', () => {
    // 读数取的是 `[data-slot="shell.statusbar"]` 的 innerText，示例那段渲染在它的兄弟
    // 容器里，所以按示例自己的标记数（data-two-halves）判，别按那段文字判。
    expect(first()?.twoHalves, String(first()?.twoHalves)).toBe(1)
  })
  test('没有槽位故障', () => {
    expect(first()?.faults ?? [], JSON.stringify(first()?.faults)).toEqual([])
  })
  test('没有同步失败', () => {
    expect(first()?.syncFailures ?? [], JSON.stringify(first()?.syncFailures)).toEqual([])
  })
  test('截图在', () => {
    expect(existsSync(shot), shot).toBe(true)
  })
})
