/** sandbox runner 的解释器解析（interpreter.ts）纯函数自检：不读 process、不起子进程，
 * 只把三份入参喂进去看返回的 file/kind/env。读 lib/ 产物，先 pnpm run build。
 * 单独跑：node --test src/packages/sandbox/tests/interpreter.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { resolveRunnerInterpreter } = await import(
  new URL('../../../../lib/packages/sandbox/win/interpreter.js', import.meta.url).href
)

const EXEC = 'C:\\Program Files\\nodejs\\node.exe'
const PATH_KEY = 'PATH'
const PATH_VALUE = 'C:\\Windows\\System32'

/** 每次都新建一份 env，免得用例之间互相污染。 */
const makeEnv = (extra = {}) => ({ [PATH_KEY]: PATH_VALUE, ...extra })

test('node 分支：宿主就是 node，file 用 execPath，不注入 ELECTRON_RUN_AS_NODE', () => {
  const out = resolveRunnerInterpreter({ execPath: EXEC, electron: false, env: makeEnv() })
  assert.equal(out.file, EXEC)
  assert.equal(out.kind, 'node')
  assert.equal(out.env.ELECTRON_RUN_AS_NODE, undefined)
})

test('electron 分支：置 ELECTRON_RUN_AS_NODE=1', () => {
  const out = resolveRunnerInterpreter({ execPath: 'C:\\app\\electron.exe', electron: true, env: makeEnv() })
  assert.equal(out.kind, 'electron')
  assert.equal(out.file, 'C:\\app\\electron.exe')
  assert.equal(out.env.ELECTRON_RUN_AS_NODE, '1')
})

test('electron 分支：原 env 里是 0 也要改成 1', () => {
  const out = resolveRunnerInterpreter({
    execPath: 'C:\\app\\electron.exe',
    electron: true,
    env: makeEnv({ ELECTRON_RUN_AS_NODE: '0' }),
  })
  assert.equal(out.env.ELECTRON_RUN_AS_NODE, '1')
})

test('DSC_NODE 有值：用 override，且不注入 ELECTRON_RUN_AS_NODE', () => {
  const node = 'D:\\tools\\node\\node.exe'
  // 故意给 electron:true：override 优先级更高，不该被 Electron 分支改写。
  const out = resolveRunnerInterpreter({
    execPath: 'C:\\app\\electron.exe',
    electron: true,
    env: makeEnv({ DSC_NODE: node }),
  })
  assert.equal(out.file, node)
  assert.equal(out.kind, 'override')
  assert.equal(out.env.ELECTRON_RUN_AS_NODE, undefined)
})

test('DSC_NODE 是空白：当作没给，走 electron 分支', () => {
  const out = resolveRunnerInterpreter({
    execPath: 'C:\\app\\electron.exe',
    electron: true,
    env: makeEnv({ DSC_NODE: '   ' }),
  })
  assert.equal(out.file, 'C:\\app\\electron.exe')
  assert.equal(out.kind, 'electron')
  assert.equal(out.env.ELECTRON_RUN_AS_NODE, '1')
})

test('原有 env 的其它键（PATH）在三个分支都还在', () => {
  const cases = [
    { execPath: EXEC, electron: false, env: makeEnv() },
    { execPath: 'C:\\app\\electron.exe', electron: true, env: makeEnv() },
    { execPath: EXEC, electron: false, env: makeEnv({ DSC_NODE: 'D:\\n\\node.exe' }) },
  ]
  for (const input of cases) {
    assert.equal(resolveRunnerInterpreter(input).env[PATH_KEY], PATH_VALUE)
  }
})

test('传进去的 env 对象没有被改写', () => {
  const env = { PATH: PATH_VALUE, ELECTRON_RUN_AS_NODE: '0' }
  const out = resolveRunnerInterpreter({ execPath: 'C:\\app\\electron.exe', electron: true, env })
  // 返回的是新对象，原键值一个没动。
  assert.equal(env.ELECTRON_RUN_AS_NODE, '0')
  assert.equal(out.env.ELECTRON_RUN_AS_NODE, '1')
  assert.notEqual(out.env, env)
})
