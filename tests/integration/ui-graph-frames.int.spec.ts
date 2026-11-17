/**
 * 启动图帧（`event: plugins`）的组装与扇出（迁自 `scripts/ui-graph-frames-test.mjs`）。
 *
 * ## 被测的是什么
 *
 * 本地壳与手机壳共用 `core/ui-graph-frames.ts`，这里钉住两件会被「顺手改一改」弄坏的事：
 *
 * 1. `graphFrameOf`：`removed` 是「上一帧有、这一帧没有」的 id 差；没有上一帧时必须是
 *    空数组（首帧）；rev 取图自己的 rev；changed 留空（页面按 graph 核对，不靠它）；
 *    graph 原样带过去（同一个对象，不拷贝）；同一张图再包一次 removed 空；多了条目不进
 *    removed（那是页面自己加的，帧里只说少了谁）。
 * 2. `createUiGraphFrames`：当前值初始为 null；push 后 current 即这一帧；订阅者按序收到；
 *    **一个订阅者抛错不能拖垮别人**（通道写失败是常事，不能连带别的页面收不到帧）；
 *    退订后不再收到、退订不影响 current 前进。
 * 3. **手机壳（remote）接上了这一路**（宿主侧接线）：这一段是接线钉——被测对象是
 *    `src/packages/remote/index.ts` 的 `apply`，它的行为面是「起真宿主 + 起手机服务 + 看
 *    SSE」，那是 e2e 档的活（批 9 才建 e2e project）。在没有行为接缝可走查的前提下，
 *    这四条退而钉**接线事实**（plugins 源接了 `graphFrames.listen`、两条变更事件都订了、
 *    initial 帧记得当基准、退订挂在 ctx.effect 上）。它们不是「文件里有没有这句文本」的
 *    松断言——丢掉任何一条，对应的行为（补帧基准、卸载不留监听）就没了唯一的守夜人。
 *
 * @module dsc/tests/integration/ui-graph-frames
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { createUiGraphFrames, graphFrameOf } from '@pneuma/runtime/core/ui-graph-frames.js'
import type { UiBootGraph } from '@pneuma/runtime/core/ui-manifest.js'

/** 仓库根（本文件在 tests/integration/ 下）。 */
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** 造一张最小可用的图：只关心 id 与 rev，别的字段照契约补齐。 */
function graphOf(rev: string, ids: string[]): UiBootGraph {
  return {
    rev,
    entries: ids.map((id) => ({ id, rev: `${id}-rev`, url: `plugins/${id}/client.js?rev=${id}-rev` })),
    batches: [{ phase: 'application', entries: [...ids] }],
    host: { name: 'Pneuma', version: '0.0.0' },
  } as unknown as UiBootGraph
}

// ── 1. 帧的组装：removed 由前后两帧的 id 差算 ──────────────────────────────────
describe('帧的组装：removed 由前后两帧的 id 差算', () => {
  const original = graphOf('r1', ['a', 'b', 'c'])
  const first = graphFrameOf(original, null)
  const second = graphFrameOf(graphOf('r2', ['a', 'c']), first)
  const same = graphFrameOf(graphOf('r2', ['a', 'c']), second)
  const grown = graphFrameOf(graphOf('r3', ['a', 'c', 'd']), second)

  test('首帧没有上一帧时 removed 是空数组', () => {
    expect(Array.isArray(first.removed) && first.removed.length === 0, JSON.stringify(first.removed)).toBe(true)
  })
  test('rev 取图自己的 rev', () => {
    expect(first.rev).toBe('r1')
  })
  test('changed 留空（页面按 graph 核对，不靠它）', () => {
    expect(first.changed, JSON.stringify(first.changed)).toEqual([])
  })
  test('graph 原样带过去（同一个对象，不拷贝）', () => {
    expect(first.graph).toBe(original)
    expect(first.graph.entries.length).toBe(3)
  })
  test('少了一条 → removed 里就是它', () => {
    expect(second.removed).toEqual(['b'])
  })
  test('仍在的那几条不算 removed', () => {
    expect(second.removed.includes('a')).toBe(false)
    expect(second.removed.includes('c')).toBe(false)
  })
  test('同一张图再包一次 → removed 空（不编一条假变更）', () => {
    expect(same.removed, JSON.stringify(same.removed)).toEqual([])
  })
  test('多了条目不进 removed（那是页面自己加的，帧里只说少了谁）', () => {
    expect(grown.removed, JSON.stringify(grown.removed)).toEqual([])
  })
})

// ── 2. 通道：当前值、订阅、退订、一个订阅者抛错不拖垮别人 ────────────────────────
describe('通道：当前值、订阅、退订、一个订阅者抛错不拖垮别人', () => {
  test('刚开始没有当前帧', () => {
    expect(createUiGraphFrames().current).toBeNull()
  })

  test('push 之后 current 是这一帧；订阅者收到了（抛错的那个排在前也不影响）', () => {
    const frames = createUiGraphFrames()
    const seen: string[] = []
    const off = frames.listen((frame) => seen.push(frame.rev))
    frames.listen(() => {
      throw new Error('这个订阅者炸了')
    })
    const after: string[] = []
    const offLater = frames.listen((frame) => after.push(frame.rev))
    const one = graphFrameOf(graphOf('r1', ['a']), null)
    frames.push(one)
    expect(frames.current).toBe(one)
    expect(seen.length === 1 && after.length === 1, `${String(seen.length)} / ${String(after.length)}`).toBe(true)
    off()
    offLater()
  })

  test('再推一帧，订阅者再收一次；退订之后不再收到；退订不影响 current 前进', () => {
    const frames = createUiGraphFrames()
    const seen: string[] = []
    const off = frames.listen((frame) => seen.push(frame.rev))
    frames.listen(() => {
      throw new Error('这个订阅者炸了')
    })
    const after: string[] = []
    const offLater = frames.listen((frame) => after.push(frame.rev))
    const one = graphFrameOf(graphOf('r1', ['a']), null)
    frames.push(one)
    frames.push(graphFrameOf(graphOf('r2', []), one))
    expect(seen.length === 2 && seen[1] === 'r2', JSON.stringify(seen)).toBe(true)
    off()
    offLater()
    frames.push(graphFrameOf(graphOf('r3', []), frames.current))
    expect(seen.length === 2 && after.length === 2, `${JSON.stringify(seen)} / ${JSON.stringify(after)}`).toBe(true)
    expect(frames.current?.rev).toBe('r3')
  })
})

// ── 3. 手机壳（remote）接上了这一路（宿主侧接线钉，理由见文件头 §3） ─────────────
describe('手机壳（remote）接上了这一路（宿主侧接线）', () => {
  const source = readFileSync(join(REPO_ROOT, 'src', 'packages', 'remote', 'index.ts'), 'utf8')

  test('remote 给数据通道传了 plugins 源（listen 接到 subscribe）', () => {
    expect(source.includes('plugins: {') && source.includes('graphFrames.listen(listener)')).toBe(true)
  })
  test('翻开关与盘上变化两条事件都订了', () => {
    expect(source.includes("'dsc/ui-plugins-changed'") && source.includes("'dsc/ui-graph-dirty'")).toBe(true)
  })
  test('initial 那一帧会记下当基准（不然 removed 永远空）', () => {
    expect(source.includes('graphFrames.remember(frame)')).toBe(true)
  })
  test('退订挂在 ctx.effect 上（卸载不留监听）', () => {
    expect(source.includes('remote: 退订启动图帧')).toBe(true)
  })
})

