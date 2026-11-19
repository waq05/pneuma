/**
 * sandbox runner 的解释器解析（interpreter.ts）纯函数自检：不读 process、不起子进程，
 * 只把三份入参喂进去看返回的 file/kind/env。
 *
 * 三条分支（宿主 node / Electron / DSC_NODE 指定）决定沙箱里的 runner 用哪个可执行文件、
 * 以及要不要注入 ELECTRON_RUN_AS_NODE；写错的表现是 runner 起不来或起来的是界面进程。
 *
 * @module @pneuma/sandbox/tests/interpreter
 */
import { expect, test } from 'vitest'
import { resolveRunnerInterpreter } from '../win/interpreter.js'

const EXEC = 'C:\\Program Files\\nodejs\\node.exe'
const PATH_KEY = 'PATH'
const PATH_VALUE = 'C:\\Windows\\System32'

/** 每次都新建一份 env，免得用例之间互相污染。 */
const makeEnv = (extra: Record<string, string> = {}): Record<string, string> => ({ [PATH_KEY]: PATH_VALUE, ...extra })

test('node 分支：宿主就是 node，file 用 execPath，不注入 ELECTRON_RUN_AS_NODE', () => {
  const out = resolveRunnerInterpreter({ execPath: EXEC, electron: false, env: makeEnv() })
  expect(out.file).toBe(EXEC)
  expect(out.kind).toBe('node')
  expect(out.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
})

test('electron 分支：置 ELECTRON_RUN_AS_NODE=1', () => {
  const out = resolveRunnerInterpreter({ execPath: 'C:\\app\\electron.exe', electron: true, env: makeEnv() })
  expect(out.kind).toBe('electron')
  expect(out.file).toBe('C:\\app\\electron.exe')
  expect(out.env.ELECTRON_RUN_AS_NODE).toBe('1')
})

test('electron 分支：原 env 里是 0 也要改成 1', () => {
  const out = resolveRunnerInterpreter({
    execPath: 'C:\\app\\electron.exe',
    electron: true,
    env: makeEnv({ ELECTRON_RUN_AS_NODE: '0' }),
  })
  expect(out.env.ELECTRON_RUN_AS_NODE).toBe('1')
})

test('DSC_NODE 有值：用 override，且不注入 ELECTRON_RUN_AS_NODE', () => {
  const node = 'D:\\tools\\node\\node.exe'
  // 故意给 electron:true：override 优先级更高，不该被 Electron 分支改写。
  const out = resolveRunnerInterpreter({
    execPath: 'C:\\app\\electron.exe',
    electron: true,
    env: makeEnv({ DSC_NODE: node }),
  })
  expect(out.file).toBe(node)
  expect(out.kind).toBe('override')
  expect(out.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
})

test('DSC_NODE 是空白：当作没给，走 electron 分支', () => {
  const out = resolveRunnerInterpreter({
    execPath: 'C:\\app\\electron.exe',
    electron: true,
    env: makeEnv({ DSC_NODE: '   ' }),
  })
  expect(out.file).toBe('C:\\app\\electron.exe')
  expect(out.kind).toBe('electron')
  expect(out.env.ELECTRON_RUN_AS_NODE).toBe('1')
})

test('原有 env 的其它键（PATH）在三个分支都还在', () => {
  const cases = [
    { execPath: EXEC, electron: false, env: makeEnv() },
    { execPath: 'C:\\app\\electron.exe', electron: true, env: makeEnv() },
    { execPath: EXEC, electron: false, env: makeEnv({ DSC_NODE: 'D:\\n\\node.exe' }) },
  ]
  for (const input of cases) {
    expect(resolveRunnerInterpreter(input).env[PATH_KEY]).toBe(PATH_VALUE)
  }
})

test('传进去的 env 对象没有被改写', () => {
  const env = { PATH: PATH_VALUE, ELECTRON_RUN_AS_NODE: '0' }
  const out = resolveRunnerInterpreter({ execPath: 'C:\\app\\electron.exe', electron: true, env })
  // 返回的是新对象，原键值一个没动。
  expect(env.ELECTRON_RUN_AS_NODE).toBe('0')
  expect(out.env.ELECTRON_RUN_AS_NODE).toBe('1')
  expect(out.env).not.toBe(env)
})
