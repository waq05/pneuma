/**
 * bash 输出截断：超预算时留头也留尾（迁自 `scripts/bash-truncation-test.mjs`）。
 *
 * ## 为什么值得单独一条
 *
 * 0.7.1 之前只留开头 `output.slice(0, outputLimit)`：编译错误、测试断言、退出前的报错
 * 几乎都在末尾，于是模型拿着前几千字进度条，看不到真正的失败原因。现在按头 60% +
 * 省略标记 + 尾 40% 切，标记里写清省了多少字符。
 *
 * ## 四段
 *
 *   ① 纯函数 `truncateBashOutput`：短输出原样返回；
 *   ② 纯函数的切法与标记（头尾都在、中间写明省了多少字符）；
 *   ③ **真跑一次子进程**，确认 `spawnShell` 真的走了这条切法（不是只测了没接线的函数）；
 *   ④ 超过字节上限（`outputLimit * 4`）真正丢字节时，结果末尾必须补一句「已丢弃 N 字节」
 *      ——tty 分支跳过了省略标记，不补就等于静默丢尾部；没超上限时不许出现这句。
 *
 * ## 为什么第 ③ 段必须是真子进程
 *
 * 第 ④ 段用假 `spawn` 喂确定的分块（真子进程的分块边界取决于管道缓冲，断不出「到底
 * 该丢多少字节」）；但假 spawn 同时也把「函数有没有接进主路径」这件事绕过去了，
 * 所以另留一条真进程：输出超上限，末尾报错必须还在。
 *
 * 落位：放在 integration 层是因为第 ③ 段要 spawn 一个真 node 子进程（unit 层 5 秒超时
 * 卡得太紧，且 unit 跑在线程池里）。
 *
 * @module @pneuma/tools-default/tests/bash-truncation.int.spec
 */
import { spawnShell, truncateBashOutput } from '../bash.js'
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import type { SpawnPlan } from '../../../core/tools/command-runner.js'

/** 真子进程的临时工作目录（Windows 的 tmpdir 带短名，realpath 后再用）。 */
const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsc-bash-trunc-')))

/** 一次 data 事件喂什么：测「丢了多少字节」时由它控制分块边界。 */
interface FakeChunkPlan {
  chunks: Buffer[]
  tty?: boolean
}

/** 造一个假执行器：按给定分块发 data，然后 close(0)。 */
function fakeSpawn(plan: FakeChunkPlan): SpawnPlan {
  return {
    file: 'fake-shell',
    args: [],
    cwd,
    env: {},
    ...(plan.tty === true ? { tty: true } : {}),
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      setImmediate(() => {
        for (const chunk of plan.chunks) child.stdout.emit('data', chunk)
        child.emit('close', 0)
      })
      return child as unknown as ChildProcess
    },
  }
}

/** 跑一次假执行器（默认给足超时；这里没有真进程，不会真等）。 */
function runFake(plan: FakeChunkPlan, outputLimit: number): Promise<string> {
  return spawnShell(fakeSpawn(plan), 20_000, outputLimit, new AbortController().signal)
}

describe('① 短输出：一个字节都不动', () => {
  test('不超过上限时原样返回', () => {
    const short = '只有一行输出'
    expect(truncateBashOutput(short, 100)).toBe(short)
  })

  test('刚好等于上限也不截', () => {
    expect(truncateBashOutput('x'.repeat(100), 100)).toBe('x'.repeat(100))
  })
})

describe('② 长输出：头 60% + 标记 + 尾 40%', () => {
  /** 这一节的输出上限。 */
  const limit = 1_000
  /** 中间用不同的字填充，方便确认「省略」的确实是中段而不是头或尾。 */
  const head = `HEAD-开头第一行\n${'h'.repeat(400)}`
  const middle = `${'m'.repeat(2_500)}MIDDLE-SHOULD-BE-GONE${'m'.repeat(2_500)}`
  const tail = `${'t'.repeat(400)}\nFINAL-ERROR: 最后一行才是报错`
  const output = head + middle + tail
  const truncated = truncateBashOutput(output, limit)
  /** 保留的正文字符数（头 600 + 尾 400；标记本身另算）。 */
  const markerStart = truncated.indexOf('\n…（中间省略')
  const markerEnd = truncated.indexOf('）\n', markerStart) + 2
  const bodyChars = truncated.length - (markerEnd - markerStart)

  test('开头内容保留', () => {
    expect(truncated.startsWith('HEAD-开头第一行')).toBe(true)
  })

  test('尾部报错保留（真正的失败原因在末尾）', () => {
    expect(truncated.endsWith('FINAL-ERROR: 最后一行才是报错')).toBe(true)
  })

  test('中间省略标记写明了省多少字符', () => {
    expect(truncated).toMatch(/中间省略 \d+ 字符/)
  })

  test('标记里有「完整输出」往哪看的说明', () => {
    expect(truncated).toContain('完整输出')
  })

  test('头 60% + 尾 40% 都算进预算（保留正文 = 上限）', () => {
    expect(bodyChars).toBe(limit)
  })

  test('省略字数 = 原长 - 保留字数', () => {
    const omitted = Number(/中间省略 (\d+) 字符/.exec(truncated)?.[1])
    expect(omitted).toBe(output.length - bodyChars)
  })

  test('被省略的中段没有漏进来', () => {
    expect(truncated).not.toContain('MIDDLE-SHOULD-BE-GONE')
  })
})

describe('③ 真子进程：spawnShell 走同一条截断', () => {
  /** 输出上限：总量压在 2 倍以内，只测切法（字节上限那条在 ④）。 */
  const outputLimit = 600
  /** 打 6 行长输出，最后一行是报错。 */
  const script = [
    "const pad = 'x'.repeat(100)",
    'for (let i = 0; i < 6; i += 1) console.log(`head-${i} ${pad}`)',
    "console.log('FINAL-ERROR: 找不到模块 approval.ts')",
  ].join('\n')

  let result = ''

  test('子进程跑完并交回正文', async () => {
    result = await spawnShell(
      { file: process.execPath, args: ['-e', script], cwd, env: process.env },
      20_000,
      outputLimit,
      new AbortController().signal,
    )
    expect(result.length).toBeGreaterThan(0)
  })

  test('保留了开头', () => {
    expect(result).toContain('head-0')
  })

  test('保留了结尾报错（模型看得到真正的失败原因）', () => {
    expect(result).toContain('FINAL-ERROR: 找不到模块 approval.ts')
  })

  test('带省略标记与字数（真的截了，不是没超上限）', () => {
    expect(result).toMatch(/中间省略 \d+ 字符/)
  })
})

describe('④ 超过字节上限：丢掉的字节必须说出来（tty 分支尤其不能静默）', () => {
  /** 上限 = outputLimit * 4 = 400 字节。 */
  const outputLimit = 100
  /** 前两块进缓冲（300 + 300，第二块把 bytes 推过 400），后两块整块丢掉 = 1000 字节。 */
  const chunks = [Buffer.alloc(300, 'a'), Buffer.alloc(300, 'b'), Buffer.alloc(500, 'c'), Buffer.alloc(500, 'd')]

  describe('tty 分支（终端流要原样，不能用省略标记）', () => {
    let ttyOut = ''

    test('跑完', async () => {
      ttyOut = await runFake({ chunks, tty: true }, outputLimit)
      expect(ttyOut.length).toBeGreaterThan(0)
    })

    test('输出里有「已丢弃」提示', () => {
      expect(ttyOut).toContain('已丢弃')
    })

    test('提示带具体字节数（1000）', () => {
      expect(ttyOut).toMatch(/已丢弃 1000 字节/)
    })

    test('提示写明上限是多少字节', () => {
      expect(ttyOut).toContain('400 字节')
    })

    test('不套用 truncateBashOutput 的省略标记', () => {
      expect(ttyOut).not.toContain('中间省略')
    })

    test('丢之前的内容仍然保留', () => {
      expect(ttyOut).toContain('aaa')
      expect(ttyOut).toContain('bbb')
    })
  })

  describe('非 tty 分支（两条提示互补，不重复）', () => {
    let plainOut = ''

    test('同样补一句「已丢弃 1000 字节」', async () => {
      plainOut = await runFake({ chunks }, outputLimit)
      expect(plainOut).toMatch(/已丢弃 1000 字节/)
    })

    test('原有「中间省略」提示仍在', () => {
      expect(plainOut).toMatch(/中间省略 \d+ 字符/)
    })
  })

  test('没超过字节上限时不含「已丢弃」（回归）', async () => {
    const smallOut = await runFake({ chunks: [Buffer.from('short-output')], tty: true }, outputLimit)
    expect(smallOut).not.toContain('已丢弃')
  })
})
