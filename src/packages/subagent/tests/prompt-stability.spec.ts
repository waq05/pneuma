/**
 * 系统提示稳定性回归测试（2026-11 用户报障：系统提示连出三张卡、缓存命中约 50%）。
 *
 * 钉住四件事：
 * 1. **系统提示逐字稳定**：看板写进展/记活动之后，`team` 段（以及整个 `# 子智能体` 段）
 *    必须一个字节都不变——它一变，服务端前缀缓存（`core/llm.ts:777` 的头部断点）每轮作废。
 * 2. **看板快照走投影、不走系统提示**：看板没变 → 投影返回同一个数组、不报注入卡；
 *    变了 → 追加一条快照、内容含最新进展，并且只报一张卡。
 * 3. **水位的三个分量**：revision（任务变更）、activity 条数（纯活动追加不动 revision）。
 * 4. **正文限长**：任务 ≤10 条、活动 ≤8 条、总字符 ≤2000。
 *
 * 断言的出处是真实会话日志：`sessions/D-dsc/c2838565….jsonl` 里 system-prompt 变了 6 次，
 * 逐段 diff 后唯一变化的就是 team 段（209→452→507→693→900→923 字）。
 *
 * @module @pneuma/subagent/tests/prompt-stability
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'

// 临时 HOME + DSC_HOME：apply 会铺出厂角色、读写插件配置与任务板，真实 ~/.dsc 一个字节都不许动。
// 必须放在动态 import 之前——DSC_HOME 在 core/path-policy 加载时取一次，任务板目录跟着它算。
const home = mkdtempSync(join(tmpdir(), 'numa-prompt-stability-'))
const savedEnv = {
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
  DSC_HOME: process.env['DSC_HOME'],
}
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })

const { subagentPlugin, TEAM_BOARD_GUIDE, teamBoardGuide, teammateCollabGuide } = await import('../index.js')
const {
  BOARD_SNAPSHOT_LIMITS,
  BoardSnapshotWatermark,
  boardSnapshotText,
  boardSnapshotWatermark,
  countRounds,
  userTurnKey,
} = await import('../board-snapshot.js')
const boardMod = await import('@pneuma/runtime/core/team-board.js')
// 整份系统提示用内核同一个拼装器验证（段序、段数与真实会话一致）
const { buildSystemPromptParts, promptHash } = await import('@pneuma/session-core/prompt.js')

afterAll(() => {
  for (const name of ['HOME', 'USERPROFILE', 'DSC_HOME'] as const) {
    const before = savedEnv[name]
    if (before === undefined) delete process.env[name]
    else process.env[name] = before
  }
})

// ── 假 ctx：apply 真正用到的几个面 ───────────────────────────────────────────

interface CapturedProjection {
  id: string
  apply: (
    messages: ChatMessageLike[],
    session?: unknown,
    report?: (view: Record<string, unknown>) => void,
  ) => ChatMessageLike[]
  options?: { order?: number }
}

interface ChatMessageLike {
  role: string
  content: string | null
  ts?: number
}

interface CapturedPrompt {
  id: string
  render: () => string
  options?: { order?: number }
}

interface CapturedSection {
  id: string
  fields: () => unknown[]
  values: () => Record<string, unknown>
}

interface FakeOwner {
  meta: { id: string }
  messages: ChatMessageLike[]
  appendNote: (id: string, text: string) => void
}

function fakeContext(): {
  ctx: Context
  prompts: CapturedPrompt[]
  projections: CapturedProjection[]
  notes: Array<{ id: string; text: string }>
} {
  const prompts: CapturedPrompt[] = []
  const projections: CapturedProjection[] = []
  const notes: Array<{ id: string; text: string }> = []
  const owner: FakeOwner = { meta: { id: 'stability-session' }, messages: [], appendNote: (id, text) => notes.push({ id, text }) }
  const ctx = {
    session: { current: () => owner },
    tools: {
      register: () => () => {},
      list: () => [],
    },
    prompt: {
      register: (id: string, render: () => string, options?: { order?: number }) => {
        prompts.push({ id, render, ...(options === undefined ? {} : { options }) })
        return () => {}
      },
      registerProjection: (id: string, apply: CapturedProjection['apply'], options?: { order?: number }) => {
        projections.push({ id, apply, ...(options === undefined ? {} : { options }) })
        return () => {}
      },
    },
    settings: {
      about: () => ({ home: process.env.DSC_HOME }),
      registerSection: (spec: CapturedSection) => spec,
    },
    provide: () => {},
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
    transcript: { touch: () => {} },
    llm: { listModels: () => [], model: 'test-model' },
    approval: {},
    guards: {
      register: () => () => {},
      registerSessionResolver: () => () => {},
      gate: () => ({ action: 'defer' }),
      observe: () => {},
    },
    agent: { sessionById: () => undefined },
    get: () => undefined,
  }
  return { ctx: ctx as unknown as Context, prompts, projections, notes }
}

/** 装一次插件，返回捕获面。 */
function mount(): ReturnType<typeof fakeContext> {
  const harness = fakeContext()
  subagentPlugin.apply(harness.ctx, undefined)
  return harness
}

/** 一个空的会话历史（round 0）。 */
function history(round = 0): ChatMessageLike[] {
  const messages: ChatMessageLike[] = [{ role: 'user', content: '开始干活' }]
  for (let index = 0; index < round; index += 1) {
    messages.push({ role: 'assistant', content: `第 ${String(index)} 轮` })
  }
  return messages
}

/** 假会话：投影按会话 id 读板子，按「历史最后一条消息」判重复落 note。 */
function ownerFor(sessionId: string): FakeOwner {
  return { meta: { id: sessionId }, messages: [], appendNote: () => {} }
}

/** 一个干净会话名 + 清掉可能残留的板子。 */
function freshSession(name: string): string {
  const sessionId = `stability-${name}`
  boardMod.resetBoard(sessionId)
  return sessionId
}

// ── 1. 系统提示逐字稳定 ─────────────────────────────────────────────────────

test('系统提示的 team 段是常量：看板写进展/记活动之后逐字不变', () => {
  const { prompts } = mount()
  const render = (): string => prompts.find((entry) => entry.id === 'team')?.render() ?? ''
  const before = render()
  expect(before).toContain('# 共享任务板')
  expect(before).toContain('任务板的规矩')
  expect(before).toContain('task_id')
  // 稳定段里不许出现任何看板数据
  expect(before).not.toContain('最新进展')
  expect(before).not.toContain('最近活动')
  expect(before).not.toContain('在队队友与绑定任务：')

  const sessionId = freshSession('guide')
  const created = boardMod.boardCreate(sessionId, { subject: '写登录接口' })
  boardMod.boardUpdate(sessionId, created.task.id, created.board.revision, 'note', {
    text: '接口层写完，跑单测中',
    by: 'dev-1',
  })
  boardMod.recordBoardActivity(sessionId, { by: 'dev-1', kind: 'message', text: '看一眼契约' })

  // 拉一次投影（看板有变化），再确认系统提示段一个字节都没变。
  const projection = mountProjection()
  projection.apply([...history()], ownerFor(sessionId))
  expect(render()).toBe(before)
  // 字面量常量本身也必须足够稳定：长度固定、含 5 条规矩。
  // 字符数是**回归钉子**：以后有人往这段里塞看板/队友数据，长度会变，这条当场红。
  expect(TEAM_BOARD_GUIDE.trim().length, 'TEAM_BOARD_GUIDE 字符数固定（改了先确认没塞易变内容）').toBe(543)
  expect(TEAM_BOARD_GUIDE.match(/^\d\. /gm)).toHaveLength(5)
  boardMod.resetBoard(sessionId)
})

test('系统提示的 subagent 段在同一配置下逐字稳定', () => {
  const { prompts } = mount()
  const render = (): string => prompts.find((entry) => entry.id === 'subagent')?.render() ?? ''
  const before = render()
  expect(before).toContain('# 子智能体')
  expect(before).toContain('分工协议')

  const sessionId = freshSession('subagent-guide')
  const created = boardMod.boardCreate(sessionId, { subject: '拆任务' })
  boardMod.boardUpdate(sessionId, created.task.id, created.board.revision, 'claim', { owner: 'dev-1', by: 'dev-1' })
  expect(render()).toBe(before)
  boardMod.resetBoard(sessionId)
})

test('team 段按「开没开派活」补一句队友通道，两种形态都是常量', () => {
  const withDelegation = teamBoardGuide(true)
  expect(withDelegation).toContain('subagent list')
  expect(withDelegation).toContain('在队队友')
  expect(teamBoardGuide(true)).toBe(withDelegation)
  const withoutDelegation = teamBoardGuide(false)
  expect(withoutDelegation).not.toContain('subagent list')
  expect(withoutDelegation).toBe(TEAM_BOARD_GUIDE)
})

test('队友系统提示的「团队协作」段是常量，不含看板/队伍数据', () => {
  const text = teammateCollabGuide(true)
  expect(text).toContain('team_task list')
  expect(text).toContain('team_message')
  // 「最新进展」只作为工具字段名出现（引导去查），不允许出现看板行的实际格式
  expect(text).not.toContain('｜最新进展（')
  expect(text).not.toContain('最近活动（新的在前）')
  expect(teammateCollabGuide(true)).toBe(text)
  // 队友段字符数回归钉子：塞进队伍/看板数据会让长度变化。
  expect(text.trim().length, '队友「团队协作」段字符数固定').toBe(535)
  expect(teammateCollabGuide(false)).toContain('任务板未开启')
})

test('整份系统提示：同一配置、不同看板状态下逐字相同（hash 相同）', () => {
  const { prompts } = mount()
  // 用内核同一个拼装器：本包贡献两段（team/subagent）+ 模型信息段，其余内置段由
  // buildSystemPromptParts 现拼。这样比的是「真实装配路径产出的整份文本」，不只 team 段。
  const build = (): { text: string; hash: string; sections: Array<{ id: string; order: number; chars: number }> } => {
    const contributions = [
      ...prompts.map((entry) => ({ id: entry.id, order: entry.options?.order ?? 60, text: entry.render() })),
      { id: 'model', order: 890, text: '当前模型：test-model（provider test）' },
    ]
    const parts = buildSystemPromptParts(home, { skills: '', contributions })
    return { text: parts.text, hash: promptHash(parts.text), sections: parts.sections }
  }

  const sessionId = freshSession('whole-prompt')
  const first = build()
  const teamSection = first.sections.find((section) => section.id === 'team')
  expect(teamSection, '整份提示里必须有 team 段').toBeDefined()
  expect(first.text).toContain('# 共享任务板')
  expect(teamSection?.order, 'team 段排在 instructions/skills 之后，易变风险最低').toBe(220)
  // 字符数回归钉子：看板数据每轮都变，往这段里塞一条就会改变长度，这条会红。
  expect(teamSection?.chars, 'team 段字符数固定').toBe(602)

  // 看板从空 → 有任务 → 写进展 → 记活动，每次都要重新拼整份提示
  const created = boardMod.boardCreate(sessionId, { subject: '整份提示稳定性' })
  const withTask = build()
  expect(withTask.text).toBe(first.text)
  expect(withTask.hash).toBe(first.hash)

  boardMod.boardUpdate(sessionId, created.task.id, created.board.revision, 'note', {
    text: '第一版实现完成',
    by: 'dev-1',
  })
  boardMod.recordBoardActivity(sessionId, { by: 'dev-1', kind: 'message', text: '同步一下契约' })
  const withProgress = build()
  expect(withProgress.text, '看板数据变化后整份系统提示必须逐字不变').toBe(first.text)
  expect(withProgress.hash, '整份系统提示 hash 必须不变（服务端缓存按它命中）').toBe(first.hash)
  expect(withProgress.sections.map((section) => [section.id, section.chars])).toStrictEqual(
    first.sections.map((section) => [section.id, section.chars]),
  )
  boardMod.resetBoard(sessionId)
})

// ── 2. 投影注入：变了才注、只报一张卡 ────────────────────────────────────────

/** 从一次装配里取 team-board 投影（每次 mount 的投影实例各自带一本水位台账）。 */
function mountProjection(): CapturedProjection {
  const { projections } = mount()
  const projection = projections.find((entry) => entry.id === 'team-board')
  expect(projection, '缺 team-board 投影').toBeDefined()
  expect(projection?.options?.order).toBe(700)
  return projection!
}

test('看板无变化 → 投影不注入（返回同一数组、不报卡）', () => {
  const sessionId = freshSession('no-change')
  const created = boardMod.boardCreate(sessionId, { subject: '看板无变化用例' })
  boardMod.boardUpdate(sessionId, created.task.id, created.board.revision, 'note', { text: '进展一', by: 'dev-1' })
  const projection = mountProjection()
  const owner = ownerFor(sessionId)

  // 第 0 轮第一次：板子有内容、水位未见过 → 注入。
  const first = [...history()]
  const injected = projection.apply(first, owner)
  expect(injected.length).toBe(first.length + 1)
  expect(String(injected[injected.length - 1]?.content)).toContain('进展一')

  // 同一轮的二次派生（invariant 校验）：必须给同一份请求，仍注入。
  const second = [...history()]
  const again = projection.apply(second, owner)
  expect(again.length).toBe(second.length + 1)
  expect(String(again[again.length - 1]?.content), '同一轮重派生要得到逐字相同的快照').toBe(
    String(injected[injected.length - 1]?.content),
  )

  // 下一轮（同一用户回合里的下一个工具步骤）：看板没变 → 原样返回**同一个数组**，不注入、不报卡。
  const next = [...history(1)]
  const views: Array<Record<string, unknown>> = []
  const out = projection.apply(next, owner, (view) => views.push(view))
  expect(out, '看板没变的下一轮必须原样返回').toBe(next)
  expect(views, '没注入就不该有注入卡').toHaveLength(0)
  boardMod.resetBoard(sessionId)
})

test('三态：新用户轮必注入 / 同用户轮内板子没变不注入 / 板子变必注入', () => {
  const sessionId = freshSession('three-state')
  const created = boardMod.boardCreate(sessionId, { subject: '三态用例' })
  boardMod.boardUpdate(sessionId, created.task.id, created.board.revision, 'note', { text: '进展一', by: 'dev-1' })
  const projection = mountProjection()
  const owner = ownerFor(sessionId)
  owner.messages = [{ role: 'user', content: '第一问', ts: 1_700_000_000_000 }]

  // 用户轮 A 的第一跳：首注入
  const a0 = projection.apply([...history(0)], owner)
  expect(a0.length, '用户轮 A 首跳必注入').toBe(2)
  // 用户轮 A 内的下一工具步骤：板子没变 → 不注入
  const a1 = [...history(1)]
  expect(projection.apply(a1, owner), '同一用户轮的后续步骤板子没变 → 不注入').toBe(a1)
  // 用户轮 A 内板子变了 → 注入
  boardMod.boardUpdate(sessionId, created.task.id, boardMod.readBoard(sessionId).revision, 'note', {
    text: '进展二',
    by: 'dev-1',
  })
  const a2 = projection.apply([...history(2)], owner)
  expect(String(a2[a2.length - 1]?.content)).toContain('进展二')
  // 用户轮 B（历史里多了一条 user 消息）：板子没变也必注入（模型重新开一段上下文）
  owner.messages = [...owner.messages, { role: 'assistant', content: '答完第一问', ts: 1_700_000_000_100 }, { role: 'user', content: '第二问', ts: 1_700_000_000_200 }]
  const b0 = projection.apply([...history(3)], owner)
  expect(b0.length, '新用户轮首跳必注入').toBe(5)
  expect(String(b0[b0.length - 1]?.content), '新用户轮注入的是当前最新看板').toContain('进展二')
  // 用户轮 B 内的下一工具步骤：不注入
  const b1 = [...history(4)]
  expect(projection.apply(b1, owner), '用户轮 B 内板子没变 → 不注入').toBe(b1)
  boardMod.resetBoard(sessionId)
})

test('看板变化 → 注入一次且含最新进展；report 只记一张卡，note 只落一条', () => {
  const sessionId = freshSession('change')
  const created = boardMod.boardCreate(sessionId, { subject: '看板变化用例' })
  const projection = mountProjection()
  const owner = ownerFor(sessionId)
  const views: Array<Record<string, unknown>> = []

  const first = projection.apply([...history()], owner, (view) => views.push(view))
  const firstText = String(first[first.length - 1]?.content)
  expect(firstText).toContain('看板变化用例')
  expect(views).toHaveLength(1)
  expect(views[0]?.['kind']).toBe('team-board')
  expect(views[0]?.['source']).toBe('team-board')
  expect(views[0]?.['where']).toBe('user-tail')
  expect(String(views[0]?.['preview'])).toContain('# 共享任务板快照')

  // 看板写进展 → revision 变 → 下一轮必须注入新快照，并且再记一张卡（正文变了）
  boardMod.boardUpdate(sessionId, created.task.id, created.board.revision, 'note', {
    text: '第一版实现完成',
    by: 'dev-1',
  })
  const second = projection.apply([...history(1)], owner, (view) => views.push(view))
  const secondText = String(second[second.length - 1]?.content)
  expect(secondText).toContain('第一版实现完成')
  expect(views).toHaveLength(2)

  // 同一轮重复派生：正文没变 → 不再记卡（但请求里照样有快照，invariant 才过得去）
  const derived = projection.apply([...history(1)], owner, (view) => views.push(view))
  expect(String(derived[derived.length - 1]?.content)).toBe(secondText)
  expect(views, '同一份正文只记一张卡').toHaveLength(2)
  boardMod.resetBoard(sessionId)
})

test('水位第二个分量：纯活动追加不动 revision，也要注入', () => {
  const sessionId = freshSession('activity')
  const created = boardMod.boardCreate(sessionId, { subject: '活动追加工位' })
  boardMod.boardUpdate(sessionId, created.task.id, created.board.revision, 'note', { text: '进展一', by: 'dev-1', })
  const projection = mountProjection()
  const owner = ownerFor(sessionId)
  const first = projection.apply([...history(1)], owner)
  expect(String(first[first.length - 1]?.content)).toContain('进展一')

  // 队友互发消息只写 activity、不涨 revision：只看 revision 会漏掉这条变化。
  const before = boardMod.readBoard(sessionId)
  boardMod.recordBoardActivity(sessionId, { by: 'dev-2', kind: 'message', text: '我这边先在改契约' })
  const after = boardMod.readBoard(sessionId)
  expect(after.revision, '纯活动追加不该涨 revision').toBe(before.revision)
  expect(after.activity.length).toBe(before.activity.length + 1)

  const second = projection.apply([...history(2)], owner)
  expect(second.length).toBe(4)
  expect(String(second[second.length - 1]?.content)).toContain('我这边先在改契约')
  boardMod.resetBoard(sessionId)
})

test('空板不注入；清空后重新建任务会再注入', () => {
  const sessionId = freshSession('empty')
  const projection = mountProjection()
  const owner = ownerFor(sessionId)
  const empty = [...history()]
  const out = projection.apply(empty, owner)
  expect(out, '空板不注入（不为了「暂无任务」多一张卡）').toBe(empty)

  const created = boardMod.boardCreate(sessionId, { subject: '空板后第一条' })
  const withTask = projection.apply([...history(1)], owner)
  expect(String(withTask[withTask.length - 1]?.content)).toContain('空板后第一条')

  boardMod.resetBoard(sessionId)
  const cleared = [...history(2)]
  expect(projection.apply(cleared, owner), '板子清空后也不注入').toBe(cleared)
  boardMod.boardCreate(sessionId, { subject: '清空后重建' })
  const rebuilt = projection.apply([...history(3)], owner)
  expect(String(rebuilt[rebuilt.length - 1]?.content)).toContain('清空后重建')
  boardMod.resetBoard(sessionId)
})

// ── 3. 水位纯逻辑 ───────────────────────────────────────────────────────────

test('水位台账：首轮必注、同轮重派生必注、同用户轮下轮没变不注、变了再注、轮号倒退当首次', () => {
  const seen = new BoardSnapshotWatermark()
  const user = '1:100'
  expect(seen.due('s1', '1:0:0', 0, user), '首次必须注入').toBe(true)
  seen.mark('s1', '1:0:0', 0, user)
  expect(seen.due('s1', '1:0:0', 0, user), '同一轮重派生要给同一个答案').toBe(true)
  expect(seen.due('s1', '1:0:0', 1, user), '同一用户轮、水位没变 → 不注入').toBe(false)
  expect(seen.due('s1', '2:0:0', 1, user), '水位变了 → 注入').toBe(true)
  seen.mark('s1', '2:0:0', 1, user)
  expect(seen.due('s1', '2:0:0', 0, user), '轮号倒退（压缩/重放）→ 当首次').toBe(true)
  expect(seen.due('s1', '2:0:0', 1, '2:200'), '换了用户轮 → 必注入').toBe(true)
  // 不同会话互不影响
  expect(seen.due('s2', '2:0:0', 1, user)).toBe(true)
})

test('用户轮键：数日志里的 user 消息，拿最后一条的落库时刻兜撞号', () => {
  expect(userTurnKey([])).toBe('0:0')
  expect(userTurnKey([{ role: 'user', content: 'a' }])).toBe('1:0')
  expect(userTurnKey([{ role: 'user', content: 'a', ts: 100 }, { role: 'assistant', content: 'b' }])).toBe('1:100')
  expect(
    userTurnKey([{ role: 'user', content: 'a', ts: 100 }, { role: 'user', content: 'b', ts: 200 }]),
  ).toBe('2:200')
})

test('水位三个分量：revision / activity 条数 / 最新活动时刻', () => {
  const board = { version: 1 as const, revision: 3, tasks: [], activity: [] }
  expect(boardSnapshotWatermark(board)).toBe('3:0:0')
  const withActivity = {
    ...board,
    activity: [{ at: 1700000000123, by: 'dev', kind: 'message' as const, text: '消息' }],
  }
  expect(boardSnapshotWatermark(withActivity)).toBe('3:1:1700000000123')
  // 条数封顶（200）后还能靠最新活动时刻认出「有新的」
  const atCap = {
    ...board,
    activity: Array.from({ length: 200 }, (_, index) => ({
      at: 1700000000000 + index,
      by: 'dev',
      kind: 'message' as const,
      text: `m${String(index)}`,
    })),
  }
  const replaced = {
    ...atCap,
    activity: [{ at: 1800000000000, by: 'dev', kind: 'message' as const, text: '新消息' }, ...atCap.activity.slice(0, 199)],
  }
  expect(boardSnapshotWatermark(replaced)).not.toBe(boardSnapshotWatermark(atCap))
  expect(countRounds([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }])).toBe(1)
})

// ── 4. 正文限长 ─────────────────────────────────────────────────────────────

test('快照正文限长：任务 ≤10、活动 ≤8、总字符 ≤1500，且有序且确定', () => {
  const sessionId = freshSession('limits')
  boardMod.resetBoard(sessionId)
  let board = boardMod.readBoard(sessionId)
  for (let index = 0; index < 12; index += 1) {
    const created = boardMod.boardCreate(sessionId, { subject: `任务 ${String(index)}：${'很长的标题'.repeat(6)}` })
    board = created.board
    boardMod.boardUpdate(sessionId, created.task.id, boardMod.readBoard(sessionId).revision, 'note', {
      text: `进展 ${String(index)}：${'很长的进展正文'.repeat(8)}`,
      by: `dev-${String(index)}`,
    })
  }
  for (let index = 0; index < 10; index += 1) {
    boardMod.recordBoardActivity(sessionId, {
      by: `dev-${String(index)}`,
      kind: 'message',
      text: `活动 ${String(index)}：${'很长的活动正文'.repeat(8)}`,
    })
  }
  const snapshot = boardSnapshotText(boardMod.readBoard(sessionId))
  expect(snapshot.length).toBeLessThanOrEqual(BOARD_SNAPSHOT_LIMITS.chars)
  expect(snapshot).toContain('# 共享任务板快照')
  const taskLines = snapshot.split('\n').filter((line) => line.startsWith('- t'))
  const activityLines = snapshot.split('\n').filter((line) => /^- \d{2}:\d{2} /.test(line))
  expect(taskLines.length).toBeLessThanOrEqual(BOARD_SNAPSHOT_LIMITS.tasks)
  expect(activityLines.length).toBeLessThanOrEqual(BOARD_SNAPSHOT_LIMITS.activity)
  // 确定性：同一块板算两次必须逐字相同（投影是纯函数，重放才能重建请求）
  expect(boardSnapshotText(boardMod.readBoard(sessionId))).toBe(snapshot)
  boardMod.resetBoard(sessionId)
})

test('README 与正文口径一致：模型仍看得见最新看板（快照 + 工具两条路）', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  // README 必须讲清新口径：稳定段只放规矩、易变数据走尾部快照/工具现查。
  expect(readme).toContain('系统提示')
  expect(readme).toContain('快照')
})
