/**
 * subagent 插件运行面的补测（W14，第一批）：设置分区保存、队友信箱读取、队友移除时的记录清理。
 *
 * 覆盖目标（对照 W14 缺口清单 `packages/subagent/index.ts`）：
 * - `save` 的 `approval` 分支（合法值落盘 + 非法值返回文案）；
 * - `team_message` 的 `inbox` 动作在信箱非空时列出最近几条（含总数与写入顺序说明）；
 * - 团队服务 `remove` 在「名册里有记录、运行记录文件存在」时真的删掉文件并如实回报。
 *
 * 其余缺口行（轮次预算、最终轮提醒、流事件转发、`agent.attach` 回调、嵌套父队友通知、
 * 认领失败、finished 列表挤出、嵌套队友命名兜底等）都要求真实队友生命周期与流式模型事件；
 * 那需要一个完整的队友 harness，本批不做，见报告里的逐条说明。
 *
 * 隔离：临时 HOME + DSC_HOME，动态 import 在设好环境之后；真实 `~/.dsc` 一个字节都不碰。
 *
 * @module @pneuma/subagent/tests/w14-runtime-edges
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SettingsSectionSpec, SettingsValue } from '@pneuma/runtime/services/types.js'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-subagent-w14-'))
const WORKSPACE = join(HOME, 'workspace')
mkdirSync(WORKSPACE, { recursive: true })
const savedEnv = {
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
  DSC_HOME: process.env['DSC_HOME'],
}
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.DSC_HOME = join(HOME, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })

type SessionModule = typeof import('../../../core/session.js')
type IndexModule = typeof import('../index.js')
type BoardModule = typeof import('../../../core/team-board.js')

let plugin: IndexModule['subagentPlugin']
let SessionClass: SessionModule['Session']
let boardModule: BoardModule

beforeAll(async () => {
  SessionClass = (await import('../../../core/session.js')).Session
  plugin = (await import('../index.js')).subagentPlugin
  boardModule = await import('../../../core/team-board.js')
})

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup()
    } catch {
      // 已经收过了
    }
  }
})

beforeEach(() => {
  mkdirSync(join(HOME, '.dsc', 'plugins'), { recursive: true })
  writeJson(join(HOME, '.dsc', 'plugins.json'), { version: 1, entries: [] })
})

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 装一次插件，返回捕获到的工具、设置分区、provide 服务与卸载函数。 */
interface Wired {
  tools: Array<Record<string, unknown>>
  sections: SettingsSectionSpec[]
  services: Map<string, unknown>
  dispose: () => void
}

function mount(config: Record<string, unknown> = {}): Wired {
  const tools: Array<Record<string, unknown>> = []
  const sections: SettingsSectionSpec[] = []
  const services = new Map<string, unknown>()
  const session = SessionClass.create(WORKSPACE, join(HOME, 'sessions', 'w14-parent.jsonl'))
  cleanups.push(() => {
    try {
      session.close()
    } catch {
      // 已经关了
    }
  })
  const ctx = {
    session: {
      current: () => session,
      open: async () => undefined,
    },
    emit: () => undefined,
    tools: {
      register(entry: Record<string, unknown>) {
        tools.push(entry)
        return () => {
          const at = tools.indexOf(entry)
          if (at >= 0) tools.splice(at, 1)
        }
      },
      list: () => tools,
    },
    prompt: {
      register: () => () => undefined,
      registerProjection: () => () => undefined,
    },
    settings: {
      about: () => ({ home: HOME }),
      registerSection(spec: SettingsSectionSpec) {
        sections.push(spec)
        return () => {
          const at = sections.indexOf(spec)
          if (at >= 0) sections.splice(at, 1)
        }
      },
    },
    provide(name: string, service: unknown) {
      services.set(name, service)
    },
    effect(execute: () => unknown) {
      const off = execute()
      return typeof off === 'function' ? (off as () => void) : () => undefined
    },
    transcript: {
      touch: () => undefined,
      emit: () => undefined,
      system: () => undefined,
    },
    llm: {
      model: 'fake/model',
      routeForSession: () => ({
        api: 'fake',
        baseUrl: 'http://fake',
        apiKey: 'k',
        model: 'fake/model',
      }),
      routeTo: () => ({
        api: 'fake',
        baseUrl: 'http://fake',
        apiKey: 'k',
        model: 'fake/model',
      }),
      providerOf: () => 'fake',
      modelOf: () => 'fake/model',
      parseModelRef: (ref: string) => ({ provider: 'fake', model: ref }),
      listModels: () => [],
      stream: async () => ({
        text: '',
        reasoning: '',
        toolCalls: [],
        usage: null,
        finishReason: 'stop',
      }),
    },
    approval: { decide: async () => 'allow-once' },
    guards: {
      register: () => () => undefined,
      registerSessionResolver: () => () => undefined,
      gate: async () => ({ action: 'defer' }),
      observe: () => undefined,
    },
    agent: {
      sessionById: () => undefined,
      hasAgent: () => false,
      attach: () => undefined,
      detach: () => undefined,
      acceptsInput: () => false,
      followup: () => undefined,
    },
  }
  const apply = plugin.apply as unknown as (context: unknown, passed?: unknown) => (() => void) | void
  const returned = apply(ctx, config)
  const dispose = (): void => {
    if (typeof returned === 'function') returned()
  }
  return { tools, sections, services, dispose }
}

test('设置分区 save：approval 合法值落盘，非法值返回文案且不改当前值', () => {
  const wired = mount()
  const section = wired.sections[0] as unknown as {
    values: () => Record<string, SettingsValue>
    save: (key: string, value: SettingsValue) => string | void
  }
  expect(section, '插件没有注册设置分区').toBeDefined()
  expect(section.values()['approval']).toBe('forbid')
  expect(section.save('approval', 'foreground')).toBeUndefined()
  expect(section.values()['approval']).toBe('foreground')
  const rejected = section.save('approval', 'nonsense')
  expect(typeof rejected).toBe('string')
  expect(section.values()['approval']).toBe('foreground')
  wired.dispose()
})

test('team_message inbox：信箱非空时按写入顺序列出最近几条并报告总数', async () => {
  const wired = mount()
  const tool = wired.tools.find((entry) => entry['name'] === 'team_message')
  expect(tool, '插件没有注册 team_message 工具').toBeDefined()
  boardModule.inboxAppend('w14-mate', '第一条消息')
  boardModule.inboxAppend('w14-mate', '第二条消息')
  const runCtx = {
    caller: { name: 'w14-mate', sessionId: 'w14-parent-session' },
    sessionId: 'w14-parent-session',
    cwd: WORKSPACE,
    signal: new AbortController().signal,
  }
  const text = await (tool!['run'] as (args: unknown, ctx: unknown) => Promise<string>)({ action: 'inbox', limit: 5 }, runCtx)
  expect(text).toContain('你的信箱最近 2 条')
  expect(text).toContain('共 2 条')
  expect(text).toContain('第一条消息')
  expect(text).toContain('第二条消息')
  wired.dispose()
})

test('团队服务 remove：名册有记录时删掉队友运行记录并如实回报', async () => {
  const wired = mount()
  const service = wired.services.get('team') as { remove: (name: string) => Promise<string> } | undefined
  expect(service, '插件没有 provide team 服务').toBeDefined()
  // 造一份「队友运行记录」：首行 meta 标 origin=subagent 才算队友文件。
  const file = join(HOME, 'sessions', 'w14-teammate-session.jsonl')
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'meta', id: 'w14-teammate-session', origin: 'subagent', cwd: WORKSPACE })}\n`,
    'utf8',
  )
  expect(existsSync(file)).toBe(true)
  const rosterFile = join(HOME, 'team', 'roster.json')
  writeJson(rosterFile, {
    teammates: [
      {
        name: 'w14-mate',
        role: 'tester',
        parent: 'lead',
        depth: 1,
        state: 'stopped',
        task: 't',
        file,
        rounds: 1,
        startedAt: Date.now() - 1000,
      },
    ],
  })
  const text = await service!.remove('w14-mate')
  expect(text).toContain('已把「w14-mate」从名册移除')
  expect(text).toContain('运行记录一并删除')
  expect(existsSync(file), '运行记录文件应当被删掉').toBe(false)
  // 名册里也不再留这一位。
  const roster = JSON.parse(readFileSync(rosterFile, 'utf8')) as {
    teammates: Array<{ name: string }>
  }
  expect(roster.teammates.map((entry) => entry.name)).not.toContain('w14-mate')
  wired.dispose()
})
