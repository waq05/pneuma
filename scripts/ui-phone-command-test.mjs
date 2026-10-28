/**
 * 手机端（remote-web）输入框 `/` 命令菜单的探针。
 *
 * 为什么单开一条：手机界面是**另一个 React 应用**，与桌面壳不共用产物，命令菜单是新
 * 加的一块——「菜单里有什么」「选完填什么」「发送时当命令还是当消息」这三件事都在
 * `remote-web/src/lib/commands.ts` 里，纯函数，直接跑真实现（Node 直读 .ts）。
 *
 * 修的是现成的错：以前手机上打 `/compact` 会被当成普通消息发给模型（宿主那边只认
 * `runUiCommand` 这条道）。所以这里也钉住「发送前的分流」。
 *
 * 用法：node scripts/ui-phone-command-test.mjs
 *
 * @module dsc/scripts/ui-phone-command-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { commandQueryAt, filterCommands, insertCommand, commandToRun } = await import(
  new URL('../remote-web/src/lib/commands.ts', import.meta.url).href
)

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let passed = 0
let failed = 0

/**
 * 记一条断言。
 *
 * @param {string} name 断言名
 * @param {boolean} ok 是否通过
 * @param {string} detail 失败时的读数
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ok  ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${name}${detail === '' ? '' : `  <- ${detail}`}`)
}

/** 宿主那份清单的迷你版（真的形状：name / args / description / label / duringTask）。 */
const COMMANDS = [
  { name: 'new', args: '', description: '新建一个空会话', label: '新会话', duringTask: 'deny' },
  { name: 'compact', args: '', description: '压缩以上对话内容', label: '压缩', duringTask: 'deny' },
  { name: 'diff', args: '[文件]', description: '查看工作区未提交改动', label: '差异', duringTask: 'allow' },
  { name: 'review', args: '[关注点]', description: '审查工作区未提交改动', label: '代码审查', duringTask: 'allow' },
  { name: 'resume', args: '', description: '恢复历史会话', label: '恢复会话', duringTask: 'deny' },
]

console.log('\n[1] 命令位判定（与桌面壳同一套口径）')
{
  check('打 / 就是在找命令（空前缀）', commandQueryAt('/', 1) === '', String(commandQueryAt('/', 1)))
  check('打了一半给查询词（小写）', commandQueryAt('/RE', 3) === 're', String(commandQueryAt('/RE', 3)))
  check('打了空格进参数阶段，菜单收起', commandQueryAt('/diff src', 9) === null, String(commandQueryAt('/diff src', 9)))
  check('普通消息不算命令位', commandQueryAt('看看 /diff', 9) === null, String(commandQueryAt('看看 /diff', 9)))
  check('光标在 / 左边不算', commandQueryAt('/d', 0) === null, String(commandQueryAt('/d', 0)))
}

console.log('\n[2] 过滤（前缀，保持原序）')
{
  const all = filterCommands(COMMANDS, '')
  check('空前缀列全部', all.length === 5, String(all.length))
  const re = filterCommands(COMMANDS, 're')
  check('/re 命中 review 与 resume', JSON.stringify(re.map((row) => row.name)) === JSON.stringify(['review', 'resume']), JSON.stringify(re.map((row) => row.name)))
  check('大小写不敏感', filterCommands(COMMANDS, 'RE').length === 2, String(filterCommands(COMMANDS, 'RE').length))
  check('负向对照：子串不算（view 不该命中 review）', filterCommands(COMMANDS, 'view').length === 0, String(filterCommands(COMMANDS, 'view').length))
}

console.log('\n[3] 采纳：无参数不带空格，有参数补一个')
{
  const newCmd = COMMANDS.find((command) => command.name === 'new')
  const diff = COMMANDS.find((command) => command.name === 'diff')
  check('/new（无参数）', insertCommand(newCmd) === '/new', JSON.stringify(insertCommand(newCmd)))
  check('/diff（有参数补空格）', insertCommand(diff) === '/diff ', JSON.stringify(insertCommand(diff)))
}

console.log('\n[4] 发送前的分流：命令 vs 消息')
{
  check('精确命令名当命令跑', commandToRun('/compact', COMMANDS) === '/compact', String(commandToRun('/compact', COMMANDS)))
  check('带参数整条交给宿主', commandToRun('/diff lib/a.ts', COMMANDS) === '/diff lib/a.ts', String(commandToRun('/diff lib/a.ts', COMMANDS)))
  check('唯一前缀展开（/co → /compact）', commandToRun('/co', COMMANDS) === '/compact', String(commandToRun('/co', COMMANDS)))
  check('前缀撞名不猜（/re 有两条）', commandToRun('/re', COMMANDS) === null, String(commandToRun('/re', COMMANDS)))
  check('普通消息不拦', commandToRun('帮我看下 /diff 是什么意思', COMMANDS) === null, String(commandToRun('帮我看下 /diff 是什么意思', COMMANDS)))
  check('清单外的名字不当命令（失败关闭）', commandToRun('/exit', COMMANDS) === null, String(commandToRun('/exit', COMMANDS)))
  check('只有斜杠不算命令', commandToRun('/', COMMANDS) === null, String(commandToRun('/', COMMANDS)))
}

console.log('\n[5] 接线（菜单画在哪、命令发给谁）')
{
  const composer = read('remote-web/src/components/Composer.tsx')
  check('输入框上方画菜单', composer.includes('<CommandMenu rows={commandRows}'))
  check('回车先归菜单（候选没选完不会把半条命令发出去）', composer.includes("if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing)"))
  check('Esc 收起并记住这个前缀', composer.includes('setMutedFor(commandQuery)'))
  const page = read('remote-web/src/pages/ChatPage.tsx')
  check('清单从宿主取（listUiCommands）', page.includes("invoke<PhoneCommandView[]>('listUiCommands')"))
  check('连上才取一次（断线时别反复问）', page.includes("if (state.conn !== 'open') return"))
  check('命令走 runUiCommand，消息走 submit', page.includes("invoke<boolean>('runUiCommand', [command])") && page.includes('client.submit(text'))
  // 口径与桌面壳对齐：`/` 开头的一律进命令通道（认不出由宿主回一句人话），不按「能不能
  // 匹配上清单」决定要不要当消息发——否则 /re、拼错的 /comapct 又会被喂给模型。
  check('认不出的一律走命令通道（按前缀判，不按清单）', page.includes("if (text.trim().startsWith('/'))"))
  check('带附件时当场拒绝并保住输入（返回 false）', page.includes('这条命令不接受附件') && page.includes('return false'))
  check('错误条不再只画在待办卡里（常显）', /\{cardError !== null \? <p className="pendingcard-error">/.test(read('remote-web/src/pages/ChatPage.tsx')))
  const composerSend = read('remote-web/src/components/Composer.tsx')
  check('发送被拒时不清空输入与附件', composerSend.includes('if (!onSend(outgoing, images, paths)) return'))
  const css = read('remote-web/src/styles.css')
  check(
    '样式类齐（浮层 / 分组 / 行 / 图标 / 中文名 / 英文名 / 说明）',
    ['cmd-pop', 'cmd-section', 'cmd-item', 'cmd-icon', 'cmd-label', 'cmd-name', 'cmd-desc'].every((cls) => css.includes(`.${cls}`)),
  )
  check('说明右对齐（所有行收在同一条右边缘）', /\.cmd-desc \{[^}]*text-align: right/s.test(css))
}

console.log(`\n${String(passed)}/${String(passed + failed)} 通过`)
process.exit(failed === 0 ? 0 : 1)
