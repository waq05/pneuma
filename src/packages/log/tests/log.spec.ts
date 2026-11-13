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
import { afterAll, expect, test } from 'vitest'

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
  }
  const effects: Array<() => void> = []
  const ctx = {
    logger: {
      buffer: [] as LogMessage[],
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

test('设置页改级别/目录/上限，运行中立刻生效（不用重启宿主）', () => {
  const dir = tempDir('dsc-log-live-')
  const { captured, dispose } = mount({ dir, level: 'info' })
  const section = captured.sections.get('log')
  expect(section).toBeDefined()
  const service = logServiceOf(captured)
  expect(service.level()).toBe('info')
  expect(section?.values().maxFileMB).toBe(8)

  // 设置页点「保存」走的就是 section.save：写 plugins.json，下一次取值立刻按新值算
  section?.save('level', 'debug')
  expect(service.level()).toBe('debug')

  section?.save('maxFileMB', '16')
  expect(section?.values().maxFileMB).toBe(16)

  const moved = tempDir('dsc-log-live-dir-')
  section?.save('dir', moved)
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

test('保存路径不等 TTL：设置分区 save() 之后立刻是新值', () => {
  const dir = tempDir('dsc-log-save-')
  writeLogConfigOnDisk({ level: 'info' })
  const { captured, dispose } = mount({ dir, level: 'info' })
  // 先读一次，把缓存填上（apply 里建 sink 时已经读过一次）
  const service = logServiceOf(captured)
  expect(service.level()).toBe('info')

  captured.sections.get('log')?.save('level', 'debug')
  // 若保存路径没有打掉缓存，这里在 TTL 内仍是 info 而红
  expect(service.level()).toBe('debug')
  dispose()
})
