/**
 * 来源层「读与归一化」的单元测试：把 GitHub / 飞书两种来源里**不碰子进程与网络**的那半层
 * （触发器归一化、只读上下文读取、出站通道、轮询小工具、准入窗口）逐条钉住。
 *
 * 为什么值得钉：这些函数判错都不抛异常，只会把「模型看到的文本 / 回复发到哪 / 轮询该不该继续」
 * 悄悄换个值。比如 `githubAddress` 把 `pull` 当成 `issues`、`historyText` 把富文本丢了、
 * `sendGithub` 的幂等标记少写一个字符，症状都不是报错，而是「回了两次」「模型收到一份
 * 错的历史」。
 *
 * 假的只有 `Commands`（`fakeCommands()`，按 API 路径喂数据）与 `SourceContext` 的极小切片；
 * 被测模块、zod schema、`CliError` 判定全是源码。不发 HTTP、不跑 gh / lark-cli、不读 ~/.dsc。
 *
 * @module @pneuma/superagent/tests/sources-read
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AttachmentStore, setAttachmentStoreForTest } from '../../../core/attachments.js'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import { CliError, type Commands } from '../infra/commands.js'
import type { ChannelRef, OutboundMessage, Thread, Ticket, Trigger } from '../core/index.js'
import type { SourceContext } from '../sources/host.js'
import { health } from '../sources/host.js'
import {
  admissionContext,
  threadWindow,
} from '../sources/admission-context.js'
import {
  ciCounts,
  ciFact,
  ciFailures,
  ciSummary,
  githubThreadContext,
  pullChecks,
  readGithub,
  readRepositoryPath,
} from '../sources/github-read.js'
import {
  branchCiTrigger,
  ciTrigger,
  commentTrigger,
  githubAddress,
  githubChannel,
  githubPage,
  isHumanLogin,
  issueTrigger,
  mentions,
  pullTrigger,
  reviewPlace,
  UserSchema,
  type GithubComment,
} from '../sources/github-trigger.js'
import {
  feishuChannel,
  feishuParent,
  feishuRef,
  feishuThreadId,
  feishuTime,
  feishuTrigger,
  feishuTriggerId,
  historyEvent,
  historyText,
  topicEvent,
  withMentionNames,
} from '../sources/feishu-trigger.js'
import {
  feishuRead,
  feishuReferences,
  feishuResource,
  feishuThreadContext,
  feishuView,
  readFeishu,
  readFeishuLink,
} from '../sources/feishu-read.js'
import {
  agentPull,
  claimPull,
  observePull,
  pullEndNotices,
  pullOf,
  pullsOf,
  readPull,
  ticketBranch,
  type Pull,
} from '../sources/github-pull.js'
import { githubLink, sendGithub } from '../sources/github-channel.js'
import { feishuChatLink, feishuLink, sendFeishu } from '../sources/feishu-channel.js'
import { admissionImageKeys, readAdmissionImage } from '../sources/feishu-image.js'
import { cursorAt, pause, POLL_HORIZON_MS, polled, pollThreads } from '../sources/poll.js'

// ── 假的 Commands ───────────────────────────────────────────────────────────

interface ApiCall {
  path: string
  flags: string[]
}
type ApiHandler = (path: string, flags: string[]) => unknown
type PagesHandler = (path: string) => unknown[]
type LarkHandler = (args: string[], cwd?: string) => unknown

interface FakeOptions {
  repository?: string
  api?: ApiHandler
  pages?: PagesHandler
  lark?: LarkHandler
}

/**
 * 造一个 `Commands` 假件：`api` / `pages` / `lark` 按调用路径交给调用方给的函数，
 * 没给处理函数的路径当场抛错——少准备一条数据必须红，而不是返回 undefined 让用例装绿。
 * `gh` / `run` 一律抛错：万一实现绕过 `api` 直接跑子进程，这里立刻失败（不联网）。
 */
function fakeCommands(options: FakeOptions = {}) {
  const repository = options.repository ?? 'acme/widgets'
  const calls = {
    api: [] as ApiCall[],
    pages: [] as string[],
    lark: [] as { args: string[]; cwd?: string }[],
    signals: [] as (AbortSignal | undefined)[],
  }
  const commands = {
    calls,
    repository,
    deployment: {
      repository,
      github: { cli: 'gh', login: 'agent', noreply: '7+agent@users.noreply.github.com' },
      feishu: { cli: 'lark-cli', appId: 'cli_app', brand: 'feishu' as const, botId: 'ou_bot', name: 'Bot' },
    },
    withSignal(signal?: AbortSignal) {
      calls.signals.push(signal)
      return commands
    },
    async api(schemaOrPath: unknown, ...rest: unknown[]): Promise<unknown> {
      const raw = typeof schemaOrPath === 'string'
      const path = raw ? (schemaOrPath as string) : ((rest[0] as string | undefined) ?? '')
      const flags = (raw ? rest : rest.slice(1)) as string[]
      calls.api.push({ path, flags })
      const handler = options.api
      if (!handler) throw new Error(`测试假件没有 api 处理函数（${path}）`)
      const value = await handler(path, flags)
      if (raw) return value
      return (schemaOrPath as { parse(value: unknown): unknown }).parse(value)
    },
    async pages(item: { safeParse(value: unknown): { success: boolean; data?: unknown } }, path: string, tally?: { skipped: number }) {
      calls.pages.push(path)
      const handler = options.pages
      if (!handler) throw new Error(`测试假件没有 pages 处理函数（${path}）`)
      const rows = handler(path)
      const parsed = rows.flatMap(row => {
        const result = item.safeParse(row)
        return result.success ? [result.data] : []
      })
      if (tally) tally.skipped += rows.length - parsed.length
      return parsed
    },
    async lark(args: string[], cwd?: string) {
      calls.lark.push({ args, cwd })
      const handler = options.lark
      if (!handler) throw new Error('测试假件没有 lark 处理函数')
      return handler(args, cwd)
    },
    async gh(): Promise<never> {
      throw new Error('测试假件不执行 gh 子进程')
    },
    async run(): Promise<never> {
      throw new Error('测试假件不执行子进程')
    },
  }
  return commands as unknown as Commands & { calls: typeof calls; deployment: unknown }
}

const apiWith = (table: Record<string, unknown>): ApiHandler => (path) => {
  if (!(path in table)) throw new Error(`意外的 api 路径：${path}`)
  return table[path]
}
const pagesWith = (table: Record<string, unknown[]>): PagesHandler => (path) => {
  if (!(path in table)) throw new Error(`意外的 pages 路径：${path}`)
  return table[path]
}

// ── 公共数据 ────────────────────────────────────────────────────────────────

const user = (login = 'carol', type = 'User') => ({ login, type, id: 5 })

/** 一条 GitHub 评论 / Issue 共用的最小合法记录。 */
const comment = (over: Record<string, unknown> = {}) => ({
  id: 1,
  body: 'hello',
  user: user(),
  html_url: 'https://github.com/acme/widgets/issues/12#issuecomment-1',
  created_at: '2026-09-09T00:00:01Z',
  updated_at: '2026-09-09T00:00:01Z',
  ...over,
})

const issue = (over: Record<string, unknown> = {}) => ({
  ...comment(),
  number: 12,
  title: 'A bug',
  state: 'open',
  created_at: '2026-09-09T00:00:01Z',
  html_url: 'https://github.com/acme/widgets/issues/12',
  ...over,
})

const trigger = (over: Partial<Trigger> = {}): Trigger => ({
  id: 'trig-1',
  source: 'github',
  threads: [{ source: 'github', id: '12' }],
  actor: { source: 'github', id: 'carol' },
  human: true,
  at: '2026-09-09T00:00:01.000Z',
  text: 'hello',
  meta: {},
  ...over,
})

// ── github-trigger：URL 与触发器归一化 ──────────────────────────────────────

describe('github-trigger', () => {
  it('githubAddress 只认本仓的 Issue / PR / review 讨论地址', () => {
    expect(githubAddress('https://github.com/Acme/Widgets/issues/12', 'acme/widgets')).toEqual({ number: 12, pr: false })
    expect(githubAddress('https://api.github.com/repos/acme/widgets/pulls/7', 'acme/widgets')).toEqual({ number: 7, pr: true })
    expect(githubAddress('https://github.com/acme/widgets/pull/7#discussion_r99', 'acme/widgets')).toEqual({ number: 7, pr: true, discussion: 99 })
    expect(githubAddress('https://github.com/other/repo/issues/1', 'acme/widgets'), '别的仓库不认').toBeUndefined()
    expect(githubAddress('https://example.com/acme/widgets/issues/1', 'acme/widgets'), '站外地址不认').toBeUndefined()
  })

  it('githubChannel / githubPage 拼出回复地址与网页链接', () => {
    expect(githubChannel(12)).toEqual({ source: 'github', thread: 'github:12', address: { number: '12' } })
    expect(githubChannel(12, 'https://github.com/acme/widgets/pull/12#discussion_r1').address.url)
      .toBe('https://github.com/acme/widgets/pull/12#discussion_r1')
    expect(githubPage('acme/widgets', 12)).toBe('https://github.com/acme/widgets/issues/12')
    expect(githubPage('acme/widgets', 12, true)).toBe('https://github.com/acme/widgets/pull/12')
  })

  it('UserSchema 把已删除账号归一成 ghost，isHumanLogin 区分机器人', () => {
    expect(UserSchema.parse(null)).toEqual({ login: 'ghost', type: 'User' })
    expect(UserSchema.parse({ login: 'octo', type: 'Bot' })).toEqual({ login: 'octo', type: 'Bot' })
    expect(isHumanLogin({ login: 'carol', type: 'User' })).toBe(true)
    expect(isHumanLogin({ login: 'carol' }), '缺 type 时按人算').toBe(true)
    expect(isHumanLogin({ login: 'dependabot[bot]', type: 'User' }), '登录名带 [bot] 后缀也算机器人').toBe(false)
    expect(isHumanLogin({ login: 'carol', type: 'Bot' })).toBe(false)
  })

  it('reviewPlace 输出 文件:行号 与 diff 尾部三行', () => {
    const text = reviewPlace({
      id: 1, path: 'src/render.ts', line: 43, user: user(),
      diff_hunk: '@@ -40,6 +40,8 @@\n a\n b\n c\n d\n e',
    })
    expect(text).toBe('src/render.ts:43\n c\n d\n e')
    expect(reviewPlace({ id: 1, path: 'src/a.ts', original_line: 9, user: user() }), '没有 line 用 original_line').toBe('src/a.ts:9')
  })

  it('mentions 按词边界匹配，命中大小写不敏感', () => {
    expect(mentions('ping @agent please', 'agent')).toBe(true)
    expect(mentions('ping @Agent please', 'agent')).toBe(true)
    expect(mentions('not @agents here', 'agent'), '更长登录名不算').toBe(false)
    expect(mentions('mail a@agent', 'agent'), '邮箱前缀不算点名').toBe(false)
    expect(mentions('@agent', 'agent')).toBe(true)
  })

  it('commentTrigger 归一化对话评论：作者、正文、mentions、回复地址', () => {
    const result = commentTrigger(comment({ id: 3, body: 'hey @agent', html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-3' }),
      { number: 12, isPr: true, url: 'https://github.com/acme/widgets/pull/12' }, 'conversation', 'agent')
    expect(result).toMatchObject({
      source: 'github', threads: [{ source: 'github', id: '12' }], actor: { source: 'github', id: 'carol' }, human: true,
      text: 'hey @agent', addressed: 'mention', at: '2026-09-09T00:00:01Z',
      meta: { number: 12, isPr: true, commentId: 3, kind: 'conversation' },
    })
    expect(result.id).toMatch(/^[0-9a-f]{32}$/)
    expect(result.channel).toEqual({ source: 'github', thread: 'github:12', address: { number: '12', url: 'https://github.com/acme/widgets/pull/12#issuecomment-3' } })
  })

  it('commentTrigger 归一化行内 review 评论：带上文件:行号与根评论', () => {
    const result = commentTrigger(comment({
      id: 8, body: 'consider this', path: 'src/a.ts', line: 12, diff_hunk: 'x\ny\nz', in_reply_to_id: 5,
      html_url: 'https://github.com/acme/widgets/pull/12#discussion_r8',
    }), { number: 12, isPr: true, prAuthor: 'dave' }, 'inline', 'agent')
    expect(result.text).toBe('src/a.ts:12\nx\ny\nz\n\nconsider this')
    expect(result.human).toBe(true)
    expect(result.meta).toMatchObject({ kind: 'inline', prAuthor: 'dave', path: 'src/a.ts', line: 12, inReplyTo: 5 })
  })

  it('commentTrigger 归一化 review 决定：正文前置 APPROVED 与 commit', () => {
    const result = commentTrigger(comment({ id: 9, body: 'ok', state: 'APPROVED', commit_id: 'abc123', submitted_at: '2026-09-09T00:00:09Z', updated_at: null }),
      { number: 12, isPr: true }, 'review', 'agent')
    expect(result.text).toBe('APPROVED review of commit abc123\n\nok')
    expect(result.at).toBe('2026-09-09T00:00:09Z')
  })

  it('commentTrigger 空正文时 text 为空，且 COMMENTED 的 review 不加决定前缀', () => {
    const empty = commentTrigger(comment({ id: 10, body: null }), { number: 12, isPr: false }, 'conversation', 'agent')
    expect(empty.text).toBe('')
    const commented = commentTrigger(comment({ id: 11, body: 'nit', state: 'COMMENTED' }), { number: 12, isPr: true }, 'review', 'agent')
    expect(commented.text).toBe('nit')
  })

  it('commentTrigger 把机器人作者标成非人类，agent 自己的评论也不算人类', () => {
    const bot = commentTrigger(comment({ user: user('ci[bot]', 'Bot') }), { number: 12, isPr: true }, 'conversation', 'agent')
    expect(bot.human).toBe(false)
    expect(bot.actor).toEqual({ source: 'github', id: 'ci[bot]' })
    const own = commentTrigger(comment({ user: user('Agent') }), { number: 12, isPr: true }, 'conversation', 'agent')
    expect(own.human, '智能体自己的评论不是人类请求').toBe(false)
  })

  it('issueTrigger / pullTrigger：正文带标题，PR 记 isPr 与 prAuthor', () => {
    const issueResult = issueTrigger(issue({ body: 'steps to reproduce', title: 'Crash' }) as never, 'agent')
    expect(issueResult).toMatchObject({
      source: 'github', threads: [{ source: 'github', id: '12' }], text: 'Crash\n\nsteps to reproduce',
      meta: { number: 12, isPr: false, kind: 'issue' }, url: 'https://github.com/acme/widgets/issues/12',
    })
    expect(issueResult.id).toMatch(/^[0-9a-f]{32}$/)
    const pullResult = pullTrigger(issue({ pull_request: { url: 'x' }, body: null }) as never, 'agent')
    expect(pullResult.meta).toMatchObject({ number: 12, isPr: true, prAuthor: 'carol', kind: 'pull' })
    expect(pullResult.text, '没有正文时只有标题').toBe('A bug\n\n')
  })

  it('branchCiTrigger / ciTrigger：CI 触发没有人类作者与回复地址', () => {
    const branch = branchCiTrigger('main', 'abcdef1234', 2, 'CI failed', 'https://github.com/acme/widgets/commit/abcdef1234')
    expect(branch).toMatchObject({ source: 'github', threads: [{ source: 'github', id: 'ci:main' }], human: false, meta: { ci: true, branch: 'main', sha: 'abcdef1234', revision: 2 } })
    expect(branch.channel, '默认分支 CI 没有人可回复').toBeUndefined()
    const pr = ciTrigger({ number: 12, html_url: 'https://github.com/acme/widgets/pull/12', user: { login: 'agent' } }, 3, 'CI passed')
    expect(pr).toMatchObject({ threads: [{ source: 'github', id: '12' }], human: false, meta: { number: 12, isPr: true, prAuthor: 'agent', ci: true, revision: 3 } })
    expect(pr.channel).toEqual({ source: 'github', thread: 'github:12', address: { number: '12' } })
  })
})

// ── feishu-trigger：事件 / 历史 / 话题归一化 ─────────────────────────────────

describe('feishu-trigger', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    message_id: 'om_1', chat_id: 'oc_a', chat_type: 'group', sender_id: 'ou_carol', sender_type: 'user',
    content: 'hello @bot', create_time: '1757000000000', mentions: [],
    ...over,
  })

  it('feishuChannel / feishuThreadId / feishuTriggerId 拼地址与稳定 ID', () => {
    expect(feishuChannel('oc_a', 'om_1')).toEqual({ source: 'feishu', thread: 'feishu:oc_a', address: { chatId: 'oc_a', messageId: 'om_1' } })
    expect(feishuChannel('oc_a', 'om_1', true).address.direct).toBe('true')
    expect(feishuThreadId('oc_a', undefined, 'om_1')).toBe('oc_a:om_1')
    expect(feishuThreadId('oc_a', 'om_root', 'om_1')).toBe('oc_a:om_root')
    expect(feishuTriggerId('om_1')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('withMentionNames 把占位 key 换成 @名字，缺 key 或名字时原样保留', () => {
    expect(withMentionNames('hi @_user_1', [{ key: '@_user_1', name: 'Carol' }])).toBe('hi @Carol')
    expect(withMentionNames('hi @_user_1', [{ key: '@_user_1' }])).toBe('hi @_user_1')
    expect(withMentionNames('hi @_user_1', [{}])).toBe('hi @_user_1')
  })

  it('feishuTime 同时吃毫秒时间戳与本地时间串，读不懂就抛', () => {
    expect(feishuTime('1757000000000')).toBe(new Date(1757000000000).toISOString())
    expect(feishuTime('2026-09-11 12:00')).toBe(new Date(Date.parse('2026-09-11 12:00')).toISOString())
    expect(() => feishuTime('not a time')).toThrow(/Unreadable Feishu message time/)
  })

  it('feishuTrigger 丢弃机器人自己的消息', () => {
    expect(feishuTrigger(event({ sender_id: 'ou_bot' }), 'ou_bot', 'cli_app')).toBeUndefined()
    expect(feishuTrigger(event({ sender_id: 'cli_app' }), 'ou_bot', 'cli_app')).toBeUndefined()
  })

  it('feishuTrigger 归一化群里的点名消息', () => {
    const result = feishuTrigger(event({ mentions: [{ id: 'ou_bot', key: '@_user_1', name: 'Bot' }], modified: 'x' }), 'ou_bot', 'cli_app')
    expect(result).toMatchObject({
      source: 'feishu', threads: [{ source: 'feishu', id: 'oc_a:om_1' }],
      actor: { source: 'feishu', id: 'ou_carol' }, human: true, addressed: 'mention',
      text: 'hello @bot', meta: { chatId: 'oc_a', messageId: 'om_1', direct: false, mentioned: true },
    })
    expect(result?.at).toBe(new Date(1757000000000).toISOString())
  })

  it('feishuTrigger 归一化私聊：带 direct 地址与 root/parent/thread', () => {
    const result = feishuTrigger(event({ chat_type: 'p2p', root_id: 'om_root', parent_id: 'om_parent', thread_id: 'omt_1',
      message_app_link: 'https://applink.feishu.cn/client/chat/open?x=1' }), 'ou_bot', 'cli_app')
    expect(result).toMatchObject({
      addressed: 'direct', url: 'https://applink.feishu.cn/client/chat/open?x=1',
      meta: { direct: true, mentioned: false, rootId: 'om_root', parentId: 'om_parent', threadId: 'omt_1' },
    })
    expect(result?.channel).toEqual({ source: 'feishu', thread: 'feishu:oc_a', address: { chatId: 'oc_a', messageId: 'om_1', direct: 'true' } })
  })

  it('feishuParent / feishuRef 从触发器里取父消息与来源引用', () => {
    expect(feishuParent(trigger({ source: 'feishu', meta: { parentId: 'om_p' } }))).toBe(feishuTriggerId('om_p'))
    expect(feishuParent(trigger({ source: 'feishu', meta: {} }))).toBeUndefined()
    expect(feishuParent(trigger({ meta: { parentId: 'om_p' } })), '别的来源不算').toBeUndefined()
    expect(feishuRef(trigger({ source: 'feishu', meta: { chatId: 'oc_a', messageId: 'om_1' }, at: '2026-09-09T00:00:01.000Z' })))
      .toEqual({ triggerId: 'trig-1', chatId: 'oc_a', messageId: 'om_1', at: '2026-09-09T00:00:01.000Z' })
    expect(feishuRef(trigger({ source: 'feishu', meta: { chatId: 'oc_a' } }))).toBeUndefined()
    expect(feishuRef(trigger({ meta: { chatId: 'oc_a', messageId: 'om_1' } })), '别的来源不算').toBeUndefined()
  })

  const historical = (over: Record<string, unknown> = {}) => ({
    message_id: 'om_h1', chat_id: 'oc_a', create_time: '1757000000000', sender: { id: 'ou_carol', sender_type: 'user' },
    body: { content: JSON.stringify({ text: 'from history' }) },
    ...over,
  })

  it('historyText 解析富文本 / 纯文本 / 非 JSON 三态', () => {
    expect(historyText({ ...historical(), body: { content: JSON.stringify({ text: 'hi' }) } } as never)).toBe('hi')
    expect(historyText({ ...historical(), body: { content: 'plain system text' } } as never)).toBe('plain system text')
    expect(historyText({ ...historical(), body: { content: JSON.stringify({ image_key: 'img_1' }) } } as never)).toBe('{"image_key":"img_1"}')
    expect(historyText({ ...historical(), body: undefined } as never)).toBe('')
  })

  it('historyEvent 把历史消息适配成事件形状，发送者类型映射为 user/bot', () => {
    expect(historyEvent(historical({ mentions: [{ id: 'ou_bot' }], root_id: 'om_r', message_app_link: 'https://x' }) as never, 'oc_a', true))
      .toEqual({
        message_id: 'om_h1', chat_id: 'oc_a', chat_type: 'p2p', create_time: '1757000000000',
        sender_id: 'ou_carol', sender_type: 'user', content: 'from history', mentions: [{ id: 'ou_bot' }],
        root_id: 'om_r', parent_id: undefined, thread_id: undefined, message_app_link: 'https://x',
      })
    const bot = historyEvent(historical({ sender: { id: 'cli_app', sender_type: 'app' } }) as never, 'oc_a', false)
    expect(bot).toMatchObject({ chat_type: 'group', sender_type: 'bot' })
  })

  it('topicEvent 回落到 root，且优先用 open_bot_id 认机器人', () => {
    const message = {
      message_id: 'om_t1', chat_id: 'oc_a', content: 'reply', create_time: '2026-09-11 12:00',
      sender: { id: 'ou_x', sender_type: 'app', open_bot_id: 'ou_bot' }, root_id: undefined, parent_id: 'om_p', thread_id: 'omt_1',
    }
    expect(topicEvent(message as never, 'oc_a', false, 'om_root')).toMatchObject({
      sender_id: 'ou_bot', sender_type: 'bot', root_id: 'om_root', parent_id: 'om_p', thread_id: 'omt_1', chat_type: 'group',
    })
    expect((topicEvent({ ...message, message_id: 'om_root', root_id: undefined } as never, 'oc_a', true, 'om_root') as { root_id?: string }).root_id,
      '根消息自己不记 root').toBeUndefined()
  })
})

// ── github-read：只读检查 ───────────────────────────────────────────────────

describe('github-read', () => {
  const snapshot = {
    head: 'abcdef123456',
    checks: [
      { name: 'build', status: 'completed', conclusion: 'failure' },
      { name: 'lint', status: 'completed', conclusion: 'success' },
      { name: 'test', status: 'in_progress', conclusion: null },
    ],
    statuses: [{ context: 'legacy', state: 'error' }],
  }

  it('ciCounts / ciFailures / ciFact 只把失败结论算失败', () => {
    expect(ciCounts(snapshot)).toEqual({ failed: 2, running: 1 })
    expect(ciFailures(snapshot)).toEqual(['build', 'legacy'])
    expect(ciFact({ failed: 2, running: 0 })).toMatchObject({ problem: true, value: '2' })
    expect(ciFact({ failed: 0, running: 3 })).toMatchObject({ value: '3' })
    expect(ciFact({ failed: 0, running: 0 })).toMatchObject({ value: { zh: '通过', en: 'passed' } })
    expect(ciFact({ failed: 0, running: 0 }).problem).toBeUndefined()
  })

  it('ciSummary 描述失败 / 运行中 / 通过三种结论，并提示去哪读全部检查', () => {
    const failed = ciSummary(snapshot, 'PR #12', 'github/pulls/12/checks')
    expect(failed).toContain('CI failed 2/4 on PR #12 at abcdef1: build, legacy')
    expect(failed).toContain('1 still running')
    expect(failed).toContain('Read github/pulls/12/checks for every check.')
    expect(ciSummary({ head: 'abcdef1', checks: [{ name: 'a', status: 'in_progress', conclusion: null }], statuses: [] }, 'main', 'x'))
      .toContain('CI running 1/1 on main')
    expect(ciSummary({ head: 'abcdef1', checks: [{ name: 'a', status: 'completed', conclusion: 'success' }], statuses: [] }, 'main', 'x'))
      .toContain('CI passed 1/1 on main')
  })

  it('ciSummary 超过五个失败时只列前五个并说还有几个', () => {
    const many = { head: 'abcdef1', statuses: [], checks: Array.from({ length: 7 }, (_, index) => ({ name: `c${index}`, status: 'completed', conclusion: 'failure' })) }
    expect(ciSummary(many, 'main', 'x')).toContain('c0, c1, c2, c3, c4, and 2 more')
  })

  it('readRepositoryPath 读文件走 raw Accept，目录只列非隐藏条目并排序', async () => {
    const file = fakeCommands({ api: apiWith({ 'contents/src/a.ts': 'export const a = 1' }) })
    await expect(readRepositoryPath(file, 'src/a.ts', 'file')).resolves.toBe('export const a = 1')
    expect(file.calls.api[0]).toEqual({ path: 'contents/src/a.ts', flags: ['-H', 'Accept: application/vnd.github.raw'] })

    const directory = fakeCommands({ api: apiWith({ 'contents/src': [{ name: 'b.ts' }, { name: 'a.ts' }, { name: '.hidden' }, { name: 'node_modules' }] }) })
    await expect(readRepositoryPath(directory, 'src', 'directory')).resolves.toBe('a.ts\nb.ts')
  })

  it('readRepositoryPath 拒绝隐藏 / node_modules / 上跳路径，目录位置返回的是文件时抛错', async () => {
    const commands = fakeCommands({ api: () => { throw new Error('不该发请求') } })
    for (const path of ['../outside', '.git/config', 'src/node_modules/x', 'src/.env']) {
      await expect(readRepositoryPath(commands, path, 'file')).rejects.toThrow(/Only non-hidden repository source paths/)
    }
    expect(commands.calls.api, '校验失败要在发请求之前').toHaveLength(0)
    const file = fakeCommands({ api: apiWith({ 'contents/src/a.ts': { name: 'a.ts' } }) })
    await expect(readRepositoryPath(file, 'src/a.ts', 'directory')).rejects.toThrow('src/a.ts is not a directory')
  })

  it('pullChecks 合并 check-runs 与 statuses：同 context 取最新，非法项计入 skipped', async () => {
    const commands = fakeCommands({
      api: apiWith({
        'commits/abcdef1/check-runs?per_page=100': [
          { check_runs: [{ name: 'build', status: 'completed', conclusion: 'failure' }, { name: 'bad' }] },
          { check_runs: [{ name: 'lint', status: 'completed', conclusion: 'success' }] },
        ],
      }),
      pages: pagesWith({
        'commits/abcdef1/statuses?per_page=100': [
          { context: 'legacy', state: 'success' },
          { context: 'legacy', state: 'failure' },
          { context: 'other', state: 'pending' },
        ],
      }),
    })
    const result = await pullChecks(commands, 'abcdef1')
    expect(result.checks.map(check => check.name)).toEqual(['build', 'lint'])
    expect(result.statuses).toEqual([{ context: 'legacy', state: 'success' }, { context: 'other', state: 'pending' }])
    expect(result.head).toBe('abcdef1')
  })

  it('readGithub 读 commit 的 CI', async () => {
    const commands = fakeCommands({
      api: apiWith({ 'commits/abcdef1/check-runs?per_page=100': [{ check_runs: [] }] }),
      pages: pagesWith({ 'commits/abcdef1/statuses?per_page=100': [] }),
    })
    await expect(readGithub(commands, 'github/commits/abcdef1/checks')).resolves.toEqual({ head: 'abcdef1', checks: [], statuses: [] })
  })

  it('readGithub 对不支持的资源与越界组合在发请求前抛错', async () => {
    const commands = fakeCommands({ api: () => { throw new Error('不该发请求') } })
    for (const resource of ['github/../x', 'github/issues/0', 'github/issues/12/reviews', 'github/issues/12/checks', 'github/issues/12/thread/5']) {
      await expect(readGithub(commands, resource)).rejects.toThrow()
    }
    expect(commands.calls.api).toHaveLength(0)
    await expect(readGithub(commands, 'github/pulls/12/checks/2')).rejects.toThrow('Checks do not take a page number')
    await expect(readGithub(commands, 'github/pulls/12/thread')).rejects.toThrow(/Name the review thread/)
  })

  it('readGithub 读 review 讨论：从任意评论回到根，回复带 reply_to 与文件行号', async () => {
    const comments = [
      { ...comment({ id: 5, body: 'root', path: 'src/a.ts', line: 3, diff_hunk: 'x\ny\nz' }), html_url: 'https://github.com/acme/widgets/pull/12#discussion_r5', created_at: '2026-09-09T00:00:01Z' },
      { ...comment({ id: 6, body: 'reply', in_reply_to_id: 5 }), html_url: 'https://github.com/acme/widgets/pull/12#discussion_r6', created_at: '2026-09-09T00:00:02Z' },
    ]
    const commands = fakeCommands({ pages: pagesWith({ 'pulls/12/comments?per_page=100': comments }) })
    const result = await readGithub(commands, 'github/pulls/12/thread/6') as { messages: { id: string; text: string; reply_to?: string }[] }
    expect(result.messages.map(message => message.id)).toEqual(['5', '6'])
    expect(result.messages[0]!.text).toContain('src/a.ts:3')
    expect(result.messages[1]!.text).toBe('reply')
    expect(result.messages[1]!.reply_to).toBe('5')
  })

  it('readGithub 读不存在的 review 评论时报错', async () => {
    const commands = fakeCommands({ pages: pagesWith({ 'pulls/12/comments?per_page=100': [comment({ id: 5 })] }) })
    await expect(readGithub(commands, 'github/pulls/12/thread/99')).rejects.toThrow(/No review comment of this PR has that id/)
  })

  it('readGithub 读 Issue/PR 描述：合并状态、draft、分支与标签都进结果', async () => {
    const item = issue({
      number: 12, title: 'Add cache', state: 'closed', body: 'why not', merged: true, draft: true,
      labels: [{ name: 'enhancement' }, { name: 'ready' }], head: { ref: 'agent/cache' }, base: { ref: 'main' },
      html_url: 'https://github.com/acme/widgets/pull/12',
    })
    const commands = fakeCommands({ api: apiWith({ 'pulls/12': item }) })
    await expect(readGithub(commands, 'github/pulls/12')).resolves.toMatchObject({
      number: 12, title: 'Add cache', state: 'closed', merged: true, draft: true, head: 'agent/cache', base: 'main',
      labels: ['enhancement', 'ready'], id: '12', from: 'carol', text: 'why not',
      url: 'https://github.com/acme/widgets/pull/12',
    })
  })

  it('readGithub 读评论页：满 20 条给下一页，非法项计入 skipped', async () => {
    const listed: unknown[] = Array.from({ length: 19 }, (_, index) => comment({ id: index + 1 }))
    listed.push({ id: 'bad' })
    const commands = fakeCommands({ api: apiWith({ 'issues/12/comments?per_page=20&page=2': listed }) })
    const result = await readGithub(commands, 'github/issues/12/comments/2') as { messages: unknown[]; next_resource: string; skipped: number }
    expect(result.messages).toHaveLength(19)
    expect(result.next_resource).toBe('github/issues/12/comments/3')
    expect(result.skipped).toBe(1)
  })

  it('readGithub 读 review 列表：正文前置 review 决定', async () => {
    const commands = fakeCommands({
      api: apiWith({
        'pulls/12/reviews?per_page=20&page=1': [comment({ id: 3, body: 'looks fine', state: 'APPROVED', commit_id: 'abc', submitted_at: '2026-09-09T00:00:03Z' })],
      }),
    })
    const result = await readGithub(commands, 'github/pulls/12/reviews') as { messages: { text: string }[] }
    expect(result.messages[0]!.text).toBe('APPROVED\n\nlooks fine')
  })

  it('readGithub 读 PR 的 CI：先读 PR head sha 再读检查', async () => {
    const commands = fakeCommands({
      api: apiWith({
        'pulls/12': { head: { sha: 'deadbeef' } },
        'commits/deadbeef/check-runs?per_page=100': [{ check_runs: [] }],
      }),
      pages: pagesWith({ 'commits/deadbeef/statuses?per_page=100': [] }),
    })
    await expect(readGithub(commands, 'github/pulls/12/checks')).resolves.toEqual({ head: 'deadbeef', checks: [], statuses: [] })
  })

  it('githubThreadContext 读默认分支 CI：不读会话，直接把自己的触发文本当上下文', async () => {
    const commands = fakeCommands({})
    const result = await githubThreadContext.read(commands, trigger({ meta: { ci: true, branch: 'main' }, url: 'https://ci', text: 'CI failed' }), 'thread', undefined, undefined)
    expect(result.status).toBe('branch_ci')
    expect(result.messages).toEqual([{ id: 'https://ci', from: 'CI', at: '2026-09-09T00:00:01.000Z', text: 'CI failed', bot: true }])
    expect(commands.calls.api, 'branch CI 不读任何 API').toHaveLength(0)
  })

  it('githubThreadContext 读行内 review 讨论：thread 给全线程，root 只给根', async () => {
    const comments = [
      { ...comment({ id: 5, body: 'root', path: 'a.ts', line: 1 }), html_url: 'https://github.com/acme/widgets/pull/12#discussion_r5', created_at: '2026-09-09T00:00:01Z' },
      { ...comment({ id: 6, body: 'reply', in_reply_to_id: 5 }), html_url: 'https://github.com/acme/widgets/pull/12#discussion_r6', created_at: '2026-09-09T00:00:02Z' },
    ]
    const commands = fakeCommands({ pages: pagesWith({ 'pulls/12/comments?per_page=100': comments }) })
    const triggerOf = trigger({ meta: { number: 12, isPr: true, kind: 'inline', commentId: 6 } })
    const all = await githubThreadContext.read(commands, triggerOf, 'thread', undefined, undefined)
    expect(all.messages).toHaveLength(2)
    expect(all.status).toBe('review_thread')
    expect(all.body).toEqual({ status: 'review_thread', messages: all.messages })
    const root = await githubThreadContext.read(commands, triggerOf, 'root', undefined, undefined)
    expect(root.messages).toHaveLength(1)
    expect(githubThreadContext.messageId(triggerOf)).toBe('')
  })

  it('githubThreadContext 按 page 读 Issue 会话：第 1 页先带描述', async () => {
    const commands = fakeCommands({
      api: apiWith({
        'issues/12': issue({ title: 'Crash', body: 'steps' }),
        'issues/12/comments?per_page=100&page=1': [comment({ id: 2, body: 'me too' })],
        'issues/12/comments?per_page=100&page=2': [comment({ id: 3, body: 'again' })],
      }),
    })
    const first = await githubThreadContext.read(commands, trigger({ meta: { number: 12 } }), 'thread', undefined, undefined)
    expect(first.messages).toHaveLength(2)
    expect(first.messages[0]!.text).toBe('Crash\n\nsteps')
    expect(first.next, '评论不足 100 条就没有下一页').toBeUndefined()
    const second = await githubThreadContext.read(commands, trigger({ meta: { number: 12 } }), 'thread', '2', undefined)
    expect(second.messages).toHaveLength(1)
    expect(second.messages[0]!.text).toBe('again')
  })
})

// ── feishu-read：只读上下文 ─────────────────────────────────────────────────

describe('feishu-read', () => {
  const ref = { triggerId: 'abc123', chatId: 'oc_a', messageId: 'om_1', at: '2026-09-11T04:00:00.000Z' }
  const sourceResult = (over: Record<string, unknown> = {}) => ({ items: [{ message_id: 'om_1', chat_id: 'oc_a', root_id: 'om_root', parent_id: 'om_parent', thread_id: 'omt_1', ...over }] })
  const message = (over: Record<string, unknown> = {}) => ({
    message_id: 'om_1', chat_id: 'oc_a', content: 'hello', msg_type: 'text',
    sender: { id: 'ou_carol', name: 'Carol', sender_type: 'user' }, create_time: '1757000000000',
    ...over,
  })

  it('feishuReferences 生成各种资源引用', () => {
    expect(feishuReferences(ref)).toEqual({
      skill: 'dsh-superagent-feishu', message: 'feishu/abc123/message', root: 'feishu/abc123/root',
      parent: 'feishu/abc123/parent', thread: 'feishu/abc123/thread', around: 'feishu/abc123/around',
    })
  })

  it('feishuResource 只接受五个 section，游标只给 thread / around', () => {
    expect(feishuResource('feishu/abc123/thread/tok%2B1')).toEqual({ triggerId: 'abc123', section: 'thread', cursor: 'tok+1' })
    expect(feishuResource('feishu/abc123/around')).toEqual({ triggerId: 'abc123', section: 'around', cursor: undefined })
    expect(() => feishuResource('feishu/abc123/message/2')).toThrow(/Use feishu/)
    expect(() => feishuResource('feishu/abc/other')).toThrow(/Use feishu/)
  })

  it('readFeishuLink 只认与来源消息一致、未删除且有链接的那条', async () => {
    const commands = fakeCommands({
      lark: () => ({ messages: [{ message_id: 'om_1', chat_id: 'oc_a', message_app_link: 'https://applink.feishu.cn/x' }] }),
    })
    await expect(readFeishuLink(commands, ref)).resolves.toBe('https://applink.feishu.cn/x')
    const noLink = fakeCommands({ lark: () => ({ messages: [{ message_id: 'om_1', chat_id: 'oc_a' }] }) })
    await expect(readFeishuLink(noLink, ref)).rejects.toThrow('Source message link unavailable')
    const deleted = fakeCommands({ lark: () => ({ messages: [{ message_id: 'om_1', chat_id: 'oc_a', deleted: true, message_app_link: 'https://x' }] }) })
    await expect(readFeishuLink(deleted, ref)).rejects.toThrow('Source message link unavailable')
    const wrongChat = fakeCommands({ lark: () => ({ messages: [{ message_id: 'om_1', chat_id: 'oc_other', message_app_link: 'https://x' }] }) })
    await expect(readFeishuLink(wrongChat, ref)).rejects.toThrow('Source message link unavailable')
  })

  it('readFeishu 读话题页：给出下一页引用，并统计跳过的不可读消息', async () => {
    const commands = fakeCommands({
      lark: (args) => {
        if (args[0] === 'api') return sourceResult()
        return {
          thread_id: 'omt_1', has_more: true, page_token: 'next1',
          messages: [message(), message({ message_id: 'om_2', parent_id: undefined }), { message_id: 'bad' }],
        }
      },
    })
    const result = await readFeishu(commands, ref, 'feishu/abc123/thread', 20) as { messages: { message_id: string }[]; next_resource: string; skipped: number; thread_id: string }
    expect(result.messages.map(item => item.message_id)).toEqual(['om_1', 'om_2'])
    expect(result.skipped).toBe(1)
    expect(result.thread_id).toBe('omt_1')
    expect(result.next_resource).toBe('feishu/abc123/thread/next1')
    expect(commands.calls.lark[1]!.args).toEqual(['im', '+threads-messages-list', '--thread', 'omt_1', '--order', 'asc', '--page-size', '20', '--no-reactions'])
  })

  it('readFeishu 话题分页不前进、返回别的群消息、来源没有话题时各有明确行为', async () => {
    const stuck = fakeCommands({
      lark: (args) => args[0] === 'api' ? sourceResult() : { thread_id: 'omt_1', has_more: true, page_token: 'same', messages: [message()] },
    })
    await expect(readFeishu(stuck, ref, 'feishu/abc123/thread/same', 20)).rejects.toThrow(/pagination did not advance/)

    const outside = fakeCommands({
      lark: (args) => args[0] === 'api' ? sourceResult() : { thread_id: 'omt_1', has_more: false, messages: [message({ chat_id: 'oc_other' })] },
    })
    await expect(readFeishu(outside, ref, 'feishu/abc123/thread', 20)).rejects.toThrow(/outside the source thread/)

    const noThread = fakeCommands({ lark: (args) => args[0] === 'api' ? sourceResult({ thread_id: undefined }) : undefined })
    await expect(readFeishu(noThread, ref, 'feishu/abc123/thread', 20)).resolves.toEqual({ status: 'no_thread', messages: [], next_resource: null })
  })

  it('readFeishu 读单条消息：root / parent / 来源自己，缺目标时给 no_<section>', async () => {
    const commands = fakeCommands({
      lark: (args) => {
        if (args[0] === 'api') return sourceResult()
        const target = args[args.indexOf('--message-ids') + 1]
        return { messages: [message({ message_id: target, chat_id: 'oc_a' })] }
      },
    })
    await expect(readFeishu(commands, ref, 'feishu/abc123/root', 20)).resolves.toMatchObject({ status: 'available', message: { message_id: 'om_root' } })
    await expect(readFeishu(commands, ref, 'feishu/abc123/parent', 20)).resolves.toMatchObject({ status: 'available', message: { message_id: 'om_parent' } })
    await expect(readFeishu(commands, ref, 'feishu/abc123/message', 20)).resolves.toMatchObject({ status: 'available', message: { message_id: 'om_1' } })

    const parentless = fakeCommands({ lark: (args) => args[0] === 'api' ? sourceResult({ parent_id: undefined }) : undefined })
    await expect(readFeishu(parentless, ref, 'feishu/abc123/parent', 20)).resolves.toEqual({ status: 'no_parent', message: null })

    const unreadable = fakeCommands({ lark: (args) => args[0] === 'api' ? sourceResult() : { messages: [] } })
    await expect(readFeishu(unreadable, ref, 'feishu/abc123/message', 20)).rejects.toThrow(/requested Feishu message is unavailable/)

    const wrongChat = fakeCommands({ lark: (args) => args[0] === 'api' ? sourceResult() : { messages: [message({ message_id: 'om_1', chat_id: 'oc_other' })] } })
    await expect(readFeishu(wrongChat, ref, 'feishu/abc123/message', 20)).rejects.toThrow(/outside the source chat/)
  })

  it('readFeishu 拒绝别人的 trigger、around 资源与已删除的来源消息', async () => {
    const commands = fakeCommands({ lark: (args) => args[0] === 'api' ? sourceResult() : {} })
    await expect(readFeishu(commands, ref, 'feishu/other/message', 20)).rejects.toThrow('A Feishu source trigger is required')
    await expect(readFeishu(commands, ref, 'feishu/abc123/around', 20)).rejects.toThrow(/read with feishuRead/)
    const deleted = fakeCommands({ lark: (args) => args[0] === 'api' ? sourceResult({ deleted: true }) : {} })
    await expect(readFeishu(deleted, ref, 'feishu/abc123/message', 20)).rejects.toThrow(/unavailable or deleted/)
    const wrongSourceChat = fakeCommands({ lark: (args) => args[0] === 'api' ? sourceResult({ chat_id: 'oc_other' }) : {} })
    await expect(readFeishu(wrongSourceChat, ref, 'feishu/abc123/message', 20)).rejects.toThrow(/source chat does not match/)
  })

  it('feishuView 把消息形状换成模型看的上下文（机器人、删除、回复、链接）', () => {
    expect(feishuView(message({ content: 'hello @_user_1', mentions: [{ key: '@_user_1', name: 'Carol' }], parent_id: 'om_p', message_app_link: 'https://l' }) as never))
      .toEqual({ id: 'om_1', from: 'Carol', at: new Date(1757000000000).toISOString(), text: 'hello @Carol', reply_to: 'om_p', url: 'https://l' })
    const bot = feishuView(message({ sender: { id: 'cli_app', sender_type: 'app' }, deleted: true, content: 'gone' }) as never)
    expect(bot).toMatchObject({ from: 'cli_app', text: '', bot: true, deleted: true })
  })

  it('feishuRead 读 around：前后各五条去重，游标页只往前翻', async () => {
    const calls: Record<string, unknown>[] = []
    const commands = fakeCommands({
      lark: (args) => {
        if (args[0] === 'api' && args[2] === '/open-apis/im/v1/messages/mget') return sourceResult()
        const parameters = JSON.parse(args[4]!) as Record<string, unknown>
        calls.push(parameters)
        if (parameters.sort_type === 'ByCreateTimeDesc') {
          return {
            has_more: true, page_token: 'older',
            items: [
              { message_id: 'om_1', chat_id: 'oc_a', create_time: '1757000000000', sender: { id: 'ou_carol', sender_type: 'user' }, body: { content: JSON.stringify({ text: 'now' }) } },
              { message_id: 'om_0', chat_id: 'oc_a', create_time: '1756999999000', sender: { id: 'ou_carol', sender_type: 'user' }, body: { content: JSON.stringify({ text: 'before' }) } },
            ],
          }
        }
        return {
          has_more: false,
          items: [{ message_id: 'om_2', chat_id: 'oc_a', create_time: '1757000001000', sender: { id: 'ou_dave', sender_type: 'user' }, body: { content: JSON.stringify({ text: 'after' }) } }],
        }
      },
    })
    const first = await feishuRead(commands, ref, 'feishu/abc123/around', 20) as { messages: { id: string; text: string }[]; next_resource: string }
    expect(first.messages.map(item => item.text), '按时间升序').toEqual(['before', 'now', 'after'])
    expect(first.next_resource).toBe('feishu/abc123/around/older')
    expect(calls[0]).toMatchObject({ container_id_type: 'chat', container_id: 'oc_a', sort_type: 'ByCreateTimeDesc', page_size: 6 })
    expect(calls[1]).toMatchObject({ sort_type: 'ByCreateTimeAsc', page_size: 6 })

    calls.length = 0
    const paged = await feishuRead(commands, ref, 'feishu/abc123/around/older', 20) as { messages: { id: string }[] }
    expect(calls, '游标页只发往前翻的那一条请求').toHaveLength(1)
    expect(calls[0]).toMatchObject({ page_size: 10, page_token: 'older' })
    expect(paged.messages.map(item => item.id)).toEqual(['om_0', 'om_1'])
  })

  it('feishuRead around 缺时间时抛错', async () => {
    const commands = fakeCommands({ lark: (args) => args[0] === 'api' ? sourceResult() : {} })
    await expect(feishuRead(commands, { ...ref, at: undefined }, 'feishu/abc123/around', 20)).rejects.toThrow(/no time to read the chat around/)
  })

  it('feishuThreadContext.read 没有话题时回落到前后聊天消息', async () => {
    const commands = fakeCommands({
      lark: (args) => {
        if (args[0] === 'api' && args[2] === '/open-apis/im/v1/messages/mget') return sourceResult({ thread_id: undefined })
        return {
          has_more: false,
          items: [
            { message_id: 'om_1', chat_id: 'oc_a', create_time: '1757000000000', sender: { id: 'ou_carol', sender_type: 'user' }, body: { content: JSON.stringify({ text: 'hi' }) } },
          ],
        }
      },
    })
    const result = await feishuThreadContext.read(commands, trigger({
      id: 'abc123', source: 'feishu', meta: { chatId: 'oc_a', messageId: 'om_1' }, threads: [{ source: 'feishu', id: 'oc_a:om_1' }],
    }), 'thread', undefined, { readPageSize: 20 })
    expect(result.status).toBe('chat_neighbours')
    expect(result.messages.map(item => item.text)).toEqual(['hi'])
    expect(result.body).toEqual({ status: 'chat_neighbours', messages: result.messages })
  })

  it('feishuThreadContext.read 把 next_resource 还原成游标', async () => {
    const commands = fakeCommands({
      lark: (args) => {
        if (args[0] === 'api') return sourceResult()
        return { thread_id: 'omt_1', has_more: true, page_token: 'tok/next', messages: [message()] }
      },
    })
    const result = await feishuThreadContext.read(commands, trigger({
      id: 'abc123', source: 'feishu', meta: { chatId: 'oc_a', messageId: 'om_1' }, threads: [{ source: 'feishu', id: 'oc_a:om_1' }],
    }), 'thread', undefined, { readPageSize: 20 })
    expect(result.status).toBe('available')
    expect(result.next).toBe('tok/next')
    expect(commands.calls.lark[1]!.args, '第一页不带 page-token').not.toContain('--page-token')
  })

  it('feishuThreadContext.image 把图片 key 的校验交给 feishu-image', async () => {
    const commands = fakeCommands({})
    await expect(feishuThreadContext.image!({}, commands, trigger({
      id: 'abc123', source: 'feishu', meta: { chatId: 'oc_a', messageId: 'om_1' }, threads: [{ source: 'feishu', id: 'oc_a:om_1' }],
    }), { id: 'om_1', text: 'no image here' }, 'img_wanted', '', new AbortController().signal))
      .rejects.toThrow('Choose an image key from this source message')
    expect(feishuThreadContext.images!('see img_abc and img_abc and img_def')).toEqual(['img_abc', 'img_def'])
  })
})

// ── github-pull：PR 绑定与收尾通知 ──────────────────────────────────────────

describe('github-pull', () => {
  const deployment = {
    repository: 'acme/widgets',
    github: { cli: 'gh', login: 'agent', noreply: '1+agent@users.noreply.github.com' },
    stateDir: '/tmp/state',
    promptMaxChars: 1,
    admissionContextMaxPages: 1,
    admissionContextTimeoutMs: 1,
  } as never
  const pull = (over: Record<string, unknown> = {}): Pull => ({
    number: 12, title: 'T', state: 'open', html_url: 'https://github.com/acme/widgets/pull/12',
    user: { login: 'agent', type: 'User' }, body: null, created_at: '2026-09-09T00:00:01Z',
    head: { sha: 'abc', ref: 'agent/ticket-1', repo: { full_name: 'acme/widgets' } },
    ...over,
  })
  const ticket = (over: Partial<Ticket> = {}): Ticket => ({
    id: 't1', title: 'ticket', decisionId: 'd1', mandate: { actor: { source: 'github', id: 'carol' }, strength: 'explicit', basis: {} } as never,
    channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    origin: { triggerId: 'trig-1', triggerIds: [] }, execution: { name: 'ticket-1', directory: '/tmp/w', assignment: 'do it' },
    ...over,
  })

  /** 只实现被测函数用到的 SourceContext 切片。 */
  const contextOf = (options: { tickets?: Ticket[]; triggers?: Record<string, Trigger>; follows?: boolean } = {}) => {
    const tickets = options.tickets ?? []
    const calls = { bindThread: [] as unknown[][], threadClosed: [] as unknown[][], patch: [] as unknown[][], describe: [] as unknown[][] }
    const context = {
      deployment,
      tickets: {
        get: (id: string) => tickets.find(item => item.id === id),
        open: () => tickets.filter(item => !item.ended),
        bindThread: (...args: unknown[]) => calls.bindThread.push(args),
        threadClosed: (...args: unknown[]) => calls.threadClosed.push(args),
      },
      triggers: { get: (id: string) => options.triggers?.[id], latest: () => undefined },
      threads: {
        patch: (...args: unknown[]) => calls.patch.push(args),
        describe: (...args: unknown[]) => calls.describe.push(args),
      },
      atomic: <T>(work: () => T) => work(),
    }
    return { context: context as unknown as SourceContext, calls }
  }

  it('readPull 读 PR 并补上编号', async () => {
    const commands = fakeCommands({ api: apiWith({ 'pulls/12': pull({ number: undefined }) }) })
    const result = await readPull({ commands } as never, 12)
    expect(result.number).toBe(12)
    expect(result.head.ref).toBe('agent/ticket-1')
    expect(commands.calls.signals).toHaveLength(1)
  })

  it('pullsOf / pullOf 只认 github 线程，open 时跳过已关闭的', () => {
    const follows = [
      { thread: 'github:12', own: true, closed: { at: '2026-09-09T00:00:00Z', outcome: 'merged' as const } },
      { thread: 'feishu:oc_a', own: false },
      { thread: 'github:13', own: true },
    ]
    expect(pullsOf({ follows })).toEqual([12, 13])
    expect(pullsOf({ follows }, true)).toEqual([13])
    expect(pullOf({ follows })).toBe(13)
    expect(pullOf({ follows: [follows[0]!] }), '没有开着的就退回最后一个已关闭的').toBe(12)
    expect(pullsOf({}).length).toBe(0)
  })

  it('agentPull / ticketBranch 判定 PR 是否属于智能体与该工单', () => {
    expect(agentPull(pull(), deployment)).toBe(true)
    expect(agentPull(pull({ user: { login: 'carol' } }), deployment), '别人开的 PR 不算').toBe(false)
    expect(agentPull(pull({ head: { sha: 'a', ref: 'x', repo: { full_name: 'fork/widgets' } } }), deployment), 'fork 来的不算').toBe(false)
    expect(ticketBranch(ticket(), 'agent/ticket-1')).toBe(true)
    expect(ticketBranch(ticket(), 'agent/other')).toBe(false)
    expect(ticketBranch(ticket({ execution: undefined }), 'agent/ticket-1')).toBe(false)
  })

  it('claimPull 拒绝已结束工单、无来源触发且非智能体分支的 PR', () => {
    const ended = contextOf({ tickets: [ticket({ ended: { at: '2026-09-09T00:00:00Z', by: 'executor', outcome: 'closed' } })] })
    expect(claimPull(ended.context, 't1', pull())).toBe('Ticket ended because its PR was closed')

    const foreign = contextOf({ tickets: [ticket()] })
    expect(claimPull(foreign.context, 't1', pull({ user: { login: 'carol' }, head: { sha: 'a', ref: 'feature/x', repo: { full_name: 'acme/widgets' } } })))
      .toContain('PR does not belong to this ticket')
  })

  it('claimPull 接受来源 PR 并绑定；已被别的活工单占用的 PR 被拒', () => {
    const started = contextOf({ tickets: [ticket()], triggers: { 'trig-1': trigger({ meta: { isPr: true, number: 12 } }) } })
    expect(claimPull(started.context, 't1', pull({ user: { login: 'carol' }, head: { sha: 'a', ref: 'feature/x', repo: { full_name: 'acme/widgets' } } })))
      .toBeUndefined()
    expect(started.calls.bindThread).toEqual([['t1', { source: 'github', id: '12' }, false]])
    expect(started.calls.patch).toEqual([['github:12', { number: 12, isPr: true, url: 'https://github.com/acme/widgets/pull/12', prAuthor: 'carol' }]])

    const owner = ticket({ id: 't2', follows: [{ thread: 'github:12', own: true }] })
    const busy = contextOf({ tickets: [ticket(), owner], triggers: { 'trig-1': trigger({ meta: { isPr: true, number: 12 } }) } })
    expect(claimPull(busy.context, 't1', pull())).toBe('PR already belongs to another active ticket')
  })

  it('claimPull 对已关闭的 PR 不绑定也不报错', () => {
    const context = contextOf({ tickets: [ticket()], triggers: { 'trig-1': trigger({ meta: { isPr: true, number: 12 } }) } })
    expect(claimPull(context.context, 't1', pull({ state: 'closed' }))).toBeUndefined()
    expect(context.calls.bindThread).toHaveLength(0)
  })

  it('observePull：合并 / 关闭都上报 threadClosed，并清掉自动合并事实', async () => {
    const context = contextOf({ tickets: [ticket({ follows: [{ thread: 'github:12', own: true }] })] })
    await expect(observePull(context.context, pull({ state: 'closed', merged: true, merged_at: '2026-09-10T00:00:00Z' }))).resolves.toBe(true)
    expect(context.calls.threadClosed).toEqual([[{ source: 'github', id: '12' }, 'merged', '2026-09-10T00:00:00Z']])
    expect(context.calls.describe).toEqual([['github:12', { facts: { autoMerge: null } }]])
  })

  it('observePull：开着的智能体 PR 自动绑到唯一匹配分支的活工单', async () => {
    const context = contextOf({ tickets: [ticket()] })
    await expect(observePull(context.context, pull({ auto_merge: {} }))).resolves.toBe(false)
    expect(context.calls.bindThread).toEqual([['t1', { source: 'github', id: '12' }, true]])
    expect(context.calls.describe).toEqual([['github:12', { facts: { autoMerge: { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } } } }]])
  })

  it('observePull：两个工单共用同一分支时不猜绑定', async () => {
    const context = contextOf({ tickets: [ticket(), ticket({ id: 't2' })] })
    await observePull(context.context, pull())
    expect(context.calls.bindThread, '候选不唯一就不绑').toHaveLength(0)
  })

  it('pullEndNotices 只给非 GitHub 通道发终态通知，按工单原语言选文案', () => {
    const ended = ticket({
      ended: { at: '2026-09-11T00:00:00Z', by: 'executor', outcome: 'merged' },
      channels: [
        { source: 'github', thread: 'github:12', address: { number: '12' } },
        { source: 'feishu', thread: 'feishu:oc_a', address: { chatId: 'oc_a', messageId: 'om_1' } },
      ],
      follows: [{ thread: 'github:12', own: true, closed: { at: '2026-09-11T00:00:00Z', outcome: 'merged' } }],
    })
    const notices = pullEndNotices(ended, '把这个修掉', 'acme/widgets')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ channel: { source: 'feishu' }, kind: 'notice', ticketId: 't1' })
    expect(notices[0]!.text).toBe('[PR #12](https://github.com/acme/widgets/pull/12) 已合并。')
    expect(pullEndNotices(ended, 'fix it', 'acme/widgets')[0]!.text).toBe('[PR #12](https://github.com/acme/widgets/pull/12) has merged.')
    expect(pullEndNotices({ ...ended, ended: { at: 'x', by: 'executor', outcome: 'closed' } }, '把这个修掉', 'acme/widgets')[0]!.text)
      .toBe('[PR #12](https://github.com/acme/widgets/pull/12) 已关闭，未合并。')
    expect(pullEndNotices({ ...ended, ended: { at: 'x', by: 'executor', outcome: 'closed' } }, 'fix it', 'acme/widgets')[0]!.text)
      .toBe('[PR #12](https://github.com/acme/widgets/pull/12) was closed without merging.')
  })

  it('pullEndNotices 没有终态、没有跟到 PR、或只有一个 GitHub 通道时不给通知', () => {
    const base = ticket({ follows: [{ thread: 'github:12', own: true, closed: { at: '2026-09-11T00:00:00Z', outcome: 'merged' } }] })
    expect(pullEndNotices(base, 'x', 'acme/widgets')).toEqual([])
    expect(pullEndNotices({ ...base, ended: { at: 'x', by: 'executor', outcome: 'merged' }, follows: [] }, 'x', 'acme/widgets')).toEqual([])
    expect(pullEndNotices({ ...base, ended: { at: 'x', by: 'executor', outcome: 'merged' }, channels: [{ source: 'github', thread: 'github:12', address: {} }] }, 'x', 'acme/widgets'))
      .toEqual([])
    const own = ticket({
      ended: { at: 'x', by: 'executor', outcome: 'merged' },
      channels: [{ source: 'feishu', thread: 'feishu:oc_a', address: { chatId: 'oc_a' } }],
      follows: [
        { thread: 'github:13', own: false, closed: { at: '2026-09-11T00:00:00Z', outcome: 'closed' } },
        { thread: 'github:12', own: true, closed: { at: '2026-09-10T00:00:00Z', outcome: 'merged' } },
      ],
    })
    expect(pullEndNotices(own, 'x', 'acme/widgets')[0]!.text, '优先用工单自己开的 PR').toContain('PR #12')
  })
})

// ── 出站通道 ────────────────────────────────────────────────────────────────

describe('github-channel', () => {
  const message = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
    id: 'r1', channel: { source: 'github', thread: 'github:12', address: { number: '12' } }, text: 'hello', kind: 'reply',
    ...over,
  })

  it('sendGithub 发顶层评论，正文带幂等标记', async () => {
    const commands = fakeCommands({ pages: () => [], api: () => undefined })
    const host = { commands } as unknown as Pick<SourceContext, 'commands'>
    await expect(sendGithub(host, message())).resolves.toBe('sent')
    expect(commands.calls.pages).toEqual(['issues/12/comments'])
    expect(commands.calls.api.at(-1)!.path).toBe('issues/12/comments')
    expect(commands.calls.api.at(-1)!.flags).toEqual(['--method', 'POST', '-f', 'body=hello\n\n<!-- dsh-superagent:r1 -->'])
  })

  it('sendGithub 发现智能体已发过同一条（同标记同根）时不再发', async () => {
    const commands = fakeCommands({ pages: () => [{ id: 9, user: { login: 'AGENT' }, body: 'hello\n\n<!-- dsh-superagent:r1 -->' }] })
    await expect(sendGithub({ commands } as never, message())).resolves.toBe('sent')
    expect(commands.calls.api).toHaveLength(0)
  })

  it('sendGithub 回复 review 讨论：先找根评论，再往 /replies 发', async () => {
    const commands = fakeCommands({
      api: (path) => path === 'pulls/comments/77' ? { id: 77, in_reply_to_id: 70 } : undefined,
      pages: () => [],
    })
    const address = { number: '12', url: 'https://github.com/acme/widgets/pull/12#discussion_r77' }
    await expect(sendGithub({ commands } as never, message({ channel: { source: 'github', thread: 'github:12', address } }))).resolves.toBe('sent')
    expect(commands.calls.pages).toEqual(['pulls/12/comments'])
    expect(commands.calls.api.at(-1)!.path).toBe('pulls/12/comments/70/replies')
  })

  it('sendGithub 目标 review 评论已删（404）时退回顶层 PR 评论', async () => {
    const commands = fakeCommands({
      api: (path) => {
        if (path === 'pulls/comments/77') throw new CliError('Not Found', 404)
        return undefined
      },
      pages: () => [],
    })
    const address = { number: '12', url: 'https://github.com/acme/widgets/pull/12#discussion_r77' }
    await expect(sendGithub({ commands } as never, message({ channel: { source: 'github', thread: 'github:12', address } }))).resolves.toBe('sent')
    expect(commands.calls.api.at(-1)!.path, '退回 issues/<n>/comments').toBe('issues/12/comments')
  })

  it('sendGithub 把 410 与「已锁定」的 403 当成目标永久消失', async () => {
    const gone410 = fakeCommands({ pages: () => { throw new CliError('Gone', 410) } })
    await expect(sendGithub({ commands: gone410 } as never, message())).resolves.toBe('gone')
    const locked = fakeCommands({ pages: () => { throw new CliError('The issue is locked', 403) } })
    await expect(sendGithub({ commands: locked } as never, message())).resolves.toBe('gone')
  })

  it('sendGithub 别的失败照抛，缺回复目标直接报错', async () => {
    const failing = fakeCommands({ pages: () => { throw new CliError('server error', 500) } })
    await expect(sendGithub({ commands: failing } as never, message())).rejects.toThrow('server error')
    await expect(sendGithub({ commands: fakeCommands({}) } as never, message({ channel: { source: 'github', thread: 'github:12', address: {} } })))
      .rejects.toThrow('Missing GitHub reply target')
  })

  it('githubLink 拼链接与标签，review 讨论的标签不同', () => {
    expect(githubLink({ number: '12' }, {})).toEqual({ url: '', label: { zh: 'GitHub #12', en: 'GitHub #12' } })
    expect(githubLink({ number: '12' }, { repository: 'acme/widgets' }).url).toBe('https://github.com/acme/widgets/issues/12')
    expect(githubLink({ number: '12', url: 'https://github.com/acme/widgets/pull/12#discussion_r1' }, { repository: 'acme/widgets' }))
      .toMatchObject({ label: { zh: 'GitHub #12 的 review 讨论', en: 'Review discussion on GitHub #12' } })
  })
})

describe('feishu-channel', () => {
  const message = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
    id: 'r1', channel: { source: 'feishu', thread: 'feishu:oc_a', address: { chatId: 'oc_a', messageId: 'om_1' } }, text: 'hello', kind: 'reply',
    ...over,
  })

  it('feishuChatLink / feishuLink 按品牌拼 AppLink，带触发深链', () => {
    expect(feishuChatLink('feishu', 'oc_a')).toBe('https://applink.feishu.cn/client/chat/open?openChatId=oc_a')
    expect(feishuChatLink('lark', 'oc_a')).toBe('https://applink.larksuite.com/client/chat/open?openChatId=oc_a')
    expect(feishuLink({ chatId: 'oc_a', messageId: 'om_1' }, {})).toEqual({
      url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_a',
      label: { zh: '飞书消息', en: 'Feishu message' }, triggerId: feishuTriggerId('om_1'),
    })
    expect(feishuLink({ chatId: 'oc_a' }, { feishu: { brand: 'lark' } as never })).toEqual({
      url: 'https://applink.larksuite.com/client/chat/open?openChatId=oc_a', label: { zh: '飞书消息', en: 'Feishu message' },
    })
  })

  it('sendFeishu 用消息 ID 作幂等键在线程里回复', async () => {
    const commands = fakeCommands({ lark: () => ({ ok: true, data: {} }) })
    await expect(sendFeishu({ commands } as never, message())).resolves.toBe('sent')
    expect(commands.calls.lark[0]!.args).toEqual([
      'im', '+messages-reply', '--message-id', 'om_1', '--markdown', 'hello', '--reply-in-thread', '--idempotency-key', 'r1',
    ])
  })

  it('sendFeishu 缺回复目标与超长消息都在发请求前报错', async () => {
    const commands = fakeCommands({})
    await expect(sendFeishu({ commands } as never, message({ channel: { source: 'feishu', thread: 'feishu:oc_a', address: { chatId: 'oc_a' } } })))
      .rejects.toThrow('Missing Feishu reply target')
    await expect(sendFeishu({ commands } as never, message({ text: Array.from({ length: 101 }, () => 'word').join(' ') })))
      .rejects.toThrow(/maximum is 100/)
    expect(commands.calls.lark).toHaveLength(0)
  })

  it('sendFeishu 把撤回 / 已删除的错误码归一成 gone，别的错误照抛', async () => {
    const withdrawn = fakeCommands({ lark: () => { throw new CliError('message was withdrawn', 230011) } })
    await expect(sendFeishu({ commands: withdrawn } as never, message())).resolves.toBe('gone')
    const notFound = fakeCommands({ lark: () => { throw new CliError('message not found', 230012) } })
    await expect(sendFeishu({ commands: notFound } as never, message())).resolves.toBe('gone')
    const other = fakeCommands({ lark: () => { throw new CliError('rate limited', 230020) } })
    await expect(sendFeishu({ commands: other } as never, message())).rejects.toThrow('rate limited')
    const plain = fakeCommands({ lark: () => { throw new Error('boom') } })
    await expect(sendFeishu({ commands: plain } as never, message())).rejects.toThrow('boom')
  })
})

// ── poll：订阅线程池的轮询小工具 ────────────────────────────────────────────

describe('poll', () => {
  const thread = (over: Partial<Thread> = {}): Thread => ({
    key: 'github:12', ref: { source: 'github', id: '12' }, createdAt: '2026-09-01T00:00:00.000Z',
    subscriptions: [], correlated: [], pending: [], meta: {}, ...over,
  })
  const contextOf = (tickets: Record<string, Ticket> = {}) => {
    const patches: unknown[][] = []
    const context = {
      threads: { patch: (...args: unknown[]) => patches.push(args) },
      tickets: { get: (id: string) => tickets[id] },
    }
    return { context: context as unknown as SourceContext, patches }
  }

  it('cursorAt 把游标往回挪 5 秒', () => {
    expect(cursorAt('2026-09-09T00:00:10.000Z')).toBe('2026-09-09T00:00:05.000Z')
  })

  it('polled：有活工单、最近有活动就继续，超过 horizon 停止', () => {
    const now = Date.parse('2026-09-20T00:00:00.000Z')
    const live = contextOf({ t1: { ended: undefined } as never })
    expect(polled(live.context, thread({ subscriptions: ['t1'] }), now)).toBe(true)
    expect(polled(contextOf().context, thread({ lastAt: '2026-09-19T00:00:00.000Z' }), now)).toBe(true)
    expect(polled(contextOf().context, thread({ createdAt: '2026-09-01T00:00:00.000Z' }), now)).toBe(false)
    expect(polled(contextOf().context, thread({ createdAt: new Date(now - POLL_HORIZON_MS + 1000).toISOString() }), now)).toBe(true)
    expect(polled(contextOf().context, thread(), now)).toBe(false)
  })

  it('pollThreads 成功清掉 pollError，失败记 String(error)，skip 与 aborted 不轮询', async () => {
    const recent = { lastAt: new Date().toISOString() }
    const { context } = contextOf()
    context.threads.subscribed = () => [thread(recent), thread({ ...recent, key: 'github:13', ref: { source: 'github', id: '13' } })]
    const polls: string[] = []
    await pollThreads(context, 'github', () => false, async item => { polls.push(item.key) })
    expect(polls).toEqual(['github:12', 'github:13'])

    const failing = contextOf()
    failing.context.threads.subscribed = () => [thread(recent)]
    await pollThreads(failing.context, 'github', () => false, async () => { throw new Error('boom') })
    expect(failing.patches).toEqual([['github:12', { pollError: 'Error: boom' }]])

    const skipped = contextOf()
    skipped.context.threads.subscribed = () => [thread(recent)]
    await pollThreads(skipped.context, 'github', () => false, async () => { throw new Error('不该被轮询') }, () => true)
    expect(skipped.patches, 'skip 的线程连失败都不记').toHaveLength(0)

    const stopped = contextOf()
    stopped.context.threads.subscribed = () => [thread(recent)]
    await pollThreads(stopped.context, 'github', () => true, async () => { throw new Error('不该被轮询') })
    expect(stopped.patches).toHaveLength(0)
  })

  it('polled 的已结束工单不阻止 horizon 判定', () => {
    const now = Date.parse('2026-09-20T00:00:00.000Z')
    const ended = contextOf({ t1: { ended: { at: 'x', by: 'executor', outcome: 'closed' } } as never })
    expect(polled(ended.context, thread({ subscriptions: ['t1'], createdAt: '2026-09-01T00:00:00.000Z' }), now)).toBe(false)
  })

  it('pause 到点或中止都 resolve，已中止的信号立刻返回', async () => {
    const controller = new AbortController()
    await expect(pause(5, controller.signal)).resolves.toBeUndefined()
    controller.abort()
    await expect(pause(10_000, controller.signal)).resolves.toBeUndefined()
    const midway = new AbortController()
    const running = pause(10_000, midway.signal)
    setTimeout(() => midway.abort(), 5)
    await expect(running).resolves.toBeUndefined()
  })
})

// ── admission-context：准入窗口 ─────────────────────────────────────────────

describe('admission-context', () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({ id: `m${index + 1}`, from: 'carol', at: '', text: `t${index + 1}` }))

  it('threadWindow 保留前五条与来源两侧各五条，并记录被略过的数量', () => {
    const window = threadWindow(messages, 'm9')
    expect(window.source_found).toBe(true)
    expect(window.loaded_messages).toBe(12)
    expect(window.entries.map(entry => entry.message.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12'])
    expect(window.entries[0]).toMatchObject({ position: 1, omitted_before: 0 })
    expect(window.omitted_after).toBe(0)
  })

  it('threadWindow 对来源不在列表里只保留前五条，中间的断层记 omitted_before', () => {
    const window = threadWindow(messages.slice(0, 8), 'missing')
    expect(window.source_found).toBe(false)
    expect(window.entries.map(entry => entry.position)).toEqual([1, 2, 3, 4, 5])
    expect(window.omitted_after, '后面三条被略过').toBe(3)
    // 来源是第 12 条：窗口是前五条 + 6..12，第 6 条（下标 5）被略过。
    const sparse = threadWindow(messages, 'm12')
    expect(sparse.entries.map(entry => entry.position)).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12])
    expect(sparse.entries.map(entry => entry.omitted_before)).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0])
    expect(sparse.omitted_after).toBe(0)
  })

  it('admissionContext 按 maxPages 分页、去重，并汇总 status / complete / next', async () => {
    const reads: (string | undefined)[] = []
    const context = {
      messageId: 'm1',
      async read(_commands: unknown, _part: string, cursor?: string) {
        reads.push(cursor)
        if (cursor === undefined) return { messages: [messages[0]!, messages[1]!], next: 'p2', status: 'chat_neighbours' }
        return { messages: [messages[1]!, messages[2]!], next: 'p3', status: 'available' }
      },
    }
    const result = await admissionContext(context as never, {} as never, 2)
    expect(reads).toEqual([undefined, 'p2'])
    expect(result.messages.map(message => message.id)).toEqual(['m1', 'm2', 'm3'])
    expect(result.complete).toBe(false)
    expect(result.next).toBe('p3')
    expect(result.status, '第一页的 status 优先').toBe('chat_neighbours')
    expect(result.window.source_found).toBe(true)
  })

  it('admissionContext 读完所有页时 complete 为 true', async () => {
    const context = {
      messageId: 'm1',
      async read() { return { messages: [messages[0]!] } },
    }
    const result = await admissionContext(context as never, {} as never, 3)
    expect(result.complete).toBe(true)
    expect(result.next).toBeNull()
    expect(result.status).toBeUndefined()
  })

  it('admissionContext 发现游标重复时抛错，不静默返回半份上下文', async () => {
    const context = {
      messageId: 'm1',
      async read() { return { messages: [], next: 'same' } },
    }
    await expect(admissionContext(context as never, {} as never, 5)).rejects.toThrow(/pagination repeated a cursor/)
  })
})

// ── host：体检文案 ──────────────────────────────────────────────────────────

describe('host.health', () => {
  it('health 用英文模板填值，带 code 与 values', () => {
    const result = health('error', 'pollFailures', { count: '3', error: 'boom' })
    expect(result).toEqual({
      state: 'error', detail: '3 consecutive failed polls; last: boom', code: 'pollFailures', values: { count: '3', error: 'boom' },
    })
    expect(health('paused', 'setupPending')).toEqual({ state: 'paused', detail: 'Waiting for the deployment check', code: 'setupPending' })
  })
})

// ── feishu-image：准入评估时的图片下载 ──────────────────────────────────────

describe('feishu-image', () => {
  it('admissionImageKeys 只抽 img_ 前缀的 key 并去重', () => {
    expect(admissionImageKeys('img_abc and img_abc and img_def')).toEqual(['img_abc', 'img_def'])
    expect(admissionImageKeys('no keys here')).toEqual([])
  })

  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')])
  const ref = { triggerId: 'trig-1', chatId: 'oc_a', messageId: 'om_1' }

  /** 用临时附件仓库换掉进程级那一份（跑完还原），避免写真实 ~/.dsc。 */
  const withStore = <T>(work: (root: string) => Promise<T>): Promise<T> => {
    const root = createTempDir('dsc-sa-attachments-')
    setAttachmentStoreForTest(new AttachmentStore({ root }))
    return work(root).finally(() => { setAttachmentStoreForTest(null) })
  }

  /** 造一个假 lark-cli：把文件写进调用方给的临时目录并返回 saved_path。 */
  const downloader = (fileName: string, bytes: Buffer, outside?: string) => fakeCommands({
    lark: (_args, cwd) => {
      const target = outside ? join(outside, fileName) : join(cwd!, fileName)
      writeFileSync(target, bytes)
      return { saved_path: target }
    },
  })

  it('把下载到的 PNG 存成附件并返回元数据，临时目录用完即删', async () => {
    await withStore(async (root) => {
      const commands = downloader('image.png', PNG)
      const result = await readAdmissionImage({}, commands, ref, 'see img_abc', 'img_abc', root, new AbortController().signal)
      expect(result.source_message_id).toBe('om_1')
      expect(result.image_key).toBe('img_abc')
      expect(result.image).toMatchObject({ kind: 'image', mime: 'image/png' })
      expect(result.image.sha).toMatch(/^[0-9a-f]{64}$/)
      const cwd = commands.calls.lark[0]!.cwd!
      expect(cwd.startsWith(root), '临时下载目录建在 stateDir 下').toBe(true)
      await expect(import('node:fs/promises').then(fs => fs.access(cwd))).rejects.toThrow()
    })
  })

  it('图片 key 必须来自这条消息，消息 ID 必须是 Feishu 形状', async () => {
    await withStore(async (root) => {
      await expect(readAdmissionImage({}, fakeCommands({}), ref, 'no key here', 'img_abc', root, new AbortController().signal))
        .rejects.toThrow('Choose an image key from this source message')
      await expect(readAdmissionImage({}, fakeCommands({}), { ...ref, messageId: 'not-a-message' }, 'img_abc', 'img_abc', root, new AbortController().signal))
        .rejects.toThrow()
    })
  })

  it('下载结果指到临时目录外、扩展名不支持、内容不是图片都拒绝', async () => {
    await withStore(async (root) => {
      const outside = downloader('image.png', PNG, root)
      await expect(readAdmissionImage({}, outside, ref, 'img_abc', 'img_abc', root, new AbortController().signal))
        .rejects.toThrow('Image download returned a path outside its temporary directory')
      const text = downloader('image.txt', Buffer.from('plain'))
      await expect(readAdmissionImage({}, text, ref, 'img_abc', 'img_abc', root, new AbortController().signal))
        .rejects.toThrow(/not a supported PNG\/JPEG\/WebP\/GIF image/)
      const fake = downloader('image.png', Buffer.from('not really a png'))
      await expect(readAdmissionImage({}, fake, ref, 'img_abc', 'img_abc', root, new AbortController().signal))
        .rejects.toThrow(/not a supported PNG\/JPEG\/WebP\/GIF image/)
    })
  })

  it('下载回来是目录时按「不是普通文件」拒绝', async () => {
    await withStore(async (root) => {
      const directory = fakeCommands({
        lark: (_args, cwd) => { mkdirSync(join(cwd!, 'image.png')); return { saved_path: join(cwd!, 'image.png') } },
      })
      await expect(readAdmissionImage({}, directory, ref, 'img_abc', 'img_abc', root, new AbortController().signal))
        .rejects.toThrow(/exceeds the attachment byte limit or is not a regular file/)
    })
  })

  it('已中止的信号在下载前就抛', async () => {
    await withStore(async (root) => {
      const controller = new AbortController()
      controller.abort()
      await expect(readAdmissionImage({}, fakeCommands({}), ref, 'img_abc', 'img_abc', root, controller.signal))
        .rejects.toThrow()
    })
  })
})
