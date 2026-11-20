/**
 * @pneuma/log 的包级测试：钉住三条真会出事的线。
 *
 * 1. **脱敏**：漏一条就是事故，所以四类外形逐条断言，外加「普通文本不被误伤」；
 * 2. **上限**：轮转与过期清理是唯一会动用户磁盘的地方，用临时目录真写一遍；
 * 3. **装配**：命令、设置分区、服务三样都挂上了，且 `apply` 的清理函数真能摘掉监听。
 *
 * 迁移说明：原来假 ctx 走 `scripts/_testkit.mjs` 的 `mountPlugin` / `runCommand` /
 * `expectRegistered`，现在本文件自带一份假 ctx（只实现 log 会碰的 `logger` / `provide` /
 * `commands` / `settings` / `transcript` / `effect`），理由是不再依赖将来要删的脚本层，
 * 也让断言直接落在捕获到的注册对象上。快照文件 `log-record.snapshot.json` 改成内联断言
 * （同样是钉格式，但读文件时不用再跳一次），断言库换成 Vitest。
 *
 * @module @pneuma/log/tests
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { afterAll, expect, test, vi } from 'vitest'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本文件建过的临时目录，统一在 afterAll 删。 */
const tempDirs: string[] = []

/** 建一个临时目录并登记清理。 */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

// 配置改成每次现读 `plugins.json`（见 index.ts 的 config()），测试必须有自己的 DSC_HOME：
// 否则会读走开发者真实的 ~/.dsc/plugins.json，断言随人而变，写配置还会碰到真文件。
// 必须在 import 之前设好：core/path-policy 的 DSC_HOME 是模块加载那一刻定死的。
const home = tempDir('dsc-log-home-')
process.env.DSC_HOME = join(home, '.dsc')

const filter = await import('../filter.js')
const { LogSink, dayKey } = await import('../sink.js')
const { logPlugin } = await import('../index.js')

/** 造一条 cordis 形状的日志消息。 */
const message = (type: string, level: number, text: string): LogMessage => ({
  sn: 1,
  ts: Date.now(),
  name: 'probe',
  type,
  level,
  args: [text],
})

/** cordis 日志消息里本测试用得到的字段。 */
interface LogMessage {
  sn: number
  ts: number
  name: string
  type: string
  level: number
  args: unknown[]
}

/** 一条被捕获的日志服务。 */
interface CapturedLog {
  tail: (count?: number) => string[]
  file: () => string
  dir: () => string
  level: () => string
  flush: () => void
}

/** 命令处理函数的形状（测试只给 `notice`）。 */
type CommandHandler = (input: { args: string[]; ui: { notice: (text: string) => void } }) => unknown

/** 捕获到的一次装配。 */
interface Captured {
  /** 注册上来的服务，按名字取。 */
  services: Record<string, unknown>
  /** 注册的日志 exporter。 */
  exporters: Array<{ export: (message: LogMessage) => void }>
  /** 注册的命令：名字 → 规格与处理函数。 */
  commands: Map<string, { spec: { name: string }; handler: CommandHandler }>
  /** 注册的设置分区。 */
  sections: Map<string, SettingsSectionSpec>
  /** 命令 notice 出来的文字。 */
  notices: string[]
  /** 假 logger 的缓冲：`/log` 与 log 服务的 tail 从这里取。 */
  buffer: LogMessage[]
}

/**
 * 装一次插件：假 ctx 只实现 apply 会碰的面。
 *
 * `effect` 真跑回调并收集清理函数——log 的 `apply` 用不到它，但保留正确语义，
 * 免得将来挪进 `effect` 的注册被静默跳过。
 */
function mount(config: Record<string, unknown>): { captured: Captured; dispose: () => void } {
  const captured: Captured = {
    services: {},
    exporters: [],
    commands: new Map(),
    sections: new Map(),
    notices: [],
    buffer: [],
  }
  const effects: Array<() => void> = []
  const ctx = {
    logger: {
      buffer: captured.buffer,
      exporter: (exporter: { export: (message: LogMessage) => void }) => {
        captured.exporters.push(exporter)
        return () => {}
      },
    },
    provide: (name: string, service: unknown) => {
      captured.services[name] = service
    },
    get: (name: string) => captured.services[name],
    commands: {
      register: (spec: { name: string }, handler: CommandHandler) => {
        captured.commands.set(spec.name, { spec, handler })
        return () => captured.commands.delete(spec.name)
      },
    },
    settings: {
      registerSection: (spec: SettingsSectionSpec) => {
        captured.sections.set(spec.id, spec)
        return () => captured.sections.delete(spec.id)
      },
    },
    transcript: { system: () => {} },
    effect: (execute: () => unknown) => {
      const off = execute()
      if (typeof off === 'function') effects.push(off as () => void)
      return () => {}
    },
  }
  const dispose = logPlugin.apply(ctx as never, config) as unknown
  return {
    captured,
    dispose: () => {
      if (typeof dispose === 'function') (dispose as () => void)()
      for (const off of effects) off()
    },
  }
}

/** 跑一条命令，收集它 notice 出来的文字。 */
function runCommand(captured: Captured, name: string, args: string[] = []): string[] {
  const entry = captured.commands.get(name)
  expect(entry, `命令 /${name} 没注册`).toBeDefined()
  captured.notices.length = 0
  entry?.handler({ args, ui: { notice: (text: string) => captured.notices.push(text) } })
  return captured.notices
}

/** 取日志服务（装配成功的另一个证据）。 */
const logServiceOf = (captured: Captured): CapturedLog => captured.services['log'] as CapturedLog

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

// ── 1. 包形态 ───────────────────────────────────────────────────────────────

test('清单与装配行对得上', () => {
  const pkg = JSON.parse(read('../package.json')) as { name: string; pneuma: { order: number } }
  const patch = read('../cordis.patch.yml')
  expect(pkg.name).toBe('@pneuma/log')
  expect(pkg.pneuma.order).toBe(5)
  expect(patch).toContain("name: '@pneuma/log'")
})

// ── 2. 脱敏 ─────────────────────────────────────────────────────────────────

test('四类凭据都被抹掉', () => {
  const cases: Array<[string, string]> = [
    ['Authorization: Bearer abcdefgh12345678', 'Authorization: ***'],
    ['Bearer abcdefgh12345678', 'Bearer ***'],
    ['apiKey="abcdefgh12345678"', 'apiKey="***'],
    ['access_token: abcdefgh12345678', 'access_token: ***'],
    ['key is sk-abcdefgh12345678', 'sk-***'],
  ]
  for (const [input, expected] of cases) {
    const out = filter.redact(`x ${input} y`)
    expect(out, `${input} → ${out}`).toContain(expected)
    expect(out, `${input} 的密钥还在：${out}`).not.toContain('12345678')
  }
})

test('普通文本不被误伤', () => {
  expect(filter.redact('read 12 files in 340ms')).toBe('read 12 files in 340ms')
})

test('级别名映射', () => {
  expect(filter.levelNameOf(0)).toBe('error')
  expect(filter.levelNameOf(3)).toBe('debug')
  expect(filter.levelNameOf(99)).toBe('info')
})

test('落盘记录的形状稳定', () => {
  // 钉的是格式：哪天有人把 `lvl` 改名成 `level`，读日志的脚本与体检就得跟着改。
  // 时间戳固定，断言才不会每跑一次就变。
  const record = filter.toRecord({ sn: 7, ts: 1_700_000_000_000, name: 'probe', type: 'warn', level: 1, args: ['%s 掉了一条', 'tool'] })
  expect(record).toEqual({
    t: '2023-11-14T22:13:20.000Z',
    lvl: 'warn',
    name: 'probe',
    sn: 7,
    msg: 'tool 掉了一条',
  })
})

// ── 3. 落盘上限 ─────────────────────────────────────────────────────────────

test('写满轮转到 .1，过期目录被整目录删', () => {
  const dir = tempDir('dsc-log-test-')
  const sink = new LogSink({ dir, maxFileBytes: 400, keepDays: 10, sweepIntervalMs: 0 })
  // 每行约 60 字节，40 行 ≈ 2.4 KB，必然超过 400 的上限
  for (let i = 0; i < 40; i += 1) sink.write(JSON.stringify({ i, msg: 'x'.repeat(40) }))
  sink.flush()

  const day = dayKey(Date.now())
  const files = readdirSync(join(dir, day))
  expect(files.some((name) => name.endsWith('.jsonl'))).toBe(true)
  expect(files.some((name) => name.endsWith('.jsonl.1'))).toBe(true)

  const oldDay = dayKey(Date.now() - 40 * 24 * 60 * 60 * 1000)
  mkdirSync(join(dir, oldDay), { recursive: true })
  writeFileSync(join(dir, oldDay, 'dsc-1.jsonl'), 'x'.repeat(1024))
  const pruner = new LogSink({ dir, keepDays: 10, maxTotalBytes: 1 << 20, sweepIntervalMs: 0 })
  expect(pruner.prune(true).dirs).toBeGreaterThanOrEqual(1)
  expect(existsSync(join(dir, oldDay))).toBe(false)
  expect(existsSync(join(dir, day))).toBe(true)
  sink.close()
})

// ── 4. 装配 ─────────────────────────────────────────────────────────────────

test('apply 挂上命令、设置分区与服务，清理函数摘掉监听', () => {
  const dir = tempDir('dsc-log-apply-')
  const { captured, dispose } = mount({ dir })

  expect(captured.commands.has('log')).toBe(true)
  expect(captured.sections.has('log')).toBe(true)
  const service = logServiceOf(captured)
  expect(typeof service.tail).toBe('function')
  expect(typeof service.file).toBe('function')

  captured.exporters[0]?.export(message('info', 2, 'hello %s'))
  captured.exporters[0]?.export(message('warn', 1, 'secret sk-abcdefgh12345678'))
  service.flush()

  const body = readFileSync(service.file(), 'utf8')
  expect(body).toContain('hello')
  expect(body).toContain('sk-***')
  expect(body).not.toContain('12345678')

  dispose()
  expect(existsSync(service.file())).toBe(true)
})

test('级别 off 时一条都不落', () => {
  const dir = tempDir('dsc-log-off-')
  const { captured, dispose } = mount({ dir, level: 'off' })
  captured.exporters[0]?.export(message('error', 0, 'shut up'))
  logServiceOf(captured).flush()
  expect(existsSync(logServiceOf(captured).file())).toBe(false)
  dispose()
})

test('/log 命令报出文件、级别与条数', () => {
  const dir = tempDir('dsc-log-cmd-')
  const { captured, dispose } = mount({ dir })
  captured.exporters[0]?.export(message('info', 2, 'command probe'))
  logServiceOf(captured).flush()

  const notices = runCommand(captured, 'log', ['5'])
  expect(notices.length).toBe(1)
  expect(notices[0]).toContain('日志文件')
  expect(notices[0]?.includes('信息') || notices[0]?.includes('info')).toBe(true)
  dispose()
})

// ── 5. 配置现读：设置页改完立刻生效 ──────────────────────────────────────────

test('readLogConfig 每次现读 plugins.json，不是挂载时的快照', async () => {
  const { readLogConfig } = await import('@pneuma/runtime/core/log-config.js')
  const { writePluginConfig } = await import('@pneuma/runtime/core/plugin-registry.js')
  // passed 代表装配时那份行配置：磁盘没写的键该继续用它作底
  const passed = { dir: tempDir('dsc-log-core-'), level: 'info' }
  expect(readLogConfig(passed).level).toBe('info')

  writePluginConfig('log', { level: 'debug', maxFileBytes: 16 * 1024 * 1024 })
  expect(readLogConfig(passed).level).toBe('debug')
  expect(readLogConfig(passed).maxFileBytes).toBe(16 * 1024 * 1024)
  expect(readLogConfig(passed).dir).toBe(passed.dir)

  // 复位，免得这份临时 plugins.json 影响后面的用例
  writePluginConfig('log', { level: null, maxFileBytes: null })
})

test('设置页改级别/目录/上限，运行中立刻生效（不用重启宿主）', async () => {
  const dir = tempDir('dsc-log-live-')
  const { captured, dispose } = mount({ dir, level: 'info' })
  const section = captured.sections.get('log')
  expect(section).toBeDefined()
  const save = section?.save
  expect(typeof save).toBe('function')
  /** 设置页每次打开都现算字段值；这里把它的丢弃 Promise 的签名收成同步取一次。 */
  const values = (): Record<string, unknown> => section?.values() as Record<string, unknown>
  const service = logServiceOf(captured)
  expect(service.level()).toBe('info')
  expect(values()['maxFileMB']).toBe(8)

  // 设置页点「保存」走的就是 section.save：写 plugins.json，下一次取值立刻按新值算
  await save?.('level', 'debug')
  expect(service.level()).toBe('debug')

  await save?.('maxFileMB', '16')
  expect(values()['maxFileMB']).toBe(16)

  const moved = tempDir('dsc-log-live-dir-')
  await save?.('dir', moved)
  expect(service.dir()).toBe(moved)
  expect(service.file().startsWith(moved)).toBe(true)

  // 新级别真的作用在下一行上：debug 现在放行（缺省 info 时会丢掉）
  captured.exporters[0]?.export(message('debug', 3, 'after-save'))
  service.flush()
  expect(readFileSync(service.file(), 'utf8')).toContain('after-save')
  dispose()
})

// ── 6. 配置缓存：省钱但不拖延生效 ────────────────────────────────────────────

/** 直接改磁盘上的 `plugins.json`（不经过设置分区），模拟用户手改文件。 */
function writeLogConfigOnDisk(patch: Record<string, unknown>): void {
  const root = process.env['DSC_HOME'] ?? ''
  mkdirSync(root, { recursive: true })
  const file = join(root, 'plugins.json')
  const doc = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { version?: number; entries?: unknown[] })
    : { version: 1, entries: [] }
  const entries = Array.isArray(doc.entries) ? doc.entries : []
  const index = entries.findIndex(
    (entry) => entry !== null && typeof entry === 'object' && (entry as { file?: string }).file === 'log',
  )
  const previous = index >= 0 ? (entries[index] as { config?: Record<string, unknown> }) : {}
  const next = {
    file: 'log',
    disabled: false,
    ...previous,
    config: { ...(previous.config ?? {}), ...patch },
  }
  if (index >= 0) entries[index] = next
  else entries.push(next)
  doc.version = doc.version ?? 1
  doc.entries = entries
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

test('配置有缓存：手改盘上的 plugins.json，TTL 内还是旧值，过后才生效', async () => {
  const dir = tempDir('dsc-log-cache-')
  // 挂载前把磁盘与行配置都定成 info，这条用例就不依赖前面用例留下的状态
  writeLogConfigOnDisk({ level: 'info' })
  const { captured, dispose } = mount({ dir, level: 'info' })
  const service = logServiceOf(captured)
  expect(service.level()).toBe('info')

  // 绕过 section.save，直接写盘：没有失效事件，只能靠 TTL
  writeLogConfigOnDisk({ level: 'debug' })

  // 缓存若不存在，这一步会立刻读到 debug 而红
  expect(service.level()).toBe('info')

  // TTL 是 250 ms；多等 150 ms 给定时器精度留余量
  await new Promise((resolve) => setTimeout(resolve, 250 + 150))
  expect(service.level()).toBe('debug')
  dispose()
})

test('保存路径不等 TTL：设置分区 save() 之后立刻是新值', async () => {
  const dir = tempDir('dsc-log-save-')
  writeLogConfigOnDisk({ level: 'info' })
  const { captured, dispose } = mount({ dir, level: 'info' })
  // 先读一次，把缓存填上（apply 里建 sink 时已经读过一次）
  const service = logServiceOf(captured)
  expect(service.level()).toBe('info')

  await captured.sections.get('log')?.save?.('level', 'debug')
  // 若保存路径没有打掉缓存，这里在 TTL 内仍是 info 而红
  expect(service.level()).toBe('debug')
  dispose()
})

// ── 7. 崩溃现场：两条进程级错误都落一行，且只落一次 ────────────────────────────

/** 取某个进程事件的监听器（process.listeners 的签名只认信号名，这里按字符串取）。 */
function listenersOf(event: string): Function[] {
  return (process.listeners as unknown as (name: string) => Function[])(event)
}

/** 从进程监听表里挑出「本次 mount 新加的那一个」。 */
function addedListener(event: string, before: ReadonlySet<unknown>): ((...args: never[]) => void) | undefined {
  return listenersOf(event).find((listener) => !before.has(listener)) as ((...args: never[]) => void) | undefined
}

test('uncaughtException：落一行带栈、退出码 1；重复事件不重复记；exit 监听器刷掉队列', () => {
  const dir = tempDir('dsc-log-crash-')
  writeLogConfigOnDisk({ dir, level: 'info' })
  const beforeUncaught = new Set<unknown>(listenersOf('uncaughtException'))
  const beforeExit = new Set<unknown>(listenersOf('exit'))
  const { captured, dispose } = mount({ dir, level: 'info' })
  const uncaught = addedListener('uncaughtException', beforeUncaught)
  const onExit = addedListener('exit', beforeExit)
  expect(uncaught, 'apply 应挂上 uncaughtException').toBeDefined()
  expect(onExit, 'apply 应挂上 exit').toBeDefined()

  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const service = logServiceOf(captured)
  try {
    uncaught?.(new Error('boom') as never)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(readFileSync(service.file(), 'utf8')).toContain('[uncaughtException] Error: boom')

    // crashing 已置位：第二次进来只打印与退出，不再写第二行。
    const lines = readFileSync(service.file(), 'utf8').trim().split('\n').length
    uncaught?.(new Error('again') as never)
    expect(readFileSync(service.file(), 'utf8').trim().split('\n').length).toBe(lines)
  } finally {
    exitSpy.mockRestore(); vi.restoreAllMocks()
  }

  // 正常退出：队列里剩下的行由 exit 监听器刷盘。
  captured.exporters[0]?.export(message('info', 2, 'before-exit'))
  onExit?.()
  expect(readFileSync(service.file(), 'utf8')).toContain('before-exit')
  dispose()
})

test('unhandledRejection：非 Error 的原因折成字符串落一行', () => {
  const dir = tempDir('dsc-log-rejection-')
  writeLogConfigOnDisk({ dir, level: 'info' })
  const beforeRejection = new Set<unknown>(listenersOf('unhandledRejection'))
  const { captured, dispose } = mount({ dir, level: 'info' })
  const rejection = addedListener('unhandledRejection', beforeRejection)
  expect(rejection, 'apply 应挂上 unhandledRejection').toBeDefined()
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    rejection?.('字符串原因' as never)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(readFileSync(logServiceOf(captured).file(), 'utf8')).toContain('[unhandledRejection] 字符串原因')
  } finally {
    exitSpy.mockRestore(); vi.restoreAllMocks()
  }
  dispose()
})

// ── 8. /log 的条数归一与 tail 取日志缓冲 ─────────────────────────────────────

test('/log 条数非法或非正时按 20 条；日志缓冲非空时 tail 给出级别/来源/正文', () => {
  const dir = tempDir('dsc-log-tail-')
  writeLogConfigOnDisk({ dir, level: 'info' })
  const { captured, dispose } = mount({ dir, level: 'info' })
  captured.buffer.push(message('info', 2, '第一条日志'))
  captured.buffer.push(message('warn', 1, '第二条日志'))

  const notices = runCommand(captured, 'log', ['不是数字'])
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain('日志文件')
  // buffer 里的两行会被 tail 出来（级别名 + 来源 + 正文）。
  expect(notices[0]).toContain('info')
  expect(notices[0]).toContain('第二条日志')

  const service = logServiceOf(captured)
  // 0 按「没填」回落 20 条；负数被夹成 0，而 slice(-0) 等于整段。
  expect(service.tail(0)).toHaveLength(2)
  expect(service.tail(-5)).toHaveLength(2)
  expect(service.tail(1)).toHaveLength(1)
  expect(service.tail()).toHaveLength(2)
  dispose()
})

// ── 9. 设置分区剩余分支：off 标签、总量上限、未知键、清理按钮 ─────────────────

test('设置分区：off 选项有中文标签；保存总量上限与未知键；清理按钮回报删了几个目录', () => {
  const dir = tempDir('dsc-log-section-')
  writeLogConfigOnDisk({ dir, level: 'info' })
  const { captured, dispose } = mount({ dir, level: 'info' })
  const section = captured.sections.get('log')
  expect(section).toBeDefined()

  const fields = section?.fields() as Array<{ key?: string; type: string; options?: Array<{ value: string; label: string }> }>
  const level = fields.find((field) => field.key === 'level')
  expect(level?.options?.find((option) => option.value === 'off')?.label).toBe('关闭')
  expect(level?.options?.some((option) => option.value === 'debug')).toBe(true)

  expect(String(section?.save?.('maxTotalMB', 'not-a-number'))).toContain('正数')
  expect(section?.save?.('maxTotalMB', '16')).toBeUndefined()
  expect(section?.values?.()).toMatchObject({ maxTotalMB: 16 })
  expect(String(section?.save?.('bogus', '1'))).toContain('bogus')

  expect(String(section?.action?.('bogus'))).toContain('未知的操作')
  expect(String(section?.action?.('cleanup'))).toContain('清理完成')
  dispose()
})

// ── 10. sink 的剩余分支：size / 目录不存在 / 打开失败 / 总量预算 ──────────────

test('sink：size 随写入增长；目录不存在时清理返回零；目录位置被文件占着时静默丢弃', () => {
  const dir = tempDir('dsc-log-sink-extra-')
  const sink = new LogSink({ dir, sweepIntervalMs: 0 })
  expect(sink.size()).toBe(0)
  sink.write('{"msg":"x"}')
  sink.flush()
  expect(sink.size()).toBeGreaterThan(0)
  expect(sink.file()).toContain(dayKey(Date.now()))
  sink.close()

  const missing = new LogSink({ dir: join(dir, 'no-such-dir') })
  expect(missing.prune(true)).toStrictEqual({ dirs: 0, bytes: 0 })

  // 用普通文件占住「日志目录」的位置：开文件失败，写入被丢弃但不抛。
  const blocked = join(dir, 'blocked')
  writeFileSync(blocked, 'x')
  const broken = new LogSink({ dir: blocked })
  expect(() => {
    broken.write('{"msg":"lost"}')
    broken.flush()
    broken.close()
  }).not.toThrow()
})

test('sink 总量预算：超过上限从最旧的一天开始整目录删，今天不删', () => {
  const dir = tempDir('dsc-log-budget-')
  const now = Date.now()
  const oldDay = dayKey(now - 2 * 24 * 60 * 60 * 1000)
  const yesterday = dayKey(now - 24 * 60 * 60 * 1000)
  for (const day of [oldDay, yesterday]) {
    mkdirSync(join(dir, day), { recursive: true })
    writeFileSync(join(dir, day, 'dsc-1.jsonl'), 'x'.repeat(1024))
  }
  // keepDays 大、总量上限只够一天：保留期内的两天里，最旧的那天被删。
  const sink = new LogSink({ dir, keepDays: 30, maxTotalBytes: 1024, sweepIntervalMs: 0 })
  const result = sink.prune(true)
  expect(result.dirs).toBe(1)
  expect(result.bytes).toBe(1024)
  expect(existsSync(join(dir, oldDay))).toBe(false)
  expect(existsSync(join(dir, yesterday))).toBe(true)
})
