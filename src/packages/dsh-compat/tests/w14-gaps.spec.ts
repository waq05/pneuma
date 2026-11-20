/**
 * dsh-compat 装配面补盲（w14）：`apply()` 里那 15 行从未被走到——模块解析钩子兜底、
 * `DSH_HOME` 归一、warn/error 镜像进 transcript 的 exporter 桥、可注入 logger 门面的
 * 四个级别与 named logger、以及卸载时摘掉 exporter。
 *
 * 假 ctx 的 logger 只有 exporter/四个级别这几样「管道」形状，消息对象按 cordis 的
 * `Message` 拼；文案还原用的是真 `Logger.format` + 真 `defaultFormatters`，所以
 * `warn('failed: %s', err)` 这类 printf 写法照样验得到。`DSC_HOME` 在任何产品 import
 * 之前指进临时目录。
 *
 * @module dsc/packages/dsh-compat/tests/w14-gaps.spec
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-dsh-compat-w14-'))
process.env['DSC_HOME'] = HOME
const savedDshHome = process.env['DSH_HOME']

let dshCompatPlugin: (typeof import('../index.js'))['dshCompatPlugin']

beforeAll(async () => {
  dshCompatPlugin = (await import('../index.js')).dshCompatPlugin
})

afterAll(() => {
  delete process.env['DSC_HOME']
  if (savedDshHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedDshHome
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 句柄：留给系统清
  }
})

interface LogMessage {
  sn: number
  ts: number
  name: string
  type: string
  level: number
  args: unknown[]
}

interface LoggerLike {
  (name?: string): {
    debug: (...args: unknown[]) => void
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  exporter(sink: { export(message: LogMessage): void }): () => void
}

/** 假 cordis logger：只保留「消息进 exporter」这一条管道，级别阈值不做过滤（交给插件自己滤）。 */
function fakeLogger(logs: LogMessage[]): LoggerLike {
  const sinks = new Set<(message: LogMessage) => void>()
  const emit = (type: string, name: string, args: unknown[]): void => {
    const message: LogMessage = { sn: logs.length + 1, ts: Date.now(), name, type, level: 3, args }
    logs.push(message)
    for (const sink of sinks) sink(message)
  }
  const named = (name: string) => ({
    debug: (...args: unknown[]) => emit('debug', name, args),
    info: (...args: unknown[]) => emit('info', name, args),
    warn: (...args: unknown[]) => emit('warn', name, args),
    error: (...args: unknown[]) => emit('error', name, args),
  })
  const logger = ((name?: string) => named(name ?? '')) as LoggerLike
  logger.debug = (...args) => emit('debug', '', args)
  logger.info = (...args) => emit('info', '', args)
  logger.warn = (...args) => emit('warn', '', args)
  logger.error = (...args) => emit('error', '', args)
  logger.exporter = (sink) => {
    sinks.add(sink.export)
    return () => {
      sinks.delete(sink.export)
    }
  }
  return logger
}

interface Harness {
  systems: string[]
  logs: LogMessage[]
  provided: Map<string, unknown>
  logger: LoggerLike
  dispose(): void
}

function mount(): Harness {
  const logs: LogMessage[] = []
  const systems: string[] = []
  const provided = new Map<string, unknown>()
  const logger = fakeLogger(logs)
  const ctx = {
    logger,
    transcript: { system: (text: string) => systems.push(text) },
    provide(name: string, value: unknown) {
      provided.set(name, value)
    },
  }
  const cleanup = dshCompatPlugin.apply?.(ctx as never, undefined)
  let disposed = false
  return {
    systems,
    logs,
    provided,
    logger,
    dispose() {
      if (disposed) return
      disposed = true
      cleanup?.()
    },
  }
}

test('apply：DSH_HOME 归一到 DSC_HOME，并 provide 可注入的 logger 门面', () => {
  const harness = mount()
  expect(process.env['DSH_HOME']).toBe(HOME)
  const service = harness.provided.get('logger') as LoggerLike
  expect(typeof service).toBe('function')
  expect(typeof service.debug).toBe('function')
  expect(typeof service.warn).toBe('function')
  harness.dispose()
})

test('warn/error 镜像进 transcript，info/debug 不转；printf 占位符被还原', () => {
  const harness = mount()
  const service = harness.provided.get('logger') as LoggerLike
  service.warn('failed: %s', '端点 500')
  service.error('boom')
  service.info('quiet')
  service.debug('quieter')

  expect(harness.systems).toHaveLength(2)
  expect(harness.systems[0]).toBe('[dsh 插件] failed: 端点 500')
  expect(harness.systems[1]).toBe('[dsh 插件] boom')
  // 四个级别都真的走了一遍内置管道（exporter 只吞 warn/error 是桥自己的事）。
  expect(harness.logs.map((message) => message.type)).toEqual(['warn', 'error', 'info', 'debug'])
  harness.dispose()
})

test('named logger：message.name 出现在 transcript 前缀里', () => {
  const harness = mount()
  const service = harness.provided.get('logger') as LoggerLike
  service('cost-meter').warn('账本写不进去')
  expect(harness.systems).toEqual(['[dsh 插件·cost-meter] 账本写不进去'])
  harness.dispose()
})

test('卸载：返回的 disposer 摘掉 exporter，之后的 warn 不再进 transcript', async () => {
  const harness = mount()
  const service = harness.provided.get('logger') as LoggerLike
  service.warn('before-dispose')
  expect(harness.systems).toHaveLength(1)
  harness.dispose()
  service.warn('after-dispose')
  expect(harness.systems).toHaveLength(1)
})
