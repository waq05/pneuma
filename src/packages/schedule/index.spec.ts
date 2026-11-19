/**
 * schedule 插件装配面（`src/packages/schedule/index.ts`）：工具、命令、提示词、设置分区、快照面。
 *
 * 用假 ctx 跑真 `apply`：工具 / 命令直接调，设置分区直接读字段与保存，提示词直接取返回值。
 * 规则算法与落盘已在 core/schedule 的 spec 里测过，这里只验「插件把自己的面挂对、话说明白」。
 * DSC_HOME 在任何 import 之前指进临时目录（store 的默认目录是模块求值时算定的）。
 *
 * @module dsc/packages/schedule/index.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-schedule-plugin-'))
process.env['DSC_HOME'] = HOME

let schedulePlugin: typeof import('./index.js').schedulePlugin
let storeModule: typeof import('../../core/schedule/store.js')

afterAll(() => {
  delete process.env['DSC_HOME']
})

beforeAll(async () => {
  storeModule = await import('../../core/schedule/store.js')
  schedulePlugin = (await import('./index.js')).schedulePlugin
})

beforeEach(() => {
  rmSync(join(HOME, 'schedule'), { recursive: true, force: true })
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

/** 读插件写下的任务（同一份默认目录）。 */
function tasks(): import('../../core/schedule/store.js').ScheduleTask[] {
  return new storeModule.ScheduleStore().load().tasks
}

/** 假 ctx：记录插件挂了什么，需要的地方给可控返回值。 */
function fakeCtx() {
  const tools: Array<Record<string, unknown>> = []
  const commands: Array<{ spec: Record<string, unknown>; run: (args: unknown) => unknown }> = []
  const prompts: Array<() => string> = []
  const projections: Array<{
    id: string
    apply: (
      messages: Array<{ role: string; content: string }>,
      session?: unknown,
      report?: (view: Record<string, unknown>) => void,
    ) => Array<{ role: string; content: string }>
    options?: Record<string, unknown>
  }> = []
  const notes: Array<{ id: string; text: string }> = []
  const surfaces = new Map<string, () => unknown>()
  const notices: string[] = []
  const followups: Array<{ text: string; target: string | undefined; kind: string }> = []
  const events: string[] = []
  const uiNotices: string[] = []
  let section: Record<string, unknown> | null = null
  const session = {
    meta: { id: 's1', cwd: HOME },
    messages: [] as Array<{ role: string; content: string }>,
    appendNote: (id: string, text: string) => {
      notes.push({ id, text })
    },
  }
  const ctx = {
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    tools: {
      register(spec: Record<string, unknown>) {
        tools.push(spec)
        return () => undefined
      },
    },
    commands: {
      register(spec: Record<string, unknown>, run: (args: unknown) => unknown) {
        commands.push({ spec, run })
        return () => undefined
      },
    },
    prompt: {
      register(_id: string, fn: () => string) {
        prompts.push(fn)
        return () => undefined
      },
      registerProjection(
        id: string,
        apply: (typeof projections)[number]['apply'],
        options?: Record<string, unknown>,
      ) {
        projections.push({ id, apply, ...(options === undefined ? {} : { options }) })
        return () => undefined
      },
    },
    surfaces: {
      register(id: string, fn: () => unknown) {
        surfaces.set(id, fn)
        return () => undefined
      },
    },
    settings: {
      registerSection(value: Record<string, unknown>) {
        section = value
        return () => undefined
      },
    },
    transcript: {
      getSnapshot: () => ({ entries: [] as Array<{ kind: string; text: string }> }),
      system(text: string) {
        notices.push(text)
      },
    },
    agent: {
      followup(text: string, _message: unknown, target: string | undefined, kind: string) {
        followups.push({ text, target, kind })
      },
    },
    waiting: { anyFor: () => false },
    session: { current: () => session },
    llm: { route: () => ({ baseUrl: 'https://api.test', apiKey: 'fake-key', model: 'test-model' }) },
    get: () => undefined,
    on(event: string) {
      events.push(event)
      return () => undefined
    },
  }
  return {
    ctx: ctx as never,
    tools,
    commands,
    prompts,
    projections,
    notes,
    session,
    surfaces,
    notices,
    followups,
    events,
    uiNotices,
    sectionOf: () => section as never,
    ui: {
      notice(text: string) {
        uiNotices.push(text)
      },
    },
  }
}

/** 跑一次 apply；返回可释放的句柄。 */
function mount(config: Record<string, unknown> = { enabled: true, timeZone: 'UTC' }) {
  const fake = fakeCtx()
  const dispose = schedulePlugin.apply(fake.ctx, config) as unknown as () => void
  return { ...fake, dispose }
}

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
})

describe('装配面', () => {
  test('挂上工具 / 命令 / 提示词 / 快照 / 设置分区 / 回合结束订阅', () => {
    const wired = mount()
    cleanup = wired.dispose
    expect(wired.tools.map((tool) => tool['name'])).toEqual(['schedule'])
    expect(wired.commands.map((item) => item.spec['name'])).toEqual(['schedule'])
    expect(wired.prompts).toHaveLength(1)
    // 2026-11 P0：任务清单/下次时刻走尾部投影（order 630），系统提示段只剩静态说明。
    expect(wired.projections.map((projection) => projection.id)).toEqual(['schedule'])
    expect(wired.projections[0]?.options).toMatchObject({ order: 630 })
    expect(wired.surfaces.has('scheduled')).toBe(true)
    expect(wired.sectionOf()).toMatchObject({ id: 'schedule', order: 32 })
    expect(wired.events).toContain('dsc/turn-end')
    expect(wired.notices).toEqual([])
  })

  test('任务文件坏了：启动时把问题说给用户，不静默丢', () => {
    mkdirSync(join(HOME, 'schedule'), { recursive: true })
    writeFileSync(join(HOME, 'schedule', 'tasks.json'), '{bad', 'utf8')
    const wired = mount()
    cleanup = wired.dispose
    expect(wired.notices.some((line) => line.includes('定时任务：'))).toBe(true)
  })
})

describe('工具 schedule', () => {
  /** 调工具的 run。 */
  function run(wired: ReturnType<typeof mount>, args: Record<string, unknown>): Promise<unknown> {
    const tool = wired.tools[0]!
    return (tool['run'] as (a: unknown) => Promise<unknown>)(args)
  }

  test('create：缺字段 / 坏时区 / 坏规则各抛一句；成功回报写清规则、时区与下次', async () => {
    const wired = mount()
    cleanup = wired.dispose
    await expect(run(wired, { action: 'create' })).rejects.toThrow(/title/)
    await expect(run(wired, { action: 'create', title: 'T' })).rejects.toThrow(/prompt/)
    await expect(run(wired, { action: 'create', title: 'T', prompt: 'P' })).rejects.toThrow(/rule/)
    await expect(run(wired, { action: 'create', title: 'T', prompt: 'P', rule: 'every:30m', timeZone: 'Bad/Zone' })).rejects.toThrow(/不认识/)
    await expect(run(wired, { action: 'create', title: 'T', prompt: 'P', rule: 'nope' })).rejects.toThrow()

    const text = String(await run(wired, { action: 'create', title: '喝水', prompt: '起来喝水', rule: 'every:30m' }))
    expect(text).toContain('已建好定时任务')
    expect(text).toContain('每 30 分钟')
    expect(text).toContain('时区：UTC')
    expect(text).toContain('下次')
    expect(tasks()[0]).toMatchObject({ title: '喝水', prompt: '起来喝水', createdBy: 'model', sessionId: 's1' })
  })

  test('总开关关着时创建：照建，但回报里提醒去打开', async () => {
    const wired = mount({ enabled: false, timeZone: 'UTC' })
    cleanup = wired.dispose
    const text = String(await run(wired, { action: 'create', title: 'T', prompt: 'P', rule: 'every:30m' }))
    expect(text).toContain('总开关现在是关的')
  })

  test('list：空清单给用法；有任务给条数与摘要', async () => {
    const wired = mount()
    cleanup = wired.dispose
    expect(String(await run(wired, { action: 'list' }))).toContain('现在没有定时任务')
    await run(wired, { action: 'create', title: '早报', prompt: '写早报', rule: 'daily:09:30' })
    const text = String(await run(wired, { action: 'list' }))
    expect(text).toContain('定时任务 1 条（1 条启用）')
    expect(text).toContain('早报')
    expect(text).toContain('宿主不常驻就不触发')
  })

  test('update：改标题/规则/时区/启停；坏时区与坏规则拒绝；不存在的 id 拒绝', async () => {
    const wired = mount()
    cleanup = wired.dispose
    const created = String(await run(wired, { action: 'create', title: '旧', prompt: 'P', rule: 'every:30m' }))
    const id = tasks()[0]!.id
    expect(created).toContain('旧')

    const updated = String(await run(wired, { action: 'update', id, title: '新', rule: 'daily:08:00', timeZone: 'Asia/Shanghai' }))
    expect(updated).toContain('已更新「新」')
    expect(updated).toContain('每天 08:00')
    expect(tasks()[0]).toMatchObject({ title: '新', timeZone: 'Asia/Shanghai' })

    await expect(run(wired, { action: 'update', id, timeZone: 'Nope/Zone' })).rejects.toThrow(/不认识/)
    await expect(run(wired, { action: 'update', id, rule: 'bogus' })).rejects.toThrow()
    await expect(run(wired, { action: 'update', id: 'zzz' })).rejects.toThrow(/没有匹配/)

    const paused = String(await run(wired, { action: 'update', id, enabled: false }))
    expect(paused).toContain('暂停')
  })

  test('pause / resume / run / delete 与未知 action', async () => {
    const wired = mount()
    cleanup = wired.dispose
    await run(wired, { action: 'create', title: 'T', prompt: 'P', rule: 'every:30m' })
    const id = tasks()[0]!.id

    expect(String(await run(wired, { action: 'pause', id }))).toContain('已暂停')
    expect(tasks()[0]!.enabled).toBe(false)
    expect(String(await run(wired, { action: 'resume', id }))).toContain('已恢复')

    const fired = String(await run(wired, { action: 'run', id }))
    expect(fired).toContain('立即投给模型')
    expect(wired.followups).toHaveLength(1)
    expect(wired.followups[0]).toMatchObject({ target: 's1', kind: 'notice' })
    expect(wired.followups[0]!.text).toContain('【定时任务触发】')

    expect(String(await run(wired, { action: 'delete', id }))).toContain('已删除')
    expect(tasks()).toHaveLength(0)
    await expect(run(wired, { action: 'nope' })).rejects.toThrow(/action 只能是/)
  })
})

describe('命令 /schedule', () => {
  function command(wired: ReturnType<typeof mount>, args: string[]): unknown {
    return wired.commands[0]!.run({ args, ui: wired.ui })
  }

  test('list 与空参数都回清单（含用法页脚）', () => {
    const wired = mount()
    cleanup = wired.dispose
    command(wired, [])
    command(wired, ['list'])
    expect(wired.uiNotices).toHaveLength(2)
    expect(wired.uiNotices[0]).toContain('现在没有定时任务')
  })

  test('add：缺标题 / 坏规则回提示；成功建任务并回「已建好」', async () => {
    const wired = mount()
    cleanup = wired.dispose
    command(wired, ['add', 'every:30m'])
    expect(wired.uiNotices.at(-1)).toContain('还要给个标题')
    command(wired, ['add', 'bogus', '标题'])
    expect(wired.uiNotices.at(-1)).toContain('认不出选择器')
    command(wired, ['add', 'every:30m', '起来喝水'])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(wired.uiNotices.at(-1)).toContain('已建好定时任务')
    expect(tasks()[0]).toMatchObject({ createdBy: 'user', title: '起来喝水' })
  })

  test('add 的选择器切分：cron 五段、cron: 连写、weekly 两段、weekly: 连写', async () => {
    const wired = mount()
    cleanup = wired.dispose
    for (const args of [
      ['add', 'cron', '0', '9', '*', '*', '*', '早报'],
      ['add', 'cron:0', '9', '*', '*', '*', '早报二'],
      ['add', 'weekly', 'mon', '09:30', '站会'],
      ['add', 'weekly:mon', '09:30', '站会二'],
    ]) {
      command(wired, args)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const kinds = tasks().map((task) => task.rule.kind)
    expect(kinds).toEqual(['cron', 'cron', 'weekly', 'weekly'])
    expect(tasks()[0]!.title).toBe('早报')
    expect(tasks()[2]!.title).toBe('站会')

    command(wired, ['add', 'cron', '0', '9'])
    expect(wired.uiNotices.at(-1)).toContain('cron 要写全五段')
    command(wired, ['add', 'weekly', 'mon'])
    expect(wired.uiNotices.at(-1)).toContain('weekly 要写')
  })

  test('pause / resume / run / remove 与找不到 / 未知子命令', async () => {
    const wired = mount()
    cleanup = wired.dispose
    await wireTask(wired)
    const id = tasks()[0]!.id

    command(wired, ['pause', id])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(wired.uiNotices.at(-1)).toContain('已暂停')
    command(wired, ['resume', id])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(wired.uiNotices.at(-1)).toContain('已恢复')
    command(wired, ['run', id])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(wired.uiNotices.at(-1)).toContain('立即投给模型')
    command(wired, ['remove', id])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(wired.uiNotices.at(-1)).toContain('已删除')

    command(wired, ['pause', 'nope'])
    expect(wired.uiNotices.at(-1)).toContain('没有匹配')
    command(wired, ['whatever'])
    expect(wired.uiNotices.at(-1)).toContain('用法：')
  })

  /** 通过命令建一条任务（后面的 pause/run 用）。 */
  async function wireTask(wired: ReturnType<typeof mount>): Promise<void> {
    command(wired, ['add', 'every:30m', '任务'])
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
})

describe('提示词 / 快照 / 设置分区', () => {
  test('提示词：没有任务或总开关关着给空串；有任务时只给静态说明（无标题、无下次时刻）', async () => {
    const wired = mount()
    cleanup = wired.dispose
    expect(wired.prompts[0]!()).toBe('')
    await (wired.tools[0]!['run'] as (a: unknown) => Promise<unknown>)({
      action: 'create',
      title: '早报',
      prompt: '写早报',
      rule: 'daily:09:30',
    })
    const text = wired.prompts[0]!()
    expect(text).toContain('你有定时任务')
    expect(text).toContain('不构成任何授权')
    expect(text).toContain('至多补一次')
    expect(text).toContain('action=list')
    // 静态段里不许出现任务标题或绝对/相对触发时刻。
    expect(text).not.toContain('早报')
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(text).not.toMatch(/每天\s*\d{2}:\d{2}/)

    const off = mount({ enabled: false, timeZone: 'UTC' })
    cleanup = off.dispose
    expect(off.prompts[0]!()).toBe('')
  })

  test('快照面 scheduled：只读投影任务字段', async () => {
    const wired = mount()
    cleanup = wired.dispose
    await (wired.tools[0]!['run'] as (a: unknown) => Promise<unknown>)({
      action: 'create',
      title: '早报',
      prompt: '写早报',
      rule: 'daily:09:30',
    })
    const rows = wired.surfaces.get('scheduled')!() as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({ title: '早报', enabled: true, lastStatus: 'never' })
    expect(typeof rows[0]!['nextRunAt']).toBe('number')
  })

  test('设置分区：fields 的字段齐全、values 回当前值、save 逐项校验', async () => {
    const wired = mount()
    cleanup = wired.dispose
    const section = wired.sectionOf() as {
      fields(): Array<Record<string, unknown>>
      values(): Record<string, unknown>
      save(key: string, value: unknown): string | void
      action(name: string): string | Promise<string>
    }

    const fields = section.fields()
    expect(fields.map((field) => field['key'] ?? field['action'] ?? field['type'])).toEqual(
      expect.arrayContaining(['info', 'enabled', 'timeZone', 'maxRunSeconds', 'historyLimit', 'check']),
    )
    expect(section.values()).toEqual({ enabled: true, timeZone: 'UTC', maxRunSeconds: 600, historyLimit: 200 })

    expect(section.save('enabled', false)).toBeUndefined()
    expect(section.values()['enabled']).toBe(false)
    expect(section.save('timeZone', 'Bad/Zone')).toContain('不认识')
    expect(section.save('timeZone', 'Asia/Shanghai')).toBeUndefined()
    expect(section.save('maxRunSeconds', 'x')).toContain('整数')
    expect(section.save('maxRunSeconds', 10)).toContain('30')
    expect(section.save('maxRunSeconds', 120)).toBeUndefined()
    expect(section.save('historyLimit', 'x')).toContain('整数')
    expect(section.save('historyLimit', 5)).toContain('20')
    expect(section.save('historyLimit', 100)).toBeUndefined()
    expect(section.save('bogus', 1)).toContain('bogus')
    // 刚才把总开关关掉了：check 先回这句；打开之后才回状态摘要。
    expect(await section.action('check')).toContain('总开关是关着的')
    expect(section.save('enabled', true)).toBeUndefined()
    expect(await section.action('check')).toContain('条任务')
    expect(await section.action('bogus')).toContain('bogus')
  })
})
