/**
 * web 工具卡的渲染体：头行一枚读数（几条结果 / HTTP 状态码），展开体一份来源清单或抓取摘要。
 *
 * 收起行只说一件事：`3 条结果` 或 `HTTP 404`（{@link WebCount}）。为什么不在头行摆来源标题——
 * 本仓的工具行是一行一条的扁平清单（`scripts/ui-tool-row-flat-test.mjs` 钉着），把标题塞进头行
 * 会把那一行拉成两行，一屏十几条搜索就看不见别的了。标题与摘要在展开体里，链接点开是**系统
 * 浏览器的新窗口**（不是右侧预览页签：来源是互联网上的页面，本机预览打不开它）。
 *
 * 两档分开画（形状对着 dsh 的 `WebBlock.tsx`：答案段 → 来源有序清单 → 截断说明）：
 *  - **搜索**：提供方给的整段摘要（`answer`，可无）+ 来源清单，每条一行标题、一行摘要；零来源
 *    时写「没有结果」——空着的那一块读起来像「还没跑完」，而它其实跑完了；
 *  - **抓取**：一条链接 + 一个状态码，正文不进卡片（网页正文一大段 HTML/纯文本，铺进会话流没有
 *    可读性，模型那边的原文照旧在轨迹页与通用卡里）。
 *
 * 链接只把 http(s) 画成可点：口径与 Markdown 渲染层一致（`ui-primitives/ui/markdown.tsx:561-570`
 * ——外链才新窗口，`javascript:` / `data:` / `file:` 一律退回一段纯文本）。这里的 URL 来自外部
 * 来源，**更不能**让一个 `javascript:` 变成 href。这一条与「有链接就画成链接」的直觉相反，
 * 但点错一次的代价不是样式，是执行别人的脚本。
 *
 * 三种「还没有内容」分开画，不共用一句占位（与 read 卡同一套取舍）：
 *  - 还在跑、结果没回来 → 一句「正在搜索」/「正在抓取」（按调用档位选）；
 *  - 跑完了、但结果认不出（卡片数据不合格、文本兜底放弃、抓取没有卡片数据）→ 摊**结果原文**：
 *    空着那一块最坏的地方不是丑，是让人以为这次调用什么都没拿回来，而原文就在手上
 *    （`call.resultText`）。这条与 read 卡「解析不出结构就画原文」是同一条规矩；
 *  - 搜索零来源 → 「没有结果」+ 宿主尾注（「换个更具体的关键词」这类话是模型回头改方向的关键）。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card/web-view
 */
import type { ReactNode } from 'react'
import { createT, type ToolCallView } from '@dsc/ui'
import { isHttpSource, type WebResult } from './web-model'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../../locale/ui.zh.json'
import en from '../../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 头行那枚读数。
 *
 * 三种说法，按「读者一眼要什么」分：搜索说条数、抓取说状态码、其余什么都不说（没有卡片数据时
 * 头行还有动词与摘要，硬塞一句「正在搜索」会和状态点重复）。
 */
export function WebCount({ result }: { result: WebResult | null }): ReactNode {
  if (result === null) return null
  if (result.kind === 'search') {
    return (
      <span className="tc-web-count">
        {result.sources.length === 0
          ? t('transcript.tool.webNoResult')
          : t('transcript.tool.webResultCount', { count: result.sources.length })}
      </span>
    )
  }
  if (result.statusCode === null) return null
  return <span className="tc-web-count">{t('transcript.tool.webHttp', { code: result.statusCode })}</span>
}

/**
 * web 卡的展开体。
 *
 * @param call 这条工具调用（只读状态：还在跑时给一句占位）
 * @param kind 这次调用的档位（`result` 为 null 时用它挑「正在搜索 / 正在抓取」那句话）
 * @param result 结果视图（还没落地、或形状认不出时是 null）
 */
export function WebBody({
  call,
  kind,
  result,
}: {
  call: ToolCallView
  kind: 'search' | 'fetch'
  result: WebResult | null
}): ReactNode {
  if (result === null) {
    if (call.status !== 'running') {
      /*
       * 跑完了却认不出结果（卡片数据不合格 / 抓取没有卡片数据 / 文本兜底放弃）：摊**原文**，
       * 不画空壳。
       *
       * 为什么不能就地 `return null`：这张卡的判据里有一条是**名字**（`webCallOf` 命中
       * `web_search` / `webfetch`），所以它一定会被选中；展开体再交白卷，读者看到的就是
       * 「点开之后什么都没有」——比一张通用卡还糟，因为通用卡至少把结果摊着。
       * 原文就在 `call.resultText` 上，摊出来一个字都不丢（与 read 卡解析失败时画原文同一条规矩）。
       */
      const raw = typeof call.resultText === 'string' ? call.resultText : ''
      if (raw.trim() === '') return null
      return (
        <div className="tc-web">
          <pre className="tc-web-raw">{raw}</pre>
        </div>
      )
    }
    return (
      <div className="tc-web">
        <p className="tc-web-note">
          {kind === 'search' ? t('transcript.tool.webSearching') : t('transcript.tool.webFetching')}
        </p>
      </div>
    )
  }
  return (
    <div className="tc-web">
      {result.kind === 'search' ? <WebSearchBody result={result} /> : <WebFetchBody result={result} />}
      <WebNotes notes={result.notes} />
    </div>
  )
}

/** 搜索卡的展开体：摘要段 + 来源清单（或「没有结果」）+ 截断说明。 */
function WebSearchBody({ result }: { result: Extract<WebResult, { kind: 'search' }> }): ReactNode {
  return (
    <>
      {result.answer === null || result.answer === '' ? null : (
        /* 摘要没有独立的小标题：`.tc-web-answer` 的段落位置已经说明了它是「答案」，
           再加一行字只是多占一行。`webAnswer` 这个词拿去当悬停说明，英文界面也有话说。 */
        <p className="tc-web-answer" title={t('transcript.tool.webAnswer')}>
          {result.answer}
        </p>
      )}
      {result.sources.length === 0 ? (
        <p className="tc-web-note">{t('transcript.tool.webNoResult')}</p>
      ) : (
        <ol className="tc-web-sources">
          {result.sources.map((source, index) => (
            <li className="tc-web-source" key={`${String(index)}:${source.url}`}>
              {/* 标签取标题、没有标题（或标题是空串）就用 URL：一个字的标题画出来是一条看不见的链接。 */}
              <WebLink url={source.url} label={source.title === null || source.title === '' ? source.url : source.title} />
              {source.snippet === null || source.snippet === '' ? null : (
                /* 摘要按两行封顶（`.tc-web-snippet` 的 `-webkit-line-clamp`），整段挂在悬停说明里。 */
                <div className="tc-web-snippet" title={source.snippet}>
                  {source.snippet}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {result.truncated ? (
        <p className="tc-web-note">{t('transcript.tool.webTruncated', { count: result.sources.length })}</p>
      ) : null}
    </>
  )
}

/** 抓取卡的展开体：一条链接 + 一个状态码 + 截断说明。 */
function WebFetchBody({ result }: { result: Extract<WebResult, { kind: 'fetch' }> }): ReactNode {
  return (
    <>
      <div className="tc-web-fetch">
        <WebLink url={result.url} label={result.url} />
        {result.statusCode === null ? null : (
          <span className="tc-web-status">{t('transcript.tool.webHttp', { code: result.statusCode })}</span>
        )}
      </div>
      {result.truncated ? <p className="tc-web-note">{t('transcript.tool.webContentTruncated')}</p> : null}
    </>
  )
}

/**
 * 一条链接：http(s) 才画成新窗口外链，其余画成同款样子的纯文本。
 *
 * 判据来自模型（`web-model.ts` 的 `isHttpSource`）而不是本文件里再写一条正则：文本兜底解析
 * 「这一行是不是 URL」用的是同一个函数——两处各写一条，迟早出现「解析认了、渲染不认」。
 *
 * 为什么纯文本也用 `.tc-web-link`：样子一样、位置一样，读者不会以为「这条漏了」；但没有 `href`，
 * 点下去什么都不会发生——点不动就别装作能点（`markdown.tsx:561-570` 的同一套判据）。
 */
function WebLink({ url, label }: { url: string; label: string }): ReactNode {
  if (!isHttpSource(url)) return <span className="tc-web-link">{label}</span>
  return (
    <a className="tc-web-link" href={url} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  )
}

/** 宿主的说明（没搜到、只列了前 N 条、内容被截断）：一句一段，一句都不合并。 */
function WebNotes({ notes }: { notes: string[] }): ReactNode {
  if (notes.length === 0) return null
  return (
    <>
      {notes.map((note, index) => (
        <p className="tc-web-note" key={`${String(index)}:${note}`}>
          {note}
        </p>
      ))}
    </>
  )
}
