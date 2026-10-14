/**
 * 状态面板四组新数据面的宿主侧端到端探针（真内核 + 真 git 仓库 + 真后台作业）。
 *
 * 为什么单开一条电池：`ui-status-panel-test.mjs` 钉的是壳侧纯逻辑与文本形态；
 * 「宿主到底算不算得出这些数」只有把真内核起起来才验得了——git 的增删行数、
 * 计划目录的会话账（提交→批/拒→入账→切会话不可见）、后台作业 / 终端会话
 * 按会话进出清单与收掉、**只读输出面（readBackground：读作业/终端输出 + 归属校验 +
 * 读口不抢模型增量游标）**、定点任务进「工作流」面、**空仓库（HEAD 未出生）里的
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

/** 轮询等一个异步条件成立（给后台输出一点落定时间；也允许条件是 async）。 */
const pollUntil = async (fn, ms = 5000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
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

// ── 普通目录（不是 git 仓库）：git 面该给 `repo: false`，界面据此整行不画分支钮 ─────
const wsPlain = join(home, 'plain')
mkdirSync(wsPlain, { recursive: true })
writeFileSync(join(wsPlain, 'notes.txt'), 'plain\n', 'utf8')
const sessionPlain = join(sessionDir, 'eeeeeeee-ffff-0000-1111-222233334444.jsonl')
writeFileSync(
  sessionPlain,
  `${JSON.stringify({ type: 'meta', id: 'eeeeeeee-ffff-0000-1111-222233334444', cwd: wsPlain, createdAt: 5 })}\n${JSON.stringify({ type: 'user', text: '普通目录会话' })}\n`,
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
  // 未跟踪的 new.txt（一行）也计入增删：tracked 的 a.txt 加 3 删 1，加上未跟踪的 1 行 = 加 4 删 1。
  check('增删行数含未跟踪：加 4（a.txt 的 3 + new.txt 的 1）删 1', full.added === 4 && full.removed === 1, JSON.stringify({ added: full.added, removed: full.removed }))
  check(
    '每文件行数分档：未暂存 a.txt +3/−1',
    full.unstagedStats['a.txt']?.added === 3 && full.unstagedStats['a.txt']?.removed === 1,
    JSON.stringify(full.unstagedStats),
  )
  check(
    '未跟踪逐文件行数：new.txt +1/−0',
    full.untrackedStats['new.txt']?.added === 1 && full.untrackedStats['new.txt']?.removed === 0,
    JSON.stringify(full.untrackedStats),
  )
  // 三条脏：a.txt（改动）、new.txt（未跟踪）、.dsc/（计划文件的目录，porcelain 把整个
  // 未跟踪目录记一条）——计划目录的种子就落在这个仓库里，这条断言顺带钉住这个口径。
  check('脏文件数含未跟踪（a.txt / new.txt / .dsc 各一条）', full.dirtyFileCount === 3, JSON.stringify(full))
  check(
    '目录折叠条目保留（`.dsc/` 在未跟踪里、行数 0）',
    full.untracked.includes('.dsc/') && (full.untrackedStats['.dsc/']?.added ?? 0) === 0,
    JSON.stringify(full.untracked),
  )
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
  // 只读输出面：readBackground 读终端会话的输出（归属校验同 stop；返回带 atEnd / 丢字字段）。
  await pollUntil(async () => (await kernel.ui.readBackground(termId)).text.includes('hi'))
  const termOut = await kernel.ui.readBackground(termId)
  check(
    'readBackground 读终端输出非空（kind/status/atEnd/丢字字段都在）',
    termOut.kind === 'terminal' &&
      termOut.text.includes('hi') &&
      termOut.status === 'running' &&
      typeof termOut.atEnd === 'boolean' &&
      typeof termOut.totalChars === 'number' &&
      termOut.droppedChars === 0,
    JSON.stringify(termOut),
  )
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
  check(
    '空仓库的增删行数把未跟踪计入（中文名 3 行 + big.txt 那 1 行）',
    status.added === 4 && status.removed === 0,
    JSON.stringify({ added: status.added, removed: status.removed }),
  )
  check(
    '未跟踪逐文件行数（≤1MiB 才数）：中文名 3 行、big.txt 1 行；二进制/空文件 0 行出局',
    status.untrackedStats['中文 名.txt']?.added === 3 &&
      status.untrackedStats['big.txt']?.added === 1 &&
      !status.untracked.includes('bin.dat') &&
      !status.untracked.includes('empty.txt'),
    JSON.stringify({ untracked: status.untracked, stats: status.untrackedStats }),
  )

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
  check(
    '暂存后增删行数算得出来（已暂存 3 行 + 仍在未跟踪的 big.txt 1 行）',
    after.added === 4 && after.removed === 0,
    JSON.stringify({ added: after.added, removed: after.removed }),
  )
  check('已暂存段每文件行数（中文名 +3）', after.stagedStats['中文 名.txt']?.added === 3, JSON.stringify(after.stagedStats))
  check('已暂存分组里有它（`A` 前缀 + 原样路径）', after.staged.some((line) => line.startsWith('A ') && line.includes('中文 名.txt')), JSON.stringify(after.staged))
  check('暂存后它不再算未跟踪', !after.untracked.includes('中文 名.txt'), JSON.stringify(after.untracked))

  await session.open(sessionFile)
}

console.log('[6] 会话目录是仓库子目录：路径基准 rebase + 只看 cwd 之内')
{
  const session = kernel.get('session')
  const dock = kernel.get('dock')

  // 一个仓库，会话 cwd 钉在它的 sub/ 子目录：仓库根那侧的改动在 cwd 之外、必须被过滤，
  // sub/ 里的改动与未跟踪文件才算数。
  const wsRepo = join(home, 'ws-sub')
  mkdirSync(join(wsRepo, 'sub'), { recursive: true })
  const gitSub = (...args) => execFileSync('git', args, { cwd: wsRepo, stdio: 'pipe', windowsHide: true })
  gitSub('init', '-q')
  gitSub('config', 'user.email', 'probe@local')
  gitSub('config', 'user.name', 'probe')
  writeFileSync(join(wsRepo, 'root.txt'), 'root\n', 'utf8')
  writeFileSync(join(wsRepo, 'sub', 'inner.txt'), 'one\ntwo\n', 'utf8')
  gitSub('add', '-A')
  gitSub('commit', '-qm', 'init')
  // 仓库根那侧改一处（cwd 之外）+ 子目录里改一处、加一个未跟踪文件
  writeFileSync(join(wsRepo, 'root.txt'), 'root\nchanged-outside\n', 'utf8')
  writeFileSync(join(wsRepo, 'sub', 'inner.txt'), 'one\nTWO\nthree\n', 'utf8')
  writeFileSync(join(wsRepo, 'sub', 'newfile.txt'), 'fresh\nlines\n', 'utf8')

  const sessionSub = join(sessionDir, 'dddddddd-eeee-ffff-0000-111122223333.jsonl')
  writeFileSync(
    sessionSub,
    `${JSON.stringify({ type: 'meta', id: 'dddddddd-eeee-ffff-0000-111122223333', cwd: join(wsRepo, 'sub'), createdAt: 4 })}\n${JSON.stringify({ type: 'user', text: '子目录会话' })}\n`,
    'utf8',
  )
  await session.open(sessionSub)

  const status = await dock.handle('git-status', { stats: true })
  check(
    '展示路径 rebase 到 cwd 相对（是 inner.txt，不是 sub/inner.txt）',
    status.unstaged.some((line) => line.endsWith('inner.txt')) && !status.unstaged.some((line) => line.includes('sub/')),
    JSON.stringify(status.unstaged),
  )
  check('cwd 之外的仓库改动整条过滤（root.txt 不出现）', !JSON.stringify(status).includes('root.txt'), JSON.stringify(status))
  check(
    '每文件行数按 cwd 相对路径给（inner.txt +2/−1）',
    status.unstagedStats['inner.txt']?.added === 2 && status.unstagedStats['inner.txt']?.removed === 1,
    JSON.stringify(status.unstagedStats),
  )
  check('子目录里的未跟踪文件数得出行数（newfile.txt +2）', status.untrackedStats['newfile.txt']?.added === 2, JSON.stringify(status.untrackedStats))

  // 点未跟踪行：合成预览出得来（以前拿仓库相对路径会撞上 inside 边界、报「读不到这个条目」）
  const one = await dock.handle('git-diff', { file: 'newfile.txt' })
  check('点 cwd 里的未跟踪行：合成出全是新增行的段（不再「读不到这个条目」）', one.diff.includes('+++ b/newfile.txt') && one.diff.includes('+fresh'), one.diff.slice(0, 160))
  const t = await dock.handle('git-diff', { file: 'inner.txt' })
  check('点 tracked 行：出得来该文件的 diff（cwd 相对路径作 pathspec，git 按 cwd 解释）', t.diff.includes('+TWO') && t.diff.includes('-two'), t.diff.slice(0, 200))
  const all = await dock.handle('git-diff', {})
  check('「全部改动」也限定在 cwd 之内（不带 cwd 外的 root.txt 改动）', all.diff.includes('inner.txt') && !all.diff.includes('root.txt'), all.diff.slice(0, 200))

  await session.open(sessionFile)
}

console.log('[7] 后台活输出面（readBackground：只读快照 + 归属校验 + 不动模型增量游标）')
{
  const session = kernel.get('session')
  const sid = session.current().meta.id
  const runCtx = { cwd: ws, sessionId: sid, signal: new AbortController().signal }
  const bash = kernel.tools.list().find((tool) => tool.name === 'bash')
  const outTool = kernel.tools.list().find((tool) => tool.name === 'job_output')

  const launched = await bash.run({ command: 'node -e "console.log(\'job-hello-output\')"', run_in_background: true }, runCtx)
  const jobId = /job-\d+/.exec(launched)?.[0] ?? ''
  check('会吐输出的后台作业起得来', jobId !== '', launched.slice(0, 40))

  // 模拟界面按秒轮询：读几拍，读口不该动模型的增量游标。
  await pollUntil(async () => (await kernel.ui.readBackground(jobId)).text.includes('job-hello-output'))
  await kernel.ui.readBackground(jobId)
  const view = await kernel.ui.readBackground(jobId)
  check(
    'readBackground 读作业输出非空（kind = job，带 atEnd / 头部丢字字段）',
    view.kind === 'job' &&
      view.text.includes('job-hello-output') &&
      typeof view.atEnd === 'boolean' &&
      view.droppedChars === 0 &&
      typeof view.totalChars === 'number',
    JSON.stringify(view),
  )
  // peek 不动 lastRead：界面读过之后，模型的 job_output 仍能从头上读到全文。
  const modelRead = await outTool.run({ job_id: jobId }, runCtx)
  check('读口不抢模型的增量游标（模型 job_output 仍读到输出）', modelRead.includes('job-hello-output'), modelRead.slice(0, 120))

  // 归属校验：别的会话起的活读不了（与 stop 同口径）；陌生 id 也拒（不静默给空）。
  const foreignText = await bash.run({ command: 'node -e "setTimeout(()=>{}, 60000)"', run_in_background: true }, { ...runCtx, sessionId: 'other-session' })
  const foreignId = /job-\d+/.exec(foreignText)?.[0] ?? ''
  let refused = ''
  try {
    await kernel.ui.readBackground(foreignId)
  } catch (error) {
    refused = String(error)
  }
  check('readBackground 读别的会话的活被拒', refused.includes('别的会话'), refused)
  let unknown = ''
  try {
    await kernel.ui.readBackground('job-99999')
  } catch (error) {
    unknown = String(error)
  }
  check('readBackground 读陌生 id 报错', unknown !== '', unknown)

  await kernel.ui.stopBackground(jobId)
  await kernel.tools.list().find((tool) => tool.name === 'job_kill').run({ job_id: foreignId }, runCtx)
}

console.log('[8] git 快照面（surfaces.git）+ 分支清单 / 切分支 / 建分支')
{
  const session = kernel.get('session')
  const dock = kernel.get('dock')
  const approval = kernel.get('approval')
  const gitWs = (...args) => execFileSync('git', args, { cwd: ws, stdio: 'pipe', windowsHide: true })
  const gitHead = () => gitWs('rev-parse', '--abbrev-ref', 'HEAD').toString().trim()

  await session.open(sessionFile)
  const policy0 = approval.policy
  const branch0 = gitHead()

  // 「有界面才拍」那条链：第一次读这一片只顺手催一拍（界面刚连上的那一拍），
  // 所以首读拿到的是空读数，几拍之后才是真读数——这条断言钉的就是这个行为。
  const first = surfaces()
  check(
    'git 面在场（键在 surfaces 里，不是缺席）',
    typeof first.git === 'object' && first.git !== null && typeof first.git.repo === 'boolean',
    JSON.stringify(first.git),
  )
  const arrived = await pollUntil(() => surfaces().git.repo === true, 2500)
  check('界面一读就催一拍：读数立刻到位（不是等 5 秒的巡检那一档）', arrived, JSON.stringify(surfaces().git))

  const mine = surfaces().git
  // 与「状态面板那条读」对齐要带上 `stats: true`：改动条数只在那一档里给（轻读那档
  // 只回 staged/unstaged/untracked 三段）。
  const status = await dock.handle('git-status', { stats: true })
  check('分支名与 git-status 一致', mine.branch === status.branch, `${mine.branch} vs ${status.branch}`)
  check(
    '改动计数与 git-status 同一口径（含未跟踪，且只看 cwd 之内）',
    mine.dirtyFileCount === status.dirtyFileCount,
    `${String(mine.dirtyFileCount)} vs ${String(status.dirtyFileCount)}`,
  )
  check('detached = false（HEAD 挂在分支上）', mine.detached === false, JSON.stringify(mine))

  // 分支清单：多造一条，清单该有两条、当前那条排第一
  gitWs('branch', 'probe-side')
  const list = await dock.handle('git-branches', {})
  check(
    '清单回 current / detached / branches 三件',
    typeof list.current === 'string' && list.detached === false && Array.isArray(list.branches),
    JSON.stringify(list),
  )
  check('本地两条分支都在清单里', list.branches.length === 2, JSON.stringify(list.branches))
  check(
    '当前分支排第一且标 current（菜单展开就在眼前）',
    list.branches[0].current === true && list.branches[0].name === list.current && list.branches[0].name === branch0,
    JSON.stringify(list.branches),
  )
  check('另一条 current = false', list.branches[1].current === false && list.branches[1].name === 'probe-side', JSON.stringify(list.branches))

  // 只读档：切分支是写类 op，**当场拒**（不是挂一张卡等人答）——安全闸门在这条路上同样成立
  approval.setPolicy('readonly')
  let denied = ''
  try {
    await dock.handle('git-checkout', { branch: 'probe-side' })
  } catch (error) {
    denied = String(error)
  }
  check('只读档下切分支被拒（写类 op 过审批闸）', denied.includes('已拒绝'), denied)
  check('被拒之后工作区没动', gitHead() === branch0, gitHead())

  // 完全访问：真切成立，且快照面自己跟上（写类 op 落盘后那一次催拍）
  approval.setPolicy('full-access')
  const switched = await dock.handle('git-checkout', { branch: 'probe-side' })
  check('切分支回 ok + 分支名', switched.ok === true && switched.branch === 'probe-side', JSON.stringify(switched))
  check('工作区真的切过去了', gitHead() === 'probe-side', gitHead())
  const followed = await pollUntil(() => surfaces().git.branch === 'probe-side', 8000)
  check('切完快照面自己跟上（催拍那条路，不必等下一个 12 秒）', followed, JSON.stringify(surfaces().git))

  // 建分支并切过去
  const created = await dock.handle('git-branch-create', { branch: 'probe-fresh' })
  check('建分支回 ok + 名字', created.ok === true && created.branch === 'probe-fresh', JSON.stringify(created))
  check('工作区在新建的那条上', gitHead() === 'probe-fresh', gitHead())
  const created2 = await pollUntil(() => surfaces().git.branch === 'probe-fresh', 8000)
  check('新建的分支也上了快照面', created2, JSON.stringify(surfaces().git))
  check('新分支进了清单（三条）', (await dock.handle('git-branches', {})).branches.length === 3)

  // 收拾：切回原分支（顺带断言切回来这条路），策略还原
  await dock.handle('git-checkout', { branch: branch0 })
  check('切回原分支也成', gitHead() === branch0, gitHead())
  approval.setPolicy(policy0)

  // 不是仓库的工作目录：面回 repo:false（界面据此整行不画），清单给空表而不是抛错
  await session.open(sessionPlain)
  await pollUntil(() => surfaces().git.repo === false, 8000)
  check('非仓库：面里 repo = false（界面整行不画）', surfaces().git.repo === false, JSON.stringify(surfaces().git))
  const plainList = await dock.handle('git-branches', {})
  check('非仓库里读分支清单：空表 + 不抛', plainList.branches.length === 0 && plainList.current === '', JSON.stringify(plainList))
  await session.open(sessionFile)
}

console.log('')
if (failures === 0) {
  console.log('状态面板数据面电池：全部通过')
} else {
  console.log(`状态面板数据面电池：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
}
process.exit(failures === 0 ? 0 : 1)
