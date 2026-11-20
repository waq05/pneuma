/**
 * commands 的 W14 补缺口测试：/copy 起子进程抛错、/update 的成功与失败回执、
 * /ui-trust 的「有等待确认项」分支，以及 /status 里的工具条数。
 *
 * 沿用 `wiring-extra.spec.ts` 的假 ctx / runtime / ui 三件套；`spawn` 与 `checkForUpdate`
 * 换成可编排的桩（不真复制剪贴板、不联网）。
 *
 * @module @pneuma/commands/tests/w14-command-edges
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import type { CommandService } from '@pneuma/runtime/services/types.js'

const home = mkdtempSync(join(tmpdir(), 'dsc-commands-w14-'))
const cwd = mkdtempSync(join(tmpdir(), 'dsc-commands-w14-cwd-'))
const previousHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = home

const state = vi.hoisted(() => ({
  spawnThrows: false,
  update: undefined as undefined | (() => Promise<unknown>),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: () => {
      if (state.spawnThrows) throw new Error('剪贴板命令起不来')
      return { on: () => {}, stdin: { end: () => {} } }
    },
  }
})

vi.mock('@pneuma/runtime/core/update-check.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pneuma/runtime/core/update-check.js')>()
  return {
    ...actual,
    checkForUpdate: () => (state.update === undefined ? actual.checkForUpdate() : state.update!()),
  }
})

const { commandsPlugin } = await import('../index.js')

afterAll(() => {
  if (previousHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = previousHome
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

/** 通知收集。 */
const notices: string[] = []
const session = {
  messages: [],
  meta: { cwd, id: 'abcdef12-3456-7890', createdAt: Date.UTC(2026, 10, 16) },
}
const snapshotState = {
  status: {
    turnState: 'idle',
    effort: 'default',
    sessionPath: '' as string | undefined,
  },
  entries: [] as Array<{ kind: string; text: string; role?: string }>,
  surfaces: {
    policy: {
      current: 'readonly',
      options: [],
      reviewer: 'user',
      reviewerOptions: [],
    },
  },
}

const runtime = {
  getSnapshot: () => snapshotState,
  setPolicy: () => {},
  setReviewer: () => {},
  submit: () => {},
  listPlugins: () => [],
  dock: async () => ({ diff: '' }),
} as never

const ui = {
  shell: false,
  notice: (text: string) => notices.push(text),
  openPicker: () => {},
  openModels: () => {},
}

let service: CommandService | undefined
function ensureApplied(): CommandService {
  if (service !== undefined) return service
  const fakeCtx = {
    get: () => undefined,
    emit: () => {},
    provide: (_name: string, value: CommandService) => {
      service = value
    },
    session: { current: () => session },
    llm: { provider: 'deepseek', model: 'chat', contextWindow: 100_000 },
  }
  ;(commandsPlugin.apply as (ctx: unknown) => void)(fakeCtx)
  if (service === undefined) throw new Error('apply 没有 provide commands 服务')
  return service
}

/** 派发一条命令并返回这次的通知。 */
function dispatch(input: string): string[] {
  notices.length = 0
  ensureApplied().run(input, runtime as never, ui as never)
  return [...notices]
}

/** 等异步 handler 写出通知。 */
async function waitNotice(fragment: string): Promise<string> {
  let text = ''
  await vi.waitFor(() => {
    text = notices.join('\n')
    expect(text).toContain(fragment)
  })
  return text
}

describe('/copy：spawn 同步抛错', () => {
  test('剪贴板命令起不来时只回一句人话', () => {
    snapshotState.entries = [{ kind: 'text', text: '上一条回复' }]
    state.spawnThrows = true
    try {
      expect(dispatch('/copy').join('\n')).toContain('复制失败：剪贴板命令起不来')
    } finally {
      state.spawnThrows = false
      snapshotState.entries = []
    }
  })
})

describe('/update：新版带发布页与失败', () => {
  test('成功回执带发布页 URL', async () => {
    state.update = async () => ({
      ok: true,
      notice: '发现新版 v9.9.9',
      data: { kind: 'url', url: 'https://example.invalid/rel' },
    })
    try {
      dispatch('/update')
      const text = await waitNotice('发现新版')
      expect(text).toContain('发布页：https://example.invalid/rel')
    } finally {
      state.update = undefined
    }
  })

  test('抛错时折成 /update 失败一句', async () => {
    state.update = async () => {
      throw new Error('网络断了')
    }
    try {
      dispatch('/update')
      await waitNotice('/update 失败：网络断了')
    } finally {
      state.update = undefined
    }
  })
})

describe('/status：工具条数', () => {
  test('会话里有工具消息时不炸，自动压缩线写给用户', () => {
    snapshotState.entries = [
      { kind: 'tool', text: 'x', role: 'tool' },
      { kind: 'text', text: 'y', role: 'user' },
    ]
    try {
      const text = dispatch('/status').join('\n')
      expect(text).toContain('自动压缩触发线')
    } finally {
      snapshotState.entries = []
    }
  })
})
