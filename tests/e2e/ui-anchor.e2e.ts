/**
 * 浮层锚定（CSS 锚点定位）的真机走查（迁自 `scripts/ui-anchor-e2e.mjs`，断言 1:1）：
 * 真宿主 + 真 Chromium，量打开下拉之后的终态。
 *
 * 为什么要真机：锚点定位是浏览器的活，纯逻辑测不出来「贴上去了没有」。这里量的是
 * 真实矩形——左缘对齐、间距等于 gap、不窄于触发钮、打开当帧就不是隐藏态。
 *
 * 与探针的差异：读数/截图落 tmpdir；「Electron 在 / 界面壳产物在」由 freshness 承担；
 * 「宿主起来 / 驱动写出读数」两道 gate 在 beforeAll；条件分支（读数里真量到了才断言
 * 细节矩形）保持原判——前提行作为独立 test 先行断言，与探针的 check 顺序一一对应。
 *
 * @module dsc/tests/e2e/ui-anchor.e2e
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, type TestContext } from 'vitest'

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

const DRIVER = join(ROOT, 'scripts', '_ui-anchor-main.cjs')

interface AnchorResult {
  error?: string
  measure?: {
    error?: string
    visibility?: string
    anchorName?: string
    positionAnchor?: string
    tryFallbacks?: string
    trigger?: { left?: number; top?: number; bottom?: number; width?: number }
    pop?: { left?: number; top?: number; bottom?: number; width?: number; height?: number }
  }
  flip?: {
    viewport?: number
    trigger?: { top?: number }
    pop?: { top?: number; bottom?: number; height?: number }
  }
  hover?: {
    scrolled?: number
    viewport?: { w?: number }
    before?: { anchorTop?: number; anchorLeft?: number; cardTop?: number; cardBottom?: number; cardLeft?: number; cardWidth?: number }
    after?: { anchorTop?: number; cardBottom?: number }
  }
}

const fresh = probeFreshness()
if (!fresh.ok) console.warn(skipReason(fresh))

describe.skipIf(!fresh.ok)('ui-anchor e2e：下拉浮层贴锚点（CSS 锚点定位，真机）', () => {
  const { home } = mkdtempHome('dsc-anchor-')
  const outDir = join(home, 'out')
  const shot = join(outDir, 'anchor-popover.png')
  const resultPath = join(outDir, 'anchor-popover.json')

  let host: UiHost | null = null
  let result: AnchorResult | null = null

  beforeAll(async () => {
    rmSync(resultPath, { force: true })
    const port = await freePort()
    host = await startUiHost({
      label: 'anchor',
      envExtra: {
        HOME: home,
        USERPROFILE: home,
        DSC_HOME: join(home, '.dsc'),
        DSC_UI_PORT: String(port),
      },
    })
    result = (await runElectronDriver({
      driver: DRIVER,
      url: host.url,
      resultPath,
      timeoutMs: 180_000,
      envExtra: {
        DSC_ANCHOR_RESULT: resultPath,
        DSC_ANCHOR_SHOT: shot,
        DSC_ANCHOR_USER_DATA: electronUserData(home),
      },
    })) as AnchorResult
  }, 300_000)

  afterAll(async () => {
    await stopHost(host)
    if (result !== null && result.error === undefined) rmSync(home, { recursive: true, force: true })
  })

  const measured = () => result?.measure ?? {}
  const pop = () => measured().pop ?? {}
  const trigger = () => measured().trigger ?? {}

  /**
   * 探针的条件分支语义：前提那条 check 不成立时，它管着的细节断言**跳过**（不是连锁红）。
   * 这里原样保留：前提不成立 → ctx.skip 并写原因。
   */
  const skipUnless = (ctx: TestContext, ok: boolean, detail: string): void => {
    if (!ok) ctx.skip(`前提不成立（${detail}），细节断言跳过（与原探针同款）`)
  }

  test('设置里找到了一个下拉并打开了浮层', () => {
    expect(measured().error === undefined && pop().width !== undefined && Number(pop().width) > 0, JSON.stringify(measured().error ?? pop())).toBe(true)
  })
  test('浮层左缘对齐触发钮（±1px）', (ctx) => {
    skipUnless(ctx, measured().error === undefined && Number(pop().width) > 0, '没量到下拉浮层')
    expect(Math.abs(Number(pop().left) - Number(trigger().left)), `${String(pop().left)} vs ${String(trigger().left)}`).toBeLessThanOrEqual(1)
  })
  test('浮层贴着触发钮（下方或上方，间距 4px ±2）', (ctx) => {
    skipUnless(ctx, measured().error === undefined && Number(pop().width) > 0, '没量到下拉浮层')
    const below = Number(pop().top) - Number(trigger().bottom)
    const above = Number(trigger().top) - (Number(pop().top) + Number(pop().height))
    expect(Math.abs(below - 4) <= 2 || Math.abs(above - 4) <= 2, `下 ${String(below)} / 上 ${String(above)}`).toBe(true)
  })
  test('浮层不窄于触发钮', (ctx) => {
    skipUnless(ctx, measured().error === undefined && Number(pop().width) > 0, '没量到下拉浮层')
    expect(Number(pop().width) + 0.5 >= Number(trigger().width), `${String(pop().width)} vs ${String(trigger().width)}`).toBe(true)
  })
  test('打开当帧就不是隐藏态（没有「先画错再挪」的空窗）', (ctx) => {
    skipUnless(ctx, measured().error === undefined && Number(pop().width) > 0, '没量到下拉浮层')
    expect(measured().visibility, String(measured().visibility)).not.toBe('hidden')
  })
  test('浏览器真的用上了锚点定位（触发钮有 anchor-name，浮层有 position-anchor）', (ctx) => {
    skipUnless(ctx, measured().error === undefined && Number(pop().width) > 0, '没量到下拉浮层')
    expect(
      String(measured().anchorName ?? '').startsWith('--') && String(measured().positionAnchor ?? '').startsWith('--'),
      JSON.stringify({ anchorName: measured().anchorName, positionAnchor: measured().positionAnchor }),
    ).toBe(true)
  })
  test('放不下时的翻向真的生效（position-try-fallbacks 含 flip-block）', (ctx) => {
    skipUnless(ctx, measured().error === undefined && Number(pop().width) > 0, '没量到下拉浮层')
    // 翻向要靠 position-try-fallbacks。它要是被 React 丢了，翻向就静默失效。
    expect(String(measured().tryFallbacks ?? ''), String(measured().tryFallbacks)).toContain('flip-block')
  })

  // 翻向机制：窗口底部粘一个锚点 + 120 高的浮层，下方放不下时必须翻到上方。
  describe('翻向机制（底部锚点）', () => {
    const flip = () => result?.flip ?? {}
    const flipPop = () => flip().pop ?? {}
    const flipTrigger = () => flip().trigger ?? {}

    test('翻向探针量到了（锚点与浮层都在）', () => {
      expect(Number(flipPop().height) > 0, JSON.stringify(flip())).toBe(true)
    })
    test('下方放不下时翻到锚点上方', (ctx) => {
      skipUnless(ctx, Number(flipPop().height) > 0, '翻向探针没量到')
      expect(Number(flipPop().bottom) <= Number(flipTrigger().top) + 1, `浮层底 ${String(flipPop().bottom)} vs 锚点顶 ${String(flipTrigger().top)}`).toBe(true)
    })
    test('翻上去之后仍在窗口里', (ctx) => {
      skipUnless(ctx, Number(flipPop().height) > 0, '翻向探针没量到')
      expect(Number(flipPop().top) >= -1, `${String(flipPop().top)} / 窗口 ${String(flip().viewport)}`).toBe(true)
    })
  })

  // 「文件已更改」悬停卡那套定位：锚点在聊天区深处、卡片是 body 下的 fixed 浮层。
  describe('悬停卡定位（fixed 浮层跟随滚动）', () => {
    const hover = () => result?.hover ?? {}
    const before = () => hover().before ?? {}
    const after = () => hover().after ?? {}

    test('悬停卡定位量到了（锚点与固定浮层都在）', () => {
      expect(Number(before().cardWidth) > 0, JSON.stringify(hover())).toBe(true)
    })
    test('卡片贴锚点上方、间距 6px（±1）', (ctx) => {
      skipUnless(ctx, Number(before().cardWidth) > 0, '悬停卡没量到')
      expect(Math.abs(Number(before().anchorTop) - Number(before().cardBottom) - 6), `卡底 ${String(before().cardBottom)} / 锚点顶 ${String(before().anchorTop)}`).toBeLessThanOrEqual(1)
    })
    test('左缘 = 锚点左缘 − 24 后夹进视口（±1）', (ctx) => {
      skipUnless(ctx, Number(before().cardWidth) > 0, '悬停卡没量到')
      const expectedLeft = Math.max(
        8,
        Math.min(Number(before().anchorLeft) - 24, Number(hover().viewport?.w ?? 1280) - 340 - 8),
      )
      expect(Math.abs(Number(before().cardLeft) - expectedLeft), `${String(before().cardLeft)} vs ${String(expectedLeft)}`).toBeLessThanOrEqual(1)
    })
    test('聊天区真的滚动了（跟随断言的前提）', (ctx) => {
      skipUnless(ctx, Number(before().cardWidth) > 0, '悬停卡没量到')
      expect(Number(hover().scrolled) > 0, String(hover().scrolled)).toBe(true)
    })
    test('滚动之后卡片仍贴着锚点（差 ≤1px，fixed 浮层跟着行走）', (ctx) => {
      skipUnless(ctx, Number(before().cardWidth) > 0, '悬停卡没量到')
      expect(Math.abs(Number(after().anchorTop) - Number(after().cardBottom) - 6), `卡底 ${String(after().cardBottom)} / 锚点顶 ${String(after().anchorTop)}`).toBeLessThanOrEqual(1)
    })
  })

  test('驱动没有报错', () => {
    expect(result?.error, String(result?.error ?? '')).toBeUndefined()
  })
  test('截图在', () => {
    expect(existsSync(shot), shot).toBe(true)
  })
})
