/**
 * cordis 装配真机走查（迁自 `scripts/ui-cordis-test.mjs` 的真机段，断言 1:1）：
 * 起隔离宿主 + 真 Chromium，量「statusbar 走 cordis」这条链路。
 *
 * 原探针的 [0] 段（cordis `inject` 语义自检，6 条断言）**不需要浏览器**，已按 A 组报告
 * 的建议拆去 `tests/integration/ui-cordis-inject.int.spec.ts`；本文件只保留真机段。
 *
 * 断言对应原探针：
 *   1. 19 条插件全装上；statusbar 的 via='cordis'、fiber=2（生效），其余 18 条仍是 cordis；
 *   2. 状态栏那一段在 DOM 里只有 1 份（多份 = 卸载不干净）；
 *   3. 换装一轮后新代码真的执行（产物里的标记出现），段数仍是 1；
 *   4. 全程没有槽位故障、没有同步失败、没有页面报错；
 *   5. 还原轮之后仍是 1 份（再卸再装仍然干净）。
 *
 * 踩过的两个坑（别再改回去）：
 *   - ELECTRON_RUN_AS_NODE 必须从环境里摘掉，否则 electron.exe 退回成普通 node；
 *   - 给 electron.exe 的命令行只能带入口地址这一个位置参数：多带一个（哪怕空串）它直接
 *     退出码 127。产物路径与截图路径走环境变量。
 *
 * 与探针的差异：读数/截图落 tmpdir；探针**没有**「截图存在」断言（证据图只打日志），
 * 迁移版保持原样不造新断言；「还原轮」在探针里缺轮就静默跳过，迁移版 skip 并写原因。
 *
 * @module dsc/tests/e2e/ui-cordis.e2e
 */
import { existsSync, rmSync } from 'node:fs'
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

const DRIVER = join(ROOT, 'scripts', '_ui-cordis-main.cjs')
const BUNDLE = join(ROOT, 'lib', 'ui', 'plugins', 'statusbar', 'client.js')

interface CordisResult {
  error?: string
  steps?: Array<{
    label: string
    nonce?: string
    probe?: {
      settled?: boolean
      rows?: Record<string, { state?: string; via?: string; fiber?: number }>
      statusbarEntries?: number
      statusbarText?: string
      viaAttrs?: string[]
      fiberAttrs?: string[]
      faults?: string[]
      syncFailures?: string[]
      batches?: Array<{ state?: string }>
      hmrMark?: string
    }
  }>
  console?: string[]
  shot?: string
}

const fresh = probeFreshness()
if (!fresh.ok) console.warn(skipReason(fresh))

describe.skipIf(!fresh.ok)('ui-cordis e2e：界面插件装配走 cordis（真机）', () => {
  const { home } = mkdtempHome('dsc-cordis-probe-')
  const outDir = join(home, 'out')
  const shot = join(outDir, 'cordis-probe.png')
  const resultPath = join(outDir, 'cordis-probe.json')

  let host: UiHost | null = null
  let result: CordisResult | null = null

  beforeAll(async () => {
    rmSync(resultPath, { force: true })
    const port = await freePort()
    host = await startUiHost({
      label: 'cordis-probe',
      envExtra: {
        HOME: home,
        USERPROFILE: home,
        DSC_HOME: join(home, '.dsc'),
        DSC_UI_HMR: '1',
        DSC_UI_HMR_POLL_MS: '250',
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
        DSC_CORDIS_BUNDLE: BUNDLE,
        DSC_CORDIS_SHOT: shot,
        DSC_CORDIS_DIAG: process.env['DSC_CORDIS_DIAG'] ?? '',
      },
    })) as CordisResult
  }, 420_000)

  afterAll(async () => {
    await stopHost(host)
    if (result !== null && result.error === undefined) rmSync(home, { recursive: true, force: true })
  })

  const first = (): NonNullable<CordisResult['steps']>[number]['probe'] | undefined => result?.steps?.[0]?.probe
  const ready = (): boolean => result?.steps?.[0]?.probe?.settled === true

  /** 原探针在 first 缺席时直接 return（后续不跑）：迁移成 skip 并写原因。 */
  const skipUnlessFirst = (ctx: TestContext): boolean => {
    const ok = ready()
    if (!ok) ctx.skip(`首帧落定读数没拿到（${JSON.stringify(result?.error ?? null)}），后续断言跳过（与原探针的 fail-fast 同款）`)
    return ok
  }

  test('statusbar 产物在（驱动拿它做换装轮）', () => {
    expect(existsSync(BUNDLE), BUNDLE).toBe(true)
  })
  test('拿到首帧落定读数', () => {
    const probe = result?.steps?.[0]?.probe
    expect(probe !== undefined && probe.settled === true, JSON.stringify(result?.error ?? probe ?? null)).toBe(true)
  })

  test('插件全部装上（≥19 条且全部 loaded）', (ctx) => {
    skipUnlessFirst(ctx)
    const rows = first()?.rows ?? {}
    const ids = Object.keys(rows)
    expect(ids.length >= 19 && ids.every((id) => rows[id].state === 'loaded'), ids.filter((id) => rows[id].state !== 'loaded').join('、')).toBe(true)
  })
  test('statusbar 走 cordis（via=cordis）', (ctx) => {
    skipUnlessFirst(ctx)
    expect(first()?.rows?.['statusbar']?.via === 'cordis', JSON.stringify(first()?.rows?.['statusbar'])).toBe(true)
  })
  test('statusbar 的纤维已生效（fiber=2）', (ctx) => {
    skipUnlessFirst(ctx)
    expect(first()?.rows?.['statusbar']?.fiber, String(first()?.rows?.['statusbar']?.fiber)).toBe(2)
  })
  test('其余插件条也全走 cordis（via=cordis）', (ctx) => {
    skipUnlessFirst(ctx)
    const rows = first()?.rows ?? {}
    const ids = Object.keys(rows).filter((id) => id !== 'statusbar')
    expect(ids.every((id) => rows[id].via === 'cordis'), ids.filter((id) => rows[id].via !== 'cordis').map((id) => `${id}=${String(rows[id].via)}`).join('、')).toBe(true)
  })
  test('全部纤维都生效（fiber=2）', (ctx) => {
    skipUnlessFirst(ctx)
    const rows = first()?.rows ?? {}
    const ids = Object.keys(rows)
    expect(ids.every((id) => rows[id].fiber === 2), ids.filter((id) => rows[id].fiber !== 2).map((id) => `${id}=${String(rows[id].fiber)}`).join('、')).toBe(true)
  })
  test('状态栏在 DOM 里只有 1 份', (ctx) => {
    skipUnlessFirst(ctx)
    expect(first()?.statusbarEntries, String(first()?.statusbarEntries)).toBe(1)
  })
  test('空会话里状态栏不画假读数（按设计留空）', (ctx) => {
    skipUnlessFirst(ctx)
    // 状态栏在空会话里**按设计留空**：步数为 0 时整段不画（2026-10-30 的决定，与 dsh 的
    // ActivityPill 同款）。真读数由带一轮对话的探针负责：ui-dsh-card.e2e。
    expect(first()?.statusbarText, JSON.stringify(first()?.statusbarText)).toBe('')
  })
  test('没有槽位故障', (ctx) => {
    skipUnlessFirst(ctx)
    expect(first()?.faults ?? [], (first()?.faults ?? []).join('、')).toEqual([])
  })
  test('没有同步失败', (ctx) => {
    skipUnlessFirst(ctx)
    expect(first()?.syncFailures ?? [], (first()?.syncFailures ?? []).join('、')).toEqual([])
  })
  test('两批都落定', (ctx) => {
    skipUnlessFirst(ctx)
    const batches = first()?.batches ?? []
    expect(batches.length >= 2 && batches.every((b) => b.state === 'done'), JSON.stringify(batches)).toBe(true)
  })
  test('诊断区每行都写着装配路径且纤维状态都是 2（诊断开着时）', (ctx) => {
    skipUnlessFirst(ctx)
    const viaAttrs = first()?.viaAttrs ?? []
    // 原探针：诊断区没开（viaAttrs 空）时这组 check 不跑，迁移成 skip 写原因。
    if (viaAttrs.length === 0) {
      ctx.skip('诊断区没开（viaAttrs 为空），与原探针同款跳过')
      return
    }
    const ids = Object.keys(first()?.rows ?? {})
    expect(viaAttrs.length === ids.length && viaAttrs.every((v) => v === 'cordis'), JSON.stringify(viaAttrs)).toBe(true)
    expect((first()?.fiberAttrs ?? []).every((v) => v === '2'), JSON.stringify(first()?.fiberAttrs)).toBe(true)
  })

  test('跑到了换装轮', (ctx) => {
    skipUnlessFirst(ctx)
    const swapped = result?.steps?.find((s) => s.label.startsWith('换装'))
    expect(swapped !== undefined, JSON.stringify(result?.steps?.map((s) => s.label))).toBe(true)
  })
  const swappedStep = () => result?.steps?.find((s) => s.label.startsWith('换装'))
  test('换装后新代码真的执行（标记出现）', (ctx) => {
    skipUnlessFirst(ctx)
    const swapped = swappedStep()
    if (swapped === undefined) {
      ctx.skip('没有换装轮，与原探针同款跳过')
      return
    }
    expect(swapped.probe?.hmrMark === swapped.nonce, `${String(swapped.probe?.hmrMark)} vs ${String(swapped.nonce)}`).toBe(true)
  })
  test('换装后状态栏仍是 1 份（卸旧装新干净）', (ctx) => {
    skipUnlessFirst(ctx)
    const swapped = swappedStep()
    if (swapped === undefined) {
      ctx.skip('没有换装轮，与原探针同款跳过')
      return
    }
    expect(swapped.probe?.statusbarEntries, String(swapped.probe?.statusbarEntries)).toBe(1)
  })
  test('换装后仍是 via=cordis 且 fiber=2', (ctx) => {
    skipUnlessFirst(ctx)
    const swapped = swappedStep()
    if (swapped === undefined) {
      ctx.skip('没有换装轮，与原探针同款跳过')
      return
    }
    const row = swapped.probe?.rows?.['statusbar']
    expect(row?.via === 'cordis' && row?.fiber === 2, JSON.stringify(row)).toBe(true)
  })
  test('换装后没有槽位故障', (ctx) => {
    skipUnlessFirst(ctx)
    const swapped = swappedStep()
    if (swapped === undefined) {
      ctx.skip('没有换装轮，与原探针同款跳过')
      return
    }
    expect(swapped.probe?.faults ?? [], (swapped.probe?.faults ?? []).join('、')).toEqual([])
  })

  const finalStep = () => result?.steps?.find((s) => s.label === '还原轮')
  test('还原后状态栏仍是 1 份', (ctx) => {
    skipUnlessFirst(ctx)
    const final = finalStep()
    // 原探针：还原轮缺席时这组 check 静默不跑（没有 else）；迁移成 skip 写原因——
    // 静默跳过和红是两回事，但都不许绿得不明不白。
    if (final === undefined) {
      ctx.skip('读数里没有「还原轮」（与原探针的静默跳过不同，这里留了痕）')
      return
    }
    expect(final.probe?.statusbarEntries, String(final.probe?.statusbarEntries)).toBe(1)
  })
  test('还原后没有槽位故障', (ctx) => {
    skipUnlessFirst(ctx)
    const final = finalStep()
    if (final === undefined) {
      ctx.skip('读数里没有「还原轮」（与原探针的静默跳过不同，这里留了痕）')
      return
    }
    expect(final.probe?.faults ?? [], (final.probe?.faults ?? []).join('、')).toEqual([])
  })

  test('全程页面没有 error/warning', (ctx) => {
    skipUnlessFirst(ctx)
    expect(result?.console ?? [], JSON.stringify(result?.console).slice(0, 600)).toEqual([])
  })
})
