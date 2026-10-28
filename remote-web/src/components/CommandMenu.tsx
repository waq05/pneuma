import type { ReactNode } from 'react'
import type { PhoneCommandView } from '../lib/commands.js'

/**
 * 输入框上方的 `/` 命令候选。
 *
 * 形状照 dsh 的输入提名菜单（title → 英文名 → 右对齐说明，行高 34）：手机屏幕窄，
 * 说明右对齐收边之后左边那一列才读得成一列。图标是内联 SVG——这个项目没有图标库，
 * 只为七个命令引一个进来不值当。
 */
export interface CommandMenuProps {
  rows: readonly PhoneCommandView[]
  /** 高亮行（外接键盘用 ↑↓ 时才会变；手指点哪行就直接采纳那行）。 */
  at: number
  onPick: (command: PhoneCommandView) => void
}

/** 命令名 → 图标。认不出的命令不给图标，行照样画。 */
const GLYPHS: Readonly<Record<string, ReactNode>> = {
  new: <><path d="M4 5h11a2 2 0 0 1 2 2v10H6a2 2 0 0 1-2-2z" /><path d="M17 3v6M14 6h6" /></>,
  compact: <><path d="m12 3 8 4-8 4-8-4z" /><path d="m4 12 8 4 8-4" /><path d="m4 17 8 4 8-4" /></>,
  status: <path d="M3 12h4l2-6 4 12 2-6h6" />,
  usage: <><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></>,
  diff: <><path d="M6 3v18" /><path d="M18 3v18" /><path d="M4 8h4" /><path d="M16 16h4" /></>,
  review: <><path d="m8 6-5 6 5 6" /><path d="m16 6 5 6-5 6" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>,
}

/**
 * 画菜单。
 *
 * @param props 行、高亮位、采纳回调
 * @returns 菜单；没有行时由调用方决定不渲染
 */
export function CommandMenu({ rows, at, onPick }: CommandMenuProps): ReactNode {
  return (
    <div className="cmd-pop" role="listbox" aria-label="命令候选">
      <div className="cmd-section" role="presentation">
        指令
      </div>
      {rows.map((row, index) => (
        <button
          type="button"
          key={row.name}
          role="option"
          aria-selected={index === at}
          className={`cmd-item${index === at ? ' is-on' : ''}`}
          onMouseDown={(event) => {
            // mousedown 抢在 textarea 失焦之前：焦点一丢，键盘会收起来，菜单也白点了。
            event.preventDefault()
            onPick(row)
          }}
        >
          <span className="cmd-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              {GLYPHS[row.name] ?? null}
            </svg>
          </span>
          <span className="cmd-label">{row.label ?? `/${row.name}`}</span>
          {row.label === undefined ? null : <span className="cmd-name">{row.name}</span>}
          <span className="cmd-desc">{row.description}</span>
        </button>
      ))}
    </div>
  )
}
