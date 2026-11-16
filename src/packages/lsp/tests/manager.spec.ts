/**
 * LSP 管理器的调度面（`packages/lsp/manager.ts`）：找服务器/找根、池化、串行队列、
 * 破键退避、idle 回收与收摊。
 *
 * 对端仍是 `fixtures/fake-lsp-server.mjs`（真 node 子进程），时间预算压到毫秒级；
 * 每个用例自己造一个带 `package.json` 的项目根，`baseCwd` 指向它，让 `node` 能被解析到。
 *
 * @module dsc/packages/lsp/tests/manager.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { LspManager } from '../manager.js'
import type { LspManagerOptions, LspRuntimeValues } from '../client.js'
import type { LspServerDef } from '../servers.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))
const env = { ...process.env } as Record<string, string>
const position = { line: 0, character: 0 }

const created: Array<{ manager: LspManager; root: string }> = []

afterEach(() => {
  for (const { manager, root } of created.splice(0)) {
    manager.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

interface Setup {
  manager: LspManager
  root: string
  file: string
}

/** 一个带 package.json 标记的临时项目根。 */
function project(extra: Partial<LspServerDef> = {}, values: Partial<LspRuntimeValues> = {}, options: Partial<LspManagerOptions> = {}): Setup {
  const root = mkdtempSync(join(tmpdir(), 'dsc-lsp-manager-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"demo"}\n', 'utf8')
  const file = join(root, 'src', 'a.ts')
  writeFileSync(file, 'const a = 1\n', 'utf8')
  const server: LspServerDef = {
    id: 'fake',
    languageId: 'typescript',
    extensions: ['.ts'],
    command: 'node',
    args: [fixture, 'ok'],
    markers: ['package.json'],
    ...extra,
  }
  const manager = new LspManager({
    servers: () => [server],
    idleTimeoutMs: () => 60_000,
    baseCwd: () => root,
    env: () => env,
    values: () => ({
      initializeTimeoutMs: 4_000,
      requestTimeoutMs: 4_000,
      diagnosticsWaitMs: 500,
      pushSettleMs: 30,
      cancelGraceMs: 100,
      shutdownGraceMs: 800,
      brokenRetryMs: 60_000,
      ...values,
    }),
    ...options,
  })
  created.push({ manager, root })
  return { manager, root, file }
}

describe('plan：找文件、找服务器、找根', () => {
  test('文件不存在 / 扩展名没人认领 / 找不到项目根，各给一句能照做的原因', async () => {
    const { manager, root, file } = project()
    expect(await manager.query('goToDefinition', join(root, 'no.ts'), position, root, undefined)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('文件不存在'),
    })

    const other = join(root, 'x.xyz')
    writeFileSync(other, 'x', 'utf8')
    expect(await manager.query('goToDefinition', other, position, root, undefined)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('没有认领 .xyz 的语言服务器'),
    })

    // 掉标记文件：往上找不到项目根（临时目录里不会有 package.json）。
    const bare = mkdtempSync(join(tmpdir(), 'dsc-lsp-bare-'))
    writeFileSync(join(bare, 'b.ts'), 'const b = 1\n', 'utf8')
    try {
      expect(await manager.query('goToDefinition', join(bare, 'b.ts'), position, bare, undefined)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('定不了项目根'),
      })
    } finally {
      rmSync(bare, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }

    expect(await manager.query('goToDefinition', 'relative.ts', position, root, undefined)).toMatchObject({ ok: false })
    expect(file).toContain('a.ts')
  })

  test('PATH 里找不到服务器：原因带安装提示', async () => {
    const { manager, root, file } = project({ id: 'typescript', command: 'no-such-lsp-bin-xyz' })
    const outcome = await manager.query('goToDefinition', file, position, root, undefined)
    expect(outcome).toMatchObject({
      ok: false,
      server: 'typescript',
      reason: expect.stringMatching(/PATH 里找不到 typescript/),
    })
    expect((outcome as { reason: string }).reason).toContain('装法')
  })
})

describe('池化与状态', () => {
  test('查询成功进池；status/servers/canServe 都跟着事实走', async () => {
    const { manager, root, file } = project()
    expect(manager.canServe(file, root)).toBe(true)
    expect(manager.canServe(join(root, 'nope.ts'), root)).toBe(false)

    const outcome = await manager.query('goToDefinition', file, position, root, undefined)
    expect(outcome).toMatchObject({ ok: true, kind: 'locations', server: 'fake', root })

    const status = manager.status()[0]!
    expect(status).toMatchObject({ id: 'fake', available: true, instances: 1, roots: [root], brokenSeconds: null })
    expect(status).not.toHaveProperty('problem')

    const info = manager.servers()[0]!
    expect(info).toMatchObject({ id: 'fake', available: true })

    manager.dispose()
    expect(manager.status()[0]).toMatchObject({ instances: 0 })
    expect(await manager.query('goToDefinition', file, position, root, undefined)).toMatchObject({
      ok: false,
      reason: 'LSP 管理器已经收掉了',
    })
  })

  test('诊断：推来的诊断转成结果；等不到明说「没给出诊断」', async () => {
    const { manager, root, file } = project()
    const pushed = await manager.diagnostics(file, root, 'abcd', undefined)
    expect(pushed).toMatchObject({ ok: true, server: 'fake', root })
    if (pushed.ok) expect(pushed.diagnostics[0]).toMatchObject({ message: 'len:4' })

    const stale = project({ args: [fixture, 'stale'] }, { diagnosticsWaitMs: 250 })
    const missed = await stale.manager.diagnostics(stale.file, stale.root, undefined, undefined)
    expect(missed).toMatchObject({ ok: false, reason: expect.stringContaining('没给出诊断') })
  })

  test('同一个 (服务器, 根) 的查询串行：两条并发不重叠', async () => {
    const { manager, root, file } = project({ args: [fixture, 'slow'] })
    const started = Date.now()
    const [first, second] = await Promise.all([
      manager.query('goToDefinition', file, position, root, undefined),
      manager.query('goToDefinition', file, position, root, undefined),
    ])
    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({ ok: true })
    // 每条 150ms：串行至少 300ms；并发会明显更短。
    expect(Date.now() - started).toBeGreaterThanOrEqual(280)
    expect(manager.status()[0]).toMatchObject({ instances: 1 })
  })
})

describe('失败与退避', () => {
  test('服务器中途退出：这次查询失败并带 stderr，下一次直接按破键拒绝', async () => {
    const { manager, root, file } = project({ args: [fixture, 'die'] })
    const first = await manager.query('goToDefinition', file, position, root, undefined)
    expect(first).toMatchObject({ ok: false, server: 'fake', reason: expect.stringContaining('没成') })
    expect((first as { stderr?: string }).stderr).toContain('boom')

    const second = await manager.query('goToDefinition', file, position, root, undefined)
    expect(second).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/最近起不来，先不重试/),
    })
    const status = manager.status()[0]!
    expect(status.brokenSeconds).toBeGreaterThan(0)
    expect(status.problem).toContain('进程退出')
    expect(manager.canServe(file, root)).toBe(false)
  })

  test('非致命失败（服务器说不支持）不记破键、不杀实例', async () => {
    const { manager, root, file } = project({ args: [fixture, 'no-hover'] })
    const first = await manager.query('hover', file, position, root, undefined)
    expect(first).toMatchObject({ ok: false, reason: expect.stringContaining('没声明支持 hover') })
    expect(manager.canServe(file, root)).toBe(true)
    expect(manager.status()[0]).toMatchObject({ instances: 1, brokenSeconds: null })
  })
})

describe('idle 回收', () => {
  test('超过 idle 没用过的实例被收掉；有活的时候不动', async () => {
    const { manager, root, file } = project({}, {}, { idleTimeoutMs: () => 300 })
    await manager.query('goToDefinition', file, position, root, undefined)
    expect(manager.status()[0]).toMatchObject({ instances: 1 })

    // 立刻扫一遍：还在 idle 窗口里，不该被收。
    await manager.sweepIdle()
    expect(manager.status()[0]).toMatchObject({ instances: 1 })

    await new Promise((resolve) => setTimeout(resolve, 400))
    await manager.sweepIdle()
    expect(manager.status()[0]).toMatchObject({ instances: 0 })
  })
})
