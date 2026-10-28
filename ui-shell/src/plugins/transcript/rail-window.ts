/**
 * 右侧刻度条「当前在第几轮」的判定（纯函数，不碰 DOM）。
 *
 * 为什么从 jump-rail.tsx 抽出来：这里出过一个只有真实会话才复现的错——**子代理汇报**
 * （`internal` 的 user 条目）渲染成一行触发行（`.entry-system`，见 rows/user-row.tsx），
 * 不是用户气泡 `.entry-user`。旧写法用「所有 `.entry-user` 里的最后一条」当"最新一轮"，
 * 于是滑到会话底部时读到的是**上一个有人说话的轮**，高亮就落错了刻度（2026-10-28 用户报障）。
 *
 * 现在两个口径分开：
 *   - 「最新一轮是哪一轮」由调用方从**轮清单**给（`lastRound`），不从 DOM 里数；
 *   - 锚点按 `[data-round]` 收集（每一轮至少有一条行带这个属性），不再只认用户气泡。
 *
 * 零依赖：探针用 Node 的类型擦除直读本文件（同 rounds.ts 的约定），所以**不许有任何
 * 运行期 import**。
 *
 * @module dsc-ui-shell/plugins/transcript/rail-window
 */

/** 一枚锚点：某一轮的首行，`top` 是它在滚动容器内容坐标里的位置。 */
export interface RailAnchor {
  /** 轮号（0 基，与刻度一一对应）。 */
  round: number
  /** 这一轮首行距内容顶端多少像素。 */
  top: number
}

/**
 * 按轮号去重，同一轮只留**第一行**（DOM 顺序即内容顺序，所以第一行就是离这一轮起点最近的）。
 *
 * 为什么不排序：调用方按 DOM 顺序给，本来就是升序；排一次反而把「乱序 = 有毛病」这件事
 * 藏起来。乱序时几何兜底照样能走，只是结果不保证。
 * @param rows - 按 DOM 顺序给出的行（可重复轮号）
 * @returns 每轮一条锚点
 */
export function dedupeByRound(rows: readonly RailAnchor[]): RailAnchor[] {
  const seen = new Set<number>()
  const anchors: RailAnchor[] = []
  for (const row of rows) {
    if (seen.has(row.round)) continue
    seen.add(row.round)
    anchors.push(row)
  }
  return anchors
}

/** 判定当前轮要的输入。 */
export interface RailProbe {
  /** 这一帧是不是贴着底部（阈值由调用方定，与消息流跟随同一档）。 */
  atBottom: boolean
  /** 已画出来的最后一轮的轮号；一轮都没有时给 -1。 */
  lastRound: number
  /** 探针线上命中的轮号（`elementFromPoint` 的结果）；没命中给 null。 */
  hitRound: number | null
  /** 锚点（`dedupeByRound` 的产物，按轮号升序）。 */
  anchors: readonly RailAnchor[]
  /** 探针线在内容坐标里的位置（`scrollTop + 内缩`）。 */
  probeTop: number
}

/**
 * 现在该高亮哪一轮。判据顺序与改之前一致（贴底 → 命中测试 → 几何兜底），
 * 只有「贴底」那一支换了数据源：**用轮清单里的最后一轮，不用 DOM 里最后一个用户气泡**。
 *
 * @param probe - 这一帧的读数
 * @returns 轮号；一枚锚点都没有、又没贴底、也没命中时给 -1（不亮）
 */
export function pickCurrentRound(probe: RailProbe): number {
  // ── 0) 贴底：正在看最新一轮 ──
  // 这一支必须排在命中测试前面：底部往往是一张改动卡 / 轮尾，别人都不带 data-round，
  // 命中测试会落到上一轮的行上。
  if (probe.atBottom && probe.lastRound >= 0) return probe.lastRound

  // ── 1) 命中测试：探针线上是什么，就按它身上的 data-round 认轮 ──
  if (probe.hitRound !== null) return probe.hitRound

  // ── 2) 几何兜底：真实位置与各轮锚点比 ──
  if (probe.anchors.length === 0) return -1
  let current = -1
  for (const anchor of probe.anchors) {
    if (anchor.top <= probe.probeTop) current = anchor.round
    else break
  }
  // ── 3) 还在最顶上：高亮画出来的第一轮，而不是一枚都不亮 ──
  return current === -1 ? (probe.anchors[0]?.round ?? -1) : current
}
