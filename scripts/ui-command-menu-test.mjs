/**
 * 壳（桌面 / 手机那份插件化界面）输入框 `/` 命令菜单的探针。
 *
 * 报障：输入框里打 `/` 什么也不出（旧版把 `/` 开头的原文当场拦下，只有 /compact 例外）。
 * 这一版把 TUI 的命令接到壳里，但**只接必要的那几条**——所以要钉的就是「哪几条能跑、
 * 哪几条一定不能跑」，以及两侧接线（宿主白名单 / 契约 / 旧桥 / 壳）。
 *
 * 五段：
 *   [1] 宿主那份 `shell: true` 清单：就是那七条；危险动作一条都不在里面（逐条列名对照）；
 *   [2] `shellCommandRejection`：闸的真行为——前缀展开后仍拦、参数阶段放行、非 `/` 输入拦，
 *       外加**负向对照**（拿掉 `shell` 标记就拦得住，证明闸不是恒放行）；
 *   [3] 白名单与接线：界面通道 / 宿主协议 / 远程壳 / 契约 / 共享类型 / 旧桥 / 宿主插件；
 *   [4] 壳侧纯逻辑真跑（`composer/commands.ts`：命令位判定、前缀过滤、补全文本、标灰）；
 *   [5] 壳侧接线（invoke 两条、按键归属、样式类、旧文案已拆）。
 *
 * 用法：pnpm build && node scripts/ui-command-menu-test.mjs
 *
 * @module dsc/scripts/ui-command-menu-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const core = await import('../lib/core/commands-completion.js')
const { shellCommands, shellCommandRejection, isShellCommand, addExtraSpec, removeExtraSpec, BUILT_IN_COMMANDS } = core
const { UI_METHODS, UI_EXCLUDED, UI_ARG_SPECS } = await import('../lib/core/ui-methods.js')
const { INVOKABLE_METHODS } = await import('../lib/core/host-methods.js')
const { REMOTE_SHELL_METHODS } = await import('../lib/plugins/remote/types.js')
const shell = await import(new URL('../ui-shell/src/plugins/composer/commands.ts', import.meta.url).href)
const { commandQuery, filterCommands, insertCommand, blockedNow } = shell

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let passed = 0
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === '' ? '' : `  <- ${detail}`}`)
  }
}

/** 壳里能跑的那七条（改这一份就是改口径：清单动了探针必须跟着动）。 */
const EXPECTED = ['new', 'compact', 'status', 'usage', 'diff', 'review', 'help']

console.log('[1] 宿主：哪些命令摆在壳的菜单里')
{
  const names = shellCommands().map((spec) => spec.name)
  check('清单就是那七条（次序照命令表的原序）', JSON.stringify(names) === JSON.stringify(EXPECTED), JSON.stringify(names))
  for (const name of EXPECTED) {
    check(`listUiCommands 会列出 /${name}`, names.includes(name), '')
    check(`/不可执行的闸放行 /${name}`, isShellCommand(name), '')
  }
  // 逐条点名不能进菜单的：写完面的（权限三旋钮 / 导出 / 落信任 / 退出）、
  // 壳里有更顺手替身的（模型、档位、会话、设置、插件、队友、更新）。
  const forbidden = [
    'policy',
    'reviewer',
    'permission',
    'export',
    'ui-trust',
    'exit',
    'copy',
    'update',
    'thinking',
    'settings',
    'resume',
    'agents',
    'model',
    'effort',
    'fork',
    'plugins',
  ]
  for (const name of forbidden) {
    check(`/不可执行：/${name} 不在菜单里`, !names.includes(name) && !isShellCommand(name), '')
  }
  check('内置表每条命令都还在（没顺手删掉终端那几条）', BUILT_IN_COMMANDS.length === 23, String(BUILT_IN_COMMANDS.length))
  const help = shellCommands().find((spec) => spec.name === 'help')
  check('/help 的说明照样来自命令表（不是壳里抄的）', help?.description === '查看帮助', JSON.stringify(help))
}

console.log('\n[2] 闸的真行为：shellCommandRejection')
{
  check('裸 `/` 放行（落到 /help，与 TUI 一致）', shellCommandRejection('/') === null, String(shellCommandRejection('/')))
  check('/review 放行', shellCommandRejection('/review') === null, String(shellCommandRejection('/review')))
  check('带参数放行（/review 关注点）', shellCommandRejection('/review 关注点') === null, '')
  check('带参数放行（/diff src/a.ts）', shellCommandRejection('/diff src/a.ts') === null, '')
  // 展开规则与 TUI 共用同一条 `expandCommand`（按**全表**算）：`/rev` 在全表里撞
  // `/reviewer`、`/REVIEW` 大小写也对不上，两条都展开不出唯一名字——TUI 那边同样
  // 认不出（「未知命令」）。壳里打这些前缀照旧能跑，靠的是另一个机制：菜单按壳清单
  // 过滤后 Enter 采纳高亮项（[4] 段钉着），所以这条路不是死胡同。
  check('唯一前缀展开按全表算（/rev 撞 /reviewer，不当别名）', shellCommandRejection('/rev') !== null, String(shellCommandRejection('/rev')))
  check('大小写不按别名展开（与 TUI 的未知命令同口径）', shellCommandRejection('/REVIEW') !== null, String(shellCommandRejection('/REVIEW')))
  const policy = shellCommandRejection('/policy full-access')
  check('权限旋钮拦下并说清原因', policy !== null && policy.includes('/policy') && policy.includes('不在桌面壳'), String(policy))
  check('别名展开后一样拦（/po → /policy）', shellCommandRejection('/po') !== null, String(shellCommandRejection('/po')))
  const unknown = shellCommandRejection('/nope')
  check('不认识的命令拦下', unknown !== null && unknown.includes('/nope'), String(unknown))
  const plain = shellCommandRejection('帮我看看这个 bug')
  check('非 `/` 输入拦下（界面通道只接命令）', plain !== null, String(plain))
  const sneaky = shellCommandRejection('/  policy')
  check('多打空格绕过不了（先归一再认名字，仍指向 /policy）', sneaky !== null && sneaky.includes('/policy'), String(sneaky))
  check('反过来：多打空格的放行命令照样放行（归一后是 /review）', shellCommandRejection('/   review x') === null, String(shellCommandRejection('/   review x')))

  // 负向对照：拿掉 `shell` 标记，同一个闸就该拦——证明它不是恒放行。
  const probe = { name: 'probe-tmp', args: '', description: '探针临时命令' }
  addExtraSpec(probe)
  const cold = shellCommandRejection('/probe-tmp')
  check('外部插件命令默认拦（没标 shell）', cold !== null, String(cold))
  removeExtraSpec(probe)
  addExtraSpec({ ...probe, shell: true })
  const warm = shellCommandRejection('/probe-tmp')
  check('宿主侧插件给自己标了 shell 就放行（且菜单里多一行）', warm === null && shellCommands().some((spec) => spec.name === 'probe-tmp'), String(warm))
  removeExtraSpec({ ...probe, shell: true })
  check('注销后又消失（不留残留）', !shellCommands().some((spec) => spec.name === 'probe-tmp'), '')
}

console.log('\n[3] 白名单与两侧接线')
{
  check('界面通道放行 listUiCommands', UI_METHODS.includes('listUiCommands'), '')
  check('界面通道放行 runUiCommand', UI_METHODS.includes('runUiCommand'), '')
  check('runCommand 仍被排除（任意命令执行那条路没开）', UI_EXCLUDED.includes('runCommand') && !UI_METHODS.includes('runCommand'), '')
  check('两条都有实参规格', UI_ARG_SPECS.listUiCommands?.length === 0 && UI_ARG_SPECS.runUiCommand?.length === 1, JSON.stringify(UI_ARG_SPECS.runUiCommand))
  check('宿主协议清单也加了（漏一个桌面 tsc 就红）', ['listUiCommands', 'runUiCommand'].every((name) => INVOKABLE_METHODS.includes(name)), '')
  check('远程壳放行（手机与电脑同一份壳产物）', ['listUiCommands', 'runUiCommand'].every((name) => REMOTE_SHELL_METHODS.includes(name)), '')

  const contract = read('src/contract.ts')
  check('契约里声明 UiCommandView', /export interface UiCommandView \{/.test(contract) && contract.includes('duringTask'), '')
  check('契约里声明两条方法', /listUiCommands\(\): UiCommandView\[\]/.test(contract) && /runUiCommand\(input: string\): boolean/.test(contract), '')
  const sharedTypes = read('src/ui/index.ts')
  check('共享类型面转出 UiCommandView（壳按它写渲染）', sharedTypes.includes('UiCommandView,'), '')
  const pluginApi = read('ui-shell/src/plugin-api.ts')
  check('@dsc/ui 转出 UiCommandView', pluginApi.includes('UiCommandView,'), '')
  const bridge = read('desktop/src/renderer/bridge.ts')
  check('旧渲染层的 RuntimeProxy 给了两条实现', /listUiCommands: \(\) => call<UiCommandView\[\]>/.test(bridge) && /runUiCommand: \(input\) => call<boolean>\('runUiCommand'/.test(bridge), '')
  const runtime = read('src/plugins/runtime.ts')
  check('宿主插件走纯函数那道闸', runtime.includes('shellCommandRejection(input)'), '')
  check('列表与派发共用一份 UI 回调（notice 落会话，壳直接读得到）', (runtime.match(/commandUi\(\)/g) ?? []).length >= 3, '')
  const core = read('src/core/commands-completion.ts')
  check('尺子写在命令表旁边（shell: true 那段注释在）', core.includes('shell: true') && core.includes('失败关闭'), '')
  const spec = read('src/services/types.ts')
  check('CommandSpec 有 shell 一位并写了失败关闭', /shell\?: boolean/.test(spec) && spec.includes('失败关闭'), '')
}

console.log('\n[4] 壳侧纯逻辑（真跑 composer/commands.ts）')
{
  check('命令位：整条以 / 开头且光标在名字里', commandQuery('/re', 3) === 're', String(commandQuery('/re', 3)))
  check('命令位：裸 / 给空查询（列全部）', commandQuery('/', 1) === '', String(commandQuery('/', 1)))
  check('参数阶段收起（/review 关注点）', commandQuery('/review 关注点', 13) === null, String(commandQuery('/review 关注点', 13)))
  check('不是命令位（普通消息）', commandQuery('看看 /review', 9) === null, String(commandQuery('看看 /review', 9)))
  check('光标还在 / 左边不算（行首按左键）', commandQuery('/re', 0) === null, String(commandQuery('/re', 0)))
  check('换行也算参数阶段', commandQuery('/re\nview', 8) === null, String(commandQuery('/re\nview', 8)))

  const table = [
    { name: 'new', args: '', description: '新建会话', duringTask: 'deny' },
    { name: 'review', args: '[关注点]', description: '审查工作区未提交改动', duringTask: 'allow' },
    { name: 'resume', args: '', description: '恢复历史会话', duringTask: 'deny' },
  ]
  const all = filterCommands(table, '')
  check('空前缀列全部且保持原序', JSON.stringify(all.map((row) => row.name)) === JSON.stringify(['new', 'review', 'resume']), JSON.stringify(all.map((row) => row.name)))
  const r = filterCommands(table, 're')
  check('前缀过滤命中', JSON.stringify(r.map((row) => row.name)) === JSON.stringify(['review', 'resume']), JSON.stringify(r.map((row) => row.name)))
  check('大小写不敏感', filterCommands(table, 'RE').length === 2, '')
  check('负向对照：只认前缀不认子串（view 不该命中 review）', filterCommands(table, 'view').length === 0, JSON.stringify(filterCommands(table, 'view')))
  check('补全文本：无参数不带空格', insertCommand(table[0]) === '/new', insertCommand(table[0]))
  check('补全文本：有参数带一个空格（接着打参数）', insertCommand(table[1]) === '/review ', JSON.stringify(insertCommand(table[1])))
  // 前缀展开在全表里撞名（/rev 撞 /reviewer）时，壳这条路的出口是「菜单过滤只在壳
  // 清单里算 + Enter 采纳高亮项」：过滤后只剩一条，采纳它就成。
  const shellNames = filterCommands(shellCommands(), 'rev').map((row) => row.name)
  check('菜单过滤按壳清单算（/rev 只剩 review 一条）', JSON.stringify(shellNames) === JSON.stringify(['review']), JSON.stringify(shellNames))
  const upper = filterCommands(shellCommands(), 're').map((row) => row.name)
  check('菜单过滤大小写不敏感（/RE 命中壳那批）', JSON.stringify(upper) === JSON.stringify(['review']), JSON.stringify(upper))
  check('回合中：deny 的行标灰', blockedNow(table[0], true) === true, '')
  check('回合中：allow 的行不标灰', blockedNow(table[1], true) === false, '')
  check('闲着的时候都不标灰', blockedNow(table[0], false) === false, '')
}

console.log('\n[5] 壳侧接线')
{
  const composer = read('ui-shell/src/plugins/composer/ui.tsx')
  check('菜单数据来自宿主的 listUiCommands', composer.includes("invoke<ShellCommandView[]>('listUiCommands')") || read('ui-shell/src/plugins/composer/command-menu.ts').includes("('listUiCommands')"), '')
  check('执行走 runUiCommand（不再当场拦下）', composer.includes("invoke<boolean>('runUiCommand'"), '')
  check('旧文案已拆（“还没接到界面通道”那句不再出现）', !composer.includes('这条路还没接到界面通道'), '')
  check('/compact 老特例已并入统一派发', !composer.includes("value === '/compact'"), '')
  check('Enter 采纳高亮项（与 TUI 的 panelOpen 分支同口径）', composer.includes('command.insertText()'), '')
  check('只打一个 / 时不采纳（原文落到 /help）', composer.includes("command.open && typed !== '/'"), '')
  check('按键归属：↑↓/Tab/Esc 先归菜单', composer.includes('command.move(event.key === ' + "'ArrowDown'" + ' ? 1 : -1)') && composer.includes('command.pick()'), '')
  check('命令位里不提文件（@ 面板让位）', composer.includes('if (commandQuery(value, caret) === null) mention.track(value, caret)'), '')
  check('面板画出来了（role=listbox + 类名）', composer.includes('aria-label="命令候选"') && composer.includes('className={`slash-item'), '')
  const styles = read('ui-shell/src/styles.css')
  check('样式类齐（面板 / 行 / 三列 / 提示）', ['slash-pop', 'slash-item', 'slash-name', 'slash-args', 'slash-desc', 'slash-flag', 'slash-hint'].every((cls) => styles.includes(`.${cls}`)), '')
  const menu = read('ui-shell/src/plugins/composer/command-menu.ts')
  check('清单一次取、模块级缓存（打字每一拍不问宿主）', menu.includes('let cache: ShellCommandView[] | null = null') && menu.includes('if (cache !== null)'), '')
  check('取不到时整会话不反复问（并给一句提示）', menu.includes('let unavailable = false') && composer.includes('没接“/”命令通道'), '')
  check('纯模块零依赖（不 import React / 宿主）', !/^import /m.test(read('ui-shell/src/plugins/composer/commands.ts')), '')
}

console.log(`\n壳的 / 命令菜单：${String(passed)}/${String(passed + failures)} 通过`)
process.exit(failures === 0 ? 0 : 1)
