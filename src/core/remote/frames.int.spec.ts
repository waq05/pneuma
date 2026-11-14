/**
 * 帧流：全局 seq、增量 diff、锚帧节奏、环形缓冲与重连补帧（迁自 `scripts/remote-host-test.mjs` 第 8 节）。
 *
 * ## 被测的是什么
 *
 * `RemoteFrameHub` 是纯逻辑（不碰 cordis、不碰网络），diff 规则与锚帧节奏逐格对：
 *   - 第一帧一定是全量（客户端手里没有基准）；全量帧把快照字段照 v2 原样铺平；
 *   - 增量按 `id` 认条目：新出现进 `added`、JSON.stringify 不同进 `updated`、
 *     消失进 `removedIds`；`meta`（除 entries/liveEntries 外的快照字段）与
 *     `liveEntries`（负 id 直播尾）每帧全量带；
 *   - 三种全量锚：连续 50 帧 delta（探针把阈值调成 3 逐格看）、距上一全量 30 秒
 *     （时钟注入逐毫秒推）、会话切换（sessionId 变号）立刻全量；
 *   - 环形缓冲（探针把容量调成 4 看滚动）与重连补帧：窗口内按序补发**原样 JSON 文本**
 *     （重发不重算）；N 是最新一帧补 0 帧；比最老还旧、缺省 0、比最新还新 → 回落全量（null）。
 *
 * ## 断言形状与状态
 *
 * 帧正文是 JSON 文本，解析后按宽松 Record 读（`rec()` / `arr()` 收窄，与 ops-worker
 * 的迁移同款）：源码没有给线上帧的窄类型，收窄点写在这里而不是到处 `as`。
 * 探针是一条顺序脚本：diff 序列用的 `hub` 与环形缓冲用的 `bufHub` 跨用例共享同一实例、
 * 注入钟 `clock` 顺序推进，所以实例在 beforeAll 构造、用例按声明顺序执行（同文件串行）。
 *
 * ## 隔离
 *
 * RemoteFrameHub 全在内存里；这里仍按 integration 层惯例换好临时 HOME 再加载内核侧模块。
 *
 * @module dsc/core/remote/frames.int.spec
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../../tests/harness.js'

/** 临时主目录：必须在任何内核模块被加载之前换好（理由见 prefs.int.spec 文件头）。 */
const home = tempHome('dsc-remote-frames-')

delete process.env['DSC_HOME']

afterAll(() => {
  home.restore()
})

type FramesModule = typeof import('@pneuma/runtime/core/remote/frames.js')
let mod: FramesModule

/** 帧正文解析出来的宽松形状（探针按 JS 直取字段，这里收窄成断言可用的读法）。 */
type FrameDoc = Record<string, unknown>
/** 非 object 一律当空对象（帧不是对象时别让断言直接 TypeError）。 */
const rec = (value: unknown): FrameDoc => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as FrameDoc) : {})
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const parsed = (frame: { text: string }): FrameDoc => rec(JSON.parse(frame.text) as unknown)

type FrameInput = import('@pneuma/runtime/core/remote/frames.js').FrameInput
const entry = (id: number, text: string): { id: number; kind: string; text: string } => ({ id, kind: 'text', text })
/** 探针的快照工厂：FrameInput 三要素 + 附加字段（附加字段原样进 meta 或全量帧顶层）。 */
const snap = (entries: Array<{ id: number; kind: string; text: string }>, patch: Record<string, unknown> = {}): FrameInput & Record<string, unknown> =>
  ({
    sessionId: 's1',
    cwd: 'D:\\dsc',
    status: { turnState: 'idle' },
    surfaces: { pendingApproval: null },
    sessions: [],
    sessionsLoading: false,
    entries,
    liveEntries: [{ id: -1, kind: 'thinking', text: '想' }],
    ...patch,
  }) as FrameInput & Record<string, unknown>

/** 探针的注入钟：锚帧二要逐毫秒往前推，各 hub 共享同一个变量。 */
let clock = 1_000_000
/** diff 序列与环形缓冲的共享实例（beforeAll 构造，理由见文件头「断言形状与状态」）。 */
let hub: InstanceType<FramesModule['RemoteFrameHub']>
let bufHub: InstanceType<FramesModule['RemoteFrameHub']>
let built: import('@pneuma/runtime/core/remote/frames.js').BuiltFrame[]
/** 探针的 diff 序列四帧：第一条全量 → 增加条目 → 改条目 → 删条目（用例之间复用，不重 build）。 */
let firstFrame: import('@pneuma/runtime/core/remote/frames.js').BuiltFrame
let firstDoc: FrameDoc
let addedFrame: import('@pneuma/runtime/core/remote/frames.js').BuiltFrame
let addedDoc: FrameDoc
let updatedDoc: FrameDoc
let removedDoc: FrameDoc

beforeAll(async () => {
  mod = await import('@pneuma/runtime/core/remote/frames.js')
  hub = new mod.RemoteFrameHub({ now: () => clock })
  bufHub = new mod.RemoteFrameHub({ now: () => clock, capacity: 4, anchorFrames: 1000 })
  built = []
  for (let i = 0; i < 6; i += 1) built.push(bufHub.build(snap([entry(1, `第 ${String(i)} 版`)])))
  // 探针的 diff 序列：四次 build 的 seq 必须连续，断言按帧复用（顺序见各用例）。
  firstFrame = hub.build(snap([entry(1, '第一条')]))
  firstDoc = parsed(firstFrame)
  addedFrame = hub.build(snap([entry(1, '第一条'), entry(2, '第二条')]))
  addedDoc = parsed(addedFrame)
  updatedDoc = parsed(hub.build(snap([entry(1, '第一条改了'), entry(2, '第二条')])))
  removedDoc = parsed(hub.build(snap([entry(1, '第一条改了')])))
})

describe('帧流：增量 diff 与锚帧节奏', () => {
  test('第一帧一定是全量（客户端手里没有基准）', () => {
    expect(firstFrame.full).toBe(true)
    expect(firstFrame.seq).toBe(1)
    expect(firstDoc['type']).toBe('snapshot')
    expect(firstDoc['full']).toBe(true)
  })

  test('全量帧把快照字段照 v2 原样铺平（不是塞在 meta 里）', () => {
    expect(firstDoc['sessionId']).toBe('s1')
    expect(firstDoc['cwd']).toBe('D:\\dsc')
    expect(Array.isArray(firstDoc['entries'])).toBe(true)
    expect(arr(firstDoc['entries']).length).toBe(1)
    expect(Array.isArray(firstDoc['liveEntries'])).toBe(true)
  })

  test('新出现的条目进 added（seq 继续递增，type=delta）', () => {
    expect(addedFrame.full).toBe(false)
    expect(addedFrame.seq).toBe(2)
    expect(addedDoc['type']).toBe('delta')
    expect(addedDoc['full']).toBe(false)
    expect(arr(addedDoc['added']).length).toBe(1)
    expect(rec(arr(addedDoc['added'])[0])['id']).toBe(2)
  })

  test('没动的条目既不在 added 也不在 updated；removedIds 是空的', () => {
    expect(arr(addedDoc['updated']).length).toBe(0)
    expect(arr(addedDoc['removedIds']).length).toBe(0)
  })

  test('meta 每帧全量带（除 entries/liveEntries 外的快照字段原样打包）', () => {
    const meta = rec(addedDoc['meta'])
    expect(meta['sessionId']).toBe('s1')
    expect(meta['cwd']).toBe('D:\\dsc')
    expect(rec(meta['status'])['turnState']).toBe('idle')
    expect('surfaces' in meta).toBe(true)
    expect('entries' in meta).toBe(false)
    expect('liveEntries' in meta).toBe(false)
  })

  test('liveEntries（负 id 直播尾）每帧全量带', () => {
    const live = arr(addedDoc['liveEntries'])
    expect(live.length).toBe(1)
    expect(rec(live[0])['id']).toBe(-1)
  })

  test('JSON.stringify 不同的条目进 updated（按 id 认）', () => {
    expect(arr(updatedDoc['added']).length).toBe(0)
    const updatedEntries = arr(updatedDoc['updated'])
    expect(updatedEntries.length).toBe(1)
    expect(rec(updatedEntries[0])['id']).toBe(1)
    expect(rec(updatedEntries[0])['text']).toBe('第一条改了')
  })

  test('消失的条目进 removedIds', () => {
    const removedIds = arr(removedDoc['removedIds'])
    expect(removedIds.length).toBe(1)
    expect(removedIds[0]).toBe(2)
    expect(arr(removedDoc['updated']).length).toBe(0)
  })

  // 锚帧之一：连续 N 帧 delta 之后至少一帧全量
  // 标题里的 50 / 30 / 120 是收集期写死的渲染值（FULL_ANCHOR_FRAMES / FULL_ANCHOR_MS /
  // FRAME_BUFFER_SIZE），断言体仍用常量比对。
  test('连续 50 帧 delta 之后必须再给一帧全量（这里把阈值调成 3 逐格看）', () => {
    const frameHub = new mod.RemoteFrameHub({ now: () => clock, anchorFrames: 3, anchorMs: 10_000_000 })
    const kinds = [
      frameHub.build(snap([entry(1, 'a')])),
      frameHub.build(snap([entry(1, 'b')])),
      frameHub.build(snap([entry(1, 'c')])),
      frameHub.build(snap([entry(1, 'd')])),
      frameHub.build(snap([entry(1, 'e')])),
    ].map((frame) => frame.full)
    expect(JSON.stringify(kinds)).toBe(JSON.stringify([true, false, false, false, true]))
  })

  // 锚帧之二：距上一全量 30 秒
  test('距上一全量不足 30 秒走增量，够 30 秒立刻补全量', () => {
    const timeHub = new mod.RemoteFrameHub({ now: () => clock, anchorFrames: 1000 })
    const timeKinds: boolean[] = []
    timeKinds.push(timeHub.build(snap([entry(1, 'a')])).full)
    clock += mod.FULL_ANCHOR_MS - 1
    timeKinds.push(timeHub.build(snap([entry(1, 'b')])).full)
    clock += 1
    timeKinds.push(timeHub.build(snap([entry(1, 'c')])).full)
    expect(JSON.stringify(timeKinds)).toBe(JSON.stringify([true, false, true]))
  })

  // 锚帧之三：会话切换立刻全量
  test('会话切换（sessionId 变号）立即发全量', () => {
    const sessionHub = new mod.RemoteFrameHub({ now: () => clock })
    sessionHub.build(snap([entry(1, 'a')]))
    expect(sessionHub.build(snap([entry(1, 'a')], { sessionId: 's2' })).full).toBe(true)
  })

  test('环形缓冲只留最近 120 帧（这里容量调成 4 看得到滚动）', () => {
    expect(bufHub.buffered).toBe(4)
    expect(bufHub.oldestSeq).toBe(3)
    expect(bufHub.newestSeq).toBe(6)
  })

  test('N 落在缓冲窗口内：按序补发 N 之后的所有帧，且是原样的 JSON 文本（重发不重算）', () => {
    const resumed = bufHub.resume(3)
    expect(resumed).not.toBeNull()
    expect(resumed?.length).toBe(3)
    expect(resumed?.[0]).toBe(built[3]?.text)
    expect(resumed?.[1]).toBe(built[4]?.text)
    expect(resumed?.[2]).toBe(built[5]?.text)
  })

  test('N 就是最新一帧时补发 0 帧（已经追上了）', () => {
    expect((bufHub.resume(6) ?? null)?.length).toBe(0)
  })

  test('N 比缓冲里最老那帧还旧 → 接不上，回落全量（null）', () => {
    expect(bufHub.resume(2)).toBeNull()
  })

  test('lastSeq 缺省或 0 → 要全量（null）', () => {
    expect(bufHub.resume(0)).toBeNull()
  })

  test('N 比最新一帧还新（宿主重启过）→ 也回落全量，不能一帧不发', () => {
    expect(bufHub.resume(99)).toBeNull()
  })
})
