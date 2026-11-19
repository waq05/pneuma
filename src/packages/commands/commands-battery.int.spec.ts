/**
 * 斜杠命令电池（迁自 `scripts/commands-battery-test.mjs`）：新命令 fork / model / thinking /
 * plugins / update / policy / reviewer / permission / preset / skills 的 handler 直测。
 *
 * ## 为什么这一层要起真内核
 *
 * 被测的是**派发链**：`/...` 输入先过 `duringTask` 闸（回合中不许 fork/update），再按名字
 * 找到 handler。这条链住在 `commands` 插件里，只有内核装配过才有；直接 import 那个包拿到
 * 的兼容导出 `runCommand` 在没装插件时恒返回 false（见 `packages/commands/index.ts` 的注释）。
 * 所以这里 `bootKernel` 之后走 `ctx.commands.run`——与界面同一个入口。
 *
 * handler 本身只认传进来的 `runtime` / `ui`：本文件给的是手搓的运行时快照与界面回调，
 * 断言因此钉在「命令做了什么」（改了哪根旋钮、发了哪句回执、落盘成什么）上。
 *
 * `/update` 用 `DSC_UPDATE_CHECK_URL` 那道缝 + 桩掉 `globalThis.fetch`：那是被观测对象
 * 真实的出网口（与 `src/core/update-check.spec.ts` 同一手法），不另造 HTTP 服务。
 *
 * 三个浮层（PresetPicker / SkillsPicker / 两级 SessionPicker）的渲染冒烟属 ink 渲染层，
 * 在 `src/packages/tui/app/pickers.spec.ts`（tui project）。
 *
 * 按 D25：这一层跑的是混合平面，改完 src 必须 `pnpm run build`。
 *
 * @module dsc/packages/commands/commands-battery.int.spec
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { forkSession, readUserMessages } from '@pneuma/runtime/core/session.js'
import { DSC_HOME } from '@pneuma/runtime/core/path-policy.js'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'

/** 派发结果：命令是否被认出来（false = 当普通消息）。 */
interface CommandService {
  run(input: string, runtime: unknown, ui: unknown): boolean
  specs(): Array<{ name: string; args?: string; duringTask?: string }>
}

/** 界面回调的调用记录。 */
interface Calls {
  notices: string[]
  openModels: number
  openPresets: number
  openSkills: number
  toggleThinking: Array<boolean | undefined>
}

let llm: FakeLLM
let kernel: BootedKernel
let commands: CommandService

/** 等一个条件成立；超时返回 false（由调用方的断言报出来）。 */
async function until(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (condition()) return true
    } catch {
      // 文件还没建出来：继续等。
    }
    if (Date.now() > deadline) return false
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

/** 造一份假界面：每条回调都记数，没给的回调保持 undefined（命令走兜底分支）。 */
function makeUi(overrides: Partial<Record<keyof Calls, unknown>> = {}): { ui: Record<string, unknown>; calls: Calls } {
  const calls: Calls = { notices: [], openModels: 0, openPresets: 0, openSkills: 0, toggleThinking: [] }
  const ui: Record<string, unknown> = {
    openPicker() {},
    openModels() {
      calls.openModels += 1
    },
    openPresets() {
      calls.openPresets += 1
    },
    openSkills() {
      calls.openSkills += 1
    },
    toggleThinking(visible?: boolean) {
      calls.toggleThinking.push(visible)
    },
    notice(text: string) {
      calls.notices.push(text)
    },
    ...overrides,
  }
  return { ui, calls }
}

/** 派发一条命令。 */
function run(input: string, runtime: unknown, ui: Record<string, unknown>): boolean {
  return commands.run(input, runtime, ui)
}

/** 一份权限面（三档 + 两位审阅者，正交的两根轴）。 */
const POLICY_SURFACE = {
  current: 'auto-edit',
  options: [
    { id: 'readonly', label: '仅查看', hint: '只看不改' },
    { id: 'auto-edit', label: '自动编辑', hint: '文件自动放行' },
    { id: 'full-access', label: '完全访问', hint: '全部自动放行' },
  ],
  reviewer: 'user',
  reviewerOptions: [
    { id: 'user', label: '本人审阅', hint: '弹审批卡等你点' },
    { id: 'auto-review', label: 'AI 复核', hint: '先给模型判官看' },
  ],
}

/** 一份打包预设面。 */
const PRESET_SURFACE = {
  current: 'custom',
  defaultName: 'workspace',
  options: [
    { name: 'read-only', label: '只读', description: '写盘与执行一律拒', sandbox: 'read-only', policy: 'readonly', reviewer: 'user', builtin: true },
    { name: 'workspace', label: '工作区可写', description: '区内自动放行', sandbox: 'workspace-write', policy: 'auto-edit', reviewer: 'user', builtin: true },
    { name: 'full-access', label: '完全访问', description: '什么都不问', sandbox: 'danger-full-access', policy: 'full-access', reviewer: 'user', builtin: true },
    { name: 'auto-review', label: 'AI 复核', description: '每个调用先过判官', sandbox: 'danger-full-access', policy: 'full-access', reviewer: 'auto-review', builtin: true },
  ],
}

/** 一条「活着的会话」快照：idle + 真 jsonl 路径。 */
function idleSnapshot(sessionPath?: string | null): Record<string, unknown> {
  return {
    status: {
      turnState: 'idle',
      sessionId: '01890a5e-aaaa-4bbb-8ccc-ddddeeeeffff',
      ...(sessionPath === undefined ? {} : { sessionPath }),
    },
    surfaces: { policy: POLICY_SURFACE, permissionPresets: PRESET_SURFACE },
  }
}

beforeAll(async () => {
  llm = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  commands = (kernel.ctx as unknown as { commands: CommandService }).commands
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
})

describe('① spec 表：命令都可补全，且三根权限旋钮各有入口', () => {
  test('十个命令都在注册表里（/help 与补全都从这里取）', () => {
    const names = new Set(commands.specs().map((spec) => spec.name))
    for (const name of ['fork', 'export', 'preset', 'thinking', 'skills', 'plugins', 'update', 'policy', 'reviewer', 'permission']) {
      expect(names.has(name), name).toBe(true)
    }
  })

  test('fork 与 update 声明 duringTask=deny（回合中不许改历史 / 装更新）', () => {
    const specOf = (name: string): { duringTask?: string } | undefined =>
      commands.specs().find((spec) => spec.name === name)
    expect(specOf('fork')?.duringTask).toBe('deny')
    expect(specOf('update')?.duringTask).toBe('deny')
  })

  test('policy / reviewer / permission 三个 spec 各管一根旋钮（permission 不是 policy 的别名）', () => {
    const argsOf = (name: string): string | undefined => commands.specs().find((spec) => spec.name === name)?.args
    expect(argsOf('policy')).toBe('[readonly|auto-edit|full-access]')
    expect(argsOf('reviewer')).toBe('[user|auto-review]')
    expect(argsOf('permission')).toBe('[预设名]')
  })
})

describe('② /fork：整本分叉落盘，现场会话不动', () => {
  /** 源会话：两问两答。 */
  const SOURCE_ID = 'src-1'
  /** 源会话文件。 */
  let sourcePath = ''

  beforeAll(() => {
    mkdirSync(join(DSC_HOME, 'sessions', 'w'), { recursive: true })
    const lines = [
      { type: 'meta', id: SOURCE_ID, cwd: 'D:\\w', createdAt: 1 },
      { type: 'user', text: '第一问' },
      { type: 'assistant', text: '第一答' },
      { type: 'user', text: '第二问' },
      { type: 'assistant', text: '第二答' },
    ]
    sourcePath = join(DSC_HOME, 'sessions', 'w', `${SOURCE_ID}.jsonl`)
    writeFileSync(sourcePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  })

  /** 真机快照形状：sessionId 是 uuid，sessionPath 才是 jsonl 路径。 */
  function forkRuntime(): Record<string, unknown> {
    return {
      getSnapshot: () => idleSnapshot(sourcePath),
      listUserMessages: (path: string) => Promise.resolve(readUserMessages(path)),
      forkSession: (path: string, index: number) => Promise.resolve({ ok: true, path: forkSession(path, index) }),
    }
  }

  test('成功回执提到副本与 /resume', async () => {
    const { ui, calls } = makeUi()
    expect(run('/fork', forkRuntime(), ui)).toBe(true)
    expect(await until(() => calls.notices.length > 0)).toBe(true)
    expect(calls.notices[0]).toContain('已分叉出副本')
    expect(calls.notices[0]).toContain('/resume')
  })

  test('分叉出了新 jsonl（整本哨兵修复生效）：副本含全部问答，meta 换新 id', () => {
    // 副本落在 slugCwd(源 cwd) = 'D-w' 目录（不是源所在的 w/）。
    const forkedDir = join(DSC_HOME, 'sessions', 'D-w')
    const names = readdirSync(forkedDir)
    expect(names.length).toBeGreaterThanOrEqual(1)
    const forkedName = names[0]!
    expect(forkedName.endsWith('.jsonl')).toBe(true)
    const lines = readFileSync(join(forkedDir, forkedName), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(5)
    expect(lines[3]).toContain('第二问')
    expect((JSON.parse(lines[0]!) as { id: string }).id).not.toBe(SOURCE_ID)
  })

  test('副本首行 meta 标了 forkedFrom', () => {
    const forkedDir = join(DSC_HOME, 'sessions', 'D-w')
    const forkedName = readdirSync(forkedDir)[0]!
    const forkedId = (JSON.parse(readFileSync(join(forkedDir, forkedName), 'utf8').trim().split('\n')[0]!) as { id: string }).id
    const meta = JSON.parse(readFileSync(join(DSC_HOME, 'sessions', 'meta.json'), 'utf8')) as {
      sessions: Record<string, { forkedFrom?: string }>
    }
    expect(meta.sessions[forkedId]?.forkedFrom).toBe(SOURCE_ID)
  })

  test('空会话 /fork 给人话提示', async () => {
    const { ui, calls } = makeUi()
    run('/fork', { getSnapshot: () => ({ status: { turnState: 'idle', sessionId: null } }) }, ui)
    expect(await until(() => calls.notices.length > 0)).toBe(true)
    expect(calls.notices[0]).toContain('还没有可分叉的会话')
  })
})

describe('③ /model 与 /thinking', () => {
  test('裸 /model 只开选择器，不再发用法 notice', () => {
    const { ui, calls } = makeUi()
    run('/model', { getSnapshot: () => ({ status: { turnState: 'idle' } }) }, ui)
    expect(calls.openModels).toBe(1)
    expect(calls.notices).toHaveLength(0)
  })

  test('/thinking 无参数 = 翻转（visible 传 undefined），on/off 显式传值', () => {
    const { ui, calls } = makeUi()
    run('/thinking', {}, ui)
    run('/thinking on', {}, ui)
    run('/thinking off', {}, ui)
    expect(calls.toggleThinking).toEqual([undefined, true, false])
  })

  test('未知参数给用法', () => {
    const { ui, calls } = makeUi()
    run('/thinking sideways', {}, ui)
    expect(calls.notices[0]).toContain('用法：/thinking')
  })

  test('没接回调的端给兜底提示不炸', () => {
    const { ui, calls } = makeUi({ toggleThinking: undefined })
    run('/thinking', {}, ui)
    expect(calls.notices[0]).toContain('当前界面不支持会话内切换思考块')
  })
})

describe('④ /plugins：清单走多行 notice', () => {
  test('插件清单含两个插件与启停标记，problem 上屏，头部有总数', () => {
    const { ui, calls } = makeUi()
    run(
      '/plugins',
      {
        listPlugins: () => [
          { file: 'commands', name: 'commands', description: '命令注册表', enabled: true, source: 'builtin', toggleable: false },
          { file: 'my-plugin.js', name: 'my-plugin', description: '外部示例', enabled: false, source: 'external', toggleable: true, problem: 'apiVersion 过新' },
        ],
      },
      ui,
    )
    const text = calls.notices[0] ?? ''
    expect(text).toContain('commands（内核）')
    expect(text).toContain('my-plugin（外部 · 已停用）')
    expect(text).toContain('apiVersion 过新')
    expect(text).toContain('已挂载插件（2 个）')
  })
})

describe('⑤ /policy 与 /reviewer：单档两根轴（前缀匹配 + 回执）', () => {
  /** 一份会记账的运行时：切档调用都记下来。 */
  function policyRuntime(overrides: Record<string, unknown> = {}): {
    runtime: Record<string, unknown>
    state: { policy?: string; reviewer?: string; preset?: string }
  } {
    const state: { policy?: string; reviewer?: string; preset?: string } = {}
    const runtime: Record<string, unknown> = {
      getSnapshot: () => idleSnapshot(),
      setPolicy(policy: string) {
        state.policy = policy
      },
      setReviewer(reviewer: string) {
        state.reviewer = reviewer
      },
      usePermissionPreset(name: string) {
        state.preset = name
        return { ok: true, notice: `权限预设切到「${name}」` }
      },
      ...overrides,
    }
    return { runtime, state }
  }

  test('裸 /policy 列出三档与当前档，且不再出现四档的 ai-review', () => {
    const { runtime } = policyRuntime()
    const { ui, calls } = makeUi()
    run('/policy', runtime, ui)
    const text = calls.notices[0] ?? ''
    expect(text).toContain('当前权限模式：auto-edit')
    expect(text).toContain('readonly')
    expect(text).toContain('full-access')
    expect(text).not.toContain('ai-review')
  })

  test('/policy full 前缀匹配切档，并给一句回执', () => {
    const { runtime, state } = policyRuntime()
    const { ui, calls } = makeUi()
    run('/policy full', runtime, ui)
    expect(state.policy).toBe('full-access')
    expect(calls.notices.at(-1)).toContain('权限模式已切到「完全访问」')
  })

  test('未知权限档位报可选清单', () => {
    const { runtime } = policyRuntime()
    const { ui, calls } = makeUi()
    run('/policy nope', runtime, ui)
    expect(calls.notices.at(-1)).toContain('未知权限档位')
  })

  test('裸 /reviewer 列出两位审阅者与当前', () => {
    const { runtime } = policyRuntime()
    const { ui, calls } = makeUi()
    run('/reviewer', runtime, ui)
    const text = calls.notices[0] ?? ''
    expect(text).toContain('当前审阅者：user')
    expect(text).toContain('auto-review')
  })

  test('/reviewer auto 前缀匹配切审阅者，并给一句带解释的回执', () => {
    const { runtime, state } = policyRuntime()
    const { ui, calls } = makeUi()
    run('/reviewer auto', runtime, ui)
    expect(state.reviewer).toBe('auto-review')
    expect(calls.notices.at(-1)).toContain('审批审阅者已切到「AI 复核」')
  })

  test('未知审阅者报可选清单', () => {
    const { runtime } = policyRuntime()
    const { ui, calls } = makeUi()
    run('/reviewer nope', runtime, ui)
    expect(calls.notices.at(-1)).toContain('未知审阅者')
  })
})

describe('⑥ /permission：打包预设选择器（不再是 /policy 的别名）', () => {
  /** 一份会记账的运行时。 */
  function permissionRuntime(overrides: Record<string, unknown> = {}): {
    runtime: Record<string, unknown>
    preset: () => string | undefined
  } {
    let preset: string | undefined
    const runtime: Record<string, unknown> = {
      getSnapshot: () => idleSnapshot(),
      usePermissionPreset(name: string) {
        preset = name
        return { ok: true, notice: `权限预设切到「${name}」` }
      },
      ...overrides,
    }
    return { runtime, preset: () => preset }
  }

  test('裸 /permission 列出当前预设（custom 带说明）与四个预设', () => {
    const { runtime } = permissionRuntime()
    const { ui, calls } = makeUi()
    run('/permission', runtime, ui)
    const text = calls.notices[0] ?? ''
    expect(text).toContain('当前权限预设：custom')
    expect(text).toContain('三根旋钮的组合不匹配任何预设')
    for (const name of ['read-only', 'workspace', 'full-access', 'auto-review']) expect(text).toContain(name)
  })

  test('/permission full 前缀匹配到 full-access', () => {
    const { runtime, preset } = permissionRuntime()
    const { ui } = makeUi()
    run('/permission full', runtime, ui)
    expect(preset()).toBe('full-access')
  })

  test('档位名被误当预设名时，指路到 /policy <档位>', () => {
    const { runtime } = permissionRuntime()
    const { ui, calls } = makeUi()
    run('/permission readonly', runtime, ui)
    expect(calls.notices[0]).toContain('是权限档位不是预设')
    expect(calls.notices[0]).toContain('/policy readonly')
  })

  test('未知预设报可选清单', () => {
    const { runtime } = permissionRuntime()
    const { ui, calls } = makeUi()
    run('/permission nope', runtime, ui)
    expect(calls.notices[0]).toContain('未知权限预设')
  })

  test('usePermissionPreset 失败时把错误原话上屏', () => {
    const { runtime } = permissionRuntime({
      usePermissionPreset: () => ({ ok: false, error: '沙箱插件没开，danger-full-access 这一半没落地' }),
    })
    const { ui, calls } = makeUi()
    run('/permission auto-review', runtime, ui)
    expect(calls.notices[0]).toContain('没落地')
  })
})

describe('⑦ /update：假更新源，只查不装', () => {
  /** 桩掉 `globalThis.fetch`：`/update` 真实的出网口。 */
  function stubFetch(body: unknown): () => void {
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    return () => {
      globalThis.fetch = original
    }
  }

  test('有新版时给出版本与发布页', async () => {
    process.env['DSC_UPDATE_CHECK_URL'] = 'http://127.0.0.1:1/releases/latest'
    const restore = stubFetch({ version: '999.0.0', url: 'http://127.0.0.1:1/page' })
    try {
      const { ui, calls } = makeUi()
      run('/update', { getSnapshot: () => ({ status: { turnState: 'idle' } }) }, ui)
      expect(await until(() => calls.notices.length > 0)).toBe(true)
      expect(calls.notices[0]).toContain('发现新版 999.0.0')
      expect(calls.notices[0]).toContain('发布页')
    } finally {
      restore()
    }
  })

  test('已是最新给版本号', async () => {
    const { DSC_VERSION } = await import('@pneuma/runtime/core/version.js')
    process.env['DSC_UPDATE_CHECK_URL'] = 'http://127.0.0.1:1/releases/latest'
    const restore = stubFetch({ version: DSC_VERSION, url: '' })
    try {
      const { ui, calls } = makeUi()
      run('/update', { getSnapshot: () => ({ status: { turnState: 'idle' } }) }, ui)
      expect(await until(() => calls.notices.length > 0)).toBe(true)
      expect(calls.notices[0]).toContain('已是最新')
    } finally {
      restore()
      delete process.env['DSC_UPDATE_CHECK_URL']
    }
  })
})

describe('⑧ 裸 /preset /skills：有选择器的端开浮层，没接的端 notice 兜底', () => {
  test('裸 /preset 与 /skills 分别走 openPresets / openSkills 回调', () => {
    const withPicker = makeUi()
    run('/preset', {}, withPicker.ui)
    run('/skills', {}, withPicker.ui)
    expect(withPicker.calls.openPresets).toBe(1)
    expect(withPicker.calls.openSkills).toBe(1)
    expect(withPicker.calls.notices).toHaveLength(0)
  })

  test('没接回调时落回 notice 清单', () => {
    const fallback = makeUi({ openPresets: undefined, openSkills: undefined })
    run('/preset', {}, fallback.ui)
    run('/skills', {}, fallback.ui)
    expect(fallback.calls.notices[0]).toContain('当前模式：')
    expect(fallback.calls.notices[1]).toContain('技能')
  })
})

describe('⑨ duringTask 闸：回合中挡下 deny 命令', () => {
  test('回合中 /fork 被派发闸挡下', () => {
    const { ui, calls } = makeUi()
    run(
      '/fork',
      {
        getSnapshot: () => ({ status: { turnState: 'working', sessionId: 'x' } }),
        listUserMessages: () => Promise.resolve([]),
        forkSession: () => Promise.resolve({ ok: true, path: '/tmp/x.jsonl' }),
      },
      ui,
    )
    expect(calls.notices[0]).toContain('要等当前回合结束')
  })
})
