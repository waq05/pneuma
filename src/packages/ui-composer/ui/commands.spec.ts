/**
 * 壳输入框 `/` 命令菜单（迁自 `scripts/ui-command-menu-test.mjs`）。
 *
 * 迁进来的五段，全部有真接缝（读的是真实导出与真实返回值，不是源码文本）：
 *   ① 宿主 `shell: true` 清单就是那九条，写完面的与壳里有替身的逐条不在——
 *      判据落在 `shellCommands()` / `isShellCommand()` 的真实返回上；
 *   ② `shellCommandRejection` 的真行为：放行、拦截、前缀展开、外加负向对照
 *      （临时命令没标 `shell` 就拦，标了才放行——证明闸不是恒放行）；
 *   ②b `shellHelpText()` 只列壳里跑得了的，终端那份仍是全量；
 *   ③ 白名单半边：`UI_METHODS` / `UI_EXCLUDED` / `UI_ARG_SPECS` / `INVOKABLE_METHODS` /
 *      `REMOTE_SHELL_METHODS` 都是真实导出，按手册 §2 方案 A「断言导出对象」改写；
 *   ④ 壳侧纯逻辑（`composer/commands.ts`：命令位判定、前缀过滤、补全文本、
 *      收输入的 claim、回合中标灰）。
 *
 * 没迁的（原文是「读源码找那句文本」，按手册 §2 属必删项，理由见交付报告）：
 *   [3] 契约 / 共享类型 / 宿主 runtime 接线的十几条文本钉——契约形状由 `tsc` 编译期
 *       把关（`UiCommandView` 不存在时壳自己编不过），运行期无接缝可断言；
 *   [5] 壳侧接线与样式类（invoke 调用点、按键归属、`slash-*` 样式、TUI/手机端接线）
 *       ——接缝在渲染层，属「待组件渲染批」。
 *
 * 为什么归 ui project：本文件 import 了 `./commands.js`（纯模块）与 `commands-core`，
 * 两者虽不带 `@dsc/ui`，但落在本目录即归 ui project 收（`src/packages/<pkg>/ui/**`），
 * 与同目录 `model-picker.spec.ts` 同一约定。
 *
 * @module dsc-ui-composer/ui/commands.spec
 */
import { describe, expect, test } from 'vitest'
import type { CommandSpec } from '@pneuma/runtime/services/types.js'
import {
  BUILT_IN_COMMANDS,
  addExtraSpec,
  allSpecs,
  expandCommand,
  helpText,
  isShellCommand,
  removeExtraSpec,
  shellCommandRejection,
  shellCommands,
  shellHelpText,
} from '../../commands-core/commands-completion.js'
import { REMOTE_SHELL_METHODS } from '../../remote/types.js'
import { INVOKABLE_METHODS } from '@pneuma/runtime/core/host-methods.js'
import { UI_ARG_SPECS, UI_EXCLUDED, UI_METHODS } from '@pneuma/runtime/core/ui-methods.js'
import { blockedNow, claimInput, commandQuery, filterCommands, insertCommand, type ShellCommandView } from './commands.js'

/**
 * 宿主 `listUiCommands` 的投影（照 `packages/runtime/index.ts` 的取法转录）：spec → view。
 *
 * 壳侧四个纯函数收的是 **view**（宿主已把 spec 投影好：`duringTask` 缺省补 `'allow'`、
 * label / input 缺省不填）——壳只读不造。这里转录的是「取法」而非源码文本：宿主投影少带
 * 一个字段时，走这条路的断言会红；手写的夹具直接写成 view，不过这道。
 */
const toView = (spec: CommandSpec): ShellCommandView => ({
  name: spec.name,
  args: spec.args,
  description: spec.description,
  ...(spec.label === undefined ? {} : { label: spec.label }),
  ...(spec.input === undefined ? {} : { input: spec.input }),
  duringTask: spec.duringTask ?? 'allow',
})

/** 壳里能跑的清单（改这一份就是改口径：清单动了本文件必须跟着动）。 */
const EXPECTED = ['new', 'compact', 'status', 'usage', 'diff', 'review', 'review-status', 'review-cancel', 'help']

/** 逐条点名不能进菜单的：写完面的、壳里有更顺手替身的（权限三旋钮 / 导出 / 退出 / 模型……）。 */
const FORBIDDEN = [
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

describe('① 宿主：哪些命令摆在壳的菜单里', () => {
  test('清单就是那九条（次序照命令表的原序）', () => {
    expect(shellCommands().map((spec) => spec.name)).toEqual(EXPECTED)
  })

  test.each(EXPECTED)('listUiCommands 会列出 /%s，闸也放行', (name) => {
    expect(shellCommands().some((spec) => spec.name === name)).toBe(true)
    expect(isShellCommand(name)).toBe(true)
  })

  test.each(FORBIDDEN)('/%s 不在菜单里、闸也不放行', (name) => {
    expect(shellCommands().some((spec) => spec.name === name)).toBe(false)
    expect(isShellCommand(name)).toBe(false)
  })

  test('内置表每条命令都还在（没顺手删掉终端那几条）', () => {
    expect(BUILT_IN_COMMANDS).toHaveLength(25)
  })

  test('/help 的说明照样来自命令表（不是壳里抄的）', () => {
    const help = shellCommands().find((spec) => spec.name === 'help')
    expect(help?.description).toBe('查看命令帮助')
  })

  test('内置命令每条都有中文短名，且控制在 2–5 字（再长就把英文名挤没了）', () => {
    const unlabeled = BUILT_IN_COMMANDS.filter((spec) => typeof spec.label !== 'string' || spec.label === '')
    expect(unlabeled.map((spec) => spec.name)).toEqual([])
    const tooLong = BUILT_IN_COMMANDS.filter(
      (spec) => typeof spec.label === 'string' && (spec.label.length < 2 || spec.label.length > 5),
    )
    expect(tooLong.map((spec) => [spec.name, spec.label])).toEqual([])
  })

  test('壳那七条的中文名与 dsh 口径一致', () => {
    const pairs = ['new:新会话', 'compact:压缩', 'status:状态', 'usage:用量', 'diff:差异', 'review:代码审查', 'help:帮助']
    for (const pair of pairs) {
      const [name, label] = pair.split(':')
      expect(shellCommands().find((spec) => spec.name === name)?.label).toBe(label)
    }
  })

  test('/review 标了 input 与提示语（只有它一条；回车先补全、不执行）', () => {
    const reviewSpec = BUILT_IN_COMMANDS.find((spec) => spec.name === 'review')
    expect(reviewSpec?.input?.hint.includes('关注点')).toBe(true)
    expect(
      BUILT_IN_COMMANDS.filter((spec) => spec.input !== undefined).map((spec) => spec.name),
    ).toEqual(['review'])
  })
})

describe('② 闸的真行为：shellCommandRejection', () => {
  test('裸 `/` 放行（落到 /help，与 TUI 一致）', () => {
    expect(shellCommandRejection('/')).toBeNull()
  })

  test('清单内的命令带不带参数都放行', () => {
    expect(shellCommandRejection('/review')).toBeNull()
    expect(shellCommandRejection('/review 关注点')).toBeNull()
    expect(shellCommandRejection('/diff src/a.ts')).toBeNull()
  })

  test('唯一前缀展开按全表算（/rev 撞 /reviewer，不当别名）', () => {
    expect(shellCommandRejection('/rev')).not.toBeNull()
  })

  test('大小写不按别名展开（与 TUI 的未知命令同口径）', () => {
    expect(shellCommandRejection('/REVIEW')).not.toBeNull()
  })

  test('权限旋钮拦下并说清原因（不在桌面壳）', () => {
    const policy = shellCommandRejection('/policy full-access')
    expect(policy).not.toBeNull()
    expect(policy).toContain('/policy')
    expect(policy).toContain('不在桌面壳')
  })

  test('别名展开后一样拦（/po → /policy）', () => {
    expect(shellCommandRejection('/po')).not.toBeNull()
  })

  test('带参数也按名字展开（/di HEAD → /diff HEAD），展开不改参数原文', () => {
    expect(expandCommand('/di HEAD')).toBe('/diff HEAD')
    expect(shellCommandRejection('/di HEAD')).toBeNull()
    expect(expandCommand('/sta  中文 参数')).toBe('/status  中文 参数')
    expect(expandCommand('/diff HEAD')).toBe('/diff HEAD')
    expect(expandCommand('/rev')).toBe('/rev')
  })

  test('不认识的命令拦下且点名', () => {
    const unknown = shellCommandRejection('/nope')
    expect(unknown).not.toBeNull()
    expect(unknown).toContain('/nope')
  })

  test('非 `/` 输入拦下（界面通道只接命令）', () => {
    expect(shellCommandRejection('帮我看看这个 bug')).not.toBeNull()
  })

  test('多打空格绕过不了（先归一再认名字），放行的命令归一后照样放行', () => {
    const sneaky = shellCommandRejection('/  policy')
    expect(sneaky).not.toBeNull()
    expect(sneaky).toContain('/policy')
    expect(shellCommandRejection('/   review x')).toBeNull()
  })

  test('负向对照：外部命令没标 shell 拦、标了放行、注销后消失（闸不是恒放行）', () => {
    const probe = { name: 'probe-tmp', args: '', description: '探针临时命令' }
    addExtraSpec(probe)
    try {
      expect(shellCommandRejection('/probe-tmp')).not.toBeNull()
    } finally {
      removeExtraSpec(probe)
    }
    addExtraSpec({ ...probe, shell: true })
    try {
      expect(shellCommandRejection('/probe-tmp')).toBeNull()
      expect(shellCommands().some((spec) => spec.name === 'probe-tmp')).toBe(true)
    } finally {
      removeExtraSpec({ ...probe, shell: true })
    }
    expect(shellCommands().some((spec) => spec.name === 'probe-tmp')).toBe(false)
  })
})

describe('②b /help 只列壳里跑得了的', () => {
  test('列出来的就是那九条（原序）', () => {
    const text = shellHelpText()
    const listed = text
      .split('\n')
      .filter((line) => line.startsWith('/'))
      .map((line) => line.slice(1).split(/\s/)[0])
    expect(listed).toEqual(EXPECTED)
  })

  test('跑不了的命令一条都不出现', () => {
    const text = shellHelpText()
    const listed = text
      .split('\n')
      .filter((line) => line.startsWith('/'))
      .map((line) => line.slice(1).split(/\s/)[0])
    for (const name of ['export', 'exit', 'model', 'policy', 'copy', 'fork']) {
      expect(listed).not.toContain(name)
    }
  })

  test('头部写清条数、末尾给出路（终端 / 底栏旋钮）', () => {
    const text = shellHelpText()
    expect(text).toContain('9 条')
    expect(text).toContain('终端')
    expect(text).toContain('旋钮')
  })

  test('终端那份仍是全量（同一个注册表两种口径）', () => {
    expect(helpText(allSpecs()).split('\n')).toHaveLength(25)
  })
})

describe('③ 白名单（真实导出面，方案 A：断言导出对象）', () => {
  test('界面通道放行 listUiCommands / runUiCommand', () => {
    expect(UI_METHODS).toContain('listUiCommands')
    expect(UI_METHODS).toContain('runUiCommand')
  })

  test('runCommand 仍被排除（任意命令执行那条路没开）', () => {
    expect(UI_EXCLUDED).toContain('runCommand')
    expect(UI_METHODS).not.toContain('runCommand')
  })

  test('两条都有实参规格（listUiCommands 零参、runUiCommand 一参）', () => {
    expect(UI_ARG_SPECS.listUiCommands).toHaveLength(0)
    expect(UI_ARG_SPECS.runUiCommand).toHaveLength(1)
  })

  test('宿主协议清单也加了（漏一个桌面 tsc 就红）', () => {
    expect(INVOKABLE_METHODS).toContain('listUiCommands')
    expect(INVOKABLE_METHODS).toContain('runUiCommand')
  })

  test('远程壳放行（手机与电脑同一份壳产物）', () => {
    expect(REMOTE_SHELL_METHODS).toContain('listUiCommands')
    expect(REMOTE_SHELL_METHODS).toContain('runUiCommand')
  })
})

describe('④ 壳侧纯逻辑：composer/commands.ts', () => {
  test('命令位：整条以 / 开头且光标在名字里', () => {
    expect(commandQuery('/re', 3)).toBe('re')
  })

  test('命令位：裸 / 给空查询（列全部）', () => {
    expect(commandQuery('/', 1)).toBe('')
  })

  test('参数阶段收起（/review 关注点）', () => {
    expect(commandQuery('/review 关注点', 13)).toBeNull()
  })

  test('不是命令位（普通消息）、光标在 / 左边、换行都算参数阶段', () => {
    expect(commandQuery('看看 /review', 9)).toBeNull()
    expect(commandQuery('/re', 0)).toBeNull()
    expect(commandQuery('/re\nview', 8)).toBeNull()
  })

  test('空前缀列全部且保持原序；前缀过滤命中且大小写不敏感', () => {
    const table: ShellCommandView[] = [
      { name: 'new', args: '', description: '新建会话', duringTask: 'deny' },
      { name: 'review', args: '[关注点]', description: '审查工作区未提交改动', duringTask: 'allow' },
      { name: 'resume', args: '', description: '恢复历史会话', duringTask: 'deny' },
    ]
    expect(filterCommands(table, '').map((row) => row.name)).toEqual(['new', 'review', 'resume'])
    expect(filterCommands(table, 're').map((row) => row.name)).toEqual(['review', 'resume'])
    expect(filterCommands(table, 'RE')).toHaveLength(2)
  })

  test('负向对照：只认前缀不认子串（view 不该命中 review）', () => {
    const table: ShellCommandView[] = [
      { name: 'review', args: '[关注点]', description: '审查', duringTask: 'allow' },
    ]
    expect(filterCommands(table, 'view')).toEqual([])
  })

  test('补全文本：无参数不带空格，有参数带一个空格（接着打参数）', () => {
    const table: ShellCommandView[] = [
      { name: 'new', args: '', description: '新建会话', duringTask: 'deny' },
      { name: 'review', args: '[关注点]', description: '审查', duringTask: 'allow' },
    ]
    expect(insertCommand(table[0]!)).toBe('/new')
    expect(insertCommand(table[1]!)).toBe('/review ')
  })

  test('菜单过滤按壳清单算：/rev 命中 review 三条（review-status / review-cancel 也是事实）', () => {
    expect(filterCommands(shellCommands().map(toView), 'rev').map((row) => row.name)).toEqual([
      'review',
      'review-status',
      'review-cancel',
    ])
    expect(filterCommands(shellCommands().map(toView), 'RE').map((row) => row.name)).toEqual([
      'review',
      'review-status',
      'review-cancel',
    ])
  })

  test('回合中：deny 的行标灰，allow 的不标，闲着都不标', () => {
    const table: ShellCommandView[] = [
      { name: 'new', args: '', description: '新建会话', duringTask: 'deny' },
      { name: 'review', args: '[关注点]', description: '审查', duringTask: 'allow' },
    ]
    expect(blockedNow(table[0]!, true)).toBe(true)
    expect(blockedNow(table[1]!, true)).toBe(false)
    expect(blockedNow(table[0]!, false)).toBe(false)
  })

  test('要收输入的命令：回车前给出补全文本与提示', () => {
    const claimRows: ShellCommandView[] = [
      { name: 'review', args: '[关注点]', description: '代码审查', duringTask: 'allow', input: { hint: '写上关注点' } },
      { name: 'reviewer', args: '', description: '审阅者', duringTask: 'allow' },
      { name: 'diff', args: '[文件]', description: '差异', duringTask: 'allow' },
    ]
    const claim = claimInput(claimRows, '/review')
    expect(claim?.insert).toBe('/review ')
    expect(claim?.hint).toBe('写上关注点')
  })

  test('尾空格不算参数；写了参数就不补全', () => {
    const claimRows: ShellCommandView[] = [
      { name: 'review', args: '[关注点]', description: '代码审查', duringTask: 'allow', input: { hint: '写上关注点' } },
    ]
    expect(claimInput(claimRows, '/review   ')?.insert).toBe('/review ')
    expect(claimInput(claimRows, '/review 只看登录逻辑')).toBeNull()
  })

  test('/rev 撞 /reviewer 时只认收输入的那条', () => {
    const claimRows: ShellCommandView[] = [
      { name: 'review', args: '[关注点]', description: '代码审查', duringTask: 'allow', input: { hint: '写上关注点' } },
      { name: 'reviewer', args: '', description: '审阅者', duringTask: 'allow' },
    ]
    expect(claimInput(claimRows, '/rev')?.insert).toBe('/review ')
  })

  test('没有 input 的命令行为不变（/diff 返回 null）', () => {
    const claimRows: ShellCommandView[] = [{ name: 'diff', args: '[文件]', description: '差异', duringTask: 'allow' }]
    expect(claimInput(claimRows, '/diff')).toBeNull()
  })

  test('清单为空时返回 null（不为这条去请求宿主）；普通消息不认', () => {
    const claimRows: ShellCommandView[] = [
      { name: 'review', args: '[关注点]', description: '代码审查', duringTask: 'allow', input: { hint: '写上关注点' } },
    ]
    expect(claimInput([], '/review')).toBeNull()
    expect(claimInput(claimRows, '看看 /review')).toBeNull()
  })
})
