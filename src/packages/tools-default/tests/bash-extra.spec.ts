/**
 * bash 工具主路径补测（`packages/tools-default/bash.ts`）。
 *
 * 同目录的 `bash-jobs.spec.ts` 已经钉住 JobTable / TerminalTable 的游标语义与
 * `createJobTools` / `createTerminalTool` 的文案，`bash-truncation.int.spec.ts`
 * （integration 层）钉住 `truncateBashOutput` 的切法与假 spawn 的字节上限。这里只补
 * **还没人走的那几条**：
 *
 *   ① `createBashTool` 的 schema 与预算文案；
 *   ② 参数校验、策略硬地板拒绝、后台旁路（有 / 没有作业表两条）；
 *   ③ 真跑短命令：成功、非 0 退出、双流合并、工作目录、环境脱敏、无输出；
 *   ④ 真跑长命令：超时（默认档与参数上下限夹取）、用户取消；
 *   ⑤ 输出截断与 tty 原样保留（工具层的接线，不是纯函数）；
 *   ⑥ 网络拉取命令（`curl` 出现在命令文本里）的结果套不可信围栏；
 *   ⑦ 后台进程登记表的增删查与整表收尾；
 *   ⑧ 作业记录的环形缓冲（`dropped`）在 `output`/`peek` 里的绝对偏移；
 *   ⑨ 作业启动失败（cwd 不存在）走 onError 而不是静默挂住；终端会话数上限。
 *
 * 命令只用 `node <临时脚本>` 与 `echo` 这类跨 shell 的写法：本仓库在 Windows 上默认
 * 走 PowerShell、POSIX 上走 sh，测试不该依赖其中一种。临时目录清理容忍 EPERM
 * （Windows 上刚退出的子进程可能还占着 cwd 一瞬）。
 *
 * @module @pneuma/tools-default/tests/bash-extra.spec
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'
import {
  BASH_DEFAULT_BUDGETS,
  JOB_OUTPUT_CAP,
  JOB_VIEW_CHARS,
  NETWORK_FETCH_RE,
  JobTable,
  TerminalTable,
  createBashTool,
  killTree,
  stopAllBackgroundChildren,
  stopBackgroundChild,
  trackBackgroundChild,
  trackedBackgroundChild,
  untrackBackgroundChild,
  type BashBudgets,
  type JobRecord,
  type TerminalRecord,
} from '../bash.js'

let dir = ''
let scriptNo = 0

afterEach(() => {
  // 真子进程刚被收掉时可能还攥着 cwd 一瞬（Windows 上 rmSync 会 EPERM）。
  if (dir !== '') {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // 留给系统清，别让清理失败盖住真正的断言结果。
    }
  }
  dir = ''
  scriptNo = 0
})

/** 本用例的临时工作目录（realpath：Windows 的 tmpdir 可能带短名）。 */
function workdir(): string {
  if (dir === '') dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsc-bash-extra-')))
  return dir
}

/** 在临时目录写一个 node 脚本，返回可以交给任意 shell 的命令行（路径不含空格）。 */
function nodeScript(body: string): string {
  scriptNo += 1
  const file = join(workdir(), `probe-${String(scriptNo)}.js`)
  writeFileSync(file, body, 'utf8')
  return `node ${file.replaceAll('\\', '/')}`
}

/** 一次工具调用上下文。 */
function ctx(cwd: string = workdir(), signal: AbortSignal = new AbortController().signal): never {
  return { cwd, signal, sessionId: 'sess-extra', sessionPath: '' } as never
}

/** 在缺省预算上覆盖几项。 */
function budgets(overrides: Partial<BashBudgets> = {}): BashBudgets {
  return { ...BASH_DEFAULT_BUDGETS, ...overrides }
}

/** 轮询等到条件成立（作业收尾是异步的）。 */
async function until<T>(probe: () => T | undefined, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = probe()
    if (hit !== undefined) return hit
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('createBashTool：schema 与预算文案', () => {
  test('名字/风险/必填参数固定；预算写进参数说明；后台旁路按调用方是否提供切换', () => {
    const plain = createBashTool()
    expect(plain.name).toBe('bash')
    expect(plain.risk).toBe('exec')
    const params = plain.parameters as {
      properties: Record<string, Record<string, unknown>>
      required: string[]
    }
    expect(params.required).toEqual(['command'])
    expect(Object.keys(params.properties)).toEqual([
      'command',
      'timeoutMs',
      'tty',
      'cols',
      'rows',
      'sandbox_permissions',
      'justification',
      'sandbox_scope',
    ])
    expect(String(params.properties['timeoutMs']!['description'])).toContain('默认 30000')
    expect(String(params.properties['timeoutMs']!['description'])).toContain('上限 120000')
    expect(params.properties['run_in_background']).toBeUndefined()
    // 一次性升权三个参数是沙箱守卫的入口，不能因为没挂后台就丢。
    expect(params.properties['sandbox_permissions']!['enum']).toEqual(['workspace-write', 'danger-full-access'])

    const withBackground = createBashTool(budgets(), { launch: () => 'job-1' })
    const bgParams = withBackground.parameters as { properties: Record<string, unknown> }
    expect(bgParams.properties['run_in_background']).toBeDefined()
  })

  test('自定义预算：说明里的默认值/上限跟着走，不写死缺省数', () => {
    const tool = createBashTool({ timeoutMs: 1_234, maxTimeoutMs: 5_678, outputChars: 42 })
    const props = (tool.parameters as { properties: Record<string, Record<string, unknown>> }).properties
    const text = String(props['timeoutMs']!['description'])
    expect(text).toContain('默认 1234')
    expect(text).toContain('上限 5678')
  })
})

describe('createBashTool：参数校验与策略硬地板', () => {
  test('command 缺失/空串/纯空白/非字符串一律拒', async () => {
    const tool = createBashTool()
    for (const args of [{}, { command: '' }, { command: '   ' }, { command: 42 }]) {
      await expect(tool.run(args, ctx())).rejects.toThrow(/command 必须是非空字符串/)
    }
  })

  test('策略判 deny 的命令在工具层再拒一次（绕过审批也执行不了）', async () => {
    const tool = createBashTool()
    await expect(tool.run({ command: 'diskpart' }, ctx())).rejects.toThrow(/命令被安全策略拒绝执行：用 diskpart 清盘/)
  })
})

describe('createBashTool：真跑短命令', () => {
  test('成功：stdout 与 stderr 合并交回，退出码 0 不额外报码', async () => {
    const result = await createBashTool().run(
      { command: nodeScript("process.stdout.write('OUT-MARK\\n'); process.stderr.write('ERR-MARK\\n')") },
      ctx(),
    )
    expect(result).toContain('OUT-MARK')
    expect(result).toContain('ERR-MARK')
    expect(result).not.toContain('退出码')
  }, 20_000)

  test('非 0 退出：正文保留，并附「退出码 N」', async () => {
    const result = await createBashTool().run(
      { command: nodeScript("console.log('BEFORE-FAIL'); process.exit(3)") },
      ctx(),
    )
    expect(result).toContain('BEFORE-FAIL')
    expect(result).toContain('退出码 3')
  }, 20_000)

  test('工作目录就是 ctx.cwd（不是测试进程的 cwd）', async () => {
    const cwd = workdir()
    const result = await createBashTool().run(
      { command: nodeScript("console.log(require('node:fs').realpathSync.native(process.cwd()))") },
      ctx(cwd),
    )
    expect(String(result).trim()).toBe(realpathSync.native(cwd))
  }, 20_000)

  test('环境脱敏：DSC_* 私有变量与密钥形状变量都进不去，普通变量照常继承', async () => {
    const names = ['DSC_EXTRA_API_KEY', 'DSC_WORKSPACE', 'PLAIN_HELLO'] as const
    const before = names.map((name) => process.env[name])
    process.env['DSC_EXTRA_API_KEY'] = 'should-not-leak'
    process.env['DSC_WORKSPACE'] = 'should-not-leak'
    process.env['PLAIN_HELLO'] = 'world'
    try {
      const result = await createBashTool().run(
        {
          command: nodeScript(
            [
              "console.log('plain=' + (process.env.PLAIN_HELLO ?? 'missing'))",
              "console.log('secret=' + (process.env.DSC_EXTRA_API_KEY ?? 'scrubbed'))",
              "console.log('dsc=' + (process.env.DSC_WORKSPACE ?? 'scrubbed'))",
            ].join('\n'),
          ),
        },
        ctx(),
      )
      expect(result).toContain('plain=world')
      expect(result).toContain('secret=scrubbed')
      expect(result).toContain('dsc=scrubbed')
      expect(result).not.toContain('should-not-leak')
    } finally {
      names.forEach((name, index) => {
        const value = before[index]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      })
    }
  }, 20_000)

  test('命令没有任何输出：给「（无输出）」占位，而不是空串', async () => {
    const result = await createBashTool().run({ command: nodeScript('') }, ctx())
    expect(result).toBe('（无输出）')
  }, 20_000)

  test('cwd 不存在：spawn 失败冒成异常（ENOENT），不挂在超时上', async () => {
    const missing = join(workdir(), 'no-such-dir')
    await expect(createBashTool().run({ command: nodeScript('') }, ctx(missing))).rejects.toThrow(/ENOENT/)
  }, 20_000)
})

describe('createBashTool：超时与取消', () => {
  test('timeoutMs 低于 1000 被夹到 1000：到点交回已收输出 + 终止说明', async () => {
    const result = await createBashTool(budgets({ timeoutMs: 5_000 })).run(
      { command: nodeScript("console.log('BEFORE-HANG'); setTimeout(() => {}, 30_000)"), timeoutMs: 1 },
      ctx(),
    )
    expect(result).toContain('命令超时（1000ms）')
    expect(result).toContain('已请求终止')
    expect(result).toContain('BEFORE-HANG')
  }, 20_000)

  test('timeoutMs 超过上限被夹到 maxTimeoutMs', async () => {
    const result = await createBashTool(budgets({ timeoutMs: 30_000, maxTimeoutMs: 1_500 })).run(
      { command: nodeScript("console.log('BEFORE-MAX'); setTimeout(() => {}, 30_000)"), timeoutMs: 999_999 },
      ctx(),
    )
    expect(result).toContain('命令超时（1500ms）')
    expect(result).toContain('BEFORE-MAX')
  }, 20_000)

  test('取消信号：返回「命令被用户取消」并保留取消前输出', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const result = await createBashTool().run(
      { command: nodeScript("console.log('BEFORE-ABORT'); setTimeout(() => {}, 30_000)") },
      ctx(workdir(), controller.signal),
    )
    expect(result).toContain('命令被用户取消')
    expect(result).toContain('BEFORE-ABORT')
  }, 20_000)
})

describe('createBashTool：输出处理', () => {
  test('超过 outputChars：工具层接上截断（留头留尾 + 省略标记）', async () => {
    const result = await createBashTool(budgets({ outputChars: 100 })).run(
      { command: nodeScript("console.log('HEAD-MARK' + 'x'.repeat(300) + 'TAIL-MARK')") },
      ctx(),
    )
    expect(result).toContain('中间省略')
    expect(result).toContain('HEAD-MARK')
    expect(result).toContain('TAIL-MARK')
  }, 20_000)

  test('tty=true：输出原样保留 ANSI 控制序列，不走截断', async () => {
    const result = await createBashTool(budgets({ outputChars: 50 })).run(
      {
        command: nodeScript(
          "process.stdout.write('\\u001b[31m' + 'RED'.repeat(30) + '\\u001b[0mANSI-TAIL')",
        ),
        tty: true,
      },
      ctx(),
    )
    expect(result).toContain('\u001b[31m')
    expect(result).toContain('ANSI-TAIL')
    expect(result).not.toContain('中间省略')
  }, 20_000)

  test('命令文本命中网络拉取：结果套不可信围栏（curl 出现在注释里也拦，宁严勿松）', async () => {
    const result = await createBashTool().run({ command: 'echo NET-MARK # curl' }, ctx())
    expect(result).toContain('<external_content source="bash">')
    expect(result).toContain('NET-MARK')
    expect(result).toContain('</external_content>')

    // 同一条规则直接验一遍：大小写、可执行文件后缀、词边界。
    for (const command of ['curl https://example.com', 'WGET x', 'Invoke-WebRequest x', 'iwr x', 'curl.exe x']) {
      expect(NETWORK_FETCH_RE.test(command), command).toBe(true)
    }
    expect(NETWORK_FETCH_RE.test('curly braces')).toBe(false)
  }, 20_000)
})

describe('createBashTool：后台旁路与进程登记表', () => {
  test('run_in_background=true：把命令、cwd、会话 id 交给作业表并返回 job id', async () => {
    const calls: Array<{ command: string; cwd: string; owner?: string }> = []
    const tool = createBashTool(budgets(), {
      launch: (command, cwd, owner) => {
        calls.push({ command, cwd, owner })
        return 'job-42'
      },
    })
    const cwd = workdir()
    const result = await tool.run({ command: 'echo hi', run_in_background: true }, ctx(cwd))
    expect(result).toContain('已转入后台：job-42')
    expect(result).toContain('job_output(job_id="job-42")')
    expect(calls).toEqual([{ command: 'echo hi', cwd, owner: 'sess-extra' }])
  })

  test('没有后台作业表时请求转后台：明确拒绝，不静默前台跑', async () => {
    await expect(createBashTool().run({ command: 'echo hi', run_in_background: true }, ctx())).rejects.toThrow(
      /后台作业表不可用/,
    )
  })

  test('登记表：track/untrack/tracked/stop 与整表收尾', () => {
    const first = { pid: undefined } as unknown as ChildProcess
    const second = { pid: undefined } as unknown as ChildProcess
    trackBackgroundChild('k-1', first)
    expect(trackedBackgroundChild('k-1')).toBe(first)
    untrackBackgroundChild('k-1')
    expect(trackedBackgroundChild('k-1')).toBeUndefined()
    // 未登记的键：stop 返回 false，不抛。
    expect(stopBackgroundChild('k-1')).toBe(false)
    trackBackgroundChild('k-1', first)
    trackBackgroundChild('k-2', second)
    expect(stopBackgroundChild('k-1')).toBe(true)
    expect(trackedBackgroundChild('k-1')).toBeUndefined()
    expect(trackedBackgroundChild('k-2')).toBe(second)
    stopAllBackgroundChildren()
    expect(trackedBackgroundChild('k-2')).toBeUndefined()
    // pid 未定的进程收尾是 no-op，不该抛。
    expect(() => killTree(first)).not.toThrow()
  })
})

describe('JobTable：启动失败与环形缓冲的绝对偏移', () => {
  test('spawn 起不来（cwd 不存在）：job 记 failed + onError，通知里说启动失败', async () => {
    const missing = join(workdir(), 'no-such-dir')
    const notes: string[] = []
    const table = new JobTable({ notify: (text) => notes.push(text) })
    const id = table.launch('echo hi', missing)
    await until(() => (table.get(id)?.status === 'running' ? undefined : true), '作业启动失败')
    const job = table.get(id)!
    expect(job.status).toBe('failed')
    expect(job.exitCode).toBeNull()
    expect(job.output).toContain('[启动失败：')
    expect(notes[0]).toContain(`后台作业 ${id} 启动失败`)
  }, 20_000)

  test('头部被丢过（dropped>0）：output/peek 的 from 是绝对偏移，低于 dropped 的 offset 被夹回来', () => {
    const table = new JobTable({ notify: () => undefined })
    const internals = table as unknown as { jobs: Map<string, JobRecord> }
    internals.jobs.set('job-1', {
      id: 'job-1',
      command: 'noisy',
      cwd: '',
      status: 'completed',
      exitCode: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      output: 'x'.repeat(JOB_OUTPUT_CAP),
      dropped: 5_000,
      lastRead: 0,
      networkFetch: false,
    })

    const total = JOB_OUTPUT_CAP + 5_000
    const tail = table.output('job-1')
    expect(tail.from).toBe(total - JOB_VIEW_CHARS)
    expect(tail.text).toHaveLength(JOB_VIEW_CHARS)
    expect(tail.droppedChars).toBe(5_000)
    expect(tail.atEnd).toBe(true)
    expect(tail.totalChars).toBe(total)

    // 请求已经被丢掉的头部：夹到现存输出的开头（离末尾还远，回包带续读提示）。
    const clamped = table.output('job-1', 10)
    expect(clamped.from).toBe(5_000)
    expect(clamped.atEnd).toBe(false)
    expect(clamped.text).toContain('后面还有')
    expect(clamped.text.startsWith('xxxx')).toBe(true)

    const peeked = table.peek('job-1', 10)
    expect(peeked.from).toBe(total - 10)
    expect(peeked.text).toHaveLength(10)
    expect(peeked.atEnd).toBe(true)
  })
})

describe('TerminalTable：会话数上限', () => {
  test('开到第 9 个：给一句能照做的上限提示；未知会话带现有 id', () => {
    const table = new TerminalTable()
    const internals = table as unknown as { sessions: Map<string, TerminalRecord> }
    for (let index = 0; index < 8; index += 1) {
      const id = `term-${String(index + 1)}`
      internals.sessions.set(id, {
        id,
        cwd: '',
        status: 'running',
        exitCode: null,
        startedAt: Date.now(),
        lastSent: '',
        output: '',
        dropped: 0,
        lastRead: 0,
      })
    }
    expect(() => table.open()).toThrow(/终端会话已到 8 个上限/)
    expect(() => table.read('term-404')).toThrow(/没有这个终端会话：term-404（现有的会话：term-/)
  })
})
