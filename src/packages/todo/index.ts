/**
 * todo 插件：provide `todo` 服务——模型自己维护、界面实时显示的那张任务清单。
 *
 * 这个功能点由这几块组成，全在自己文件里：
 *   1. 工具 `todo_write`（整表替换或按 id 合并）；
 *   2. 命令 `/todo [clear]`；
 *   3. 界面快照里的 `todos` 那片投影（注册进 surfaces 注册表）；
 *   4. 会话状态条目 `todos`（恢复历史会话时清单跟着回来）与压缩后要原样带过去的清单文本；
 *   5. 「todo-reminder」节流提醒投影（order 800，默认开）：距上次写清单过了 N 轮、
 *      且还有未完成项时，往请求末尾补一条 user 提醒；提醒本身**每 N 轮才注入一次**，
 *      由 `core/todo-reminder-cadence.ts` 的按会话台账把关（提醒不落历史，光靠历史判不了重）。
 *      判定逻辑在 `core/todo-reminder.ts` 与那个台账里（都是纯逻辑，可被探针直读），
 *      配置走本插件的设置分区。
 *
 * 形状抄三家：整表替换与四态来自 Codex 的 `update_plan`（`protocol/src/plan_tool.rs:9-28`）
 * 与 DSH 的 `todo_write`；id / 子任务 / 单调 revision 来自 Hermes（`tools/todo_tool.py:9-32`）。
 *
 * @module dsc/plugins/todo
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { resolvePluginConfig, writePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import { appendTodoReminder, TODO_REMINDER_TEXT } from '@pneuma/runtime/core/todo-reminder.js'
import { TodoReminderCadence, countRounds } from '@pneuma/runtime/core/todo-reminder-cadence.js'
import { InjectionReportLedger } from '@pneuma/runtime/core/context-injection-report.js'
import { TodoStore } from './todo.js'
import { Session } from '@pneuma/runtime/core/session.js'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { SettingsField, SettingsValues, TodoWriteResult } from '@pneuma/runtime/contract.js'
import { CONTEXT_INJECTION_KINDS, contextInjectionPreview } from '@pneuma/runtime/contract.js'
import type { SettingsSectionSpec, TodoService } from '@pneuma/runtime/services/types.js'
import { hostT } from '@pneuma/runtime/core/i18n.js'

/**
 * 设置面文案的取词器：语言来自 `config.yaml` 的 `language:`，字典是本包的
 * `locale/ui.zh.json` / `ui.en.json`（与界面半用同一份文件、同一条判定）。
 */
const t = hostT(import.meta.dirname)

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'todo'

/** 节流提醒的默认值：默认开，每 8 轮提醒一次（口径与理由见 `core/todo-reminder.ts` 的文件头）。 */
const REMINDER_DEFAULTS = { enabled: true, everyRounds: 8 }

/**
 * 从插件配置读节流提醒的开关与间隔，并把间隔夹回 1..100。
 *
 * 2026-10-27 起按「轮」数（一轮 = 一次模型请求），默认开、8 轮一次。
 * 老配置里可能还留着 `everyTurns`，读一次当回退——不迁移、不写盘，等用户下次保存时自然换成新键。
 * `enabled` 只有显式写了 false 才算关：默认开，缺省不该被读成"用户关掉了"。
 */
function readReminderConfig(): { enabled: boolean; everyRounds: number } {
  const raw = resolvePluginConfig(CONFIG_KEY)
  const num = Number(raw.everyRounds ?? raw.everyTurns)
  return {
    enabled: raw.enabled !== false && raw.enabled !== 'false',
    everyRounds: Number.isFinite(num)
      ? Math.min(Math.max(Math.round(num), 1), 100)
      : REMINDER_DEFAULTS.everyRounds,
  }
}

/**
 * 清单工具要的三件事：这次调用归哪条会话、那条会话的清单、写进去并落盘。
 *
 * 为什么打成一个口子：`todo_write` 以前只写内存里那份全局 `TodoStore`，落盘那一步
 * （`appendState`）只挂在界面那条 `writeTodos` 上——工具写的东西根本没进会话日志，
 * 而后台会话/队友调一次又会改掉用户眼前那份清单（P0-7）。
 */
interface TodoTarget {
  /** 这次调用归哪条会话（`ToolContext.sessionId/sessionPath`，缺省按当前查看的）。 */
  sessionOf(runCtx: { sessionId?: string; sessionPath?: string }): Session
  /** 那条会话的清单存储（按会话分表）。 */
  storeFor(session: Session): TodoStore
  /** 写进那条会话的清单并落盘到它自己的 jsonl。 */
  writeInto(session: Session, list: readonly unknown[], merge: boolean): TodoWriteResult
}

/** 任务清单工具：写入即回显整表，模型看到的和用户看到的是同一份。 */
function todoTool(target: TodoTarget, onWrite: () => void): ToolEntry {
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
    async run(args, runCtx) {
      const list = Array.isArray(args.todos) ? args.todos : null
      if (list === null) throw new Error('todos 必须是数组')
      const session = target.sessionOf(runCtx)
      const store = target.storeFor(session)
      const result = target.writeInto(session, list, args.merge === true)
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
    /**
     * 会话 id → 清单存储。**一条会话一份**（P0-7）：全进程一个 store 时，后台会话或队友
     * 写一次就把用户眼前那份清单顶掉，两条会话并行时互相覆盖。建表时按那条会话自己的
     * 日志恢复（`dsc/session-open` 恢复历史会话也走这条路）。
     */
    const stores = new Map<string, TodoStore>()
    const storeFor = (session: Session): TodoStore => {
      const existing = stores.get(session.meta.id)
      if (existing !== undefined) return existing
      const created = new TodoStore()
      created.restore(session.state('todos') ?? [])
      stores.set(session.meta.id, created)
      return created
    }
    /** 当前查看会话的清单存储：界面投影、提示词投影、`/todo` 命令都问它。 */
    const store = (): TodoStore => storeFor(ctx.session.current())
    /**
     * 这次工具调用归哪条会话。判定顺序与 `goal` 包同一套（两边各留一份小函数：可写白名单
     * 只许改这两个文件，不为它单开跨包模块），先按调用方身份、最后才回落到界面：
     *   1. `sessionPath`：先问 agent 名册（常驻会话在里面，零读盘）；名册里没有的——
     *      队友会话由 `subagent` 直接 `Session.create/load`，不登记进名册——按路径读一份
     *      只读视图并缓存，之后的 `appendState` 仍写回这个路径；
     *   2. `sessionId`：名册里按 id 找；
     *   3. 都没有才 `ctx.session.current()`：界面、`/命令` 这类非工具调用路径。
     */
    const loadedByPath = new Map<string, Session>()
    const sessionAtPath = (filePath: string): Session | undefined => {
      const live = ctx.get('agent')?.sessionFor(filePath)
      if (live !== undefined) return live
      const cached = loadedByPath.get(filePath)
      if (cached !== undefined) return cached
      let loaded: Session
      try {
        // keepPath=true：状态要写回读进来的这个路径（队友日志住在 `.teammates` 下；
        // 不传会让 keepPath 的默认逻辑把路径重算到会话根目录，状态就落到另一份新文件里）。
        // lease=false：只读重放，不抢写租约、不修复中断回合、不投递收件箱——解析会话
        // 这一步不许有副作用。文件不存在时 `load` 直接抛错（它从不建空文件），按解析不到处理。
        loaded = Session.load(filePath, true, { lease: false })
      } catch {
        return undefined
      }
      loadedByPath.set(filePath, loaded)
      return loaded
    }
    const sessionOf = (runCtx: { sessionId?: string; sessionPath?: string }): Session => {
      const filePath = runCtx.sessionPath
      if (filePath !== undefined && filePath !== '') {
        const byPath = sessionAtPath(filePath)
        if (byPath !== undefined) return byPath
      }
      const sessionId = runCtx.sessionId
      return (
        (sessionId !== undefined && sessionId !== '' ? ctx.get('agent')?.sessionById(sessionId) : undefined) ??
        ctx.session.current()
      )
    }

    const touch = (): void => ctx.emit('dsc/changed')
    /** 写进指定会话的清单并落盘到它自己的 jsonl（工具与界面两条入口共用）。 */
    const writeInto = (session: Session, list: readonly unknown[], merge: boolean): TodoWriteResult => {
      const result = storeFor(session).write(list, merge)
      session.appendState('todos', result.items)
      touch()
      return result
    }
    const writeTodos = (list: readonly unknown[], merge: boolean) => writeInto(ctx.session.current(), list, merge)

    /**
     * 某条会话的清单提示词（界面投影、`/todo` 与压缩携带共用这一份口径）。
     * 按会话取（P2）：压缩携带传被压缩的那条，不能拿用户眼前那条的清单。
     */
    const todoPromptOf = (session: Session): string => {
      const todos = storeFor(session)
      return todos.empty ? '' : `本次任务清单（当前进度，照它继续，别重建）：\n${todos.formatForPrompt()}`
    }

    const service: TodoService = {
      todoView() {
        const todos = store()
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
        const session = ctx.session.current()
        storeFor(session).clear()
        session.appendState('todos', [])
        ctx.emit('dsc/notice', '任务清单已清空')
        touch()
      },
      todoPrompt() {
        return todoPromptOf(ctx.session.current())
      },
    }
    ctx.provide('todo', service)

    ctx.effect(
      () => ctx.tools.register(todoTool({ sessionOf, storeFor, writeInto }, () => ctx.emit('dsc/changed'))),
      'todo: tools.register',
    )

    ctx.effect(() => ctx.surfaces.register('todos', () => service.todoView()), 'todo: surfaces.register')
    // 压缩摘要会把清单改写走样，所以整表要原样带过去（压缩插件只问注册表要文本）。
    // 带会话：按**被压缩的那条**取清单；拿不到会话时才回落当前查看的（兼容老调用方）。
    ctx.effect(
      () => ctx.compact.registerCarry((session?: Session) => todoPromptOf(session ?? ctx.session.current())),
      'todo: compact.registerCarry',
    )

    // ── 节流提醒投影（默认开）──────────────────────────────────────────────
    // 长会话里模型会把「做完一步就改状态」忘掉，光靠工具说明里的静态叮嘱拉不回来。
    // 这条投影每 N 轮往请求末尾补一条 user 提醒（ZCode 的节流注入思路），
    // 代价是每轮多一条 user 消息的 token，所以只在清单确实有未完成项时才发（默认 8 轮一次）。
    let reminder = readReminderConfig()
    /**
     * 注入节流台账：按会话记住「上一次真的补过提醒的那一轮」。
     *
     * 为什么非有这一笔不可（2026-11-11 核实）：`appendTodoReminder` 的幂等判据查的是
     * **历史里有没有这条提醒**，而提醒是投影注入、不落历史（`core/todo-reminder.ts` 文件头
     * 写了为什么刻意不落）。于是「距上次写清单已 ≥ `everyRounds` 轮」一旦成立，之后每一跳
     * 都满足，**每一跳都再补一次同一句提醒**：白烧 token，而且同一句话反复出现会被模型当
     * 背景音忽略——比不发更糟。判据改成「本轮 − 上次注入的轮 ≥ `everyRounds`」，
     * 台账按会话记（常驻多 agent 各看各的清单与轮次），写法与 `packages/prompt/index.ts`
     * 的 `envSent`（约 :163，只活内存、表满整表清）同一套。
     *
     * 只有真注入了才记账（`appendTodoReminder` 没补的那一跳不动台账）：开关关着、清单里
     * 没有未完成项、距上次写清单还不够 N 轮时它什么也没补，若也跟着记账，下一跳就会被
     * 误判成「刚提醒过」，提醒白白推迟一整个周期。
     */
    const reminderCadence = new TodoReminderCadence()
    /**
     * 提醒上报台账：同一句提醒只在该会话第一次出现时记一张注入卡。
     *
     * 与上面的节流台账**分开记**，两件事的判据不同（与 `envSent` / `envReported` 同一套取舍，
     * 见 `core/context-injection-report.ts` 的文件头）：节流台账回答「这一跳还要不要注入」，
     * 本台账回答「这一跳还要不要长卡」。节流生效后提醒每 N 轮才注入一次，但正文是一句固定的
     * 话——第 2 次注入与第 1 次逐字相同，卡片再记一条并不能告诉读者任何新东西。
     * 注入被跳过的那一跳不产生报告，也不该动本台账。
     */
    const reminderReported = new InjectionReportLedger()
    const applyReminder = (patch: Record<string, unknown | null>): void => {
      writePluginConfig(CONFIG_KEY, patch)
      reminder = readReminderConfig()
    }
    const offReminder = ctx.prompt.registerProjection(
      'todo-reminder',
      (messages, session, report) => {
        // 提醒问**这次请求那条会话**的清单：后台回合的提醒不该报用户眼前那条的进度（P0-7）。
        const owner = session ?? ctx.session.current()
        const todos = storeFor(owner)
        // 轮号取「这条会话已有几条 assistant 消息」：一轮 = 一次模型请求 = 一条 assistant。
        // 不拿 `countRoundsSinceLastTodoWrite` 当轮号——它在每次 todo_write 之后清零，
        // 拿它做周期判据会让提醒越拖越稀（写一次清单，下一次提醒要多等整整一个周期）。
        const round = countRounds(messages)
        if (!reminderCadence.due(owner.meta.id, round, reminder.everyRounds)) return messages
        const out = appendTodoReminder(messages, {
          enabled: reminder.enabled,
          everyRounds: reminder.everyRounds,
          hasOpenTodos: todos.read().some((item) => item.status === 'pending' || item.status === 'in_progress'),
        })
        // 没补就原样返回（`appendTodoReminder` 不注入时返回同一个数组），台账不动。
        if (out === messages) return out
        // 提醒是投影现算的、日志上没有这一句（`session-core/loop.ts:77` 的规矩）：
        // 注入方自己落一条 note，正文就是注入原文，事后回看能对出模型当时多看了什么。
        // 写法照 `packages/lsp/index.ts:219` / `packages/hooks/index.ts:552`。
        owner.appendNote('todo-reminder', TODO_REMINDER_TEXT)
        // 真补了才记账，并且只在「这一跳」记：下一跳轮号 +1，判据就变成「还差 N−1 轮」。
        reminderCadence.mark(owner.meta.id, round)
        // 过一道上报闸：同一句正文只在第一次出现时记一张卡（理由见上面两个台账的注释）。
        if (report !== undefined
          && reminderReported.take(owner.meta.id, CONTEXT_INJECTION_KINDS.todoReminder, TODO_REMINDER_TEXT)) {
          report({
            kind: CONTEXT_INJECTION_KINDS.todoReminder,
            source: 'todo-reminder',
            where: 'user-tail',
            chars: TODO_REMINDER_TEXT.length,
            preview: contextInjectionPreview(TODO_REMINDER_TEXT),
          })
        }
        return out
      },
      // order 800：排在 env-facts(600) 之后（提醒要落在环境快照之后，也在 drop-images(900) 之前）
      { order: 800 },
    )
    ctx.effect(() => offReminder, 'todo: prompt.registerProjection')

    const reminderFields: SettingsField[] = [
      {
        type: 'switch',
        key: 'enabled',
        label: t('field.enabled.label'),
        help: t('field.enabled.help'),
      },
      {
        type: 'number',
        key: 'everyRounds',
        label: t('field.everyRounds.label'),
        min: 1,
        max: 100,
        step: 1,
        help: t('field.everyRounds.help'),
      },
    ]
    const reminderSection: SettingsSectionSpec = {
      id: CONFIG_KEY,
      title: t('section.title'),
      subtitle: t('section.subtitle'),
      order: 45,
      fields: () => reminderFields,
      // 每次打开都现读磁盘：手改 plugins.json 也能看到真值。
      values: (): SettingsValues => {
        reminder = readReminderConfig()
        return { enabled: reminder.enabled, everyRounds: reminder.everyRounds }
      },
      save: (key, value): string | void => {
        if (key === 'enabled') {
          applyReminder({ enabled: value === true || value === 'true' })
          return
        }
        if (key === 'everyRounds') {
          const num = Number(value)
          if (!Number.isFinite(num)) return t('save.notNumber')
          if (num < 1 || num > 100) return t('save.outOfRange')
          applyReminder({ everyRounds: Math.round(num) })
          return
        }
        return t('save.unknownKey', { key })
      },
    }
    const offReminderSection = ctx.settings.registerSection(reminderSection)
    ctx.effect(() => offReminderSection, 'todo: settings.registerSection')

    ctx.effect(() => ctx.commands.register(
      { name: 'todo', args: '[clear]', description: '查看或清空本次任务清单' },
      ({ args, ui }) => {
        if (args[0] === 'clear') {
          service.clearTodos()
          return
        }
        const text = store().formatForPrompt()
        ui.notice(text === '' ? '当前没有任务清单。' : text)
      },
    ), 'todo: commands.register')

    ctx.on('dsc/session-open', ({ session }) => {
      const todos = storeFor(session)
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
