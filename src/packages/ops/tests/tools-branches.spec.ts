/**
 * ops 工具层（`tools.ts`）与调用层（`worker.ts`）的补缺口测试。
 *
 * 被测协议的另一半是外部 Rust worker 二进制。这里用**跨平台的假 worker**顶替它：
 * 起 `process.execPath`（node），用 `NODE_OPTIONS=--require <脚本>` 预载一个脚本，
 * 脚本同步读走 stdin 上的 JSON 请求、按请求里的 tool 回一段 JSON。这样走的是真的
 * `child_process.spawn` / stdin-stdout / 退出码路径，只把「Rust 那半」换成替身。
 *
 * 断言两层：工具层发出的请求参数（假 worker 把它记到文件里）与渲染给模型的文字。
 *
 * @module @pneuma/ops/tests/tools-branches
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, parse } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

/** 假 worker 的源码：同步读 stdin（抢在 node「把 stdin 当脚本」之前），按 mode 回包。 */
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
    if (error.code === 'EOF') break
    throw error
  }
  if (read === 0) break
  chunks.push(Buffer.from(buffer.subarray(0, read)))
}
const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const request = envelope.request
const args = request.args || {}
const mode = process.env.DSC_FAKE_OPS_MODE || 'ok'

const log = process.env.DSC_FAKE_OPS_LOG
if (log) fs.appendFileSync(log, JSON.stringify({ tool: request.tool, args, readOnly: request.read_only }) + '\\n')

const path = typeof args.path === 'string' ? args.path : '/tmp/fake'
const revision = '0123456789abcdef'

if (mode === 'hang') {
  // 一直活着，等外层超时或取消来杀。
  setInterval(() => {}, 1000)
} else if (mode === 'bad-json') {
  fs.writeSync(1, 'this is not json')
  process.exit(0)
} else if (mode === 'array') {
  fs.writeSync(1, '[]')
  process.exit(0)
} else if (mode === 'empty') {
  process.exit(0)
} else if (mode === 'code124') {
  process.exit(124)
} else if (mode === 'exit3') {
  fs.writeSync(2, 'worker crashed: detail line')
  process.exit(3)
} else if (mode === 'big') {
  fs.writeSync(1, JSON.stringify({ status: 'ok', blob: 'x'.repeat(200000) }))
  process.exit(0)
} else {
  let outcome
  if (mode === 'absent') {
    outcome = { status: 'ok', path, exists: false }
  } else if (mode === 'no-revision') {
    outcome = { status: 'ok', path, exists: true, bytes: 3 }
  } else if (mode === 'failure') {
    outcome = { error: { code: 'DENIED', effectState: 'none', message: '这个路径被拒了' } }
  } else if (mode === 'partial-failure') {
    const failure = { code: 'TAIL_BROKEN', effectState: 'partial', message: '后面坏了' }
    outcome = request.tool === 'read_table'
      ? { status: 'ok', path, format: 'csv', columns: ['a'], rowCount: 1, items: [{ row: 1, cells: ['x'] }], total: 1, error: failure }
      : { status: 'ok', path, items: [{ path, items: [{ line: 1, text: '已解析的部分' }], lineCount: 1, complete: false }], error: failure }
  } else if (request.tool === 'stat') {
    outcome = { status: 'ok', path, exists: true, bytes: 12, lineCount: 2, revision, modifiedMs: 1700000000000, readonly: false }
  } else if (request.tool === 'inspect_local_file') {
    outcome = { status: 'ok', path, items: [{ line: 1, text: '第一行' }], lineCount: 2, complete: false, nextOffset: 2, revision }
  } else if (request.tool === 'read_files') {
    const files = Array.isArray(args.files) ? args.files : []
    outcome = { status: 'ok', items: files.map((file) => ({ path: file.path, items: [{ line: 1, text: 'x' }], lineCount: 1, complete: true })) }
  } else if (request.tool === 'diff') {
    outcome = { status: 'ok', path, matched: 0, items: [] }
  } else if (request.tool === 'read_table') {
    outcome = { status: 'ok', path, format: 'csv', columns: ['a', 'b'], rowCount: 0, items: [], total: 0 }
  } else if (request.tool === 'read_docx') {
    outcome = { status: 'ok', path, total: 0, items: [] }
  } else if (request.tool === 'read_pdf') {
    outcome = { status: 'ok', path, total: 0, items: [] }
  } else {
    outcome = { status: 'ok', dryRun: args.dryRun === true, items: [{ path, revisionBefore: revision, revisionAfter: 'fedcba9876543210', bytesBefore: 3, bytesAfter: 5 }] }
  }
  fs.writeSync(1, JSON.stringify({ ...outcome, echo: { tool: request.tool, args } }))
  process.exit(0)
}
`

const home = createTempDir('dsc-ops-branches-home-')
process.env['DSC_HOME'] = home
const work = createTempDir('dsc-ops-branches-work-')
const preload = join(work, 'fake-ops-worker.cjs')
writeFileSync(preload, FAKE_WORKER_SOURCE, 'utf8')
/** NODE_OPTIONS 里的路径统一用正斜杠：Windows 反斜杠在转义解析里会掉。 */
const NODE_OPTIONS = `--require "${preload.replace(/\\/g, '/')}"`
const LOG = join(work, 'requests.jsonl')

const toolsModule = await import('../tools.js')
const workerModule = await import('../worker.js')

const options = { file: process.execPath, timeoutMs: 10_000, maxBytes: 64 * 1024 }
const entries = toolsModule.createOpsTools(options)
const byName = (name: string) => {
  const found = entries.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`没有工具 ${name}`)
  return found
}
const ctx = { cwd: work, signal: new AbortController().signal, sessionId: 'ops-branches', sessionPath: join(work, 's.jsonl') }

let savedNodeOptions: string | undefined
let savedMode: string | undefined

/** 在「假 worker 生效」的环境里跑一段。 */
async function withFakeWorker<T>(mode: string, run: () => Promise<T>): Promise<T> {
  savedNodeOptions = process.env['NODE_OPTIONS']
  savedMode = process.env['DSC_FAKE_OPS_MODE']
  process.env['NODE_OPTIONS'] = NODE_OPTIONS
  process.env['DSC_FAKE_OPS_MODE'] = mode
  process.env['DSC_FAKE_OPS_LOG'] = LOG
  rmSync(LOG, { force: true })
  try {
    return await run()
  } finally {
    if (savedNodeOptions === undefined) delete process.env['NODE_OPTIONS']
    else process.env['NODE_OPTIONS'] = savedNodeOptions
    if (savedMode === undefined) delete process.env['DSC_FAKE_OPS_MODE']
    else process.env['DSC_FAKE_OPS_MODE'] = savedMode
    delete process.env['DSC_FAKE_OPS_LOG']
  }
}

/** 读假 worker 收到的请求。 */
function loggedRequests(): Array<{ tool: string; args: Record<string, unknown>; readOnly: boolean }> {
  if (!existsSync(LOG)) return []
  return readFileSync(LOG, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { tool: string; args: Record<string, unknown>; readOnly: boolean })
}

afterEach(() => {
  rmSync(LOG, { force: true })
})

afterAll(() => {
  // Windows 上刚被杀掉的子进程句柄可能还没释放：清理失败交给系统临时目录兜底。
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // 忽略
  }
})

describe('十三个工具的成功路径（真 spawn 假 worker）', () => {
  test('七个只读工具都走通，结果文字非空', async () => {
    await withFakeWorker('ok', async () => {
      const inspect = await byName('ops_inspect_local_file').run(
        { path: 'a.txt', offset: 1, limit: 5, view: 'hex' },
        ctx,
      )
      expect(String(inspect)).toContain('第一行')
      expect(String(inspect)).toContain('续读用 offset=2')

      const readFiles = await byName('ops_read_files').run(
        { files: [{ path: 'a.txt', offset: 1, limit: 2 }, { path: 'b.txt' }] },
        ctx,
      )
      expect(String(readFiles)).toContain('文件：' + join(work, 'a.txt'))

      expect(String(await byName('ops_stat').run({ path: 'a.txt' }, ctx))).toContain('存在：是')
      expect(String(await byName('ops_diff').run({ path: 'a.txt', content: 'x' }, ctx))).toContain('没有差异')
      expect(
        String(
          await byName('ops_read_table').run(
            { path: 'a.csv', format: 'csv', encoding: 'utf-8', header: false, offset: 1, limit: 200 },
            ctx,
          ),
        ),
      ).toContain('表格：')
      expect(String(await byName('ops_read_docx').run({ path: 'a.docx', offset: 1, limit: 5 }, ctx))).toContain('文档：')
      expect(String(await byName('ops_read_pdf').run({ path: 'a.pdf', offset: 1, limit: 5 }, ctx))).toContain('PDF：')

      // 请求参数确实进了 worker（不是拼在工具层就丢了）。
      const requests = loggedRequests()
      expect(requests.find((item) => item.tool === 'inspect_local_file')?.args).toMatchObject({ offset: 1, limit: 5, view: 'hex' })
      expect(requests.find((item) => item.tool === 'read_files')?.readOnly).toBe(true)
      expect(requests.find((item) => item.tool === 'read_table')?.args).toMatchObject({ format: 'csv', encoding: 'utf-8', header: false, offset: 1, limit: 200 })
    })
  })

  test('六个写类工具都走通：带修订锚、建父目录、预演不改盘', async () => {
    await withFakeWorker('ok', async () => {
      const target = join(work, 'nested', 'write.txt')
      const written = await byName('ops_write_file').run({ path: target, content: 'hello', expectedRevision: 'abc' }, ctx)
      expect(String(written)).toContain('改动 1 个文件')
      expect(existsSync(join(work, 'nested'))).toBe(true)

      const edited = await byName('ops_edit_file').run(
        { path: target, edits: [{ oldText: 'hello', newText: 'hi' }], expectedRevision: 'abc' },
        ctx,
      )
      expect(String(edited)).toContain(join(work, 'nested', 'write.txt'))

      // copy / move：目标父目录不存在时工具层先建出来。
      const copied = await byName('ops_copy').run(
        { path: target, to: join(work, 'dst', 'copy.txt'), expectedRevision: 'abc' },
        ctx,
      )
      expect(String(copied)).toContain(target)
      const moved = await byName('ops_move').run(
        { path: target, to: join(work, 'dst', 'moved.txt'), expectedRevision: 'abc' },
        ctx,
      )
      expect(String(moved)).toContain(target)

      expect(String(await byName('ops_remove').run({ path: target, expectedRevision: 'abc' }, ctx))).toContain('改动 1 个文件')

      const replaced = await byName('ops_replace').run(
        { path: join(work, 'tree'), pattern: 'a', replacement: 'b', glob: ['**/*.ts'], maxReplacements: 5 },
        ctx,
      )
      expect(String(replaced)).toContain('替换')

      // dryRun：请求里带 dryRun、不落盘。
      const dryTarget = join(work, 'dry.txt')
      const dry = await byName('ops_write_file').run({ path: dryTarget, content: 'x', dryRun: true }, ctx)
      expect(String(dry)).toContain('预演')
      expect(existsSync(dryTarget)).toBe(false)

      const requests = loggedRequests()
      // 只有没传 expectedRevision 的写类（这里只有 dryRun 那次）才会先 stat 取锚。
      expect(requests.filter((item) => item.tool === 'stat')).toHaveLength(1)
      expect(requests.find((item) => item.tool === 'write_file')?.args).toMatchObject({ expectedRevision: 'abc', content: 'hello' })
      expect(requests.find((item) => item.tool === 'replace')?.args).toMatchObject({ pattern: 'a', replacement: 'b', glob: ['**/*.ts'], maxReplacements: 5 })
      expect(requests.find((item) => item.tool === 'write_file' && item.args['dryRun'] === true)).toBeDefined()
    })
  })

  test('没传 expectedRevision 时先取一次修订号；文件不存在记 absent', async () => {
    await withFakeWorker('absent', async () => {
      await byName('ops_write_file').run({ path: join(work, 'brand-new.txt'), content: 'x' }, ctx)
      const requests = loggedRequests()
      expect(requests[0]?.tool).toBe('stat')
      expect(requests[1]?.tool).toBe('write_file')
      expect(requests[1]?.args['expectedRevision']).toBe('absent')
    })
  })
})

describe('revisionOf 与 invoke 的失败口径', () => {
  test('取不到修订号：不写，让模型先用 ops_stat 看状态', async () => {
    await withFakeWorker('no-revision', async () => {
      await expect(byName('ops_write_file').run({ path: join(work, 'x.txt'), content: 'x' }, ctx)).rejects.toThrow(
        /取不到目标文件的修订号/,
      )
    })
  })

  test('worker 回失败：普通工具抛错；文档类带已解析内容时按部分成功返回', async () => {
    await withFakeWorker('failure', async () => {
      await expect(byName('ops_inspect_local_file').run({ path: 'a.txt' }, ctx)).rejects.toThrow(/失败：DENIED/)
    })
    await withFakeWorker('partial-failure', async () => {
      const text = String(await byName('ops_read_table').run({ path: 'a.csv' }, ctx))
      expect(text).toContain('x')
      expect(text).toContain('失败：TAIL_BROKEN')
    })
  })

  test('预演时父目录不存在：不建目录、不动 worker，直接说清正式写入会建', async () => {
    await withFakeWorker('ok', async () => {
      const missing = join(work, 'not-yet', 'deep', 'x.txt')
      await expect(byName('ops_write_file').run({ path: missing, content: 'x', dryRun: true }, ctx)).rejects.toThrow(
        /父目录还不存在/,
      )
      // 预演先取了一次修订号（stat），但没有任何写类请求发出。
      expect(loggedRequests().every((item) => item.tool === 'stat')).toBe(true)
      expect(existsSync(join(work, 'not-yet'))).toBe(false)
    })
  })

  test('参数下界：limit 小于 1、maxReplacements 小于 1 都当场报错', async () => {
    await withFakeWorker('ok', async () => {
      await expect(byName('ops_inspect_local_file').run({ path: 'a.txt', limit: 0 }, ctx)).rejects.toThrow(
        /limit 不能小于 1/,
      )
      await expect(
        byName('ops_replace').run({ path: join(work, 'tree2'), pattern: 'a', replacement: 'b', maxReplacements: 0 }, ctx),
      ).rejects.toThrow(/maxReplacements 不能小于 1/)
    })
  })

  test('整树替换的围栏：主目录也拒（不只是盘符根）', async () => {
    const realProfile = process.env['USERPROFILE']
    const realHome = process.env['HOME']
    process.env['USERPROFILE'] = home
    process.env['HOME'] = home
    try {
      await expect(
        byName('ops_replace').run({ path: home, pattern: 'a', replacement: 'b' }, ctx),
      ).rejects.toThrow(/不能对主目录整树替换/)
      expect(() => byName('ops_replace').run({ path: parse(home).root, pattern: 'a', replacement: 'b' }, ctx)).toBeDefined()
    } finally {
      if (realProfile === undefined) delete process.env['USERPROFILE']
      else process.env['USERPROFILE'] = realProfile
      if (realHome === undefined) delete process.env['HOME']
      else process.env['HOME'] = realHome
    }
  })
})

describe('worker 调用层：输出上限、退出码、超时与取消', () => {
  const callOptions = {
    file: process.execPath,
    tool: 'stat',
    args: {} as Record<string, unknown>,
    cwd: work,
    scope: 'ops-branches',
    readOnly: true,
    timeoutMs: 10_000,
    maxBytes: 64 * 1024,
  }

  test('不是 JSON / 不是对象 / 空输出：三种坏回执各给一句「结果不可信」', async () => {
    for (const mode of ['bad-json', 'array', 'empty']) {
      await withFakeWorker(mode, async () => {
        await expect(workerModule.callOpsWorker(callOptions)).rejects.toThrow(/不是 JSON|不是对象/)
      })
    }
  })

  test('worker 自己判超时（退出码 124）与崩溃（退出码 3）分别说清', async () => {
    await withFakeWorker('code124', async () => {
      await expect(workerModule.callOpsWorker(callOptions)).rejects.toThrow(/自己判了超时/)
    })
    await withFakeWorker('exit3', async () => {
      await expect(workerModule.callOpsWorker(callOptions)).rejects.toThrow(/没正常收场（退出码 3）：worker crashed/)
    })
  })

  test('输出超过字节上限：拒绝并提示把范围调小', async () => {
    await withFakeWorker('big', async () => {
      await expect(workerModule.callOpsWorker({ ...callOptions, maxBytes: 1024 })).rejects.toThrow(/输出超过 1024 字节上限/)
    })
  })

  test('运行中被取消 / 超时：各给一句能照做的话', async () => {
    await withFakeWorker('hang', async () => {
      const controller = new AbortController()
      const pending = workerModule.callOpsWorker({ ...callOptions, signal: controller.signal })
      await new Promise((resolve) => setTimeout(resolve, 100))
      controller.abort()
      await expect(pending).rejects.toThrow(/这次调用被取消了/)
    })
    await withFakeWorker('hang', async () => {
      await expect(workerModule.callOpsWorker({ ...callOptions, timeoutMs: 120 })).rejects.toThrow(/毫秒没交结果/)
    })
  })

  test('worker 起不来：spawn 失败折成一句带路径的错', async () => {
    await expect(
      workerModule.callOpsWorker({ ...callOptions, file: join(work, 'no-such-worker-binary') }),
    ).rejects.toThrow(/ops worker 起不来/)
  })

  test('worker 查找：dsh profile 目录里的 dsh-ops 也认；dsc profiles 目录会扫一遍', async () => {
    const fakeHome = createTempDir('dsc-ops-profile-')
    const realProfile = process.env['USERPROFILE']
    const realHome = process.env['HOME']
    const savedWorker = process.env['DSC_OPS_WORKER']
    process.env['USERPROFILE'] = fakeHome
    process.env['HOME'] = fakeHome
    delete process.env['DSC_OPS_WORKER']
    try {
      // DSC_HOME/profiles 下放一个目录：dscProfiles 的 readdir 分支被执行。
      mkdirSync(join(home, 'profiles', 'named'), { recursive: true })
      const target = `${process.platform}-${process.arch}`
      const workerFile = join(fakeHome, '.dsh', 'profiles', 'p1', 'node_modules', 'dsh-ops', 'runtime', target, workerModule.opsWorkerName())
      mkdirSync(join(workerFile, '..'), { recursive: true })
      writeFileSync(workerFile, 'x')
      const found = workerModule.resolveOpsWorker()
      expect(found).toMatchObject({ ok: true, file: workerFile })
      if (found.ok) expect(found.source).toContain('dsh profile')
    } finally {
      if (realProfile === undefined) delete process.env['USERPROFILE']
      else process.env['USERPROFILE'] = realProfile
      if (realHome === undefined) delete process.env['HOME']
      else process.env['HOME'] = realHome
      if (savedWorker === undefined) delete process.env['DSC_OPS_WORKER']
      else process.env['DSC_OPS_WORKER'] = savedWorker
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })
})
