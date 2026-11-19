/**
 * 后台作业与持久终端的簿记面（`packages/tools-default/bash.ts`）：
 * `JobTable` / `createJobTools`、`TerminalTable` / `createTerminalTool`、以及 `shellPlan` 的组装。
 *
 * 为什么值得单测：这两张表的游标语义（`output`/`read` 会推进 `lastRead`，`peek` 不推进）
 * 与状态文案（运行中/已完成/被终止/失败）是状态面板和模型共用的读口，写错会让模型读不到
 * 后续输出。作业启动走真子进程（`echo` / `exit 3` / 睡一秒的 node 脚本）——那是唯一能
 * 覆盖 `launch` → onChunk → onExit → notify 的路；工具面用假表，只钉参数校验与文案。
 *
 * @module dsc/packages/tools-default/tests/bash-jobs.spec
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  createJobTools,
  createTerminalTool,
  JobTable,
  shellPlan,
  TerminalTable,
  type JobOutputView,
  type JobRecord,
  type TerminalOutputView,
  type TerminalRecord,
} from '../bash.js'

let dir = ''

afterEach(() => {
  // 真终端会话刚被收掉时，子进程可能还占着 cwd 一瞬（Windows 上 rmSync 会 EPERM）。
  if (dir !== '') rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dir = ''
})

function workdir(): string {
  dir = mkdtempSync(join(tmpdir(), 'dsc-bash-jobs-'))
  return dir
}

/** 轮询等到条件成立（作业是异步收尾的，不靠固定 sleep）。 */
async function until<T>(probe: () => T | undefined, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = probe()
    if (hit !== undefined) return hit
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const ctx = { sessionId: 'sess-1', cwd: '' } as never

/** 造一份 job_output 视图。 */
function jobView(overrides: Partial<JobOutputView> = {}): JobOutputView {
  return {
    id: 'job-1',
    status: 'running',
    exitCode: null,
    text: 'hello\n',
    totalChars: 6,
    from: 0,
    droppedChars: 0,
    atEnd: true,
    ...overrides,
  }
}

/** 造一份 terminal read 视图。 */
function termView(overrides: Partial<TerminalOutputView> = {}): TerminalOutputView {
  return {
    id: 'term-1',
    status: 'running',
    exitCode: null,
    text: 'hi\n',
    totalChars: 3,
    from: 0,
    droppedChars: 0,
    atEnd: true,
    ...overrides,
  }
}

/** 造一条作业记录（只填工具面用到的字段）。 */
function jobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    command: 'echo hi',
    cwd: '',
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    output: '',
    dropped: 0,
    lastRead: 0,
    networkFetch: false,
    ...overrides,
  }
}

/** 造一条终端记录。 */
function termRecord(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    id: 'term-1',
    cwd: '',
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    lastSent: '',
    output: '',
    dropped: 0,
    lastRead: 0,
    ...overrides,
  }
}

describe('shellPlan：四档终端各自怎么拼', () => {
  // 这条会真的探一次本机 shell（`shellPlan('auto')` 不起子进程但首次会读注册表/路径）：
  // GitHub Windows runner 冷启动实测 5.4s，撞到默认 5000ms 上限。它是真探针，不是纯函数，
  // 给 30s 上限（同文件其他 spawn 用例走的是它们自己的超时参数）。
  test('sh：原样交给 sh -c；当前平台默认档与选择一致', () => {
    const env = { PATH: 'x' }
    expect(shellPlan('sh', 'echo hi', '/work', env)).toEqual({ file: 'sh', args: ['-c', 'echo hi'], env, cwd: '/work' })
    const auto = shellPlan('auto', 'echo hi', '/work', env)
    if (process.platform === 'win32') {
      expect(auto.file.toLowerCase()).toContain('powershell')
      expect(auto.args[0]).toBe('-NoProfile')
      expect(auto.args[1]).toBe('-Command')
      expect(auto.args[2]).toContain('echo hi')
      expect(auto.args[2]).toContain('OutputEncoding')
      expect(auto.args[2]).toContain('$LASTEXITCODE')
    } else {
      expect(auto).toEqual({ file: 'sh', args: ['-c', 'echo hi'], env, cwd: '/work' })
    }
  }, 30_000)

  // pwsh / powershell 两档按实现只在 Windows 上生效（非 win32 的 shellPlan 一律回落 sh），
  // 所以这组断言只在 win32 上跑；sh 档的等价覆盖在上一条用例里。
  test.skipIf(process.platform !== 'win32')('PowerShell 家族：-NoProfile -Command，前面钉 UTF-8、末尾带退出码', () => {
    const env = {}
    for (const choice of ['pwsh', 'powershell'] as const) {
      const plan = shellPlan(choice, 'ls', 'C:/w', env)
      expect(plan.args.slice(0, 2)).toEqual(['-NoProfile', '-Command'])
      expect(plan.args[2]).toContain('[Console]::OutputEncoding = [Text.Encoding]::UTF8')
      expect(plan.args[2]).toContain('ls')
      expect(plan.args[2]).toContain('exit $LASTEXITCODE')
      expect(plan).toMatchObject({ env, cwd: 'C:/w' })
    }
  })

  test('Git Bash 与 WSL：不读 rc；WSL 带 --cd 和 bash -lc，有发行版就钉 -d', () => {
    const env = {}
    const gitbash = shellPlan('gitbash', 'ls', 'C:/w', env)
    expect(gitbash.args).toEqual(['--noprofile', '--norc', '-c', 'ls'])
    expect(gitbash.file).not.toBe('')

    const wsl = shellPlan('wsl', 'ls', 'C:/w', env)
    const cdAt = wsl.args.indexOf('--cd')
    expect(cdAt).toBeGreaterThanOrEqual(0)
    expect(wsl.args[cdAt + 1]).toBe('C:/w')
    expect(wsl.args.slice(-2)).toEqual(['-lc', 'ls'])
    const dAt = wsl.args.indexOf('-d')
    // 有发行版时是 ['-d', name, '--cd', ...]；探测不到就退回不指定。
    if (dAt >= 0) expect(dAt).toBeLessThan(cdAt)
    expect(wsl).toMatchObject({ env, cwd: 'C:/w' })
  })
})

describe('JobTable：真子进程的作业生命周期', () => {
  test('启动 → 收输出 → 完成通知带 id 与 owner；runningIds 跟着状态走', async () => {
    const cwd = workdir()
    const notes: Array<{ text: string; owner?: string }> = []
    const table = new JobTable({ notify: (text, owner) => notes.push({ text, owner }) })
    const id = table.launch('echo hello', cwd, 'sess-1')
    expect(id).toBe('job-1')
    expect(table.size).toBe(1)
    expect(table.runningIds()).toEqual([id])

    await until(() => (table.get(id)?.status === 'running' ? undefined : true), '作业完成')
    expect(table.get(id)).toMatchObject({ status: 'completed', exitCode: 0, cwd })
    expect(table.runningIds()).toEqual([])

    const view = table.output(id)
    expect(view).toMatchObject({ status: 'completed', exitCode: 0, atEnd: true })
    expect(view.text).toContain('hello')
    expect(notes).toHaveLength(1)
    expect(notes[0]!.text).toContain(`后台作业 ${id}`)
    expect(notes[0]!.text).toContain('成功完成')
    expect(notes[0]!.owner).toBe('sess-1')
  }, 30_000)

  test('非 0 退出记失败，通知里带退出码；命令过长时截断预览', async () => {
    const cwd = workdir()
    const notes: string[] = []
    const table = new JobTable({ notify: (text) => notes.push(text) })
    const longCommand = `echo ${'x'.repeat(80)}; exit 3`
    const id = table.launch(longCommand, cwd)
    await until(() => (table.get(id)?.status === 'running' ? undefined : true), '作业失败')
    expect(table.get(id)).toMatchObject({ status: 'failed', exitCode: 3 })
    expect(notes[0]).toContain('失败（退出码 3）')
    expect(notes[0]).toContain('…')
  }, 30_000)

  test('output 推进 lastRead，peek 只看不推；offset 可回读，越界值按没给处理', async () => {
    const cwd = workdir()
    const table = new JobTable({ notify: () => undefined })
    const id = table.launch('echo hello', cwd)
    await until(() => (table.get(id)?.status === 'running' ? undefined : true), '作业完成')

    const peeked = table.peek(id)
    expect(peeked.text).toContain('hello')
    const first = table.output(id)
    expect(first.text).toContain('hello')
    expect(first.atEnd).toBe(true)
    // 游标已经到末尾：再读是空的，peek 不会把游标顶走后让模型读不到。
    expect(table.output(id).text).toBe('')
    expect(table.peek(id).text).toContain('hello')

    expect(table.output(id, 1).text).toBe(first.text.slice(1))
    expect(table.output(id, -5).text).toBe('') // 负数当没给，游标仍在末尾
    expect(table.output(id, Number.NaN).text).toBe('')
    expect(table.output(id, 9_999).text).toBe('') // 超过总长夹到末尾
  }, 30_000)

  test('网络拉取的输出套不可信围栏；list 按启动时间排序；get 认 id', async () => {
    const cwd = workdir()
    const table = new JobTable({ notify: () => undefined })
    const id = table.launch('echo from-net', cwd)
    await until(() => (table.get(id)?.status === 'running' ? undefined : true), '作业完成')

    const record = table.get(id)!
    record.networkFetch = true
    const first = table.output(id)
    expect(first.text).toContain('from-net')
    expect(first.text).toMatch(/job-output/i)
    const peeked = table.peek(id)
    expect(peeked.text).toContain('from-net')
    expect(peeked.text).toMatch(/job-output/i)

    expect(table.list().map((item) => item.id)).toEqual([id])
    expect(table.get('nope')).toBeUndefined()
  }, 30_000)

  test('未知作业给最近的 id 提示；markKilled 只动 running，重复调用不覆盖', async () => {
    const cwd = workdir()
    const table = new JobTable({ notify: () => undefined })
    expect(() => table.output('job-9')).toThrow(/没有这个后台作业：job-9（还没有任何作业）/)

    const id = table.launch('echo hi', cwd)
    expect(() => table.output('job-9')).toThrow(/最近的作业：job-1/)

    expect(table.markKilled('nope')).toBeUndefined()
    const killed = table.markKilled(id)
    expect(killed).toMatchObject({ status: 'killed' })
    expect(typeof killed?.finishedAt).toBe('number')
    // 已经结束的作业再 mark 不覆盖结束时间与状态。
    const again = table.markKilled(id)
    expect(again?.status).toBe('killed')
    expect(table.runningIds()).toEqual([])
  }, 30_000)

  test('作业数到上限再 launch：给一句能照做的提示', () => {
    const table = new JobTable({ notify: () => undefined })
    // 只填记录不启进程：上限检查在 spawn 之前，够验这一条。
    const internals = table as unknown as { jobs: Map<string, JobRecord> }
    for (let index = 0; index < 50; index += 1) {
      internals.jobs.set(`job-${String(index + 1)}`, jobRecord({ id: `job-${String(index + 1)}` }))
    }
    expect(() => table.launch('echo hi', '')).toThrow(/后台作业已到 50 个上限/)
  })
})

describe('createJobTools：参数校验与状态文案（假表）', () => {
  test('job_output：空 id 抛错；四种状态各有一句话；空输出给占位', async () => {
    const views: JobOutputView[] = [
      jobView({ status: 'running', exitCode: null }),
      jobView({ status: 'completed', exitCode: 0 }),
      jobView({ status: 'killed', exitCode: null, text: '' }),
      jobView({ status: 'failed', exitCode: 7, text: '  ' }),
    ]
    const table = {
      output: () => views.shift()!,
      list: () => [],
      get: () => undefined,
      markKilled: () => undefined,
    } as unknown as JobTable
    const tools = createJobTools(table)
    const output = tools.find((tool) => tool.name === 'job_output')!
    await expect(output.run({ job_id: '' }, ctx)).rejects.toThrow(/job_id 必须是非空字符串/)
    expect(await output.run({ job_id: 'job-1' }, ctx)).toContain('运行中')
    expect(await output.run({ job_id: 'job-1' }, ctx)).toContain('已完成')
    expect(await output.run({ job_id: 'job-1' }, ctx)).toContain('（还没有输出）')
    const failed = await output.run({ job_id: 'job-1' }, ctx)
    expect(failed).toContain('失败（退出码 7）')
    expect(failed).toContain('（还没有输出）')
  })

  test('job_list：空表给启动提示；有作业给时长与命令', async () => {
    let jobs: JobRecord[] = []
    const table = { output: () => jobView(), list: () => jobs, get: () => undefined, markKilled: () => undefined } as unknown as JobTable
    const tools = createJobTools(table)
    const list = tools.find((tool) => tool.name === 'job_list')!
    expect(await list.run({}, ctx)).toBe('（没有后台作业。启动：bash 带 run_in_background=true）')

    const startedAt = Date.now() - 5_000
    jobs = [jobRecord({ id: 'job-1', startedAt, finishedAt: Date.now(), status: 'failed', exitCode: 2 })]
    const text = await list.run({}, ctx)
    expect(text).toContain('job-1')
    expect(text).toContain('失败（退出码 2）')
    expect(text).toMatch(/5s/)
  })

  test('job_kill：空 id / 不存在 / 已结束 / 正在跑（进程已不在）各给结论', async () => {
    let job: JobRecord | undefined
    const table = {
      output: () => jobView(),
      list: () => [],
      get: () => job,
      markKilled: () => job,
    } as unknown as JobTable
    const tools = createJobTools(table)
    const kill = tools.find((tool) => tool.name === 'job_kill')!
    await expect(kill.run({ job_id: '' }, ctx)).rejects.toThrow(/job_id 必须是非空字符串/)
    job = undefined
    await expect(kill.run({ job_id: 'job-777' }, ctx)).rejects.toThrow(/没有这个后台作业：job-777/)
    job = jobRecord({ id: 'job-777', status: 'completed' })
    expect(await kill.run({ job_id: 'job-777' }, ctx)).toContain('已经是 completed')
    // 这个 id 没在登记表里挂过进程，所以走「进程已经不在了」那条。
    job = jobRecord({ id: 'job-777' })
    expect(await kill.run({ job_id: 'job-777' }, ctx)).toContain('进程已经不在了')
  })
})

describe('TerminalTable：真会话的读写与收尾', () => {
  test('open → send → read 到输出 → list → close；结束后再发被拒', async () => {
    // 不传 cwd：让 shell 落在测试进程自己的目录，免得 Windows 上子进程占着临时目录
    // 让 afterEach 的 rmSync 报 EPERM（cwd 的传递由假表那条 open 用例钉）。
    const exits: string[] = []
    const table = new TerminalTable({ onExit: (id) => exits.push(id) })
    const id = table.open('sess-1')
    expect(id).toBe('term-1')
    expect(table.size).toBe(1)
    try {
      table.send(id, 'echo hi\n')
      const view = await until(() => {
        const peeked = table.peek(id)
        return peeked.text.includes('hi') ? peeked : undefined
      }, '终端输出')
      expect(view.text).toContain('hi')
      expect(table.list().map((item) => item.id)).toEqual([id])
    } finally {
      expect(table.close(id)).toContain('已收掉')
    }
    expect(table.close(id)).toContain('本来就已经结束')
    expect(() => table.send(id, 'echo again\n')).toThrow(/已经结束/)
  }, 40_000)
})

describe('createTerminalTool：五个动作的文案与校验（假表）', () => {
  function fakeTable(): {
    table: TerminalTable
    calls: string[]
    setView: (view: TerminalOutputView) => void
    setRecords: (records: TerminalRecord[]) => void
  } {
    const calls: string[] = []
    let view = termView()
    let records: TerminalRecord[] = []
    const table = {
      open: (owner?: string, cwd?: string) => {
        calls.push(`open:${String(owner)}:${String(cwd)}`)
        return 'term-9'
      },
      read: (id: string, offset?: number) => {
        calls.push(`read:${id}:${String(offset)}`)
        return view
      },
      send: (id: string, data: string) => calls.push(`send:${id}:${data.trim()}`),
      close: (id: string) => {
        calls.push(`close:${id}`)
        return `终端会话 ${id} 已收掉`
      },
      list: () => records,
    } as unknown as TerminalTable
    return { table, calls, setView: (next) => (view = next), setRecords: (next) => (records = next) }
  }

  test('open 用会话 id 与 cwd；read 在结束时带 exitCode，未读完给续读 offset', async () => {
    const fake = fakeTable()
    const tool = createTerminalTool(fake.table)
    const opened = await tool.run({ action: 'open' }, { sessionId: 'sess-7', cwd: '/w' } as never)
    expect(opened).toContain('term-9')
    expect(fake.calls).toContain('open:sess-7:/w')

    fake.setView(termView({ status: 'closed', exitCode: 4, atEnd: false, text: 'abc', from: 0 }))
    const read = await tool.run({ action: 'read', session_id: 'term-9', offset: 2 }, { sessionId: 's', cwd: '' } as never)
    expect(fake.calls).toContain('read:term-9:2')
    expect(read).toContain('会话已结束，exitCode 4')
    expect(read).toContain('offset=3 续读')

    fake.setView(termView())
    const plain = await tool.run({ action: 'read', session_id: 'term-9' }, { sessionId: 's', cwd: '' } as never)
    expect(fake.calls).toContain('read:term-9:undefined')
    expect(plain).not.toContain('会话已结束')
  })

  test('send 必须带 data；close/list 的文案；未知 action 列出可用值', async () => {
    const fake = fakeTable()
    const tool = createTerminalTool(fake.table)
    await expect(tool.run({ action: 'send', session_id: 'term-9' }, { sessionId: 's', cwd: '' } as never)).rejects.toThrow(
      /send 要带上 data/,
    )
    await expect(
      tool.run({ action: 'send', session_id: 'term-9', data: '' }, { sessionId: 's', cwd: '' } as never),
    ).rejects.toThrow(/send 要带上 data/)
    expect(await tool.run({ action: 'send', session_id: 'term-9', data: 'ls\n' }, { sessionId: 's', cwd: '' } as never)).toContain(
      '已写进 term-9',
    )
    expect(await tool.run({ action: 'close', session_id: 'term-9' }, { sessionId: 's', cwd: '' } as never)).toContain('已收掉')

    expect(await tool.run({ action: 'list' }, { sessionId: 's', cwd: '' } as never)).toBe('（还没有任何终端会话）')
    fake.setRecords([
      termRecord({ id: 'term-1' }),
      termRecord({ id: 'term-2', status: 'closed', exitCode: 0 }),
    ])
    const list = await tool.run({ action: 'list' }, { sessionId: 's', cwd: '' } as never)
    expect(list).toContain('term-1（running）')
    expect(list).toContain('term-2（closed，exitCode 0）')

    await expect(tool.run({ action: 'dance' }, { sessionId: 's', cwd: '' } as never)).rejects.toThrow(
      /不认识的 action「dance」/,
    )
  })
})
