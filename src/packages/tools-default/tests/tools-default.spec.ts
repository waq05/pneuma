/**
 * @pneuma/tools-default 的包级测试：钉 7 条不变量。
 * 为什么只钉这些：工具真跑要子进程与磁盘，留在集成探针里；能便宜钉住的是装配面、包形态、
 * 入口、文档、两个纯函数（glob 花括号展开、bash 输出截断），以及作业表的对外查询口
 * （`ctx.jobs`，superagent 执行器靠它等 worker 回合结束后的作业）。
 * 导入面是源码入口（`../index.js` 等），不是 `lib/` 产物。
 * @module @pneuma/tools-default/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { toolsDefaultPlugin } from '../index.js'
import { expandBraces } from '../search-tools.js'
import { JobTable, createJobsService, truncateBashOutput } from '../bash.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/tools-default', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: tools-default\s*$/m)
  expect(patch).toContain("name: '@pneuma/tools-default'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml（库包则相反）。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.'].default).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  if (pkg.pneuma.library === true) {
    expect(pkg.pneuma.bundle).toBeUndefined()
  } else {
    expect(pkg.pneuma.bundle.patch).toBe('./cordis.patch.yml')
  }
})

// 入口真能加载：直接 import 源码入口并检查插件对象的三件事。
test('入口能加载，插件名与 apply 对得上', () => {
  expect(typeof toolsDefaultPlugin).toBe('object')
  expect(typeof toolsDefaultPlugin.name).toBe('string')
  expect(toolsDefaultPlugin.name).toBe(pkg.name.split('/').pop())
  expect(toolsDefaultPlugin.name).toBe('tools-default')
  expect(typeof toolsDefaultPlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

// 花括号展开：只有真带逗号的多选才展开；单值按字面量处理；缺右括号直接报错，不静默空结果。
test('glob 花括号：{a,b} 展开，{a} 不展开，缺 } 报错', () => {
  expect(expandBraces('src/*.{js,ts}')).toEqual(['src/*.js', 'src/*.ts'])
  expect(expandBraces('src/{a}')).toEqual(['src/{a}'])
  expect(expandBraces('src/*.js')).toEqual(['src/*.js'])
  expect(() => expandBraces('src/*.{js')).toThrow(/没有配对的/)
})

// 输出截断：留头 60% + 尾 40%，中间写明省略多少字符；没超预算就原样返回。
test('bash 输出截断：头 60% + 尾 40%，短输出不动', () => {
  const out = truncateBashOutput('A'.repeat(100), 10)
  expect(out.startsWith('A'.repeat(6))).toBe(true)
  expect(out.endsWith('A'.repeat(4))).toBe(true)
  expect(out).toContain('中间省略 90 字符')
  expect(truncateBashOutput('短输出', 10)).toBe('短输出')
})

// 作业表对外查询口（backlog G3）：superagent 的执行器靠它等 worker 回合结束后的作业。
// 钉四件事：owner 过滤、running 只列在跑的、wait 真等到结束、kill 只收在跑的。
test(
  'jobs 服务：owner 过滤、running、wait 等到结束、kill 幂等',
  async () => {
    const table = new JobTable({ notify: () => undefined })
    const jobs = createJobsService(table)
    const cwd = process.cwd()
    // 两个作业分属两个会话：过滤要按 owner 分得开。命令睡 600ms，保证断言那一刻它还在跑。
    // 用 `node -e` 而不是临时脚本：不拼路径，Windows 的 PowerShell 与 POSIX 的 sh 都能原样执行。
    const mine = table.launch('node -e "setTimeout(()=>{},600)"', cwd, 'session-a')
    const other = table.launch('node -e "setTimeout(()=>{},600)"', cwd, 'session-b')
    expect(jobs.list('session-a').length, 'list 要按 owner 过滤').toBe(1)
    expect(jobs.list('session-a')[0].id).toBe(mine)
    expect(jobs.list('session-b')[0].id).toBe(other)
    expect(jobs.running('session-a').length, '刚起的作业应当在 running 里').toBe(1)
    expect(jobs.running('session-a')[0].owner, 'running 要带上 owner').toBe('session-a')
    // kill 一个在跑的：返回 true，之后它不再出现在 running 里。
    expect(jobs.kill(mine), '在跑的作业 kill 要返回 true').toBe(true)
    expect(jobs.running('session-a').length, '被终止的作业不该还在 running 里').toBe(0)
    // 再 kill 一次同一个：已经不在跑，返回 false（幂等）。
    expect(jobs.kill(mine), 'kill 要幂等').toBe(false)
    // wait 真等到另一个作业结束。
    expect(await jobs.wait(other, 10_000), 'wait 应当等到作业结束').toBe(true)
    expect(jobs.list('session-b')[0].status).toBe('completed')
    // 没有这个作业：wait 立刻 true（没有东西可等），kill 返回 false。
    expect(await jobs.wait('job-does-not-exist', 1000)).toBe(true)
    expect(jobs.kill('job-does-not-exist')).toBe(false)
  },
  // 真起两个子进程（各自要拉起 shell），默认 5s 不够稳，与 bash-jobs.spec.ts 同一档给 30s。
  30_000,
)
