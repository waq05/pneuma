/**
 * ops 的 W14 补缺口测试：不传 expectedRevision 的写类工具、worker 的平台/起不来口径、
 * 以及插件装配时「找到 worker 就整批注册工具」那条成功路径。
 *
 * 假 worker 沿用 `tools-branches.spec.ts` 的做法：起 `process.execPath`，用
 * `NODE_OPTIONS=--require <脚本>` 预载一段同步读 stdin 的脚本顶替 Rust 二进制——
 * 走的是真的 spawn / stdin / 退出码路径，不依赖外部 dsh-ops 二进制。
 *
 * @module @pneuma/ops/tests/w14-worker-paths
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

/** 假 worker：同步读 stdin，按 tool 回一段最小合法回执。 */
const FAKE_WORKER_SOURCE = `
const fs = require('node:fs')
const chunks = []
const buffer = Buffer.alloc(65536)
for (;;) {
  let read = 0
  try {
    read = fs.readSync(0, buffer, 0, buffer.length, null)
  } catch (error) {
    if (error.code === 'EAGAIN') {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
      continue
    }
    break
  }
  if (read === 0) break
  chunks.push(Buffer.from(buffer.subarray(0, read)))
}
const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const request = envelope.request
const path = typeof request.args.path === 'string' ? request.args.path : ''
if (request.tool === 'stat') {
  fs.writeSync(1, JSON.stringify({ status: 'ok', path, exists: true, bytes: 3, lineCount: 1, revision: 'rev-1', readonly: false }))
} else {
  fs.writeSync(1, JSON.stringify({ status: 'ok', path, items: [{ path, revisionBefore: 'rev-1', revisionAfter: 'rev-2', bytesBefore: 3, bytesAfter: 5 }] }))
}
process.exit(0)
`

const home = createTempDir('dsc-ops-w14-home-')
process.env['DSC_HOME'] = home
const work = createTempDir('dsc-ops-w14-work-')
const preload = join(work, 'fake-ops-worker.cjs')
writeFileSync(preload, FAKE_WORKER_SOURCE, 'utf8')
const NODE_OPTIONS = `--require "${preload.replace(/\\/g, '/')}"`
const workerPath = join(work, 'fake-ops-worker.exe')
writeFileSync(workerPath, 'not really an exe: resolveOpsWorker 只认路径存在且是文件', 'utf8')

type OpsMod = typeof import('../worker.js')
type ToolsMod = typeof import('../tools.js')
let workerModule: OpsMod
let toolsModule: ToolsMod

let savedNodeOptions: string | undefined

beforeAll(async () => {
  workerModule = await import('../worker.js')
  toolsModule = await import('../tools.js')
})

afterEach(() => {
  if (savedNodeOptions === undefined) delete process.env['NODE_OPTIONS']
  else process.env['NODE_OPTIONS'] = savedNodeOptions
  savedNodeOptions = undefined
})

afterAll(() => {
  delete process.env['DSC_HOME']
  delete process.env['DSC_OPS_WORKER']
})

/** 在假 worker 生效的环境里跑一段。 */
async function withFakeWorker<T>(run: () => Promise<T>): Promise<T> {
  savedNodeOptions = process.env['NODE_OPTIONS']
  process.env['NODE_OPTIONS'] = NODE_OPTIONS
  try {
    return await run()
  } finally {
    if (savedNodeOptions === undefined) delete process.env['NODE_OPTIONS']
    else process.env['NODE_OPTIONS'] = savedNodeOptions
  }
}

const ctx = {
  cwd: work,
  signal: new AbortController().signal,
  sessionId: 'ops-w14',
  sessionPath: join(work, 's.jsonl'),
}

/** 工具表。 */
function tools() {
  return toolsModule.createOpsTools({
    file: process.execPath,
    timeoutMs: 10_000,
    maxBytes: 64 * 1024,
  })
}

/** 按名字取工具。 */
function byName(name: string) {
  const found = tools().find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`没有工具 ${name}`)
  return found
}

describe('写类工具不传 expectedRevision：先 stat 取锚再发请求', () => {
  test('edit_file（dryRun）/ copy / move / remove 都补上修订锚', async () => {
    await withFakeWorker(async () => {
      const target = join(work, 'anchor.txt')
      writeFileSync(target, 'hello', 'utf8')
      mkdirSync(join(work, 'dst'), { recursive: true })

      // edit_file：dryRun + 不带 expectedRevision → 先取锚，请求里带 dryRun。
      const edited = await byName('ops_edit_file').run(
        {
          path: target,
          edits: [{ oldText: 'hello', newText: 'hi' }],
          dryRun: true,
        },
        ctx,
      )
      expect(String(edited)).toContain(target)

      // copy / move / remove：同样不带锚，目标父目录由工具层建。
      const copied = await byName('ops_copy').run({ path: target, to: join(work, 'dst', 'copy.txt') }, ctx)
      expect(String(copied)).toContain(target)
      const moved = await byName('ops_move').run({ path: target, to: join(work, 'dst', 'moved.txt') }, ctx)
      expect(String(moved)).toContain(target)
      const removed = await byName('ops_remove').run({ path: join(work, 'dst', 'copy.txt') }, ctx)
      expect(String(removed)).toContain('改动 1 个文件')
    })
  })
})

describe('worker 的平台与起不来口径', () => {
  test('不支持的平台给出带平台名的原因', () => {
    const original = process.platform
    try {
      Object.defineProperty(process, 'platform', {
        value: 'sunos',
        configurable: true,
      })
      const found = workerModule.resolveOpsWorker()
      expect(found).toMatchObject({ ok: false })
      if (!found.ok) expect(found.reason).toContain('sunos')
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      })
    }
  })

  test('spawn 同步抛错（参数非法）折成「起不来 ops worker」', async () => {
    await expect(
      workerModule.callOpsWorker({
        file: 'bad\u0000worker',
        tool: 'stat',
        args: {},
        cwd: work,
        scope: 'ops-w14',
        readOnly: true,
      }),
    ).rejects.toThrow(/起不来 ops worker/)
  })

  test('非 Windows 平台的兜底 kill 走 SIGKILL', async () => {
    const original = process.platform
    try {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      })
      await withFakeWorker(async () => {
        await expect(
          workerModule.callOpsWorker({
            file: process.execPath,
            tool: 'stat',
            args: {},
            cwd: work,
            scope: 'ops-w14',
            readOnly: true,
            timeoutMs: 1,
          }),
        ).rejects.toThrow()
      })
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      })
    }
  })
})

describe('插件装配：找到 worker 就整批注册工具', () => {
  test('DSC_OPS_WORKER 指向真实文件时注册十三个工具并给出系统提示', async () => {
    process.env['DSC_OPS_WORKER'] = workerPath
    const registered: string[] = []
    const systems: string[] = []
    const providedSections: unknown[] = []
    const ctx2 = {
      tools: {
        register: vi.fn((tool: { name: string }) => {
          registered.push(tool.name)
          return () => {}
        }),
      },
      settings: {
        registerSection: vi.fn((section: unknown) => {
          providedSections.push(section)
          return () => {}
        }),
      },
      prompt: { register: vi.fn(() => () => {}) },
      transcript: { system: (text: string) => systems.push(text) },
      effect(execute: () => unknown) {
        const result = execute()
        return typeof result === 'function' ? result : () => {}
      },
    }
    const { opsPlugin } = await import('../index.js')
    try {
      ;(opsPlugin.apply as (ctx: unknown, passed: unknown) => void)(ctx2 as never, {})
      expect(registered).toHaveLength(13)
      expect(registered).toContain('ops_stat')
      expect(systems).toEqual([])
      expect(providedSections).toHaveLength(1)
    } finally {
      delete process.env['DSC_OPS_WORKER']
    }
  })
})
