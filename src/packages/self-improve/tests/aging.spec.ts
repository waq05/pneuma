/**
 * @pneuma/self-improve 的老化整理测试：钉住「自己会跑」「stale 有后果」「归档能回滚」三件事。
 *
 * 为什么钉这几条：
 *   - `shouldCurate` 是自动整理的唯一闸门，判反了就是每个会话开一次都整理（或永远不整理）；
 *   - `curateSkills` 归档时必须把**真实**的改前指纹记进台账——记空 hash 等于归档不可回滚，
 *     而归档是「只搬不删」，搬走之后没人能凭名字再找回来；
 *   - 用户手写的技能被自动搬走是这份功能最不该做的事，必须有一条断言把这条红线钉死。
 *
 * 迁移说明：原文件第 4 条读 `index.ts` 源码四条正则（`ctx.on('dsc/session-open', …)`、
 * `enabled: config.enabled`、`lastRunAt: readLastCuratedAt()`、`saveLastRunAt: …`）。
 * 这四条描述的是 `autoCurate` 的接线，现在改成**真装一次插件再触发钩子**：
 *   - 会话打开 → 31 天未命中的 agent 技能真被搬走、`.curated.json` 真被写回；
 *   - `enabled: false` 传给 apply → 同条件技能原地不动、时间戳不动；
 *   - 紧接着再触发一次 → 24 小时节流生效，新造的技能不被搬（这同时证明 `lastRunAt` 读的是盘上那份）。
 * 改引号、改注释不会红；把开关判断删掉、把时间戳读写接错、把钩子换个事件名都会红。
 *
 * 隔离：临时 DSC_HOME（HOME / USERPROFILE 一起指过去），真实 ~/.dsc 一个字节都不碰。
 *
 * @module @pneuma/self-improve/tests/aging
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'

// 先隔离再 import：`DSC_HOME` 在 path-policy 模块求值那一刻就被读走了。
const home = mkdtempSync(join(tmpdir(), 'dsc-aging-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
const skillsDir = join(process.env.DSC_HOME, 'skills')
mkdirSync(skillsDir, { recursive: true })

const sw = await import('../skill-write.js')
const ld = await import('../ledger.js')
const mod = await import('../index.js')

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 造一份技能文件，返回原文（用来比对归档后的正文与指纹）。 */
function writeSkill(name: string, title: string): string {
  const markdown = [
    '---',
    `name: ${name}`,
    `description: ${title}（临时 HOME 里的探针）`,
    'whenToUse: 自检时',
    '---',
    '',
    `# ${title}`,
    '',
    `这是 ${name} 的正文。`,
  ].join('\n')
  const dir = join(skillsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), markdown, 'utf8')
  return markdown
}

/** 写使用台账：`days` 天前最后活跃，`createdBy` 决定自动化有没有资格动它。 */
function writeUsageRecord(name: string, days: number, createdBy: string): { at: number; now: number } {
  const now = Date.now()
  const at = now - days * DAY
  const doc = {
    version: 1,
    skills: {
      [name]: {
        createdBy,
        useCount: 0,
        patchCount: 0,
        createdAt: at,
        lastUsedAt: null,
        lastPatchedAt: null,
        state: 'active',
        pinned: false,
        archivedAt: null,
      },
    },
  }
  writeFileSync(join(skillsDir, '.usage.json'), JSON.stringify(doc, null, 2), 'utf8')
  return { at, now }
}

/** 读回使用台账。 */
function readUsageFile(): { skills: Record<string, { state: string }> } {
  return JSON.parse(readFileSync(join(skillsDir, '.usage.json'), 'utf8')) as {
    skills: Record<string, { state: string }>
  }
}

// 第 1 条：闸门本身。从没跑过 → 真；刚跑过 → 假；超过 24 小时 → 真。
test('shouldCurate：从没跑过 / 刚跑过 / 超过 24 小时', () => {
  expect(mod.shouldCurate(0, 1_000_000)).toBe(true)
  expect(mod.shouldCurate(-1, 1_000_000)).toBe(true)
  expect(mod.shouldCurate(Number.NaN, 1_000_000)).toBe(true)
  expect(mod.shouldCurate(1_000_000, 1_000_000 + HOUR)).toBe(false)
  expect(mod.shouldCurate(1_000_000, 1_000_000 + 25 * HOUR)).toBe(true)
  expect(mod.shouldCurate(1_000_000, 1_000_000 + 12 * HOUR, 24 * HOUR)).toBe(false)
})

// 第 2 条：31 天未命中的 agent 技能 —— 目录搬进 .archive/、档位变 archived、台账记真实指纹。
test('curateSkills：31 天没命中的 agent 技能被搬进归档区，台账 beforeHash 是真指纹', () => {
  const markdown = writeSkill('aging-probe', '老化探针')
  writeUsageRecord('aging-probe', 31, 'agent')
  const report = sw.curateSkills(Date.now(), sw.DEFAULT_AGING)
  expect(report.archived).toEqual(['aging-probe'])
  expect(existsSync(join(skillsDir, 'aging-probe'))).toBe(false)
  const archived = readdirSync(join(skillsDir, '.archive'))
  expect(archived.length).toBe(1)
  expect(archived[0]).toMatch(/^aging-probe-/u)
  expect(readFileSync(join(skillsDir, '.archive', archived[0] ?? '', 'SKILL.md'), 'utf8')).toBe(markdown)
  expect(readUsageFile().skills['aging-probe']?.state).toBe('archived')
  const entry = ld.readLedger().find((item) => item.action === 'archive' && item.skill === 'aging-probe')
  expect(entry).toBeDefined()
  expect(entry?.beforeHash).not.toBe(ld.EMPTY_HASH)
  expect(entry?.beforeHash).toBe(ld.hashText(markdown))
})

// 第 3 条：归档能回滚 —— 按指纹认出归档区那一份，整目录搬回来，档位跟着回 active。
test('rollbackEntry：archive 条目能按指纹把技能搬回技能目录', () => {
  const entry = ld.readLedger().find((item) => item.action === 'archive' && item.skill === 'aging-probe')
  expect(entry, '上一条测试应已写下 archive 台账').toBeDefined()
  const result = ld.rollbackEntry(String(entry?.id))
  expect(result.ok).toBe(true)
  const restored = join(skillsDir, 'aging-probe', 'SKILL.md')
  expect(existsSync(restored)).toBe(true)
  expect(ld.hashText(readFileSync(restored, 'utf8'))).toBe(entry?.beforeHash)
  expect(readUsageFile().skills['aging-probe']?.state).toBe('active')
})

// 第 4 条：节流状态读写自成一体、坏文件当没跑过。
test('时间戳文件写下去读回来一致，坏文件当没跑过', () => {
  sw.writeLastCuratedAt(123_456_789)
  expect(sw.readLastCuratedAt()).toBe(123_456_789)
  writeFileSync(join(skillsDir, '.curated.json'), '{ 这不是 JSON', 'utf8')
  expect(sw.readLastCuratedAt()).toBe(0)
})

// 第 5 条：开关关掉时一样都不做——不整理、不写时间戳、不说话、不发重算通知。
// 为什么这条必须钉：老化会搬技能目录，那是写操作；开关关了还搬，等于开关没关。
test('autoCurateOnce：enabled=false 时不调 curateSkills、不写 .curated.json', () => {
  const calls = { curate: 0, saved: 0, said: 0, changed: 0 }
  const deps = {
    enabled: false,
    now: Date.now(),
    lastRunAt: 0, // 从没跑过：光看节流是会跑的，唯一拦住它的就是开关
    curate: () => {
      calls.curate += 1
      return { stale: ['x'], archived: [], skipped: [], total: 1 }
    },
    saveLastRunAt: () => {
      calls.saved += 1
    },
    announce: () => {
      calls.said += 1
    },
    changed: () => {
      calls.changed += 1
    },
  }
  const blocked = mod.autoCurateOnce(deps as never)
  expect(blocked).toEqual({ ran: false, text: '', report: null })
  expect(calls).toEqual({ curate: 0, saved: 0, said: 0, changed: 0 })

  // 开关打开的同一条路径：整理一次、写一次时间戳、有变化才说一句。
  const opened = mod.autoCurateOnce({ ...deps, enabled: true } as never)
  expect(opened.ran).toBe(true)
  expect(calls).toEqual({ curate: 1, saved: 1, said: 1, changed: 1 })
  expect(opened.text).toMatch(/1 个降为 stale/u)
})

// 第 6 条：红线 —— 用户手写的技能 31 天没命中也不许被搬走。
test('curateSkills：createdBy 不是 agent 的技能 31 天未命中也不搬走', () => {
  // 清掉上一条留下的 aging-probe，让这一轮只看得见用户技能
  rmSync(join(skillsDir, 'aging-probe'), { recursive: true, force: true })
  writeSkill('user-probe', '用户手写探针')
  writeUsageRecord('user-probe', 31, 'user')
  const report = sw.curateSkills(Date.now(), sw.DEFAULT_AGING)
  expect(report.archived.includes('user-probe')).toBe(false)
  expect(existsSync(join(skillsDir, 'user-probe', 'SKILL.md'))).toBe(true)
  expect(readUsageFile().skills['user-probe']?.state).toBe('active')
})

// ── 接线：钩子、开关、时间戳读写（原第 4 条的源码文本断言换成真触发）────────────

/** 一次 apply 捕获到的面。 */
interface Curator {
  /** 触发 `dsc/session-open` 钩子，跑一次自动整理。 */
  openSession: () => void
  /** 收集说给用户看的话。 */
  said: string[]
  /** apply 有没有挂上 dsc/session-open。 */
  events: string[]
}

/** 假会话：apply 只用 meta 与状态读写；cwd 给临时工作区，候选文件才会落在临时目录。 */
function fakeSession(): unknown {
  const state = new Map<string, unknown>()
  const cwd = join(home, 'work')
  mkdirSync(cwd, { recursive: true })
  return {
    meta: { id: 'aging-spec-session', cwd },
    filePath: join(home, 'sessions', 'aging-spec-session.jsonl'),
    messages: [],
    toolErrors: new Map<string, string>(),
    state: (name: string) => state.get(name),
    appendState: (name: string, value: unknown) => {
      state.set(name, value)
    },
  }
}

/**
 * 真装一次插件：假 ctx 覆盖 apply 会碰的每个面。
 *
 * 只关心 `dsc/session-open` 与它引发的整理，所以 `agent.followup` / `approval.decide` /
 * `skills.setEnabled` / `memory.write` 都给了不做事的桩——本文件的用例不会走到它们。
 */
function mountCurator(config: Record<string, unknown> = {}): Curator {
  const events: string[] = []
  const handlers = new Map<string, () => void>()
  const said: string[] = []
  const session = fakeSession()
  const ctx = {
    session: { current: () => session },
    get: () => undefined,
    on: (event: string, handler: () => void) => {
      events.push(event)
      handlers.set(event, handler)
      return () => {}
    },
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
    tools: { register: () => () => {} },
    guards: { register: () => () => {} },
    commands: { register: () => () => {} },
    settings: { registerSection: () => () => {} },
    prompt: {
      register: () => () => {},
      registerProjection: () => () => {},
    },
    transcript: { system: (text: string) => said.push(text) },
    approval: { decide: async () => 'allow' },
    skills: { setEnabled: () => ({ ok: true }) },
    agent: { followup: () => {} },
    memory: { write: () => ({ ok: true }) },
    emit: () => {},
    logger: { debug: () => {} },
  }
  mod.selfImprovePlugin.apply(ctx as never, config)
  return {
    openSession: () => handlers.get('dsc/session-open')?.(),
    said,
    events,
  }
}

test('会话打开真触发自动整理：31 天未命中的 agent 技能被搬走并写回时间戳', () => {
  const markdown = writeSkill('auto-probe', '自动整理探针')
  writeUsageRecord('auto-probe', 31, 'agent')
  const curator = mountCurator()
  expect(curator.events).toContain('dsc/session-open')
  curator.openSession()

  expect(existsSync(join(skillsDir, 'auto-probe'))).toBe(false)
  expect(readUsageFile().skills['auto-probe']?.state).toBe('archived')
  expect(sw.readLastCuratedAt()).toBeGreaterThan(0)
  expect(curator.said.some((text) => text.includes('技能老化'))).toBe(true)
  // 归档的是原文件，一个字节都不许改
  const archived = readdirSync(join(skillsDir, '.archive')).find((name) => name.startsWith('auto-probe-'))
  expect(readFileSync(join(skillsDir, '.archive', archived ?? '', 'SKILL.md'), 'utf8')).toBe(markdown)
})

test('开关关掉时会话打开不搬任何东西，也不动时间戳', () => {
  writeSkill('off-probe', '关掉时的探针')
  writeUsageRecord('off-probe', 31, 'agent')
  // 把时间戳清零：节流这一层已经放行，唯一还能拦住整理的就是开关本身。
  sw.writeLastCuratedAt(0)
  const curator = mountCurator({ enabled: false })
  curator.openSession()

  expect(existsSync(join(skillsDir, 'off-probe', 'SKILL.md'))).toBe(true)
  expect(readUsageFile().skills['off-probe']?.state).toBe('active')
  expect(sw.readLastCuratedAt()).toBe(0)
  expect(curator.said).toEqual([])
})

test('24 小时节流：上一次刚跑过，再开会话不搬新到期的技能', () => {
  // 节流窗口内：时间戳写成「刚刚」，同条件下技能不该被搬走。
  sw.writeLastCuratedAt(Date.now())
  expect(mod.shouldCurate(sw.readLastCuratedAt(), Date.now())).toBe(false)
  writeSkill('throttle-probe', '节流探针')
  writeUsageRecord('throttle-probe', 31, 'agent')
  const curator = mountCurator()
  curator.openSession()

  expect(existsSync(join(skillsDir, 'throttle-probe', 'SKILL.md'))).toBe(true)
  expect(readUsageFile().skills['throttle-probe']?.state).toBe('active')
})
