/**
 * SGR 鼠标事件的分包解析（`\x1b[<b;x;yM` / `\x1b[<b;x;ym`）。
 *
 * 为什么要能解析「一包多条」：ink 的 `useInput` 把**一次 stdin 读取**当成一条 keypress
 * 交给回调（`input` = 整包去掉首个 ESC 的原文）。终端会把连着发生的事件攒在一起发——
 * 快速连点、划过刻度列的运动事件（1003）尤其如此。旧写法（锚定单条的 `/^\[<…$/`）碰上
 * 一包两条就整包匹配失败，于是鼠标事件掉进普通键盘路径：轻则丢事件，重则被读成 Esc
 * （「再按一次 Quit」/「打断回合」）。这里一次取出全部事件，且**只在整包确实都是鼠标
 * 序列时**才认（残留任何别的字符就交回键盘路径，粘贴文本里恰好带 `[<1;2;3M` 也不会被吞）。
 *
 * @module dsc-tui/app/mouse
 */

/** 一条 SGR 鼠标事件。 */
export interface MouseEventBit {
  /**
   * SGR 的 button 原始号（**未拆位**）：
   * 0 左键、1 中键、2 右键、32+n 「按住键 n 拖动」、35 纯移动（1003）、
   * 64/65 纵向滚轮上/下、66/67 横向滚轮。
   */
  button: number
  /** 终端列（1 基，SGR 原样）。 */
  col: number
  /** 终端行（1 基，SGR 原样）。 */
  row: number
  /** `M` = 按下/移动，`m` = 松开。 */
  press: boolean
}

/** 一条 SGR 鼠标序列（不含前导 ESC，ink 已经剥掉第一个）。 */
const PATTERN = '\\[<(\\d+);(\\d+);(\\d+)([Mm])'

/**
 * 把一次输入解析成鼠标事件表；不是「纯鼠标包」返回 null。
 *
 * @param input - `useInput` 给的原文（可能含前导 ESC 或一包多条）。
 */
export function parseMouse(input: string): MouseEventBit[] | null {
  const events: MouseEventBit[] = []
  for (const match of input.matchAll(new RegExp(PATTERN, 'g'))) {
    events.push({
      button: Number(match[1]),
      col: Number(match[2]),
      row: Number(match[3]),
      press: match[4] === 'M',
    })
  }
  if (events.length === 0) return null
  // 残留检查：剔掉鼠标序列与游离的 ESC，还剩字符就不认（例如粘贴进来的一整段文本）。
  const residue = input.replace(new RegExp(PATTERN, 'g'), '').replace(/\x1b/g, '')
  return residue === '' ? events : null
}
