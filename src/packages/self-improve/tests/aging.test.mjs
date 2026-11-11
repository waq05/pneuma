/**
 * @pneuma/self-improve 的老化整理测试：钉住「自己会跑」「stale 有后果」「归档能回滚」三件事。
 *
 * 为什么钉这几条：
 *   - `shouldCurate` 是自动整理的唯一闸门，判反了就是每个会话开一次都整理（或永远不整理）；
 *   - `curateSkills` 归档时必须把**真实**的改前指纹记进台账——记空 hash 等于归档不可回滚，
 *     而归档是「只搬不删」，搬走之后没人能凭名字再找回来；
 *   - 用户手写的技能被自动搬走是这份功能最不该做的事，必须有一条断言把这条红线钉死。
 *
 * 隔离：临时 DSC_HOME（HOME / USERPROFILE 一起指过去），真实 ~/.dsc 一个字节都不碰。
 * 用法：pnpm run build && node --test "src/packages/self-improve/tests/*.test.mjs"
 *
 * @module @pneuma/self-improve/tests/aging
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// 先隔离再加载 lib：`DSC_HOME` 在 path-policy 模块求值那一刻就被读走了。
const home = mkdtempSync(join(tmpdir(), 'dsc-aging-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
const skillsDir = join(process.env.DSC_HOME, 'skills')
mkdirSync(skillsDir, { recursive: true })

const sw = await import('../../../../lib/packages/self-improve/skill-write.js')
const ld = await import('../../../../lib/packages/self-improve/ledger.js')
const mod = await import('../../../../lib/packages/self-improve/index.js')

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
let passed = 0

/** 造一份技能文件，返回原文（用来比对归档后的正文与指纹）。 */
function writeSkill(name, title) {
  const markdown = ['---', `name: ${name}`, `description: ${title}（临时 HOME 里的探针）`, 'whenToUse: 自检时', '---', '', `# ${title}`, '', `这是 ${name} 的正文。`].join('\n')
  const dir = join(skillsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), markdown, 'utf8')
  return markdown
}

/** 写使用台账：`days` 天前最后活跃，`createdBy` 决定自动化有没有资格动它。 */
function writeUsageRecord(name, days, createdBy) {
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

function readUsageFile() {
  return JSON.parse(readFileSync(join(skillsDir, '.usage.json'), 'utf8'))
}

// 第 1 条：闸门本身。从没跑过 → 真；刚跑过 → 假；超过 24 小时 → 真。
test('shouldCurate：从没跑过 / 刚跑过 / 超过 24 小时', () => {
  assert.equal(mod.shouldCurate(0, 1_000_000), true, 'lastAt=0 是「从没跑过」，必须跑')
  assert.equal(mod.shouldCurate(-1, 1_000_000), true, '负数是坏数据，也当没跑过')
  assert.equal(mod.shouldCurate(Number.NaN, 1_000_000), true, 'NaN 同样当没跑过')
  assert.equal(mod.shouldCurate(1_000_000, 1_000_000 + HOUR), false, '刚跑过一小时不该再跑')
  assert.equal(mod.shouldCurate(1_000_000, 1_000_000 + 25 * HOUR), true, '超过 24 小时该跑')
  assert.equal(mod.shouldCurate(1_000_000, 1_000_000 + 12 * HOUR, 24 * HOUR), false, '显式传 24 小时也被节流')
  passed += 1
})

// 第 2 条：31 天未命中的 agent 技能 —— 目录搬进 .archive/、档位变 archived、台账记真实指纹。
test('curateSkills：31 天没命中的 agent 技能被搬进归档区，台账 beforeHash 是真指纹', () => {
  const markdown = writeSkill('aging-probe', '老化探针')
  writeUsageRecord('aging-probe', 31, 'agent')
  const report = sw.curateSkills(Date.now())
  assert.deepEqual(report.archived, ['aging-probe'], `应只归档 aging-probe，实际 ${JSON.stringify(report)}`)
  assert.equal(existsSync(join(skillsDir, 'aging-probe')), false, '技能目录应已搬走')
  const archived = readdirSync(join(skillsDir, '.archive'))
  assert.equal(archived.length, 1, `归档区里应有 1 份，实际 ${archived.join('、')}`)
  assert.match(archived[0], /^aging-probe-/u, '归档目录名应带技能名')
  assert.equal(readFileSync(join(skillsDir, '.archive', archived[0], 'SKILL.md'), 'utf8'), markdown, '归档的是原文件，一个字节都不许改')
  assert.equal(readUsageFile().skills['aging-probe'].state, 'archived', '.usage.json 里档位应是 archived')
  const entry = ld.readLedger().find((item) => item.action === 'archive' && item.skill === 'aging-probe')
  assert.ok(entry !== undefined, '台账里应有一条 archive')
  assert.notEqual(entry.beforeHash, ld.EMPTY_HASH, '归档条目的 beforeHash 不许再是空 hash')
  assert.equal(entry.beforeHash, ld.hashText(markdown), 'beforeHash 应等于归档前 SKILL.md 内容的指纹')
  passed += 1
})

// 第 3 条：归档能回滚 —— 按指纹认出归档区那一份，整目录搬回来，档位跟着回 active。
test('rollbackEntry：archive 条目能按指纹把技能搬回技能目录', () => {
  const entry = ld.readLedger().find((item) => item.action === 'archive' && item.skill === 'aging-probe')
  assert.ok(entry !== undefined, '上一条测试应已写下 archive 台账')
  const result = ld.rollbackEntry(entry.id)
  assert.equal(result.ok, true, result.error)
  const restored = join(skillsDir, 'aging-probe', 'SKILL.md')
  assert.equal(existsSync(restored), true, 'SKILL.md 应已搬回技能目录')
  assert.equal(ld.hashText(readFileSync(restored, 'utf8')), entry.beforeHash, '搬回来的内容指纹应与台账一致')
  assert.equal(readUsageFile().skills['aging-probe'].state, 'active', '档位应跟着回到 active，不然目录里照样看不到它')
  passed += 1
})

// 第 4 条：自动跑的那条线接在会话打开上，节流状态读写自成一体、坏文件当没跑过。
test('自动整理挂在 dsc/session-open，时间戳文件坏掉当没跑过', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  assert.match(source, /ctx\.on\('dsc\/session-open', \(\) => \{ autoCurate\(\) \}\)/, '钩子要挂在 dsc/session-open 上')
  assert.match(source, /enabled: config\.enabled/, '自动整理必须过功能开关')
  assert.match(source, /lastRunAt: readLastCuratedAt\(\)/, '自动整理必须先过 shouldCurate 这道闸')
  assert.match(source, /saveLastRunAt: \(now\) => \{ writeLastCuratedAt\(now\) \}/, '跑完要写回时间戳')
  sw.writeLastCuratedAt(123_456_789)
  assert.equal(sw.readLastCuratedAt(), 123_456_789, '写下去再读回来应是同一个时间戳')
  writeFileSync(join(skillsDir, '.curated.json'), '{ 这不是 JSON', 'utf8')
  assert.equal(sw.readLastCuratedAt(), 0, '坏文件一律当「从没跑过」')
  passed += 1
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
    saveLastRunAt: () => { calls.saved += 1 },
    announce: () => { calls.said += 1 },
    changed: () => { calls.changed += 1 },
  }
  const blocked = mod.autoCurateOnce(deps)
  assert.deepEqual(blocked, { ran: false, text: '', report: null })
  assert.equal(calls.curate, 0, '关掉开关不许整理')
  assert.equal(calls.saved, 0, '关掉开关不许写时间戳')
  assert.equal(calls.said, 0)
  assert.equal(calls.changed, 0)

  // 开关打开的同一条路径：整理一次、写一次时间戳、有变化才说一句。
  const opened = mod.autoCurateOnce({ ...deps, enabled: true })
  assert.equal(opened.ran, true)
  assert.equal(calls.curate, 1)
  assert.equal(calls.saved, 1)
  assert.equal(calls.said, 1)
  assert.match(opened.text, /1 个降为 stale/u)
  passed += 1
})

// 第 6 条：红线 —— 用户手写的技能 31 天没命中也不许被搬走。
test('curateSkills：createdBy 不是 agent 的技能 31 天未命中也不搬走', () => {
  // 清掉上一条留下的 aging-probe，让这一轮只看得见用户技能
  rmSync(join(skillsDir, 'aging-probe'), { recursive: true, force: true })
  writeSkill('user-probe', '用户手写探针')
  writeUsageRecord('user-probe', 31, 'user')
  const report = sw.curateSkills(Date.now())
  assert.ok(!report.archived.includes('user-probe'), '用户手写的技能不该被归档')
  assert.equal(existsSync(join(skillsDir, 'user-probe', 'SKILL.md')), true, '用户手写的技能必须原地不动')
  assert.equal(readUsageFile().skills['user-probe'].state, 'active', '档位也不该被改动')
  passed += 1
})

after(() => {
  rmSync(home, { recursive: true, force: true })
  console.log('通过 ' + String(passed) + ' 项')
})
