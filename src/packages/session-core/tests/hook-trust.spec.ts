/**
 * 钩子脚本的配置健康度（迁自 `scripts/hooks-test.mjs`，2026-10-28 现场）。
 *
 * 现场：钩子配的脚本文件被删了，配置还指着它。于是每条 bash 都得到一句
 * 「钩子脚本失败（退出码 1）」并被拦下——用户看不出是文件没了。
 *
 * 三件事各一条网：
 *   1. 认得出「命令里写了脚本、文件不存在」（trust = missing，不跑）；
 *   2. 脚本失败的拦截理由里带上 stderr 首行（`Cannot find module` 这种一眼可读）；
 *   3. 正常以 2 退出的阻断仍然按 stderr 给理由，不被上面的改动带偏。
 *
 * 纯函数，归 unit 层；但 `trustOf` 会读 `~/.dsc/hooks-trusted.json`，而那几个路径在
 * import 期由 `dscPath()` 算定，所以先换临时 HOME 再动态 import——顺序反了就会去读
 * 开发者真实的那份批准名单。
 *
 * @module dsc/packages/session-core/tests/hook-trust.spec
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../../../tests/harness.js'

/** 临时主目录：钩子配置与批准名单都从这里推导。 */
const home = tempHome('dsc-hook-trust-')

type HooksModule = typeof import('../hooks.js')
type HookScript = import('../hooks.js').HookScript
type HookSettings = import('../hooks.js').HookSettings
type HookRun = import('../hooks.js').HookRun

let hooks: HooksModule

beforeAll(async () => {
  hooks = await import('../hooks.js')
})

afterAll(() => {
  home.restore()
})

/** 命令里写着的那个脚本路径：故意不建出来，模拟「配了但文件被删」。 */
const MISSING = join(home.home, 'no-such-dir', 'guard.js')

/** 一条 pre-tool 脚本钩子。 */
const script: HookScript = {
  id: 'x1',
  enabled: true,
  event: 'pre-tool',
  matcher: 'bash',
  command: `node ${MISSING}`,
  timeoutMs: 0,
  failClosed: true,
}

/** 全局开关：脚本失败即拦。 */
const settings: HookSettings = { enabled: true, scriptTimeoutMs: 10_000, scriptFailClosed: true, autoAccept: false }

/** 造一次脚本执行结果。 */
function run(exitCode: number, stderr: string): HookRun {
  return { exitCode, stdout: '', stderr, ms: 40, timedOut: false, spawnError: '', truncated: false }
}

describe('① 认得出「配了脚本，文件没了」', () => {
  test('scriptFileOf 只认存在的文件（不存在给空串）', () => {
    expect(hooks.scriptFileOf(script.command)).toBe('')
  })

  test('scriptTokenOf 不看存在性，认得出命令里的脚本', () => {
    expect(hooks.scriptTokenOf(script.command)).toBe(MISSING)
  })

  test('文件不存在时状态是 missing', () => {
    expect(hooks.trustOf(script, false).state).toBe('missing')
  })

  test('missing 的脚本不许跑', () => {
    expect(hooks.trustOf(script, false).runnable).toBe(false)
  })

  test('提示里写明缺的是哪个文件', () => {
    expect(hooks.trustOf(script, false).detail).toContain(MISSING)
  })
})

describe('② 脚本失败的拦截理由带上 stderr 首行', () => {
  test('退出码 1 + fail-closed 判为拦', () => {
    const judged = hooks.judgeScriptRun(run(1, `Error: Cannot find module '${MISSING}'`), script, settings)
    expect(judged.action).toBe('block')
  })

  test('拦截理由带上 stderr 首行', () => {
    const judged = hooks.judgeScriptRun(run(1, `Error: Cannot find module '${MISSING}'`), script, settings)
    expect(judged.message).toContain('Cannot find module')
  })

  test('拦截理由不再只有「退出码 1」', () => {
    const judged = hooks.judgeScriptRun(run(1, `Error: Cannot find module '${MISSING}'`), script, settings)
    expect(judged.message).toContain('钩子脚本失败')
  })
})

describe('③ 正常阻断与空 stderr 不被带偏', () => {
  test('退出码 2 照旧按脚本给的理由阻断', () => {
    const judged = hooks.judgeScriptRun(run(2, '强推不允许'), script, settings)
    expect(judged.action).toBe('block')
    expect(judged.message).toBe('强推不允许')
  })

  test('stderr 为空时文案保持原样（不出现空的 stderr 括号）', () => {
    const judged = hooks.judgeScriptRun(run(1, '   '), script, settings)
    expect(judged.action).toBe('block')
    expect(judged.message).not.toContain('stderr')
  })
})
