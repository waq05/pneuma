/**
 * 待办工具卡的渲染体：头行一枚「完成了几条」，展开体一份带勾选状态的清单。
 *
 * 为什么值得一张专用卡：通用卡把一次 `todo_write` 摆成参数表——`todos` 是一整个数组，压成
 * 一行 JSON 之后既看不出哪条做完了，也看不出进度。这里照本仓待办自己的形状画：四态符号
 * 来自 `packages/todo/todo.ts:30-35`（`[ ]` / `[>]` / `[x]` / `[~]`），子任务按层级缩进
 * （`todo.ts:131-136`），进度口径与状态面板那一份一致（不含 `cancelled`，`todo.ts:108-116`）。
 *
 * 勾选状态是**只读**的：模型的清单只有模型能改（改它得走一次工具调用），这里画成勾选框是为了
 * 一眼扫出进度，不是为了点。所以用 `<span>` + `data-status`，不是 `<input type="checkbox">`——
 * 一个点不动的 checkbox 比一个画出来的勾更让人搓火。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card/todo-view
 */
import type { CSSProperties, ReactNode } from 'react'
import { createT } from '@dsc/ui'
import type { TodoList, TodoRow } from './todo-model'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../../locale/ui.zh.json'
import en from '../../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 头行那枚进度读数（外加「正在做的那一条」）。
 *
 * 为什么把进行中的那条搬到头行：一份清单最想知道的永远是「现在在干嘛」。展开体里有全表，
 * 但收起态那一行也得说得出这句话，否则读者要为了看一眼进度挨张点开。
 */
export function TodoProgress({ list }: { list: TodoList }): ReactNode {
  const active = list.items.find((item) => item.status === 'in_progress')
  return (
    <>
      {list.total === 0 ? null : (
        <span className="tc-todo-progress">{t('transcript.tool.todoProgress', { done: list.done, total: list.total })}</span>
      )}
      {active === undefined ? null : (
        <span className="tc-todo-active" title={active.content}>
          {active.content}
        </span>
      )}
    </>
  )
}

/**
 * 展开体的清单。
 *
 * @param list 清单（条目已带层级与状态）
 */
export function TodoBody({ list }: { list: TodoList }): ReactNode {
  if (list.cleared) {
    return (
      <div className="tc-todo" data-todo-empty="1">
        <p className="tc-todo-note">{t('transcript.tool.todoCleared')}</p>
      </div>
    )
  }
  if (list.items.length === 0) {
    return (
      <div className="tc-todo" data-todo-empty="1">
        <p className="tc-todo-note">{t('transcript.tool.todoEmpty')}</p>
      </div>
    )
  }
  return (
    <div className="tc-todo">
      <ul className="tc-todo-list">
        {list.items.map((item, at) => (
          <TodoLine item={item} key={`${item.id === '' ? '#' : item.id}:${String(at)}`} />
        ))}
      </ul>
      <div className="tc-todo-meta">
        <span className="tc-todo-done">{t('transcript.tool.todoProgress', { done: list.done, total: list.total })}</span>
      </div>
      {list.notes.length === 0 ? null : <p className="tc-todo-note">{list.notes.join('；')}</p>}
    </div>
  )
}

/** 一条：勾选框 + 正文（子任务靠 `--tc-todo-depth` 缩进）。 */
function TodoLine({ item }: { item: TodoRow }): ReactNode {
  return (
    <li
      className="tc-todo-item"
      data-status={item.status}
      style={{ '--tc-todo-depth': String(item.depth) } as CSSProperties}
    >
      <span className="tc-todo-box" aria-hidden="true" />
      <span className="tc-todo-text">{item.content}</span>
    </li>
  )
}
