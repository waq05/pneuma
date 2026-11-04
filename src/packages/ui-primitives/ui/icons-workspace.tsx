/**
 * 工作区那一组的彩色图标（2026-10-25）。
 *
 * 为什么另立一套而不是改 {@link ./icons} 里的线性版：那一套是**全站通用**的字形（侧栏、
 * 文件树、工具卡的 read、技能菜单都借 `IconFolder`），一旦填上颜色，几十处跟着变色；
 * 这一套只服务「工作区」这一个语义：顶栏打开方式组、侧栏工作区行、菜单里的那四条打开方式。
 *
 * 颜色为什么写死 #RRGGBB 而不是令牌：它们读的是**对象本身**的颜色（文件夹是琥珀色、
 * 终端是绿色、VS Code 是蓝色），跟主题的明暗无关；主题里那套 `--dsc-*` 令牌是界面表面的
 * 颜色，换成它反而会让琥珀文件夹在深浅主题之间跳色。同类先例见
 * `file-type-icon.tsx` 里代码文件片的品牌色。
 *
 * 目录图标是**双色**（暗色背板 + 亮色前片）：单色实心块在 15px 上只是一块色斑，
 * 分出前后面才一眼读成「文件夹」。
 *
 * @module dsc-ui-shell/ui-primitives/icons-workspace
 */
import type { CSSProperties, JSX } from 'react'
import { iconSizeStyle } from './icons'

type Props = { size?: number; className?: string }

/** 文件夹背板（暗一档）：闭口时只剩顶上那截页签，开口时整片背板露在里面。 */
const FOLDER_BACK = '#C8801F'
/** 文件夹前片（亮一档）：闭口时的正面、开口时向外翻的那片。 */
const FOLDER_FRONT = '#F3B44C'
/** 终端：绿色。 */
const TERM = '#34A46F'
/** VS Code：官方蓝。 */
const VSCODE = '#2C9CE6'
/** 复制：中性蓝灰（它不是「对象」，用静一点的颜色才不跟另外三条抢）。 */
const COPY = '#7C8BA1'

function svgBase(size: number, className: string | undefined, viewBox: string, children: JSX.Element): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      style={iconSizeStyle(size)}
      viewBox={viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  )
}

/** 闭合的文件夹（琥珀双色）：背板页签 + 前片。 */
export function IconFolderColor({ size = 16, className }: Props): JSX.Element {
  return svgBase(
    size,
    className,
    '0 0 24 24',
    <>
      <rect x="2.5" y="5.4" width="9" height="6.4" rx="2" fill={FOLDER_BACK} />
      <rect x="2.5" y="8.6" width="19" height="11" rx="3.1" fill={FOLDER_FRONT} />
    </>,
  )
}

/** 打开的文件夹（琥珀双色）：背板 + 向外翻的前片。 */
export function IconFolderOpenColor({ size = 16, className }: Props): JSX.Element {
  return svgBase(
    size,
    className,
    '0 0 24 24',
    <>
      <rect x="2.5" y="5.4" width="9" height="6.4" rx="2" fill={FOLDER_BACK} />
      <rect x="2.5" y="8.6" width="19" height="11" rx="3.1" fill={FOLDER_BACK} />
      <path
        d="M3.6 11.8h17.4c.72 0 1.26.68 1.1 1.38l-1.46 5.6c-.23.9-1.04 1.52-1.97 1.52H5.6c-1.2 0-2.13-1.03-1.99-2.22z"
        fill={FOLDER_FRONT}
      />
    </>,
  )
}

/** 终端（绿）：框 + 提示符，框内垫一层同色淡底，凑近才看得出是填色。 */
export function IconTerminalColor({ size = 16, className }: Props): JSX.Element {
  return svgBase(
    size,
    className,
    '0 0 24 24',
    <>
      <rect x="2.9" y="4.4" width="18.2" height="15.2" rx="3.4" fill={TERM} fillOpacity="0.16" />
      <rect
        x="2.9"
        y="4.4"
        width="18.2"
        height="15.2"
        rx="3.4"
        stroke={TERM}
        strokeWidth="1.5"
      />
      <path
        d="m7.2 9.5 2.9 2.5-2.9 2.5"
        stroke={TERM}
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12.7 14.8h4" stroke={TERM} strokeWidth="1.7" strokeLinecap="round" />
    </>,
  )
}

/** VS Code 官方 mark（蓝）：左侧的缺口用 evenodd 挖空，小尺寸下不至于糊成一块蓝。 */
export function IconVSCodeColor({ size = 16, className }: Props): JSX.Element {
  return svgBase(
    size,
    className,
    '0 0 24 24',
    <path
      d="M23.15 2.587 18.21.162a1.494 1.494 0 0 0-1.643.196L3.82 10.02 1.24 7.966 0 8.66v6.68l1.24.694 2.58-2.054 12.747 9.662a1.494 1.494 0 0 0 1.643.196l4.94-2.425A1.5 1.5 0 0 0 24 19.957V4.043a1.5 1.5 0 0 0-.85-1.456ZM18 17.5l-7-5.5 7-5.5v11Z"
      fill={VSCODE}
      fillRule="evenodd"
      clipRule="evenodd"
    />,
  )
}

/** 复制（蓝灰）：两张纸，后面那张是淡底。 */
export function IconCopyColor({ size = 16, className }: Props): JSX.Element {
  return svgBase(
    size,
    className,
    '0 0 24 24',
    <>
      <rect x="8.4" y="3.2" width="11.4" height="13.2" rx="2.8" fill={COPY} fillOpacity="0.18" />
      <rect
        x="8.4"
        y="3.2"
        width="11.4"
        height="13.2"
        rx="2.8"
        stroke={COPY}
        strokeWidth="1.5"
      />
      <path
        d="M15.4 16.4v1.6a2.8 2.8 0 0 1-2.8 2.8H6.6a2.8 2.8 0 0 1-2.8-2.8V9.6a2.8 2.8 0 0 1 2.8-2.8h1.4"
        stroke={COPY}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>,
  )
}
