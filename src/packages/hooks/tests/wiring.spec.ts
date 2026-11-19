/**
 * hooks 插件装配面（`packages/hooks/index.ts`）：规则/脚本守卫、审批兜底、观察者、
 * 提示词投影、命令、设置分区与 hooks 服务。
 *
 * 用假 ctx 跑真 `apply`：守卫直接调、设置分区直接读/存/动作、命令直接执行。
 * 规则与脚本引擎本身在 `session-core/tests/hooks.spec.ts` 里测过，这里钉的是
 * 「插件把钩子挂到链上的哪一档、结论怎么落到审计与审批、界面那一页能改什么」。
 * `DSC_HOME` 在任何 import 之前指进临时目录（配置路径在模块求值时算定）。
 *
 * @module dsc/packages/hooks/tests/wiring.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-hooks-wiring-'))
process.env['DSC_HOME'] = HOME

/**
 * 假会话目录：钩子脚本以它当 `cwd` 被 spawn，所以必须真实存在。
 *
 * 原来写死的 `C:/repo` 在 Linux 上不存在，`/bin/sh` 直接 ENOENT（表现为「钩子脚本没能启动」）；
 * 在 Windows CI 上 `C:\repo` 也不存在，同样会红。用临时目录才是两边都成立的前提。
 */
const REPO = join(HOME, 'repo')
mkdirSync(REPO, { recursive: true })

let hooksPlugin: typeof import('../index.js').hooksPlugin
let readHooks: typeof import('../../session-core/hooks.js').readHooks

beforeAll(async () => {
  readHooks = (await import('../../session-core/hooks.js')).readHooks
  hooksPlugin = (await import('../index.js')).hooksPlugin
})

afterAll(() => {
  delete process.env['DSC_HOME']
})

beforeEach(() => {
  writeFileSync(join(HOME, 'hooks.json'), JSON.stringify({ version: 1, settings: {}, rules: [], scripts: [] }), 'utf8')
  rmSync(join(HOME, 'hooks-trusted.json'), { force: true })
  rmSync(join(HOME, 'audit.jsonl'), { force: true })
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

/** 写一份钩子配置（规则/脚本/设置都从这里走真读盘）。 */
function writeHooks(doc: { rules?: unknown[]; scripts?: unknown[]; settings?: Record<string, unknown> }): void {
  writeFileSync(
    join(HOME, 'hooks.json'),
    JSON.stringify({ version: 1, settings: doc.settings ?? {}, rules: doc.rules ?? [], scripts: doc.scripts ?? [] }),
    'utf8',
  )
}

/** 造一条守卫入参。 */
function input(overrides: Record<string, unknown> = {}): never {
  return {
    toolName: 'bash',
    risk: 'exec',
    cwd: REPO,
    args: { command: 'rm -rf build' },
    command: 'rm -rf build',
    target: '',
    signal: new AbortController().signal,
    sessionId: 'sess-1',
    sessionPath: join(REPO, '.dsc', 'sessions', 'a.jsonl'),
    ...overrides,
  } as never
}

/** 假 ctx：记录挂载点，审批与命令可注入。 */
function fakeCtx(options: { decision?: 'allow-once' | 'allow-session' | 'allow-always' | 'reject' } = {}) {
  const guards: Array<{ id: string; order: number; decide: (value: unknown) => Promise<unknown> }> = []
  const observers: Array<{ id: string; order: number; observe: (tool: string, text: string) => string }> = []
  const commands: Array<{ spec: { name: string }; run: (args: unknown) => unknown }> = []
  const projections: Array<{ id: string; fn: (messages: unknown[]) => unknown }> = []
  const sections: Array<Record<string, unknown>> = []
  const decisions: Array<{ request: unknown; forceAskReason?: string }> = []
  const notices: string[] = []
  const events: string[] = []
  const emitted: string[] = []
  const services = new Map<string, unknown>()
  let section: Record<string, unknown> | null = null
  const ctx = {
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    guards: {
      register(guard: { id: string; order: number }) {
        guards.push(guard as never)
        return () => undefined
      },
      registerObserver(observer: { id: string; order: number }) {
        observers.push(observer as never)
        return () => undefined
      },
    },
    approval: {
      policy: 'auto-edit',
      decide: async (request: unknown, _signal: unknown, extra?: { forceAskReason?: string }) => {
        decisions.push({ request, forceAskReason: extra?.forceAskReason })
        return options.decision ?? 'allow-once'
      },
    },
    session: {
      current: () => ({
        meta: { id: 'sess-1', cwd: REPO },
        filePath: join(REPO, '.dsc', 'sessions', 'a.jsonl'),
      }),
    },
    llm: { model: 'dsc-model' },
    transcript: { system: (text: string) => notices.push(text) },
    commands: {
      register(spec: { name: string }, run: (args: unknown) => unknown) {
        commands.push({ spec, run })
        return () => undefined
      },
    },
    prompt: {
      registerProjection(id: string, fn: (messages: unknown[]) => unknown) {
        projections.push({ id, fn })
        return () => undefined
      },
    },
    settings: {
      registerSection(value: Record<string, unknown>) {
        section = value
        sections.push(value)
        return () => undefined
      },
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    get(name: string) {
      return services.get(name)
    },
    emit(event: string, text?: string) {
      events.push(event)
      if (text !== undefined) emitted.push(text)
    },
    logger: { debug: () => undefined },
    on(event: string, _handler: unknown) {
      events.push(`on:${event}`)
      return () => undefined
    },
  }
  hooksPlugin.apply?.(ctx as never, {})
  return { ctx, guards, observers, commands, projections, sections, decisions, notices, emitted, events, services, section: section as never }
}

/** 等审计文件里出现满足条件的行（脚本是异步收尾的）。 */
async function auditLines(): Promise<Array<Record<string, unknown>>> {
  const file = join(HOME, 'audit.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const REMOVE_RULE = {
  id: 'r1',
  enabled: true,
  tool: 'bash',
  field: 'command',
  pattern: 'rm -rf',
  action: 'deny',
  reason: '这条命令会删构建产物，先问我',
}

describe('守卫链上的规则', () => {
  test('挂了安全钩子与外部钩子两档（order 20/25），并注册两个观察者（40/45）', () => {
    const harness = fakeCtx()
    expect(harness.guards.map((guard) => `${guard.id}@${String(guard.order)}`)).toEqual(['hooks@20', 'lifecycle-hooks@25'])
    expect(harness.observers.map((observer) => `${observer.id}@${String(observer.order)}`)).toEqual([
      'hooks@40',
      'lifecycle-hooks@45',
    ])
    expect(harness.services.get('hooks')).toBeDefined()
  })

  test('命中 deny 规则：返回 deny 并把用户理由交给模型；审计记一笔', async () => {
    writeHooks({ rules: [REMOVE_RULE] })
    const harness = fakeCtx()
    const guard = harness.guards[0]!
    const verdict = (await guard.decide(input())) as { action: string; reason: string }
    expect(verdict.action).toBe('deny')
    expect(verdict.reason).toContain('这条命令会删构建产物')
    const lines = await auditLines()
    expect(lines.some((line) => line.kind === 'hook' && line.decision === 'blocked')).toBe(true)
  })

  test('没命中 / 总开关关着：都不表态（defer）', async () => {
    writeHooks({ rules: [{ ...REMOVE_RULE, pattern: 'git push --force' }] })
    const pass = fakeCtx()
    expect(await pass.guards[0]!.decide(input())).toEqual({ action: 'defer' })

    writeHooks({ rules: [REMOVE_RULE], settings: { enabled: false } })
    const disabled = fakeCtx()
    expect(await disabled.guards[0]!.decide(input())).toEqual({ action: 'defer' })
  })

  test('ask 规则：叫审批卡（带 forceAskReason）；人批了放行，人否了拒绝', async () => {
    writeHooks({ rules: [{ ...REMOVE_RULE, action: 'ask', reason: '' }] })
    const allowed = fakeCtx({ decision: 'allow-once' })
    expect(await allowed.guards[0]!.decide(input())).toMatchObject({ action: 'pass' })
    expect(allowed.decisions[0]?.forceAskReason).toContain('用户登记的规则要求这次必须有人确认')
    expect(allowed.decisions[0]?.request).toMatchObject({ toolName: 'bash', sessionId: 'sess-1' })

    const rejected = fakeCtx({ decision: 'reject' })
    expect(await rejected.guards[0]!.decide(input())).toMatchObject({ action: 'deny' })
    expect((await auditLines()).some((line) => line.decision === 'reject')).toBe(true)
  })
})

describe('脚本守卫与观察者', () => {
  test('脚本以 2 退出：按拦处理并把 stderr 首行交给模型', async () => {
    const guard = join(HOME, 'guard.mjs')
    writeFileSync(guard, 'process.stderr.write("脚本说不行\\n");process.exit(2)', 'utf8')
    writeHooks({
      settings: { autoAccept: true },
      scripts: [{ event: 'pre-tool', matcher: 'bash', command: `node ${guard}`, failClosed: true }],
    })
    const harness = fakeCtx()
    const verdict = (await harness.guards[0]!.decide(input())) as { action: string; reason: string }
    expect(verdict.action).toBe('deny')
    expect(verdict.reason).toContain('脚本说不行')
  })

  test('观察者原样返回结果；post-tool 脚本的留言进审计与通知', async () => {
    const script = join(HOME, 'after.mjs')
    writeFileSync(script, 'process.stdout.write(JSON.stringify({action:"note",message:"干完了"}))', 'utf8')
    writeHooks({
      settings: { autoAccept: true },
      scripts: [{ event: 'post-tool', matcher: 'bash', command: `node ${script}` }],
    })
    const harness = fakeCtx()
    expect(harness.observers[0]!.observe('bash', '结果文本')).toBe('结果文本')

    // 脚本是异步跑完的：等审计里出现这条 post-tool 记录。
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const lines = await auditLines()
      if (lines.some((line) => line.kind === 'hook' && line.tool === 'bash')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect((await auditLines()).length).toBeGreaterThan(0)
  })
})

describe('设置分区', () => {
  test('values 读当前配置；save 改开关键并把非法数字挡回来', () => {
    writeHooks({ settings: { scriptTimeoutMs: 5000 }, rules: [REMOVE_RULE] })
    const harness = fakeCtx()
    const section = harness.section as unknown as {
      values(): Record<string, unknown>
      save(key: string, value: unknown): string | void
    }
    expect(section.values()).toMatchObject({
      enabled: true,
      scriptFailClosed: true,
      scriptTimeoutMs: 5000,
      autoAccept: false,
      rulePattern: '',
    })

    expect(section.save('enabled', false)).toBeUndefined()
    expect(readHooks().settings.enabled).toBe(false)
    expect(section.save('scriptTimeoutMs', 'abc')).toContain('数字')
    expect(section.save('scriptTimeoutMs', 1200)).toBeUndefined()
    expect(readHooks().settings.scriptTimeoutMs).toBe(1200)
  })

  test('动作：加规则/停用/删除；加脚本/批准/撤销/删除', () => {
    const harness = fakeCtx()
    const section = harness.section as unknown as {
      save(key: string, value: unknown): string | void
      action(name: string): string | void
      values(): Record<string, unknown>
    }

    section.save('ruleTool', 'bash')
    section.save('rulePattern', 'git push --force')
    section.save('ruleAction', 'ask')
    section.save('ruleReason', '强推要先问')
    expect(section.action('ruleAdd')).toContain('规则')
    const added = readHooks().rules.find((rule) => rule.pattern === 'git push --force')
    expect(added).toMatchObject({ action: 'ask', reason: '强推要先问' })

    section.save('ruleId', added!.id)
    section.save('ruleEnabled', false)
    expect(readHooks().rules.find((rule) => rule.id === added!.id)?.enabled).toBe(false)
    expect(section.action('ruleDelete')).toContain('删')
    expect(readHooks().rules).toHaveLength(0)
    expect(section.action('ruleDelete')).toContain('规则表是空的')

    section.save('scriptEvent', 'turn-end')
    section.save('scriptMatcher', '')
    section.save('scriptCommand', 'echo done')
    expect(section.action('scriptAdd')).not.toContain('不能')
    const script = readHooks().scripts[0]!
    section.save('scriptId', script.id)
    expect(section.action('scriptTrust')).not.toContain('没有')
    expect(section.action('scriptUntrust')).not.toContain('没有')
    expect(section.action('scriptDelete')).not.toContain('没有')
    expect(readHooks().scripts).toHaveLength(0)

    expect(section.action('unknown')).toContain('unknown')
    expect(section.save('nope', 1)).toContain('nope')
  })
})

describe('命令、投影与服务', () => {
  test('/hooks 打印规则、脚本与外部钩子的现状', () => {
    writeHooks({
      rules: [REMOVE_RULE],
      scripts: [{ event: 'pre-tool', matcher: 'bash', command: 'echo hi' }],
    })
    const harness = fakeCtx()
    const command = harness.commands.find((item) => item.spec.name === 'hooks')!
    const said: string[] = []
    command.run({ ui: { notice: (text: string) => said.push(text) } })
    const text = said.join('\n')
    expect(text).toContain('规则 1 条')
    expect(text).toContain('脚本 1 条')
    expect(text).toContain('echo hi')
  })

  test('提示词投影：没有待补留言时原样返回；服务能查配置、预判规则并读审计', () => {
    writeHooks({ rules: [REMOVE_RULE] })
    const harness = fakeCtx()
    const projection = harness.projections.find((item) => item.id === 'user-prompt-submit')!
    const messages = [{ role: 'user', content: '你好' }]
    expect(projection.fn(messages)).toEqual(messages)

    const service = harness.services.get('hooks') as {
      doc(): { rules: unknown[] }
      trustOf(id: string): unknown
      previewRules(input: unknown): Array<{ action: string }>
      recent(limit?: number): unknown[]
    }
    expect(service.doc().rules).toHaveLength(1)
    expect(service.trustOf('missing')).toBeNull()
    expect(service.previewRules({ toolName: 'bash', command: 'rm -rf build' })[0]).toMatchObject({ action: 'block' })
    expect(Array.isArray(service.recent(5))).toBe(true)
  })
})
