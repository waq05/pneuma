/**
 * TUI 整屏帧快照（P4 帧快照层）：30 个场景，逐字节钉住真渲染出的整屏帧。
 *
 * 一条场景 = 构造 App（假 runtime 喂快照/事件）+ render 到假终端 + 等一帧稳定 +
 * `expectGolden(整屏帧, 'tui/<场景>')`。帧的读法与确定性约定见 `frame-kit.ts` 文件头。
 *
 * 每条场景先用一条便宜的 `expect` 钉住「这一帧该有的、有区分度的字」，再交给 golden
 * 做整屏比对：golden 红了看 diff，语义断言红了先看场景意图是否已漂。
 *
 * ## 更新 golden
 *
 * ```bash
 * UPDATE_GOLDEN=1 npx vitest run --project snapshot tests/snapshots/tui
 * ```
 *
 * 然后**人工审** `tests/snapshots/golden/tui/*.txt` 的 diff 再提交。golden 落盘位置由
 * `tests/harness.ts` 的 `expectGolden` 固定为 `tests/snapshots/golden/<name>.txt`
 * （harness 禁改），所以场景名统一带 `tui/` 前缀，文件在 `golden/tui/` 下。
 *
 * ## 与建议清单的差异
 *
 * TUI 没有「组头/阶段组」「read 卡」「web 卡」「编辑中提示」这四个面（它们只存在于
 * `ui-renderer`/桌面层，终端 ChatView 没有对应渲染分支）。对应的四条名额换成 TUI
 * 真实存在的面：压缩活动行、提问卡、计划评审卡、审批卡（内嵌 diff）。清单见各
 * `test` 名。
 *
 * @module dsc/tests/snapshots/tui/frames
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { RuntimeSnapshot } from '@pneuma/runtime/contract.js'
import { expectGolden } from '../../harness.js'
import {
  approval,
  lineOf,
  mountFrame,
  pngPath,
  plan,
  question,
  restoreHome,
  snapshot,
  status,
  textEntry,
  thinkingEntry,
  todos,
  toolEntry,
  userEntry,
} from './frame-kit.js'

/** App 组件在 `beforeAll` 里动态 import（`DSC_HOME` 必须先换好）。 */
let App: unknown

beforeAll(async () => {
  const module = await import('../../../src/packages/tui/app/App.js')
  App = module.App
})

afterAll(() => {
  restoreHome()
})

/** 挂一帧并保证卸载（异常也不漏）。 */
async function capture(
  initial: RuntimeSnapshot,
  options: Parameters<typeof mountFrame>[2] = {},
): Promise<string> {
  const frame = await mountFrame(App, initial, options)
  try {
    return frame.text
  } finally {
    frame.unmount()
  }
}

/** 挂载 → 按键序列 → 取最终帧。 */
async function captureKeys(
  initial: RuntimeSnapshot,
  keys: readonly string[],
  options: Parameters<typeof mountFrame>[2] = {},
): Promise<string> {
  const frame = await mountFrame(App, initial, options)
  try {
    for (const key of keys) await frame.press(key)
    return frame.text
  } finally {
    frame.unmount()
  }
}

/** 挂载 → 点中某段文字所在行（SGR 鼠标）→ 取最终帧。 */
async function captureClick(
  initial: RuntimeSnapshot,
  needle: string,
  options: Parameters<typeof mountFrame>[2] = {},
): Promise<string> {
  const frame = await mountFrame(App, initial, options)
  try {
    const row = lineOf(frame.text, needle)
    if (row < 0) throw new Error(`点不中：帧里没有 ${JSON.stringify(needle)}`)
    await frame.press(`\x1b[<0;4;${row + 1}M`)
    return frame.text
  } finally {
    frame.unmount()
  }
}

/** 一条 5 行的思考正文：折叠态只露最后 3 行，展开态全露。 */
const THINKING_TEXT = [
  '先看仓库结构：src 是内核，ui-shell 是界面。',
  '第二步确认测试入口：tests/harness.ts 提供假终端与 golden。',
  '第三步核对契约：TranscriptEntry 决定会话流怎么画。',
  '第四步排场景：欢迎页、状态栏、工具卡、弹卡各来一条。',
  '最后跑两遍 snapshot project，确认 golden 稳定。',
].join('\n')

/** 一条足够长的工具结果：展开后会被 `oneLine(..., 200)` 截断。 */
const LONG_RESULT =
  '读取成功。文件共有 42 行：第一段说明模块职责，第二段说明依赖方向，' +
  '第三段说明失败模式，第四段说明如何验证。这里再补一些字确保结果超过两百个字符，' +
  '界面会在展开态把它截断成一行并以省略号结尾，golden 因此同时钉住「展开」与「截断」两件事。' +
  '如果这段文字不够长，截断断言会失效，所以刻意写到超过限制。下面继续补字：' +
  '这一段只为了把长度推过两百个字符，内容本身没有信息量，但它必须存在，' +
  '否则 twenty lines 这个断言就只是摆设。再来一句用于凑数的话：测试文本到此为止，' +
  '但长度还没到两百，所以再补最后一小段，确保 oneLine 一定走截断分支。'

/** 一轮的过程条目：用户 + 思考 + 正文 + 工具。 */
function turn(base: number, topic: string): ReturnType<typeof userEntry>[] {
  return [
    userEntry(base, topic),
    thinkingEntry(base + 1, `${topic}\n先确认现场，再动手。`),
    textEntry(base + 2, `${topic}：已处理。`),
    toolEntry(base + 3, {
      name: 'read_file',
      argsText: `{"file_path":"/w/${base}.md"}`,
      status: 'done',
      durationMs: 1_200,
      resultText: '内容',
    }),
  ]
}

describe('TUI 帧快照', () => {
  // ── 欢迎页 / 会话底座 ───────────────────────────────────────────────────────

  test('01 欢迎页：短会话（有历史）', async () => {
    const frame = await capture(
      snapshot([userEntry(1, '你好，介绍一下这个项目'), textEntry(2, '这是 Pneuma 的终端界面。')]),
    )
    expect(frame).toContain('✦ Pneuma')
    expect(frame).toContain('❯ 你好，介绍一下这个项目')
    expectGolden(frame, 'tui/01-welcome-with-history')
  })

  test('02 欢迎页：空会话（开场提示）', async () => {
    const frame = await capture(snapshot([]))
    expect(frame).toContain('✦ Pneuma')
    expect(frame).toContain('输入消息开始对话')
    expectGolden(frame, 'tui/02-welcome-empty')
  })

  // ── 状态栏两态 ─────────────────────────────────────────────────────────────

  test('03 状态栏：空闲 + 工具完成', async () => {
    const frame = await capture(
      snapshot([
        userEntry(1, '看一下 README'),
        textEntry(2, '已读完。'),
        toolEntry(3, { name: 'read_file', status: 'done', durationMs: 1_200, resultText: '内容' }),
      ]),
    )
    expect(frame).toContain('● 空闲')
    expect(frame).toContain('✓ 完成')
    expectGolden(frame, 'tui/03-status-idle')
  })

  test('04 状态栏：执行中 + 工具运行态', async () => {
    const frame = await capture(
      snapshot([userEntry(1, '跑一下测试'), toolEntry(2, { name: 'bash', status: 'running', argsText: '{"command":"pnpm test"}' })], {
        status: status({ turnState: 'working' }),
      }),
    )
    expect(frame).toContain('◐ 执行中')
    expect(frame).toContain('调用 bash 工具')
    expectGolden(frame, 'tui/04-status-busy')
  })

  // ── 会话条目 ───────────────────────────────────────────────────────────────

  test('05 单条用户行（金色 ❯ 与上文空行）', async () => {
    const frame = await capture(snapshot([userEntry(1, '这是单条用户消息，行首是金色的 ❯。')]))
    expect(lineOf(frame, '❯ 这是单条用户消息')).toBeGreaterThan(0)
    expectGolden(frame, 'tui/05-user-line')
  })

  test('06 思考行：折叠态（恒定 3 行瀑布）', async () => {
    const frame = await capture(snapshot([userEntry(1, '先想一想'), thinkingEntry(2, THINKING_TEXT), textEntry(3, '想好了。')]))
    expect(frame).toContain('⚓ 思考')
    expect(frame).toContain('（Ctrl+T 展开）')
    expect(frame).toContain('│ …')
    expectGolden(frame, 'tui/06-thinking-collapsed')
  })

  test('07 思考行：展开态（Ctrl+T）', async () => {
    const frame = await captureKeys(
      snapshot([userEntry(1, '先想一想'), thinkingEntry(2, THINKING_TEXT), textEntry(3, '想好了。')]),
      ['\x14'],
    )
    expect(frame).toContain('⚓ 思考')
    expect(frame).toContain('先看仓库结构')
    expect(frame).toContain('最后跑两遍 snapshot project')
    expectGolden(frame, 'tui/07-thinking-expanded')
  })

  // ── 工具行四态 ─────────────────────────────────────────────────────────────

  test('08 工具行：running', async () => {
    const frame = await capture(
      snapshot([userEntry(1, '读文件'), toolEntry(2, { name: 'read_file', status: 'running' })]),
    )
    expect(frame).toContain('⚙  调用 read_file 工具')
    expect(frame).toContain('◐ 执行中')
    expectGolden(frame, 'tui/08-tool-running')
  })

  test('09 工具行：done（带耗时）', async () => {
    const frame = await capture(
      snapshot([userEntry(1, '读文件'), toolEntry(2, { name: 'read_file', status: 'done', durationMs: 1_234 })]),
    )
    expect(frame).toContain('✓ 完成')
    expect(frame).toContain('1.2s')
    expectGolden(frame, 'tui/09-tool-done')
  })

  test('10 工具行：failed', async () => {
    const frame = await capture(
      snapshot([
        userEntry(1, '读文件'),
        toolEntry(2, { name: 'read_file', status: 'failed', resultText: 'ENOENT: no such file' }),
      ]),
    )
    expect(frame).toContain('✗ 失败')
    expectGolden(frame, 'tui/10-tool-failed')
  })

  test('11 工具行：展开且结果截断（点击卡片）', async () => {
    const frame = await captureClick(
      snapshot([
        userEntry(1, '读文件'),
        toolEntry(2, {
          name: 'read_file',
          status: 'done',
          argsText: '{"file_path":"/w/notes.md"}',
          resultText: LONG_RESULT,
        }),
      ]),
      '调用 read_file 工具',
    )
    expect(frame).toContain('▸ {"file_path":"/w/notes.md"}')
    expect(frame).toContain('↳ 读取成功')
    expect(frame).toContain('…')
    expectGolden(frame, 'tui/11-tool-expanded-truncated')
  })

  // ── 弹卡 / 任务条 ──────────────────────────────────────────────────────────

  test('12 审批卡：内嵌 diff', async () => {
    const frame = await capture(
      snapshot([], {
        surfaces: {
          pendingApproval: approval({
            diff: {
              path: '/w/src/app.ts',
              added: 2,
              removed: 1,
              status: 'modified',
              hunks: [
                {
                  oldStart: 10,
                  oldCount: 2,
                  newStart: 10,
                  newCount: 3,
                  lines: [
                    { kind: 'context', text: 'const a = 1', oldLine: 10, newLine: 10 },
                    { kind: 'remove', text: 'const b = 2', oldLine: 11, newLine: null },
                    { kind: 'add', text: 'const b = 3', oldLine: null, newLine: 11 },
                    { kind: 'add', text: 'const c = 4', oldLine: null, newLine: 12 },
                  ],
                },
              ],
            },
          }),
        },
      }),
    )
    expect(frame).toContain('⚠ 工具授权：write_file')
    expect(frame).toContain('将做的改动：/w/src/app.ts')
    expect(frame).toContain('@@ -10,2 +10,3 @@')
    expectGolden(frame, 'tui/12-approval-diff')
  })

  test('13 任务清单条（todo）', async () => {
    const frame = await capture(
      snapshot([userEntry(1, '继续'), textEntry(2, '在做了。')], {
        surfaces: {
          todos: todos({
            items: [
              { id: '1', content: '写场景', status: 'completed' },
              { id: '2', content: '跑两遍', status: 'in_progress' },
              { id: '3', content: '写报告', status: 'pending' },
            ],
            done: 1,
            total: 3,
            active: '跑两遍',
          }),
        },
      }),
    )
    expect(frame).toContain('☑ 1/3')
    expect(frame).toContain('当前：跑两遍')
    expectGolden(frame, 'tui/13-todo-strip')
  })

  test('14 计划条目卡（已批准）', async () => {
    const frame = await capture(
      snapshot([
        userEntry(1, '计划呢'),
        {
          id: 2,
          kind: 'plan',
          plan: { file: '/w/.dsc/plans/plan.md', title: '测试层收尾', text: '# 收尾', decision: 'approved' },
        },
      ]),
    )
    expect(frame).toContain('📋 计划')
    expect(frame).toContain('已批准')
    expectGolden(frame, 'tui/14-plan-card')
  })

  test('15 压缩标记行（第 2 次压缩）', async () => {
    const frame = await capture(
      snapshot([
        userEntry(1, '继续', { compaction: { count: 2 } }),
        textEntry(2, '压缩后的历史继续。'),
      ]),
    )
    expect(frame).toContain('⎯ 已压缩历史 · 第 2 次 ⎯')
    expectGolden(frame, 'tui/15-compact-rule')
  })

  // ── 子代理 ─────────────────────────────────────────────────────────────────

  test('16 子代理卡（收工态，固定耗时）', async () => {
    const frame = await capture(
      snapshot([
        userEntry(1, '派个活'),
        {
          id: 2,
          kind: 'subagent',
          sub: {
            name: 'writer-1',
            role: 'writer',
            task: '写正文',
            state: 'idle',
            model: 'test-model',
            rounds: 4,
            toolCalls: 5,
            startedAt: 1_000,
            finishedAt: 65_000,
            tokens: 12_345,
          },
        },
      ]),
    )
    expect(frame).toContain('子代理：写正文')
    expect(frame).toContain('已完成')
    expect(frame).toContain('1m4s')
    expectGolden(frame, 'tui/16-subagent-card')
  })

  test('17 /agents 浮层（假命令派发走真实通道）', async () => {
    const frame = await captureKeys(
      snapshot([userEntry(1, '看看队友')], { sessionStates: { '/w/bg-1.jsonl': 'working' } }),
      ['/agents', '\r'],
    )
    expect(frame).toContain('子代理与后台会话')
    expect(frame).toContain('writer-1（writer）')
    expect(frame).toContain('后台会话')
    expectGolden(frame, 'tui/17-subagent-overlay')
  })

  // ── 活动行 / 轮尾 ──────────────────────────────────────────────────────────

  test('18 压缩活动行（spinner 与已用时归一后）', async () => {
    const frame = await capture(
      snapshot([userEntry(1, '压缩一下'), textEntry(2, '好')], {
        status: status({ compactingSince: Date.now() - 3_000 }),
      }),
    )
    expect(frame).toContain('压缩上下文中')
    expect(frame).toContain('已用 <elapsed>')
    expectGolden(frame, 'tui/18-compacting-line')
  })

  test('19 轮尾：过程失败', async () => {
    const frame = await capture(
      snapshot([
        userEntry(1, '跑一下'),
        textEntry(2, '开始失败。'),
        { id: 3, kind: 'turn-end', reason: 'error' },
      ]),
    )
    expect(frame).toContain('✗ 过程失败')
    expectGolden(frame, 'tui/19-turn-end-error')
  })

  test('20 internal 唤醒卡（子任务状态更新）', async () => {
    const frame = await capture(snapshot([userEntry(1, '<teammate-report>写完了</teammate-report>', { internal: true })]))
    expect(frame).toContain('⌸ 子任务状态更新')
    expectGolden(frame, 'tui/20-internal-wake')
  })

  test('21 轮尾用量（状态栏 tok 与缓存）', async () => {
    const frame = await capture(
      snapshot([userEntry(1, '这一轮用了多少'), textEntry(2, '见状态栏。')], {
        status: status({
          usage: { inputTokens: 12_345, outputTokens: 678, cacheHitTokens: 9_000, cacheMissTokens: 1_000 },
        }),
      }),
      { statusBar: { tokens: true, cache: true } },
    )
    expect(frame).toContain('tok 12.3k↑ 678↓')
    expect(frame).toContain('缓存90%')
    expectGolden(frame, 'tui/21-usage-line')
  })

  // ── 输入框 / 附件 / 提示 ───────────────────────────────────────────────────

  test('22 附件芯片行（Ctrl+V 贴图）', async () => {
    const frame = await captureKeys(snapshot([userEntry(1, '看这张图')]), ['\x16'], {
      clipboardReader: () => Promise.resolve({ kind: 'image' as const, path: pngPath }),
    })
    expect(frame).toContain('[图#1] pic.png')
    expectGolden(frame, 'tui/22-attachment-chips')
  })

  test('23 会话内图片行（点击预览提示）', async () => {
    const frame = await capture(
      snapshot([userEntry(1, '看图', { images: ['data:image/png;base64,AAAA'] })]),
    )
    expect(frame).toContain('🖼 1 张图片 · 点击预览')
    expectGolden(frame, 'tui/23-image-row')
  })

  test('24 撤回提示（第一次 Esc）', async () => {
    const frame = await captureKeys(snapshot([userEntry(1, '撤回刚才那句'), textEntry(2, '好。')]), ['\x1b'])
    expect(frame).toContain('再按一次 Esc：撤回上一轮对话')
    expectGolden(frame, 'tui/24-rewind-prime')
  })

  // ── 提问 / 计划评审 ────────────────────────────────────────────────────────

  test('25 提问卡（单选三选项）', async () => {
    const frame = await capture(snapshot([], { surfaces: { pendingQuestion: question() } }))
    expect(frame).toContain('❓ 模型提问（第 1/1 题）')
    expect(frame).toContain('先做哪一块？')
    expect(frame).toContain('空格 选定')
    expectGolden(frame, 'tui/25-ask-card')
  })

  test('26 多轮会话整屏（5 轮，刻度栏）', async () => {
    const frame = await capture(
      snapshot([
        ...turn(1, '第一轮：先看现场'),
        ...turn(10, '第二轮：核对契约'),
        ...turn(20, '第三轮：排场景'),
        ...turn(30, '第四轮：写断言'),
        ...turn(40, '第五轮：跑两遍'),
      ]),
    )
    expect(frame).toContain('第五轮：跑两遍')
    expect(frame).toContain('━━')
    expect(frame).toContain('▴')
    expect(frame).toContain('▾')
    expectGolden(frame, 'tui/26-multi-turn-rail')
  })

  test('27 长会话裁剪（120 条，欢迎页不再画）', async () => {
    const entries = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      kind: 'system' as const,
      text: `条目-${String(index).padStart(3, '0')}`,
    }))
    const frame = await capture(snapshot(entries))
    expect(frame).toContain('条目-119')
    expect(frame).not.toContain('Pneuma')
    expect(frame).not.toContain('条目-000')
    expectGolden(frame, 'tui/27-long-session-crop')
  })

  // ── 宽度 ──────────────────────────────────────────────────────────────────

  test('28 窄屏 80 列', async () => {
    const frame = await capture(
      snapshot([
        userEntry(1, '窄屏下这一行会折行，但 ❯ 与正文列要对齐。'),
        thinkingEntry(2, '窄屏里思考块仍然恒定 3 行。'),
        textEntry(3, '窄屏正文。'),
        toolEntry(4, { name: 'read_file', status: 'done', durationMs: 1_200 }),
      ]),
      { columns: 80 },
    )
    expect(frame).toContain('⚓ 思考')
    expectGolden(frame, 'tui/28-narrow-80')
  })

  test('29 宽屏 120 列', async () => {
    const frame = await capture(
      snapshot([
        userEntry(1, '宽屏下状态栏的左右两组之间应当留出空隙。'),
        thinkingEntry(2, '宽屏里思考块也还是 3 行。'),
        textEntry(3, '宽屏正文。'),
        toolEntry(4, { name: 'read_file', status: 'done', durationMs: 1_200 }),
      ]),
      { columns: 120 },
    )
    expect(frame).toContain('● 空闲')
    expectGolden(frame, 'tui/29-wide-120')
  })

  // ── 计划评审弹卡 / 目标条 ──────────────────────────────────────────────────

  test('30 计划评审卡（全文折叠）', async () => {
    const lines = ['# 测试层收尾', '', ...Array.from({ length: 18 }, (_, index) => `${index + 1}. 步骤 ${index + 1}`)]
    const frame = await capture(
      snapshot([], {
        surfaces: {
          pendingPlan: plan({ text: lines.join('\n'), file: '/w/.dsc/plans/plan.md', title: '测试层收尾' }),
        },
      }),
    )
    expect(frame).toContain('☐ 计划评审：测试层收尾')
    expect(frame).toContain('… 共 20 行')
    expectGolden(frame, 'tui/30-plan-review')
  })
})
