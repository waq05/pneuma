/**
 * 浏览器推送（Web Push）：VAPID 密钥按需生成与原子落盘、订阅去重入库、失效订阅清理
 * （迁自 `scripts/remote-host-test.mjs` 第 10 节）。
 *
 * ## 被测的是什么
 *
 * `RemotePush`：
 *   - **密钥第一次用到才生成**（不是装上插件就生成）：先断言 keysFile 不存在，调
 *     `publicKey()` 之后文件才落地；公钥是 URL-safe base64（>80 字符），再读一次是同一份
 *     （不重新生成）；push-keys.json 里有 publicKey 与 privateKey；
 *   - **订阅按 endpoint 去重**：第一次 added:true，同一条再来是更新（added:false、total 不变）；
 *     缺 keys.p256dh、缺 endpoint 的订阅被拒；push-subs.json 是数组，每条含
 *     endpoint / keys / deviceId / createdAt（createdAt 来自注入的假钟）；
 *   - **发送**：注入假发送器（不真打推送服务），两台各收一条、payload 是那条消息的 JSON；
 *     发送器抛 statusCode 410（订阅已失效）的订阅**当场从库里删掉**，其余照发；
 *     按 endpoint 退订；库里没有订阅时发送是空操作（attempted 0，不报错）。
 *
 * ## 隔离
 *
 * keys 与订阅都落 tempHome 下的子目录（显式传 dir）。sender 抛错要带 `statusCode` 字段，
 * `Error` 没有这个属性，按探针的意图收窄成 `Error & { statusCode?: number }` 再赋值。
 *
 * @module dsc/core/remote/push.int.spec
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../../tests/harness.js'

/** 临时主目录：必须在任何内核模块被加载之前换好（理由见 prefs.int.spec 文件头）。 */
const home = tempHome('dsc-remote-push-')

delete process.env['DSC_HOME']

afterAll(() => {
  home.restore()
})

type PushModule = typeof import('@pneuma/runtime/core/remote/push.js')
let mod: PushModule

/** JSON 解析结果的宽松读法（源码没给线上文件的窄类型，收窄点在这里）。 */
type JsonDoc = Record<string, unknown>
const rec = (value: unknown): JsonDoc => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonDoc) : {})

beforeAll(async () => {
  mod = await import('@pneuma/runtime/core/remote/push.js')
})

/** 探针的场景状态：实例与发送记录跨用例按序推进（同文件串行）。 */
const dir = join(home.home, 'push-unit')
const keysFile = join(dir, 'push-keys.json')
const subsFile = join(dir, 'push-subs.json')
/** 假发送器收到的每一次发送。 */
const sent: Array<{ endpoint: string; payload: string }> = []
/** 名单里的 endpoint 这次发送抛 410（订阅已不在了）。 */
const failing = new Set<string>()
let push: InstanceType<PushModule['RemotePush']>
/** 第一次生成的 VAPID 公钥（后面「再读一次是同一份」要跟它比）。 */
let publicKey: string | null

beforeAll(() => {
  push = new mod.RemotePush({
    dir,
    now: () => 1_700_000_000_000,
    sender: async (subscription, payload) => {
      if (failing.has(subscription.endpoint)) {
        const error = new Error('订阅已经不在了') as Error & { statusCode?: number }
        error.statusCode = 410
        throw error
      }
      sent.push({ endpoint: subscription.endpoint, payload })
    },
  })
})

const sub1 = { endpoint: 'https://push.example/1', keys: { p256dh: 'p1', auth: 'a1' } }
const sub2 = { endpoint: 'https://push.example/2', keys: { p256dh: 'p2', auth: 'a2' } }

describe('浏览器推送（Web Push）', () => {
  test('第一次用到才生成 VAPID 密钥（不是装上插件就生成）', () => {
    expect(existsSync(keysFile)).toBe(false)
  })

  test('VAPID 密钥生成并原子落盘（公钥是 URL-safe base64）', () => {
    publicKey = push.publicKey()
    expect(publicKey).not.toBeNull()
    expect(publicKey !== null ? publicKey.length : 0).toBeGreaterThan(80)
    expect(publicKey !== null ? /^[A-Za-z0-9_-]+$/.test(publicKey) : false).toBe(true)
    expect(existsSync(keysFile)).toBe(true)
  })

  test('push-keys.json 里有 publicKey 与 privateKey，而且再读一次是同一份（不重新生成）', () => {
    const keyDoc = rec(JSON.parse(readFileSync(keysFile, 'utf8')) as unknown)
    expect(typeof keyDoc['publicKey']).toBe('string')
    expect(typeof keyDoc['privateKey']).toBe('string')
    expect(push.publicKey()).toBe(publicKey)
  })

  test('订阅入库（第一次是 added:true）', () => {
    const first = push.add(sub1, 'dev-1')
    expect(first.ok).toBe(true)
    expect(first.ok === true ? first.added : false).toBe(true)
    expect(push.count()).toBe(1)
  })

  test('同一个 endpoint 再来一次是更新不是新增（去重）', () => {
    const again = push.add(sub1, 'dev-1')
    expect(again.ok).toBe(true)
    expect(again.ok === true ? again.added : false).toBe(false)
    expect(again.ok === true ? again.total : 0).toBe(1)
  })

  test('缺 keys.p256dh 的订阅被拒', () => {
    expect(push.add({ endpoint: 'https://push.example/3' }, 'dev-1').ok).toBe(false)
  })

  test('缺 endpoint 的订阅被拒', () => {
    expect(push.add({ keys: { p256dh: 'p', auth: 'a' } }, 'dev-1').ok).toBe(false)
  })

  test('push-subs.json 是数组，每条含 endpoint / keys / deviceId / createdAt', () => {
    push.add(sub2, 'dev-2')
    const subsDoc = JSON.parse(readFileSync(subsFile, 'utf8')) as unknown[]
    expect(Array.isArray(subsDoc)).toBe(true)
    expect(subsDoc.length).toBe(2)
    const first = rec(subsDoc[0])
    expect(first['endpoint']).toBe('https://push.example/1')
    expect(rec(first['keys'])['auth']).toBe('a1')
    expect(first['deviceId']).toBe('dev-1')
    expect(first['createdAt']).toBe(1_700_000_000_000)
  })

  test('发送走 sendNotification 那条路（这里注入假发送器）：两台各收一条', async () => {
    const okSend = await push.send({ title: 'Pneuma 等待审批', body: 'write', url: 'http://127.0.0.1:17321/' })
    expect(okSend.attempted).toBe(2)
    expect(okSend.sent).toBe(2)
    expect(okSend.dropped).toBe(0)
    expect(sent.length).toBe(2)
    expect(rec(JSON.parse(sent[0]?.payload ?? '{}') as unknown)['title']).toBe('Pneuma 等待审批')
  })

  test('404/410 的订阅当场从库里删掉（其余照发）', async () => {
    failing.add('https://push.example/2')
    const dropped = await push.send({ title: 'x', body: 'y', url: 'z' })
    expect(dropped.dropped).toBe(1)
    expect(dropped.sent).toBe(1)
    expect(push.count()).toBe(1)
    expect(push.subscriptions()[0]?.endpoint).toBe('https://push.example/1')
  })

  test('按 endpoint 退订', () => {
    expect(push.remove('https://push.example/1')).toBe(true)
    expect(push.count()).toBe(0)
    expect(push.remove('不存在的')).toBe(false)
  })

  test('库里没有订阅时发送是空操作（不报错）', async () => {
    const empty = await push.send({ title: 'x' })
    expect(empty.attempted).toBe(0)
  })
})
