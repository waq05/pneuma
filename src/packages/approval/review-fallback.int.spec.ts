/**
 * 审阅者（AI 复核 / auto-review）的结局、判官看见的历史与失败回退（integration 层，原
 * `scripts/approval-review-fallback-test.mjs`）。
 *
 * 这一层钉的是「谁被放行、谁被拒、拒的理由」——审批这件事只有这三个答案：
 *
 *   ① **结局**：allow 直接过；deny 弹卡；非法输出算「协议错」弹卡；网络错/超时算「没跑完」，
 *      默认回落到用户自己选的那一档，配置 `approval.failClosed` 打开时改成弹卡。
 *   ② **输入**：判官看见的是「保留历史 + 来源角色 + 任务状态」，不是「工具名 + 最后一句原话」。
 *      每条来源角色的判据都在这一层用真会话消息验一遍。
 *   ③ **范围**：升权/只读这些边角不让判官替用户签字。
 *
 * ## 为什么每条用例自己起一只内核
 *
 * 判官的应答由 `fakeLLM` 的剧本按**请求序号**发放；一只内核跑多条不同应答的用例，
 * 顺序错一位就会把「判官说 allow」测成「判官说 deny」。所以每条用例自带剧本、自带内核，
 * 重试（integration 层 `retry: 1`）也不会串味。代价是每条多约 1 秒装配。
 *
 * 判官本身是一个**模型请求**：`fakeLLM` 只回它，`llm.bodies` 就是判官真正看到的输入。
 *
 * ## 隔离
 *
 * HOME 由 integration 层提供；`plugins.json` 每条用例重写（沙箱关、标题插件关、审批卡
 * 超时压到 10 秒），会话落盘与判官用量都写在临时 `DSC_HOME` 里。
 *
 * @module dsc/packages/approval/review-fallback.int.spec
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DSC_HOME } from '@pneuma/runtime/core/path-policy.js'
import { bootKernel, fakeLLM, readSessionJsonl, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'

/** 本文件的工作目录：每只内核都在这下面新建会话。 */
const WORK = join(DSC_HOME, '..', 'review-ws')
/** 工作区外的目标：判官缺席时这条必须弹卡（不能按「工作区内」放行）。 */
const OUTSIDE = join(DSC_HOME, '..', 'review-outside.txt')
/** 判官的合法放行：low + allow。 */
const JUDGE_ALLOW = '{"risk":"low","decision":"allow"}'

/** 内核里本文件用到的服务面。 */
interface Card {
  toolName: string
  reason: string
  risk: string
  scopes: string[]
}

interface SessionView {
  meta: { id: string; cwd: string }
  filePath: string
  messages: Array<{ role: string; content: unknown }>
  appendUser(text: string, images?: string[], files?: unknown[], origin?: string): void
  appendAssistant(text: string, reasoning: string, toolCalls: unknown[]): void
  appendState(id: string, payload: unknown): void
}

interface Probe {
  ctx: {
    on(event: 'dsc/notice', listener: (text: string) => void): () => void
    provide(name: string, value: unknown): void
    approval: {
      decide(request: RequestOf, signal: AbortSignal): Promise<string>
      pendingView(): Card | null
      answer(answer: 'reject' | 'allow-once' | 'allow-session'): void
      setPolicy(next: string): void
      setReviewer(next: string): void
    }
    session: { current(): SessionView }
    ui: { newSessionIn(cwd: string): Promise<void> }
  }
  llm: FakeLLM | null
  session: { id: string; filePath: string; cwd: string }
  kernel: BootedKernel
  dispose(): Promise<void>
}

interface RequestOf {
  toolName: string
  argsSummary: string
  args?: Record<string, unknown>
  cwd?: string
  sessionId?: string
  sessionPath?: string
}

/** 每只内核一套配置；`judge` 给了就按它回应判官，`dead` 表示端点根本连不上。 */
interface BootOptions {
  judge?: string
  dead?: boolean
  failClosed?: boolean
  childAgent?: boolean
  /** 审阅者：默认 auto-review（这一批全是判官的路），「没有审阅者」那条传 user。 */
  reviewer?: 'user' | 'auto-review'
  /** 判官端点回非 2xx（401 是模型层不重试的那一类，立刻算「没跑完」）。 */
  status?: number
  prepare?(session: SessionView): void
}

/** 已起的内核：afterEach 统一收掉，用例失败也不会把句柄留在进程里。 */
const open: Probe[] = []

afterEach(async () => {
  while (open.length > 0) {
    const probe = open.pop()!
    await probe.dispose()
  }
})

/** 等条件成立；超时返回 false。 */
async function until(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

/** 起一只内核、落一条会话；判官应答由 `options.judge` 决定。 */
async function boot(options: BootOptions): Promise<Probe> {
  mkdirSync(WORK, { recursive: true })
  mkdirSync(DSC_HOME, { recursive: true })
  writeFileSync(
    join(DSC_HOME, 'plugins.json'),
    `${JSON.stringify(
      {
        version: 1,
        entries: [
          // 沙箱关掉：这一组测的是审批自己的裁决，沙箱边界在 escalation-scope 里测。
          { file: 'sandbox', disabled: true },
          { file: 'memory', config: { enabled: false } },
          // 标题插件会在回合之间多发一次模型请求，吃掉剧本里的判官那一轮。
          { file: 'session-title', disabled: true },
          {
            file: 'approval',
            config: { approvalTimeoutMs: 10_000, ...(options.failClosed === true ? { failClosed: true } : {}) },
          },

        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  const llm =
    options.dead === true
      ? null
      : await fakeLLM({
          turns: [options.judge ?? JUDGE_ALLOW],
          ...(options.status === undefined ? {} : { status: options.status }),
        })
  const kernel = await bootKernel({ providerBaseUrl: llm?.baseUrl ?? 'http://127.0.0.1:9' })
  const probe: Probe = {
    ctx: kernel.ctx as unknown as Probe['ctx'],
    llm,
    session: { id: '', filePath: '', cwd: '' },
    kernel,
    async dispose() {
      await kernel.dispose()
      await llm?.close()
    },
  }
  open.push(probe)
  // 「有人在看」：没有这个信号，审批插件判定「没人能答」，卡不弹、直接按拒。
  probe.ctx.provide('interactive', { kind: 'tui', reachable: () => true })
  await probe.ctx.ui.newSessionIn(WORK)
  const current = probe.ctx.session.current()
  // 会话要先落盘：守卫按会话身份解析权限档，读不回来的会话会被判成「已结束」直接拒。
  current.appendUser('（自检）让这条会话落盘')
  const deadline = Date.now() + 3_000
  for (;;) {
    try {
      if (readFileSync(current.filePath, 'utf8').includes('"type":"user"')) break
    } catch {
      // 还没建出来：继续等。
    }
    if (Date.now() > deadline) break
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
  probe.session = { id: current.meta.id, filePath: current.filePath, cwd: current.meta.cwd }
  if (options.childAgent === true) {
    // 子代理身份的唯一判据是名册：队友的运行记录文件就是子会话的 jsonl 路径。
    mkdirSync(join(DSC_HOME, 'team'), { recursive: true })
    writeFileSync(
      join(DSC_HOME, 'team', 'roster.json'),
      `${JSON.stringify(
        {
          teammates: [
            {
              name: 'reviewer-1',
              role: 'reviewer',
              state: 'done',
              task: '审查改动',
              file: current.filePath,
              cwd: current.meta.cwd,
              parent: '',
              depth: 1,
              rounds: 1,
              startedAt: 1,
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  }
  options.prepare?.(current)
  // 审阅者是按会话存的：不显式切到 auto-review，判官这条路根本走不到（默认是本人审）。
  probe.ctx.approval.setReviewer(options.reviewer ?? 'auto-review')
  return probe
}

/** 一次「写到工作区外」的审批请求（判官要判的就是它）。 */
function requestOf(probe: Probe, path = OUTSIDE, toolName = 'write', args?: Record<string, unknown>): RequestOf {
  return {
    toolName,
    argsSummary: `{"path":${JSON.stringify(path)}}`,
    args: args ?? { path, content: 'x' },
    cwd: probe.session.cwd,
    sessionId: probe.session.id,
    sessionPath: probe.session.filePath,
  }
}

/** 跑一次裁决；判官放行时不弹卡，直接拿到结论。 */
async function decide(probe: Probe, request: RequestOf, signal = new AbortController().signal): Promise<string> {
  return probe.ctx.approval.decide(request, signal)
}

/** 等卡冒出来、把卡面的东西交出来，再按给定答案点掉；返回裁决与卡面。 */
async function decideWithCard(
  probe: Probe,
  request: RequestOf,
  answer: 'reject' | 'allow-once' = 'reject',
  /**
   * 等卡出现的上限。判官连不上时要先走完模型层的重试才知道「没跑完」，
   * 那一段实测十几秒；默认 5 秒只够立刻就能出结论的那几条。
   */
  waitMs = 5_000,
): Promise<{ decision: string; card: Card }> {
  const pending = probe.ctx.approval.decide(request, new AbortController().signal)
  expect(await until(() => probe.ctx.approval.pendingView() !== null, waitMs)).toBe(true)
  const card = probe.ctx.approval.pendingView()!
  probe.ctx.approval.answer(answer)
  return { decision: await pending, card }
}

/** 判官这次收到的全部 user 消息正文（拼成一段便于按角色找）。 */
function judgeText(probe: Probe): string {
  const bodies = probe.llm?.bodies ?? []
  const messages = (bodies.at(-1) ?? []) as Array<{ role: string; content: string }>
  return messages.map((message) => message.content).join('\n')
}

/** 判官这次收到的完整 messages（断言顺序与第一条环境快照）。 */
function judgeMessages(probe: Probe): Array<{ role: string; content: string }> {
  const bodies = probe.llm?.bodies ?? []
  return (bodies.at(-1) ?? []) as Array<{ role: string; content: string }>
}

describe('① 判官放行 / 否决 / 缺席', () => {
  test('判官放行：直接过，不弹卡；判官看到环境快照、历史与待审调用', async () => {
    const probe = await boot({ judge: JUDGE_ALLOW })
    const decision = await decide(probe, requestOf(probe))
    expect(decision).toBe('allow-once')
    expect(probe.ctx.approval.pendingView()).toBeNull()

    const messages = judgeMessages(probe)
    // 第一条是系统提示（闭集协议），第二条是环境快照，最后一条是待审调用。
    expect(messages[0]?.content).toContain('{"risk":"low","decision":"allow"}')
    expect(messages[1]?.content).toBe(`ENVIRONMENT\n${JSON.stringify({ cwd: probe.session.cwd }, null, 2)}`)
    const last = messages.at(-1)?.content ?? ''
    expect(last).toContain('"kind": "pending-call"')
    expect(last).toContain('"tool": "write"')
  })

  test('判官判高风险：弹卡、不自动放行，卡上写明是判官判的；答拒之后卡就收', async () => {
    const probe = await boot({ judge: '{"risk":"high","decision":"deny","reason":"递归删目录"}' })
    const { decision, card } = await decideWithCard(probe, requestOf(probe))
    expect(decision).toBe('reject')
    expect(card.reason).toContain('AI 复核判为高风险')
    expect(card.reason).toContain('递归删目录')
    expect(card.risk).toBe('high')
    expect(probe.ctx.approval.pendingView()).toBeNull()
  })

  test('判官说不放行：卡上带出判官的原话', async () => {
    const probe = await boot({ judge: '{"risk":"medium","decision":"deny","reason":"本轮只要求读日志，没有授权改迁移脚本"}' })
    const { card } = await decideWithCard(probe, requestOf(probe))
    expect(card.reason).toContain('没有授权改迁移脚本')
    expect(card.reason).toContain('AI 复核判不放行')
  })
})

describe('② 协议错与自相矛盾：弹卡，绝不走「判官没说完就放行」那条路', () => {
  test('不是 JSON：协议错弹卡，即使权限档是「完全访问」也不回落', async () => {
    const probe = await boot({ judge: '这不是 JSON，我是判官' })
    const first = await decideWithCard(probe, requestOf(probe))
    expect(first.card.reason).toContain('不合协议')
    // 2026-11-06 复审：完全访问档下协议错也弹卡——回落等于放行，等于没审。
    probe.ctx.approval.setPolicy('full-access')
    const second = await decideWithCard(probe, requestOf(probe))
    expect(second.card.reason).toContain('不合协议')
  })

  test('low + deny 自相矛盾：按否决落卡，不从「判官没给意见」那条路放行', async () => {
    const probe = await boot({ judge: '{"risk":"low","decision":"deny","reason":"低风险不许否决"}' })
    const { card } = await decideWithCard(probe, requestOf(probe))
    expect(card.reason).toContain('按否决处理')
  })

  test('high + allow 自相矛盾：按高风险落卡', async () => {
    const probe = await boot({ judge: '{"risk":"high","decision":"allow"}' })
    const { card } = await decideWithCard(probe, requestOf(probe))
    expect(card.risk).toBe('high')
    expect(card.reason).toContain('AI 复核')
  })

  test('allow 带 reason：闭集外的形状，协议错弹卡', async () => {
    const probe = await boot({ judge: '{"risk":"low","decision":"allow","reason":"多带理由也不行"}' })
    const { card } = await decideWithCard(probe, requestOf(probe))
    expect(card.reason).toContain('不合协议')
  })
})

describe('③ 判官缺席：默认回落到权限档，工作区外照旧弹卡', () => {
  test('工作区内的写：判官连不上 → 按 auto-edit 放行，不弹卡', async () => {
    const probe = await boot({ status: 401 })
    const decision = await decide(probe, requestOf(probe, join(probe.session.cwd, 'a.txt')))
    expect(decision).toBe('allow-once')
    expect(probe.ctx.approval.pendingView()).toBeNull()
  })

  test('工作区外的写：判官缺席也不放行，照旧弹卡', async () => {
    const probe = await boot({ status: 401 })
    const { decision, card } = await decideWithCard(probe, requestOf(probe))
    expect(decision).toBe('reject')
    expect(card.reason).toContain('AI 复核没跑完')
  })

  test('完全访问档：判官缺席时按该档放行', async () => {
    const probe = await boot({ status: 401 })
    probe.ctx.approval.setPolicy('full-access')
    expect(await decide(probe, requestOf(probe))).toBe('allow-once')
  })

  test('这一轮已被打断：判官缺席时也不放行', async () => {
    const probe = await boot({ dead: true })
    const controller = new AbortController()
    controller.abort()
    expect(await decide(probe, requestOf(probe), controller.signal)).toBe('reject')
    expect(probe.ctx.approval.pendingView()).toBeNull()
  })

  test('配置 failClosed：判官没跑完就弹卡，理由写明「失败即拒绝」', async () => {
    const probe = await boot({ status: 401, failClosed: true })
    const { card } = await decideWithCard(probe, requestOf(probe, join(probe.session.cwd, 'b.txt')))
    expect(card.reason).toContain('失败即拒绝')
  })
})

describe('④ 没有审阅者时行为不变；外层 run_code 不单独审', () => {
  test('本人审阅 + 工作区内写：按自动编辑放行，不问、也不叫判官', async () => {
    const probe = await boot({ judge: JUDGE_ALLOW, reviewer: 'user' })
    expect(await decide(probe, requestOf(probe, join(probe.session.cwd, 'c.txt')))).toBe('allow-once')
    expect(probe.llm?.requestCount).toBe(0)
  })

  test('run_code：auto-edit 下直接放行且不叫判官；仅查看模式仍然拒', async () => {
    const probe = await boot({ judge: JUDGE_ALLOW })
    const request = requestOf(probe, join(probe.session.cwd, 'x'), 'run_code', { code: 'return 1' })
    expect(await decide(probe, request)).toBe('allow-once')
    expect(probe.llm?.requestCount).toBe(0)
    probe.ctx.approval.setPolicy('readonly')
    expect(await decide(probe, request)).toBe('reject')
  })
})

describe('⑤ 判官看得见历史与来源角色', () => {
  test('真人指令 / 后台作业通知 / 队友汇报 / 历史调用 / 截断 / 待审调用只出现一次', async () => {
    const longWords = '读一下 src/plugins/approval.ts，告诉我它干什么。'.repeat(80)
    const probe = await boot({
      judge: JUDGE_ALLOW,
      prepare(session) {
        session.appendUser('把 a.txt 里的 x 改成 y')
        session.appendUser(longWords)
        session.appendUser('后台作业 job-1 成功完成。用 job_output 查看输出。', undefined, undefined, 'notice')
        session.appendUser('<teammate-report id="t1">队友汇报</teammate-report>')
        session.appendAssistant('我先读一下文件。', '', [
          { id: 'c1', name: 'read', arguments: '{"file_path":"a.txt"}' },
        ])
      },
    })
    expect(await decide(probe, requestOf(probe, OUTSIDE, 'write', { path: OUTSIDE, content: 'x' }))).toBe('allow-once')
    const text = judgeText(probe)
    // 真人指令：user-instruction。
    expect(text).toContain('"role": "user-instruction"')
    expect(text).toContain('把 a.txt 里的 x 改成 y')
    // 程序写的消息一律 fact，不能当授权。
    expect(/"role": "fact"[\s\S]{0,200}后台作业 job-1/.test(text)).toBe(true)
    expect(text).toContain('队友汇报')
    // 历史调用进历史；待审调用只在最后一条里出现。
    expect(text).toContain('"kind": "tool-call"')
    expect(text).toContain('"name": "read"')
    // 待审调用只出现一次；历史里只有那次 read 调用（write 这个名字还会出现在工具定义里，
    // 所以这里数的是「历史调用」这一类条目，不是名字出现过几次）。
    expect((text.match(/"kind": "pending-call"/g) ?? []).length).toBe(1)
    expect((text.match(/"kind": "tool-call"/g) ?? []).length).toBe(1)
    // 单条用户消息截到 1200 字。
    expect(text).toContain('…（已截断）')
    // 判官的花费也记一笔账。
    const usage = readSessionJsonl(join(DSC_HOME, 'usage', 'usage.jsonl'))
    const last = usage.at(-1) ?? {}
    expect(last.k).toBe('judge')
    expect(last.provider).toBe('test')
    expect(last.sid).toBe(probe.session.id)
    expect(typeof last.i).toBe('number')
  })

  test('任务状态进历史，但声明「不是用户原话」（模型自己写的不能当授权）', async () => {
    const probe = await boot({
      judge: JUDGE_ALLOW,
      prepare(session) {
        session.appendState('todos', [
          { id: 't1', content: '按教师隔离文档', status: 'in_progress' },
          { id: 't2', content: '补测试', status: 'pending' },
          { id: 't3', content: '旧任务', status: 'completed' },
        ])
        session.appendState('goal', {
          id: 'g1',
          revision: 1,
          objective: '完成文档隔离',
          phase: 'active',
          maxRounds: 10,
          rounds: 2,
        })
      },
    })
    await decide(probe, requestOf(probe))
    const text = judgeText(probe)
    expect(text).toContain('完成文档隔离')
    expect(text).toContain('按教师隔离文档')
    expect(text).toContain('补测试')
    // 已完成项不该占判官的注意力。
    expect(text).not.toContain('旧任务')
    expect(text).toContain('"kind": "task-state"')
    expect(text).toContain('不是用户原话')
  })

  test('项目规则（AGENTS.md）与工具定义都进历史，角色分别是 constraint 与 tool-schema', async () => {
    const probe = await boot({
      judge: JUDGE_ALLOW,
      prepare() {
        writeFileSync(join(WORK, 'AGENTS.md'), '# 约定\n改代码前先读文件；不要动 dist/。\n', 'utf8')
      },
    })
    await decide(probe, requestOf(probe))
    const text = judgeText(probe)
    expect(text).toContain('"role": "constraint"')
    expect(text).toContain('改代码前先读文件')
    expect(text).toContain('"kind": "tool-schema"')
    expect(text).toContain('"name": "write"')
  })

  test('历史裁剪之后仍带最早那条用户指令（长任务里授权不能被挤掉）', async () => {
    const probe = await boot({
      judge: JUDGE_ALLOW,
      prepare(session) {
        session.appendUser('这是最早的需求：把出题文档改成按班级隔离')
        // 70 条历史工具调用：超过单次评审 60 条的上限，最早那条用户指令如果被一起裁掉，
        // 后面的 medium 动作都会因为「找不到授权」被否——2026-11-06 报障的形状。
        for (let index = 0; index < 70; index += 1) {
          session.appendAssistant('', '', [
            { id: `c${String(index)}`, name: 'read', arguments: `{"file_path":"f${String(index)}.ts"}` },
          ])
        }
      },
    })
    expect(await decide(probe, requestOf(probe))).toBe('allow-once')
    expect(judgeText(probe)).toContain('这是最早的需求')
  })

  test('子代理会话：用户消息降成「父级指令」，并带来源说明', async () => {
    const probe = await boot({ judge: JUDGE_ALLOW })
    // 名册是外部边界（子代理插件的队友台账），这里给一份只有这条会话的桩：
    // 审批只需要 `list()`，而 subagent 插件出厂是关的。
    probe.ctx.provide('subagent', { list: () => [{ file: probe.session.filePath }] })
    await decide(probe, requestOf(probe))
    const text = judgeText(probe)
    expect(text).toContain('"role": "direct-parent-instruction"')
    expect(text).toContain('来自派发这个子代理的父代理')
  })
})
