/**
 * 启动图帧（`event: plugins`）的组装与扇出。
 *
 * 为什么单独钉：本地壳与手机壳现在共用 `core/ui-graph-frames.ts`，这里钉住两件会被
 * 「顺手改一改」弄坏的事——
 *   1. `removed` 是「上一帧有、这一帧没有」的 id 差，且没有上一帧时必须是空数组（首帧）；
 *   2. 扇出里一个订阅者抛错不能拖垮别人（通道写失败是常事，不能连带别的页面收不到帧）。
 *
 * 跑法：cd D:\dsc && pnpm run build && node scripts/ui-graph-frames-test.mjs
 *
 * @module dsc/scripts/ui-graph-frames-test
 */
import { readFileSync } from 'node:fs'
import { createUiGraphFrames, graphFrameOf } from '../lib/core/ui-graph-frames.js'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS ${name}`)
    return
  }
  fail += 1
  console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** 造一张最小可用的图：只关心 id 与 rev，别的字段照契约补齐。 */
function graphOf(rev, ids) {
  return {
    rev,
    entries: ids.map((id) => ({ id, rev: `${id}-rev` })),
    batches: [{ phase: 'application', state: 'done' }],
    host: { name: 'Pneuma', version: '0.0.0' },
  }
}

console.log('[1] 帧的组装：removed 由前后两帧的 id 差算')
{
  const first = graphFrameOf(graphOf('r1', ['a', 'b', 'c']), null)
  check('首帧没有上一帧时 removed 是空数组', Array.isArray(first.removed) && first.removed.length === 0, JSON.stringify(first.removed))
  check('rev 取图自己的 rev', first.rev === 'r1', first.rev)
  check('changed 留空（页面按 graph 核对，不靠它）', first.changed.length === 0, JSON.stringify(first.changed))
  check('graph 原样带过去（同一个对象，不拷贝）', first.graph.rev === 'r1' && first.graph.entries.length === 3)

  const second = graphFrameOf(graphOf('r2', ['a', 'c']), first)
  check('少了一条 → removed 里就是它', JSON.stringify(second.removed) === JSON.stringify(['b']), JSON.stringify(second.removed))
  check('仍在的那几条不算 removed', !second.removed.includes('a') && !second.removed.includes('c'), JSON.stringify(second.removed))

  const same = graphFrameOf(graphOf('r2', ['a', 'c']), second)
  check('同一张图再包一次 → removed 空（不编一条假变更）', same.removed.length === 0, JSON.stringify(same.removed))

  const grown = graphFrameOf(graphOf('r3', ['a', 'c', 'd']), second)
  check('多了条目不进 removed（那是页面自己加的，帧里只说少了谁）', grown.removed.length === 0, JSON.stringify(grown.removed))
}

console.log('[2] 通道：当前值、订阅、退订、一个订阅者抛错不拖垮别人')
{
  const frames = createUiGraphFrames()
  check('刚开始没有当前帧', frames.current === null)
  const seen = []
  const off = frames.listen((frame) => seen.push(frame.rev))
  const throwing = frames.listen(() => {
    throw new Error('这个订阅者炸了')
  })
  const after = []
  const offLater = frames.listen((frame) => after.push(frame.rev))
  const one = graphFrameOf(graphOf('r1', ['a']), null)
  frames.push(one)
  check('push 之后 current 是这一帧', frames.current === one)
  check('订阅者收到了（抛错的那个排在前也不影响）', seen.length === 1 && after.length === 1, `${String(seen.length)} / ${String(after.length)}`)
  frames.push(graphFrameOf(graphOf('r2', []), one))
  check('再推一帧，订阅者再收一次', seen.length === 2 && seen[1] === 'r2', JSON.stringify(seen))
  off()
  throwing()
  offLater()
  frames.push(graphFrameOf(graphOf('r3', []), frames.current))
  check('退订之后不再收到', seen.length === 2 && after.length === 2, `${String(seen.length)} / ${String(after.length)}`)
  check('退订不影响 current 前进', frames.current?.rev === 'r3', String(frames.current?.rev))
}


console.log('[3] 手机壳（remote）接上了这一路（宿主侧接线，文本钉）')
{
  const source = readFileSync(new URL('../src/packages/remote/index.ts', import.meta.url), 'utf8')
  check('remote 给数据通道传了 plugins 源', source.includes('plugins: {') && source.includes('graphFrames.listen(listener)'))
  check(
    '翻开关与盘上变化两条事件都订了',
    source.includes("'dsc/ui-plugins-changed'") && source.includes("'dsc/ui-graph-dirty'"),
  )
  check('initial 那一帧会记下当基准（不然 removed 永远空）', source.includes('graphFrames.remember(frame)'))
  check('退订挂在 ctx.effect 上（卸载不留监听）', source.includes('remote: 退订启动图帧'))
}

console.log('')
console.log(fail === 0 ? `启动图帧电池：${String(pass)} 条全过` : `启动图帧电池：${String(pass)} 通过 / ${String(fail)} 失败`)
process.exit(fail === 0 ? 0 : 1)
