/**
 * superagent 插件装配面（`packages/superagent/index.ts`）：设置分区、`/sa` 命令、
 * 快照面、`superagent` 服务、两项体检与来源前置条件。
 *
 * 用假 ctx 跑真 `apply`：设置分区直接读/存、命令直接执行、服务直接调。
 * 存储层是真的（`node:sqlite` + 临时 `DSC_HOME`），所以「保存 → 读回 → 重启后还在」
 * 这条硬验收验的是同一条落盘路径，不是另造一份假库。
 *
 * `DSC_HOME` 在任何 import 之前指进临时目录：`plugin-registry` 的 `plugins.json`
 * 路径在模块求值时算定；superagent 自己的库路径每条调用现读环境变量，所以后两条
 * 失败用例能在同一文件里把它换到一个「父路径是文件」的目录。
 *
 * @module dsc/packages/superagent/tests/wiring.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-superagent-wiring-'))
process.env['DSC_HOME'] = HOME

/**
 * 每条用例一个独立的 `DSC_HOME`：编排库是同一路径下的 sqlite，多个用例共用一个目录
 * 会让上一张工单漏进下一张快照。`plugins.json` 的路径在模块求值时已经钉在 {@link HOME}，
 * 所以这里的切换只影响 superagent 自己的库/锁/会话目录。
 */
let CASE_HOME = HOME

type SuperagentIndex = typeof import('../index.js')
let index: SuperagentIndex
let warn: ReturnType<typeof vi.spyOn>

/** 一份假 ctx 捕获到的东西。 */
interface Harness {
  sections: Array<Record<string, unknown> & {
    values(): Record<string, unknown>
    save(key: string, value: unknown): string | void
  }>
  commands: Array<{
    spec: { name: string }
    run(invocation: { args: string[]; ui: { notice(text: string): void } }): unknown
  }>
  surfaces: Map<string, () => unknown>
  services: Map<string, unknown>
  events: string[]
  notices: string[]
  checks: Array<{ id: string; order?: number; run(): Promise<{ status: string; summary: string; detail?: string }> }>
  disposers: Array<() => void>
}

/** 所有活跃 harness 的收尾函数：afterEach 统一调，避免定时器/库句柄漏进下一条。 */
const cleanups: Array<() => void> = []

beforeAll(async () => {
  index = await import('../index.js')
}, 60_000)

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup()
    } catch {
      // 已经收过了
    }
  }
  warn.mockRestore()
  process.env['DSC_HOME'] = HOME
  if (CASE_HOME !== HOME) {
    try {
      rmSync(CASE_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // sqlite 的 -wal/-shm 偶尔还占着：临时目录留给系统清。
    }
  }
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 偶尔还占着 sqlite 的 -wal/-shm：临时目录留给系统清。
  }
})

beforeEach(() => {
  CASE_HOME = mkdtempSync(join(tmpdir(), 'dsc-superagent-case-'))
  process.env['DSC_HOME'] = CASE_HOME
  mkdirSync(HOME, { recursive: true })
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

/** 假 health 服务：只收登记项，run 不在这里实现（doctor 的活）。 */
function fakeHealth(): { service: unknown; checks: Harness['checks'] } {
  const checks: Harness['checks'] = []
  const service = {
    checks,
    register(check: Harness['checks'][number]) {
      checks.push(check)
      return () => {}
    },
    async run() {
      return { at: 0, entries: [], ok: 0, warn: 0, fail: 0, skip: 0 }
    },
  }
  return { service, checks }
}

/** 假 ctx：`effect` 真执行回调并把 disposer 收起来；服务表可预置 health/presets。 */
function runApply(
  passed?: unknown,
  options: { health?: unknown; presets?: unknown } = {},
): Harness {
  const sections: Harness['sections'] = []
  const commands: Harness['commands'] = []
  const surfaces = new Map<string, () => unknown>()
  const services = new Map<string, unknown>()
  const events: string[] = []
  const notices: string[] = []
  const checks = (options.health as { checks?: Harness['checks'] } | undefined)?.checks ?? []
  const disposers: Harness['disposers'] = []
  if (options.health !== undefined) services.set('health', options.health)
  if (options.presets !== undefined) services.set('permissionPresets', options.presets)

  const ctx = {
    effect(fn: () => unknown) {
      const off = fn()
      if (typeof off === 'function') disposers.push(off as () => void)
      return () => {}
    },
    get(name: string) {
      return services.get(name)
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    emit(event: string) {
      events.push(event)
    },
    settings: {
      registerSection(section: Harness['sections'][number]) {
        sections.push(section)
        return () => {}
      },
    },
    commands: {
      register(spec: Harness['commands'][number]['spec'], run: Harness['commands'][number]['run']) {
        commands.push({ spec, run })
        return () => {}
      },
    },
    surfaces: {
      register(name: string, read: () => unknown) {
        surfaces.set(name, read)
        return () => {}
      },
    },
    transcript: {
      system(text: string) {
        notices.push(text)
      },
    },
  }
  index.apply(ctx as never, passed)
  const harness: Harness = { sections, commands, surfaces, services, events, notices, checks, disposers }
  cleanups.push(() => {
    for (const off of disposers.splice(0).reverse()) off()
  })
  return harness
}

/** 取服务（每条用例都要用）。 */
function serviceOf(harness: Harness): {
  surface(): Record<string, unknown>
  publish(input: { title: string; body?: string; base?: string }): Promise<string>
  stop(id: string): Promise<void>
  retry(id: string): Promise<void>
  clean(id: string): Promise<void>
  peekSession(id: string): Promise<unknown>
  tick(): void
} {
  return harness.services.get('superagent') as never
}

/** 读 plugins.json 里 superagent 那一条的 config。 */
function savedConfig(): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(join(HOME, 'plugins.json'), 'utf8')) as {
    entries?: Array<{ file?: string; config?: Record<string, unknown> }>
  }
  return doc.entries?.find((entry) => entry.file === 'superagent')?.config ?? {}
}

/** 跑一次 `/sa`，返回它输出的一句话。 */
function runSa(harness: Harness, args: string[]): string {
  const command = harness.commands.find((item) => item.spec.name === 'sa')
  expect(command, '/sa 命令应当注册').toBeDefined()
  const said: string[] = []
  command!.run({ args, ui: { notice: (text: string) => said.push(text) } })
  return said.join('\n')
}

describe('装配注册面', () => {
  test('分区、服务、快照面、命令与两项体检都挂上了', () => {
    const health = fakeHealth()
    const harness = runApply({}, { health: health.service })

    expect(harness.sections.map((section) => section.id)).toEqual(['superagent'])
    expect(harness.sections[0]).toMatchObject({ id: 'superagent', order: 39 })
    expect(harness.services.get('superagent')).toBeDefined()
    expect(typeof serviceOf(harness).surface).toBe('function')
    expect(harness.surfaces.has('superagent')).toBe(true)
    expect(harness.commands.map((command) => command.spec.name)).toEqual(['sa'])
    expect(harness.checks.map((check) => check.id)).toEqual([
      'superagent/orchestrator',
      'superagent/feishu',
    ])
    expect(harness.checks.map((check) => check.order)).toEqual([100, 101])
  })

  test('设置分区有十二个字段，并发与超时的边界写在声明里', () => {
    const harness = runApply()
    const section = harness.sections[0]!
    const fields = (section.fields as () => Array<Record<string, unknown>>)()
    expect(fields.map((field) => field.key)).toEqual([
      'repoPath',
      'maxWorkers',
      'ticketTimeoutSeconds',
      'githubRepository',
      'githubLogin',
      'githubAllowed',
      'githubTokenEnv',
      'feishuEnabled',
      'feishuCli',
      'feishuChats',
      'feishuDirect',
      'assessorModel',
    ])
    const byKey = Object.fromEntries(fields.map((field) => [field.key, field]))
    expect(byKey['maxWorkers']).toMatchObject({ type: 'number', min: 1, max: 16, step: 1 })
    expect(byKey['ticketTimeoutSeconds']).toMatchObject({ type: 'number', min: 0, max: 86_400, step: 60 })
    expect(byKey['repoPath']).toMatchObject({ type: 'text', mono: true })
    expect(byKey['feishuEnabled']).toMatchObject({ type: 'switch' })
    expect(byKey['feishuDirect']).toMatchObject({ type: 'switch' })
  })
})

describe('配置读取', () => {
  test('缺省值与越界夹取：并发 1–16、超时 0 起、非法数字回落缺省', () => {
    const defaults = index.readSuperagentConfig()
    expect(defaults).toMatchObject({
      repoPath: '',
      maxWorkers: 2,
      ticketTimeoutSeconds: 1800,
      githubRepository: '',
      githubLogin: '',
      githubAllowed: [],
      githubTokenEnv: 'GITHUB_TOKEN',
      feishuEnabled: false,
      feishuCli: '',
      feishuChats: [],
      feishuDirect: false,
      assessorModel: '',
    })

    expect(index.readSuperagentConfig({ maxWorkers: 99 }).maxWorkers).toBe(16)
    expect(index.readSuperagentConfig({ maxWorkers: 0 }).maxWorkers).toBe(1)
    expect(index.readSuperagentConfig({ maxWorkers: '7' }).maxWorkers).toBe(7)
    expect(index.readSuperagentConfig({ ticketTimeoutSeconds: -10 }).ticketTimeoutSeconds).toBe(0)
    expect(index.readSuperagentConfig({ ticketTimeoutSeconds: 10 ** 9 }).ticketTimeoutSeconds).toBe(86_400)
    expect(index.readSuperagentConfig({ maxWorkers: 'abc', ticketTimeoutSeconds: {} })).toMatchObject({
      maxWorkers: 2,
      ticketTimeoutSeconds: 1800,
    })
    expect(index.readSuperagentConfig({ repoPath: '  C:/repo  ' }).repoPath).toBe('C:/repo')
  })

  test('名单按逗号拆开去重；开关只认布尔 true，字符串 "true" 不算打开', () => {
    const config = index.readSuperagentConfig({
      githubAllowed: ' alice, bob , alice, , ',
      githubTokenEnv: '  GH_TOKEN  ',
      feishuEnabled: 'true',
      feishuCli: ' C:/bin/lark-cli ',
      feishuChats: ' oc_1, oc_2, oc_1 ',
      feishuDirect: true,
      assessorModel: ' vendor/model ',
    })
    expect(config.githubAllowed).toEqual(['alice', 'bob'])
    expect(config.githubTokenEnv).toBe('GH_TOKEN')
    expect(config.feishuEnabled).toBe(false)
    expect(config.feishuCli).toBe('C:/bin/lark-cli')
    expect(config.feishuChats).toEqual(['oc_1', 'oc_2'])
    expect(config.feishuDirect).toBe(true)
    expect(config.assessorModel).toBe('vendor/model')
  })

  test('assessorTargetOf 按最后一个 / 拆；空段与格式不对都当「不调模型」', () => {
    const target = (model: string): unknown =>
      index.assessorTargetOf(index.readSuperagentConfig({ assessorModel: model }))
    expect(target('')).toBeNull()
    expect(target('  ')).toBeNull()
    expect(target('deepseek')).toBeNull()
    expect(target('deepseek/')).toBeNull()
    expect(target('/chat')).toBeNull()
    expect(target('deepseek/chat')).toEqual({ provider: 'deepseek', model: 'chat' })
    expect(target(' a/b ')).toEqual({ provider: 'a', model: 'b' })
    expect(target('vendor/deepseek/chat')).toEqual({ provider: 'vendor/deepseek', model: 'chat' })
  })

  test('values 现读 plugins.json，名单以一行逗号文本回到设置面', () => {
    writeFileSync(
      join(HOME, 'plugins.json'),
      JSON.stringify({
        version: 1,
        entries: [{
          file: 'superagent',
          disabled: false,
          config: {
            repoPath: 'D:/repo',
            maxWorkers: '10',
            ticketTimeoutSeconds: 120,
            githubAllowed: 'alice, bob',
            feishuEnabled: true,
            feishuChats: 'oc_a, oc_b',
          },
        }],
      }),
      'utf8',
    )
    const harness = runApply()
    expect(harness.sections[0]!.values()).toMatchObject({
      repoPath: 'D:/repo',
      maxWorkers: 10,
      ticketTimeoutSeconds: 120,
      githubAllowed: 'alice, bob',
      feishuEnabled: true,
      feishuChats: 'oc_a, oc_b',
    })
  })
})

describe('设置分区写入', () => {
  test('非法值：数字字段与仓库格式各自给一句能照着改的话，未知键点名', () => {
    const section = runApply().sections[0]!
    expect(section.save('maxWorkers', 'abc')).toBe('并发上限要填数字（1–16）')
    expect(section.save('ticketTimeoutSeconds', 'abc')).toBe('超时秒数要填数字（0 表示不限）')
    expect(section.save('githubRepository', 'not a repo')).toBe('仓库要写成 owner/name 的样子')
    expect(section.save('nope', 1)).toBe('未知设置项「nope」')
    // 失败不落盘。
    expect(savedConfig()).toEqual({})
  })

  test('合法值：数字夹取、名单去重、空串删键，保存后 values 立刻读回', () => {
    const section = runApply().sections[0]!
    section.save('maxWorkers', 99)
    section.save('ticketTimeoutSeconds', -5)
    section.save('repoPath', '  C:/repo  ')
    section.save('githubAllowed', ' alice, bob , alice')
    section.save('feishuChats', 'oc_1, oc_2, oc_1')
    section.save('feishuEnabled', true)
    section.save('feishuDirect', false)
    section.save('githubRepository', ' owner/name ')
    section.save('assessorModel', ' vendor/model ')

    expect(savedConfig()).toMatchObject({
      maxWorkers: 16,
      ticketTimeoutSeconds: 0,
      repoPath: 'C:/repo',
      githubAllowed: 'alice, bob',
      feishuChats: 'oc_1, oc_2',
      feishuEnabled: true,
      feishuDirect: false,
      githubRepository: 'owner/name',
      assessorModel: 'vendor/model',
    })
    expect(section.values()).toMatchObject({
      maxWorkers: 16,
      ticketTimeoutSeconds: 0,
      repoPath: 'C:/repo',
      githubAllowed: 'alice, bob',
      feishuChats: 'oc_1, oc_2',
    })

    // 空串 = 删掉这个键：回到缺省的空路径，而不是在文件里留一条空记录。
    section.save('repoPath', '')
    expect(savedConfig()).not.toHaveProperty('repoPath')
    expect(section.values()['repoPath']).toBe('')
  })
})

describe('/sa 命令与空态文案', () => {
  test('参数错误各自说清用法；空列表、建单、按前缀停单都给你一句话', () => {
    const harness = runApply()

    expect(runSa(harness, [])).toContain('格式：/sa new')
    expect(runSa(harness, ['list', 'extra'])).toContain('/sa list 不接受参数')
    expect(runSa(harness, ['stop'])).toContain('后面要跟一个工单 id')
    expect(runSa(harness, ['stop', 'a', 'b'])).toContain('只接一个工单 id')
    expect(runSa(harness, ['dance'])).toContain('格式：/sa new')
    expect(runSa(harness, ['list'])).toContain('还没有工单')

    expect(runSa(harness, ['new', '修复 登录 页', '|', '中文提示'])).toContain('工单已建')
    const listed = runSa(harness, ['list'])
    expect(listed).toContain('ID / 状态 / 标题')
    expect(listed).toContain('修复 登录 页')

    const shortId = listed.split('\n')[1]!.split(/\s+/)[0]!
    expect(runSa(harness, ['stop', shortId])).toContain('工单已停止')
    expect(runSa(harness, ['list'])).toContain('已结束')
    expect(runSa(harness, ['stop', 'zzzzzzzz'])).toContain('没有这张工单')
  })
})

describe('服务与快照', () => {
  test('空快照 ready；发布 / 停止 / 查询走同一条落库路径并推 dsc/changed', async () => {
    const harness = runApply()
    const service = serviceOf(harness)

    expect(service.surface()).toMatchObject({
      ready: true,
      counts: { needsYou: 0, running: 0, done: 0 },
      tickets: [],
    })

    await expect(service.publish({ title: '   ' })).rejects.toThrow('标题不能为空')
    const id = await service.publish({ title: '修复登录', body: '中文提示' })
    expect(typeof id).toBe('string')
    expect(harness.events).toContain('dsc/changed')

    const snapshot = service.surface()
    expect((snapshot['tickets'] as Array<{ title: string }>).map((ticket) => ticket.title)).toContain('修复登录')
    const counts = snapshot['counts'] as { needsYou: number; running: number; done: number }
    expect(counts.needsYou + counts.running + counts.done).toBe(1)

    // 只读读执行会话：这张单还没真派过工，给一句可操作的话而不是空数组。
    await expect(service.peekSession(id)).rejects.toThrow('这张工单还没有执行会话')
    expect(() => service.tick()).not.toThrow()

    await service.stop(id)
    expect((service.surface()['counts'] as { done: number }).done).toBe(1)
    await expect(service.stop('no-such-ticket')).rejects.toThrow()
    await expect(service.retry(id)).rejects.toThrow()
    await expect(service.clean(id)).rejects.toThrow('没有配置仓库路径')
  })
})

describe('失败与前置条件', () => {
  test('编排库打不开：快照给 store_unavailable，命令说未启动，十秒内不重试', () => {
    // 让 `<DSC_HOME>/superagent` 是一个文件：mkdirSync(dirname(db)) 必然失败。
    const blocked = join(HOME, 'blocked-home')
    mkdirSync(blocked, { recursive: true })
    writeFileSync(join(blocked, 'superagent'), 'not a directory', 'utf8')
    process.env['DSC_HOME'] = blocked
    try {
      const harness = runApply()
      const service = serviceOf(harness)
      const snapshot = service.surface()
      expect(snapshot['ready']).toBe(false)
      expect(snapshot['problem']).toMatchObject({ code: 'store_unavailable' })
      expect(String((snapshot['problem'] as { detail: string }).detail)).toContain('编排库没打开')

      // retryAt 闸：第二次拉快照不再重试 open，结论不变。
      expect(service.surface()).toMatchObject({ ready: false })
      expect(runSa(harness, ['list'])).toContain('Super Agent 未启动（连库失败）')
      expect(warn.mock.calls.flat().join('\n')).toContain('未启动：编排库没打开')
    } finally {
      process.env['DSC_HOME'] = CASE_HOME
    }
  })

  test('来源前置条件不满足只记日志：GitHub 缺令牌、飞书默认关 / 没填群', () => {
    delete process.env['DSC_WIRING_MISSING_TOKEN']
    const harness = runApply({
      githubRepository: 'owner/name',
      githubLogin: 'bot',
      githubAllowed: 'alice',
      githubTokenEnv: 'DSC_WIRING_MISSING_TOKEN',
    })
    serviceOf(harness).surface()
    const text = warn.mock.calls.flat().join('\n')
    expect(text).toContain('GitHub 来源没启动：环境变量 DSC_WIRING_MISSING_TOKEN 里没有令牌')
    expect(text).toContain('飞书来源没启动：设置里没打开')
    expect(text).not.toContain('GitHub 来源已启动')

    const enabled = runApply({ feishuEnabled: true, feishuChats: '' })
    serviceOf(enabled).surface()
    expect(warn.mock.calls.flat().join('\n')).toContain('飞书来源没启动：没填群 chat_id')
  })

  test('两项体检：启动前都 skip；库打开后编排项给 ok 并列出锁与 running 读数', async () => {
    const health = fakeHealth()
    const harness = runApply({}, { health: health.service })
    const [orchestrator, feishu] = harness.checks

    const before = await orchestrator!.run()
    expect(before.status).toBe('skip')
    expect(before.summary).toContain('还没启动')
    expect((await feishu!.run()).status).toBe('skip')

    serviceOf(harness).surface()
    const after = await orchestrator!.run()
    expect(after.status).toBe('ok')
    expect(after.detail).toContain('写：可写')
    expect(after.detail).toContain('running 工单：没有')
    expect((await feishu!.run()).status).toBe('skip')
  })
})
