/**
 * ops 插件的外壳自检：worker 能不能被独立驱动、十一个面的参数与渲染对不对（迁自 `scripts/ops-test.mjs`）。
 *
 * ## 被测的是什么
 *
 *   [1] 找得到 worker，并且**不依赖 dsh 的进程服务**就能跑通一次读；
 *   [2] read_files / stat / diff / read_table 四种返回形状都对得上（行号、修订、单元格）；
 *   [3] 只读模式下写类工具被 worker 当场拒（多一道闸，不靠调用方自觉）；
 *   [4] 工具层先过读禁：`.env` 这类文件在到达 worker 之前就被拦下；
 *   [5] 渲染把「还有多少没显示 / 续读写法」写进结果，模型不会把半截当全文；
 *   [6] diff 的 offset 是 0 起，分页要说出来；[7] hex 视图不拿文本行数冒充十六进制行；
 *   [8] 写类六件：修订锚、预演、先读后写；[9] 修订锚真的能挡并发覆盖；
 *   [10] 复制/移动的写目标按 to 过闸；[11] 审批卡的「将做的改动」认得 ops 写类。
 *
 * ## worker 依赖与 skip 口径（不静默绿）
 *
 * 被测协议的另一半是 **dsh-ops 的真 worker 二进制**，本仓库造不了等效假件——假 worker
 * 等于测自己的实现，比明确 skip 更假。所以：从**真实主目录**（setup 透传的
 * `__DSC_REAL_HOME__`，不是临时 HOME）找已安装的 worker；找到就全量跑，找不到整段
 * `describe.skip` 并在输出里写明原因。CI 无 worker 时这一层不设防，缺口记在
 * `docs/testing-backlog.md`（B24）。
 *
 * ## 隔离与平面
 *
 * 临时工作目录夹具；真实 `~/.dsc` 一个字节都不动（worker 查找只读）。spec 直接 import ops
 * 包的源码模块（resolveOpsWorker / callOpsWorker / createOpsTools / render*），不起内核——
 * 这层不依赖装配。探针里 `createOpsTools` 传的 `readOnly: () => false` 其实是**无效参数**
 * （OpsToolOptions 没这个字段，读写由每个工具自己的 mutating 决定），迁移时删掉。
 *
 * @module @pneuma/ops/ops-worker.int.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

type WorkerModule = typeof import('./worker.js')
type RenderModule = typeof import('./render.js')
type OpsTool = ReturnType<typeof import('./tools.js')['createOpsTools']>[number]

/** worker 的回执是宽松的 Record；探针按 JS 直取字段，这里收窄成断言可用的读法。 */
type Outcome = Record<string, unknown>
/** 非 object 一律当空对象（worker 崩了时 error 可能是 undefined）。 */
const rec = (value: unknown): Outcome => (value !== null && typeof value === 'object' ? (value as Outcome) : {})
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** 真实主目录：integration 的 setup 在换 HOME 之前存在 globalThis 上。 */
function realHome(): string {
  return (globalThis as { __DSC_REAL_HOME__?: string }).__DSC_REAL_HOME__ ?? ''
}

/**
 * 找已安装的 dsh-ops worker（探针同款两处：`~/.dsc/plugins` 与 dsh 的 profiles）。
 * 环境里已带 `DSC_OPS_WORKER` 时直接认它。
 */
function findInstalledWorker(): string {
  const fromEnv = process.env['DSC_OPS_WORKER'] ?? ''
  if (fromEnv !== '') return fromEnv
  const home = realHome()
  if (home === '') return ''
  const target = `${process.platform}-${process.arch}`
  const workerName = process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker'
  const pluginCopy = join(home, '.dsc', 'plugins', 'node_modules', 'dsh-ops', 'runtime', target, workerName)
  if (existsSync(pluginCopy)) return pluginCopy
  let names: string[] = []
  try {
    names = readdirSync(join(home, '.dsh', 'profiles'))
  } catch {
    return ''
  }
  for (const name of names) {
    const file = join(home, '.dsh', 'profiles', name, 'node_modules', 'dsh-ops', 'runtime', target, workerName)
    if (existsSync(file)) return file
  }
  return ''
}

const WORKER = findInstalledWorker()
const d = WORKER === '' ? describe.skip : describe

let worker: WorkerModule
let render: RenderModule
let makeTools: typeof import('./tools.js')['createOpsTools']
/** 夹具总目录；失败时留着翻，成功时 afterAll 删。 */
const WORK = mkdtempSync(join(tmpdir(), 'dsc-ops-worker-'))
/** 共享的调用基参（探针同款）。 */
let base: { file: string; cwd: string; scope: string; readOnly: true; timeoutMs: number }
/** 工具 run 的 ctx（web-search spec 同款四字段裸对象）。 */
const toolCtx = { cwd: WORK, signal: new AbortController().signal, sessionId: 'sess-ops-spec', sessionPath: '' }
/** [1][2][5] 段的共享结果，后面渲染段复用，不重复起 worker。 */
let inspected: Outcome
let many: Outcome
let table: Outcome

let textFile = ''
let csvFile = ''

beforeAll(async () => {
  if (WORKER === '') {
    console.warn('[ops-worker.int.spec] 跳过：真实主目录里没找到 dsh-ops worker（缺口记 backlog B24）')
    return
  }
  process.env['DSC_OPS_WORKER'] = WORKER
  worker = await import('./worker.js')
  render = await import('./render.js')
  makeTools = (await import('./tools.js')).createOpsTools
  const found = worker.resolveOpsWorker()
  if (!found.ok) throw new Error(`DSC_OPS_WORKER 指向的 worker 不可用：${found.reason}`)
  base = { file: found.file, cwd: WORK, scope: 'sess-ops-spec', readOnly: true, timeoutMs: 20_000 }
  textFile = join(WORK, 'sample.txt')
  writeFileSync(textFile, `${Array.from({ length: 30 }, (_, i) => `line-${String(i + 1)}`).join('\n')}\n`, 'utf8')
  csvFile = join(WORK, 'table.csv')
  writeFileSync(csvFile, 'name,age\n"a, b",3\n"multi\nline",4\n', 'utf8')
})

afterAll(() => {
  // 成功时删夹具；失败现场留着（与 harness 临时 HOME 同一约定）。
  try {
    rmSync(WORK, { recursive: true, force: true })
  } catch {
    // 删不掉不影响结论：临时目录会被系统清。
  }
})

d('ops worker 集成段（真 worker）', () => {
  test('[1] 独立读一次：inspect 的行号、续读位置与修订号都对得上', async () => {
    inspected = rec(
      await worker.callOpsWorker({ ...base, tool: 'inspect_local_file', args: { path: textFile, offset: 1, limit: 3 } }),
    )
    expect(inspected['status'], JSON.stringify(inspected['error'] ?? inspected['status'])).toBe('completed')
    const firstThree = arr(inspected['items'])
    expect(firstThree.length).toBe(3)
    expect(rec(firstThree[0])['line']).toBe(1)
    expect(rec(firstThree[2])['line']).toBe(3)
    expect(inspected['lineCount']).toBe(30)
    expect(inspected['nextOffset']).toBe(4)
    expect(typeof inspected['revision']).toBe('string')
    expect(String(inspected['revision']).length).toBe(64)
  })

  test('[2] read_files / stat / diff / read_table 四种形状', async () => {
    many = rec(
      await worker.callOpsWorker({
        ...base,
        tool: 'read_files',
        args: { files: [{ path: textFile, offset: 1, limit: 2 }, { path: csvFile }] },
      }),
    )
    const manyItems = arr(many['items'])
    expect(manyItems.length).toBe(2)
    expect(arr(rec(manyItems[0])['items']).length).toBe(2)
    expect(rec(manyItems[0])['nextOffset']).toBe(3)

    const st = rec(await worker.callOpsWorker({ ...base, tool: 'stat', args: { path: textFile } }))
    expect(st['exists']).toBe(true)
    expect(st['lineCount']).toBe(30)
    expect(typeof st['bytes']).toBe('number')
    expect(Number(st['bytes'])).toBeGreaterThan(0)
    const missing = rec(await worker.callOpsWorker({ ...base, tool: 'stat', args: { path: join(WORK, 'nope.txt') } }))
    expect(missing['status']).toBe('completed')
    expect(missing['exists']).toBe(false)

    const diffed = rec(
      await worker.callOpsWorker({
        ...base,
        tool: 'diff',
        args: { path: csvFile, content: 'name,age\n"a, b",5\n"multi\nline",4\n' },
      }),
    )
    const diffItems = arr(diffed['items'])
    expect(diffItems.length).toBe(2)
    expect(rec(diffItems[0])['kind']).toBe('remove')
    expect(rec(diffItems[1])['kind']).toBe('add')
    expect(rec(diffItems[0])['line']).toBe(2)

    table = rec(await worker.callOpsWorker({ ...base, tool: 'read_table', args: { path: csvFile } }))
    expect(arr(table['columns']).join('/')).toBe('name/age')
    expect(arr(table['items']).length).toBe(2)
    expect(arr(rec(arr(table['items'])[1])['cells'])[0]).toBe('multi\nline')
  })

  test('[3] 只读模式挡住写类，被拒之后文件不落地', async () => {
    const denied = rec(
      await worker.callOpsWorker({
        ...base,
        tool: 'write_file',
        args: { path: join(WORK, 'x.txt'), content: 'x', expectedRevision: '0'.repeat(64) },
      }),
    )
    expect(rec(denied['error'])['code']).toBe('POLICY_DENIED')
    expect(rec(denied['error'])['reason']).toBe('read-only')
    expect(existsSync(join(WORK, 'x.txt'))).toBe(false)
  })

  test('[4] 工具层读禁：密钥文件在到达 worker 之前就被拦下', async () => {
    const inspectTool = makeTools({ file: base.file, timeoutMs: 20_000, maxBytes: 128 * 1024 }).find(
      (tool) => tool.name === 'ops_inspect_local_file',
    )
    expect(inspectTool).toBeDefined()
    await expect(inspectTool?.run({ path: '.env' }, toolCtx)).rejects.toThrow(/禁止读取/)
  })

  test('[5] 渲染与续读提示', () => {
    expect(inspected).toBeDefined()
    const renderedInspect = render.renderInspect(inspected, { path: textFile, view: 'text' })
    expect(renderedInspect.includes('1\tline-1')).toBe(true)
    expect(renderedInspect.includes('3\tline-3')).toBe(true)
    expect(renderedInspect.includes('共 30 行')).toBe(true)
    expect(renderedInspect.includes('offset=4')).toBe(true)

    expect(table).toBeDefined()
    const renderedTable = render.renderTable(table, { path: csvFile })
    expect(renderedTable.includes('2 列：name / age')).toBe(true)
    expect(renderedTable.includes('1\t["a, b","3"]')).toBe(true)

    expect(many).toBeDefined()
    const renderedMany = render.renderReadFiles(many)
    expect((renderedMany.match(/文件：/g) ?? []).length).toBe(2)
  })

  test('[5b] 全读完之后不再谎报「还有没读完」', async () => {
    const allRead = await worker.callOpsWorker({ ...base, tool: 'read_files', args: { files: [{ path: csvFile }] } })
    expect(render.renderReadFiles(allRead).includes('没读完')).toBe(false)
  })

  test('[6] diff 的 offset 是 0 起，分页要说出来', async () => {
    const content = 'name,age\n"a, b",5\n"multi\nline",4\n'
    const pageFirst = rec(
      await worker.callOpsWorker({ ...base, tool: 'diff', args: { path: csvFile, content, offset: 0, limit: 1 } }),
    )
    expect(rec(arr(pageFirst['items'])[0])['kind']).toBe('remove')
    const pageSecond = rec(
      await worker.callOpsWorker({ ...base, tool: 'diff', args: { path: csvFile, content, offset: 1, limit: 1 } }),
    )
    expect(rec(arr(pageSecond['items'])[0])['kind']).toBe('add')
    const renderedPage = render.renderDiff(pageFirst, { path: csvFile })
    expect(renderedPage.includes('不完整')).toBe(true)
    expect(renderedPage.includes('offset=1')).toBe(true)
  })

  test('[7] hex 视图不拿文本行数冒充十六进制行', async () => {
    const hexed = rec(
      await worker.callOpsWorker({ ...base, tool: 'inspect_local_file', args: { path: textFile, view: 'hex', limit: 4 } }),
    )
    const renderedHex = render.renderInspect(hexed, { path: textFile, view: 'hex' })
    expect(renderedHex.includes('字节')).toBe(true)
    expect(renderedHex.includes('共 30 行')).toBe(false)
  })

  describe('[8]-[10] 写类六件', () => {
    const rwFile = () => join(WORK, 'rw.txt')
    const toolOf = (name: string): OpsTool | undefined =>
      makeTools({ file: base.file, timeoutMs: 20_000, maxBytes: 128 * 1024 }).find((tool) => tool.name === name)

    test('整写预演不落盘、且写明是预演；整写落地', async () => {
      const dryWrite = String(await toolOf('ops_write_file')?.run({ path: rwFile(), content: 'x\n', dryRun: true }, toolCtx))
      expect(existsSync(rwFile())).toBe(false)
      expect(dryWrite).toContain('预演')
      await toolOf('ops_write_file')?.run({ path: rwFile(), content: 'a\nb\nc\n' }, toolCtx)
      expect(readFileSync(rwFile(), 'utf8')).toBe('a\nb\nc\n')
    })

    test('没读过就整写会被拒；读过之后可以整写', async () => {
      const unread = join(WORK, 'unread.txt')
      writeFileSync(unread, 'old\n')
      await expect(toolOf('ops_write_file')?.run({ path: unread, content: 'new\n' }, toolCtx)).rejects.toThrow(/读/)
      await toolOf('ops_inspect_local_file')?.run({ path: unread }, toolCtx)
      await toolOf('ops_write_file')?.run({ path: unread, content: 'new\n' }, toolCtx)
      expect(readFileSync(unread, 'utf8')).toBe('new\n')
    })

    test('编辑：多处替换一次生效，预演不改盘', async () => {
      await toolOf('ops_edit_file')?.run({ path: rwFile(), edits: [{ oldText: 'a', newText: 'A' }, { oldText: 'c', newText: 'C' }] }, toolCtx)
      expect(readFileSync(rwFile(), 'utf8')).toBe('A\nb\nC\n')
      const dryEdit = String(
        await toolOf('ops_edit_file')?.run({ path: rwFile(), edits: [{ oldText: 'b', newText: 'B' }], dryRun: true }, toolCtx),
      )
      expect(dryEdit).toContain('预演')
      expect(readFileSync(rwFile(), 'utf8')).toBe('A\nb\nC\n')
    })

    test('复制落地、目标已存在被拒；移动落地且源没了；删除落地', async () => {
      const copied = join(WORK, 'copied.txt')
      await toolOf('ops_copy')?.run({ path: rwFile(), to: copied }, toolCtx)
      expect(readFileSync(copied, 'utf8')).toBe('A\nb\nC\n')
      await expect(toolOf('ops_copy')?.run({ path: rwFile(), to: copied }, toolCtx)).rejects.toThrow(/./)
      const moved = join(WORK, 'moved.txt')
      await toolOf('ops_move')?.run({ path: copied, to: moved }, toolCtx)
      expect(existsSync(moved)).toBe(true)
      expect(existsSync(copied)).toBe(false)
      await toolOf('ops_remove')?.run({ path: moved }, toolCtx)
      expect(existsSync(moved)).toBe(false)
    })

    test('整目录替换：预演不动盘，生效后按文件数+处数分开说', async () => {
      const repDir = join(WORK, 'rep')
      mkdirSync(repDir, { recursive: true })
      writeFileSync(join(repDir, 'x.md'), 'foo foo\n')
      const repDry = String(
        await toolOf('ops_replace')?.run({ path: repDir, pattern: 'foo', replacement: 'bar', dryRun: true }, toolCtx),
      )
      expect(repDry).toContain('预演')
      expect(readFileSync(join(repDir, 'x.md'), 'utf8')).toBe('foo foo\n')
      const repRun = String(await toolOf('ops_replace')?.run({ path: repDir, pattern: 'foo', replacement: 'bar' }, toolCtx))
      expect(readFileSync(join(repDir, 'x.md'), 'utf8')).toBe('bar bar\n')
      expect(repRun).toContain('2 处')
      expect(repRun).toContain('改动 1 个文件')
      expect(repRun).toContain('共替换 2 处')
    })

    test('[9] 修订锚真的能挡并发覆盖（显式传旧版本）', async () => {
      const stale = rec(await worker.callOpsWorker({ ...base, tool: 'stat', args: { path: rwFile() } }))
      await toolOf('ops_write_file')?.run({ path: rwFile(), content: 'A2\nb\nC\n' }, toolCtx)
      await expect(
        toolOf('ops_write_file')?.run({ path: rwFile(), content: 'nope\n', expectedRevision: stale['revision'] }, toolCtx),
      ).rejects.toThrow(/REVISION_CONFLICT/)
      expect(readFileSync(rwFile(), 'utf8')).toBe('A2\nb\nC\n')
    })

    test('[10] gateAs 把复制目标按 to 过闸；copy/move/remove 不再宣称支持 dryRun', () => {
      const gated = rec(toolOf('ops_copy')?.gateAs?.({ path: rwFile(), to: 'relative-dest.txt' }, WORK))
      expect(rec(gated['args'])['path']).toBe(join(WORK, 'relative-dest.txt'))
      const propsOf = (name: string): Record<string, unknown> | undefined =>
        rec(rec(toolOf(name)?.parameters)['properties']) as Record<string, unknown> | undefined
      expect(propsOf('ops_copy')?.['dryRun']).toBeUndefined()
      expect(propsOf('ops_move')?.['dryRun']).toBeUndefined()
      expect(propsOf('ops_remove')?.['dryRun']).toBeUndefined()
    })
  })

  test('[11] 审批卡的「将做的改动」认得 ops 写类', async () => {
    const approval = await import('../approval/index.js')
    const preview = (toolName: string, args: Record<string, unknown>): ReturnType<typeof approval.approvalDiffOf> =>
      approval.approvalDiffOf({ toolName, args, cwd: WORK, argsSummary: '' })
    const rw = join(WORK, 'rw.txt')
    const beforeText = readFileSync(rw, 'utf8')

    const writePrev = rec(await preview('ops_write_file', { path: rw, content: 'X\nb\nC\n' }))
    expect(writePrev['added']).toBe(1)
    expect(writePrev['removed']).toBe(1)
    const multiPrev = rec(
      await preview('ops_edit_file', { path: rw, edits: [{ oldText: 'A2', newText: 'A3' }, { oldText: 'C', newText: 'D' }] }),
    )
    expect(multiPrev['added']).toBe(2)
    expect(multiPrev['removed']).toBe(2)
    const missPrev = rec(await preview('ops_edit_file', { path: rw, edits: [{ oldText: '不存在的内容', newText: 'x' }] }))
    expect(missPrev['mismatch']).toBe('missing')
    const replacePrev = rec(await preview('ops_replace', { path: rw, pattern: 'b', replacement: 'B' }))
    expect(replacePrev['added']).toBe(1)
    expect(replacePrev['removed']).toBe(1)
    const copyPrev = rec(await preview('ops_copy', { path: rw, to: join(WORK, 'fresh-copy.txt') }))
    expect(copyPrev['status']).toBe('added')
    expect(copyPrev['path']).toBe(join(WORK, 'fresh-copy.txt'))
    const removePrev = rec(await preview('ops_remove', { path: rw }))
    expect(removePrev['status']).toBe('deleted')
    expect(Number(removePrev['removed'] ?? 0)).toBeGreaterThan(0)
    const dirPrev = await preview('ops_replace', { path: WORK, pattern: 'b', replacement: 'B' })
    expect(dirPrev).toBeNull()
    expect(readFileSync(rw, 'utf8')).toBe(beforeText)
  })
})
