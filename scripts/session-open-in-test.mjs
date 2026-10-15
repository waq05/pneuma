/**
 * 「在指定目录里新建会话」的宿主侧端到端探针（真内核 + 两个真目录）。
 *
 * 钉的是与参考实现对齐的那一刀：**目录是会话自己的数据**（写进 jsonl 的 meta 行），
 * 不再是宿主进程的状态——于是「在别的工作区新建会话」只是一次普通调用：不切宿主目录、
 * 不重启宿主、不重载窗口（早先那条路是 switchCwd → 宿主重启 → 整页 loadURL，整个界面
 * 会闪一下，也是这轮报障的形状）。
 *
 * 一起钉住的还有「进程 cwd 不再当数据用」的几处收口（模型终端起进程目录、MCP 起进程
 * 目录、审批的路径基准、外部插件源基准、LSP 命令解析基准）——那几处不改，跨目录会话
 * 会把东西跑到错地方。收口大多以**源码钉**形式验（行为端到端要真起 shell / MCP / LSP，
 * 那是另一条电池的事）。
 *
 * 隔离：临时 HOME + 两个临时工作区，真实 ~/.dsc 一个字节都不动。
 * 运行：node scripts/session-open-in-test.mjs（先 pnpm build）
 *
 * @module dsc/scripts/session-open-in-test
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-open-in-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dsc = join(home, '.dsc')
mkdirSync(dsc, { recursive: true })
// 内核装配要一份能读的 config.yaml；不连真模型
writeFileSync(join(dsc, 'config.yaml'), 'model:\n  name: test\n', 'utf8')

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}
const checkEq = (label, actual, expected) => check(label, actual === expected, `实际 ${String(actual)} ≠ 期望 ${String(expected)}`)

// ── 两个工作区：ws（启动会话在这儿）、wsB（一个字都没有的新工作区）──────────────
const ws = join(home, 'ws')
const wsB = join(home, 'ws-b')
mkdirSync(ws, { recursive: true })
mkdirSync(wsB, { recursive: true })

const { slugCwd, sessionsRoot } = await import('../lib/core/session.js')
const { createKernel } = await import('../lib/host/kernel.js')
const { UI_METHODS, UI_ARG_SPECS, validateUiArgs } = await import('../lib/core/ui-methods.js')

// ── 启动：resume 一条 cwd = ws 的会话（宿主进程自己的 cwd 是别的目录，刻意不同）──
const seedDir = join(sessionsRoot(), slugCwd(ws))
mkdirSync(seedDir, { recursive: true })
const seedFile = join(seedDir, '11111111-2222-3333-4444-555566667777.jsonl')
writeFileSync(
  seedFile,
  `${JSON.stringify({ type: 'meta', id: '11111111-2222-3333-4444-555566667777', cwd: ws, createdAt: 1 })}\n` +
    `${JSON.stringify({ type: 'user', text: '启动那条' })}\n`,
  'utf8',
)
const hostCwd = process.cwd()
const kernel = await createKernel({ config: {}, resumeSessionPath: seedFile })
const runtime = kernel.get('ui')
const session = kernel.get('session')

console.log('\n[1] 启动：会话目录来自会话数据，不是进程目录')
{
  const snap = kernel.transcript.getSnapshot()
  checkEq('快照的当前目录 = 那条会话的目录', snap.status.cwd, ws)
  checkEq('进程 cwd 与会话目录本来就不同（这轮的前提）', snap.status.cwd === hostCwd, false)
  checkEq('resume 的那条没被换掉', session.current().filePath, seedFile)
}

console.log('\n[2] newSessionIn：在另一个目录新建（无重启、进程目录不动）')
{
  const before = process.cwd()
  await runtime.newSessionIn(wsB)
  const after = session.current()
  const snap = kernel.transcript.getSnapshot()
  checkEq('会话的 meta.cwd 落在目标目录', after.meta.cwd, wsB)
  checkEq('jsonl 路径落在目标目录的 slug 子目录下', after.filePath.startsWith(join(sessionsRoot(), slugCwd(wsB))), true)
  checkEq('快照的当前目录跟着变', snap.status.cwd, wsB)
  checkEq('status.sessionPath 与 Session.filePath 同一口径', snap.status.sessionPath, after.filePath)
  checkEq('宿主进程自己的 cwd 没被动过', process.cwd(), before)
  checkEq('老会话仍在（常驻，不是被顶掉）', session.current().filePath !== seedFile, true)
}

console.log('\n[3] 不带目录的新建：落在**当前会话的**目录（参考实现的「当前工作区」口径）')
{
  const current = session.current().meta.cwd
  await runtime.openSession()
  checkEq('落在刚才那条会话的目录里', session.current().meta.cwd, current)
  checkEq('还是那个目录（没滑回进程目录）', session.current().meta.cwd === hostCwd, false)
}

console.log('\n[4] 还没落盘的当前会话在会话列表里（侧栏高亮就靠它）')
{
  const current = session.current()
  await session.refresh() // 壳那条路：newSessionIn 之后接一次 refreshSessions
  const listed = kernel.transcript.getSnapshot().sessions
  const hit = listed.filter((item) => item.id === current.filePath)
  checkEq('列表里有它，且只有一条', hit.length, 1)
  checkEq('那一行的目录就是会话目录', hit[0]?.cwd, current.meta.cwd)
  check('文件还没落盘（这一条是宿主补的，不是扫盘扫出来的）', !existsSync(current.filePath))
  // 落盘之后不该重复出现（同一路径扫盘也会扫到）
  writeFileSync(
    current.filePath,
    `${JSON.stringify({ type: 'meta', id: current.meta.id, cwd: current.meta.cwd, createdAt: current.meta.createdAt })}\n` +
      `${JSON.stringify({ type: 'user', text: '落盘了' })}\n`,
    'utf8',
  )
  await session.refresh()
  const again = kernel.transcript.getSnapshot().sessions.filter((item) => item.id === current.filePath)
  checkEq('落盘后仍然只有一条（补的那条让位给扫盘结果）', again.length, 1)
}

console.log('\n[5] 坏目录：当场抛，且不动当前会话')
{
  const before = session.current().filePath
  const missing = join(home, '没有这个目录')
  let threw = false
  try {
    await runtime.newSessionIn(missing)
  } catch (error) {
    threw = true
    check('错误消息说清是哪个目录不可用', String(error.message).includes('工作目录不可用'), String(error.message))
  }
  check('不存在的目录 → 抛错', threw)
  let threwRelative = false
  try {
    await runtime.newSessionIn('ws-b')
  } catch {
    threwRelative = true
  }
  check('相对路径 → 抛错（不悄悄按进程目录解析）', threwRelative)
  checkEq('两次失败都没换掉当前会话', session.current().filePath, before)
}

console.log('\n[6] 界面通道：白名单 + 实参规格')
{
  check('newSessionIn 在界面通道白名单里', UI_METHODS.includes('newSessionIn'))
  check('实参规格：一个必传字符串（不是可选，也不是可省略）', UI_ARG_SPECS.newSessionIn?.length === 1 && UI_ARG_SPECS.newSessionIn[0].optional !== true)
  check('合法调用过闸', validateUiArgs('newSessionIn', [wsB]).ok === true)
  check('非字符串被拒', validateUiArgs('newSessionIn', [123]).ok === false)
  check('超长被拒', validateUiArgs('newSessionIn', ['x'.repeat(5000)]).ok === false)
  check('一个都不给被拒', validateUiArgs('newSessionIn', []).ok === false)
}

console.log('\n[7] 源码钉：进程 cwd 不再当数据用的那几处')
{
  const read = (p) => readFileSync(join(process.cwd(), p), 'utf8')
  const bash = read('src/core/tools/bash.ts')
  const mcpCore = read('src/core/mcp.ts')
  const mcpPlugin = read('src/plugins/mcp.ts')
  const approval = read('src/plugins/approval.ts')
  const kernel = read('src/host/kernel.ts')
  const manager = read('src/host/kernel.ts') && read('src/plugins/plugin-manager.ts')
  const lspManager = read('src/core/lsp/manager.ts')
  const lspClient = read('src/core/lsp/client.ts')
  const lspPlugin = read('src/plugins/lsp.ts')
  const sessions = read('ui-shell/src/plugins/sessions/ui.tsx')
  const bridge = read('src/core/native-bridge.ts')
  const desktopMain = read('desktop/electron/main/index.ts')
  const runtimeSrc = read('src/plugins/runtime.ts')
  const hostMethods = read('src/core/host-methods.ts')

  // 会话创建的目录参数（服务层）
  const sessionSrc = read('src/plugins/session.ts')
  check('服务层：open(filePath?, cwd?) 按参数建会话', sessionSrc.includes('Session.create(dir ?? startupCwd)'))
  check('服务层：界面给的目录要过「可用」校验', sessionSrc.includes('function usableDir(') && sessionSrc.includes('工作目录不可用'))
  check('服务层：没给目录时退到当前会话的目录', sessionSrc.includes('? usableDir(cwd)') && sessionSrc.includes(": session.meta.cwd !== ''"))

  // 模型终端
  check('模型终端：起进程目录取会话 cwd', bash.includes('table.open(ctx.sessionId, ctx.cwd)') && bash.includes('spawnTerminalShell(cwd ?? \'\')'))
  // MCP
  check('MCP：起进程目录有兜底参数（不再是进程目录）', mcpCore.includes('function spawnStdio(server: McpServerConfig, fallbackCwd: string)') && mcpCore.includes("const dir = server.cwd !== '' ? server.cwd : fallbackCwd"))
  check('MCP：插件层把会话目录交给连接', mcpPlugin.includes('cwd: sessionCwd(),') && mcpPlugin.includes('function sessionCwd()'))
  check('MCP：elicitation 卡不再传空目录', !mcpPlugin.includes("cwd: '',"))
  // 审批
  check('审批：路径基准退到当前会话（不是进程目录）', approval.includes('const baseCwd = (request: ApprovalRequest): string =>') && approval.includes('const cwd = baseCwd(request)'))
  check('审批：源码里不再拿进程目录当兜底', !approval.includes('?? process.cwd()'))
  // 插件源
  // 0.6.70：基准从「出厂 config.yaml 的目录」改成「**活动配置文件**的目录」——换过配置文件的人，
  // 相对插件路径该跟着他那一份走（同一处口径，见 core/config-store 的 activeConfigFile）
  check(
    '外部插件源：相对路径基于活动配置文件所在目录',
    kernel.includes('const configDir = dirname(activeConfigFile())') && !kernel.includes('resolve(process.cwd(), entry)'),
  )
  check('插件安装：相对路径基于 DSC_HOME', manager.includes('resolve(dscPath(), source)'))
  // LSP
  check('LSP：解析基准可注入（baseCwd）', lspClient.includes('baseCwd?(): string') && (lspManager.match(/this\.baseCwd\(\)/g) ?? []).length === 3)
  check('LSP：插件层给的是会话目录', lspPlugin.includes('baseCwd: () => sessionCwd(),'))

  // 通道与壳
  check('运行时：newSessionIn 透传到会话服务', runtimeSrc.includes('newSessionIn(cwd: string) {') && runtimeSrc.includes('ctx.session.open(undefined, cwd)'))
  check('宿主方法清单含 newSessionIn（旧桌面版那条通道）', hostMethods.includes("'newSessionIn',"))
  check('壳：工作区那颗钮走 newSessionIn（不再切目录）', sessions.includes("channel.invoke('newSessionIn', [target])"))
  check('壳：整个会话列表插件不再调 switchCwd（反证：整页重载那条路已撤）', !sessions.includes("invoke('switchCwd'"))
  check('壳：添加工作区用无副作用的 pickDirectory', sessions.includes("native.invoke<string>('pickDirectory')"))
  check('壳：新建成功顺手记一笔最近工作区', sessions.includes("invoke('rememberCwd', [target])"))
  check('桥：两条新操作在白名单里', bridge.includes("'pickDirectory',") && bridge.includes("'rememberCwd',"))
  check('桥：规格齐（取目录零实参、记账一个路径）', bridge.includes('pickDirectory: [],') && bridge.includes('rememberCwd: [{ shape: { kind: \'string\', max: MAX_PATH } }],'))
  check('桌面：pickDirectory 只弹框（不动宿主）', desktopMain.includes('async function pickDirectory(): Promise<string>'))
  check('桌面：chooseDirectory 仍旧是「切目录 + 重启宿主」（旧渲染层还在用）', desktopMain.includes('if (next !== hostCwd) await restartHost(next)'))
  check('桌面：rememberCwd 只写记忆', desktopMain.includes('function rememberCwdEntry(path: string): void'))
}

// 内核留着计时器 / 写租约那些句柄，不显式退出的话进程会挂在那儿——电池只看退出码，
// 一条挂住的探针等于整条电池卡死（本仓的探针因此都以 process.exit 收尾，见
// ui-status-data-test.mjs 的末尾）。
console.log(failures === 0 ? '\n全绿' : `\n${String(failures)} 条没过`)
process.exit(failures === 0 ? 0 : 1)
