/**
 * 可点路径的**外壳**：一条路径长得像路径、点下去是「打开预览」——这一层只管外形与提示。
 *
 * 为什么外壳和行为分家：同一个按钮在两处出现，两处的点击语义不同——
 *  - 头行里（`factory.tsx` 的 `OpenPathButton`）：整条头行是展开/收起开关，所以它必须
 *    `event.stopPropagation()` 把冒泡挡掉，否则点路径会顺手把卡折了；
 *  - 展开体里（`search-view.tsx` 的命中文件列表）：卡体本来就不响应点击，没有冒泡要挡，
 *    点了直接开预览。
 *
 * 外形、`data-tc-*` 读数、悬停提示必须一模一样（探针与截图都按这几个类名读），所以标记只在
 * 这里写一份，点击处理由调用方递进来。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card/path-button
 */
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { createT, type ChangedFileView } from '@dsc/ui'
import { displayPathOf } from '@dsc/ui-primitives'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../../locale/ui.zh.json'
import en from '../../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 路径按钮的外壳属性。 */
export interface PathButtonProps {
  /** 要打开的绝对路径（预览页签吃绝对的，见 `file-path.ts`）。 */
  absPath: string
  /** 会话工作目录（显示成相对路径的基准）。 */
  cwd: string
  /** 带上它就开补丁视图（edit / write）；缺省开文件当前内容。 */
  patch?: ChangedFileView | null
  /** 点击（调用方自己决定挡不挡冒泡）。 */
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  /** 按键（调用方自己决定挡不挡冒泡）。 */
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
}

/**
 * 一条可点的路径。
 *
 * 显示形态走 `displayPathOf`（工作目录内→相对路径），与头行其余文字的字体、字号、行高一致；
 * 悬停才加下划线，静息与纯文本无差别（`views.css` 的 `.tc-path-btn`）。
 */
export function PathButton({ absPath, cwd, patch = null, onClick, onKeyDown }: PathButtonProps): ReactNode {
  const opensPatch = patch !== null
  return (
    <button
      type="button"
      className="tc-path tc-path-btn"
      data-tc-open={absPath}
      data-tc-source={opensPatch ? 'patch' : 'file'}
      title={opensPatch ? t('transcript.tool.openPatchTip', { path: absPath }) : t('transcript.tool.openFileTip', { path: absPath })}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {displayPathOf(absPath, cwd)}
    </button>
  )
}
