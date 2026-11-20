/**
 * 宿主接线层（`host/health.ts`、`host/command.ts`、`host/settings-section.ts`）的包级测试。
 *
 * 为什么这三块要一起测：它们是「运行期 → DSC 宿主」的投影面——`/doctor` 的四项体检、
 * `/sa` 命令的解析与回话、设置页的分区字段与保存。三者都只读运行期、不写自己的状态，
 * 所以用假 runtime / 假 `PanelApi` 就能把分支走全，不必起真宿主、不必连网。
 *
 * 断言的是对外可见的结果：体检的 `status` / `summary`、命令行 `ui.notice` 的文案、
 * 设置控件与保存时真正传给 `settings.save` 的值。
 *
 * @module dsc/packages/superagent/tests/kernel-host
 */
import type { SuperagentTicketView } from '@pneuma/runtime/contract.js'
import type { HealthCheck, HealthResult, SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { describe, expect, test, vi } from 'vitest'
import { SettingsSchema } from '../core/policy.js'
import { parseSaCommand, registerSaCommand, resolveTicket } from '../host/command.js'
import { createSettingsSection, saveSettingOf, settingsViewOf } from '../host/settings-section.js'

/** `/doctor` 的队友体检读 `plugins.json`：那份文件的口径由 `readPluginEntries` 自己测，这里只换掉入口。 */
const pluginEntries = vi.hoisted(() => ({ list: [] as { file: string; disabled?: boolean }[] }))
vi.mock('@pneuma/runtime/core/plugin-registry.js', () => ({ readPluginEntries: () => pluginEntries.list }))

const { createDependenciesHealth, createFeishuHealth, createSuperagentHealth, createTeammatesHealth } = await import('../host/health.js')

// ── host/health ─────────────────────────────────────────────────────────────

/**
 * 取体检结论：`HealthCheck.run()` 的签名允许同步或异步返回（doctor 那边会 await）。
 * 这四项都是同步实现，拿到 Promise 说明被测代码换成了异步——那是行为变化，当场失败。
 */
function runCheck(check: HealthCheck): HealthResult {
  const result = check.run()
  if (result instanceof Promise) throw new Error('体检项应当是同步返回')
  return result
}

/** 一张未结束工单的最小形状；`ticketStage` 只读这几个字段。 */
function ticketOf(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    title: `工单 ${id}`,
    decisionId: 'd1',
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'feishu', id: 'ou_1' }, scope: 'chat' },
    channels: [],
    assignments: [{ id: 'a1', state: 'pending', createdAt: '2026-01-01T00:00:00.000Z' }],
    inputs: [],
    undelivered: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    origin: { triggerId: 't1', triggerIds: ['t1'] },
    ...patch,
  }
}

/** 编排库体检要的运行时：只有 `createSuperagentHealth` 读的那些成员。 */
function orchestratorRuntime(options: {
  atomicThrows?: Error
  configured?: boolean
  problem?: { code: string; detail: string }
  health?: Record<string, { state: string; detail: string }>
  tickets?: unknown[]
} = {}) {
  return {
    machine: { stateDir: '/state' },
    store: {
      atomic: (work: () => unknown) => {
        if (options.atomicThrows) throw options.atomicThrows
        return work()
      },
      tickets: { open: () => options.tickets ?? [] },
    },
    configured: () => options.configured ?? true,
    setupProblem: options.problem,
    deployment: { repository: 'acme/widgets' },
    health: options.health ?? {},
  }
}

describe('host/health：编排库体检', () => {
  test('全部正常时报 ok，detail 带状态目录、锁、部署与各组件的体检格', () => {
    const check = createSuperagentHealth(orchestratorRuntime({
      health: { runtime: { state: 'ready', detail: 'booting done' }, models: { state: 'ready', detail: '' } },
    }) as never)
    expect(check.id).toBe('superagent/orchestrator')
    expect(check.title).toBe('Super Agent 编排库')
    expect(check.order).toBe(100)
    const result = runCheck(check)
    expect(result.status).toBe('ok')
    expect(result.summary).toContain('正常')
    expect(result.detail).toContain('状态目录：/state')
    expect(result.detail).toContain('锁：本进程持有')
    expect(result.detail).toContain('部署：已就绪（仓库 acme/widgets）')
    expect(result.detail).toContain('runtime：ready —— booting done')
    expect(result.detail).toContain('models：ready')
    expect(result.detail).toContain('工单：0 张未结束')
  })

  test('盘写不进去报 fail，并指出去查哪个目录', () => {
    const check = createSuperagentHealth(orchestratorRuntime({ atomicThrows: new Error('disk full') }) as never)
    const result = runCheck(check)
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('写：不可写（disk full）')
    expect(result.fix).toContain('/state')
  })

  test('部署检查没过报 warn，带上 problem 的 code', () => {
    const check = createSuperagentHealth(orchestratorRuntime({ configured: false, problem: { code: 'agentCliUnset', detail: '没填 gh' } }) as never)
    const result = runCheck(check)
    expect(result.status).toBe('warn')
    expect(result.summary).toContain('agentCliUnset')
    expect(result.detail).toContain('部署：等待检查（agentCliUnset：没填 gh）')
    expect(result.fix).toContain('设置 → Super Agent')
  })

  test('组件体检格报 error 时报 warn 并点名；工单按阶段计数', () => {
    const check = createSuperagentHealth(orchestratorRuntime({
      health: { feishu: { state: 'error', detail: 'poll failed' } },
      tickets: [
        ticketOf('t1'),
        // 等人回答：attention 让 stage 落到 person。
        ticketOf('t2', { attention: { id: 'a', question: '要哪个', triggerId: 'trig' } }),
        // 空闲：running 分配 + waiting 报告。
        ticketOf('t3', { assignments: [{ id: 'a3', state: 'running', createdAt: '2026-01-01T00:00:00.000Z', report: { state: 'waiting', summary: '等', at: '2026-01-01T00:00:00.000Z' } }] }),
      ],
    }) as never)
    const result = runCheck(check)
    expect(result.status).toBe('warn')
    expect(result.summary).toContain('feishu')
    expect(result.detail).toContain('工单：3 张未结束（执行中 1 / 待你处理 1 / 空闲 1）')
  })
})

describe('host/health：飞书来源体检', () => {
  const feishuRuntime = (options: {
    instance?: { id: string; enabled: boolean } | undefined
    entries?: Record<string, { state: string; detail: string } | undefined>
    problem?: { code: string; detail: string }
  } = {}) => ({
    store: { settings: () => SettingsSchema.parse({}) },
    sources: { instance: () => options.instance },
    health: options.entries ?? {},
    feishuProblem: options.problem,
  })

  test('来源没注册报 skip', () => {
    const result = runCheck(createFeishuHealth(feishuRuntime() as never))
    expect(result).toEqual({ status: 'skip', summary: '飞书来源没有注册（插件的来源启动那一步没跑到）' })
  })

  test('来源没启用报 skip，即使部署检查有 problem', () => {
    const result = runCheck(createFeishuHealth(feishuRuntime({
      instance: { id: 'feishu', enabled: false },
      entries: { feishu: { state: 'ready', detail: '' } },
      problem: { code: 'feishuNoApp', detail: '没 app' },
    }) as never))
    expect(result.status).toBe('skip')
    expect(result.summary).toContain('未启用')
    expect(result.detail).toContain('部署检查：feishuNoApp —— 没 app')
  })

  test('部署检查没过报 warn，说明来源不会轮询', () => {
    const result = runCheck(createFeishuHealth(feishuRuntime({
      instance: { id: 'feishu', enabled: true },
      entries: { feishu: { state: 'ready', detail: 'connected' } },
      problem: { code: 'feishuBotNotReady', detail: 'bot offline' },
    }) as never))
    expect(result.status).toBe('warn')
    expect(result.summary).toBe('飞书机器人检查没过：来源不会轮询')
    expect(result.fix).toContain('lark-cli auth status')
  })

  test('来源体检格报 error 报 warn', () => {
    const result = runCheck(createFeishuHealth(feishuRuntime({
      instance: { id: 'feishu', enabled: true },
      entries: { history: { state: 'error', detail: 'backfill failed' } },
    }) as never))
    expect(result.status).toBe('warn')
    expect(result.summary).toBe('飞书来源报错')
    expect(result.detail).toContain('history：error —— backfill failed')
  })

  test('还没开始轮询（没有体检格，或只有 starting/paused）报 skip；其余报 ok', () => {
    const none = runCheck(createFeishuHealth(feishuRuntime({ instance: { id: 'feishu', enabled: true } }) as never))
    expect(none).toEqual({ status: 'skip', summary: '飞书来源还没开始轮询（等待部署检查）' })
    const waiting = runCheck(createFeishuHealth(feishuRuntime({
      instance: { id: 'feishu', enabled: true },
      entries: { feishu: { state: 'starting', detail: 'connecting' }, history: { state: 'paused', detail: 'no bot' } },
    }) as never))
    expect(waiting.status).toBe('skip')
    const ok = runCheck(createFeishuHealth(feishuRuntime({
      instance: { id: 'feishu', enabled: true },
      entries: { feishu: { state: 'ready', detail: 'connected' }, history: { state: 'starting', detail: '' } },
    }) as never))
    expect(ok.status).toBe('ok')
    expect(ok.detail).toContain('feishu：ready —— connected')
  })
})

describe('host/health：机器依赖体检', () => {
  const runtimeWith = (settings: unknown, throwAt?: boolean) => ({
    store: { settings: () => { if (throwAt) throw new Error('设置读不出来'); return settings } },
  })
  const settingsOf = (githubCli: string, feishuCli: string, gitHint = true) => SettingsSchema.parse({
    sources: {
      github: { enabled: true, config: { repository: 'acme/widgets', ...gitHint ? { cli: githubCli } : {} } },
      feishu: { enabled: true, config: { cli: feishuCli } },
    },
  })

  test('缺命令时报 warn，并把「装什么」写进 fix', () => {
    const result = runCheck(createDependenciesHealth(runtimeWith(settingsOf('dsh-superagent-not-a-real-cli', 'dsh-superagent-not-a-real-lark')) as never))
    expect(result.status).toBe('warn')
    expect(result.summary).toContain('GitHub CLI')
    expect(result.fix).toContain('GitHub 来源要一个登录智能体账号的 gh')
    expect(result.fix).toContain('npm install -g @larksuite/cli')
    expect(result.detail).toContain('lark-cli：未安装')
  })

  test('设置读不出来也只报 warn，不抛', () => {
    const result = runCheck(createDependenciesHealth(runtimeWith(undefined, true) as never))
    expect(result.status).toBe('warn')
    expect(result.summary).toBe('依赖探测没跑成')
    expect(result.detail).toBe('设置读不出来')
  })

  test('全部能跑时报 ok（需要本机有 git，没有就跳过这条）', () => {
    const result = runCheck(createDependenciesHealth(runtimeWith(settingsOf(process.execPath, process.execPath)) as never))
    if (result.summary.startsWith('缺 git')) {
      // 本机没有 git：上面的缺命令分支已经覆盖「git 也缺」的文案，这条不再断言。
      expect(result.fix).toContain('装 Git 并重开会话让 PATH 带上它')
      return
    }
    expect(result.status).toBe('ok')
    expect(result.summary).toContain('正常')
  })
})

describe('host/health：队友能力体检', () => {
  test('plugins.json 没有 subagent 条目时报 warn，说明它默认关', () => {
    pluginEntries.list = [{ file: 'doctor' }]
    const result = runCheck(createTeammatesHealth())
    expect(result.status).toBe('warn')
    expect(result.detail).toContain('plugins.json 里没有 subagent 条目')
  })

  test('subagent 被 disabled 时报 warn；启用时报 ok', () => {
    pluginEntries.list = [{ file: 'subagent', disabled: true }]
    expect(runCheck(createTeammatesHealth()).detail).toBe('plugins.json 里 subagent 条目标着 disabled')
    pluginEntries.list = [{ file: 'subagent', disabled: false }]
    expect(runCheck(createTeammatesHealth())).toEqual({ status: 'ok', summary: '可用（subagent 插件已启用）' })
  })
})

// ── host/command ────────────────────────────────────────────────────────────

describe('host/command：/sa 解析', () => {
  test('new：标题与正文按第一个 | 切；缺正文取标题；纯空白与空标题各自报格式', () => {
    expect(parseSaCommand(['new', '改 登录 页', '|', '中文提示'])).toEqual({ kind: 'new', title: '改 登录 页', body: '中文提示' })
    expect(parseSaCommand(['new', '只有一个标题'])).toEqual({ kind: 'new', title: '只有一个标题', body: '只有一个标题' })
    expect(parseSaCommand(['new', 'a|b'])).toEqual({ kind: 'new', title: 'a', body: 'b' })
    expect(parseSaCommand(['NEW', '标题', '|', '  '])).toEqual({ kind: 'new', title: '标题', body: '标题' })
    expect(parseSaCommand(['new', '   '])).toMatchObject({ kind: 'error' })
    expect(parseSaCommand(['new', '|', '只有正文'])).toMatchObject({ kind: 'error' })
    expect(parseSaCommand(['new', '|', '只有正文'])).toHaveProperty('message', expect.stringContaining('标题不能为空'))
  })

  test('list / stop / retry / clean 与各条错误文案', () => {
    expect(parseSaCommand(['list'])).toEqual({ kind: 'list' })
    expect(parseSaCommand(['list', 'x'])).toMatchObject({ kind: 'error' })
    expect(parseSaCommand(['stop', 'abc12345'])).toEqual({ kind: 'stop', id: 'abc12345' })
    expect(parseSaCommand(['retry', 'abc'])).toEqual({ kind: 'retry', id: 'abc' })
    expect(parseSaCommand(['CLEAN', 'abc'])).toEqual({ kind: 'clean', id: 'abc' })
    expect(parseSaCommand(['stop'])).toHaveProperty('message', expect.stringContaining('后面要跟一个工单 id'))
    expect(parseSaCommand(['stop', 'abc', 'def'])).toHaveProperty('message', expect.stringContaining('只接一个工单 id'))
    expect(parseSaCommand([])).toMatchObject({ kind: 'error' })
    expect(parseSaCommand(['unknown'])).toMatchObject({ kind: 'error' })
  })
})

describe('host/command：resolveTicket', () => {
  // 契约里的界面投影除了 id / 标题 / 阶段，还要求建单时刻 `at`（界面按它排序）。
  const tickets: SuperagentTicketView[] = [
    { id: 'aaaaaaaa1111', title: '甲', at: '2026-01-01T00:00:00.000Z', stage: { stage: 'working' } },
    { id: 'aaaaaaaa2222', title: '乙', at: '2026-01-01T00:00:00.000Z', stage: { stage: 'idle' } },
    { id: 'bbbbbbbb3333', title: '丙', at: '2026-01-01T00:00:00.000Z', stage: { stage: 'ended' } },
    { id: 'bbbbbbbb4444', title: '丁', at: '2026-01-01T00:00:00.000Z', stage: { stage: 'person', action: 'review' } },
    { id: 'bbbbbbbb5555', title: '戊', at: '2026-01-01T00:00:00.000Z', stage: { stage: 'person', action: 'failed' } },
  ]

  test('空输入、找不到、完整 id 命中、唯一前缀都各有说法', () => {
    expect(resolveTicket(tickets, '  ')).toEqual({ message: '要给一个工单 id。' })
    expect(resolveTicket(tickets, 'cccc')).toHaveProperty('message', expect.stringContaining('没有这张工单'))
    expect(resolveTicket(tickets, 'bbbbbbbb3333')).toMatchObject({ ticket: { title: '丙' } })
    expect(resolveTicket(tickets, 'AAAAAAAA1111')).toMatchObject({ ticket: { title: '甲' } })
  })

  test('前缀命中多张时列出候选并让人贴长一点', () => {
    const found = resolveTicket(tickets, 'bbbbbbbb')
    expect('message' in found).toBe(true)
    if (!('message' in found)) throw new Error('应当是有歧义')
    expect(found.message).toContain('有歧义')
    expect(found.message).toContain('丙')
    expect(found.message).toContain('贴长一点')
  })
})

describe('host/command：/sa 命令回话', () => {
  interface Row { id: string; title: string; stage: unknown }
  interface Surface { ready: boolean; problem?: { detail: string }; tickets: Row[] }
  function harness(options: {
    surface?: () => Surface
    publish?: (input: { title: string; body: string }) => Promise<string>
    action?: (id: string) => Promise<void>
  } = {}) {
    const notices: string[] = []
    const registered: { spec?: unknown; handler?: (invocation: unknown) => void } = {}
    const ctx = {
      commands: {
        register(spec: unknown, handler: (invocation: unknown) => void) {
          registered.spec = spec
          registered.handler = handler
          return () => { notices.push('disposed') }
        },
      },
    }
    let rows: Row[] = [
      { id: 'aaaaaaaa1111', title: '甲', stage: { stage: 'working', action: 'queued' } },
      { id: 'bbbbbbbb2222', title: '乙', stage: { stage: 'person', action: 'delivery' } },
      { id: 'cccccccc3333', title: '丙', stage: { stage: 'person', action: 'answer' } },
      { id: 'dddddddd4444', title: '丁', stage: { stage: 'person', action: 'blocked' } },
      { id: 'eeeeeeee5555', title: '戊', stage: { stage: 'person', action: 'failed' } },
      { id: 'ffffffff6666', title: '己', stage: { stage: 'idle' } },
      { id: '999999996666', title: '庚', stage: { stage: 'ended' } },
    ]
    const api = {
      surface: options.surface ?? (() => ({ ready: true, tickets: rows })),
      publish: options.publish ?? (async ({ title }: { title: string }) => {
        const id = 'new000000001'
        rows = [...rows, { id, title, stage: { stage: 'working', action: 'queued' } }]
        return id
      }),
      stop: options.action ?? (async () => { rows = rows.map(row => ({ ...row, stage: { stage: 'ended' } })) }),
      retry: options.action ?? (async () => { rows = rows.map(row => ({ ...row, stage: { stage: 'working' } })) }),
      clean: options.action ?? (async () => {}),
    }
    const dispose = registerSaCommand(ctx as never, api as never)
    const run = (args: string[]): void => {
      registered.handler!({ args, ui: { notice: (text: string) => notices.push(text) } })
    }
    return { notices, run, dispose, registered, setRows: (next: Row[]) => { rows = next } }
  }
  /** 让 `void action.then(...)` / `void publish().then(...)` 的回调跑完。 */
  const flush = async (): Promise<void> => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
  }

  test('注册的 spec 是 sa；解析错误直接回文案；dispose 转发退订', () => {
    const h = harness()
    expect(h.registered.spec).toMatchObject({ name: 'sa', label: 'Super Agent 工单' })
    h.run(['nope'])
    expect(h.notices[0]).toContain('格式：/sa new')
    h.dispose()
    expect(h.notices).toContain('disposed')
  })

  test('运行期没就绪：说清缺什么', async () => {
    const notReady = harness({ surface: () => ({ ready: false, problem: { detail: '部署检查没过' }, tickets: [] }) })
    notReady.run(['list'])
    expect(notReady.notices[0]).toBe('Super Agent 未就绪：部署检查没过')

    const noProblem = harness({ surface: () => ({ ready: false, tickets: [] }) })
    noProblem.run(['list'])
    expect(noProblem.notices[0]).toBe('Super Agent 未就绪：运行期还没起来')
    await flush()
  })

  test('list：空列表给引导，非空时逐行渲染状态（覆盖 stageText 每支）', () => {
    const empty = harness()
    empty.setRows([])
    empty.run(['list'])
    expect(empty.notices[0]).toBe('还没有工单。用 /sa new 标题 | 正文 建一个。')

    const h = harness()
    h.run(['list'])
    const rendered = h.notices[0]!
    expect(rendered.split('\n')[0]).toBe('ID / 状态 / 标题')
    expect(rendered).toContain('aaaaaaaa  待派工  甲')
    expect(rendered).toContain('bbbbbbbb  等你接收  乙')
    expect(rendered).toContain('cccccccc  等你回答  丙')
    expect(rendered).toContain('dddddddd  卡住了  丁')
    expect(rendered).toContain('eeeeeeee  失败了  戊')
    expect(rendered).toContain('ffffffff  空闲  己')
    expect(rendered).toContain('99999999  已结束  庚')
  })

  test('stop / retry / clean 成功与失败各自回话', async () => {
    const stopped = harness()
    stopped.run(['stop', 'aaaaaaaa'])
    await flush()
    expect(stopped.notices[0]).toContain('工单已停止：甲')
    expect(stopped.notices[0]).toContain('现在已结束')

    const retried = harness()
    retried.run(['retry', 'aaaaaaaa'])
    await flush()
    expect(retried.notices[0]).toContain('已重新派工：甲')

    const cleaned = harness()
    cleaned.run(['clean', 'aaaaaaaa'])
    await flush()
    expect(cleaned.notices[0]).toBe('工作树已清理：甲')

    const failing = harness({ action: async () => { throw Object.assign(new Error('x'), { code: 'notRetryable' }) } })
    failing.run(['retry', 'aaaaaaaa'])
    await flush()
    expect(failing.notices[0]).toContain('重试失败：这张工单现在不能重试')

    const unknown = harness({ action: async () => { throw Object.assign(new Error('x'), { code: 'unknownTicket' }) } })
    unknown.run(['clean', 'aaaaaaaa'])
    await flush()
    expect(unknown.notices[0]).toContain('清理失败：没有这张工单')

    const ended = harness({ action: async () => { throw Object.assign(new Error('已经结束'), { code: 'ticketEnded' }) } })
    ended.run(['stop', 'aaaaaaaa'])
    await flush()
    expect(ended.notices[0]).toContain('停止失败：这张工单已经结束了')
  })

  test('id 找不到或有歧义时只回一句，不动工单', async () => {
    const h = harness()
    h.run(['stop', 'zzzz'])
    expect(h.notices[0]).toContain('没有这张工单')
    const ambiguous = harness()
    ambiguous.run(['stop', ''])
    expect(ambiguous.notices[0]).toContain('后面要跟一个工单 id')
  })

  test('new：发布成功后报工单标题，快照里查不到时说明没接单成功', async () => {
    const published = harness()
    published.run(['new', '标题', '|', '正文'])
    await flush()
    expect(published.notices[0]).toContain('工单已建：标题（new000000001）')

    const missing = harness({ publish: async () => 'ghost-id' })
    missing.run(['new', '标题'])
    await flush()
    expect(missing.notices[0]).toBe('已收到，但没有接单成功（id ghost-id），去看日志。')

    const failing = harness({ publish: async () => { throw new Error('主会话超时') } })
    failing.run(['new', '标题'])
    await flush()
    expect(failing.notices[0]).toBe('发布失败：主会话超时')
  })
})

// ── host/settings-section ───────────────────────────────────────────────────

describe('host/settings-section：分区投影与保存', () => {
  const settings = SettingsSchema.parse({
    executor: { maxWorkers: 3, prepare: 'pnpm install', blockedCommands: ['npm', 'docker'], model: { provider: 'deepseek', model: 'chat' } },
    eval: { mode: 'auto', timeoutSeconds: 600, model: null },
    sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh' } } },
    policy: { sources: { github: { allowed: [{ id: 'alice', name: 'Alice' }] } } },
  })
  const kind = {
    kind: 'github',
    title: { zh: 'GitHub', en: 'GitHub' },
    description: { zh: '拉 Issue 与 PR', en: 'Issues and PRs' },
    schema: { parse: (value: unknown) => value },
    health: ['github'],
    facts: (deployment: unknown) => deployment === undefined ? undefined : { account: 'agent-bot', repository: { zh: '仓库', en: 'Repository' } },
    fields: [
      { key: 'repository', label: { zh: '仓库', en: 'Repository' }, type: 'text', hint: { zh: 'owner/repo', en: 'owner/repo' } },
      { key: 'cli', label: { zh: 'CLI', en: 'CLI' }, type: 'text', choose: { zh: '从已装里选', en: 'Choose' } },
      { key: 'observe', label: { zh: '观察', en: 'Observe' }, type: 'switch' },
      { key: 'interval', label: { zh: '间隔', en: 'Interval' }, type: 'number', min: 1, max: 60 },
      { key: 'pulls', label: { zh: 'PR', en: 'PRs' }, type: 'select', options: [{ value: 'all', label: { zh: '全部', en: 'All' } }] },
      {
        key: 'labels', label: { zh: '标签', en: 'Labels' }, type: 'rows', advanced: true,
        columns: [
          { key: 'name', label: { zh: '名字', en: 'Name' }, type: 'text', pattern: '^[a-z]+$', choose: { zh: '选', en: 'Pick' } },
          { key: 'mode', label: { zh: '方式', en: 'Mode' }, type: 'select', options: [{ value: 'a', label: { zh: '甲', en: 'A' } }] },
        ],
      },
      { key: 'account', label: { zh: '账号', en: 'Account' }, type: 'fact', settings: 'deployment' },
      { key: 'secret', label: { zh: '密文', en: 'Secret' }, type: 'text', optional: true } as never,
    ],
    policy: { fields: [{ key: 'allowed', label: { zh: '允许名单', en: 'Allowed' }, type: 'rows', columns: [{ key: 'id', label: { zh: 'ID', en: 'ID' }, type: 'text' }] }] },
  }
  const installed = { id: 'github', kind: 'github', enabled: true, installed: true,
    config: { repository: 'acme/widgets', cli: 'gh', observe: true, interval: 10, pulls: 'all', labels: [{ name: 'bug', mode: 'a' }], account: 'agent-bot' } }

  function harness(options: { configured?: boolean; saveThrows?: Error; kindOverride?: unknown } = {}) {
    const saved: { block: string; value: unknown; revision: number; origin: string }[] = []
    const runtime = {
      store: { settings: () => settings },
      settings: {
        block: (block: string) => {
          if (block === 'policy') return { block, revision: 4, value: settings.policy }
          if (block === 'executor') return { block, revision: 2, value: settings.executor }
          if (block === 'eval') return { block, revision: 3, value: settings.eval }
          return { block, revision: 1, value: { enabled: true, config: installed.config } }
        },
        save: async (block: string, value: unknown, revision: number, origin: string) => {
          if (options.saveThrows) throw options.saveThrows
          saved.push({ block, value, revision, origin })
        },
      },
      sources: {
        instances: () => [installed],
        kind: () => options.kindOverride ?? kind,
        policyPart: () => ({ allowed: [{ id: 'alice' }] }),
      },
      setup: { configured: () => options.configured ?? true, deployment: { repository: 'acme/widgets' } },
    }
    return { section: createSettingsSection(runtime as never), saved, runtime }
  }

  test('fields：执行块七个控件 + 来源开关 / 配置字段 / 策略字段 / 部署事实', () => {
    const { section } = harness()
    const fields = section.fields()
    const keys = fields.map(field => 'key' in field ? field.key : 'info')
    expect(keys).toContain('maxWorkers')
    expect(keys).toContain('prepareCommand')
    expect(keys).toContain('evalMode')
    expect(keys).toContain('assessorModel')
    expect(keys).toContain('workerModel')
    expect(keys).toContain('workerBlockedCommands')
    expect(keys).toContain('github.enabled')
    expect(keys).toContain('githubRepository')
    expect(keys).toContain('githubAllowed')
    // 没声明成控件的部署事实补一条只读行。
    expect(keys).toContain('github.deployment.repository')
    expect(keys).not.toContain('github.deployment.account')

    const rows = fields.find(field => 'key' in field && field.key === 'github.labels') as Record<string, unknown>
    expect(rows.type).toBe('rows')
    expect(rows.advanced).toBe(true)
    const columns = rows.columns as Record<string, unknown>[]
    expect(columns[0]).toMatchObject({ key: 'name', pattern: '^[a-z]+$', choose: true })
    expect(columns[1]).toMatchObject({ type: 'select', options: [{ value: 'a', label: '甲' }] })
    const account = fields.find(field => 'key' in field && field.key === 'github.account') as Record<string, unknown>
    expect(account).toMatchObject({ type: 'fact', settings: 'deployment' })
    expect(section.id).toBe('superagent')
    expect(section.order).toBe(39)
  })

  test('实例 id 是 feishu 时用旧键（feishuEnabled / feishuCli / feishuAllowed）', () => {
    const feishu = { ...installed, id: 'feishu', kind: 'feishu' }
    const { section, runtime } = harness()
    ;(runtime.sources as { instances: () => unknown[] }).instances = () => [feishu]
    const keys = section.fields().map(field => 'key' in field ? field.key : '')
    expect(keys).toContain('feishuEnabled')
    expect(keys).toContain('feishuAllowed')
    const values = section.values() as Record<string, unknown>
    expect(values.feishuEnabled).toBe(true)
  })

  test('values：执行块与来源配置的当前值；部署没过时事实给空串', () => {
    const { section } = harness()
    const values = section.values() as Record<string, unknown>
    expect(values).toMatchObject({
      maxWorkers: 3,
      prepareCommand: 'pnpm install',
      evalMode: 'auto',
      evalTimeoutSeconds: 600,
      assessorModel: '',
      workerModel: 'deepseek/chat',
      workerBlockedCommands: 'npm, docker',
      githubRepository: 'acme/widgets',
      'github.observe': true,
      'github.interval': 10,
      'github.pulls': 'all',
    })
    expect(values['githubAllowed']).toEqual([{ id: 'alice' }])
    expect(values['github.account']).toBe('agent-bot')
    expect(values['github.deployment.repository']).toBe('仓库')

    const unconfigured = harness({ configured: false })
    const empty = unconfigured.section.values() as Record<string, unknown>
    expect(empty['github.account']).toBe('')
  })

  test('save：执行块的数字钳制、文本长度、命令去重、角色模型格式与模式校验', async () => {
    const { section, saved } = harness()
    expect(typeof await section.save!('maxWorkers', 'abc')).toBe('string')
    await section.save!('maxWorkers', 999)
    expect(saved.at(-1)).toMatchObject({ block: 'executor', value: { maxWorkers: 16 }, revision: 2, origin: 'panel' })
    await section.save!('maxWorkers', 0)
    expect(saved.at(-1)!.value).toMatchObject({ maxWorkers: 1 })

    expect(typeof await section.save!('prepareCommand', 'x'.repeat(10_000))).toBe('string')
    await section.save!('prepareCommand', '  pnpm install  ')
    expect(saved.at(-1)!.value).toMatchObject({ prepare: 'pnpm install' })

    await section.save!('workerBlockedCommands', ' npm, docker ,, npm ')
    expect(saved.at(-1)!.value).toMatchObject({ blockedCommands: ['npm', 'docker'] })

    expect(await section.save!('workerModel', 'no-slash')).toBe('Write provider/model, for example deepseek/deepseek-chat')
    expect(await section.save!('workerModel', '/model')).toBe('Write provider/model, for example deepseek/deepseek-chat')
    expect(await section.save!('workerModel', 'provider/')).toBe('Write provider/model, for example deepseek/deepseek-chat')
    await section.save!('workerModel', 'openai/gpt')
    expect(saved.at(-1)!.value).toMatchObject({ model: { provider: 'openai', model: 'gpt' } })
    await section.save!('workerModel', '')
    expect(saved.at(-1)!.value).toMatchObject({ model: null })

    expect(typeof await section.save!('evalMode', 'maybe')).toBe('string')
    await section.save!('evalMode', 'off')
    expect(saved.at(-1)).toMatchObject({ block: 'eval', value: { mode: 'off' } })
    expect(typeof await section.save!('evalTimeoutSeconds', 'soon')).toBe('string')
    await section.save!('evalTimeoutSeconds', 99_999)
    expect(saved.at(-1)!.value).toMatchObject({ timeoutSeconds: 600 })
    expect(typeof await section.save!('unknown-key', 'x')).toBe('string')
  })

  test('save：来源开关 / 配置字段 / 策略字段写的是对应块，保存失败把原因当字符串返回', async () => {
    const { section, saved } = harness()
    await section.save!('github.enabled', false)
    expect(saved.at(-1)).toMatchObject({ block: 'source:github', value: { enabled: false } })

    await section.save!('githubRepository', '  new/repo  ')
    expect(saved.at(-1)).toMatchObject({ block: 'source:github', value: { config: expect.objectContaining({ repository: 'new/repo' }) } })

    await section.save!('github.observe', true)
    expect(saved.at(-1)!.value).toMatchObject({ config: expect.objectContaining({ observe: true }) })
    await section.save!('github.interval', '15')
    expect(saved.at(-1)!.value).toMatchObject({ config: expect.objectContaining({ interval: 15 }) })
    await section.save!('github.pulls', 'all')
    expect(saved.at(-1)!.value).toMatchObject({ config: expect.objectContaining({ pulls: 'all' }) })

    await section.save!('githubAllowed', [{ id: 'bob' }, { id: '' }])
    expect(saved.at(-1)).toMatchObject({
      block: 'policy',
      value: { sources: { github: { allowed: [{ id: 'bob' }] } } },
    })

    // 行表回写：空行丢弃、可选空文本不落键、下拉空着取第一个选项。
    await section.save!('github.labels', [{ name: '', mode: '' }, { name: 'ok', mode: '' }])
    expect(saved.at(-1)!.value).toMatchObject({ config: { labels: [{ name: 'ok', mode: 'a' }] } })

    const failing = harness({ saveThrows: Object.assign(new Error('zod'), { issues: [{ message: '仓库名不合法' }] }) })
    expect(await failing.section.save!('githubRepository', 'bad')).toBe('仓库名不合法')
    expect(await failing.section.save!('maxWorkers', 2)).toBe('仓库名不合法')
  })

  test('facts 为空或 kind 未注册也不炸：跳过该来源', () => {
    const { runtime } = harness()
    const missingKind = { ...kind, facts: () => undefined }
    const noFacts = harness({ kindOverride: missingKind })
    expect(noFacts.section.fields().some(field => 'key' in field && field.key === 'github.deployment.repository')).toBe(false)
    // kind 查不到时整块来源跳过去。
    const unknown = harness()
    ;(runtime.sources as { kind: () => unknown }).kind = () => undefined
    ;(unknown.runtime.sources as { kind: () => unknown }).kind = () => undefined
    expect(unknown.section.fields().every(field => !('key' in field) || !String(field.key).startsWith('github'))).toBe(true)
  })

  test('saveSettingOf：没有保存入口 / 返回字符串 / 抛错 三种结局', async () => {
    const none: SettingsSectionSpec = { id: 'x', title: 'x', subtitle: '', order: 1, fields: () => [], values: () => ({}) }
    expect(await saveSettingOf(none, 'k', 1)).toBe('这个设置分区没有保存入口')
    const returning: SettingsSectionSpec = { ...none, save: async () => '被拒了' }
    expect(await saveSettingOf(returning, 'k', 1)).toBe('被拒了')
    const throwing: SettingsSectionSpec = { ...none, save: async () => { throw new Error('炸了') } }
    expect(await saveSettingOf(throwing, 'k', 1)).toBe('炸了')
    const ok: SettingsSectionSpec = { ...none, save: async () => undefined }
    expect(await saveSettingOf(ok, 'k', 1)).toBeUndefined()
  })

  test('settingsViewOf：跳过 info / button / fact，类型翻译与可选值说明进 help', () => {
    const section = {
      values: () => ({ a: 1, b: true, c: [{ id: 'x' }], d: 'text', e: 'sel' }),
      fields: () => [
        { key: 'a', label: 'A', type: 'number' },
        { key: 'b', label: 'B', type: 'switch', help: '开关说明' },
        { key: 'c', label: 'C', type: 'rows' },
        { key: 'd', label: 'D', type: 'text' },
        { key: 'e', label: 'E', type: 'select', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }], help: '选择说明' },
        { key: 'f', label: 'F', type: 'fact' },
        { type: 'info', text: '不是设置项' },
      ],
    } as never
    expect(settingsViewOf(section)).toEqual([
      { key: 'a', label: 'A', type: 'number', value: 1 },
      { key: 'b', label: 'B', type: 'boolean', value: true, help: '开关说明' },
      { key: 'c', label: 'C', type: 'list', value: [{ id: 'x' }] },
      { key: 'd', label: 'D', type: 'text', value: 'text' },
      { key: 'e', label: 'E', type: 'text', value: 'sel', help: '选择说明；可选值：x / y' },
    ])
  })
})
