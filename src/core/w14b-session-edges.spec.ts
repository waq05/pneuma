/**
 * `core/session.ts` 的缺口补齐：附件丢了的那张图换一行说明、会话列表里 stat 失败的条目跳过、
 * 头行坏掉的会话从 changes 反推工作目录、读不动的会话文件只丢这一条、rewind 前遇到坏行。
 *
 * 夹具是临时 DSC_HOME 下真写的 jsonl；`statSync` 只对一个点名的文件名抛错（模拟文件
 * 在 readdir 之后被删），其余原样透传。不碰真实 `~/.dsc`。
 *
 * @module dsc/core/w14b-session-edges.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

/** statSync 要抛错的文件名（只按文件名匹配，避免误伤别的路径）。 */
const ghost = vi.hoisted(() => ({ name: '' }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: (...args: unknown[]) => {
      const path = String(args[0] ?? '')
      if (ghost.name !== '' && path.endsWith(ghost.name)) throw Object.assign(new Error('没有这个文件'), { code: 'ENOENT' })
      return (actual.statSync as unknown as (...args: unknown[]) => unknown)(...args)
    },
  }
})

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14b-session-'))
process.env['DSC_HOME'] = HOME

type Core = typeof import('./session.js')
let core: Core
const WORK = 'D:\\work\\w14b-session'
let sessionDir = ''

beforeAll(async () => {
  core = await import('./session.js')
  sessionDir = join(core.sessionsRoot(), core.slugCwd(WORK))
  mkdirSync(sessionDir, { recursive: true })
})

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5 })
})

/** 写一份会话文件，返回路径。 */
function sessionFile(name: string, lines: string[]): string {
  const file = join(sessionDir, `${name}.jsonl`)
  writeFileSync(file, lines.map((line) => `${line}\n`).join(''), 'utf8')
  return file
}

/** 一条 meta 行。 */
function meta(id: string): string {
  return JSON.stringify({ type: 'meta', id, cwd: WORK, createdAt: 1_000 })
}

describe('appendUser：附件读不出来', () => {
  test('丢掉的那张图换成一句说明，这条消息照常落库', () => {
    const file = join(HOME, 'live-user.jsonl')
    const session = core.Session.create(WORK, file)
    // 引用一个仓库里不存在的附件：读图这一步会抛，userContent 把它折成一句说明。
    session.appendUser('看这张图', [`/api/attachments/${'0'.repeat(64)}`])
    const message = session.messages[session.messages.length - 1]
    expect(typeof message?.content).toBe('string')
    expect(String(message?.content)).toContain('图片已丢失')
  })
})

describe('listSessions：坏会话的各种兜底', () => {
  test('头行坏了但能从 changes 反推工作目录：仍然在列表里', () => {
    sessionFile('broken-head', [
      '{不是 meta',
      JSON.stringify({ type: 'user', text: '改一下这个文件', changes: [{ path: join(WORK, 'a.ts') }], ts: 1_000 }),
    ])
    const item = core.listSessions().find((row) => row.id === 'broken-head')
    expect(item).toBeDefined()
    expect(item?.cwd).toBe(WORK)
    expect(item?.title).toContain('改一下这个文件')
  })

  test('会话文件读不动（同名目录占着）：只丢这一条，其余照常列出', () => {
    mkdirSync(join(sessionDir, 'is-a-dir.jsonl'), { recursive: true })
    sessionFile('good-one', [meta('good-one'), JSON.stringify({ type: 'user', text: '在', ts: 1_000 })])
    const ids = core.listSessions().map((row) => row.id)
    expect(ids).toContain('good-one')
    expect(ids).not.toContain('is-a-dir')
  })

  test('文件在 readdir 之后 stat 失败：跳过这一条，不炸整次列表', () => {
    sessionFile('ghost-session', [meta('ghost-session'), JSON.stringify({ type: 'user', text: '在', ts: 1_000 })])
    ghost.name = 'ghost-session.jsonl'
    try {
      const ids = core.listSessions().map((row) => row.id)
      expect(ids).not.toContain('ghost-session')
    } finally {
      ghost.name = ''
    }
  })
})

describe('readUserMessages：rewind 前遇到坏行', () => {
  test('以 {"type":" 开头但 JSON 坏掉的行原样跳过，其余用户消息照常返回', () => {
    const file = sessionFile('rewind-bad', [
      meta('rewind-bad'),
      JSON.stringify({ type: 'user', text: '第一条', ts: 1_000 }),
      '{"type":"user",坏掉的行}',
      JSON.stringify({ type: 'user', text: '第三条', ts: 2_000 }),
    ])
    expect(core.readUserMessages(file)).toEqual(['第一条', '第三条'])
  })
})
