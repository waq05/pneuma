/**
 * session-core 钩子配置读盘与批准名单的长尾补盲（w14）：
 *
 *   - `readHooks` 的 `statSync` 抛错分支（配置读不到不能把工具调用炸掉）；
 *   - `trustScript` 的「脚本文件读不到」；
 *   - `trustOf` 的「脚本自批准后消失」——两次 stat 之间文件没了，按漂移停跑。
 *
 * 后两条要求「`scriptFileOf` 认得出来、紧接着的 stat 却失败」，真实文件系统上只有
 * 竞态窗口才碰得到，所以这里对 `node:fs` 的 `statSync` 做最小替身：只按文件名与
 * 预算放行，其余调用原样交给真实实现。环境仍用临时 HOME，不碰真实 `~/.dsc`。
 *
 * @module dsc/packages/session-core/tests/w14-hooks-fs.spec
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  failHooksStat: false,
  scriptBudget: new Map<string, number>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const statSync = (path: string, ...rest: unknown[]): unknown => {
    const text = String(path)
    if (state.failHooksStat && text.endsWith('hooks.json')) throw new Error('EACCES: 钩子配置不可读')
    const name = text.split(/[\\/]/).at(-1) ?? ''
    const budget = state.scriptBudget.get(name)
    if (budget !== undefined) {
      if (budget <= 0) throw new Error('ENOENT: 脚本文件不见了')
      state.scriptBudget.set(name, budget - 1)
    }
    return (actual.statSync as unknown as (target: string, ...args: unknown[]) => unknown)(path, ...rest)
  }
  return { ...actual, statSync }
})

const HOME = mkdtempSync(join(tmpdir(), 'dsc-hooks-fs-w14-'))
const savedHome = process.env['HOME']
const savedProfile = process.env['USERPROFILE']
const savedDscHome = process.env['DSC_HOME']
process.env['HOME'] = HOME
process.env['USERPROFILE'] = HOME
delete process.env['DSC_HOME']
mkdirSync(join(HOME, '.dsc'), { recursive: true })

let hooks: typeof import('../hooks.js')
let HOOKS_FILE = ''

beforeAll(async () => {
  hooks = await import('../hooks.js')
  HOOKS_FILE = hooks.HOOKS_FILE
})

afterAll(() => {
  for (const [name, value] of [
    ['HOME', savedHome],
    ['USERPROFILE', savedProfile],
    ['DSC_HOME', savedDscHome],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 句柄：留给系统清
  }
})

let bump = 0

/** 写配置并把 mtime 往前推：`readHooks` 的缓存按 mtime+size 判新。 */
function writeHooks(scripts: unknown[]): void {
  writeFileSync(HOOKS_FILE, JSON.stringify({ version: 1, settings: {}, rules: [], scripts }), 'utf8')
  bump += 1
  const stamp = new Date(Date.now() + bump * 1_000)
  try {
    utimesSync(HOOKS_FILE, stamp, stamp)
  } catch {
    // 改不了时间就算了
  }
}

/** 写一条脚本文件并返回它的绝对路径。 */
function scriptFile(name: string): string {
  const file = join(HOME, name)
  writeFileSync(file, 'process.exit(0)\n', 'utf8')
  return file
}

test('配置 statSync 抛错：readHooks 返回空配置并把原因写进 problems', () => {
  writeHooks([])
  state.failHooksStat = true
  try {
    const doc = hooks.readHooks()
    expect(doc.rules).toEqual([])
    expect(doc.scripts).toEqual([])
    expect(doc.problems.join('\n')).toContain('钩子配置读不到')
  } finally {
    state.failHooksStat = false
  }
})

test('trustScript：scriptFileOf 认得脚本、stat 时文件却没了 → 返回「脚本文件读不到」', () => {
  const file = scriptFile('guard-w14-trust.mjs')
  writeHooks([{ id: 's-trust-w14', event: 'pre-tool', matcher: '*', command: `node ${file}` }])
  state.scriptBudget.set('guard-w14-trust.mjs', 1)
  try {
    const error = hooks.trustScript('s-trust-w14')
    expect(String(error)).toContain('脚本文件读不到')
  } finally {
    state.scriptBudget.delete('guard-w14-trust.mjs')
  }
})

test('trustOf：批准后脚本消失，第二次 stat 抛错 → 按 changed 停跑并要求重批', () => {
  const file = scriptFile('guard-w14-changed.mjs')
  const command = `node ${file}`
  writeHooks([{ id: 's-changed-w14', event: 'pre-tool', matcher: '*', command }])
  writeFileSync(
    hooks.HOOK_TRUST_FILE,
    JSON.stringify({
      version: 1,
      trusted: [{ event: 'pre-tool', command, trustedAt: Date.now(), scriptPath: file, scriptMtime: 1 }],
    }),
    'utf8',
  )
  state.scriptBudget.set('guard-w14-changed.mjs', 1)
  try {
    const script = hooks.readHooks().scripts[0]!
    const trust = hooks.trustOf(script)
    expect(trust.state).toBe('changed')
    expect(trust.runnable).toBe(false)
    expect(trust.detail).toContain('被改动过')
  } finally {
    state.scriptBudget.delete('guard-w14-changed.mjs')
  }
})
