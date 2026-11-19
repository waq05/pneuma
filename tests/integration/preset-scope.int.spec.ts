/**
 * 「模式是会话的属性」与「一轮之内工具目录只有一份」（integration 层，原
 * `scripts/preset-scope-test.mjs`）。
 *
 * 背景是一次真实报障：某个会话里连着一串「未知工具」。日志摆出来是这样——同一个会话的
 * 系统提示 fingerprint 变了两次又变回来（模式被切走又切回），而中间那几轮模型喊的工具全部
 * 执行失败。根因两条，这里各钉一遍：
 *
 *   1. **模式原来是宿主全局量**：`dsc/session-open` 一打开别的会话就把它改掉，于是**后台
 *      正跑着的那个会话**的工具目录与提示词跟着换。现在按会话存，谁问就给谁算。
 *   2. **同一轮里请求一份目录、执行另取一份**：两次取值之间注册表一变，模型照着刚发出去的
 *      schema 喊的名字就落进「未知工具」。现在执行用这一轮请求的快照。
 *
 * ## 这一层的接缝
 *
 * 第 2 条需要一个**精确时序**：请求已经发出、回包还没到的时候把模式切走。`fakeLLM` 的
 * `onRequest` 钩子正好在这个时刻被调用（它比 `respond` 早），比探针自己写 SSE 端点干净。
 *
 * ## 隔离
 *
 * HOME 由 integration 层提供；自定义模式文件写在 `DSC_HOME/presets/narrow.md`，探针用的
 * `vanishing` 工具只注册在内存里，不落盘。
 *
 * @module dsc/tests/integration/preset-scope.int.spec
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { DSC_HOME } from '@pneuma/runtime/core/path-policy.js'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../harness.js'

/** 一档「只给 bash」的自定义模式：工具白名单就是那条投影的试金石。 */
const NARROW_PRESET = [
  '---',
  'name: narrow',
  'label: 窄档',
  'description: 只给 bash',
  'tools: bash',
  '---',
  '',
  '窄档的正文：这句只该出现在用窄档的那个会话的提示词里。',
  '',
].join('\n')

/** 内核里本文件用到的服务面。 */
interface SessionView {
  meta: { id: string; cwd: string }
  filePath: string
  messages: Array<{ role: string; content: unknown }>
  appendUser(text: string): void
}

interface KernelSurface {
  session: { current(): SessionView; open(filePath?: string): Promise<void> }
  tools: {
    visible(scope?: { sessionId?: string }): Array<{ name: string }>
    register(entry: {
      name: string
      description: string
      parameters: Record<string, unknown>
      risk: string
      run: (args: Record<string, unknown>) => Promise<string>
    }): () => void
  }
  presets: { use(name: string): string; readonly name: string }
  prompt: { systemPrompt(cwd: string, scope: { sessionId: string; cwd: string }): string }
  transcript: { getSnapshot(): unknown }
}

let llm: FakeLLM
let kernel: BootedKernel
let surface: KernelSurface
/** 下一轮请求到达时先切模式（模拟「请求已发出、回包还没到」的那个瞬间）。 */
let switchBeforeReply: (() => void) | null = null
/** 前两条会话的身份：`A` 是本文件开头那条（窄档），`B` 是新建的默认档那条。 */
let sessionA: { id: string; filePath: string; cwd: string }
let sessionB: { id: string; filePath: string; cwd: string }

beforeAll(async () => {
  // 自定义模式文件必须先于内核启动落盘：模式服务在装配时读目录。
  mkdirSync(join(DSC_HOME, 'presets'), { recursive: true })
  writeFileSync(join(DSC_HOME, 'presets', 'narrow.md'), NARROW_PRESET, 'utf8')
  llm = await fakeLLM({
    turns: [
      // 第 [5] 段：模型调一个「请求发出之后就会被模式白名单挡掉」的工具，然后收尾。
      { toolCall: { name: 'vanishing', args: {} } },
      '工具回来了',
    ],
    onRequest: (_body, turn) => {
      // turn 0 是标题请求，不占对话轮次，也不该触发切档。
      if (turn > 0 && switchBeforeReply !== null) {
        const run = switchBeforeReply
        switchBeforeReply = null
        run()
      }
    },
  })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  surface = kernel.ctx as unknown as KernelSurface
  sessionA = await persistCurrent('A')
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
})

/** 让当前会话真落盘（会话要有一条对话记录才建文件；切回来要按路径找它），返回它的身份。 */
async function persistCurrent(tag: string): Promise<{ id: string; filePath: string; cwd: string }> {
  const current = surface.session.current()
  current.appendUser(`（自检）让 ${tag} 落盘`)
  const deadline = Date.now() + 3_000
  for (;;) {
    try {
      if (readFileSync(current.filePath, 'utf8').includes('"type":"user"')) break
    } catch {
      // 还没建出来：继续等。
    }
    if (Date.now() > deadline) break
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
  return { id: current.meta.id, filePath: current.filePath, cwd: current.meta.cwd }
}

const names = (list: Array<{ name: string }>): string[] => list.map((tool) => tool.name)

describe('[1] 打开会话不再往转录里写「已恢复会话」', () => {
  test('新建会话与切回原会话都不写这一行', async () => {
    await surface.session.open(undefined)
    expect(JSON.stringify(surface.transcript.getSnapshot())).not.toContain('已恢复会话')
    await surface.session.open(sessionA.filePath)
    expect(JSON.stringify(surface.transcript.getSnapshot())).not.toContain('已恢复会话')
    expect(surface.session.current().meta.id).toBe(sessionA.id)
  })
})

describe('[2] 工具目录按会话算：切走别的会话不改后台那个', () => {
  test('A 切窄档后只剩 bash；新建的 B 是全量；A 不跟着变', async () => {
    surface.presets.use('narrow')
    expect(names(surface.tools.visible({ sessionId: sessionA.id }))).toEqual(['bash'])

    await surface.session.open(undefined)
    sessionB = await persistCurrent('B')
    // 新建的 B 是默认档：全量目录里 read 与 bash 都在。
    expect(names(surface.tools.visible({ sessionId: sessionB.id }))).toEqual(expect.arrayContaining(['bash', 'read']))
    // 这条以前会随 B 一起变——正是「后台会话工具目录被换掉」的报障形状。
    expect(names(surface.tools.visible({ sessionId: sessionA.id }))).toEqual(['bash'])
    // 不带 scope 的 visible() 跟随当前会话（B = 全量）。
    expect(names(surface.tools.visible()).length).toBeGreaterThan(1)
    expect(surface.presets.name).toBe('standard')
  })
})

describe('[3] 系统提示也按会话：A 的 persona 是窄档，B 的不是', () => {
  test('按 sessionId 取提示词，两边的模式正文各是各的', () => {
    const promptA = surface.prompt.systemPrompt(sessionA.cwd, { sessionId: sessionA.id, cwd: sessionA.cwd })
    const promptB = surface.prompt.systemPrompt(sessionB.cwd, { sessionId: sessionB.id, cwd: sessionB.cwd })
    expect(promptA).toContain('窄档的正文')
    expect(promptB).not.toContain('窄档的正文')
  })
})

describe('[4] 换档只影响本会话，切回去还是原档', () => {
  test('B 切 ptc 后 B 有 run_code、A 仍只有 bash；切回 A 恢复窄档', async () => {
    surface.presets.use('ptc')
    expect(names(surface.tools.visible({ sessionId: sessionB.id }))).toContain('run_code')
    expect(names(surface.tools.visible({ sessionId: sessionA.id }))).toEqual(['bash'])

    surface.presets.use('standard')
    // 会话落盘是攒批的（不是每次 appendState 都写）：等一拍再重开，否则 open() 找不到
    // 那个文件、会静默留在当前会话上——探针自己踩过一次。
    await new Promise((resolveTick) => setTimeout(resolveTick, 1_200))
    await surface.session.open(sessionA.filePath)
    expect(surface.session.current().meta.id).toBe(sessionA.id)
    expect(surface.presets.name).toBe('narrow')
  })
})

describe('[5] 同一轮里注册表变了，模型喊过的工具照样能跑', () => {
  test('执行用请求那一刻的目录：工具不在新白名单里也能跑，不落「未知工具」', async () => {
    let ran = false
    surface.tools.register({
      name: 'vanishing',
      description: '探针用：请求发出之后就会被模式白名单挡掉',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      run: async () => {
        ran = true
        return 'vanished ok'
      },
    })
    // 请求这一轮用的目录里必须有 vanishing（否则失败与快照无关，用例自己就不成立）。
    surface.presets.use('standard')
    expect(names(surface.tools.visible({ sessionId: sessionA.id }))).toContain('vanishing')
    // 回包前把当前会话切到窄档：vanishing 不在白名单里，执行那一步现取目录就会判「未知工具」。
    const session = surface.session.current()
    switchBeforeReply = () => {
      surface.presets.use('narrow')
    }
    await kernel.runTurn('开跑消失工具')
    const toolTexts = session.messages.filter((message) => message.role === 'tool').map((message) => String(message.content))
    expect(ran).toBe(true)
    expect(toolTexts.some((text) => text.includes('vanished ok'))).toBe(true)
    expect(toolTexts.some((text) => text.includes('未知工具'))).toBe(false)
    // 切档真的发生了（否则这条测的是「模式没动」）。
    expect(surface.presets.name).toBe('narrow')
  })
})
