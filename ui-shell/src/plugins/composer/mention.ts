/**
 * @ 文件提及补全（对照桌面渲染层 Composer.tsx 的同名能力）：
 * 输入 `@` 触发，候选是工作区文件（模糊过滤），↑↓ 选、Tab/Enter 补、Esc 关且同 token 不再弹。
 *
 * 文件清单来自 dock 通道的 `fs-list` **懒递归**（展开才取、深度 4、条目 500 封顶），
 * 结果缓存 60 秒——桌面端是主进程遍历 + 60s 缓存，壳这边把遍历放在界面侧做，
 * 口径一致（都没有「目录树实时监听」，超时后下一次触发重扫）。
 *
 * @module dsc-ui-shell/plugins/composer/mention
 */
import { useRef, useState } from 'react'
import type { useHostChannel } from '@dsc/ui'

/** 一次递归列举的规模上限（防大仓库把界面拖死；桌面端遍历同样有预算）。 */
const MAX_FILES = 500
const MAX_DEPTH = 4
/** 清单缓存时长：60 秒内重复触发不再扫盘。 */
const CACHE_MS = 60_000
/** 候选面板最多露几条。 */
const MAX_CANDIDATES = 8

/** 模块级缓存：60 秒内所有 @ 触发共用一份清单。 */
let cache: { at: number; files: string[] } | null = null

/** 递归列举工作区文件（只收文件，不收目录；路径相对 cwd，正斜杠显示）。 */
async function listWorkspaceFiles(channel: ReturnType<typeof useHostChannel>): Promise<string[]> {
  if (cache !== null && Date.now() - cache.at < CACHE_MS) return cache.files
  const files: string[] = []
  let truncated = false
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) {
      truncated = true
      return
    }
    let entries: Array<{ name: string; dir: boolean }> = []
    try {
      const listing = await channel.invoke<{ entries: Array<{ name: string; dir: boolean }> }>('dock', [
        'fs-list',
        { dir },
      ])
      entries = listing.entries ?? []
    } catch {
      return
    }
    for (const entry of entries) {
      const path = dir === '.' ? entry.name : `${dir}/${entry.name}`
      if (entry.dir) {
        // 目录本身不进清单，但目录名参与过滤（路径里带着它）。
        await walk(path, depth + 1)
        if (files.length >= MAX_FILES) return
      } else {
        files.push(path.replaceAll('\\', '/'))
        if (files.length >= MAX_FILES) {
          truncated = true
          return
        }
      }
    }
  }
  await walk('.', 1)
  cache = { at: Date.now(), files }
  void truncated
  return files
}

/** 一个候选：显示路径 + 简单的匹配分（越小越靠前）。 */
function rankFiles(files: readonly string[], query: string): string[] {
  const q = query.toLowerCase()
  const scored: Array<{ path: string; score: number }> = []
  for (const path of files) {
    const lower = path.toLowerCase()
    // 文件名前缀 > 文件名含 > 路径含；其余不要。
    const nameAt = lower.lastIndexOf('/')
    const name = nameAt < 0 ? lower : lower.slice(nameAt + 1)
    let score: number | null = null
    if (q === '') score = 0
    else if (name.startsWith(q)) score = 0
    else if (name.includes(q)) score = 1
    else if (lower.includes(q)) score = 2
    if (score !== null) scored.push({ path, score })
  }
  return scored
    .sort((left, right) => left.score - right.score || left.path.length - right.path.length)
    .slice(0, MAX_CANDIDATES)
    .map((item) => item.path)
}

/** 从光标位置往前找 @token；找到返回（起始下标、已输入的查询词）。 */
function tokenBefore(value: string, caret: number): { from: number; query: string } | null {
  let at = -1
  for (let index = caret - 1; index >= 0; index -= 1) {
    const char = value[index]
    if (char === '@') {
      at = index
      break
    }
    // 空白或换行截断：@token 不跨词。
    if (char === ' ' || char === '\n' || char === '\t') return null
  }
  if (at < 0) return null
  // @ 后面的字符才算查询词；紧跟标点的不算（@path/to 需要支持斜杠）。
  const query = value.slice(at + 1, caret)
  if (query.length > 120) return null
  return { from: at, query }
}

/** @ 补全面板的全部状态与动作（Composer 挂一份）。 */
export interface MentionApi {
  open: boolean
  items: readonly string[]
  loading: boolean
  at: number
  track(value: string, caret: number): void
  move(delta: number): void
  pick(): void
  close(): void
}

export function useMention(options: {
  channel: ReturnType<typeof useHostChannel>
  area: React.RefObject<HTMLTextAreaElement | null>
  apply(next: string, caret: number): void
}): MentionApi {
  const { channel, area, apply } = options
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<readonly string[]>([])
  const [loading, setLoading] = useState(false)
  const [at, setAt] = useState(0)
  /** 最近一次输入的上下文（value/caret/@ 起点/query）：pick 重构文本要用。 */
  const latest = useRef<{ value: string; caret: number; from: number; query: string } | null>(null)
  /** 用户对这个 token 明确按过 Esc：同一个 token 位置不再弹（旧界面同款）。 */
  const dismissed = useRef<string | null>(null)
  /** 当前候选（pick 从这里取选中项，避开 state 时序）。 */
  const current = useRef<readonly string[]>([])

  const track = (value: string, caret: number): void => {
    const token = tokenBefore(value, caret)
    if (token === null) {
      latest.current = null
      if (open) setOpen(false)
      return
    }
    const key = `${token.from}:${token.query}`
    if (dismissed.current === key) return
    latest.current = { value, caret, ...token }
    setOpen(true)
    // 首次触发（或缓存过期）才扫盘；已有清单时先就地过滤，扫完再替换。
    if (cache === null) {
      setLoading(true)
      void listWorkspaceFiles(channel)
        .then((files) => {
          const ranked = rankFiles(files, token.query)
          current.current = ranked
          setItems(ranked)
          setAt(0)
          setLoading(false)
        })
        .catch(() => {
          setLoading(false)
        })
    } else {
      const ranked = rankFiles(cache.files, token.query)
      current.current = ranked
      setItems(ranked)
      setAt(0)
    }
  }

  const move = (delta: number): void => {
    const count = current.current.length
    if (count === 0) return
    setAt((index) => (index + delta + count) % count)
  }

  const close = (): void => {
    const token = latest.current
    if (token !== null) dismissed.current = `${token.from}:${token.query}`
    latest.current = null
    setOpen(false)
  }

  const pick = (): void => {
    const token = latest.current
    const path = current.current[at]
    if (token === null || path === undefined) return
    // 替换 @token 为 @path + 空格，光标落在插入文本之后。
    const before = token.value.slice(0, token.from)
    const after = token.value.slice(token.caret)
    const inserted = `@${path} `
    const next = `${before}${inserted}${after}`
    const caret = token.from + inserted.length
    latest.current = null
    setOpen(false)
    apply(next, caret)
    area.current?.focus()
  }

  return { open, items, loading, at, track, move, pick, close }
}
