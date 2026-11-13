/**
 * @pneuma/superagent 的全链路用例：一条 GitHub 来源的 Trigger 从「收到」走到「建出工单」。
 *
 * 为什么单独一份：适配器那 14 条用例验的是「URL 与 JSON 怎么变成 Trigger」，验不到
 * 「Trigger 进来之后能不能真的建单」。中间还隔着两处会静默失败的地方——
 *
 *   - 准入闸（`core/policy.ts:203`）：名单没登记、来源不在范围内，都只会让这条消息
 *     `filtered` 掉，日志上什么都不显眼；
 *   - 判定器（`adapters/assessor.ts:93`）：候选入队后要在泵的一拍里被取出来才会 `decide`。
 *
 * 这两处任一没接好，症状都是「轮询在跑、一条单也不建」。这条用例把它们连起来钉住。
 *
 * 执行器用假的：本用例要证的是「工单建出来了」，不是「worker 会改代码」——后者在
 * `_sa-resume-e2e.mjs` 里用真宿主跑过。
 *
 * 迁移说明：原文件跑的是构建产物、先手工 build；现在直接 import
 * 源码，环境变量在动态 import 之前设好。
 *
 * @module @pneuma/superagent/tests/chain
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { Trigger } from '../core/model.js'
import type { DscStore } from '../adapters/store.js'
import type { SuperagentRuntime as RuntimeInstance } from '../runtime.js'

const home = mkdtempSync(join(tmpdir(), 'superagent-chain-home-'))
process.env['DSC_HOME'] = home

const { openStore } = await import('../adapters/store.js')
const { SuperagentRuntime } = await import('../runtime.js')
const { defaultSettings } = await import('../adapters/settings.js')
const { superagentScope } = await import('../adapters/scope.js')

afterAll(() => { rmSync(home, { recursive: true, force: true }) })

/** 配好的一套：仓库 `owner/repo`，名单只有 alice。 */
const ACCOUNT = { repository: 'owner/repo', login: 'pneuma-bot', allowed: ['alice'] }

/** 造一条来自 GitHub 的「人对机器人说的话」。 */
function githubTrigger(
  { actor = 'alice', repository = 'owner/repo', text = '@pneuma-bot 把 README 里的错别字改掉' }:
  { actor?: string; repository?: string; text?: string } = {},
): Trigger {
  const at = new Date().toISOString()
  return {
    id: `trg-gh-${actor}-${String(Math.random()).slice(2, 8)}`,
    source: 'github',
    threads: [{ source: 'github', id: 'github:owner/repo#issue/1' }],
    actor: { source: 'github', id: actor },
    human: true,
    addressed: 'mention',
    at,
    text,
    meta: { repository, title: '改 README 的错别字' },
    channel: { source: 'github', thread: '1001', address: {} },
  }
}

/** 一次假执行器的派工记录。 */
interface StartCall { ticketId: string; assignmentId: string }

/**
 * 装一套运行期：默认设置里带上 GitHub 来源与名单，来源范围也认这个仓库。
 *
 * @param work - 拿到 runtime 与 store 之后做什么
 */
function withRuntime(work: (context: {
  runtime: RuntimeInstance
  store: DscStore
  calls: { start: StartCall[] }
}) => void): void {
  const previous = process.env['DSC_HOME']
  const root = mkdtempSync(join(tmpdir(), 'superagent-chain-run-'))
  process.env['DSC_HOME'] = root
  const store = openStore()
  const calls: { start: StartCall[] } = { start: [] }
  const runtime = new SuperagentRuntime(store, {
    log: () => {},
    worker: { repo: () => join(root, 'repo') },
    settings: () => defaultSettings(ACCOUNT),
    scope: superagentScope(() => ACCOUNT),
    executor: {
      start(ticket, assignment) { calls.start.push({ ticketId: ticket.id, assignmentId: assignment.id }) },
      deliver() {},
      stop() {},
    },
  })
  try {
    work({ runtime, store, calls })
  } finally {
    runtime.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
    if (previous === undefined) delete process.env['DSC_HOME']
    else process.env['DSC_HOME'] = previous
  }
}

test('全链路：名单里的人 @ 机器人 → 准入通过 → 泵一拍建出工单', () => {
  withRuntime(({ runtime, calls }) => {
    const received = runtime.sourceBridge().receive(githubTrigger())
    expect(received, 'Trigger 应当入库，而不是被过滤掉').toBe('stored')

    runtime.pump()

    const tickets = runtime.list()
    expect(tickets.length, '泵的一拍里判定器应当接单').toBe(1)
    expect(tickets[0].title, '标题取自 meta.title').toBe('改 README 的错别字')
    expect(calls.start.length, '建单之后立刻派工给执行器').toBe(1)
    expect(calls.start[0].ticketId).toBe(tickets[0].id)
  })
})

test('全链路：名单外的人 @ 机器人 → 不建单，且不是「悄悄失败」', () => {
  withRuntime(({ runtime, calls }) => {
    runtime.sourceBridge().receive(githubTrigger({ actor: 'mallory' }))
    runtime.pump()
    expect(runtime.list(), '名单外的人不该建出工单').toStrictEqual([])
    expect(calls.start.length).toBe(0)
  })
})

test('全链路：同一条 Trigger 收到两次只建一张单', () => {
  withRuntime(({ runtime }) => {
    const trigger = githubTrigger()
    runtime.sourceBridge().receive(trigger)
    runtime.pump()
    const again = runtime.sourceBridge().receive(trigger)
    runtime.pump()
    expect(again, '重复投递应当被判重复').toBe('duplicate')
    expect(runtime.list().length, '去重键就是 Trigger.id，这个不能被适配层改').toBe(1)
  })
})
