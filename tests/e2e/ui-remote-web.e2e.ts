/**
 * 「手机尺寸下的远程壳」真机走查（迁自 `scripts/ui-remote-web-e2e.mjs`，断言 1:1）：
 * 真宿主 + 真 Chromium，窗口 390×844。
 *
 * 为什么要有这条：移动端此前只有单测（`ui-mobile-shell-test.mjs` 128 条断言行的是纯逻辑）。
 * 真浏览器在窄屏下会不会横向溢出、19 条插件装不装得上、槽位有没有故障，只有真跑一次才算数。
 *
 * 与探针的差异：截图与读数落 `os.tmpdir()`（探针落 `desktop/shots/`，那条夜跑通道保留）；
 * 「Electron 在 / 界面壳产物在」两条环境检查由 freshness 预检承担（不满足整文件 skip）；
 * 「宿主起来了 / 驱动写出读数文件」两道 gate 由 beforeAll 承担——gate 失败整组红并带原因。
 *
 * @module dsc/tests/e2e/ui-remote-web.e2e
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
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

const DRIVER = join(ROOT, 'scripts', '_ui-mobile-main.cjs')
const WIDTH = 390
const HEIGHT = 844

const fresh = probeFreshness()
if (!fresh.ok) console.warn(skipReason(fresh))

describe.skipIf(!fresh.ok)('ui-remote-web e2e：手机尺寸下的远程壳（390×844，真机）', () => {
  const { home } = mkdtempHome('dsc-remote-web-')
  const outDir = join(home, 'out')
  const shot = join(outDir, 'remote-web-mobile.png')
  const resultPath = join(outDir, 'remote-web-mobile.json')

  let host: UiHost | null = null
  let parsed: { error?: string; probe?: { width?: number; composer?: boolean; plugins?: number; loaded?: number; failed?: string[]; faults?: number; overflow?: number } } | null = null

  beforeAll(async () => {
    rmSync(resultPath, { force: true })
    rmSync(shot, { force: true })
    const port = await freePort()
    host = await startUiHost({
      label: 'remote-web',
      envExtra: {
        HOME: home,
        USERPROFILE: home,
        DSC_HOME: join(home, '.dsc'),
        DSC_UI_PORT: String(port),
      },
    })
    parsed = (await runElectronDriver({
      driver: DRIVER,
      url: host.url,
      resultPath,
      timeoutMs: 180_000,
      envExtra: {
        DSC_MOBILE_RESULT: resultPath,
        DSC_MOBILE_SHOT: shot,
        DSC_MOBILE_W: String(WIDTH),
        DSC_MOBILE_H: String(HEIGHT),
        DSC_MOBILE_USER_DATA: electronUserData(home),
      },
    })) as typeof parsed
  }, 300_000)

  afterAll(async () => {
    await stopHost(host)
    // 失败现场留着翻；绿了才清（原探针同款纪律，third-party 那条写得最明白）。
    if (parsed !== null && parsed.error === undefined) rmSync(home, { recursive: true, force: true })
  })

  const probe = () => parsed?.probe ?? {}

  test('驱动写出的读数没有报错', () => {
    expect(parsed?.error, String(parsed?.error ?? '')).toBeUndefined()
  })
  test('窗口就是手机宽度（360~390）', () => {
    // innerWidth 比窗口窄一条滚动条（390 → 376 实测），所以按「矮不超过窗口、又不小于
    // 常见手机下限」判，而不是死等 390。
    expect(probe().width, String(probe().width)).toBeGreaterThanOrEqual(360)
    expect(probe().width, String(probe().width)).toBeLessThanOrEqual(WIDTH)
  })
  test('输入框在（壳起得来）', () => {
    expect(probe().composer, JSON.stringify(probe().composer)).toBe(true)
  })
  test('19 条插件全装上', () => {
    expect(
      Number(probe().plugins ?? 0) >= 19 && probe().loaded === probe().plugins,
      `plugins=${String(probe().plugins)} loaded=${String(probe().loaded)}`,
    ).toBe(true)
  })
  test('没有装失败的插件', () => {
    expect(probe().failed ?? [], JSON.stringify(probe().failed)).toEqual([])
  })
  test('没有槽位故障', () => {
    expect(Number(probe().faults ?? 0), String(probe().faults)).toBe(0)
  })
  test('没有横向溢出', () => {
    // 横向溢出是窄屏最常见的坏样子：多出 1px 就能横向拖动，整页跟着抖。
    expect(Number(probe().overflow ?? 99), `溢出 ${String(probe().overflow)}px`).toBeLessThanOrEqual(2)
  })
  test('截图在', () => {
    expect(existsSync(shot), shot).toBe(true)
  })
})
