/**
 * 长期记忆评估的真回合段（迁自 `scripts/memory-eval-test.mjs` 的 C）。
 *
 * ## 为什么必须真回合
 *
 * 评估报告里两个数只有在**真回合**里才会动：
 *   - `injected`：记忆真的被写进提示词的那一轮才 +1（同一回合发两次请求也只 +1）；
 *   - `citedCount`：只在这轮回话**命中条目片段**时 +1（隐式使用反馈）。
 *
 * 纯模块那半（A、B 两段）在 `src/packages/memory/tests/memory-eval.spec.ts`，不需要 build。
 * 这里验的是「接线之后计数还在动」：假模型按剧本回话，`/memory eval` 与设置分区的只读
 * 统计行都走真出口。
 *
 * ## 装配上的两个前提
 *
 * - harness 默认把 memory 关掉（它会多发一次请求吃掉剧本），这里预置 `plugins.json`
 *   把注入打开、复盘与自动整理关掉（本文件自己控时机）；
 * - 两条记忆在**内核起来之前**就摆在盘上：起内核之后再写会被记忆插件当成「外部改动」，
 *   计数路径就不干净了。
 *
 * ## 迁移差异
 *
 * 假端点从探针自写的 `createServer` 换成 `fakeLLM`：剧本按请求序号发——第一条是工具调用
 * （制造同回合的第二次请求），第二条回话里带条目甲的片段，第三条随便收尾。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 临时主目录。 */
const home = tempHome('dsc-memory-eval-int-')
/** `.dsc` 目录（与 integration setup 口径一致：走 HOME，不设 DSC_HOME）。 */
const dsc = join(home.home, '.dsc')
/** 第一条记忆的正文（回话里会原样带出来命中引用计数）。 */
const ENTRY_A = '记忆甲片段甲子乙丑丙寅丁卯'
/** 第二条记忆的正文（本文件不让回话提它，用来验负向）。 */
const ENTRY_B = '记忆乙片段子丑寅卯辰巳午未'

type MemoryModule = typeof import('@pneuma/runtime/packages/memory/memory.js')

/** 内核里本文件用到的服务面。 */
interface SettingsField {
  type: string
  label?: string
  text?: string
  action?: string
}

interface Services {
  settings: {
    sections(): Array<{ id: string; fields: SettingsField[] }>
    action(id: string, name: string): Promise<{ ok: boolean; notice?: string; data?: unknown }>
  }
  tools: { register(entry: Record<string, unknown>): () => void }
  commands: { run(input: string, runtime: unknown, ui: { notice(line: string): void }): boolean }
  agent: { isRunning(filePath: string): boolean }
  session: { current(): { filePath: string } }
}

let llm: FakeLLM
let kernel: BootedKernel
let services: Services
let memory: MemoryModule

/** 账本读数（每次现读，不缓存）。 */
const usageOf = (): Record<string, { count?: number; injected?: number; last?: number; lastInjected?: number }> => memory.readUsage()
/** 某一格的注入次数。 */
const injectedOf = (key: string): number => usageOf()[key]?.injected ?? 0
/** 某一格的引用次数。 */
const countOf = (key: string): number => usageOf()[key]?.count ?? 0

beforeAll(async () => {
  mkdirSync(dsc, { recursive: true })
  // memory 打开注入、关掉复盘与自动整理；sandbox / session-title 一并关掉（harness 只在这份
  // 文件不存在时才写默认清单，所以这里必须自己写全，否则标题请求会吃掉一轮剧本）。
  writeFileSync(
    join(dsc, 'plugins.json'),
    JSON.stringify(
      {
        version: 1,
        entries: [
          { file: 'memory', config: { enabled: true, reviewEnabled: false, reviewEveryTurns: 0, pruneEnabled: false } },
          { file: 'sandbox', disabled: true },
          { file: 'session-title', disabled: true },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(join(dsc, 'config.yaml'), 'model:\n  name: test\n', 'utf8')
  const memGlobal = join(dsc, 'memory', 'global')
  mkdirSync(memGlobal, { recursive: true })
  writeFileSync(join(memGlobal, 'MEMORY.md'), `${ENTRY_A}\n§\n${ENTRY_B}\n`, 'utf8')

  memory = await import('@pneuma/runtime/packages/memory/memory.js')
  // 剧本：①工具调用（制造同回合第二次请求）②回话命中甲 ③第二轮随便收尾。
  llm = await fakeLLM({ turns: [{ toolCall: { name: 'echo_probe', args: {} } }, `收尾。${ENTRY_A}`, '收到'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  services = kernel.ctx as unknown as Services
  services.tools.register({
    name: 'echo_probe',
    description: '测试用回声工具',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    run: async () => 'probe ok',
  })
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
  home.restore()
})

describe('真回合：注入计数与引用计数', () => {
  /** 两格条目的账本 key。 */
  let keyA: string
  let keyB: string
  /** 第一回合之前的基线读数。 */
  let baseA: number
  let baseB: number
  let baseCiteA: number

  beforeAll(async () => {
    keyA = memory.entryUsageKey('global', ENTRY_A)
    keyB = memory.entryUsageKey('global', ENTRY_B)
    baseA = injectedOf(keyA)
    baseB = injectedOf(keyB)
    baseCiteA = countOf(keyA)
    await kernel.runTurn('开跑')
  })

  test('一次真回合后甲、乙的 injected 各递增 1', () => {
    expect(injectedOf(keyA)).toBe(baseA + 1)
    expect(injectedOf(keyB)).toBe(baseB + 1)
  })

  test('同回合第二次请求不重复递增（负向锚点：这一回合走了两次请求）', () => {
    // 本回合确实有两次请求：工具调用 + 收尾。若没按回合去重，这里会是 +2。
    expect(llm.requestCount).toBeGreaterThanOrEqual(2)
    expect(injectedOf(keyA) - baseA).toBe(1)
  })

  test('回话命中甲片段 → 甲 citedCount +1；没提乙 → 乙保持 0', () => {
    expect(countOf(keyA)).toBe(baseCiteA + 1)
    expect(countOf(keyB)).toBe(0)
  })

  test('第二回合：injected 再 +1，回话没命中 → 引用不动', async () => {
    await kernel.runTurn('再来一轮')
    expect(injectedOf(keyA)).toBe(baseA + 2)
    expect(countOf(keyA)).toBe(baseCiteA + 1)
  })

  test('账文件形状：注入维（injected / lastInjected）与引用维（count / last）都在', () => {
    const raw = JSON.parse(readFileSync(memory.usageFile(), 'utf8')) as Record<string, Record<string, unknown>>
    expect(typeof raw[keyA]?.['injected']).toBe('number')
    expect(raw[keyA]?.['injected']).toBe(baseA + 2)
    expect(typeof raw[keyA]?.['lastInjected']).toBe('number')
    expect(raw[keyA]?.['count']).toBe(baseCiteA + 1)
    expect(typeof raw[keyA]?.['last']).toBe('number')
  })
})

describe('/memory eval 出口与设置分区', () => {
  /** 假 UI：只收 `notice`（命令回执的落点）。 */
  const ui: { notices: string[] } = { notices: [] }

  test('首次评估：报表含记忆评估与两条记忆，没有对比段', () => {
    services.commands.run('/memory eval', {}, { notice: (line: string) => ui.notices.push(line) })
    expect(ui.notices.some((line) => line.includes('记忆评估'))).toBe(true)
    expect(ui.notices.some((line) => line.includes('条目 2 条'))).toBe(true)
    expect(ui.notices.join('\n')).not.toContain('与上次相比')
  })

  test('第二次评估出现「与上次相比」增量段，读数落 .eval.json', () => {
    ui.notices.length = 0
    services.commands.run('/memory eval', {}, { notice: (line: string) => ui.notices.push(line) })
    expect(ui.notices.join('\n')).toContain('与上次相比')
    expect(existsSync(memory.evalFile())).toBe(true)
  })

  test('设置分区里有只读统计行，读数是活的（含条数与引用率）', () => {
    const section = services.settings.sections().find((item) => item.id === 'memory')
    const statField = section?.fields.find((field) => field.type === 'info' && (field.label ?? '').includes('使用评估'))
    expect(statField).toBeDefined()
    expect(typeof statField?.text).toBe('string')
    expect(statField?.text).toContain('引用率')
    expect(statField?.text).toMatch(/条目 \d+/)
    expect(statField?.text).toMatch(/引用率 \d+%/)
  })

  test('「看评估报告」按钮走真出口，返回评估文本', async () => {
    const section = services.settings.sections().find((item) => item.id === 'memory')
    expect(section?.fields.some((field) => field.type === 'button' && field.action === 'evalReport')).toBe(true)
    const result = await services.settings.action('memory', 'evalReport')
    expect(result.ok).toBe(true)
    expect(typeof result.notice).toBe('string')
    expect(result.notice).toContain('记忆评估')
  })
})
