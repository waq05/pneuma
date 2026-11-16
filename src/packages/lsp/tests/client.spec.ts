/**
 * LSP 客户端与真语言服务器进程的往返（`packages/lsp/client.ts`）。
 *
 * 对端是 `tests/fixtures/fake-lsp-server.mjs`：它按 Content-Length 分帧读 stdin、写
 * stdout，各档模拟真实服务器会出现的现象（推诊断、只支持拉式诊断、编码不符、
 * 不答握手、中途退出、反向请求改文件）。这里钉的是客户端自己的账：
 * 握手、didOpen→请求→didClose、诊断两条路、超时/致命失败、优雅收尾。
 *
 * @module dsc/packages/lsp/tests/client.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { defaultRuntimeValues, LspInstance, type LspQueryError, type LspRuntimeValues } from '../client.js'
import type { LspServerDef } from '../servers.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))

const created: Array<{ instance: LspInstance; root: string }> = []

afterEach(() => {
  for (const { instance, root } of created.splice(0)) {
    try {
      instance.terminateNow()
    } catch {
      // 已经退了的实例再收一次无害
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** 造一个实例：真 node 进程跑假服务器，时间预算压到毫秒级。 */
function makeInstance(
  mode: string,
  values: Partial<LspRuntimeValues> = {},
): { instance: LspInstance; file: string; exits: string[]; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsc-lsp-client-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  const file = join(root, 'src', 'a.ts')
  writeFileSync(file, 'const a = 1\n', 'utf8')
  const exits: string[] = []
  const server: LspServerDef = {
    id: `fake-${mode}`,
    languageId: 'typescript',
    extensions: ['.ts'],
    command: 'node',
    args: [fixture, mode],
    markers: ['package.json'],
  }
  const instance = new LspInstance({
    server,
    root,
    target: { file: process.execPath, shell: false },
    env: { ...process.env } as Record<string, string>,
    values: {
      ...defaultRuntimeValues(),
      initializeTimeoutMs: 4_000,
      requestTimeoutMs: 4_000,
      diagnosticsWaitMs: 600,
      pushSettleMs: 40,
      cancelGraceMs: 100,
      shutdownGraceMs: 1_000,
      ...values,
    },
    onExit: (reason) => exits.push(reason),
  })
  created.push({ instance, root })
  return { instance, file, exits, root }
}

/** 轮询等到条件成立。 */
async function until(probe: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const position = { line: 0, character: 0 }

describe('握手与四个查询', () => {
  test('definition/references/hover/implementation 各按协议取回结果；收尾时进程退出', async () => {
    const { instance, file, exits } = makeInstance('ok')

    const definition = await instance.query('goToDefinition', file, position, undefined)
    expect(definition.kind).toBe('locations')
    if (definition.kind === 'locations') {
      expect(definition.locations).toHaveLength(1)
      expect(definition.locations[0]).toMatchObject({ uri: expect.stringMatching(/a\.ts$/) })
    }

    // 假服务器把 includeDeclaration 编码进列号：客户端必须如实带上。
    const references = await instance.query('findReferences', file, position, undefined)
    if (references.kind !== 'locations') throw new Error('findReferences 应返回位置')
    expect(references.locations).toHaveLength(2)
    expect(references.locations[0]!.range.end.character).toBe(7)

    const hover = await instance.query('hover', file, position, undefined)
    expect(hover).toMatchObject({ kind: 'hover', hover: { contents: '## 标题' } })

    const implementation = await instance.query('goToImplementation', file, position, undefined)
    expect(implementation).toMatchObject({ kind: 'locations', locations: [] })

    expect(instance.dead).toBe(false)
    await instance.shutdown()
    expect(instance.dead).toBe(true)
    await until(() => exits.length > 0, '进程退出回调')
  })

  test('服务器没声明 hoverProvider：不读文件，直接给非致命错误', async () => {
    const { instance, file } = makeInstance('no-hover')
    const error = (await instance.query('hover', file, position, undefined).catch((item: unknown) => item)) as LspQueryError
    expect(error).toBeInstanceOf(Error)
    expect(error.fatal).toBe(false)
    expect(error.message).toContain('没声明支持 hover')
  })
})

describe('诊断：推、拉、旧版本', () => {
  test('didOpen 后等服务器推送；内容参数优先于磁盘', async () => {
    const { instance, file } = makeInstance('ok')
    // 传 content='abcd'：假服务器把收到的文本长度写进 message。
    const diagnostics = await instance.diagnostics(file, 'abcd', undefined)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics![0]).toMatchObject({ severity: 1, message: 'len:4', source: 'fake' })
  })

  test('声明了 diagnosticProvider 但服务器不推：主动拉一次', async () => {
    const { instance, file } = makeInstance('pull')
    const diagnostics = await instance.diagnostics(file, undefined, undefined)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics![0]).toMatchObject({ severity: 2, message: 'pull', code: 'P1' })
  })

  test('推送的版本比这次 didOpen 旧：丢掉，等到超时给 null（不是空数组）', async () => {
    const { instance, file } = makeInstance('stale', { diagnosticsWaitMs: 300 })
    expect(await instance.diagnostics(file, undefined, undefined)).toBeNull()
  })
})

describe('失败方向', () => {
  test('握手要求非 utf-16 编码：直接失败并说清原因', async () => {
    const { instance } = makeInstance('utf8')
    await expect(instance.ready).rejects.toThrow(/只支持 utf-16/)
  })

  test('服务器不答 initialize：握手超时，查询跟着失败', async () => {
    const { instance, file } = makeInstance('silent', { initializeTimeoutMs: 200 })
    await expect(instance.query('goToDefinition', file, position, undefined)).rejects.toThrow(/没回/)
  })

  test('请求回 error：消息带 code；错误响应按失败结账', async () => {
    const { instance, file } = makeInstance('error')
    await expect(instance.query('goToDefinition', file, position, undefined)).rejects.toThrow(
      /服务器不认识这个文件（code -32001）/,
    )
  })

  test('收到 didOpen 就退出：请求结账为致命失败，stderr 尾巴留在实例上', async () => {
    const { instance, file, exits } = makeInstance('die')
    await expect(instance.query('goToDefinition', file, position, undefined)).rejects.toThrow()
    expect(instance.dead).toBe(true)
    expect(instance.stderrTail()).toContain('boom')
    await until(() => exits.length > 0, '退出回调')
  })

  test('服务器的反向请求：拒绝 workspace/applyEdit，其余回 null', async () => {
    const { instance, file } = makeInstance('apply')
    const definition = await instance.query('goToDefinition', file, position, undefined)
    if (definition.kind !== 'locations') throw new Error('应返回位置')
    // 假服务器发现 applyEdit 回了 -32601、configuration 回了 null，才把列写成 501。
    expect(definition.locations[0]!.range.end.character).toBe(501)
  })
})
