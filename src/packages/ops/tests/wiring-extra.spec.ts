/**
 * @pneuma/ops 的补缺口测试：接线（apply/设置分区/换 worker）+ worker 查找 + 结果渲染 + 工具参数闸。
 *
 * 既有 `ops.spec.ts` 只钉包形态、入口对象与时限常量；本文件补的是它明确留给运行时的那几块：
 *
 *   - `apply()` 真跑一遍假 ctx：没 worker 时的提示、设置分区字段/读写、换路径成功与失败；
 *   - `resolveOpsWorker` 的四条查找路径（显式 / 环境变量 / 插件目录 / 找不到）+ `callOpsWorker`
 *     在真正起进程之前的失败口径（请求超限、已取消、exe 不存在）；
 *   - `render.ts` 每个只读/写类回执的分支（完整、截断、空、失败尾注）；
 *   - `tools.ts` 的纯参数闸（读禁、空/超量、非法整数、根目录整树替换）。
 *
 * 临时 HOME：插件查找与 boot notice 都会读 `~/.dsc`，这里把 `DSC_HOME` 指到 mkdtemp 目录，
 * 再动态 import 产品模块——`path-policy.ts` 的 `DSC_HOME` 是模块级常量，静态 import 会先于
 * 环境赋值求值。
 *
 * @module @pneuma/ops/tests/wiring-extra
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-ops-extra-'))
const previousHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = home

const ops = await import('../index.js')
const render = await import('../render.js')
const worker = await import('../worker.js')
const toolsModule = await import('../tools.js')

afterAll(() => {
  if (previousHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = previousHome
  rmSync(home, { recursive: true, force: true })
})

/** 造一个工具调用上下文：只有 cwd/sessionId 参与这些用例。 */
function toolCtx(cwd = home) {
  return {
    cwd,
    signal: new AbortController().signal,
    sessionId: 'ops-extra-session',
    sessionPath: join(home, 'session.jsonl'),
  }
}

/** 假 ctx：只实现 apply 会碰的四个服务面，effect 立刻执行并收集退订。 */
function fakeCtx() {
  const registered = new Map<string, { name: string }>()
  const prompts: Array<{ name: string; get: () => string }> = []
  const sections: Array<import('@pneuma/runtime/services/types.js').SettingsSectionSpec> = []
  const systems: string[] = []
  const offs: Array<() => void> = []
  const ctx = {
    effect(execute: () => unknown) {
      const result = execute()
      const off = typeof result === 'function' ? (result as () => void) : () => {}
      offs.push(off)
      return off
    },
    tools: {
      register(tool: { name: string }) {
        registered.set(tool.name, tool)
        return () => registered.delete(tool.name)
      },
    },
    prompt: {
      register(name: string, get: () => string) {
        prompts.push({ name, get })
        return () => {}
      },
    },
    settings: {
      registerSection(section: import('@pneuma/runtime/services/types.js').SettingsSectionSpec) {
        sections.push(section)
        return () => {}
      },
    },
    transcript: {
      system(text: string) {
        systems.push(text)
      },
    },
  }
  return { ctx, registered, prompts, sections, systems, offs }
}

describe('worker 查找：四条路径与人话原因', () => {
  test('显式路径 / 环境变量 / 插件目录都能命中，找不到时写清找过哪里', () => {
    expect(worker.opsWorkerName('win32')).toBe('dsh-ops-worker.exe')
    expect(worker.opsWorkerName('linux')).toBe('dsh-ops-worker')

    const fakeExe = fileURLToPath(import.meta.url)
    const explicit = worker.resolveOpsWorker(fakeExe)
    expect(explicit).toMatchObject({ ok: true, file: fakeExe, source: '你在设置里填的路径' })

    const missing = worker.resolveOpsWorker(join(home, 'no-such-worker.exe'))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toContain('设置里填的 worker 不存在')

    const envPath = join(home, 'env-worker.exe')
    writeFileSync(envPath, 'x')
    const saved = process.env['DSC_OPS_WORKER']
    process.env['DSC_OPS_WORKER'] = envPath
    try {
      expect(worker.resolveOpsWorker()).toMatchObject({ ok: true, file: envPath, source: '环境变量 DSC_OPS_WORKER' })
    } finally {
      if (saved === undefined) delete process.env['DSC_OPS_WORKER']
      else process.env['DSC_OPS_WORKER'] = saved
    }

    const target = `${process.platform}-${process.arch}`
    const pluginExe = join(home, 'plugins', 'node_modules', 'dsh-ops', 'runtime', target, worker.opsWorkerName())
    mkdirSync(dirname(pluginExe), { recursive: true })
    writeFileSync(pluginExe, 'x')
    const fromPlugins = worker.resolveOpsWorker()
    expect(fromPlugins).toMatchObject({ ok: true, file: pluginExe })
    if (fromPlugins.ok) expect(fromPlugins.source).toContain('numa 插件目录')
    // 后面的接线用例要从「没有任何 worker」开始：把这一份临时插件目录收掉。
    rmSync(join(home, 'plugins'), { recursive: true, force: true })
  })

  test('起进程之前的失败：请求超限、开始前已取消、exe 不存在', async () => {
    const options = {
      file: join(home, 'missing-worker.exe'),
      tool: 'stat',
      args: {} as Record<string, unknown>,
      cwd: home,
      scope: 'ops-extra',
      readOnly: true,
    }
    await expect(
      worker.callOpsWorker({ ...options, args: { big: 'x'.repeat(worker.OPS_REQUEST_MAX_BYTES + 1) } }),
    ).rejects.toThrow(/字节上限/)

    const aborted = new AbortController()
    aborted.abort()
    await expect(worker.callOpsWorker({ ...options, signal: aborted.signal })).rejects.toThrow(/开始前就被取消/)

    await expect(worker.callOpsWorker(options)).rejects.toThrow(/ops worker 起不来/)
  })
})

describe('结果渲染：只读那批的完整 / 截断 / 空 / 失败尾注', () => {
  test('inspect：文本行号、hex 偏移、空文件、续读与修订', () => {
    const text = render.renderInspect(
      {
        path: '/tmp/a.log',
        items: [
          { line: 1, text: 'first' },
          { line: 2, text: 'second\tx' },
        ],
        lineCount: 5,
        nextOffset: 3,
        complete: false,
        revision: '0123456789abcdef',
      },
      { path: '/tmp/a.log' },
    )
    expect(text).toContain('第 1-2 行，共 5 行')
    expect(text).toContain('续读用 offset=3')
    expect(text).toContain('这次结果不完整')
    expect(text).toContain('（修订：0123456789abcdef…）')

    const hex = render.renderInspect(
      { items: [{ offset: 16, text: '00 ff' }], bytes: 64, nextOffset: 32 },
      { path: '/tmp/bin', view: 'hex' },
    )
    expect(hex).toContain('hex 视图，偏移 16 起，共 64 字节')
    expect(hex).toContain('续读用 offset=32')

    expect(render.renderInspect({ items: [], lineCount: 0 }, { path: '/tmp/empty' })).toContain('（空文件）')
    expect(render.renderInspect({ items: [] }, {})).toContain('（这个范围没有内容）')
    expect(render.renderInspect({ items: [] }, {})).toContain('文件：（路径未知）')
  })

  test('stat：存在/不存在与各事实行', () => {
    const stat = render.renderStat(
      {
        path: '/tmp/a',
        exists: true,
        bytes: 12,
        lineCount: 3,
        revision: 'abc',
        modifiedMs: Date.UTC(2026, 10, 3, 8, 20),
        readonly: true,
      },
      {},
    )
    expect(stat).toContain('存在：是')
    expect(stat).toContain('大小：12 字节')
    expect(stat).toContain('行数：3')
    expect(stat).toContain('修订：abc')
    expect(stat).toContain('修改时间：2026-11-03')
    expect(stat).toContain('只读：是')

    const missing = render.renderStat({ exists: false }, { path: '/tmp/none' })
    expect(missing).toBe('路径：/tmp/none\n存在：否')
  })

  test('diff：hunk 统计、三种标记、无差异与分页尾巴', () => {
    const text = render.renderDiff(
      {
        path: '/tmp/a',
        matched: 2,
        hunk: { added: 1, removed: 2, startLine: 4 },
        items: [
          { kind: 'add', line: 5, text: 'plus\n' },
          { kind: 'remove', line: 6, text: 'minus' },
          { kind: 'context', line: 7, text: 'same' },
        ],
        total: 3,
        nextOffset: 3,
        complete: false,
      },
      {},
    )
    expect(text).toContain('共 2 条差异记录；从第 4 行起，+1 -2')
    expect(text).toContain('+5\tplus')
    expect(text).toContain('-6\tminus')
    expect(text).toContain('?7\tsame')
    expect(text).toContain('（续读用 offset=3）')
    expect(text).toContain('这次结果不完整')

    expect(render.renderDiff({ items: [] }, { path: '/tmp/none' })).toContain('（没有差异）')
  })

  test('table / docx / pdf：表头、单元格坐标、页号与失败尾注', () => {
    const table = render.renderTable(
      {
        path: '/tmp/a.tsv',
        format: 'tsv',
        columns: ['a', 'b'],
        rowCount: 2,
        items: [{ row: 1, cells: ['x', 1] }],
        total: 2,
        nextOffset: 2,
        error: { code: 'PARTIAL', effectState: 'none', message: '后面坏了' },
      },
      {},
    )
    expect(table).toContain('表格：/tmp/a.tsv（tsv，2 列：a / b，共 2 行）')
    expect(table).toContain('1\t["x",1]')
    expect(table).toContain('共 2 行，这里显示 1 行')
    expect(table).toContain('失败：PARTIAL（这次改动：没有发生）')
    expect(table).toContain('原因：后面坏了')
    expect(render.renderTable({ items: [] }, {})).toContain('（这个范围没有记录）')

    const docx = render.renderDocx(
      {
        path: '/tmp/a.docx',
        total: 3,
        items: [
          { block: 1, text: '正文' },
          { block: 2, text: '格', table: 1, row: 2, cell: 3 },
        ],
        nextOffset: 3,
      },
      {},
    )
    expect(docx).toContain('共 3 段')
    expect(docx).toContain('（表 1 第 2 行第 3 列）')
    expect(docx).toContain('续读用 offset=3')

    const pdf = render.renderPdf(
      {
        path: '/tmp/a.pdf',
        total: 2,
        items: [{ page: 1, text: '第一页' }],
        nextOffset: 2,
        error: { code: 'TAIL', effectState: 'partial' },
      },
      {},
    )
    expect(pdf).toContain('PDF：/tmp/a.pdf（只取文本层，共 2 页）')
    expect(pdf).toContain('第 1 页\t第一页')
    expect(pdf).toContain('失败：TAIL（这次改动：partial）')
  })

  test('read_files：逐段文件块、单段失败、pending 提示与空结果', () => {
    const text = render.renderReadFiles({
      items: [
        { path: 'a.log', items: [{ line: 1, text: 'x' }], lineCount: 1, complete: true },
        { path: 'b.log', error: { code: 'DENIED', effectState: 'none' } },
        { path: 'c.log', items: [], lineCount: 0, complete: true },
      ],
      pending: 2,
    })
    expect(text).toContain('文件：a.log（第 1-1 行，共 1 行）')
    expect(text).toContain('文件：b.log\n失败：DENIED（这次改动：没有发生）')
    expect(text).toContain('（空文件）')
    expect(text).toContain('还有 2 段没读完：把 files 从第 4 段接着传')

    expect(render.renderReadFiles({ items: [] })).toBe('这次没有交回任何文件内容')
  })

  test('失败判定与 failure 文案：effect none、nextAction 转义、未知错误', () => {
    expect(render.isFailure({ error: {} })).toBe(true)
    expect(render.isFailure({ status: 'conflict' })).toBe(true)
    expect(render.isFailure({ status: 'ok' })).toBe(false)
    expect(render.hasItems({ items: [] })).toBe(false)
    expect(render.hasItems({ items: [1] })).toBe(true)

    const text = render.renderFailure({
      error: { code: 'EACCES', effectState: 'partial', nextAction: '先\n再', message: 'a\tb' },
    })
    expect(text).toBe('失败：EACCES（这次改动：partial）\n下一步：先\\n再\n原因：a\\tb')
    expect(render.renderFailure({})).toBe('失败：UNKNOWN_ERROR（这次改动：unknown）')
  })

  test('写类回执：dryRun 前缀、替换计数、跳过/失败、修订脚注与空结果', () => {
    const text = render.renderMutation(
      'replace',
      {
        dryRun: true,
        changed: 2,
        items: [
          {
            path: 'a.ts',
            replacements: 2,
            revisionBefore: 'bbbbbbbbbbbbbbbb',
            revisionAfter: 'cccccccccccccccc',
            metadata: { kept: true },
          },
          { path: 'b.ts', removed: true, bytesBefore: 10, bytesAfter: 0 },
        ],
        skipped: 9,
        skippedPaths: ['x', 'y'],
        failed: 1,
      },
      {},
    )
    expect(text.split('\n')[0]).toBe('预演（磁盘没动）：替换，改动 2 个文件、共替换 2 处')
    expect(text).toContain('a.ts（替换 2 处；修订 bbbbbbbbbbbb → cccccccccccc；元数据已保留）')
    expect(text).toContain('b.ts（已删除；10 → 0 字节）')
    expect(text).toContain('（跳过 9 个：x、y）')
    expect(text).toContain('（1 个失败，看上面的逐条回执）')
    expect(text).toContain('修订号只显示前 12 位')

    expect(render.renderMutation('write_file', { items: [] }, {})).toContain('没有文件被改动')
    expect(render.renderMutation('replace', { items: [] }, {})).toContain('没有匹配到要替换的内容')
    expect(render.renderMutation('copy', {}, { path: '/tmp/x' })).toContain('改动 0 个文件')
  })
})

describe('工具参数闸：不碰 worker 的拒绝路径', () => {
  const opts = { file: join(home, 'never-started.exe'), timeoutMs: 2_000, maxBytes: 1024 }
  const entries = toolsModule.createOpsTools(opts)
  const byName = (name: string) => {
    const found = entries.find((entry) => entry.name === name)
    if (found === undefined) throw new Error(`没有工具 ${name}`)
    return found
  }

  test('清单：十三个工具按七个只读在前、六个写类在后', () => {
    expect(entries.map((entry) => entry.name)).toEqual([
      'ops_inspect_local_file',
      'ops_read_files',
      'ops_stat',
      'ops_diff',
      'ops_read_table',
      'ops_read_docx',
      'ops_read_pdf',
      'ops_write_file',
      'ops_edit_file',
      'ops_copy',
      'ops_move',
      'ops_remove',
      'ops_replace',
    ])
    expect(entries.filter((entry) => entry.risk === 'read')).toHaveLength(7)
    expect(entries.filter((entry) => entry.risk === 'write')).toHaveLength(6)
  })

  test('读禁与参数错：.env、负 offset、空/超量 files、非字符串 content', async () => {
    await expect(byName('ops_inspect_local_file').run({ path: '.env' }, toolCtx())).rejects.toThrow(/禁止读取/)
    await expect(byName('ops_inspect_local_file').run({ path: 'a.txt', offset: -1 }, toolCtx())).rejects.toThrow(
      /offset 不能小于 0/,
    )
    await expect(byName('ops_read_files').run({ files: [] }, toolCtx())).rejects.toThrow(/files 不能为空/)
    await expect(
      byName('ops_read_files').run({ files: Array.from({ length: 33 }, () => ({ path: 'x' })) }, toolCtx()),
    ).rejects.toThrow(/最多读 32 段/)
    await expect(byName('ops_diff').run({ path: 'a.txt' }, toolCtx())).rejects.toThrow(/content 要是字符串/)
    await expect(byName('ops_read_pdf').run({ path: 'a.pdf', offset: 0 }, toolCtx())).rejects.toThrow(
      /offset 不能小于 1/,
    )
  })

  test('写类参数闸与根目录围栏：空 edits、坏 oldText、根目录整树替换', async () => {
    await expect(byName('ops_edit_file').run({ path: 'a.txt', edits: [] }, toolCtx())).rejects.toThrow(
      /edits 不能为空/,
    )
    await expect(
      byName('ops_edit_file').run({ path: 'a.txt', edits: [{ oldText: '' }] }, toolCtx()),
    ).rejects.toThrow(/oldText（非空字符串）/)
    await expect(
      byName('ops_edit_file').run({ path: 'a.txt', edits: [{ oldText: 'x' }] }, toolCtx()),
    ).rejects.toThrow(/newText/)
    await expect(
      byName('ops_replace').run({ path: parse(home).root, pattern: 'a', replacement: 'b' }, toolCtx()),
    ).rejects.toThrow(/不能对根目录/)
    await expect(
      byName('ops_replace').run({ path: 'a.txt', pattern: '', replacement: 'b' }, toolCtx()),
    ).rejects.toThrow(/pattern 要是非空字符串/)
    await expect(
      byName('ops_replace').run({ path: 'a.txt', pattern: 'a', replacement: 1 as never }, toolCtx()),
    ).rejects.toThrow(/replacement 要是字符串/)
    await expect(
      byName('ops_replace').run({ path: 'a.txt', pattern: 'a', replacement: 'b', maxReplacements: 0 }, toolCtx()),
    ).rejects.toThrow(/maxReplacements 不能小于 1/)
  })

  test('copy/move 的 gateAs 按目标路径报身份，源参数原样带过去', () => {
    const copy = byName('ops_copy')
    expect(copy.gateAs?.({ path: 'src.txt', to: 'dst/out.txt' }, 'D:\\work')).toEqual({
      name: 'ops_copy',
      risk: 'write',
      args: { path: 'D:\\work\\dst\\out.txt', to: 'dst/out.txt' },
    })
    expect(copy.gateAs?.({ path: 'src.txt' }, 'D:\\work')).toBeUndefined()
  })
})

describe('插件接线：没 worker 时的提示与设置分区，换路径成功/失败', () => {
  test('挂载、设置字段、保存与卸载都走一遍', () => {
    // `resolveOpsWorker` 的最后一条查找路径读的是 `homedir()/.dsh/profiles`；真机上装了
    // dsh-ops 就会命中。把 USERPROFILE/HOME 也指到临时目录，保证这一段的起点是「没有任何 worker」。
    const realProfile = process.env['USERPROFILE']
    const realHome = process.env['HOME']
    process.env['USERPROFILE'] = home
    process.env['HOME'] = home

    const fake = fakeCtx()
    const dispose = ops.opsPlugin.apply(fake.ctx as never, {}) as unknown as () => void

    // 临时 HOME 里没有任何 worker：十三个工具一个都不注册，系统提示空，转录里说一句缺什么。
    expect(fake.registered.size).toBe(0)
    expect(fake.systems.join('\n')).toContain('ops 工具没启用')
    expect(fake.prompts[0]?.get()).toBe('')
    expect(fake.sections).toHaveLength(1)

    const section = fake.sections[0]!
    const save = section.save!
    const values = (): Record<string, unknown> => section.values() as unknown as Record<string, unknown>
    const fields = section.fields()
    expect(fields.some((field) => String(field.label ?? '').includes('当前状态'))).toBe(true)
    expect(fields.some((field) => field.type === 'text' && field.key === 'workerPath')).toBe(true)
    expect(values()).toEqual({ workerPath: '', timeoutMs: worker.OPS_TIMEOUT_MS })

    expect(String(save('bogus', 'x'))).toContain('这个分区没有这项')
    expect(String(save('timeoutMs', 'not-a-number'))).toContain('时限要是一个数字')
    expect(save('timeoutMs', '1000')).toBeUndefined()
    expect(values()['timeoutMs']).toBe(ops.OPS_TIMEOUT_RANGE.min)

    // 换成一个真实存在的文件：解析成功，十三个工具整批注册。
    const good = join(home, 'custom-worker.exe')
    writeFileSync(good, 'x')
    const saved = save('workerPath', good)
    expect(String(saved)).toContain('路径已更新')
    expect(fake.registered.size).toBe(13)
    expect(fake.prompts[0]?.get()).toContain('ops_read_pdf')
    expect(section.fields().some((field) => String(field.label ?? '').includes('worker 路径'))).toBe(true)

    // 换成一个不存在的路径：不撤旧批次，只把原因交回去。
    const failed = save('workerPath', join(home, 'typo.exe'))
    expect(String(failed)).toContain('路径已保存，但没找到 worker')
    expect(fake.registered.size).toBe(13)

    // 留空 = 自动找：在插件目录放一份之后，swap 成功。
    const target = `${process.platform}-${process.arch}`
    const auto = join(home, 'plugins', 'node_modules', 'dsh-ops', 'runtime', target, worker.opsWorkerName())
    mkdirSync(dirname(auto), { recursive: true })
    writeFileSync(auto, 'x')
    expect(String(save('workerPath', ''))).toContain('路径已更新')
    expect(fake.registered.size).toBe(13)

    dispose()
    expect(fake.registered.size).toBe(0)

    if (realProfile === undefined) delete process.env['USERPROFILE']
    else process.env['USERPROFILE'] = realProfile
    if (realHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = realHome
  })
})
