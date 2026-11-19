/**
 * 「界面壳停用渲染器 / 骨架」真机走查（迁自 `scripts/ui-boot-e2e.mjs`，断言 1:1）。
 *
 * 为什么要有这一条：引导（`ui-boot/ui/main.tsx`）与渲染器（`ui-renderer/ui/ui.tsx`）
 * 各有一块「缺席诊断页」，但它们只在**真的被停用**时才走。纯函数测试只能证明
 * 「组件能渲染」，证明不了「开关→启动图→页面」这三跳接上了——2026-11-04 拆包时
 * 这一条恰好只验到七成。
 *
 * 四段真机（每段重开宿主与浏览器，互不污染）+ 一段纯文件的产物形态检查：
 *   [0] 产物形态：骨架的实现真在 bundle 里（体积、require 形状）——2026-11-04 夜搬完的判据；
 *   [1] normal：临时 HOME 里没有停用记录 → 骨架 .app 在、没有诊断文案；
 *   [2] layout-off：`ui-layout` 标 disabled → 诊断页含「界面布局 / ui-layout」且没有 .app；
 *   [3] renderer-off：`ui-renderer` 标 disabled → 诊断页含「界面渲染器」；
 *   [4] english：`language: en` → 页面是英文（config → 启动图 host.language → 文案那一跳）。
 *
 * 与探针的差异：读数/截图落 tmpdir（探针另写 `desktop/shots/ui-boot.json` 报告，那条夜跑
 * 通道保留）；段与段之间共用同一份 plugins.json，所以每段 beforeAll 都显式回正再停用
 * （原探针的教训：不等宿主真退，下一段会抢同一份文件的读写时序）。
 *
 * @module dsc/tests/e2e/ui-boot.e2e
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import {
  ROOT,
  electronUserData,
  freePort,
  probeFreshness,
  runElectronDriver,
  skipReason,
  startUiHost,
  stopHost,
  type UiHost,
} from './support/host.js'

const DRIVER = join(ROOT, 'scripts', '_ui-boot-e2e-main.cjs')
const RENDERER_CLIENT = join(ROOT, 'lib', 'ui', 'plugins', 'renderer', 'client.js')
const LAYOUT_CLIENT = join(ROOT, 'lib', 'ui', 'plugins', 'layout', 'client.js')
const PLUGIN_DIR = join(ROOT, 'lib', 'ui', 'plugins')

const fresh = probeFreshness()
if (!fresh.ok) console.warn(skipReason(fresh))

/** 截图在不在、有没有内容（一张纯黑 PNG 也有几 KB，所以门槛取 8KB，防的是空帧）。 */
function shotOk(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    return statSync(path).size > 8000
  } catch {
    return false
  }
}

/** 摘要：正文截一段，够事后看懂「页面上到底有什么」。 */
function textPeek(text: string | undefined): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700)
}

interface BootProbe {
  app: number
  appBox: { width: number; height: number } | null
  splash: boolean
  hasRendererDiag: boolean
  hasLayoutDiag: boolean
  hasUiLayout?: boolean
  hasUiRenderer?: boolean
  boot: { entries: string[]; disabled: string[]; host: { language: string } | null } | null
  text: string
}

interface BootResult {
  error?: string
  settleMs?: number
  probe?: BootProbe
}

describe.skipIf(!fresh.ok)('ui-boot e2e：停用渲染器 / 骨架时画的是诊断页（真机）', () => {
  // 每段（含 [0] 的形态检查与四段真机）共用一个临时 HOME：原探针就是一份 HOME 跑四段，
  // plugins.json 的「先全部回正再停用」是段间隔离的手段。
  const home = mkdtempSync(join(tmpdir(), 'dsc-ui-boot-'))
  const dsc = join(home, '.dsc')
  const outDir = join(home, 'out')
  mkdirSync(dsc, { recursive: true })
  mkdirSync(outDir, { recursive: true })

  /**
   * 写临时配置：假 provider + 可选的语言。语言是 english 段要验的东西：
   * `language: en` 经 `webserver` 进启动图的 `host.language`，界面据此取英文文案。
   */
  const writeConfig = (language: string | undefined): void => {
    writeFileSync(
      join(dsc, 'config.yaml'),
      [
        '# 自检专用：一个指向本机 discard 端口的假 provider（不联网、不花钱、不发请求）',
        'default:',
        '  provider: fake',
        '  model: fake-chat',
        ...(language === undefined ? [] : ['language: ' + language]),
        'providers:',
        '  fake:',
        '    displayName: 自检假端点',
        '    baseURL: http://127.0.0.1:9/v1',
        '    apiKeyEnv: DSC_FAKE_KEY',
        '    models:',
        '      - id: fake-chat',
        '        name: Fake Chat',
        '        contextWindow: 128000',
        '        maxTokens: 4096',
        '',
      ].join('\n'),
      'utf8',
    )
  }

  /** registry 的 DSC_HOME 在 import 那一刻定下：先设环境变量再动态 import（探针的教训）。 */
  const loadRegistry = async (): Promise<{
    readPluginEntries: () => Array<{ file: string; disabled?: boolean; config?: Record<string, unknown> }>
    writePluginEntries: (entries: Array<{ file: string; disabled?: boolean; config?: Record<string, unknown> }>) => void
  }> => {
    process.env['HOME'] = home
    process.env['USERPROFILE'] = home
    process.env['DSC_HOME'] = dsc
    return (await import(new URL('../../lib/core/plugin-registry.js', import.meta.url).href)) as Awaited<ReturnType<typeof loadRegistry>>
  }

  /** 把某几条插件标成停用（其余条目原样保留，走宿主自己的读写口，不手抄 JSON）。 */
  const writeDisabled = async (files: string[]): Promise<void> => {
    const registry = await loadRegistry()
    const entries = registry.readPluginEntries()
    // 先全部回正：四段共用同一份 plugins.json，上一段的停用不该漏进下一段的判断。
    for (const entry of entries) entry.disabled = false
    for (const file of files) {
      const index = entries.findIndex((entry) => entry.file === file)
      if (index < 0) entries.push({ file, disabled: true, config: {} })
      else entries[index] = { ...entries[index], disabled: true }
    }
    registry.writePluginEntries(entries)
  }

  /** 一段场景的通用外壳：回正/停用 → 起宿主 → 开页面 → 读数。 */
  const runScene = async (scene: { key: string; disabled: string[]; language?: string }): Promise<BootResult> => {
    if (scene.disabled.length === 0) {
      // 正常态：清掉停用记录（四段之间的文件是同一份，必须显式回正）。
      const registry = await loadRegistry()
      const entries = registry.readPluginEntries()
      for (const entry of entries) entry.disabled = false
      registry.writePluginEntries(entries)
    } else {
      await writeDisabled(scene.disabled)
    }
    writeConfig(scene.language)
    const resultPath = join(home, `boot-${scene.key}.json`)
    rmSync(resultPath, { force: true })
    const port = await freePort()
    const host = await startUiHost({
      label: scene.key,
      envExtra: {
        HOME: home,
        USERPROFILE: home,
        DSC_HOME: dsc,
        DSC_FAKE_KEY: 'sk-selfcheck-fake',
        DSC_UI_PORT: String(port),
      },
    })
    try {
      return (await runElectronDriver({
        driver: DRIVER,
        url: host.url,
        resultPath,
        timeoutMs: 240_000,
        envExtra: {
          DSC_BOOT_RESULT: resultPath,
          DSC_BOOT_SHOT: join(outDir, `ui-boot-${scene.key}.png`),
          DSC_BOOT_LABEL: scene.key,
          DSC_BOOT_USER_DATA: electronUserData(home, scene.key),
        },
      })) as BootResult
    } finally {
      await stopHost(host)
    }
  }

  // ── [0] 产物形态：骨架的实现必须真在 bundle 里（纯文件检查，不开浏览器） ----------
  describe('[0] 产物形态（纯文件，不开浏览器）', () => {
    test('渲染器产物在', () => {
      expect(existsSync(RENDERER_CLIENT), RENDERER_CLIENT).toBe(true)
    })
    test('骨架产物在', () => {
      expect(existsSync(LAYOUT_CLIENT), LAYOUT_CLIENT).toBe(true)
    })
    test('骨架产物体积说明实现真在里面（> 30 KB）', () => {
      const layoutCode = readFileSync(LAYOUT_CLIENT, 'utf8')
      expect(Buffer.byteLength(layoutCode), `${String(Buffer.byteLength(layoutCode))} B`).toBeGreaterThan(30 * 1024)
    })
    test('骨架产物从平台种子取共享状态（require @dsc/ui-runtime）', () => {
      const layoutCode = readFileSync(LAYOUT_CLIENT, 'utf8')
      expect(layoutCode.includes('require("@dsc/ui-runtime")'), '缺 require("@dsc/ui-runtime")').toBe(true)
    })
    test('骨架产物不把布局包留成 require（实现是内联的）', () => {
      const layoutCode = readFileSync(LAYOUT_CLIENT, 'utf8')
      expect(layoutCode.includes('require("@dsc/ui-layout")'), '实现没有内联，还 require("@dsc/ui-layout")').toBe(false)
    })
    test('没有产物 require 内核或布局包', () => {
      // 所有产物都不许 require 这两个：前者不提供给插件，后者只属于布局自己。
      const offenders = readdirSync(PLUGIN_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ id: entry.name, code: readFileSync(join(PLUGIN_DIR, entry.name, 'client.js'), 'utf8') }))
        .filter(
          (row) =>
            row.code.includes('require("@dsc/ui-core")') ||
            (row.id !== 'layout' && row.code.includes('require("@dsc/ui-layout")')),
        )
        .map((row) => row.id)
      expect(offenders, offenders.join(',')).toEqual([])
    })
  })

  // ── [1] normal ────────────────────────────────────────────────────────────────
  describe('[1] normal：正常态，骨架画出来了，没有诊断文案', () => {
    let result: BootResult | null = null
    const shot = join(outDir, 'ui-boot-normal.png')

    beforeAll(async () => {
      result = await runScene({ key: 'normal', disabled: [] })
    }, 420_000)

    const probe = (): BootProbe => result?.probe ?? { app: 0, appBox: null, splash: true, hasRendererDiag: true, hasLayoutDiag: true, boot: null, text: '' }

    test('整段跑通（驱动没有报错）', () => {
      expect(result?.error, String(result?.error ?? '').split('\n')[0]).toBeUndefined()
    })
    test('页面里有骨架根节点 .app', () => {
      expect(probe().app, `.app 个数=${String(probe().app)}`).toBeGreaterThanOrEqual(1)
    })
    test('.app 有可见尺寸（不是 0×0 的空壳）', () => {
      const appBox = probe().appBox
      expect(appBox !== null && appBox.width >= 200 && appBox.height >= 200, JSON.stringify(appBox)).toBe(true)
    })
    test('没有渲染器诊断文案（「界面渲染器」）', () => {
      expect(probe().hasRendererDiag, textPeek(probe().text)).toBe(false)
    })
    test('没有布局诊断文案（「界面布局」）', () => {
      expect(probe().hasLayoutDiag, textPeek(probe().text)).toBe(false)
    })
    test('启动图里有 layout 与 renderer 两条', () => {
      const boot = probe().boot
      expect(boot !== null && boot.entries.includes('layout') && boot.entries.includes('renderer'), JSON.stringify(boot === null ? null : boot.entries)).toBe(true)
    })
    test('启动图 disabled 里没有 layout / renderer', () => {
      const boot = probe().boot
      expect(boot !== null && !boot.disabled.includes('layout') && !boot.disabled.includes('renderer'), JSON.stringify(boot === null ? null : boot.disabled)).toBe(true)
    })
    test('启动占位 #boot-splash 已退场', () => {
      expect(probe().splash, String(probe().splash)).toBe(false)
    })
    test('截图在且不是空帧', () => {
      expect(shotOk(shot), shot).toBe(true)
    })
  })

  // ── [2] layout-off ────────────────────────────────────────────────────────────
  describe('[2] layout-off：停用骨架，画布局诊断页，没有 .app', () => {
    let result: BootResult | null = null
    const shot = join(outDir, 'ui-boot-layout-off.png')

    beforeAll(async () => {
      result = await runScene({ key: 'layout-off', disabled: ['ui-layout'] })
    }, 420_000)

    const probe = (): BootProbe => result?.probe ?? { app: 0, appBox: null, splash: true, hasRendererDiag: false, hasLayoutDiag: false, boot: null, text: '' }

    test('整段跑通（驱动没有报错）', () => {
      expect(result?.error, String(result?.error ?? '').split('\n')[0]).toBeUndefined()
    })
    test('页面文字里有「界面布局」', () => {
      expect(probe().hasLayoutDiag, textPeek(probe().text)).toBe(true)
    })
    test('页面文字里有「ui-layout」', () => {
      expect(probe().hasUiLayout, textPeek(probe().text)).toBe(true)
    })
    test('页面里没有骨架根节点 .app', () => {
      expect(probe().app, `.app 个数=${String(probe().app)}`).toBe(0)
    })
    test('启动图 disabled 里记着 layout', () => {
      const boot = probe().boot
      expect(boot !== null && boot.disabled.includes('layout'), JSON.stringify(boot === null ? null : boot.disabled)).toBe(true)
    })
    test('启动图 entries 里没有 layout、仍有 renderer', () => {
      const boot = probe().boot
      expect(boot !== null && !boot.entries.includes('layout') && boot.entries.includes('renderer'), JSON.stringify(boot === null ? null : boot.entries)).toBe(true)
    })
    test('诊断页不是空白（正文长度 > 40）', () => {
      const len = textPeek(probe().text).length
      expect(len > 40, `长度=${String(len)}`).toBe(true)
    })
    test('启动占位 #boot-splash 已退场（诊断页没被盖住）', () => {
      expect(probe().splash, String(probe().splash)).toBe(false)
    })
    test('截图在且不是空帧', () => {
      expect(shotOk(shot), shot).toBe(true)
    })
  })

  // ── [3] renderer-off ─────────────────────────────────────────────────────────
  describe('[3] renderer-off：停用渲染器，画渲染器诊断页', () => {
    let result: BootResult | null = null
    const shot = join(outDir, 'ui-boot-renderer-off.png')

    beforeAll(async () => {
      result = await runScene({ key: 'renderer-off', disabled: ['ui-renderer'] })
    }, 420_000)

    const probe = (): BootProbe => result?.probe ?? { app: 0, appBox: null, splash: true, hasRendererDiag: false, hasLayoutDiag: false, boot: null, text: '' }

    test('整段跑通（驱动没有报错）', () => {
      expect(result?.error, String(result?.error ?? '').split('\n')[0]).toBeUndefined()
    })
    test('页面文字里有「界面渲染器」', () => {
      expect(probe().hasRendererDiag, textPeek(probe().text)).toBe(true)
    })
    test('页面文字里有「ui-renderer」', () => {
      expect(probe().hasUiRenderer, textPeek(probe().text)).toBe(true)
    })
    test('页面里没有骨架根节点 .app', () => {
      expect(probe().app, `.app 个数=${String(probe().app)}`).toBe(0)
    })
    test('启动图 disabled 里记着 renderer', () => {
      const boot = probe().boot
      expect(boot !== null && boot.disabled.includes('renderer'), JSON.stringify(boot === null ? null : boot.disabled)).toBe(true)
    })
    test('启动图 entries 里没有 renderer、骨架 layout 仍在', () => {
      const boot = probe().boot
      expect(boot !== null && !boot.entries.includes('renderer') && boot.entries.includes('layout'), JSON.stringify(boot === null ? null : boot.entries)).toBe(true)
    })
    test('诊断页不是空白（正文长度 > 40）', () => {
      const len = textPeek(probe().text).length
      expect(len > 40, `长度=${String(len)}`).toBe(true)
    })
    test('启动占位 #boot-splash 已退场（诊断页没被盖住）', () => {
      expect(probe().splash, String(probe().splash)).toBe(false)
    })
    test('截图在且不是空帧', () => {
      expect(shotOk(shot), shot).toBe(true)
    })
  })

  // ── [4] english ──────────────────────────────────────────────────────────────
  describe('[4] english：language: en 时页面是英文', () => {
    let result: BootResult | null = null
    const shot = join(outDir, 'ui-boot-english.png')

    beforeAll(async () => {
      result = await runScene({ key: 'english', disabled: [], language: 'en' })
    }, 420_000)

    const probe = (): BootProbe => result?.probe ?? { app: 0, appBox: null, splash: true, hasRendererDiag: true, hasLayoutDiag: true, boot: null, text: '' }

    test('整段跑通（驱动没有报错）', () => {
      expect(result?.error, String(result?.error ?? '').split('\n')[0]).toBeUndefined()
    })
    test('启动图 host.language 是 en', () => {
      // 语言从 config.yaml 一路到页面：启动图带的 host.language 就是这一段要证的那一跳。
      const boot = probe().boot
      expect(boot !== null && boot.host !== null && boot.host.language === 'en', JSON.stringify(boot === null ? null : boot.host)).toBe(true)
    })
    test('骨架 .app 在（英文界面不是白屏）', () => {
      expect(probe().app, `.app 个数=${String(probe().app)}`).toBeGreaterThanOrEqual(1)
    })
    test('侧栏有「New session」（文案跟着语言走）', () => {
      expect(/New session/.test(probe().text), textPeek(probe().text)).toBe(true)
    })
    test('侧栏有「Settings」', () => {
      expect(/Settings/.test(probe().text), textPeek(probe().text)).toBe(true)
    })
    test('不再出现「新会话」', () => {
      expect(/新会话/.test(probe().text), textPeek(probe().text)).toBe(false)
    })
    test('不再出现「设置」', () => {
      expect(/设置/.test(probe().text), textPeek(probe().text)).toBe(false)
    })
    test('没有诊断文案（不是靠停用凑出来的英文）', () => {
      expect(probe().hasLayoutDiag === false && probe().hasRendererDiag === false, textPeek(probe().text)).toBe(true)
    })
    test('截图在且不是空帧', () => {
      expect(shotOk(shot), shot).toBe(true)
    })
  })
})
