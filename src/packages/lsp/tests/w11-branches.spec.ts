/**
 * LSP 包的补盲（`packages/lsp/**`）：纯算法（行号位移、URI 判定、分帧）、可执行文件
 * 解析的边角，以及管理器在启动失败/破键过期/并发冷启动上的分支。
 *
 * 管理器那条仍用真 node 子进程跑 `tests/fixtures/fake-lsp-server.mjs`（`silent` 模式
 * 不答握手），时间预算压到毫秒级；不真起语言服务器。
 *
 * @module dsc/packages/lsp/tests/w11-branches.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { defaultRuntimeValues, LspInstance, type LspRuntimeValues } from '../client.js'
import { encodeMessage, MAX_MESSAGE_BYTES, MessageDecoder, StderrTail } from '../framing.js'
import { buildLineShift, shiftDiagnostics } from '../line-shift.js'
import { LspManager } from '../manager.js'
import { findProjectRoot, resolveExecutable } from '../servers.js'
import type { LspServerDef } from '../servers.js'
import { displayPath, pathWithin, samePath, toProtocolPosition, uriToPath } from '../uri.js'

const WIN = process.platform === 'win32'
const fixture = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))

const tempDirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch {
      // Windows 上子进程刚退出可能还攥着 cwd
    }
  }
})

// ── line-shift ────────────────────────────────────────────────────────────────

describe('line-shift 补盲', () => {
  test('负行号给 null；空文本与空到非空', () => {
    const changed = buildLineShift('a', 'b')
    expect(changed(-1)).toBeNull()

    const same = buildLineShift('', '')
    expect(same(0)).toBe(0)

    const fromEmpty = buildLineShift('', 'a\nb')
    expect(fromEmpty(0)).toBe(1)
    const toEmpty = buildLineShift('a\nb', '')
    expect(toEmpty(0)).toBeNull()
    expect(toEmpty(1)).toBeNull()
  })

  test('LCS 命中相等行：中间段按对齐结果平移，缺失行出局', () => {
    const shift = buildLineShift('a\nb\nc\nd\ne', 'x\nb\ny\nd\nz')
    expect([0, 1, 2, 3, 4].map((line) => shift(line))).toEqual([null, 1, null, 3, null])
  })

  test('LCS 的 else 分支：后一行才相等时向前跳过 b', () => {
    const shift = buildLineShift('b', 'x\nb')
    expect(shift(0)).toBe(1)
  })

  test('超过 100 万格退回贪心：完全不同的文本全部出局', () => {
    const pre = Array.from({ length: 1001 }, (_, i) => `pre-${String(i)}`).join('\n')
    const post = Array.from({ length: 1001 }, (_, i) => `post-${String(i)}`).join('\n')
    const shift = buildLineShift(pre, post)
    expect(shift(0)).toBeNull()
    expect(shift(1000)).toBeNull()
  })

  test('贪心在超大文本里仍按从左到右配对', () => {
    const lines = Array.from({ length: 1001 }, (_, i) => `line-${String(i)}`)
    const pre = lines.join('\n')
    const post = [...lines].reverse().join('\n')
    const shift = buildLineShift(pre, post)
    // 第 0 行（line-0）在 post 的最后一个位置。
    expect(shift(0)).toBe(1000)
  })

  test('shiftDiagnostics：end 映射不到就跟随 start', () => {
    const out = shiftDiagnostics(
      [
        {
          severity: 1,
          message: 'x',
          range: { start: { line: 3, character: 1 }, end: { line: 9, character: 2 } },
        },
      ],
      (line) => (line === 3 ? 5 : null),
    )
    expect(out[0]?.range).toEqual({ start: { line: 5, character: 1 }, end: { line: 5, character: 2 } })
  })
})

// ── uri ───────────────────────────────────────────────────────────────────────

describe('uri 判定补盲', () => {
  test('解不出来的 URI：samePath / pathWithin 都判 false，displayPath 原样返回', () => {
    expect(samePath('file:///a%2Fb.ts', '/a/b.ts', WIN)).toBe(false)
    expect(pathWithin('file:///a%2Fb.ts', '/a/b.ts', WIN)).toBe(false)
    expect(displayPath('file:///a%2Fb.ts', '/root', WIN)).toBe('file:///a%2Fb.ts')
  })

  test('displayPath：Windows 盘符不当 scheme；工作区外给绝对路径并统一斜杠', () => {
    if (WIN) {
      expect(displayPath('D:\\root\\src\\a.ts', 'D:\\root\\src', true)).toBe('a.ts')
      expect(displayPath('D:\\other\\a.ts', 'D:\\root\\src', true)).toBe('D:/other/a.ts')
      expect(displayPath('C:/root/src', 'C:\\root\\src', true)).toBe('.')
    } else {
      expect(displayPath('/root/src/a.ts', '/root/src', false)).toBe('a.ts')
    }
  })

  test('uriToPath：非 file / 畸形转义都 undefined；合法 URI 解出路径', () => {
    expect(uriToPath('untitled:Untitled-1')).toBeUndefined()
    expect(uriToPath('file:///a%5Cb.ts', true)).toBeUndefined()
    const path = WIN ? 'C:\\work\\a.ts' : '/work/a.ts'
    const uri = WIN ? 'file:///C:/work/a.ts' : 'file:///work/a.ts'
    expect(uriToPath(uri, WIN)).toBe(path)
  })

  test('toProtocolPosition：非整数与小数都拒', () => {
    expect(() => toProtocolPosition(1.5, 1)).toThrow(/一基正整数/)
    expect(() => toProtocolPosition(1, Number.NaN)).toThrow(/一基正整数/)
  })
})

// ── framing ───────────────────────────────────────────────────────────────────

describe('framing 补盲', () => {
  test('头没有分隔符但已经超过上限：抛错（不是无限等）', () => {
    const decoder = new MessageDecoder()
    expect(() => decoder.push(Buffer.alloc(64 * 1024 + 1, 0x78))).toThrow(/仍没有出现/)
  })

  test('分隔符出现在 64KB 之后：抛「头超限」', () => {
    const decoder = new MessageDecoder()
    const chunk = Buffer.from(`${'x'.repeat(64 * 1024 + 8)}\r\n\r\n`, 'ascii')
    expect(() => decoder.push(chunk)).toThrow(/超过 .* 字节的上限/)
  })

  test('Content-Length 非法 / 缺失 / 正文超限 / 正文没到齐 / 正文不是 JSON', () => {
    expect(() => new MessageDecoder().push(Buffer.from('Content-Length: -1\r\n\r\n', 'ascii'))).toThrow(/不是非负整数/)
    expect(() => new MessageDecoder().push(Buffer.from('X-Test: 1\r\n\r\n', 'ascii'))).toThrow(/没有 Content-Length/)
    expect(() => new MessageDecoder(4).push(Buffer.from('Content-Length: 9\r\n\r\n123456789', 'ascii'))).toThrow(/超过 4 字节/)
    const partial = new MessageDecoder()
    expect(partial.push(Buffer.from('Content-Length: 5\r\n\r\nab', 'ascii'))).toEqual([])
    expect(partial.pending).toBeGreaterThan(0)
    expect(() => new MessageDecoder().push(Buffer.from('Content-Length: 3\r\n\r\nnope', 'ascii'))).toThrow(/不是合法 JSON/)
  })

  test('encodeMessage：正文超过 16MB 直接拒', () => {
    expect(() => encodeMessage({ text: 'x'.repeat(MAX_MESSAGE_BYTES) })).toThrow(/超过/)
  })

  test('StderrTail：超过上限只留尾部；字符串与 Buffer 都收；tailLines 跳过空行', () => {
    const tail = new StderrTail(4)
    tail.push('abcdef')
    expect(tail.text()).toBe('cdef')

    const textTail = new StderrTail(64)
    textTail.push(Buffer.from('\n\n第一行\n第二行\n', 'utf8'))
    expect(textTail.tailLines(1)).toBe('第二行')
    expect(textTail.tailLines(5)).toContain('第一行')
    textTail.clear()
    expect(textTail.text()).toBe('')
  })
})

// ── servers ───────────────────────────────────────────────────────────────────

describe('servers 补盲', () => {
  test('环境变量名大小写不敏感（Windows）；目录候选不算可执行文件', () => {
    const dir = tempDir('dsc-lsp-servers-')
    const name = WIN ? 'tool.exe' : 'tool'
    const file = join(dir, name)
    writeFileSync(file, 'x', 'utf8')
    if (WIN) {
      const found = resolveExecutable('tool', { path: dir }, '')
      expect(found?.file.toLowerCase()).toBe(file.toLowerCase())
      expect(found?.shell).toBe(false)
    }
    expect(resolveExecutable(dir, {}, '')).toBeUndefined()
  })

  test('findProjectRoot：maxWalk 为 0 时一步都不走', () => {
    const dir = tempDir('dsc-lsp-root-')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{}', 'utf8')
    expect(findProjectRoot(join(dir, 'src', 'a.ts'), ['package.json'], 0)).toBeUndefined()
    expect(findProjectRoot(join(dir, 'src', 'a.ts'), ['package.json'], 10)).toBe(dir)
  })
})

// ── manager ───────────────────────────────────────────────────────────────────

interface ManagerSetup {
  manager: LspManager
  root: string
  file: string
}

const managers: LspManager[] = []

function project(mode: string, values: Partial<LspRuntimeValues> = {}, brokenRetryMs = 60_000): ManagerSetup {
  const root = tempDir('dsc-lsp-w11-')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"demo"}\n', 'utf8')
  const file = join(root, 'src', 'a.ts')
  writeFileSync(file, 'const a = 1\n', 'utf8')
  const server: LspServerDef = {
    id: 'fake',
    languageId: 'typescript',
    extensions: ['.ts'],
    command: process.execPath,
    args: [fixture, mode],
    markers: ['package.json'],
  }
  const manager = new LspManager({
    servers: () => [server],
    idleTimeoutMs: () => 60_000,
    baseCwd: () => root,
    env: () => ({ ...process.env } as Record<string, string>),
    values: () => ({ ...defaultRuntimeValues(), initializeTimeoutMs: 200, requestTimeoutMs: 1_000, brokenRetryMs, ...values }),
  })
  managers.push(manager)
  return { manager, root, file }
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
})

const position = { line: 0, character: 0 }

describe('manager 失败与过期分支', () => {
  test('握手失败：原因带 stderr 位置；破键里的 diagnostics 直接拒', async () => {
    const { manager, root, file } = project('silent')
    const first = await manager.query('goToDefinition', file, position, root, undefined)
    expect(first).toMatchObject({
      ok: false,
      server: 'fake',
      reason: expect.stringContaining('起不来'),
    })

    const diagnostics = await manager.diagnostics(file, root, undefined, undefined)
    expect(diagnostics).toMatchObject({ ok: false, reason: expect.stringContaining('最近起不来') })
  })

  test('并发冷启动共用同一次启动：两条都成功且只有一个实例', async () => {
    const { manager, root, file } = project('ok')
    const [first, second] = await Promise.all([
      manager.query('goToDefinition', file, position, root, undefined),
      manager.query('goToDefinition', file, position, root, undefined),
    ])
    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({ ok: true })
    expect(manager.status()[0]).toMatchObject({ instances: 1 })
  })

  test('dispose 之后 sweepIdle 安静返回', async () => {
    const { manager } = project('ok')
    manager.dispose()
    await expect(manager.sweepIdle()).resolves.toBeUndefined()
  })
})

describe('LspInstance 启动失败', () => {
  test('可执行文件不存在：子进程 error 走 fail/finish，查询拿到致命错误', async () => {
    const root = tempDir('dsc-lsp-inst-')
    mkdirSync(join(root, 'src'), { recursive: true })
    const file = join(root, 'src', 'a.ts')
    writeFileSync(file, 'const a = 1\n', 'utf8')
    const exits: string[] = []
    const instance = new LspInstance({
      server: {
        id: 'missing',
        languageId: 'typescript',
        extensions: ['.ts'],
        command: join(root, 'no-such-lsp.exe'),
        args: [],
        markers: [],
      },
      root,
      target: { file: join(root, 'no-such-lsp.exe'), shell: false },
      env: { ...process.env } as Record<string, string>,
      values: { ...defaultRuntimeValues(), initializeTimeoutMs: 3_000 },
      onExit: (reason) => exits.push(reason),
    })
    try {
      const error = (await instance.query('goToDefinition', file, position, undefined).catch((item: unknown) => item)) as Error
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toContain('语言服务器进程起不来')
    } finally {
      instance.terminateNow()
    }
    expect(exits.length).toBeGreaterThan(0)
  })
})
