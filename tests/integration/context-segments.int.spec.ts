/**
 * 沙箱档位与当前模式落在**请求末尾的快照**里，不进系统提示词（迁自
 * `scripts/context-segments-test.mjs` 的第 [5] 节）。
 *
 * 为什么这条重要：沙箱档位与当前模式以前在系统提示词里，切一次权限 / 模式，前缀缓存整段
 * 失效（实测一次切换：命中 4K、未命中 59K）。挪到末尾快照之后前缀复用，信息一个字不少。
 * 所以这里同时钉两件事：**系统提示词逐字节不变**，而**快照里确实换成了新模式**。
 *
 * ## 原探针的另一半不在这里
 *
 * 第 [1] 节（`estimateRequestSegments` 的 schema 段与 tools 段分开算）已由
 * `src/core/token-estimate.spec.ts` 覆盖；第 [2]-[4] 节（超长工具结果修剪）是纯函数，
 * 迁到 `src/packages/prompt/tool-result-prune.spec.ts`。
 *
 * @module dsc/tests/integration/context-segments.int.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../harness.js'

/** 内核里本文件用到的服务面：只声明用到的。 */
interface SessionView {
  meta: { id: string; cwd: string }
}

interface Services {
  prompt: {
    systemPrompt(cwd: string, scope?: { sessionId?: string; cwd?: string }): string
    rewrite(messages: ChatMessage[], session: SessionView): ChatMessage[]
  }
  mode: { setMode(next: string): void }
  session: { current(): SessionView }
}

let kernel: BootedKernel
let fake: FakeLLM
let services: Services
/** 工作目录：系统提示词会读它（AGENTS.md 之类），必须是个真目录。 */
let cwd: string
/** 同一个 scope 两次调用用同一份，免得把「scope 不同」误读成「提示词变了」。 */
let scope: { sessionId: string; cwd: string }

beforeAll(async () => {
  fake = await fakeLLM({ turns: ['收到'] })
  // 这只内核要**开**沙箱插件：`【沙箱】档位` 那一段是它注册的投影（`packages/sandbox/index.ts`），
  // 而 harness 默认把它关掉（D16：Windows 上它启动时会 spawn PowerShell 体检）。这条用例测的
  // 正是那一段落在哪，所以按 D16 给出的口子预置清单——`prepareIsolatedHome` 只在文件不存在时写。
  const dscHome = process.env.DSC_HOME ?? join(process.env.HOME ?? process.cwd(), '.dsc')
  mkdirSync(dscHome, { recursive: true })
  writeFileSync(
    join(dscHome, 'plugins.json'),
    `${JSON.stringify({ version: 1, entries: [{ file: 'memory', config: { enabled: false } }, { file: 'sandbox' }] }, null, 2)}\n`,
    'utf8',
  )
  kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
  services = kernel.ctx as unknown as Services
  cwd = join(process.env.HOME ?? process.cwd(), 'ws-segments')
  mkdirSync(cwd, { recursive: true })
  scope = { sessionId: services.session.current().meta.id, cwd }
})

afterAll(async () => {
  await kernel?.dispose()
  await fake?.close()
})

/** 把一份请求里的所有正文拼起来（只看文本，图片段没有可估的内容）。 */
function textsOf(messages: ChatMessage[]): string {
  return messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n')
}

describe('① 系统提示词里没有沙箱与模式段', () => {
  test('没有【沙箱】段，也没有「当前模式：」', () => {
    const system = services.prompt.systemPrompt(cwd, scope)
    expect(system).not.toContain('【沙箱】')
    expect(system).not.toContain('当前模式：')
  })
})

describe('② 这两样都落在请求末尾的快照里', () => {
  test('快照带着沙箱档位与当前模式，且是最后一条 user', () => {
    const rewritten = services.prompt.rewrite([{ role: 'user', content: '你好' }], services.session.current())
    const tail = textsOf(rewritten)
    expect(tail).toContain('【沙箱】档位')
    expect(tail).toContain('当前模式：')
    expect(rewritten.length).toBeGreaterThan(0)
    expect(rewritten[rewritten.length - 1]!.role).toBe('user')
  })
})

describe('③ 切模式：系统提示词逐字节不变，快照换成新模式', () => {
  test('前缀缓存的前提成立：切模式前后 systemPrompt 完全一致', () => {
    const before = services.prompt.systemPrompt(cwd, scope)
    services.mode.setMode('plan')
    const after = services.prompt.systemPrompt(cwd, scope)
    expect(after).toBe(before)
  })

  test('信息一个字不少：快照里换成了计划模式', () => {
    const tail = textsOf(services.prompt.rewrite([{ role: 'user', content: '你好' }], services.session.current()))
    expect(tail).toContain('当前模式：计划')
  })
})
