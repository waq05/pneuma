/**
 * runtime 插件的 W14 补缺口测试：可选服务缺失、命令回调、模型清单、偏好归一与退出。
 *
 * 既有 `wiring.spec.ts` 铺的是整套服务都在的装配面；这里补它没走到的边角：
 *
 *   - `superagentAnswer` 的入参校验（三句人话）与成功转发；
 *   - `commandUi()` 的 openPicker / openModels 两条事件；
 *   - 没有 team 服务时 `openTeammate` 的拒绝；
 *   - `setPolicy` / `setReviewer` / `listModels` 的纯转发；
 *   - `setUiPrefs` 的字号真源（px）与旧倍率两条归一分支；
 *   - `exit()` 发 `dsc/exit` 后调 `process.exit(0)`。
 *
 * @module dsc/packages/runtime/tests/w14-runtime-paths
 */
import { describe, expect, test, vi } from 'vitest'
import { runtimePlugin } from '../index.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- 契约面是动态键，逐条标注类型只会加噪声 */
interface Mounted {
  service: Record<string, (...args: any[]) => any>
  events: Array<{ event: string; args: unknown[] }>
  optional: Map<string, unknown>
  transcript: {
    system: ReturnType<typeof vi.fn>
    touch: ReturnType<typeof vi.fn>
  }
  approval: {
    setPolicy: ReturnType<typeof vi.fn>
    setReviewer: ReturnType<typeof vi.fn>
    answer: ReturnType<typeof vi.fn>
  }
  llm: { listModels: ReturnType<typeof vi.fn> }
  settings: {
    prefs: ReturnType<typeof vi.fn>
    setPrefs: ReturnType<typeof vi.fn>
  }
  commands: { run: ReturnType<typeof vi.fn> }
}

/** 假 ctx：只铺 apply 与本次要调的那几条会用到的服务。 */
function mount(): Mounted {
  const events: Array<{ event: string; args: unknown[] }> = []
  const optional = new Map<string, unknown>()
  let provided: unknown
  const transcript = {
    system: vi.fn(),
    touch: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getSnapshot: vi.fn(),
  }
  const approval = {
    setPolicy: vi.fn(),
    setReviewer: vi.fn(),
    answer: vi.fn(),
  }
  const llm = {
    listModels: vi.fn(() => [{ value: 'p/m', provider: 'p', model: 'm' }]),
  }
  const prefs = { ui: {} as Record<string, unknown> }
  const settings = {
    prefs: vi.fn(() => prefs),
    setPrefs: vi.fn((patch: { ui?: Record<string, unknown> }) => {
      if (patch.ui !== undefined) prefs.ui = { ...prefs.ui, ...patch.ui }
    }),
  }
  const commands = {
    run: vi.fn(
      async (
        _input: unknown,
        _runtime: unknown,
        ui: {
          notice: (text: string) => void
          openPicker(): void
          openModels(): void
        },
      ) => {
        ui.notice('命令输出')
        ui.openPicker()
        ui.openModels()
        return 'command-result'
      },
    ),
  }
  const ctx = {
    transcript,
    approval,
    llm,
    settings,
    commands,
    get: (name: string) => optional.get(name),
    emit(event: string, ...args: unknown[]) {
      events.push({ event, args })
    },
    provide(name: string, value: unknown) {
      if (name === 'ui') provided = value
    },
  }
  ;(runtimePlugin.apply as (ctx: unknown) => void)(ctx as never)
  expect(provided).toBeDefined()
  return {
    service: provided as Mounted['service'],
    events,
    optional,
    transcript,
    approval,
    llm,
    settings,
    commands,
  }
}

describe('commandUi：命令回调经事件转发', () => {
  test('runCommand 里 notice 写 transcript，openPicker/openModels 各发一条事件', async () => {
    const h = mount()
    await expect(h.service['runCommand']('/help')).resolves.toBe('command-result')
    expect(h.commands.run).toHaveBeenCalledTimes(1)
    expect(h.transcript.system).toHaveBeenCalledWith('命令输出', undefined, true)
    expect(h.events.some((item) => item.event === 'dsc/open-picker')).toBe(true)
    expect(h.events.some((item) => item.event === 'dsc/open-models')).toBe(true)
  })
})

describe('可选服务缺失', () => {
  test('没有 team 时 openTeammate 给出可读拒绝；有它时转给 open', async () => {
    const h = mount()
    await expect(h.service['openTeammate']('a')).rejects.toThrow('子智能体插件没开，没有队友可以打开')
    const open = vi.fn(async () => 'opened')
    h.optional.set('team', { open })
    await expect(h.service['openTeammate']('a')).resolves.toBe('opened')
    expect(open).toHaveBeenCalledWith('a')
  })

  test('没有 superagent 时 superagentAnswer 拒绝；有它时校验入参再转发', async () => {
    const h = mount()
    await expect(h.service['superagentAnswer']({})).rejects.toThrow('Super Agent 插件没开，没法回话')

    const answer = vi.fn(async (payload: { ticketId: string; text: string }) => ({
      ok: true,
      ticketId: payload.ticketId,
    }))
    h.optional.set('superagent', { answer })
    // 这三条是同步抛（校验发生在返回 Promise 之前）。
    expect(() => h.service['superagentAnswer'](null)).toThrow('要给 `{ ticketId, text }`：回哪张工单、回什么')
    expect(() => h.service['superagentAnswer']({ ticketId: 't1', text: '   ' })).toThrow('回答不能为空：写一句要回它的话')
    expect(() => h.service['superagentAnswer']({ ticketId: 42, text: 'hi' })).toThrow('要给一个工单 id（`{ id }` 或裸字符串）')

    // 裸字符串 ticketId 也认；text 原样交给服务层。
    await h.service['superagentAnswer']({ ticketId: 't1', text: '收到' })
    expect(answer).toHaveBeenCalledWith({ ticketId: 't1', text: '收到' })

    // 只有 id 字段的 `{ id }` 形状同样收。
    await h.service['superagentAnswer']({ ticketId: { id: 't2' }, text: '好' })
    expect(answer).toHaveBeenLastCalledWith({ ticketId: 't2', text: '好' })
  })
})

describe('纯转发', () => {
  test('setPolicy / setReviewer / listModels 都落到对应服务', () => {
    const h = mount()
    h.service['setPolicy']('readonly')
    h.service['setReviewer']('auto-review')
    expect(h.approval.setPolicy).toHaveBeenCalledWith('readonly')
    expect(h.approval.setReviewer).toHaveBeenCalledWith('auto-review')
    expect(h.service['listModels']()).toEqual([{ value: 'p/m', provider: 'p', model: 'm' }])
    expect(h.llm.listModels).toHaveBeenCalledTimes(1)
  })
})

describe('setUiPrefs：字号归一两支', () => {
  test('发 px 时先归一再派生倍率', async () => {
    const h = mount()
    await expect(h.service['setUiPrefs']({ textSizePx: 18 })).resolves.toMatchObject({ ok: true })
    const patch = h.settings.setPrefs.mock.calls[0]?.[0] as {
      ui: Record<string, unknown>
    }
    expect(patch.ui['textSizePx']).toBe(18)
    expect(typeof patch.ui['fontSize']).toBe('number')
    expect(patch.ui['fontSize']).toBeGreaterThan(0)
  })

  test('只发旧倍率时换算成 px 一起写', async () => {
    const h = mount()
    await expect(h.service['setUiPrefs']({ fontSize: 1.25 })).resolves.toMatchObject({ ok: true })
    const patch = h.settings.setPrefs.mock.calls[0]?.[0] as {
      ui: Record<string, unknown>
    }
    expect(typeof patch.ui['textSizePx']).toBe('number')
    expect(typeof patch.ui['fontSize']).toBe('number')
  })
})

describe('exit', () => {
  test('先发 dsc/exit 再 process.exit(0)', () => {
    const h = mount()
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      h.service['exit']()
      expect(h.events.some((item) => item.event === 'dsc/exit')).toBe(true)
      expect(exit).toHaveBeenCalledWith(0)
    } finally {
      exit.mockRestore()
    }
  })
})
