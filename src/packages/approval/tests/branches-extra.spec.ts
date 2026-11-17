/**
 * approval 的分支补充测试：diff 推演的降级、判官历史的来源角色与裁剪。
 *
 * 两块：
 *   - `approvalDiffOf` 的失败/降级分支（参数不齐、目标已存在、old 对不上、ops 编辑重叠）；
 *   - 真装一次插件，用假 ctx 走 auto-review：验证 `reviewRoleOf` 把通知/摘要/目标续跑
 *     都认成 fact、子代理指令降级、任务状态与历史工具调用进判官请求、超长历史被裁剪。
 *
 * `DSC_HOME` 在任何 import 之前指进临时目录。
 *
 * @module dsc/packages/approval/tests/branches-extra
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { SUMMARY_BANNER } from '@pneuma/runtime/core/compact-anchors.js'
import { TEAMMATE_REPORT_OPEN } from '@pneuma/runtime/core/team-board.js'
import { TODO_REMINDER_TEXT } from '@pneuma/runtime/core/todo-reminder.js'
import type { ApprovalRequest } from '@pneuma/runtime/contract.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-approval-branches-'))
process.env['DSC_HOME'] = HOME
const WORK = join(HOME, 'work')
mkdirSync(WORK, { recursive: true })

const { approvalDiffOf, approvalPlugin } = await import('../index.js')

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const requestOf = (toolName: string, args: Record<string, unknown> | undefined, cwd = WORK): ApprovalRequest =>
  ({ toolName, argsSummary: '', args, cwd }) as ApprovalRequest

// ── approvalDiffOf 的降级分支 ────────────────────────────────────────────────

test('diff 推演：参数不齐/目标已存在/源文件读不到都回到 null，目录替换不算差异', async () => {
  // 参数整个缺失：ops_remove 的 target 认不出 → null。
  expect(await approvalDiffOf(requestOf('ops_remove', undefined))).toBeNull()
  // write 没给 content。
  expect(await approvalDiffOf(requestOf('write', { path: join(WORK, 'x.txt') }))).toBeNull()
  // edit 缺 old/new。
  expect(await approvalDiffOf(requestOf('edit', { path: join(WORK, 'x.txt'), old: 'a' }))).toBeNull()
  // ops_edit_file 没给 edits。
  expect(await approvalDiffOf(requestOf('ops_edit_file', { path: join(WORK, 'x.txt'), edits: [] }))).toBeNull()
  // ops_replace 的 pattern 是空串。
  expect(await approvalDiffOf(requestOf('ops_replace', { path: join(WORK, 'x.txt'), pattern: '' }))).toBeNull()

  // ops_copy 的目标已经存在：不覆盖，也不给 diff。
  const source = join(WORK, 'src.txt')
  const target = join(WORK, 'dst.txt')
  writeFileSync(source, 'src\n', 'utf8')
  writeFileSync(target, 'dst\n', 'utf8')
  expect(await approvalDiffOf(requestOf('ops_copy', { path: source, to: target }))).toBeNull()
  // 源文件不存在。
  expect(await approvalDiffOf(requestOf('ops_move', { path: join(WORK, 'no-src.txt'), to: target }))).toBeNull()

  // ops_replace 指向目录：stat 后不是文件 → null。
  mkdirSync(join(WORK, 'a-dir'), { recursive: true })
  expect(await approvalDiffOf(requestOf('ops_replace', { path: join(WORK, 'a-dir'), pattern: 'a', replacement: 'b' }))).toBeNull()
  // ops_remove 文件已经不在。
  expect(await approvalDiffOf(requestOf('ops_remove', { path: join(WORK, 'gone.txt') }))).toBeNull()
})

test('diff 推演：文件不在时 ops_edit_file 用参数差异兜底；多处/重叠/缺失各报 mismatch', async () => {
  const missingFile = join(WORK, 'not-yet.txt')
  const fallback = await approvalDiffOf(
    requestOf('ops_edit_file', {
      path: missingFile,
      edits: [{ oldText: 'old', newText: 'new' }],
    }),
  )
  expect(fallback).toMatchObject({ status: 'modified', fellBack: true })
  expect(fallback?.added).toBe(1)

  const file = join(WORK, 'edits.txt')
  writeFileSync(file, 'alpha beta gamma\n', 'utf8')
  const ok = await approvalDiffOf(
    requestOf('ops_edit_file', {
      path: file,
      edits: [{ oldText: 'alpha', newText: 'A' }, { oldText: 'gamma', newText: 'G' }],
    }),
  )
  expect(ok?.mismatch).toBeUndefined()
  // 同一行里换了两处，diff 仍是一行增一行删。
  expect(ok?.added).toBe(1)

  const ambiguous = await approvalDiffOf(
    requestOf('ops_edit_file', {
      path: file,
      edits: [{ oldText: 'a', newText: 'x' }],
    }),
  )
  expect(ambiguous?.mismatch).toBe('ambiguous')

  const missing = await approvalDiffOf(
    requestOf('ops_edit_file', {
      path: file,
      edits: [{ oldText: '不在', newText: 'x' }],
    }),
  )
  expect(missing?.mismatch).toBe('missing')

  const overlap = await approvalDiffOf(
    requestOf('ops_edit_file', {
      path: file,
      edits: [{ oldText: 'alpha beta', newText: 'x' }, { oldText: 'beta', newText: 'y' }],
    }),
  )
  expect(overlap?.mismatch).toBe('ambiguous')

  // ops_replace 正常替换；ops_edit_file 的坏 edit 项当空串跳过。
  const replaced = await approvalDiffOf(
    requestOf('ops_replace', { path: file, pattern: 'beta', replacement: 'B' }),
  )
  expect(replaced?.added).toBe(1)
  expect(await approvalDiffOf(requestOf('ops_edit_file', { path: file, edits: [null, { oldText: 3 }] }))).toBeNull()
})

// ── auto-review 的历史组装 ───────────────────────────────────────────────────

interface Harness {
  decide(request: ApprovalRequest, signal?: AbortSignal): Promise<string>
  llmRequests: Array<Record<string, unknown>>
}

function mount(options: {
  messages: Array<Record<string, unknown>>
  childAgent?: boolean
  goal?: unknown
  todos?: unknown[]
  tools?: Array<{ name: string; description: string; parameters: unknown }>
  prefs?: { defaultPolicy?: string; defaultReviewer?: string }
  llmText?: string
}): Harness {
  const llmRequests: Array<Record<string, unknown>> = []
  const services = new Map<string, unknown>()
  const session = {
    meta: { id: 'sess-1', cwd: WORK },
    filePath: join(WORK, 'sess-1.jsonl'),
    messages: options.messages,
    state(id: string) {
      if (id === 'goal') return options.goal
      if (id === 'todos') return options.todos
      return undefined
    },
  }
  const optional = new Map<string, unknown>()
  optional.set('agent', { sessionById: (id: string) => (id === 'sess-1' ? session : undefined), sessionFor: () => session })
  optional.set('settings', {
    prefs: () => ({
      defaultPolicy: options.prefs?.defaultPolicy ?? 'full-access',
      defaultReviewer: options.prefs?.defaultReviewer ?? 'auto-review',
    }),
  })
  optional.set('interactive', { reachable: () => true })
  optional.set('tools', { list: () => options.tools ?? [] })
  if (options.childAgent === true) {
    optional.set('subagent', { list: () => [{ file: session.filePath }] })
  }
  const llm = {
    routeForSession: () => ({ api: 'test-api', baseUrl: 'https://fake', apiKey: 'k', model: 'judge', cacheControl: true }),
    providerOf: () => 'fake',
    stream: async (_api: unknown, request: Record<string, unknown>) => {
      llmRequests.push(request)
      return {
        text: options.llmText ?? '{"risk":"low","decision":"allow"}',
        reasoning: '',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: 'stop',
      }
    },
  }
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const ctx = {
    effect: (fn: () => unknown) => {
      const off = fn()
      return typeof off === 'function' ? off : () => undefined
    },
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => undefined
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of handlers.get(event) ?? []) handler(...args)
    },
    provide: (name: string, value: unknown) => services.set(name, value),
    get: (name: string) => optional.get(name),
    guards: { register: () => () => undefined, registerObserver: () => () => undefined },
    surfaces: { register: () => () => undefined },
    waiting: { register: () => () => undefined },
    session: { current: () => session },
    llm,
    logger: { warn: () => undefined, debug: () => undefined },
  }
  approvalPlugin.apply?.(ctx as never, {})
  const service = services.get('approval') as { decide: (request: ApprovalRequest, signal: AbortSignal) => Promise<string> }
  return {
    decide: (request, signal = new AbortController().signal) => service.decide(request, signal),
    llmRequests,
  }
}

function pendingRequest(args: Record<string, unknown> = { command: 'rm -rf build' }): ApprovalRequest {
  return {
    toolName: 'bash',
    argsSummary: JSON.stringify(args),
    args,
    cwd: WORK,
    sessionId: 'sess-1',
    sessionPath: join(WORK, 'sess-1.jsonl'),
  } as ApprovalRequest
}

function message(role: string, content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { role, content, ...extra }
}

test('auto-review：通知/摘要/目标续跑都降成 fact，子代理指令降级，任务状态与工具定义进请求', async () => {
  const messages: Array<Record<string, unknown>> = [
    message('user', '把 build 清掉', {}),
    message('user', '程序通知', { origin: 'notice' }),
    message('user', '   '),
    message('user', TODO_REMINDER_TEXT),
    message('user', '（本条是程序在每次请求时自动附上的当前环境快照：cwd=/x）'),
    message('user', '<external_content source="hook:stop">钩子输出</external_content>'),
    message('user', `${TEAMMATE_REPORT_OPEN}\n队友汇报`),
    message('user', `${SUMMARY_BANNER}\n压缩摘要`),
    message('user', '后台作业 abc 完成'),
    message('user', '（目标自动续跑：继续第 2 轮）'),
    message('tool', '命令输出'),
  ]

  // 后面的历史把上面这批挤到 60 条之外，顺带验证「最近的授权来源被钉住」。
  for (let index = 0; index < 70; index += 1) messages.push(message('user', `第 ${String(index)} 条推进`))
  // 压缩摘要放在最近这一截里：它的 checkpoint 角色不该被裁掉。
  messages.push(message('user', `${SUMMARY_BANNER}\n压缩摘要`))
  // 当前这条 assistant 带着待审调用（以及一个没有工具定义的调用）：留在最近一截里。
  messages.push(
    message('assistant', null, {
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'ls' }) } },
        { id: 'c2', type: 'function', function: { name: 'unknown_tool', arguments: '{}' } },
        { id: 'c3', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'rm -rf build' }) } },
      ],
    }),
  )

  const harness = mount({
    messages,
    childAgent: true,
    goal: { phase: 'active', objective: '清掉构建产物', rounds: 1, maxRounds: 5 },
    todos: [
      { status: 'in_progress', content: '收尾' },
      { status: 'pending', content: '复查' },
      { status: 'completed', content: '已做' },
    ],
    tools: [{ name: 'bash', description: '跑命令', parameters: { type: 'object' } }],
  })
  expect(await harness.decide(pendingRequest())).toBe('allow-once')

  const request = harness.llmRequests[0]!
  const payload = (request.messages as Array<{ content: string }>).map((item) => item.content).join('\n')
  expect(payload).toContain('ENVIRONMENT')
  expect(payload).toContain('pending-call')
  // 任务状态以 fact 入队，并钉了「不是用户原话」。
  expect(payload).toContain('不是用户原话')
  // 子代理的普通用户消息降成 direct-parent-instruction。
  expect(payload).toContain('父代理')
  // 各类程序消息都在历史里，但角色是 fact / checkpoint。
  expect(payload).toContain('"role": "fact"')
  expect(payload).toContain('"role": "checkpoint"')
  // 工具定义按名字出现（未在注册表里的 unknown_tool 只留调用记录，没有定义条目）。
  expect(payload).toContain('跑命令')
  expect(payload).toContain('"kind": "tool-schema"')
})

test('auto-review：超长参数在 pending-call 里只给截断预览', async () => {
  const harness = mount({ messages: [message('user', '允许我写一份很大的文件')] })
  const huge = { content: 'x'.repeat(25_000), path: join(WORK, 'huge.txt') }
  expect(await harness.decide({ ...pendingRequest(huge), toolName: 'write' } as ApprovalRequest)).toBe('allow-once')
  const payload = (harness.llmRequests[0]!.messages as Array<{ content: string }>)
    .map((item) => item.content)
    .join('\n')
  expect(payload).toContain('"truncated": true')
  expect(payload).toContain('"preview"')
})
