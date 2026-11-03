/**
 * 「最近使用 = 会话最后一步的时间」的宿主侧探针（真内核，临时 HOME）。
 *
 * 钉的口径（2026-11-03 用户报障「点一下会话，时间就变刚刚」）：
 *   ① 侧栏那列时间取最后一条带 `ts` 的对话记录，不取文件 mtime——文件被写过不代表
 *      用户做了什么；
 *   ② 打开老会话补权限默认值（`permissionOf`）不再追加日志、不再刷新 mtime；
 *   ③ 补钉值在同一进程里立刻可读（不能为了不写盘就把值丢掉）；
 *   ④ 下一次真正写日志时，补钉值跟着落盘，重放之后还是同一份；
 *   ⑤ 老日志（没有 `ts` 字段）回落到 mtime，至少排序不乱；
 *   ⑥ 只有 meta 与记账、没有对话的文件仍然不进列表。
 *
 * 隔离：临时 HOME + 临时工作区，真实 ~/.dsc 不碰。
 * 运行：node scripts/session-activity-time-test.mjs（先 pnpm build）
 *
 * @module dsc/scripts/session-activity-time-test
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-activity-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dsc = join(home, '.dsc')
mkdirSync(dsc, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), 'model:\n  name: test\n', 'utf8')

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}
const checkEq = (label, actual, expected) =>
  check(label, actual === expected, `实际 ${String(actual)} ≠ 期望 ${String(expected)}`)

const ws = join(home, 'ws')
mkdirSync(ws, { recursive: true })

const { Session, listSessions, sessionsRoot, slugCwd } = await import('../lib/core/session.js')
const { resolvePermissions } = await import('../lib/core/permission-scope.js')

const seedDir = join(sessionsRoot(), slugCwd(ws))
mkdirSync(seedDir, { recursive: true })
const line = (record) => `${JSON.stringify(record)}\n`

// ── [1] 最后一条是记账（state，无 ts）：时间留在最后一步上 ──────────────────
const idA = '11111111-2222-3333-4444-555555555555'
const fileA = join(seedDir, `${idA}.jsonl`)
writeFileSync(
  fileA,
  line({ type: 'meta', id: idA, cwd: ws, createdAt: 100 })
    + line({ type: 'user', text: '第一问', ts: 200 })
    + line({ type: 'assistant', text: '第一答', reasoning: '', ts: 300 })
    // 打开会话时补的三条权限默认值：一条 ts 都没有
    + line({ type: 'state', id: 'permissions', payload: { sandbox: null, policy: null, reviewer: null } }),
  'utf8',
)

const rowA = listSessions().find((item) => item.id === idA)
check('[1] 会话在列表里', rowA !== undefined)
checkEq('[1] 最近使用取最后一条对话的 ts', rowA?.updatedAt, 300)
check('[1] 不是文件 mtime', rowA !== undefined && rowA.updatedAt !== statSync(fileA).mtimeMs)

// ── [2] 老日志没有 ts：回落 mtime ─────────────────────────────────────────
const idB = '66666666-7777-8888-9999-aaaaaaaaaaaa'
const fileB = join(seedDir, `${idB}.jsonl`)
writeFileSync(
  fileB,
  line({ type: 'meta', id: idB, cwd: ws, createdAt: 100 })
    + line({ type: 'user', text: '老问题' })
    + line({ type: 'assistant', text: '老回答', reasoning: '' }),
  'utf8',
)
const rowB = listSessions().find((item) => item.id === idB)
checkEq('[2] 没有 ts 时按 mtime', rowB?.updatedAt, statSync(fileB).mtimeMs)

// ── [3] 只有 meta 与记账的文件仍然不进列表 ────────────────────────────────
const idC = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
writeFileSync(
  join(seedDir, `${idC}.jsonl`),
  line({ type: 'meta', id: idC, cwd: ws, createdAt: 100 })
    + line({ type: 'state', id: 'permissions', payload: { sandbox: 'workspace-write', policy: 'auto-edit', reviewer: 'user' } }),
  'utf8',
)
check('[3] 空会话不进列表', listSessions().every((item) => item.id !== idC))

// ── [4] 打开会话补默认值：不写盘、不动 mtime ──────────────────────────────
const sizeBefore = statSync(fileA).size
const mtimeBefore = statSync(fileA).mtimeMs
const opened = Session.load(fileA)
const defaults = { sandbox: 'workspace-write', policy: 'auto-edit', reviewer: 'user' }
const resolved = resolvePermissions(opened, defaults)
checkEq('[4] 补钉返回默认值（沙箱）', resolved.sandbox, 'workspace-write')
checkEq('[4] 补钉返回默认值（权限模式）', resolved.policy, 'auto-edit')
checkEq('[4] 补钉返回默认值（审阅者）', resolved.reviewer, 'user')
checkEq('[4] 文件一个字节都没多', statSync(fileA).size, sizeBefore)
checkEq('[4] mtime 没被刷新', statSync(fileA).mtimeMs, mtimeBefore)
checkEq('[4] 列表时间仍然是最后一步', listSessions().find((item) => item.id === idA)?.updatedAt, 300)

// ── [5] 同一进程里读得到刚补的值，且不会越过用户后来改的档位 ──────────────
checkEq('[5] 立刻读得到沙箱', opened.state('permissions')?.sandbox, 'workspace-write')
const again = resolvePermissions(opened, { sandbox: 'read-only', policy: 'auto-edit', reviewer: 'user' })
checkEq('[5] 已钉住的项不再跟着默认值漂', again.sandbox, 'workspace-write')

// ── [6] 下一次真写日志：补钉值跟着落盘（在触发它的那条之前）────────────────
const now = Date.now()
opened.appendUser('第二问')
opened.close()
/** 写入流是异步的：等到「第二问」真的落盘再断言，别跟缓冲较劲。 */
async function waitForFile(file, needle, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = readFileSync(file, 'utf8')
    if (text.includes(needle) || Date.now() > deadline) return text
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const written = await waitForFile(fileA, '第二问')
const linesAfter = written.trimEnd().split(/\r?\n/)
const pinnedLine = linesAfter.findLastIndex((text) => text.includes('"id":"permissions"'))
const userLine = linesAfter.findIndex((text) => text.includes('"text":"第二问"'))
check('[6] 补钉值落盘了', pinnedLine >= 0)
check('[6] 顺序在用户那条之前', pinnedLine >= 0 && pinnedLine < userLine)
const pinned = pinnedLine >= 0 ? JSON.parse(linesAfter[pinnedLine]).payload : {}
checkEq('[6] 落盘值等于补钉值（沙箱）', pinned.sandbox, 'workspace-write')
check('[6] 重放之后还是同一份', Session.load(fileA).state('permissions')?.reviewer === 'user')

const latest = listSessions().find((item) => item.id === idA)
check('[6] 说话之后时间前进了', latest !== undefined && latest.updatedAt >= now)

// ── [7] 点击（重新加载）不会把时间推到「现在」────────────────────────────
const beforeClick = listSessions().find((item) => item.id === idA).updatedAt
const mtimeBeforeClick = statSync(fileA).mtimeMs
const reopened = Session.load(fileA)
resolvePermissions(reopened, defaults)
reopened.close()
checkEq('[7] 再点一次，时间不动', listSessions().find((item) => item.id === idA).updatedAt, beforeClick)
checkEq('[7] 文件 mtime 也不动', statSync(fileA).mtimeMs, mtimeBeforeClick)

console.log('')
if (failures > 0) {
  console.log(`FAIL 共 ${failures} 条`)
  process.exitCode = 1
} else {
  console.log('PASS 最近使用时间口径全过')
}
