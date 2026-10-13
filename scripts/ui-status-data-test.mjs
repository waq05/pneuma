/**
 * 状态面板四组新数据面的宿主侧端到端探针（真内核 + 真 git 仓库 + 真后台作业）。
 *
 * 为什么单开一条电池：`ui-status-panel-test.mjs` 钉的是壳侧纯逻辑与文本形态；
 * 「宿主到底算不算得出这些数」只有把真内核起起来才验得了——git 的增删行数、
 * 计划目录的会话账（提交→批/拒→入账→切会话不可见）、后台作业 / 终端会话
 * 按会话进出清单与收掉、定点任务进「工作流」面、**空仓库（HEAD 未出生）里的
 * diff 与未跟踪合成预览**。
 *
 * 隔离：临时 HOME + 临时工作区（真 `git init` 的仓库），不碰真实 ~/.dsc。
 *
 * 运行：node scripts/ui-status-data-test.mjs（先 pnpm build）
 *
 * @module dsc/scripts/ui-status-data-test
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

// ── 工作区里一份「更早留下的」计划文件：面板不再扫盘，它不该出现在目录里
//    （git 的脏文件口径也靠它：`.dsc/` 这个未跟踪目录被 porcelain 记一条）──────────
const plans = join(ws, '.dsc', 'plans')
mkdirSync(plans, { recursive: true })
writeFileSync(join(plans, '20260101-0100-旧文件.md'), '# 旧文件\n\n更早留下的，不属于任何会话\n', 'utf8')

// ── 会话：cwd 钉在 ws（账号的基准目录与 git 的基准目录都看它）─────────────────────
const sessionDir = join(dsc, 'sessions', ws.replace(/[:\\/]+/g, '-'))
mkdirSync(sessionDir, { recursive: true })
const sessionFile = join(sessionDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000.jsonl')
writeFileSync(
  sessionFile,
  `${JSON.stringify({ type: 'meta', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000', cwd: ws, createdAt: 1 })}\n${JSON.stringify({ type: 'user', text: '探针' })}\n`,
  'utf8',
)
// 另一个会话（B）：什么都没有——「切会话互不可见」的对照物
const sessionB = join(sessionDir, 'bbbbbbbb-cccc-dddd-eeee-ffff00001111.jsonl')
writeFileSync(
  sessionB,
  `${JSON.stringify({ type: 'meta', id: 'bbbbbbbb-cccc-dddd-eeee-ffff00001111', cwd: ws, createdAt: 2 })}\n${JSON.stringify({ type: 'user', text: '另一个会话' })}\n`,
  'utf8',
)

// ── 第二个工作区：`git init` 之后一次没提交（HEAD 未出生）。用户报障现场的复刻：
//    没有 HEAD 时 `git diff HEAD` 直接报「ambiguous argument 'HEAD'」，面板上就是那段
//    原始 fatal；未跟踪的条目又都没有 diff，于是「一点都看不到改动」。────────────
const wsNone = join(home, 'ws-none')
mkdirSync(join(wsNone, 'sub'), { recursive: true })
const gitNone = (...args) => execFileSync('git', args, { cwd: wsNone, stdio: 'pipe', windowsHide: true })
gitNone('init', '-q')
writeFileSync(join(wsNone, '中文 名.txt'), 'one\ntwo\nthree\n', 'utf8')
writeFileSync(join(wsNone, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42, 0x43]), 'utf8')
writeFileSync(join(wsNone, 'big.txt'), `${'x'.repeat(600 * 1024)}\n`, 'utf8')
writeFileSync(join(wsNone, 'empty.txt'), '', 'utf8')
writeFileSync(join(wsNone, 'sub', 'inner.txt'), 'inner\n', 'utf8')
// 会话 C：cwd 钉在 ws-none（同样不提交——「没有 HEAD」这半边也一起复刻）
const sessionC = join(sessionDir, 'cccccccc-dddd-eeee-ffff-000011112222.jsonl')
writeFileSync(
  sessionC,
  `${JSON.stringify({ type: 'meta', id: 'cccccccc-dddd-eeee-ffff-000011112222', cwd: wsNone, createdAt: 3 })}\n${JSON.stringify({ type: 'user', text: '空仓库会话' })}\n`,
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

console.log('[2] 计划目录（plan 贡献 planDirectory：会话账驱动，不扫盘）')
{
  const plan = kernel.get('plan')
  const session = kernel.get('session')
  const sess = session.current()
  const runCtx = { cwd: ws, sessionId: sess.meta.id, sessionPath: sess.filePath, signal: new AbortController().signal }
  /** 探针里的小等待：异步路径（工具先落盘再提卡、写流落盘）给到就返 true。 */
  const waitFor = async (fn, ms = 3000) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (fn()) return true
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return false
  }

  // 第一份：真走 exit_plan_mode 工具（落盘 + 提卡），批准后入账
  const exitTool = kernel.tools.list().find((tool) => tool.name === 'exit_plan_mode')
  const first = exitTool.run({ plan: '# 甲计划\n\n正文甲\n' }, runCtx)
  check('exit_plan_mode 提卡后挂起（待批）', await waitFor(() => plan.pendingPlan() !== null))
  check('待批的那份不进目录', surfaces().planDirectory.length === 0)
  const landed = readdirSync(plans).filter((name) => name !== '20260101-0100-旧文件.md')
  check('工具真的把计划落盘（.dsc/plans 下出现新文件）', landed.length === 1, JSON.stringify(landed))
  plan.answerPlan('approved')
  const firstText = await first
  check('批准后：工具结果说已批准', firstText.includes('已批准'), firstText.slice(0, 60))
  let dir = surfaces().planDirectory
  check(
    '批准后进目录（标题 = 提交时算的标题、带绝对路径）',
    dir.length === 1 && dir[0].title === '甲计划' && dir[0].file.endsWith('.md') && dir[0].at > 0,
    JSON.stringify(dir),
  )
  check('工作区里更早留下的计划文件不进目录（面板不扫盘）', dir.every((item) => !item.file.includes('旧文件')))

  // 第二份：服务路径提一份「没有对应文件」的计划（账独立于落盘文件），拒绝也入账
  await new Promise((resolve) => setTimeout(resolve, 5))
  const ghost = join(plans, '不存在的第二份.md')
  const second = plan.proposePlan({ file: ghost, title: '乙计划', text: '没有标题行\n\n正文乙\n' }, new AbortController().signal)
  plan.answerPlan('rejected', '再想想')
  check('被拒的结果原样回给提交方', (await second) === 'rejected')
  dir = surfaces().planDirectory
  check(
    '被拒的也进目录、最新在前',
    dir.length === 2 && dir[0].title === '乙计划' && dir[1].title === '甲计划',
    JSON.stringify(dir.map((item) => item.title)),
  )
  check('账不依赖落盘文件（第二份没有对应文件）', dir[0].file === ghost && !existsSync(ghost))

  // 落盘证据：账写进会话 jsonl 的 plans 状态条目。两条都等到（写流 flush 是异步的：
  // 切会话会以磁盘重放重建实例，不等落定就切会读到旧快照——真实用户的手速天然等得起，
  // 探针连续切换不带延迟会撞上那个窄窗口，所以这里按真实节奏等）。
  const plansLines = () => {
    try {
      return (readFileSync(sessionFile, 'utf8').match(/"id":"plans"/g) ?? []).length
    } catch {
      return 0
    }
  }
  check('两条账都落进会话 jsonl（plans 状态条目）', await waitFor(() => plansLines() >= 2), `plans 行数=${String(plansLines())}`)

  // 按会话：切到另一个会话看不见这份账，切回来又在了（账在会话日志里）
  await session.open(sessionB)
  check('切到别的会话：目录空（账按会话，互不可见）', surfaces().planDirectory.length === 0)
  await session.open(sessionFile)
  check('切回来：目录读回两条（跨恢复都在）', surfaces().planDirectory.length === 2, JSON.stringify(surfaces().planDirectory.map((item) => item.title)))
}

console.log('[3] 后台活（tools-default 贡献 backgroundWorks + stopBackground：按当前会话）')
{
  const session = kernel.get('session')
  const sid = session.current().meta.id
  const other = 'other-session'
  const runCtx = { cwd: ws, sessionId: sid, signal: new AbortController().signal }
  const bash = kernel.tools.list().find((tool) => tool.name === 'bash')
  const launched = await bash.run({ command: 'node -e "setTimeout(()=>{}, 60000)"', run_in_background: true }, runCtx)
  check('bash 转后台给出 job id', /job-\d+/.test(launched), launched)
  let works = surfaces().backgroundWorks
  check('当前会话起的作业进清单（标题 = 命令首行）', works.length === 1 && works[0].kind === 'job' && works[0].title.includes('setTimeout'), JSON.stringify(works))
  // 别的会话起的活：不进当前会话的清单；从面板上也收不走
  const foreignText = await bash.run({ command: 'node -e "setTimeout(()=>{}, 60000)"', run_in_background: true }, { ...runCtx, sessionId: other })
  const foreign = /job-\d+/.exec(foreignText)?.[0] ?? ''
  check('别的会话起的作业确实起了', foreign !== '', foreignText.slice(0, 40))
  check('别的会话起的作业不进清单（按会话过滤）', surfaces().backgroundWorks.length === 1, JSON.stringify(surfaces().backgroundWorks.map((work) => work.id)))
  let refused = ''
  try {
    await kernel.ui.stopBackground(foreign)
  } catch (error) {
    refused = String(error)
  }
  check('stopBackground 收别的会话的活被拒', refused.includes('别的会话'), refused)
  const stopped = await kernel.ui.stopBackground(works[0].id)
  check('stopBackground 收自己的：清单归空', surfaces().backgroundWorks.length === 0, stopped)
  // 外来的那条从工具面收掉（job_kill 是模型/脚本面的口，不看会话归属）
  await kernel.tools.list().find((tool) => tool.name === 'job_kill').run({ job_id: foreign }, runCtx)

  const terminal = kernel.tools.list().find((tool) => tool.name === 'terminal')
  const opened = await terminal.run({ action: 'open' }, runCtx)
  const termId = /term-\d+/.exec(opened)?.[0] ?? ''
  await terminal.run({ action: 'send', session_id: termId, data: 'echo hi\n' }, runCtx)
  works = surfaces().backgroundWorks
  check('终端会话进清单（标题取最近发进去的一条命令）', termId !== '' && works.length === 1 && works[0].kind === 'terminal' && works[0].title.includes('echo hi'), JSON.stringify(works))
  await session.open(sessionB)
  check('切到别的会话：后台活清单为空', surfaces().backgroundWorks.length === 0)
  await session.open(sessionFile)
  check('切回来：终端会话还在清单里', surfaces().backgroundWorks.some((work) => work.id === termId), JSON.stringify(surfaces().backgroundWorks))
  await kernel.ui.stopBackground(termId)
  check('终端会话收掉后清单为空', surfaces().backgroundWorks.length === 0)
}

console.log('[4] 定点任务（schedule 贡献 scheduled，「工作流」区）')
{
  const schedule = kernel.tools.list().find((tool) => tool.name === 'schedule')
  check('schedule 插件按条目树打开了（工具在册）', schedule !== undefined)
  const runCtx = { cwd: ws, sessionId: kernel.get('session').current().meta.id, signal: new AbortController().signal }
  await schedule.run({ action: 'create', title: '探针任务', prompt: '探针', rule: 'every:30m' }, runCtx)
  const scheduled = surfaces().scheduled
  check(
    '任务进了「工作流」面（标题 + 下次运行时刻 + 启用态）',
    Array.isArray(scheduled) && scheduled.length === 1 && scheduled[0].title === '探针任务' && typeof scheduled[0].nextRunAt === 'number' && scheduled[0].enabled === true,
    JSON.stringify(scheduled),
  )
}

console.log('[5] 空仓库（HEAD 未出生）：diff 不报错 + 未跟踪按内容合成')
{
  const session = kernel.get('session')
  const dock = kernel.get('dock')
  await session.open(sessionC)

  const status = await dock.handle('git-status', { stats: true })
  check('空仓库也读得出状态（分支给占位名，不抛）', status.branch === '(无提交)', status.branch)
  check(
    '未跟踪条目原样给（非 ASCII 路径不带 C 引号转义）',
    status.untracked.includes('中文 名.txt'),
    JSON.stringify(status.untracked),
  )
  check('未跟踪的目录整条收录（`sub/`）', status.untracked.includes('sub/'), JSON.stringify(status.untracked))
  check('脏文件数 = 5（4 个文件 + 1 个目录条目）', status.dirtyFileCount === 5, String(status.dirtyFileCount))
  check('空仓库的增删行数不炸（没有可比的东西，就是 0）', status.added === 0 && status.removed === 0, JSON.stringify(status))

  // 全量：tracked 段为空，未跟踪的合成段补上；合成不出来的（二进制 / 过大 / 空 / 目录）报条数
  const all = await dock.handle('git-diff', {})
  check('「全部改动」不再吐 HEAD 的原始报错', typeof all.diff === 'string' && !all.diff.includes('ambiguous argument'), all.diff.slice(0, 120))
  check(
    '未跟踪文件合成出「全是新增行」的段（全 5 条里只有它合成得了）',
    all.diff.includes('+++ b/中文 名.txt') && all.diff.includes('@@ -0,0 +1,3 @@') && all.diff.includes('+one'),
    all.diff.slice(0, 200),
  )
  check('合成不出来的一条条数报在 note 里', all.note.includes('另有 4 个未跟踪条目'), all.note)

  const one = await dock.handle('git-diff', { file: '中文 名.txt' })
  check('单点未跟踪文件：合成 patch（`--- /dev/null` + 新文件头）', one.diff.includes('--- /dev/null') && one.diff.includes('+++ b/中文 名.txt'), one.diff.slice(0, 160))
  check('单点的还是干净的一段（不带 note）', (one.note ?? '') === '')
  const binary = await dock.handle('git-diff', { file: 'bin.dat' })
  check('二进制未跟踪：给说明不出 diff', binary.diff === '' && binary.note.includes('二进制'), JSON.stringify(binary))
  const big = await dock.handle('git-diff', { file: 'big.txt' })
  check('超过 512KB 的未跟踪：给说明不出 diff', big.diff === '' && big.note.includes('512KB'), big.note)
  const empty = await dock.handle('git-diff', { file: 'empty.txt' })
  check('空文件：给说明不出 diff', empty.diff === '' && empty.note.includes('空文件'), empty.note)
  const dir = await dock.handle('git-diff', { file: 'sub/' })
  check('未跟踪目录整条：给说明不出 diff', dir.diff === '' && dir.note.includes('未跟踪目录'), dir.note)

  // tracked 那一半：暂存起来（HEAD 依然没有），单文件 diff 就该走 `diff --cached`
  gitNone('add', '中文 名.txt')
  const staged = await dock.handle('git-diff', { file: '中文 名.txt' })
  check('空仓库里暂存后的单文件 diff 也出得来（无 HEAD 走 `diff --cached`）', staged.diff.includes('+two'), staged.diff.slice(0, 200))
  const after = await dock.handle('git-status', { stats: true })
  check('暂存后增删行数算得出来（加 3）', after.added === 3 && after.removed === 0, JSON.stringify({ added: after.added, removed: after.removed }))
  check('已暂存分组里有它（`A` 前缀 + 原样路径）', after.staged.some((line) => line.startsWith('A ') && line.includes('中文 名.txt')), JSON.stringify(after.staged))
  check('暂存后它不再算未跟踪', !after.untracked.includes('中文 名.txt'), JSON.stringify(after.untracked))

  await session.open(sessionFile)
}

console.log('')
if (failures === 0) {
  console.log('状态面板数据面电池：全部通过')
} else {
  console.log(`状态面板数据面电池：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
}
process.exit(failures === 0 ? 0 : 1)
