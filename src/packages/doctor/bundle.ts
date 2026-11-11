/**
 * 诊断包：把「贴给维护者就能看懂的现场」打成一个文件。
 *
 * **为什么是 gzip 的 JSON 而不是 zip**：仓库没有打包依赖，而 `node:zlib` 是内置的。
 * 一个 `.json.gz` 双击打不开，但解压一条命令就够了；换来的是零新增依赖、字节可预期。
 *
 * **它包含什么**：体检结论、最近若干行日志、最近会话的路径。**不包含**密钥、模型请求正文、
 * 工具输出正文——这三样是「贴出去就会出事」的那部分，宁可让维护者多问一句。
 *
 * @module pneuma/doctor/bundle
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { dscPath } from '@pneuma/runtime/core/path-policy.js'
import { redact } from '@pneuma/runtime/core/redact.js'
import type { HealthReport } from '@pneuma/runtime/services/types.js'
import { appVersion, redactHome } from './checks/util.js'

/** 包里最多放多少行日志：够看出一轮失败的来龙去脉，又不至于把包撑到几十 MB。 */
const LOG_TAIL_LIMIT = 300

/** 会话摘要最多带多少条事件。比日志少一个量级：正文比日志行贵。 */
const EXCERPT_LIMIT = 200

/** 一条事件正文的截断长度。诊断要的是「大概在干什么」，不是全文。 */
const EXCERPT_TEXT_LIMIT = 400

/** 明确写进包里的「没有收什么」，免得收到包的人以为这就是全部。 */
const BASE_EXCLUDED = ['模型密钥原文', '模型请求/响应正文', '工具输出正文', '会话的完整内容']

/** 造包需要的现场。 */
export interface BundleInput {
  /** 体检结果（`ctx.health.run()` 的返回值）。 */
  report: HealthReport
  /** 最近若干行日志（`ctx.log.tail()` 的结果，已脱敏）。 */
  logTail: readonly string[]
  /** 最近会话文件路径；调用方负责只给路径，不给内容。 */
  sessionPaths?: readonly string[]
  /** 会话摘要（`--with-session` 时才给）。已经过脱敏与截断。 */
  sessionExcerpt?: SessionExcerpt
}

/** 会话摘要里的一条事件。只保留「谁、说了什么（截断）、调了什么工具名」。 */
export interface ExcerptEvent {
  role: 'user' | 'assistant' | 'tool' | 'other'
  text?: string
  name?: string
}

/** 一份会话的摘要。 */
export interface SessionExcerpt {
  /** 会话文件路径（家目录会被抹成 `~`）。 */
  file: string
  /** 事件总数（截断前）；`events` 只保留最后若干条。 */
  total: number
  /** 是否因为超过上限被截掉了前面的部分。 */
  truncated: boolean
  events: ExcerptEvent[]
}

/** 截断 + 脱敏一段正文。 */
function clip(text: unknown): string | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  const clean = redact(text)
  return clean.length > EXCERPT_TEXT_LIMIT ? `${clean.slice(0, EXCERPT_TEXT_LIMIT)}…（截断）` : clean
}

/**
 * 读一份会话 JSONL 的摘要。
 *
 * **只读、不解析状态**：`meta` 与 `state` 行直接跳过——诊断要的是对话脉络，
 * 状态正确与否由体检与重放快照各自负责。
 *
 * @param file 会话 JSONL 绝对路径。
 * @param limit 最多保留多少条事件（取最后 N 条）。
 */
export function readSessionExcerpt(file: string, limit = EXCERPT_LIMIT): SessionExcerpt {
  const events: ExcerptEvent[] = []
  let lines: string[]
  try {
    lines = readFileSync(file, 'utf8').split('\n')
  } catch {
    return { file: redactHome(file), total: 0, truncated: false, events: [] }
  }
  for (const line of lines) {
    if (line.trim() === '') continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      // 半截行（崩溃留下的尾巴）跳过，不算错误
      continue
    }
    const type = typeof record['type'] === 'string' ? record['type'] : ''
    if (type === '' || type === 'meta' || type === 'state') continue
    if (type === 'user') events.push({ role: 'user', text: clip(record['text']) })
    else if (type === 'assistant') events.push({ role: 'assistant', text: clip(record['text']) })
    else if (type === 'tool') {
      events.push({
        role: 'tool',
        ...(typeof record['name'] === 'string' ? { name: record['name'] } : {}),
        text: clip(record['text']),
      })
    } else events.push({ role: 'other', name: type })
  }
  const truncated = events.length > limit
  return {
    file: redactHome(file),
    total: events.length,
    truncated,
    events: truncated ? events.slice(-limit) : events,
  }
}

/** 包体的形状。字段名用短名，但这个包是给人看的，所以保留可读性。 */
export interface DiagBundle {
  generatedAt: string
  app: { version: string | null; platform: string; node: string; home: string }
  doctor: {
    at: string
    counts: { ok: number; warn: number; fail: number; skip: number }
    checks: Array<{ id: string; title: string; status: string; summary: string; detail?: string; fix?: string }>
  }
  logs: { lines: number; tail: string[] }
  sessions: { count: number; paths: string[] }
  /** `--with-session` 时才出现：最后若干条对话事件（已脱敏、已截断）。 */
  sessionExcerpt?: SessionExcerpt
  excluded: string[]
}

/**
 * 组装包体（纯函数，不碰磁盘）。
 *
 * 所有字符串都过一遍 {@link redactHome}：家目录里通常带着用户名，贴到 issue 上就是泄漏。
 *
 * @param input 现场。
 */
export function buildBundle(input: BundleInput): DiagBundle {
  const report = input.report
  const clean = (text: string): string => redactHome(text)
  const tail = input.logTail.slice(-LOG_TAIL_LIMIT).map(clean)
  const paths = (input.sessionPaths ?? []).map(clean)
  return {
    generatedAt: new Date().toISOString(),
    app: {
      version: appVersion() ?? null,
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      home: clean(dscPath()),
    },
    doctor: {
      at: new Date(report.at).toISOString(),
      counts: { ok: report.ok, warn: report.warn, fail: report.fail, skip: report.skip },
      checks: report.entries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        status: entry.status,
        summary: clean(entry.summary),
        ...(entry.detail === undefined ? {} : { detail: clean(entry.detail) }),
        ...(entry.fix === undefined ? {} : { fix: clean(entry.fix) }),
      })),
    },
    logs: { lines: tail.length, tail },
    sessions: { count: paths.length, paths },
    ...(input.sessionExcerpt === undefined
      ? {}
      : {
          sessionExcerpt: {
            ...input.sessionExcerpt,
            file: clean(input.sessionExcerpt.file),
            events: input.sessionExcerpt.events.map((event) => ({
              ...event,
              ...(event.text === undefined ? {} : { text: clean(event.text) }),
            })),
          },
        }),
    // 带了会话摘要就不能再说「不含会话内容」，那一项要摘掉，别把说明写成谎话
    excluded: input.sessionExcerpt === undefined ? [...BASE_EXCLUDED] : BASE_EXCLUDED.filter((item) => item !== '会话的完整内容'),
  }
}

/** 落盘文件名：时间到秒，同一秒跑两次会覆盖——足够，不必再加随机后缀。 */
function bundleName(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `dsc-diag-${stamp}.json.gz`
}

/**
 * 把包写进 `~/.dsc/exports/`，返回绝对路径。
 *
 * 目录 0700、文件 0600：包里虽然没有密钥，但仍带着路径与体检细节。
 *
 * @param input 现场。
 * @returns 写好的文件路径。
 */
export function writeBundle(input: BundleInput): string {
  const at = new Date()
  const dir = dscPath('exports')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, bundleName(at))
  const body = Buffer.from(`${JSON.stringify(buildBundle(input), null, 2)}\n`, 'utf8')
  writeFileSync(path, gzipSync(body), { mode: 0o600 })
  return path
}
