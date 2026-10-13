/**
 * 状态面板四组新数据面的宿主侧端到端探针（真内核 + 真 git 仓库 + 真后台作业）。
 *
 * 为什么单开一条电池：`ui-status-panel-test.mjs` 钉的是壳侧纯逻辑与文本形态；
 * 「宿主到底算不算得出这些数」只有把真内核起起来才验得了——git 的增删行数、
 * 计划目录的扫盘排序、后台作业 / 终端会话进清单与收掉、定点任务进「工作流」面。
 *
 * 隔离：临时 HOME + 临时工作区（真 `git init` 的仓库），不碰真实 ~/.dsc。
 *
 * 运行：node scripts/ui-status-data-test.mjs（先 pnpm build）
 *
 * @module dsc/scripts/ui-status-data-test
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-status-data-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dsc = join(home, '.dsc')
mkdirSync(dsc, { recursive: true })
// 假端点：内核装配需要一个能读的 config.yaml，不连真模型
writeFileSync(join(dsc, 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// schedule 是官方可开关插件（清单里 defaultDisabled）：条目树里显式打开才算开。
writeFileSync(
  join(dsc, 'plugins.json'),
  JSON.stringify({ version: 1, entries: [{ file: 'schedule', disabled: false }] }, null, 2),
  'utf8',
)

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}

// ── 工作区：一个真 git 仓库（一次提交 + 一处改动 + 一个未跟踪文件）────────────────
const ws = join(home, 'ws')
mkdirSync(ws, { recursive: true })
const git = (...args) => execFileSync('git', args, { cwd: ws, stdio: 'pipe', windowsHide: true })
git('init', '-q')
git('config', 'user.email', 'probe@local')
git('config', 'user.name', 'probe')
writeFileSync(join(ws, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
git('add', 'a.txt')
git('commit', '-qm', 'init')
// 改一处（删 1 行 two、加 3 行 TWO/four/five）+ 一个未跟踪文件
writeFileSync(join(ws, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\n', 'utf8')
writeFileSync(join(ws, 'new.txt'), 'untracked\n', 'utf8')

// ── 计划目录：两份计划文件（甲带 # 标题，乙没有——回落首个非空行；乙更新）──────────
const plans = join(ws, '.dsc', 'plans')
mkdirSync(plans, { recursive: true })
writeFileSync(join(plans, '20260101-0100-甲计划.md'), '# 甲计划\n\n正文甲\n', 'utf8')
writeFileSync(join(plans, '20260102-0200-乙计划.md'), '没有标题行\n\n正文乙\n', 'utf8')

// ── 会话：cwd 钉在 ws（计划的扫盘与 git 的基准目录都看它）─────────────────────────
const sessionDir = join(dsc, 'sessions', ws.replace(/[:\\/]+/g, '-'))
mkdirSync(sessionDir, { recursive: true })
const sessionFile = join(sessionDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000.jsonl')
writeFileSync(
  sessionFile,
  `${JSON.stringify({ type: 'meta', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000', cwd: ws, createdAt: 1 })}\n${JSON.stringify({ type: 'user', text: '探针' })}\n`,
  'utf8',
)

const { createKernel } = await import('../lib/host/kernel.js')
const kernel = await createKernel({ config: {}, resumeSessionPath: sessionFile })

/** 每次读快照前抖一下失效（transcript 监听 `dsc/changed` 清缓存）。 */
const surfaces = () => {
  kernel.emit('dsc/changed')
  return kernel.transcript.getSnapshot().surfaces
}

console.log('[1] Git 读数（dock git-status 的 stats 档）')
{
  const full = await kernel.get('dock').handle('git-status', { stats: true })
  check('增删行数：加 3 删 1', full.added === 3 && full.removed === 1, JSON.stringify(full))
  // 三条脏：a.txt（改动）、new.txt（未跟踪）、.dsc/（计划文件的目录，porcelain 把整个
  // 未跟踪目录记一条）——计划目录的种子就落在这个仓库里，这条断言顺带钉住这个口径。
  check('脏文件数含未跟踪（a.txt / new.txt / .dsc 各一条）', full.dirtyFileCount === 3, JSON.stringify(full))
  check('分支名是真名（不是「(无提交)」）', typeof full.branch === 'string' && full.branch !== '' && full.branch !== '(无提交)', full.branch)
  const lean = await kernel.get('dock').handle('git-status', {})
  check('不传 stats 就不算增删（Git 页签那条路不多跑一条 git）', lean.added === undefined && lean.removed === undefined)
}

console.log('[2] 计划目录（plan 贡献 planDirectory）')
{
  const dir = surfaces().planDirectory
  check('两份都在、最新在前', Array.isArray(dir) && dir.length === 2 && dir[0].title === '没有标题行' && dir[1].title === '甲计划', JSON.stringify(dir.map((plan) => plan.title)))
  check('标题取首个 # 标题 / 首个非空行', dir[1].title === '甲计划' && dir[0].title === '没有标题行')
  check('带绝对路径与 mtime', dir.every((plan) => plan.file.endsWith('.md') && plan.at > 0))
}

console.log('[3] 后台活（tools-default 贡献 backgroundWorks + stopBackground）')
{
  const bash = kernel.tools.list().find((tool) => tool.name === 'bash')
  const runCtx = { cwd: ws, sessionId: 'probe', signal: new AbortController().signal }
  const launched = await bash.run({ command: 'node -e "setTimeout(()=>{}, 60000)"', run_in_background: true }, runCtx)
  check('bash 转后台给出 job id', /job-\d+/.test(launched), launched)
  let works = surfaces().backgroundWorks
  check('后台作业进清单（标题 = 命令首行）', works.length === 1 && works[0].kind === 'job' && works[0].title.includes('setTimeout'), JSON.stringify(works))
  const stopped = await kernel.ui.stopBackground(works[0].id)
  check('stopBackground 收掉后清单为空', surfaces().backgroundWorks.length === 0, stopped)

  const terminal = kernel.tools.list().find((tool) => tool.name === 'terminal')
  const opened = await terminal.run({ action: 'open' }, runCtx)
  const termId = /term-\d+/.exec(opened)?.[0] ?? ''
  await terminal.run({ action: 'send', session_id: termId, data: 'echo hi\n' }, runCtx)
  works = surfaces().backgroundWorks
  check('终端会话进清单（标题取最近发进去的一条命令）', termId !== '' && works.length === 1 && works[0].kind === 'terminal' && works[0].title.includes('echo hi'), JSON.stringify(works))
  await kernel.ui.stopBackground(termId)
  check('终端会话收掉后清单为空', surfaces().backgroundWorks.length === 0)
}

console.log('[4] 定点任务（schedule 贡献 scheduled，「工作流」区）')
{
  const schedule = kernel.tools.list().find((tool) => tool.name === 'schedule')
  check('schedule 插件按条目树打开了（工具在册）', schedule !== undefined)
  const runCtx = { cwd: ws, sessionId: 'probe', signal: new AbortController().signal }
  await schedule.run({ action: 'create', title: '探针任务', prompt: '探针', rule: 'every:30m' }, runCtx)
  const scheduled = surfaces().scheduled
  check(
    '任务进了「工作流」面（标题 + 下次运行时刻 + 启用态）',
    Array.isArray(scheduled) && scheduled.length === 1 && scheduled[0].title === '探针任务' && typeof scheduled[0].nextRunAt === 'number' && scheduled[0].enabled === true,
    JSON.stringify(scheduled),
  )
}

console.log('')
if (failures === 0) {
  console.log('状态面板数据面电池：全部通过')
} else {
  console.log(`状态面板数据面电池：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
}
process.exit(failures === 0 ? 0 : 1)
