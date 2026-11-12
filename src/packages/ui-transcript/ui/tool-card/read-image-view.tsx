/**
 * `read_image` 工具卡的渲染体：头行一枚 MIME + 大小的读数，展开体一张可点的缩略图。
 *
 * 为什么展开体要**按路径现读**、而不是把字节跟着结果带下来：图片 base64 之后会膨胀约三分之一
 * （`image-tool.ts:30-31` 的 6MB 红线就是照这个定的），塞进界面契约等于每次会话快照都驮着
 * 约 8MB。这里只在卡片展开时向宿主现要一次（`dock` 的 `fs-read`，
 * `src/packages/desktop-dock/index.ts:467-489`）：挂着不看，就不读盘。
 *
 * 两块分工：
 *  - {@link ReadImageBadge} 挂在头行，只说 `PNG · 12.1 KB`。头行那条**可点路径**由装配侧画
 *    （`factory.tsx` 的 `fileTargetOf` → `IntendedPreview` → `OpenPathButton`），这里不重复画按钮；
 *  - {@link ReadImageBody} 挂在展开体：一张 `img`（尺寸由图自己 onLoad 报上来）+ 一行
 *    `宽×高`。点图开右侧预览页签（那边本来就能画图，也是「用系统程序打开」的入口），
 *    键盘用户走同样的路。
 *
 * 四种状态各占一格，不共用一句占位：还在读 / 图超过宿主 5MB 预览上限 / 读不到或不是图片 /
 * 成功。第三格把「可能不在工作目录里」与「浏览器里没有 dock」合并成一句——两种情况的下一步
 * 都是「点上方路径用系统程序打开」，提示拆成两句只会让人多点一次。
 *
 * 为什么读盘只能落在 `useEffect` 里：展开体只在卡展开时才挂载（`factory.tsx:485-486`），
 * 渲染函数体要能被 React 反复调用（并发渲染会重放），在那里发 invoke 就是一次渲染一次磁盘读。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card/read-image-view
 */
import { useEffect, useState, type ReactNode } from 'react'
import { createT, setDockPreview, useHostChannel, type ToolCallView } from '@dsc/ui'
// 文件大小的读数口径与文件树、预览面板、输入区附件同一份（`ui-primitives/ui/sizes.ts`）。
import { formatBytes } from '@dsc/ui-primitives'
import { absPathOf } from './file-path'
import { stateOfRead, type DockFsRead, type ImageState, type ReadImageCall, type ReadImageFacts } from './read-image-model'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../../locale/ui.zh.json'
import en from '../../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * MIME 的短格式：`image/png` → `PNG`，`image/svg+xml` → `SVG+XML`。
 *
 * 头行那一条已经挤着动词、路径、状态，`image/png` 这十个字符比整条摘要还长。认不出斜杠
 * （宿主写了别的形状）就原样交回去，不擅自补前缀。
 */
function shortMimeOf(mime: string): string {
  const slash = mime.indexOf('/')
  if (slash < 0 || slash === mime.length - 1) return mime
  return mime.slice(slash + 1).toUpperCase()
}

/**
 * 文件名：按两种分隔符取最后一段。
 *
 * 不引 node 的 `path`：这是界面包，浏览器里没有它（`file-path.ts` 同样只做字符串拼接）。
 * 路径以分隔符收尾（异常输入）时退回整条原文，不返回空串——`alt` 空着比显示一条长路径更糟。
 */
function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  const last = parts[parts.length - 1]
  return last === undefined || last === '' ? path : last
}

/**
 * 头行那枚读数：`PNG · 12.1 KB`。
 *
 * 结果还没落地（解析不出事实）时**什么都不画**：空着一枚读数比画一个「0 B」诚实——后者会被读成
 * 「这张图是空的」。
 */
export function ReadImageBadge({ facts }: { facts: ReadImageFacts | null }): ReactNode {
  if (facts === null) return null
  return (
    <span className="tc-shot-badge">
      {t('transcript.tool.imageMeta', { mime: shortMimeOf(facts.mime), size: formatBytes(facts.bytes) })}
    </span>
  )
}

/**
 * 图片卡的展开体。
 *
 * @param call 这条工具调用（只读 `status`：还在跑就先不读盘）
 * @param image 参数视图（图片路径原文）
 * @param cwd 会话工作目录：相对路径拼绝对的基准，也是预览页签的基准
 */
export function ReadImageBody({ call, image, cwd }: { call: ToolCallView; image: ReadImageCall; cwd: string }): ReactNode {
  const channel = useHostChannel()
  const absPath = absPathOf(image.path, cwd)
  const [state, setState] = useState<ImageState>({ kind: 'loading' })
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null)
  /**
   * 只在调用**落定**之后才读盘，而且「落定」只认 done / failed 两种：
   *
   * - `running` 时结果回执还没到，图片可能根本没落地，按路径读多半读到「不存在」，画一句
   *   「读不到」再在下一秒换成图片，等于自己制造一次闪错；
   * - `rejected`（用户拒了这次读图）与 `aborted`（中途打断）都**不是**落定：那两种情况下
   *   工具根本没把图读进来，卡里再去读盘、还画出一张图，等于绕过用户的拒绝给他看内容。
   *   这两种状态停在「正在读取图片」上不对，所以它们一律走「读不到」那一格。
   */
  const settled = call.status === 'done' || call.status === 'failed'

  useEffect(() => {
    // 换文件时尺寸必须清掉：上一张图的「宽×高」留在新图上就是一句假读数。
    setDims(null)
    if (!settled) {
      // 非落定的状态（跑着 / 被拒 / 被打断）都不读盘：那几种情况下这张卡不该出现图片。
      setState({ kind: 'unavailable' })
      return undefined
    }
    setState({ kind: 'loading' })
    let on = true
    void channel
      .invoke<DockFsRead>('dock', ['fs-read', { file: absPath }])
      .then((raw) => {
        if (on) setState(stateOfRead(raw))
      })
      .catch(() => {
        // 「路径超出工作目录」与「浏览器里没有 dock 通道」都落这一支。宿主那句中文不原样摊出来：
        // 它是契约外的字（翻不了），而读者要的下一步只有一句——点上方路径用系统程序打开。
        if (on) setState({ kind: 'unavailable' })
      })
    return () => {
      on = false
    }
  }, [absPath, settled, channel])

  const open = (): void => {
    setDockPreview({ path: absPath, cwd })
  }

  return (
    <div className="tc-shot">
      {state.kind === 'loading' ? <p className="tc-shot-note">{t('transcript.tool.imageLoading')}</p> : null}
      {state.kind === 'tooLarge' ? <p className="tc-shot-note">{t('transcript.tool.imageTooLarge')}</p> : null}
      {state.kind === 'unavailable' ? <p className="tc-shot-note">{t('transcript.tool.imageUnavailable')}</p> : null}
      {state.kind === 'image' ? (
        <>
          {/* 图本身就是按钮：点它开右侧预览页签。`role` / `tabIndex` / Enter/Space 三件齐了，
              键盘用户与鼠标用户走同一条路（`path-button.tsx` 用原生 button，这里没有 button
              可用——缩略图是 `img`）。 */}
          <img
            className="tc-shot-img"
            src={`data:${state.mime};base64,${state.base64}`}
            alt={baseNameOf(absPath)}
            role="button"
            tabIndex={0}
            onClick={open}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              // Space 默认会滚动页面：当成按钮激活就必须先拦掉。
              event.preventDefault()
              open()
            }}
            onLoad={(event) => {
              // 尺寸以图自己报的为准（自然像素），不按文件大小或扩展名猜。
              const target = event.currentTarget
              if (target.naturalWidth <= 0 || target.naturalHeight <= 0) return
              setDims({ width: target.naturalWidth, height: target.naturalHeight })
            }}
            onError={() => {
              // 解不出来的图（文件被改成了别的格式、字节坏了）：退回「读不到」那一格，
              // 别留一个破碎图标在那儿——它看着像界面坏了，实际是这张图读不了。
              setState({ kind: 'unavailable' })
            }}
          />
          {dims === null ? null : (
            <div className="tc-shot-meta">
              {t('transcript.tool.imageDims', { width: dims.width, height: dims.height })}
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
