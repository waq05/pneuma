/**
 * 检索工具卡的渲染体：头行一枚命中读数，展开体按文件列命中（路径可点、逐条带行号）。
 *
 * 收起行只说「命中了多少」：`3 处 · 2 个文件`（grep）或 `2 个文件`（glob）。为什么不在头行
 * 摆文件名——本仓的工具行是一行一条的扁平清单（`scripts/ui-tool-row-flat-test.mjs` 钉着），
 * 文件名列表塞进头行会把那一行拉成两行，一屏十几条检索就看不见别的了。文件名与逐条命中都在
 * 展开体里，路径是**可点**的（点开右侧预览页签），这是这张卡的主要用途：从命中直接跳到文件。
 *
 * 三种形态分开画：
 *  - **有命中**：文件分组 + 每组一行一处命中（行号一列，内容一列），高度封住内部滚动；
 *  - **没有匹配**：一句「没有匹配：pattern」+ 宿主的尾注（「已跳过 3 个受保护文件」这类，
 *    那句话是模型回头改方向的关键，不能省）；
 *  - **还没有结果**（还在跑）：一句「正在检索」，跑完再换内容。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card/search-view
 */
import type { ReactNode } from 'react'
import { createT, setDockPreview, type ToolCallView } from '@dsc/ui'
import { absPathOf } from './file-path'
import { PathButton } from './path-button'
import type { SearchCall, SearchResult } from './search-model'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../../locale/ui.zh.json'
import en from '../../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 头行那枚命中读数。
 *
 * 没有命中时写「没有匹配」而不是留空：空着的那一行读起来像「工具还没跑完」，而实际上它跑完了、
 * 只是没找到——这两件事在读者那里结论完全相反。
 */
export function SearchCount({ result }: { result: SearchResult }): ReactNode {
  if (result.empty) {
    return (
      <span className="tc-hit-count" data-hit-empty="1">
        {t('transcript.tool.searchNoMatch')}
      </span>
    )
  }
  if (result.total === 0) return null
  return (
    <span className="tc-hit-count">
      {result.kind === 'files'
        ? t('transcript.tool.searchFiles', { count: result.files.length })
        : t('transcript.tool.searchHits', { total: result.total, files: result.files.length })}
    </span>
  )
}

/** 展开体里的命中清单属性。 */
export interface SearchBodyProps {
  /** 这条工具调用（只读状态与结果原文）。 */
  call: ToolCallView
  /** 参数视图（模式、检索根）。 */
  search: SearchCall
  /** 结果解析；结果为空时是 null。 */
  result: SearchResult | null
  /** 会话工作目录：检索根相对它的基准，也是路径显示成相对形式的基准。 */
  cwd: string
}

/** 检索卡的展开体。 */
export function SearchBody({ call, search, result, cwd }: SearchBodyProps): ReactNode {
  // 结果里的路径相对**检索根**（`search-tools.ts:312`），不是相对会话工作目录。
  const base = search.root === null ? cwd : absPathOf(search.root, cwd)
  if (result === null) {
    if (call.status !== 'running') return null
    return (
      <div className="tc-search">
        <p className="tc-search-note">{t('transcript.tool.searchWaiting')}</p>
      </div>
    )
  }
  if (result.empty || result.files.length === 0) {
    return (
      <div className="tc-search" data-search-empty="1">
        <p className="tc-search-none">{t('transcript.tool.searchNone', { pattern: search.pattern })}</p>
        {result.notes.length > 0 ? <p className="tc-search-note">{result.notes.join(' ')}</p> : null}
      </div>
    )
  }
  return (
    <div className="tc-search">
      <div className="tc-search-files">
        {result.files.map((file) => {
          const absPath = absPathOf(file.path, base)
          return (
            <div className="tc-search-file" key={file.path}>
              <div className="tc-search-file-head">
                <PathButton
                  absPath={absPath}
                  cwd={cwd}
                  onClick={() => {
                    setDockPreview({ path: absPath, cwd })
                  }}
                />
                {file.hits.length === 0 ? null : (
                  <span className="tc-search-file-count">{t('transcript.tool.searchFileHits', { count: file.hits.length })}</span>
                )}
              </div>
              {file.hits.length === 0 ? null : (
                <ul className="tc-search-hits">
                  {file.hits.map((hit) => (
                    <li className="tc-search-hit" key={`${String(hit.line)}:${hit.text}`}>
                      {hit.line === null ? null : (
                        <span className="tc-search-line" aria-hidden="true">
                          {hit.line}
                        </span>
                      )}
                      <code className="tc-search-text">{hit.text}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>
      {result.notes.length > 0 ? <p className="tc-search-note">{result.notes.join(' ')}</p> : null}
    </div>
  )
}
