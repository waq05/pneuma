/**
 * 「文件更改预览」通知的纯解析：宿主在 edit / write 动手之前发的那段**多行纯文本**
 * （`src/plugins/file-review.ts` 的 `renderReview` 拼的），在这里切成头行三件
 * （动作 / 路径 / 计数）与逐行分类，让对话流与轨迹页把它画成一张左对齐的卡片，
 * 而不是一条居中的多行文本（几十行 diff 被 `.entry-system` 居中成一坨的报障）。
 *
 * **为什么在壳里认而不是让宿主换个形状**：那段文本一个字都不能动——同一份条目
 * TUI（ink 界面）也在读，改形状会连带影响它。所以壳按**正文前缀**认这条通知，
 * 前缀常量是 {@link REVIEW_NOTICE_BANNER}，与宿主字面量的漂移由
 * `scripts/ui-review-notice-test.mjs` 钉住（探针直接读宿主源文件比对）。
 *
 * 零 React、零 DOM——探针按 Node 的类型擦除直接 import 这个 .ts 逐条钉
 * （所以这里只许 `import type`，不许任何运行期依赖）。
 *
 * @module dsc-ui-shell/plugins/transcript/review-notice
 */

/**
 * 这条通知的正文前缀（宿主 `src/plugins/file-review.ts` 里头行的起头字面量）。
 * 认通知、切头行都从这里出发：壳与宿主各持一份时，探针比对两处，漂了要红。
 */
export const REVIEW_NOTICE_BANNER = '【文件更改预览·尚未落盘】'

/** 头行里的动作词：新建（文件原先不存在）与修改（定点改动）。 */
export type ReviewAction = 'create' | 'update'

/** 动作词的两档文案（徽章用；别处再抄一份就迟早对不上）。 */
export const REVIEW_ACTION_TEXT: Readonly<Record<ReviewAction, string>> = {
  create: '新建',
  update: '修改',
}

/** 计数：`+N 行 / -M 行` 里那两个数；宿主没给出逐行 diff 时是 null（此时看 countsText）。 */
export interface ReviewCounts {
  added: number
  removed: number
}

/**
 * 一条正文行的种类。
 * `hunk` = `@@` 开头的段头；`add` / `remove` / `context` 就是 unified diff 的三类行
 * （行首 `+` / `-` / 空格前缀原样保留，不再解析语义）；`note` = 不是 diff 的说明行
 * （「内容与磁盘上现在这份完全一样…」「算不出逐行差异」「预览只显示前 N 行…」这类）。
 */
export type ReviewLineKind = 'hunk' | 'add' | 'remove' | 'context' | 'note'

export interface ReviewNoticeLine {
  kind: ReviewLineKind
  /** 原文（含行首前缀，原样上屏——`+`/`-`/空 前缀本来就是 git 的写法）。 */
  text: string
}

/** 一条「文件更改预览」通知拆出来的全部素材。 */
export interface ReviewNotice {
  /** 头行原文（形状认不出时卡片直接摆它，不硬拆）。 */
  head: string
  /** 动作；头行形状不认识时 null。 */
  action: ReviewAction | null
  /** 路径原文（宿主已按它那一侧的工作目录相对化）；头行形状不认识时 null。 */
  path: string | null
  /** 解析出来的增删行数；宿主没给逐行 diff 时 null。 */
  counts: ReviewCounts | null
  /** 头行括号里的计数原文（`+76 行 / -0 行` 或 `逐行 diff 未给出`）；头行不认时 null。 */
  countsText: string | null
  /** 头行之后的正文行（分类但原样保留文本）。 */
  lines: readonly ReviewNoticeLine[]
}

/** 正则元字符转义：前缀是常量拼进正则的，将来有人往常量里加符号不该炸。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 头行形状：`【文件更改预览·尚未落盘】新建 E:/a.md（+76 行 / -0 行）`。
 * `.+` 是贪心的，会找到**最后一个** `（…）`——路径里带全角括号（罕见但合法）也拆不错。
 */
const HEAD_PATTERN = new RegExp(`^${escapeRegExp(REVIEW_NOTICE_BANNER)}(新建|修改) (.+)（([^（）]*)）$`)

/** `+76 行 / -0 行` → 两个数；对不上（「逐行 diff 未给出」等）返回 null。 */
function parseCounts(text: string): ReviewCounts | null {
  const match = /^\+(\d+) 行 \/ -(\d+) 行$/.exec(text)
  if (match === null) return null
  const added = Number(match[1])
  const removed = Number(match[2])
  return Number.isFinite(added) && Number.isFinite(removed) ? { added, removed } : null
}

/** 动作词 → 语义档；认不出给 null（头行不拆，整行摆出来）。 */
function parseAction(verb: string): ReviewAction | null {
  if (verb === '新建') return 'create'
  if (verb === '修改') return 'update'
  return null
}

/**
 * 一条正文行的分类。
 *
 * 判定顺序就是 unified diff 的写法本身（`+` / `-` / 空格 三种前缀），不做语义解析：
 * `（…）` 开头的说明行与 `…（…）` 开头的截断说明按 `note` 走（中性色，不许染成红/绿）；
 * 认不出的行也归 `note`——渲染上它和说明行同档（中性、等宽、左对齐），不会更糟。
 */
export function reviewLineKindOf(line: string): ReviewLineKind {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'remove'
  if (line.startsWith(' ')) return 'context'
  if (line.startsWith('（') || line.startsWith('…')) return 'note'
  return line === '' ? 'context' : 'note'
}

/** 正文是不是这条通知（只看前缀；头行拆不开也照样是它，见 {@link parseReviewNotice}）。 */
export function isReviewNotice(text: string): boolean {
  return text.startsWith(REVIEW_NOTICE_BANNER)
}

/**
 * 把一段正文切成 {@link ReviewNotice}；不是这条通知（前缀对不上）返回 null。
 *
 * 头行形状认不出（例如宿主改了措辞而前缀没变）也**照样返回结构**：`action` / `path` 给
 * null、`head` 原样带着。为什么不退回 null：退回 null 就又把整段交给 `.entry-system`
 * 居中渲染，等于这个报障原样复现；而头行摆一行原文、正文照常分类，最差也只是头行朴素一点。
 */
export function parseReviewNotice(text: string): ReviewNotice | null {
  if (!isReviewNotice(text)) return null
  const at = text.indexOf('\n')
  const head = at === -1 ? text : text.slice(0, at)
  const rest = at === -1 ? '' : text.slice(at + 1)
  const lines: ReviewNoticeLine[] = (rest === '' ? [] : rest.split('\n')).map((line) => ({
    kind: reviewLineKindOf(line),
    text: line,
  }))
  const match = HEAD_PATTERN.exec(head)
  if (match === null) {
    return { head, action: null, path: null, counts: null, countsText: null, lines }
  }
  const countsText = match[3] ?? ''
  return {
    head,
    action: parseAction(match[1] ?? ''),
    // 路径**不 trim**：它原样进 title 与展示，动一个字符就可能是另一个文件
    path: match[2] ?? '',
    counts: parseCounts(countsText),
    countsText,
    lines,
  }
}
