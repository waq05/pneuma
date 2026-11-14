/**
 * 桌面壳 @ 补全的多工作区根自检（迁自 `scripts/ui-mention-roots-test.mjs`，T50 第④项）。
 *
 * 五件事，全部走假通道直接驱动 `mention.ts` 导出的 `listWorkspaceFiles`（纯列表逻辑，
 * 不需要真渲染）：
 *   ① 第二根（配置里的额外根）的文件以**绝对路径**出现在候选里；
 *   ② 主根（会话 cwd）仍是相对路径，与旧行为逐字一致；
 *   ③ 预算共享：第一个根几千条时第二根仍拿得到 `MIN_FILES_PER_ROOT` 条；
 *   ④ `fs-roots` 抛错（旧宿主没有这个 op）时退回单根、不抛异常、`fs-list` 不传 root；
 *   ⑤ 缓存键带根集合：60 秒内根一变就重扫（旧根的候选不会留着）。
 *
 * 为什么归 ui project：`mention.ts` 顶层 import react 与 `@dsc/ui` 的类型，落在本目录
 * 即归 ui project 收（`src/packages/<pkg>/ui/**`）。jsdom 环境对这份纯列表逻辑无副作用。
 *
 * 通道桩的类型收窄：`listWorkspaceFiles` 的形参是宿主通道全型，桩只实现了它读的
 * `invoke` 一条路——与原探针同构，收窄成桩真实提供的面（`as unknown as` 是给
 * 「桩 ≠ 全型」的显式标记，不是绕检查）。
 *
 * @module dsc-ui-composer/ui/mention.spec
 */
import { describe, expect, test } from 'vitest'
import type { useHostChannel } from '@dsc/ui'
import { MAX_FILES, MIN_FILES_PER_ROOT, listWorkspaceFiles } from './mention.js'

/** 桩通道收到的每次调用（方法名 + 实参表）。 */
interface RecordedCall {
  method: string
  args: unknown[]
}

/** 假 dock 通道：只实现 `listWorkspaceFiles` 真正走的那条 `invoke`。 */
interface FakeChannel {
  calls: RecordedCall[]
  invoke(method: string, args?: unknown[]): Promise<unknown>
}

/** `fs-roots` 的回包行。 */
interface FakeRoot {
  path: string
  name: string
  main: boolean
}

/** `fs-list` 的回包行。 */
interface FakeEntry {
  name: string
  dir: boolean
}

/** 正斜杠 + 去尾部分隔符：与 mention.ts 的候选路径拼法对齐。 */
const posix = (path: string): string => path.replaceAll('\\', '/').replace(/\/+$/, '')

/** 单根兜底时 `fs-list` 不带 root，假通道用这个哨兵归账。 */
const MAIN_SENTINEL = '\u0000main'

/**
 * 造一份假通道。
 *
 * @param options.roots - `fs-roots` 回包
 * @param options.listing - `根|dir` → 条目表
 * @param options.failRoots - 让 `fs-roots` 直接拒绝（模拟旧宿主）
 */
function makeChannel(options: {
  roots: FakeRoot[]
  listing: Record<string, FakeEntry[]>
  failRoots?: boolean
}): FakeChannel {
  const { roots, listing, failRoots = false } = options
  const calls: RecordedCall[] = []
  return {
    calls,
    async invoke(method: string, args: unknown[] = []): Promise<unknown> {
      calls.push({ method, args })
      if (method !== 'dock') throw new Error(`未预期的通道：${method}`)
      const [op, payload = {}] = args as [string, Record<string, unknown>]
      if (op === 'fs-roots') {
        if (failRoots) throw new Error('dock 未知操作：fs-roots')
        return { cwd: roots[0]?.path, roots }
      }
      if (op === 'fs-list') {
        const root = payload.root ?? MAIN_SENTINEL
        const key = `${String(root)}|${String(payload.dir)}`
        if (!(key in listing)) throw new Error(`ENOENT ${key}`)
        return { entries: listing[key] }
      }
      throw new Error(`未预期的 op：${op}`)
    },
  }
}

/** 桩 → 宿主通道全型的收窄（桩只覆盖 invoke 一条路）。 */
const asHostChannel = (channel: FakeChannel): ReturnType<typeof useHostChannel> => channel as unknown as ReturnType<typeof useHostChannel>

describe('① 多根候选的路径形态', () => {
  test('第二根绝对路径、主根相对路径、按根传 root', async () => {
    const main = 'D:\\w\\fake-main'
    const extra = 'D:\\w\\fake-extra'
    const channel = makeChannel({
      roots: [
        { path: main, name: 'fake-main', main: true },
        { path: extra, name: 'fake-extra', main: false },
      ],
      listing: {
        [`${main}|.`]: [
          { name: 'src', dir: true },
          { name: 'README.md', dir: false },
        ],
        [`${main}|src`]: [{ name: 'a.ts', dir: false }],
        [`${extra}|.`]: [{ name: 'b.txt', dir: false }],
      },
    })
    const files = await listWorkspaceFiles(asHostChannel(channel))
    const extraFile = `${posix(extra)}/b.txt`

    expect(files).toContain(extraFile)
    expect(extraFile.startsWith(`${posix(extra)}/`)).toBe(true)
    expect(files).toContain('src/a.ts')
    expect(files).toContain('README.md')
    expect(files.filter((file) => file !== extraFile).every((file) => !file.includes(posix(main)))).toBe(true)
    expect(
      channel.calls.some(
        (call) => call.args[0] === 'fs-list' && (call.args[1] as Record<string, unknown>)?.root === extra && (call.args[1] as Record<string, unknown>)?.dir === '.',
      ),
    ).toBe(true)
    expect(
      channel.calls.some(
        (call) => call.args[0] === 'fs-list' && (call.args[1] as Record<string, unknown>)?.root === main && (call.args[1] as Record<string, unknown>)?.dir === '.',
      ),
    ).toBe(true)
    expect(channel.calls.some((call) => call.args[0] === 'fs-roots')).toBe(true)
  })
})

describe('② 多根共享预算 + 每根最小份额', () => {
  test('第一个根几千条时第二根仍拿到最小份额，总条数封顶', async () => {
    const main = 'D:\\w\\flood-main'
    const extra = 'D:\\w\\flood-extra'
    const flood = Array.from({ length: 5000 }, (_, index) => ({ name: `m${String(index)}.ts`, dir: false }))
    const plenty = Array.from({ length: 300 }, (_, index) => ({ name: `x${String(index)}.ts`, dir: false }))
    const channel = makeChannel({
      roots: [
        { path: main, name: 'flood-main', main: true },
        { path: extra, name: 'flood-extra', main: false },
      ],
      listing: { [`${main}|.`]: flood, [`${extra}|.`]: plenty },
    })
    const files = await listWorkspaceFiles(asHostChannel(channel))
    const extraPrefix = `${posix(extra)}/`
    const mainCount = files.filter((file) => !file.startsWith(extraPrefix)).length
    const extraCount = files.filter((file) => file.startsWith(extraPrefix)).length

    expect(files.length).toBeLessThanOrEqual(MAX_FILES)
    expect(extraCount).toBeGreaterThanOrEqual(MIN_FILES_PER_ROOT)
    expect(mainCount).toBeLessThanOrEqual(MAX_FILES - MIN_FILES_PER_ROOT)
    expect(files.length).toBe(MAX_FILES)
  })
})

describe('③ 旧宿主没有 fs-roots：退回单根', () => {
  test('fs-roots 抛错时 listWorkspaceFiles 不抛，候选仍是相对路径且不传 root', async () => {
    const main = 'D:\\w\\legacy-main'
    const channel = makeChannel({
      roots: [],
      failRoots: true,
      listing: {
        [`${MAIN_SENTINEL}|.`]: [
          { name: 'keep.txt', dir: false },
          { name: 'src', dir: true },
        ],
        [`${MAIN_SENTINEL}|src`]: [{ name: 'legacy.ts', dir: false }],
      },
    })
    let files: string[] | null = null
    let error: unknown = null
    try {
      files = await listWorkspaceFiles(asHostChannel(channel))
    } catch (caught) {
      error = caught
    }
    expect(error).toBeNull()
    expect(files).toContain('keep.txt')
    expect(files).toContain('src/legacy.ts')
    const listCall = channel.calls.find((call) => call.args[0] === 'fs-list')
    expect(listCall).toBeDefined()
    expect('root' in (listCall?.args[1] as Record<string, unknown>)).toBe(false)
    expect(files?.every((file) => !file.includes(posix(main)))).toBe(true)
  })
})

describe('④ 根集合变了就重扫（缓存键）', () => {
  test('换根前有旧根的候选，换根后新根出现、旧根消失、确实重扫', async () => {
    const main = 'D:\\w\\switch-main'
    const firstExtra = 'D:\\w\\switch-b'
    const secondExtra = 'D:\\w\\switch-c'
    const first = makeChannel({
      roots: [
        { path: main, name: 'switch-main', main: true },
        { path: firstExtra, name: 'switch-b', main: false },
      ],
      listing: {
        [`${main}|.`]: [{ name: 'main.txt', dir: false }],
        [`${firstExtra}|.`]: [{ name: 'b.txt', dir: false }],
      },
    })
    const before = await listWorkspaceFiles(asHostChannel(first))
    const second = makeChannel({
      roots: [
        { path: main, name: 'switch-main', main: true },
        { path: secondExtra, name: 'switch-c', main: false },
      ],
      listing: {
        [`${main}|.`]: [{ name: 'main.txt', dir: false }],
        [`${secondExtra}|.`]: [{ name: 'c.txt', dir: false }],
      },
    })
    const after = await listWorkspaceFiles(asHostChannel(second))

    expect(before).toContain(`${posix(firstExtra)}/b.txt`)
    expect(after).toContain(`${posix(secondExtra)}/c.txt`)
    expect(after).not.toContain(`${posix(firstExtra)}/b.txt`)
    expect(second.calls.some((call) => call.args[0] === 'fs-list')).toBe(true)
  })
})
