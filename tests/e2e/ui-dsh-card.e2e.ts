/**
 * 「dsh 插件的 diff 卡」真机走查（迁自 `scripts/ui-dsh-card-e2e.mjs`，断言 1:1）：
 * 起真宿主 + 假模型端点 + 真 Chromium，让一个 dsh 风格工具在真对话里跑一次，
 * 然后核对它的工具卡上真的画出了 diff。
 *
 * 为什么要有这一条：卡片这条链路过三跳（插件 presentResult → 宿主按 callId 缝回工具卡 →
 * 事件流 → 界面适配器挑渲染形态）。只测纯函数时，第三跳断了也看不出来——2026-10-26
 * 就断过一次：数据到了卡上，展开体只认 `call.change`，于是「有卡片、画不出来」。
 *
 * 与探针的差异：读数/截图落 tmpdir；「Electron 在 / 界面壳产物在 / 示例插件在」由
 * freshness 与下面两条静态检查承担；「宿主起来 / 驱动写出读数」两道 gate 在 beforeAll。
 *
 * @module dsc/tests/e2e/ui-dsh-card.e2e
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  sleep,
  startUiHost,
  stopHost,
  type UiHost,
} from './support/host.js'

const DRIVER = join(ROOT, 'scripts', '_ui-dsh-card-main.cjs')
const FAKE = join(ROOT, 'scripts', '_fake-llm.mjs')
const EXAMPLE = join(ROOT, 'examples', 'plugins', 'dsh-style-clock.js')

interface DshCardResult {
  error?: string
  probe?: { cards?: number; opened?: boolean; hasDiffBody?: boolean; diffAdded?: number; resultText?: string; statusbarText?: string }
}

const fresh = probeFreshness()
if (!fresh.ok) console.warn(skipReason(fresh))

describe.skipIf(!fresh.ok)('ui-dsh-card e2e：dsh 插件的 diff 卡（真对话 + 真机）', () => {
  const { home, dsc } = mkdtempHome('dsc-dsh-card-')
  const outDir = join(home, 'out')
  const shot = join(outDir, 'dsh-diff-card.png')
  const resultPath = join(outDir, 'dsh-diff-card.json')
  const noteFile = join(dsc, 'dsh-note.txt')

  let host: UiHost | null = null
  let llm: ReturnType<typeof spawn> | null = null
  let result: DshCardResult | null = null

  beforeAll(async () => {
    // [1] 环境：隔离 HOME、示例插件、假端点配置。
    const plugins = join(dsc, 'plugins')
    mkdirSync(plugins, { recursive: true })
    copyFileSync(EXAMPLE, join(plugins, 'dsh-style-clock.js'))

    const port = await freePort()
    const llmPort = await freePort()
    writeFileSync(
      join(dsc, 'config.yaml'),
      [
        '# 自检专用：一个指向本机假端点的 provider（不联网、不花钱）',
        'default:',
        '  provider: fake',
        '  model: fake-chat',
        'providers:',
        '  fake:',
        '    displayName: 自检假端点',
        '    baseURL: http://127.0.0.1:' + String(llmPort) + '/v1',
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

    // plugins.json 用宿主自己的写盘口生成：条目树有两个字段（disabled / config），
    // 手抄 JSON 容易漏掉 config 那一层的合并语义。registry 的 DSC_HOME 在 import 那一刻
    // 就定下了，所以先设环境变量再动态 import（boot 探针的教训）。
    process.env['HOME'] = home
    process.env['USERPROFILE'] = home
    process.env['DSC_HOME'] = dsc
    const registry = await import(new URL('../../lib/core/plugin-registry.js', import.meta.url).href) as {
      writePluginEnabled: (id: string, enabled: boolean) => void
      writePluginConfig: (id: string, config: Record<string, unknown>) => void
    }
    registry.writePluginEnabled('dsh-compat', true)
    registry.writePluginEnabled('dsh-style-clock.js', true)
    // 这条探针只验卡片，不验审批：工具本身是写文件的，缺省按 exec 处理会停在审批卡上。
    // 把 dsh_write_note 单条放宽到 read，别的工具不受影响（risks 是按工具名覆盖的）。
    registry.writePluginConfig('dsh-style-clock.js', { risks: { dsh_write_note: 'read' } })

    const toolCall = {
      name: 'dsh_write_note',
      arguments: { path: noteFile, text: '第一行：这条备注由 dsh 风格插件写入\n第二行：它带着一张 diff 卡片' },
    }

    // [2] 真跑：宿主提交一句话 → 假端点回工具调用 → 工具真的写文件 → 模型收尾。
    llm = spawn(process.execPath, [FAKE], {
      cwd: ROOT,
      env: {
        ...process.env,
        DSC_FAKE_LLM_PORT: String(llmPort),
        DSC_FAKE_LLM_DELAY: '0',
        DSC_FAKE_LLM_TOOL: JSON.stringify(toolCall),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await sleep(600)

    rmSync(resultPath, { force: true })
    host = await startUiHost({
      label: 'dsh-card',
      envExtra: {
        HOME: home,
        USERPROFILE: home,
        DSC_HOME: dsc,
        DSC_FAKE_KEY: 'sk-selfcheck-fake',
        DSC_UI_PORT: String(port),
      },
    })
    // [3] 读数 + 截图：卡展开后 .diff-body 在、加了行、结果里有投影文字。
    result = (await runElectronDriver({
      driver: DRIVER,
      url: host.url,
      resultPath,
      timeoutMs: 240_000,
      envExtra: {
        DSC_CARD_RESULT: resultPath,
        DSC_CARD_SHOT: shot,
        DSC_CARD_USER_DATA: electronUserData(home),
        DSC_CARD_QUESTION: '把这条备注写进文件，我要看它改了哪几行。',
        DSC_CARD_EXPECT: '已写入',
      },
    })) as DshCardResult
  }, 420_000)

  afterAll(async () => {
    await stopHost(host)
    llm?.kill()
    // registry 的 DSC_HOME 在 import 那一刻定下了；这里把进程级 env 还原，不带给别的文件
    // （vitest 默认按文件隔离 fork，还原是最后一道保险）。
    delete process.env['HOME']
    delete process.env['USERPROFILE']
    delete process.env['DSC_HOME']
    if (result !== null && result.error === undefined) rmSync(home, { recursive: true, force: true })
  })

  const probe = () => result?.probe ?? {}

  test('示例插件在（examples/plugins/dsh-style-clock.js）', () => {
    expect(existsSync(EXAMPLE), EXAMPLE).toBe(true)
  })
  test('驱动写出的读数没有报错', () => {
    expect(result?.error, String(result?.error ?? '').split('\n')[0]).toBeUndefined()
  })
  test('对话里出现了工具卡', () => {
    expect(Number(probe().cards ?? 0), JSON.stringify(probe().cards)).toBeGreaterThanOrEqual(1)
  })
  test('工具卡能展开', () => {
    expect(probe().opened, JSON.stringify(probe().opened)).toBe(true)
  })
  test('展开体里画出了 diff（.diff-body）', () => {
    expect(probe().hasDiffBody, JSON.stringify(probe().hasDiffBody)).toBe(true)
  })
  test('diff 有新增行', () => {
    expect(Number(probe().diffAdded ?? 0), String(probe().diffAdded)).toBeGreaterThanOrEqual(2)
  })
  test('结果里有插件的投影文字', () => {
    expect(String(probe().resultText ?? ''), String(probe().resultText)).toContain('已写入')
  })
  test('状态栏出了这一轮的读数', () => {
    // 这一轮真的跑过了，状态栏就该给出读数（0 轮 0 步是「没有样本」时才留空的）。
    expect(String(probe().statusbarText ?? ''), String(probe().statusbarText)).toMatch(/1 轮/)
  })
  test('截图在', () => {
    expect(existsSync(shot), shot).toBe(true)
  })
  test('文件真的被写了（卡片不是假的）', () => {
    expect(existsSync(noteFile) && readFileSync(noteFile, 'utf8').includes('第二行'), noteFile).toBe(true)
  })
})
