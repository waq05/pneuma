/**
 * 安全钩子的配置健康度探针（2026-10-28）。
 *
 * 现场：钩子配的脚本文件被删了，配置还指着它。于是每条 bash 都得到一句
 * 「钩子脚本失败（退出码 1）」并被拦下——用户看不出是文件没了。
 *
 * 这份探针钉住三件事：
 *   1. 认得出「命令里写了脚本、文件不存在」（trust = missing，不跑）；
 *   2. 脚本失败的拦截理由里带上 stderr 首行（Cannot find module 这种一眼可读）；
 *   3. 正常以 2 退出的阻断仍然按 stderr 给理由，不被上面的改动带偏。
 *
 * 用临时 HOME，不碰真实 ~/.dsc。跑之前先 `pnpm run build`。
 *
 * 运行：node scripts/hooks-test.mjs
 *
 * @module dsc/scripts/hooks-test
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-hooks-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })

const { scriptFileOf, scriptTokenOf, trustOf, judgeScriptRun } = await import(
  new URL('../lib/core/hooks.js', import.meta.url).href
)

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log('  ok  ' + label)
    return
  }
  failures += 1
  console.log('FAIL  ' + label + (extra === '' ? '' : '  <- ' + extra))
}

const missing = join(home, 'no-such-dir', 'guard.js')
const script = {
  id: 'x1',
  enabled: true,
  event: 'pre-tool',
  matcher: 'bash',
  command: `node ${missing}`,
  timeoutMs: 0,
  failClosed: true,
}
const settings = { enabled: true, scriptTimeoutMs: 10000, scriptFailClosed: true, autoAccept: false }

check('scriptFileOf 只认存在的文件（不存在给空串）', scriptFileOf(script.command) === '')
check('scriptTokenOf 不看存在性，认得出命令里的脚本', scriptTokenOf(script.command) === missing, scriptTokenOf(script.command))

const trust = trustOf(script, false)
check('文件不存在时状态是 missing', trust.state === 'missing', trust.state)
check('missing 的脚本不许跑', trust.runnable === false)
check('提示里写明缺的是哪个文件', trust.detail.includes(missing), trust.detail)

const judged = judgeScriptRun(
  { exitCode: 1, stdout: '', stderr: `Error: Cannot find module '${missing}'`, ms: 40, timedOut: false, spawnError: '', truncated: false },
  script,
  settings,
)
check('退出码 1 + fail-closed 判为拦', judged.action === 'block', judged.action)
check('拦截理由带上 stderr 首行', judged.message.includes('Cannot find module'), judged.message)
check('拦截理由不再只有「退出码 1」', judged.message.includes('Cannot find module') && judged.message.includes('钩子脚本失败'))

const blocked = judgeScriptRun(
  { exitCode: 2, stdout: '', stderr: '强推不允许', ms: 10, timedOut: false, spawnError: '', truncated: false },
  script,
  settings,
)
check('退出码 2 照旧按脚本给的理由阻断', blocked.action === 'block' && blocked.message === '强推不允许', blocked.message)

const silent = judgeScriptRun(
  { exitCode: 1, stdout: '', stderr: '   ', ms: 10, timedOut: false, spawnError: '', truncated: false },
  script,
  settings,
)
check('stderr 为空时文案保持原样（不出现空的 stderr 括号）', silent.action === 'block' && !silent.message.includes('stderr'), silent.message)

process.exit(failures === 0 ? 0 : 1)
