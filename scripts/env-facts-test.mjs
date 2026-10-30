/**
 * 环境快照与 PTC 调用日志的探针（2026-10-30）。
 *
 * 两条都来自「模型每轮都要多花一次调用」的反馈：
 *
 *   1. 快照只写「工作区有未提交改动」，不说是哪几个文件——模型只好自己 `git status`；
 *      而 `git status` 默认把中文名写成 `"\351\207\215…"` 这种八进制，第一眼认不出来。
 *      现在的快照直接列前 5 行（带 `-c core.quotePath=false`），超出部分给总数。
 *   2. `run_code` 每次把调用的工具逐条摊开，六次调用占六行。现在压成一行汇总
 *      （`glob×2、grep、bash`），只有**失败**的条目单独列——参数与原因得留着。
 *
 * 跑法：先 `pnpm run build`，再 `node scripts/env-facts-test.mjs`。
 *
 * @module dsc/scripts/env-facts-test
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { environmentText } = await import('../lib/core/prompt.js')
const { ptcResultBody } = await import('../lib/core/ptc.js')

let passed = 0
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

const dir = await mkdtemp(join(tmpdir(), 'dsc-envfacts-'))
const git = (args) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })

try {
  console.log('[1] 环境快照：列出改了什么，中文名不转义')
  git(['init', '-q'])
  await writeFile(join(dir, 'base.txt'), 'base\n', 'utf8')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'init'])
  // 一个改过的已跟踪文件 + 一个中文名未跟踪文件：两条都该出现在快照里
  await writeFile(join(dir, 'base.txt'), 'base changed\n', 'utf8')
  await writeFile(join(dir, '重构计划书.md'), '# plan\n', 'utf8')

  const text = environmentText(dir)
  check('说了是哪几个文件', text.includes('base.txt') && text.includes('重构计划书.md'), text)
  check('中文名不是八进制转义', !/\\\d{3}/.test(text), text)
  check('仍然标了「有未提交改动」', text.includes('工作区有未提交改动'), text)
  check('没把「工作区干净」也写一遍', !text.includes('工作区干净'), text)

  console.log('[2] 环境快照：超过 5 项给总数')
  // 快照按 cwd 缓存 30 秒（设计如此，免得每轮白跑 two 次 git）：换一个临时仓库再看这一段。
  const many = await mkdtemp(join(tmpdir(), 'dsc-envfacts-many-'))
  const gitMany = (args) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
      cwd: many,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  try {
    gitMany(['init', '-q'])
    await writeFile(join(many, 'base.txt'), 'base\n', 'utf8')
    gitMany(['add', '.'])
    gitMany(['commit', '-q', '-m', 'init'])
    for (let i = 0; i < 6; i += 1) await writeFile(join(many, `extra-${String(i)}.txt`), 'x\n', 'utf8')
    const text2 = environmentText(many)
    check('总数报出来了', /等 6 项/.test(text2), text2)
    check('最多只列 5 个', (text2.match(/extra-\d\.txt/g) ?? []).length <= 5, text2)
  } finally {
    await rm(many, { recursive: true, force: true })
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log('[3] PTC 调用日志：成功的压成一行，失败的单独列')
{
  const body = ptcResultBody({
    value: { ok: true },
    calls: [
      { name: 'glob', args: '{"pattern":"a"}', ms: 12, ok: true },
      { name: 'glob', args: '{"pattern":"b"}', ms: 20, ok: true },
      { name: 'grep', args: '{"pattern":"c"}', ms: 30, ok: true },
      { name: 'bash', args: '{"command":"x"}', ms: 30000, ok: false, note: '命令超时（30000ms）' },
      { name: 'read', args: '{"path":"d"}', ms: 5, ok: true },
    ],
    logs: [],
  })
  const lines = body.split('\n').filter((line) => line.trim() !== '')
  check('汇总是一行', lines.some((line) => line.includes('调了 5 次工具')), body)
  check('汇总带次数', /glob×2/.test(body), body)
  check('汇总带失败条数', /失败 1 条/.test(body), body)
  check('失败条目仍单独列', /✗ bash/.test(body) && body.includes('命令超时'), body)
  check('成功条目不再逐条铺开', !/✓ /.test(body), body)

  const clean = ptcResultBody({
    value: 'done',
    calls: [{ name: 'read', args: '{}', ms: 3, ok: true }],
    logs: [],
  })
  check('全成功时只有一行汇总', clean.includes('这一轮调了 1 次工具（read）') && !clean.includes('✗'), clean)
}

console.log('')
console.log(failures === 0 ? `全部通过（${String(passed)} 项）` : `${String(failures)} 项失败（通过 ${String(passed)} 项）`)
process.exit(failures === 0 ? 0 : 1)
