/**
 * PTC 里写文件的改动必须留痕（2026-10-30 报障：会话底部不出「文件已更改」卡）。
 *
 * 根因回顾：run_code 内部调 sdk.write 时，工具返回的 changes（改了哪个文件、增删几行、
 * 改前全文）被 PTC 丢了，只剩文本。于是：
 *   - 没有 tool/changes 事件 → 轮尾卡不出现；
 *   - 没有回合基线 → 聚合 diff（turn/diff）也没有；
 *   - 非 git 工作区连兜底都没有（git 兜底只在仓库里生效）。
 *
 * 这份探针钉四件事：
 *   ① run_code 的返回值带上 changesList，元素里带 baseline（回合基线要用）；
 *   ② 落盘时 changes 写数组，重开会话读回来还是数组（老日志的单值形状也认）；
 *   ③ 一次脚本改两个文件 → 两条都在，同文件两刀 → 聚合只有一条；
 *   ④ 落盘记录里没有 baseline（内存字段不外泄）。
 *
 * 隔离：临时 HOME + 临时工作区，真实 ~/.dsc 一个字节不动；不连真模型。
 * 运行：pnpm build && node scripts/ptc-changes-test.mjs
 *
 * @module dsc/scripts/ptc-changes-test
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-ptc-changes-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })
writeFileSync(join(process.env.DSC_HOME, 'config.yaml'), 'model:\n  name: test\n', 'utf8')

const cwd = join(home, 'ws')
mkdirSync(cwd, { recursive: true })

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const { createKernel } = await import('../lib/host/kernel.js')
const { Session } = await import('../lib/core/session.js')

const kernel = await createKernel({ config: {} })
const session = kernel.get('session')
const tools = kernel.get('tools')
const runCode = tools.list().find((entry) => entry.name === 'run_code')
check('PTC 模式里拿得到 run_code', runCode !== undefined)

const runCtx = () => ({
  cwd,
  signal: new AbortController().signal,
  sessionId: session.current().meta.id,
  sessionPath: session.current().filePath,
})

console.log('\n[1] 脚本里写两个文件：改动随结果交回，带 baseline')
let two = undefined
{
  two = await runCode.run(
    {
      code: [
        "const a = await sdk.write({ path: 'a.txt', content: 'one\\ntwo\\n' })",
        "const b = await sdk.write({ path: 'b.txt', content: 'hello\\n' })",
        'return a + b',
      ].join('\n'),
    },
    runCtx(),
  )
  const list = two.changesList ?? []
  check('返回里带 changesList（不再是纯字符串）', Array.isArray(two.changesList), JSON.stringify(Object.keys(two)))
  check('两个文件都在清单里', list.length === 2, JSON.stringify(list.map((item) => item.path)))
  check('路径是绝对路径', list.every((item) => typeof item.path === 'string' && item.path.startsWith(cwd)), JSON.stringify(list.map((item) => item.path)))
  check('新建文件 status=added', list.every((item) => item.status === 'added'))
  check('带了改前全文（baseline 是空串 = 新建）', list.every((item) => item.baseline === ''))
  check('a.txt 的增行数是 2', list.some((item) => item.path.endsWith('a.txt') && item.added === 2), JSON.stringify(list.map((item) => ({ p: item.path, a: item.added }))))
}

console.log('\n[2] 交给会话：落盘写数组，重开读回来还是数组')
{
  const current = session.current()
  // 模拟循环那一侧：先记回合基线，再把剥过 baseline 的清单塞进 tool 记录
  for (const change of two.changesList) current.recordTurnChange(change.path, change.baseline ?? '')
  const clean = two.changesList.map(({ baseline: _baseline, ...rest }) => rest)
  current.appendTool('call-ptc-1', 'run_code', { text: two.text, changes: clean }, undefined)

  // 日志走 createWriteStream（异步打开）：读之前等一拍，否则会抢在文件建出来之前
  await sleep(300)
  const raw = readFileSync(current.filePath, 'utf8')
  check('落盘的 tool 记录里 changes 是数组', /"changes":\s*\[/.test(raw), raw.slice(-400))
  check('落盘记录里没有 baseline', !raw.includes('"baseline"'))

  const reopened = Session.load(current.filePath, true, { lease: false })
  const back = reopened.fileChanges.get('call-ptc-1') ?? []
  check('重开会话后 changes 仍是两条', back.length === 2, JSON.stringify(back.length))
  check('读回来的元素不带 baseline', back.every((item) => !Object.hasOwn(item, 'baseline')))

  const files = await current.takeTurnChanges()
  check('聚合后两个文件两条', files.length === 2, JSON.stringify(files.map((item) => item.path)))
  check('聚合产物不带 baseline', files.every((item) => !Object.hasOwn(item, 'baseline')))
}

console.log('\n[3] 同一文件两刀：聚合只出一条，diff 是「起点 vs 终态」')
{
  const current = session.current()
  const one = await runCode.run({ code: "await sdk.write({ path: 'c.txt', content: 'x\\n' }); return 'ok'" }, runCtx())
  for (const change of one.changesList ?? []) current.recordTurnChange(change.path, change.baseline ?? '')
  const again = await runCode.run({ code: "await sdk.edit({ path: 'c.txt', old: 'x', new: 'y\\nz' }); return 'ok'" }, runCtx())
  for (const change of again.changesList ?? []) current.recordTurnChange(change.path, change.baseline ?? '')

  const files = await current.takeTurnChanges()
  const target = files.find((item) => item.path.endsWith('c.txt'))
  check('同文件两刀只出一条', files.length === 1, JSON.stringify(files.map((item) => item.path)))
  check('终态两行（y 与 z）、无删除', target !== undefined && target.added === 2 && target.removed === 0, JSON.stringify({ added: target?.added, removed: target?.removed }))
}

console.log('\n[4] 老日志的单值形状照旧读得懂')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsc-ptc-legacy-'))
  const legacy = Session.create(dir)
  const summary = { path: join(dir, 'old.txt'), added: 1, removed: 0, hunks: [], status: 'added' }
  // 老版本写的是单值：这里直接手写一条老形状的日志行，看读回来会不会被当成「不是数组」丢掉
  legacy.appendTool('call-old', 'write', { text: 'ok', changes: summary }, undefined)
  await sleep(300)
  const reopened = Session.load(legacy.filePath, true, { lease: false })
  const back = reopened.fileChanges.get('call-old') ?? []
  check('单值被归一成一条清单', back.length === 1 && back[0].path === summary.path, JSON.stringify(back))
}

await kernel.dispose?.()
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`)
process.exit(failures === 0 ? 0 : 1)
