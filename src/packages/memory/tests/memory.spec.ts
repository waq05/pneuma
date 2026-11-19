/**
 * @pneuma/memory 的包级测试：插件对象、记忆工具、/memory 命令、设置分区，以及一次真写入。
 *
 * 原测试 5 条 check() 全部是 `index.ts` 源码文本断言（`name: 'memory'`、`risk: 'write'`、
 * `required: ['target', 'action']`、`order: 35` 等）。现在改成假 ctx 真跑 `apply()`，
 * 从注册出来的工具 / 命令 / 设置分区上断言；写入用例落 `mkdtempSync` 的临时 `DSC_HOME`，
 * 写完再读回来，验的是「条目真的进了 MEMORY.md」而不是「源码里有这句」。
 *
 * @module @pneuma/memory/tests
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

/** 捕获到的工具声明。 */
interface CapturedTool {
  name: string
  description: string
  risk: string
  parameters: {
    properties: Record<
      string,
      { type?: string; items?: { properties?: Record<string, unknown>; required?: string[] } }
    >
    required?: string[]
  }
  run: (args: Record<string, unknown>, scope: Record<string, unknown>) => Promise<string>
}

/** 捕获到的命令声明。 */
interface CapturedCommand {
  spec: { name: string; args?: string; description?: string }
}

/** 捕获到的设置分区。 */
interface CapturedSection {
  id: string
  order?: number
  fields: () => Array<{ key: string }>
  values: () => Record<string, unknown>
  save: (key: string, value: unknown) => string | void
}

/** 一次 apply 捕获到的东西。 */
interface Harness {
  tools: CapturedTool[]
  commands: CapturedCommand[]
  sections: CapturedSection[]
  service: { cells: (at?: string) => Array<{ target: string; entries: string[] }> }
}

const home = mkdtempSync(join(tmpdir(), 'dsc-memory-spec-'))
const workspace = mkdtempSync(join(tmpdir(), 'dsc-memory-cwd-'))
/** 调用工具时给的作用域：写入落点由它决定，这一条会真写盘（临时目录内）。 */
const scope = { cwd: workspace, signal: new AbortController().signal, sessionId: 'spec-session', sessionPath: '' }

let memoryPlugin: typeof import('../index.js')['memoryPlugin']

beforeAll(async () => {
  process.env.DSC_HOME = home
  const policy = await import('@pneuma/runtime/core/path-policy.js')
  expect(policy.DSC_HOME).toBe(home)
  ;({ memoryPlugin } = await import('../index.js'))
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

/** 把 memory 这一条配置写进临时 plugins.json（插件每次用值时现读磁盘）。 */
function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(
    join(home, 'plugins.json'),
    `${JSON.stringify({ version: 1, entries: [{ file: 'memory', disabled: false, config }] }, null, 2)}\n`,
    'utf8',
  )
}

/** 假 ctx：apply 用到的面都实现；`effect` 真跑回调，否则注册不会发生。 */
function runApply(): Harness {
  const harness: Harness = {
    tools: [],
    commands: [],
    sections: [],
    service: { cells: () => [] },
  }
  const ctx = {
    tools: {
      register: (entry: CapturedTool) => {
        harness.tools.push(entry)
        return () => {}
      },
    },
    commands: {
      register: (spec: CapturedCommand['spec']) => {
        harness.commands.push({ spec })
        return () => {}
      },
    },
    prompt: {
      register: () => () => {},
      registerProjection: () => () => {},
    },
    transcript: { system: () => {} },
    approval: { decide: async () => 'allow' },
    session: {
      current: () => ({ meta: { cwd: workspace, id: 'spec-session' }, messages: [] }),
    },
    settings: {
      registerSection: (spec: CapturedSection) => {
        harness.sections.push(spec)
        return () => {}
      },
    },
    provide: (_name: string, service: Harness['service']) => {
      harness.service = service
      return () => {}
    },
    on: () => () => {},
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
    emit: () => {},
    agent: { followup: () => {} },
  }
  // 假 ctx 只实现 apply 用到的面；真实 Context 的字段远多于它。
  memoryPlugin.apply(ctx as unknown as Context, undefined)
  return harness
}

/** 取注册出来的 memory 工具。 */
function memoryTool(harness: Harness): CapturedTool {
  const tool = harness.tools.find((entry) => entry.name === 'memory')
  expect(tool, 'apply 应当注册 memory 工具').toBeDefined()
  return tool as CapturedTool
}

// 第 1 条：插件对象本体——名字、提供服务、八个注入。
test('插件对象：名字、提供服务、八个注入', () => {
  expect(memoryPlugin.name).toBe('memory')
  expect(memoryPlugin.provide).toBe('memory')
  expect([...(memoryPlugin.inject as string[])]).toStrictEqual([
    'session',
    'tools',
    'prompt',
    'approval',
    'agent',
    'commands',
    'transcript',
    'settings',
  ])
  expect(typeof memoryPlugin.apply).toBe('function')
})

// 第 2 条：工具对象——写风险，批量操作里 target/action 必填。
test('工具叫 memory、风险是写，批量操作里 target/action 必填', () => {
  const tool = memoryTool(runApply())
  expect(tool.risk).toBe('write')
  expect(tool.parameters.properties['target']?.type).toBe('string')
  expect(tool.parameters.properties['operations']?.type).toBe('array')
  expect(tool.parameters.properties['operations']?.items?.required).toStrictEqual(['target', 'action'])
  expect(tool.parameters.required).toBeUndefined()
})

// 第 3 条：三格与三种类型写在给模型的说明里（说明本身是工具对象的一部分）。
test('说明里写清三格与三种条目类型', () => {
  const description = memoryTool(runApply()).description
  for (const word of ['memory', 'user', 'workspace', 'fact', 'feedback', 'reference']) {
    expect(description, `说明里缺 ${word}`).toContain(word)
  }
})

// 第 4 条：/memory 命令带 show/eval/refresh/prune/clear 五种子命令。
test('/memory 命令带 show/eval/refresh/prune/clear 子命令', () => {
  const harness = runApply()
  const command = harness.commands.find((entry) => entry.spec.name === 'memory')
  expect(command, '/memory 命令应当注册').toBeDefined()
  for (const sub of ['show', 'eval', 'refresh', 'prune', 'clear']) {
    expect(command?.spec.args, `args 里缺 ${sub}`).toContain(sub)
  }
})

// 第 5 条：设置分区 id=memory、order=35，总开关与三格额度都在。
test('设置分区 id=memory、order=35，含总开关与三格额度', () => {
  const section = runApply().sections[0]
  expect(section?.id).toBe('memory')
  expect(section?.order).toBe(35)
  const keys = (section?.fields() ?? []).map((field) => field.key)
  for (const key of ['enabled', 'userProfile', 'workspace', 'globalLimit', 'userLimit', 'workspaceLimit', 'reviewEveryTurns']) {
    expect(keys, `设置分区缺 ${key}`).toContain(key)
  }
  expect(section?.values()).toMatchObject({ enabled: true, userProfile: true, workspace: true })
})

// 第 6 条：非法操作整批拒绝，并把合法形状回吐给模型（不落盘）。
test('非法操作整批拒绝且不落盘', async () => {
  const tool = memoryTool(runApply())
  const result = await tool.run({ operations: [{ target: '不存在的格子', action: 'add', content: 'x' }] }, scope)
  expect(result).toContain('operations 里每一项都得是')
  expect(existsSync(join(home, 'memory', 'global', 'MEMORY.md'))).toBe(false)
})

// 第 7 条：真写入——条目落进 MEMORY.md，服务立刻能读到（写入后重算快照）。
test('写入：条目落进 MEMORY.md，服务读得到', async () => {
  const harness = runApply()
  const tool = memoryTool(harness)
  const result = await tool.run({ target: 'global', action: 'add', content: '本仓库用 pnpm' }, scope)
  expect(result).toContain('本仓库用 pnpm')
  const file = join(home, 'memory', 'global', 'MEMORY.md')
  expect(existsSync(file), '写入应当落盘到临时 DSC_HOME 下').toBe(true)
  expect(readFileSync(file, 'utf8')).toContain('本仓库用 pnpm')
  const global = harness.service.cells().find((cell) => cell.target === 'global')
  expect(global?.entries).toContain('本仓库用 pnpm')
})

// 第 8 条：总开关关掉时工具不写，只回一句「现在是关着的」。
test('总开关关掉：工具拒绝写入并说明去哪打开', async () => {
  mkdirSync(home, { recursive: true })
  writeConfig({ enabled: false })
  const result = await memoryTool(runApply()).run({ target: 'global', action: 'add', content: '不该落盘' }, scope)
  expect(result).toContain('长期记忆现在是关着的')
  expect(readFileSync(join(home, 'memory', 'global', 'MEMORY.md'), 'utf8')).not.toContain('不该落盘')
})
