/**
 * session 包级测试：插件对象、服务面、不越权注册，以及启动选项与两个事件。
 *
 * 原来这四条里有三条读 `index.ts` 源码文本找方法签名、`cwd?: string`、`ctx.emit('dsc/session-open')`
 * 之类的字面量。现在改成真的跑一遍 `apply()`：
 *   - 服务面 → 逐个检查十二个方法是不是函数；
 *   - 不注册工具/命令/提示词 → 假 ctx 上挂三个 register spy，apply 结束后必须一次都没调；
 *   - 启动选项 → 传 `cwd` 后当前会话的 `meta.cwd` 就是那个目录（类型上同时钉住
 *     `SessionPluginOptions` 的 `cwd` / `resumeSessionPath` 两个字段还在）；
 *   - 事件 → `open()` 后事件流里出现 `dsc/session-open`；`dsc/exit` 的处理函数被注册，
 *     调用它真的会关当前会话（对 `close` 打 spy）。
 *
 * 环境隔离：`DSC_HOME` 指到 `mkdtempSync` 的临时目录，`saveLastSession` 这类写盘只落在临时目录。
 *
 * @module @pneuma/session/tests
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionService } from '@pneuma/runtime/services/types.js'
import type { SessionPluginOptions } from '../index.js'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-session-spec-'))
const cwd = mkdtempSync(join(tmpdir(), 'dsc-session-cwd-'))
let sessionPlugin: typeof import('../index.js')['sessionPlugin']
let service: SessionService
let emits: { name: string; payload: unknown }[]
let handlers: Map<string, () => void>
let registrations: { tools: number; commands: number; prompt: number }

beforeAll(async () => {
  process.env.DSC_HOME = home
  const policy = await import('@pneuma/runtime/core/path-policy.js')
  expect(policy.DSC_HOME).toBe(home)
  ;({ sessionPlugin } = await import('../index.js'))

  emits = []
  handlers = new Map()
  registrations = { tools: 0, commands: 0, prompt: 0 }
  const fakeCtx = {
    get: () => undefined,
    emit: (name: string, payload: unknown) => {
      emits.push({ name, payload })
    },
    on: (name: string, handler: () => void) => {
      handlers.set(name, handler)
    },
    provide: (_name: string, value: SessionService) => {
      service = value
    },
    // 这三个登记口不该被 session 插件碰到；做了计数好断言「一次都没调」。
    tools: { register: () => void (registrations.tools += 1) },
    commands: { register: () => void (registrations.commands += 1) },
    prompt: { register: () => void (registrations.prompt += 1) },
  }
  // 指一个不存在的会话文件：按插件的口径应安静地开新会话，并把 cwd 落到给定目录。
  const options: SessionPluginOptions = { cwd, resumeSessionPath: join(home, 'not-there.jsonl') }
  ;(sessionPlugin.apply as (ctx: unknown, config: SessionPluginOptions) => void)(fakeCtx, options)
})

afterAll(() => {
  service?.current().close()
  delete process.env.DSC_HOME
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

test('插件对象：名字、提供服务、不声明 inject、apply 收两个参数', () => {
  expect([sessionPlugin.name, sessionPlugin.provide]).toEqual(['session', 'session'])
  expect(sessionPlugin.inject).toBeUndefined()
  expect(typeof sessionPlugin.apply).toBe('function')
  expect(sessionPlugin.apply.length).toBe(2)
})

test('服务面十二个方法一个不少', () => {
  const methods = [
    'current',
    'open',
    'refresh',
    'archive',
    'archived',
    'restore',
    'purge',
    'rename',
    'setPinned',
    'userMessages',
    'fork',
    'rewind',
  ] as const
  for (const method of methods) expect(typeof service[method], method).toBe('function')
})

test('会话插件不自己注册工具与命令（那两件事有专门的包）', () => {
  expect(registrations).toEqual({ tools: 0, commands: 0, prompt: 0 })
})

test('启动选项 cwd/resumeSessionPath 生效，切会话发 dsc/session-open，退出关会话', async () => {
  // 不存在的 resume 路径 → 安静开新会话，目录取自 options.cwd。
  expect(service.current().meta.cwd).toBe(cwd)

  await service.open(undefined)
  const opened = emits.find((event) => event.name === 'dsc/session-open')
  expect(opened).toBeDefined()
  expect((opened?.payload as { session: { filePath: string } }).session.filePath).toBe(service.current().filePath)

  const exitHandler = handlers.get('dsc/exit')
  expect(typeof exitHandler).toBe('function')
  const closeSpy = vi.spyOn(service.current(), 'close')
  exitHandler?.()
  expect(closeSpy).toHaveBeenCalledTimes(1)
})
