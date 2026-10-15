/**
 * todo 插件：provide `todo` 服务——模型自己维护、界面实时显示的那张任务清单。
 *
 * 这个功能点由这几块组成，全在自己文件里：
 *   1. 工具 `todo_write`（整表替换或按 id 合并）；
 *   2. 命令 `/todo [clear]`；
 *   3. 界面快照里的 `todos` 那片投影（注册进 surfaces 注册表）；
 *   4. 会话状态条目 `todos`（恢复历史会话时清单跟着回来）与压缩后要原样带过去的清单文本；
 *   5. 「todo-reminder」节流提醒投影（order 800，默认关）：距上次写清单过了 N 个用户回合、
 *      且还有未完成项时，往请求末尾补一条 user 提醒。逻辑在 `core/todo-reminder.ts`（纯函数，
 *      可被探针直读），配置走本插件的设置分区。
 *
 * 形状抄三家：整表替换与四态来自 Codex 的 `update_plan`（`protocol/src/plan_tool.rs:9-28`）
 * 与 DSH 的 `todo_write`；id / 子任务 / 单调 revision 来自 Hermes（`tools/todo_tool.py:9-32`）。
 *
 * @module dsc/plugins/todo
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import { appendTodoReminder } from '../core/todo-reminder.js'
import { TodoStore } from '../core/todo.js'
import type { ToolEntry } from '../core/tools.js'
import type { SettingsField, SettingsValues } from '../contract.js'
import type { SettingsSectionSpec, TodoService } from '../services/types.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'todo'

/** 节流提醒的默认值：默认关（不给所有会话凭空加 token），每 10 个用户回合提醒一次。 */
const REMINDER_DEFAULTS = { enabled: false, everyTurns: 10 }

/** 从插件配置读节流提醒的开关与间隔，并把间隔夹回 1..100。 */
function readReminderConfig(): { enabled: boolean; everyTurns: number } {
  const raw = resolvePluginConfig(CONFIG_KEY)
  const num = Number(raw.everyTurns)
  return {
    enabled: raw.enabled === true || raw.enabled === 'true',
    everyTurns: Number.isFinite(num)
      ? Math.min(Math.max(Math.round(num), 1), 100)
      : REMINDER_DEFAULTS.everyTurns,
  }
}

/** 任务清单工具：写入即回显整表，模型看到的和用户看到的是同一份。 */
function todoTool(store: TodoStore, onWrite: () => void): ToolEntry {
  return {
    name: 'todo_write',
    description:
      '维护本次任务的用户可见清单：传 todos 数组整表替换，或 merge:true 只改给出的那几条（必须带 id）。' +
      '状态只有 pending / in_progress / completed / cancelled 四种，同一时刻最多一条 in_progress。' +
      '什么时候用：3 步以上的活开工前先立清单，做完一步立刻改状态。' +
      '什么时候不用：一两步就完的事别立清单，纯问答也别立；不要用它在计划模式里代替计划文件。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '任务清单',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '条目 id（不给自动生成；merge 模式必须给）' },
              content: { type: 'string', description: '一句话动作描述（≤300 字）' },
              status: { type: 'string', description: 'pending | in_progress | completed | cancelled' },
              parent: { type: 'string', description: '父任务 id（表示这是它的子任务）' },
            },
            required: ['content'],
          },
        },
        merge: { type: 'boolean', description: 'true = 按 id 合并更新；默认 false = 整表替换' },
      },
      required: ['todos'],
    },
    risk: 'read',
    async run(args) {
      const list = Array.isArray(args.todos) ? args.todos : null
      if (list === null) throw new Error('todos 必须是数组')
      const result = store.write(list, args.merge === true)
      onWrite()
      const progress = store.progress()
      const notes = result.notes.length > 0 ? `\n注意：${result.notes.join('；')}` : ''
      if (store.read().length === 0) return '清单已清空。'
      return `清单已更新（${progress.done}/${progress.total} 完成）\n${store.formatForPrompt()}${notes}`
    },
  }
}

export const todoPlugin: Plugin.Object = {
  name: 'todo',
  inject: ['session', 'tools', 'commands', 'surfaces', 'compact', 'prompt', 'settings'],
  provide: 'todo',
  apply(ctx) {
    const todos = new TodoStore()
    const restored = ctx.session.current().state('todos')
    if (restored !== undefined) todos.restore(restored)

    const touch = (): void => ctx.emit('dsc/changed')
    const writeTodos = (list: readonly unknown[], merge: boolean) => {
      const result = todos.write(list, merge)
      ctx.session.current().appendState('todos', result.items)
      touch()
      return result
    }

    const service: TodoService = {
      todoView() {
        const progress = todos.progress()
        return {
          items: todos.read(),
          revision: todos.rev,
          done: progress.done,
          total: progress.total,
          active: progress.active,
        }
      },
      writeTodos,
      clearTodos() {
        todos.clear()
        ctx.session.current().appendState('todos', [])
        ctx.emit('dsc/notice', '任务清单已清空')
        touch()
      },
      todoPrompt() {
        return todos.empty ? '' : `本次任务清单（当前进度，照它继续，别重建）：\n${todos.formatForPrompt()}`
      },
    }
    ctx.provide('todo', service)

    ctx.tools.register(todoTool(todos, () => ctx.emit('dsc/changed')))

    ctx.surfaces.register('todos', () => service.todoView())
    // 压缩摘要会把清单改写走样，所以整表要原样带过去（压缩插件只问注册表要文本）。
    ctx.compact.registerCarry(() => service.todoPrompt())

    // ── 节流提醒投影（默认关）──────────────────────────────────────────────
    // 长会话里模型会把「做完一步就改状态」忘掉，光靠工具说明里的静态叮嘱拉不回来。
    // 这条投影每 N 个用户回合往请求末尾补一条 user 提醒（ZCode 的节流注入思路），
    // 代价是多一条 user 消息的 token，所以默认关、用户自己开。
    let reminder = readReminderConfig()
    const applyReminder = (patch: Record<string, unknown | null>): void => {
      writePluginConfig(CONFIG_KEY, patch)
      reminder = readReminderConfig()
    }
    const offReminder = ctx.prompt.registerProjection(
      'todo-reminder',
      (messages) =>
        appendTodoReminder(messages, {
          enabled: reminder.enabled,
          everyTurns: reminder.everyTurns,
          hasOpenTodos: todos.read().some((item) => item.status === 'pending' || item.status === 'in_progress'),
        }),
      // order 800：排在 env-facts(600) 之后（提醒要落在环境快照之后，也在 drop-images(900) 之前）
      { order: 800 },
    )

    const reminderFields: SettingsField[] = [
      {
        type: 'switch',
        key: 'enabled',
        label: '每过若干回合提醒一次未完成任务',
        help: '开启后，距上次更新任务清单超过设定回合数且清单里还有未完成项时，往下一轮请求末尾补一条提醒。默认关（省 token）。',
      },
      {
        type: 'number',
        key: 'everyTurns',
        label: '每隔几个用户回合提醒一次',
        min: 1,
        max: 100,
        step: 1,
        help: '数值越小提醒越勤、token 花得越多；只在上面那条开着时生效。',
      },
    ]
    const reminderSection: SettingsSectionSpec = {
      id: CONFIG_KEY,
      title: '任务清单',
      subtitle: '未完成任务的节流提醒',
      order: 45,
      fields: () => reminderFields,
      // 每次打开都现读磁盘：手改 plugins.json 也能看到真值。
      values: (): SettingsValues => {
        reminder = readReminderConfig()
        return { enabled: reminder.enabled, everyTurns: reminder.everyTurns }
      },
      save: (key, value): string | void => {
        if (key === 'enabled') {
          applyReminder({ enabled: value === true || value === 'true' })
          return
        }
        if (key === 'everyTurns') {
          const num = Number(value)
          if (!Number.isFinite(num)) return '这里要填一个数字'
          if (num < 1 || num > 100) return '间隔要在 1 到 100 之间'
          applyReminder({ everyTurns: Math.round(num) })
          return
        }
        return `这个分区没有这项：${key}`
      },
    }
    const offReminderSection = ctx.settings.registerSection(reminderSection)

    ctx.commands.register(
      { name: 'todo', args: '[clear]', description: '查看或清空本次任务清单' },
      ({ args, ui }) => {
        if (args[0] === 'clear') {
          service.clearTodos()
          return
        }
        const text = todos.formatForPrompt()
        ui.notice(text === '' ? '当前没有任务清单。' : text)
      },
    )

    ctx.on('dsc/session-open', ({ session }) => {
      const items = session.state('todos')
      todos.clear()
      if (items !== undefined) todos.restore(items)
      touch()
    })

    return () => {
      offReminder()
      offReminderSection()
    }
  },
}
