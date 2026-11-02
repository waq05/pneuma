/**
 * `/review` findings 的纯解析：审查队友交回的汇报被 `<review-findings …>` 包裹写进会话，
 * 这里把它切成「卡头（队友名 / 状态）+ 按条 findings + 引言」，让对话流画成卡片而不是
 * 把整段标记文本当用户消息摆出来。
 *
 * 条目格式是 reviewer 角色提示词里约定死的（`src/core/agent-roles.ts` 的 BUILTIN_FILES.reviewer，
 * 任务书 `reviewTaskText` 里也再写了一遍）：
 *
 * ```
 * ### [P1] 一句话标题
 * 位置：相对路径:行号
 * 说明：……（可多行）
 * 建议：……（可多行，可缺）
 * ```
 *
 * 解析刻意宽松：字段标签认全半角冒号、剥 markdown 加粗与反引号；**解析不动的行原样留进
 * 该条的说明**——宁可把原文多留一行，也不丢内容。整体没被包裹就返回 null（普通消息照旧渲染）。
 *
 * 零 React、零 DOM：探针按 Node 的类型擦除直接 import 本文件逐条钉，所以这里只许
 * `import type`，不许任何运行期依赖。
 *
 * @module dsc-ui-shell/ui-primitives/review-findings
 */

/** 一条 finding 的位置：仓库相对路径 + 可缺省的行号。 */
export interface ReviewFindingLocation {
  path: string
  /** 真实行号；写不出数字（`src/a.ts` 或 `src/a.ts:见下`）时缺省。 */
  line?: number
}

/**
 * 优先级档位：0 = P0（必须修）… 3 = P3（可更好）。
 * 用数字而不是 `'P1'` 字符串：比较与排序直接按大小来，`data-priority` 再拼回 `P0`。
 */
export type ReviewFindingPriority = 0 | 1 | 2 | 3

/** 一条 finding：优先级 + 标题 + 位置 + 说明 + 可缺省的建议。 */
export interface ReviewFinding {
  /** 认不出档位时缺省（`[P7]` 这种写错的不假装它是一档）。 */
  priority?: ReviewFindingPriority
  title: string
  location?: ReviewFindingLocation
  /** 「说明」段（含解析不动、被兜进来的原文）。 */
  detail: string
  /** 「建议」段；队友没写就没有。 */
  suggestion?: string
}

/** 一份解析完的审查汇报。 */
export interface ReviewFindingsView {
  /** 交结论的队友名（`<review-findings teammate="…">`）；没写就是空串。 */
  teammate: string
  /** 收工状态（已完成 / 已停止 / 已失败）；老消息没有这属性。 */
  state?: string
  /** 按文档顺序的条目；队友没发现问题时是空的。 */
  findings: ReviewFinding[]
  /** 第一条之前的自由文字（「未发现问题，查了这些文件…」这类整体说明）。 */
  note: string
}

/** `<review-findings …>` 的整体包裹（只认整段包裹：普通消息不会掺这个标签）。 */
const WRAP_RE = /^\s*<review-findings\b([^>]*)>([\s\S]*)<\/review-findings>\s*$/i

/**
 * 条目头：`### [P2] 标题`（井号 2–4 个，方括号前后允许加粗标记）。
 * `P` 后面只收数字：`[P7]` 也认成一条，优先级记成「认不出」而不是当正文吞掉。
 */
const HEAD_RE = /^#{2,4}\s*\*{0,2}\[P(\d+)\]\*{0,2}\s*(.+?)\s*$/

/** 属性取值：`teammate="reviewer-1"`（前后要有分隔，免得 `xteammate=` 也命中）。 */
function attrOf(attrs: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${key}="([^"]*)"`).exec(attrs)
  return match?.[1]
}

/** 捕获到的数字 → 档位；超出 0–3 就不假装认识。 */
function priorityOf(digits: string): ReviewFindingPriority | undefined {
  const value = Number(digits)
  return value === 0 || value === 1 || value === 2 || value === 3 ? value : undefined
}

/**
 * 字段行：`位置：…` / `说明：…` / `建议：…`。
 * 先剥加粗（`**位置**`）再剥反引号与列表前缀（`- ` / `* `），然后按第一个全/半角冒号切开。
 */
function fieldOf(rawLine: string): { key: string; value: string } | null {
  const line = rawLine.replace(/\*\*/g, '').replace(/`/g, '').replace(/^\s*[*-]\s*/, '').trim()
  const at = line.search(/[：:]/)
  if (at <= 0) return null
  return { key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() }
}

/** 位置值 → `{ path, line? }`：`src/foo.ts:123`；行号不是数字就整段当路径。 */
function parseLocation(value: string): ReviewFindingLocation | undefined {
  // 位置里的全角冒号是手写常见形态（`src/a.ts：12`），先归一成半角再拆
  const text = value.trim().replace(/：/g, ':')
  if (text === '') return undefined
  const at = text.lastIndexOf(':')
  if (at > 0) {
    const line = Number.parseInt(text.slice(at + 1), 10)
    if (Number.isFinite(line) && line > 0) return { path: text.slice(0, at), line }
  }
  return { path: text }
}

/** 多行字段拼接：首行直接放，续行用空格接上（换行会把说明撑成好几段）。 */
function appendLine(current: string, line: string): string {
  if (line === '') return current
  return current === '' ? line : `${current} ${line}`
}

/**
 * 把一条会话消息解析成 {@link ReviewFindingsView}；不是 findings 文档（没被包裹）返回 null。
 *
 * 两段式：先扫出所有条目头的位置（这样每条的内容边界一眼可见），再逐条按字段收内容。
 * 「解析不动的行」按当前打开的字段归位（在建议里就续建议，否则续说明）——审查队友的
 * 说明经常换行写，把它整段塞进兜底会让「说明」和「补一句」拆成两截。
 */
export function parseReviewFindings(text: string): ReviewFindingsView | null {
  const wrapped = WRAP_RE.exec(text)
  if (wrapped === null) return null
  const attrs = wrapped[1] ?? ''
  const body = (wrapped[2] ?? '').trim()
  const teammate = attrOf(attrs, 'teammate') ?? ''
  const state = attrOf(attrs, 'state')

  const lines = body === '' ? [] : body.split('\n')
  const heads: { index: number; priority?: ReviewFindingPriority; title: string }[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const head = HEAD_RE.exec(lines[index] ?? '')
    if (head !== null) {
      heads.push({ index, priority: priorityOf(head[1] ?? ''), title: head[2] ?? '' })
    }
  }

  const base = { teammate, ...(state === undefined ? {} : { state }) }
  // 一条都没有：整段都是引言（「没有发现问题，查了这几个文件」就是这种形态）
  if (heads.length === 0) return { ...base, findings: [], note: lines.join(' ').trim() }

  const findings: ReviewFinding[] = heads.map((head, order) => {
    const start = head.index + 1
    const end = order + 1 < heads.length ? (heads[order + 1]?.index ?? lines.length) : lines.length
    const finding: ReviewFinding = {
      ...(head.priority === undefined ? {} : { priority: head.priority }),
      title: head.title,
      detail: '',
    }
    /** 当前打开的字段：续行往哪里接（null = 还没有字段，落到说明）。 */
    let section: 'detail' | 'suggestion' | null = null
    for (let index = start; index < end; index += 1) {
      const rawLine = lines[index] ?? ''
      const field = fieldOf(rawLine)
      if (field !== null && field.key === '位置') {
        const location = parseLocation(field.value)
        if (location !== undefined) finding.location = location
        section = null
        continue
      }
      if (field !== null && field.key === '说明') {
        section = 'detail'
        finding.detail = appendLine(finding.detail, field.value)
        continue
      }
      if (field !== null && field.key === '建议') {
        section = 'suggestion'
        finding.suggestion = appendLine(finding.suggestion ?? '', field.value)
        continue
      }
      if (rawLine.trim() === '') {
        section = null
        continue
      }
      // 认不出的行：在建议里就续建议，否则兜进说明（宁可多留，不丢内容）
      if (section === 'suggestion') finding.suggestion = appendLine(finding.suggestion ?? '', rawLine.trim())
      else finding.detail = appendLine(finding.detail, rawLine.trim())
    }
    return finding
  })

  const note = lines.slice(0, heads[0]?.index ?? 0).join(' ').trim()
  return { ...base, findings, note }
}
