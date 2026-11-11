/**
 * 待办工具卡的纯逻辑（差距清单 S4 第二批）：`todo_write` 这次写进去的清单长什么样。
 *
 * 数据面**一处都不改**（差距清单的原话：不要为了对齐去改数据面），只读两样现成的东西：
 *
 *  1. **参数**（`packages/todo/index.ts:84-104`）：`todos` 是数组，每项 `{id, content, status,
 *     parent}`，`status` 四态 `pending / in_progress / completed / cancelled`；`merge: true`
 *     时只带被改的那几条。还在跑、或 merge 更新时，参数只说得出一部分。
 *  2. **结果**（`packages/todo/index.ts:115-116` 用 `TodoStore.formatForPrompt()` 拼出来的整表）：
 *
 *     ```
 *     清单已更新（1/3 完成）
 *     [x] a1b2c3 写单测
 *     [>] d4e5f6 跑构建
 *       [ ] g7h8i9 收尾
 *     进度 1/3
 *     ```
 *
 *     四态符号来自 `packages/todo/todo.ts:30-35` 的 `STATUS_MARKS`，子任务按 `parent` 缩进两格
 *     （`todo.ts:131-136`）。**结果优先**：它回显的是整表，merge 模式下参数里根本没有没被改的
 *     那几条；只有结果还没回来时才退回参数。
 *
 * 清空是合法的一次调用（`todo.ts` 的 `write([])` 回「清单已清空。」），不是「没有待办」：
 * 前者是「我刚把它清掉」，后者是「这次调用压根没带清单」——后者不会走到这张卡（`todos`
 * 不是数组，判据不过）。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card/todo-model
 */

/** 走这张卡的工具名（`packages/todo/index.ts:78`）。 */
const TODO_TOOL_NAME = 'todo_write'

/** 四态（与契约的 `TodoStatus` 同一套；`packages/todo/todo.ts:21`）。 */
export type TodoState = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** 清单里的一条（渲染要的字段 + 缩进层级）。 */
export interface TodoRow {
  /** 条目 id（宿主没给时可能是空串，只用来做 key）。 */
  id: string
  /** 一句话动作描述。 */
  content: string
  status: TodoState
  /** 子任务层级（0 = 顶层；由 `parent` 链或结果里的缩进算出）。 */
  depth: number
}

/** 一次 `todo_write` 的参数视图。 */
export interface TodoCall {
  /** 参数里的清单（merge 模式下只有被改的那几条）。 */
  items: TodoRow[]
  /** 是不是按 id 合并（`true` 时参数不是整表）。 */
  merge: boolean
}

/** 渲染用的一份清单：条目 + 进度 + 宿主的提示语。 */
export interface TodoList {
  items: TodoRow[]
  /** 已完成条数（`cancelled` 不计入分母，与 `todo.ts:108-116` 的 progress 同口径）。 */
  done: number
  /** 有效总条数（不含 `cancelled`）。 */
  total: number
  /** 宿主的提示语（「只保留前 64 条」这类校正说明），按出现顺序。 */
  notes: string[]
  /** 这一次是不是把清单清空了。 */
  cleared: boolean
}

/** 四态符号 → 状态（`packages/todo/todo.ts:30-35` 的 `STATUS_MARKS` 反过来读）。 */
const MARK_STATES: Readonly<Record<string, TodoState>> = {
  ' ': 'pending',
  '>': 'in_progress',
  x: 'completed',
  '~': 'cancelled',
}

/** 结果里的条目行：缩进 + `[符号]` + id + 正文（`todo.ts:133`）。 */
const ITEM_RE = /^(\s*)\[([ x>~])\]\s+(\S+)\s+([\s\S]*)$/

/** 结果里的清空回执（`packages/todo/index.ts:115`）。 */
const CLEARED_RE = /^清单已清空。?$/

/** 结果里的提示行（`packages/todo/index.ts:114` 的 `注意：…`）。 */
const NOTE_RE = /^注意：([\s\S]*)$/

/** 结果里的进度行（`todo.ts:139` 的 `进度 1/3`）。 */
const PROGRESS_RE = /^进度 \d+\/\d+$/

/** 子任务缩进按两格一层算（`todo.ts:134` 的 `indent + '  '`）。 */
const INDENT_UNIT = 2

/**
 * 参数是不是一张待办卡：**名字是 `todo_write`** 且**参数里真有 `todos` 数组**。
 *
 * 两条同时成立才算（与终端块、read / search 卡同一条取舍，见 `factory.tsx` 的 `isTerminalCall`）。
 * 数组为空也算：那是「把清单清空」这一次调用，卡上要说「清单已清空」，不能说「没有这张卡」。
 *
 * @param name 工具名
 * @param argsText 模型产出的原始 arguments JSON 字符串
 * @returns 参数视图；不是待办形态时 null（回落通用卡）
 */
export function todoCallOf(name: string, argsText: string): TodoCall | null {
  if (name !== TODO_TOOL_NAME) return null
  if (typeof argsText !== 'string' || argsText === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(argsText) as unknown
  } catch {
    // 半截 JSON：清单还没吐全，等下一次 delta 再判。
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const args = parsed as Record<string, unknown>
  const todos = args['todos']
  if (!Array.isArray(todos)) return null
  return { items: rowsOfArgs(todos), merge: args['merge'] === true }
}

/**
 * 参数里的 `todos` → 渲染行。
 *
 * `parent` 链在这里折叠成 `depth`：渲染层只按层级缩进，不需要知道父是谁。链条断掉（父 id 不在
 * 本次参数里）就按顶层算——merge 模式下这是常态，宿主自己会补齐父链。
 */
function rowsOfArgs(todos: readonly unknown[]): TodoRow[] {
  const raw: { id: string; content: string; status: TodoState; parent: string | null }[] = []
  for (const todo of todos) {
    if (todo === null || typeof todo !== 'object' || Array.isArray(todo)) continue
    const item = todo as Record<string, unknown>
    const content = typeof item['content'] === 'string' ? item['content'].trim() : ''
    // 没有正文的条目宿主自己会丢掉（`todo.ts` 的 normalize），这里同样不画。
    if (content === '') continue
    const id = typeof item['id'] === 'string' ? item['id'] : ''
    raw.push({
      id,
      content,
      status: stateOf(item['status']),
      parent: typeof item['parent'] === 'string' && item['parent'] !== '' ? item['parent'] : null,
    })
  }
  const byId = new Map<string, (typeof raw)[number]>()
  for (const item of raw) if (item.id !== '') byId.set(item.id, item)
  return raw.map((item) => ({ id: item.id, content: item.content, status: item.status, depth: depthOf(item, byId) }))
}

/** 沿 `parent` 往上数层数（最多 8 层：父子链写坏了也不至于把行缩到屏幕外）。 */
function depthOf(
  item: { parent: string | null },
  byId: ReadonlyMap<string, { parent: string | null }>,
): number {
  let depth = 0
  let parent = item.parent
  const seen = new Set<string>()
  while (parent !== null && depth < 8) {
    if (seen.has(parent)) break
    seen.add(parent)
    // 父不在本次参数里（merge 模式的常态）：就按顶层算，别凭一个认不出的 id 给它缩进。
    const up = byId.get(parent)
    if (up === undefined) break
    depth += 1
    parent = up.parent
  }
  return depth
}

/** 状态词 → 四态；不认识的按 `pending`（宿主同样这么归一，`todo.ts:212-216`）。 */
function stateOf(value: unknown): TodoState {
  if (value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'cancelled') return value
  return 'pending'
}

/**
 * 这次调用之后清单长什么样：**结果优先、参数兜底**。
 *
 * 为什么不直接用参数：merge 模式下参数只有被改的那几条，照它画会把整表画残（没被改的条目
 * 凭空消失）。结果回显的是整表，所以只要它认得出来就用它。
 *
 * @param call 参数视图（结果还没回来时的那份兜底）
 * @param resultText 工具结果原文
 */
export function todoListOf(call: TodoCall, resultText: string | undefined): TodoList {
  const parsed = parseResult(resultText)
  if (parsed !== null) return summarize(parsed.items, parsed.notes, parsed.cleared)
  return summarize(call.items, [], false)
}

/** 结果原文解析出来的样子。 */
interface ParsedResult {
  items: TodoRow[]
  notes: string[]
  cleared: boolean
}

/**
 * 解析 `清单已更新（d/t 完成）` 那份整表。
 *
 * 判据同样是**整份形状**：认出一条条目行或一句清空回执才算这份结果是待办回显；否则返回
 * null（工具报错时结果是散文，不能当「0 条待办」画）。进度行与 `注意：` 行只做校验与提示，
 * 进度数字仍按条目自己重算——宿主那份是按「不含 cancelled」算的，两边口径一致，重算更省心。
 */
function parseResult(resultText: string | undefined): ParsedResult | null {
  if (typeof resultText !== 'string' || resultText.trim() === '') return null
  const lines = resultText.replace(/\r\n?/g, '\n').split('\n')
  const items: TodoRow[] = []
  const notes: string[] = []
  let cleared = false
  let recognised = false
  for (const line of lines) {
    if (line.trim() === '') continue
    if (CLEARED_RE.test(line.trim())) {
      cleared = true
      recognised = true
      continue
    }
    if (PROGRESS_RE.test(line.trim())) {
      recognised = true
      continue
    }
    const note = NOTE_RE.exec(line.trim())
    if (note !== null) {
      notes.push((note[1] ?? '').trim())
      continue
    }
    const item = ITEM_RE.exec(line)
    if (item === null) continue
    recognised = true
    const status = MARK_STATES[item[2] ?? ''] ?? 'pending'
    items.push({
      id: item[3] ?? '',
      content: (item[4] ?? '').trim(),
      status,
      depth: Math.floor((item[1] ?? '').length / INDENT_UNIT),
    })
  }
  if (!recognised) return null
  return { items, notes, cleared }
}

/** 收成渲染用的一份：算进度、记住「这一次是不是清空」。 */
function summarize(items: readonly TodoRow[], notes: string[], cleared: boolean): TodoList {
  const counted = items.filter((item) => item.status !== 'cancelled')
  return {
    items: [...items],
    done: counted.filter((item) => item.status === 'completed').length,
    total: counted.length,
    notes: [...notes],
    // 只认回执：还在跑的时候参数里是空数组，那只说明「清单里没有条目」，
    // 不说明「这次调用把它清掉了」——两句话在读者那里意思不同（与终端块不给
    // 跑动中的卡写「退出码 0」同一条道理）。
    cleared,
  }
}
