/**
 * 两张「请求账单」卡：这一轮用的**系统提示**（⚙）与额外注进上下文的**上下文注入**（⊕）。
 *
 * 为什么要卡片而不是灰字：这两样都不是对话内容（系统提示是请求头、注入是投影往请求里塞的），
 * 但它们决定了模型当时看到什么。摊成正文会把会话流糊满（一份系统提示 15–25KB，注入每轮几千字），
 * 所以只记摘要、只画读数：收起一行说「多大、几段、哪些类」，点开才是对账用的清单。
 *
 * 两张卡都**不画正文**：`SystemPromptView` 里没有正文字段（正文按 hash 去重落在会话 state 里，
 * 卡片条目不携带），`ContextInjectionView` 只带前 200 字预览。这是数据面的决定，界面不去补。
 *
 * 折叠态走 `useFoldState`（与思考行、工具卡同一套）：存档键由调用方给（render.tsx 拼
 * `会话id:行的稳定身份`），切会话重挂时能读回用户上次的选择。
 *
 * @module dsc-ui-shell/plugins/transcript/rows/prompt-card
 */
import type { ReactNode } from 'react'
import { IconChevronDown, createT, type TranscriptEntry } from '@dsc/ui'
import { useFoldState } from '../fold-hook'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../../locale/ui.zh.json'
import en from '../../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 系统提示的卡片视图（条目的 `prompt` 字段）。
 *
 * 类型从条目上就地取，不从契约另转一遍：`@dsc/ui` 的公开面只转出条目本身
 * （`SystemPromptView` 没进 `@dsc/ui-core` 的转出清单），为一个四字段的视图去改公开 API，
 * 所有插件都得跟着重新对表——与 `compaction-row.tsx` 取 `CompactionMark` 同一个理由。
 */
export type SystemPromptView = Extract<TranscriptEntry, { kind: 'system-prompt' }>['prompt']

/** 一条上下文注入的视图（条目 `parts` 里的一项）。 */
export type ContextInjectionView = Extract<TranscriptEntry, { kind: 'context-injection' }>['parts'][number]

/** 一张卡一段里最多列几类注入：与组头「前三类」同一个口径，再多就收进 `+N`。 */
const MAX_KIND_LABELS = 3

/** 收起行里各读数之间的分隔点，前后各一个空格（与阶段组头同一个字面量）。 */
const SEPARATOR = ' · '

/**
 * 字数折算：千位以上用 K（一位小数），千位以下原样。
 *
 * 为什么折算：系统提示动辄五位数，展开表里每一段的字数也要挤在这一列里；
 * 「6234」读起来比「6.2K」慢，而这张卡的用途是瞟一眼量级，不是核到个位。
 *
 * @param chars 字符数（UTF-16 code unit，与契约同口径）
 * @returns `318` / `6.2K` 这样的短写法
 */
function formatChars(chars: number): string {
  if (!Number.isFinite(chars) || chars <= 0) return '0'
  if (chars < 1000) return String(Math.round(chars))
  const kilo = Math.round(chars / 100) / 10
  return Number.isInteger(kilo) ? `${String(kilo)}K` : `${kilo.toFixed(1)}K`
}

/** 系统提示的「N 字」（收起行的总量与展开表每一格共用一条字典）。 */
function promptChars(chars: number): string {
  return t('transcript.prompt.chars', { chars: formatChars(chars) })
}

/** 上下文注入的「N 字」。 */
function injectionChars(chars: number): string {
  return t('transcript.injection.chars', { chars: formatChars(chars) })
}

/**
 * 段来源的给人看的写法：内核三段 / 指令文件 / 某个插件登记的段。
 *
 * `plugin:` 后面跟的是注册 id（见契约 `PromptSectionView.from` 的注释），这里只把前缀摘掉，
 * 不去查注册表——卡片是事后对账用的，当年是哪个插件登记的，日志里就只有这个 id。
 */
function fromText(from: SystemPromptView['sections'][number]['from']): string {
  if (from === 'core') return t('transcript.prompt.fromCore')
  if (from === 'file') return t('transcript.prompt.fromFile')
  return t('transcript.prompt.fromPlugin', { id: from.slice('plugin:'.length) })
}

/**
 * 注入类别的文案表。键是契约 `CONTEXT_INJECTION_KINDS` 的取值（那里是唯一真源，
 * 但它是运行期常量、没有从 `@dsc/ui` 转出来，这边照抄一份字面量）。
 * 表外的类别（以后加的）直接显示原始 kind，不丢数据、也不猜它叫什么。
 */
const KIND_LABEL: Readonly<Record<string, string>> = {
  'env-facts': t('transcript.injection.kind.envFacts'),
  mode: t('transcript.injection.kind.mode'),
  sandbox: t('transcript.injection.kind.sandbox'),
  'todo-reminder': t('transcript.injection.kind.todoReminder'),
  'repeat-reminder': t('transcript.injection.kind.repeatReminder'),
}

/** 一类注入在收起行里的写法（认不出的类别退回原始 kind）。 */
function kindText(kind: string): string {
  return KIND_LABEL[kind] ?? kind
}

/** 一类注入在收起行里的合并读数：同一个 kind 合成一条，字数相加。 */
interface KindCount {
  kind: string
  chars: number
}

/**
 * 按 `kind` 合并注入清单，顺序按**首次出现**（不排序）：
 * 阅读顺序应当反映模型收到这些东西的先后，而不是字母序。
 */
function groupByKind(parts: readonly ContextInjectionView[]): KindCount[] {
  const groups: KindCount[] = []
  const at = new Map<string, number>()
  for (const part of parts) {
    const found = groups[at.get(part.kind) ?? -1]
    if (found === undefined) {
      at.set(part.kind, groups.length)
      groups.push({ kind: part.kind, chars: part.chars })
      continue
    }
    found.chars += part.chars
  }
  return groups
}

/** 收起行的逐类读数：前三类 + 多出来的收进 `+N`。 */
function kindSummary(parts: readonly ContextInjectionView[]): string {
  const groups = groupByKind(parts)
  const shown = groups.slice(0, MAX_KIND_LABELS).map((group) => `${kindText(group.kind)} ${injectionChars(group.chars)}`)
  const rest = groups.length - shown.length
  if (rest > 0) shown.push(t('transcript.injection.more', { count: rest }))
  return shown.join(SEPARATOR)
}

/**
 * 系统提示卡。
 *
 * 收起：`⚙ 系统提示 · 6.2K 字 · 9 段 · <模型>`。
 * 展开：段清单表（段 id / 来源 / 字数，按 `order` 升序）+ 末行 hash 前 8 位。
 * 老会话（`bodyMissing`）没有段清单：展开只给一句说明，**不画空表**——
 * 一张只有表头的空表看着像「界面坏了」，说清「当年没记」比画个空壳诚实。
 *
 * @param props.prompt - 卡片视图（摘要 + 段清单，没有正文）
 * @param props.storeKey - 展开态的存档键（`会话id:行的稳定身份`）；不传就只活在本次挂载里
 */
export function SystemPromptCard({
  prompt,
  storeKey,
}: {
  prompt: SystemPromptView
  storeKey?: string
}): ReactNode {
  const [open, setOpen] = useFoldState(storeKey, false)
  // 按注册时声明的顺序刻度排：`sections` 是拼装顺序，两者通常一致，但刻度才是口径。
  const sections = [...prompt.sections].sort((left, right) => left.order - right.order)
  const toggle = (): void => {
    setOpen(!open)
  }
  return (
    <div className="entry-prompt" data-prompt-hash={prompt.hash} data-open={open ? '1' : undefined}>
      {/* 行头是这一整卡唯一常驻的部分：角色是按钮，键盘 Enter / 空格都能开合。 */}
      <div
        className="entry-prompt-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={open ? t('transcript.prompt.collapseTip') : t('transcript.prompt.expandTip')}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          // 空格按在 div 上默认会滚页面，先挡掉再自己处理（与思考行同款）。
          event.preventDefault()
          toggle()
        }}
      >
        <span className="entry-prompt-glyph" aria-hidden="true">
          ⚙
        </span>
        <span className="entry-prompt-label">{t('transcript.prompt.label')}</span>
        <span className="entry-prompt-dot" aria-hidden="true" />
        <span className="entry-prompt-meta">{promptChars(prompt.chars)}</span>
        <span className="entry-prompt-dot" aria-hidden="true" />
        <span className="entry-prompt-meta">{t('transcript.prompt.sections', { count: sections.length })}</span>
        {prompt.model === undefined || prompt.model === '' ? null : (
          <>
            <span className="entry-prompt-dot" aria-hidden="true" />
            <span className="entry-prompt-model">{prompt.model}</span>
          </>
        )}
        <IconChevronDown size={11} className="entry-prompt-chevron" />
      </div>
      {open ? (
        prompt.bodyMissing === true ? (
          <div className="entry-prompt-missing">{t('transcript.prompt.bodyMissing')}</div>
        ) : (
          <div className="entry-prompt-body">
            <div className="entry-prompt-table">
              <div className="entry-prompt-tr entry-prompt-head-row">
                <span className="entry-prompt-head-cell">{t('transcript.prompt.headId')}</span>
                <span className="entry-prompt-head-cell">{t('transcript.prompt.headFrom')}</span>
                <span className="entry-prompt-head-cell entry-prompt-num">{t('transcript.prompt.headChars')}</span>
              </div>
              {sections.map((section, index) => (
                // 同一段 id 理论上不重复，真重复了（插件登记两次）也不能让 React 撞 key：
                // 下标参与拼键，顺序稳定，展开态与重挂都不受影响。
                <div className="entry-prompt-tr" key={`${section.id}:${String(index)}`}>
                  <span className="entry-prompt-id">{section.id}</span>
                  <span className="entry-prompt-from">{fromText(section.from)}</span>
                  <span className="entry-prompt-num">{promptChars(section.chars)}</span>
                </div>
              ))}
            </div>
            {/* 末行只给 hash 前 8 位：这张卡的存在意义之一是「这一轮用的到底是哪一版提示」，
                完整 hash 拿去跟会话 state 对账即可，显示全串纯属噪音。 */}
            <div className="entry-prompt-hash">{t('transcript.prompt.hash', { hash: prompt.hash.slice(0, 8) })}</div>
          </div>
        )
      ) : null}
    </div>
  )
}

/**
 * 上下文注入卡。
 *
 * 收起：`⊕ 上下文注入 · 环境快照 318 字 · 模式 86 字`（同一 `kind` 合计，超过三类写 `+N`）。
 * 展开：每条一行——来源、注入位置（系统提示 / 请求末尾）、字数、前 200 字预览（灰色单行）。
 *
 * `parts` 为空就什么都不画：那只是因为这一轮什么都没注入（adapter 与落盘都先把空清单挡掉了），
 * 画一张「上下文注入（0）」等于在会话流里凭空多一行。
 *
 * @param props.parts - 这一轮请求的注入清单（按注入顺序）
 * @param props.storeKey - 展开态的存档键；不传就只活在本次挂载里
 */
export function ContextInjectionCard({
  parts,
  storeKey,
}: {
  parts: ContextInjectionView[]
  storeKey?: string
}): ReactNode {
  // 钩子先调、空清单后判：React 要求挂载期内钩子顺序稳定，不能因为清单空了就少调一个。
  const [open, setOpen] = useFoldState(storeKey, false)
  if (parts.length === 0) return null
  const toggle = (): void => {
    setOpen(!open)
  }
  return (
    <div className="entry-injection" data-injection-count={parts.length} data-open={open ? '1' : undefined}>
      <div
        className="entry-injection-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={open ? t('transcript.injection.collapseTip') : t('transcript.injection.expandTip')}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          toggle()
        }}
      >
        <span className="entry-injection-glyph" aria-hidden="true">
          ⊕
        </span>
        <span className="entry-injection-label">{t('transcript.injection.label')}</span>
        <span className="entry-injection-dot" aria-hidden="true" />
        <span className="entry-injection-summary">{kindSummary(parts)}</span>
        <IconChevronDown size={11} className="entry-injection-chevron" />
      </div>
      {open ? (
        <div className="entry-injection-body">
          {/* 按清单原顺序铺，不按 kind 归堆：展开态要和日志里注入的先后一一对上。 */}
          {parts.map((part, index) => (
            <div className="entry-injection-row" key={`${part.kind}:${part.source}:${String(index)}`}>
              <span className="entry-injection-source">{part.source}</span>
              <span className="entry-injection-where">
                {part.where === 'system' ? t('transcript.injection.whereSystem') : t('transcript.injection.whereTail')}
              </span>
              <span className="entry-injection-chars">{injectionChars(part.chars)}</span>
              {part.preview === undefined || part.preview === '' ? null : (
                <span className="entry-injection-preview" title={part.preview}>
                  {part.preview}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
