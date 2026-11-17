/**
 * 手机端（remote-web）输入框 `/` 命令菜单的纯逻辑（迁自
 * `scripts/ui-phone-command-test.mjs` 第 [1]–[4] 段）。
 *
 * 手机界面是另一个 React 应用（`remote-web/`），与桌面壳不共用产物；命令菜单三件事
 * ——「菜单里有什么」「选完填什么」「发送时当命令还是当消息」——全在
 * `remote-web/src/lib/commands.ts` 的四个纯函数里。修的是现成的错：以前手机上打
 * `/compact` 会被当成普通消息发给模型。
 *
 * 为什么落在 `tests/`：`remote-web/` 不在 vitest 任何 project 的 include 里
 * （`src/**` 与 `tests/**`），而它是零依赖纯模块，`jsToTsFallback` 接得住相对导入。
 *
 * 没迁的（原探针第 [5] 段接线，见交付报告缺口清单）：`Composer.tsx` / `ChatPage.tsx`
 * 的调用点、样式类、错误条——渲染层文本钉，归组件渲染批。
 *
 * @module dsc/tests/phone-commands
 */
import { describe, expect, test } from 'vitest'
import type { PhoneCommandView } from '../remote-web/src/lib/commands.js'
import { commandQueryAt, commandToRun, filterCommands, insertCommand } from '../remote-web/src/lib/commands.js'

/** 宿主那份清单的迷你版（真的形状：name / args / description / label / duringTask）。 */
const COMMANDS: readonly PhoneCommandView[] = [
  { name: 'new', args: '', description: '新建一个空会话', label: '新会话', duringTask: 'deny' },
  { name: 'compact', args: '', description: '压缩以上对话内容', label: '压缩', duringTask: 'deny' },
  { name: 'diff', args: '[文件]', description: '查看工作区未提交改动', label: '差异', duringTask: 'allow' },
  { name: 'review', args: '[关注点]', description: '审查工作区未提交改动', label: '代码审查', duringTask: 'allow' },
  { name: 'resume', args: '', description: '恢复历史会话', label: '恢复会话', duringTask: 'deny' },
]

describe('命令位判定（与桌面壳同一套口径）', () => {
  test('打 / 就是在找命令（空前缀）；打了一半给小写查询词', () => {
    expect(commandQueryAt('/', 1)).toBe('')
    expect(commandQueryAt('/RE', 3)).toBe('re')
  })

  test('打了空格进参数阶段（菜单收起）、普通消息与光标在 / 左边都不算命令位', () => {
    expect(commandQueryAt('/diff src', 9)).toBeNull()
    expect(commandQueryAt('看看 /diff', 9)).toBeNull()
    expect(commandQueryAt('/d', 0)).toBeNull()
  })
})

describe('过滤（前缀，保持原序）', () => {
  test('空前缀列全部；/re 命中 review 与 resume（原序）', () => {
    expect(filterCommands([...COMMANDS], '')).toHaveLength(5)
    expect(filterCommands([...COMMANDS], 're').map((row) => row.name)).toEqual(['review', 'resume'])
  })

  test('大小写不敏感；负向对照：子串不算（view 不该命中 review）', () => {
    expect(filterCommands([...COMMANDS], 'RE')).toHaveLength(2)
    expect(filterCommands([...COMMANDS], 'view')).toEqual([])
  })
})

describe('采纳：无参数不带空格，有参数补一个', () => {
  test('/new 与 /diff 的补全文本', () => {
    const newCmd = COMMANDS.find((command) => command.name === 'new')
    const diff = COMMANDS.find((command) => command.name === 'diff')
    expect(insertCommand(newCmd ?? COMMANDS[0]!)).toBe('/new')
    expect(insertCommand(diff ?? COMMANDS[0]!)).toBe('/diff ')
  })
})

describe('发送前的分流：命令 vs 消息（commandToRun）', () => {
  test('精确命令名当命令跑；带参数整条交给宿主', () => {
    expect(commandToRun('/compact', [...COMMANDS])).toBe('/compact')
    expect(commandToRun('/diff lib/a.ts', [...COMMANDS])).toBe('/diff lib/a.ts')
  })

  test('唯一前缀展开（/co → /compact）；前缀撞名不猜（/re 有两条）', () => {
    expect(commandToRun('/co', [...COMMANDS])).toBe('/compact')
    expect(commandToRun('/re', [...COMMANDS])).toBeNull()
  })

  test('普通消息不拦；清单外的名字不当命令（失败关闭）；只有斜杠不算命令', () => {
    expect(commandToRun('帮我看下 /diff 是什么意思', [...COMMANDS])).toBeNull()
    expect(commandToRun('/exit', [...COMMANDS])).toBeNull()
    expect(commandToRun('/', [...COMMANDS])).toBeNull()
  })
})
