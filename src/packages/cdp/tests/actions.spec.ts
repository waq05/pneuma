/**
 * CDP 动作层读应答的层数（迁自 `scripts/dock-browser-test.mjs` 第 9 节①，回归）。
 *
 * ## 为什么这条值得单开
 *
 * `clickRef` / `waitForClickPoint` / `getBoxModel` 在全仓 `.mjs` / `.js` / `.ps1` 里零命中
 * ——动作层以前**从来没有探针喂过真实形状的应答**。CDP 的 `DOM.getBoxModel` 回的是
 * `{model:{content:[…8 个数…]}}`、`DOM.resolveNode` 回的是 `{object:{objectId}}`，
 * 按一层读（`.content` / `.objectId`）永远拿到 undefined，于是 click / hover / scroll
 * 一律安静地等到超时：用户看到的是「点了没反应」。
 *
 * 所以这里用「只认实机那套形状」的桩 page：两层应答时必须算得出点；再配一个**一层应答**的
 * 负向桩（修之前的形状），证明上面那条不是空转——一层也能过的话，这条断言就没有意义。
 *
 * 桩只实现 `send` / `on` / `sessionId`（`CdpCommandTarget` 就是这三样），不连浏览器。
 *
 * @module @pneuma/cdp/tests/actions.spec
 */
import { describe, expect, test } from 'vitest'
import { clickRef, selectRef, verifyRef } from '../actions.js'
import type { SnapshotRef } from '../snapshot.js'
import type { CdpCommandTarget } from '../../../core/dock-browser.js'

/** 被点的那个元素（快照 layer 给的 ref 形状）。 */
const CLICK_REF: SnapshotRef = { ref: 'e1', backendNodeId: 7, role: 'button', name: '点我', generation: 1 }
/** `DOM.getBoxModel` 的 content：四对 (x, y)。 */
const BOX = [8, 75, 192, 75, 192, 129, 8, 129]

/** 桩 page 的对外形状。 */
interface StubPage {
  calls: string[]
  params: Array<Record<string, unknown> | undefined>
  page: CdpCommandTarget
}

/**
 * 造一个只认实机那套 CDP 应答形状的桩 page（方法名逐条记录）。
 *
 * `layered=false` 时按**一层**回（`{content}` / `{objectId}`）——那正是修之前代码读的形状，
 * 拿来当负向对照。
 */
function makeCdpPage(layered: boolean): StubPage {
  const calls: string[] = []
  const params: Array<Record<string, unknown> | undefined> = []
  return {
    calls,
    params,
    page: {
      sessionId: 'agent-7',
      on: () => () => {},
      send: async <T>(method: string, argument?: Record<string, unknown>): Promise<T> => {
        calls.push(method)
        params.push(argument)
        const reply = ((): unknown => {
          switch (method) {
            case 'DOM.describeNode':
              return { node: { backendNodeId: 7 } }
            case 'Accessibility.getPartialAXTree':
              return { nodes: [{ backendDOMNodeId: 7, role: { value: 'button' }, name: { value: '点我' } }] }
            case 'DOM.getBoxModel':
              return layered ? { model: { content: [...BOX] } } : { content: [...BOX] }
            case 'Page.getLayoutMetrics':
              return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } }
            case 'DOM.resolveNode':
              return layered ? { object: { objectId: 'obj-1' } } : { objectId: 'obj-1' }
            case 'Runtime.callFunctionOn':
              return { result: { value: ['甲', '乙'] } }
            default:
              return {}
          }
        })()
        return reply as T
      },
    },
  }
}

/** 跑一次点击并把异常转成文本（成功时返回空串）。 */
async function clickError(layered: boolean, timeoutMs: number): Promise<{ error: string; page: StubPage; clicked: unknown }> {
  const { page, calls, ...rest } = makeCdpPage(layered)
  let clicked: unknown = null
  try {
    clicked = await clickRef(page, CLICK_REF, { timeoutMs })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), page: { calls, params: rest.params, page }, clicked }
  }
  return { error: '', page: { calls, params: rest.params, page }, clicked }
}

describe('① 两层应答（实机形状）：算得出点，不等到超时', () => {
  test('clickRef 返回 (100, 102)、点一次', async () => {
    const { error, clicked } = await clickError(true, 500)
    expect(error).toBe('')
    expect(clicked).toStrictEqual(expect.objectContaining({ x: 100, y: 102, clicks: 1 }))
  })

  test('鼠标事件落在两层里读出来的那个中心点（不是 0,0 / 不退化）', async () => {
    const { page } = await clickError(true, 500)
    const index = page.calls.findIndex(
      (method, at) => method === 'Input.dispatchMouseEvent' && page.params[at]?.['type'] === 'mouseMoved',
    )
    expect(index).toBeGreaterThanOrEqual(0)
    expect(page.params[index]?.['x']).toBe(100)
    expect(page.params[index]?.['y']).toBe(102)
  })

  test('verifyRef 通过（describeNode 的 node 与无障碍节点的 role/name 都读对）', async () => {
    const { page } = makeCdpPage(true)
    await expect(verifyRef(page, CLICK_REF)).resolves.toBeUndefined()
  })

  test('selectRef 先拿 objectId 再发 Runtime.callFunctionOn，且句柄真的递进去了', async () => {
    const { page, calls, params } = makeCdpPage(true)
    const selected = await selectRef(page, CLICK_REF, ['甲'])
    expect(selected.selected).toStrictEqual(['甲', '乙'])
    const resolveAt = calls.indexOf('DOM.resolveNode')
    const callFnAt = calls.lastIndexOf('Runtime.callFunctionOn')
    expect(resolveAt).toBeGreaterThanOrEqual(0)
    expect(callFnAt).toBeGreaterThan(resolveAt)
    expect(params[callFnAt]?.['objectId']).toBe('obj-1')
  })
})

describe('② 负向：桩只回一层（修之前的形状）时必然失败', () => {
  test('clickRef 报「可点击超时」（一层也能过就说明上面那条在空转）', async () => {
    const { error } = await clickError(false, 120)
    expect(error).toContain('可点击超时')
  })

  test('selectRef 报「拿不到页面里的对象句柄」', async () => {
    const { page } = makeCdpPage(false)
    await expect(selectRef(page, CLICK_REF, ['甲'])).rejects.toThrow(/对象句柄/)
  })
})
