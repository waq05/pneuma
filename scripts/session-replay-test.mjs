/**
 * 会话重放快照：喂一份 JSONL，断言重放出来的状态没变。
 *
 * 这是「同一份日志重放之后，用户看到的东西还是那个东西」的第一条自动断言。
 * 以前改状态写入顺序、改恢复逻辑，都只能开界面人肉看一遍。
 *
 * 为什么 fixture 里写死的 `cwd` 会被改写：见 `_testkit.replaySession` 的注释——
 * 会话的目录是它自己的数据，换台机器就该换成那台机器的真实目录，否则在 CI 上打不开。
 *
 * @module dsc/scripts/session-replay-test
 */
import { fileURLToPath } from 'node:url'
import { replaySession, snapshotJson } from './_testkit.mjs'

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : ` → ${extra}`}`)
}

const fixture = fileURLToPath(new URL('./fixtures/session-replay.jsonl', import.meta.url))
const state = await replaySession(fixture)

check('mode 按日志恢复', state.mode === 'plan', String(state.mode))
check('preset 按日志恢复', state.preset === 'build', String(state.preset))
check('permissions 三项都在', state.permissions?.sandbox === 'workspace-write' && state.permissions?.policy === 'auto-edit', JSON.stringify(state.permissions))
check('todos 整表恢复（含状态）', Array.isArray(state.todos) && state.todos.length === 2 && state.todos[1]?.status === 'pending', JSON.stringify(state.todos))
check('没写过的状态是 undefined（不能凭空出现在快照里）', state.plan === undefined && state.plans === undefined, JSON.stringify(state.plans))
check('重放不会往日志里多写记录', state.log?.records === 6, String(state.log?.records))
check('日志记录类型顺序不变', JSON.stringify(state.log?.types) === JSON.stringify(['meta', 'state', 'state', 'state', 'state', 'user']), JSON.stringify(state.log?.types))

// 快照盯的是「整包形状」：哪天某个插件开始往会话里多写一条状态，这里会红
snapshotJson(fileURLToPath(new URL('./session-replay.snapshot.json', import.meta.url)), state)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`)
process.exitCode = failures === 0 ? 0 : 1
