/**
 * CDP 动作层（`packages/cdp/actions.ts`）：ref 复核、点击/输入/按键、下拉、滚动、求值、
 * 上传、截图、页面状态与标签页路由。
 *
 * 对端是记账用的假 `CdpCommandTarget`：每条动作只钉「发了哪些 CDP 命令、参数对不对、
 * 页面给的回包怎么翻译成结果或人话」。真浏览器归集成层。
 *
 * @module dsc/packages/cdp/tests/actions.spec
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  attachToTarget,
  captureScreenshot,
  clickRef,
  closeTarget,
  createTarget,
  evaluateInPage,
  fillForm,
  handleDialog,
  hoverRef,
  listTargets,
  mainFrameId,
  pressKey,
  readDocumentState,
  scrollPage,
  selectRef,
  setDownloadBehavior,
  typeIntoRef,
  uploadFiles,
  verifyRef,
  waitForClickPoint,
  waitForCondition,
  waitForPageLoad,
  type CdpSender,
} from '../actions.js'
import type { CdpCommandTarget } from '../transport.js'
import type { AxNode, SnapshotRef } from '../snapshot.js'

type Handler = (params: Record<string, unknown>) => unknown

/** 记账用的假 session：没配的方法回空对象。 */
class FakeTarget implements CdpCommandTarget {
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  handlers = new Map<string, Handler>()
  constructor(overrides: Record<string, Handler> = {}) {
    this.handlers = new Map(Object.entries({ ...DEFAULTS, ...overrides }))
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params })
    const handler = this.handlers.get(method)
    if (handler === undefined) return Promise.resolve({} as T)
    try {
      return Promise.resolve(handler(params) as T)
    } catch (error) {
      return Promise.reject(error)
    }
  }
  methods(): string[] {
    return this.calls.map((call) => call.method)
  }
  sent(method: string): Array<Record<string, unknown>> {
    return this.calls.filter((call) => call.method === method).map((call) => call.params)
  }
}

const REF: SnapshotRef = { ref: 'e5', backendNodeId: 42, role: 'button', name: '删除', generation: 3 }

/** 一个「元素还在、可点、可见」的默认后端。 */
const DEFAULTS: Record<string, Handler> = {
  'DOM.describeNode': (params) => {
    if (params['backendNodeId'] !== 42) throw new Error('不存在这个节点')
    return { node: { backendNodeId: 42 } }
  },
  'Accessibility.getPartialAXTree': () => ({
    nodes: [{ backendNodeId: 42, role: { value: 'button' }, name: { value: '删除' } }],
  }),
  'DOM.getBoxModel': () => ({ model: { content: [10, 20, 110, 20, 110, 70, 10, 70] } }),
  'Page.getLayoutMetrics': () => ({ cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }),
  'DOM.scrollIntoViewIfNeeded': () => ({}),
  'DOM.focus': () => ({}),
  'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
  'Runtime.callFunctionOn': () => ({ result: { value: ['A'] } }),
  'Runtime.evaluate': () => ({ result: { value: true } }),
  'Page.captureScreenshot': () => ({ data: 'iVBOR' }),
  'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'F1' } } }),
  'Target.getTargets': () => ({ targetInfos: [{ targetId: 't1' }, { targetId: 't2' }] }),
  'Target.attachToTarget': () => ({ sessionId: 'S1' }),
  'Target.createTarget': () => ({ targetId: 't9' }),
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-cdp-actions-'))
  dirs.push(dir)
  return dir
}

describe('ref 复核', () => {
  test('节点还在、role/name 没变才放行；改过名、换过角色、查不到都报「页面已变」', async () => {
    await expect(verifyRef(new FakeTarget(), REF)).resolves.toBeUndefined()

    const renamed = new FakeTarget({
      'Accessibility.getPartialAXTree': () => ({
        nodes: [{ backendNodeId: 42, role: { value: 'button' }, name: { value: '清空' } }],
      }),
    })
    await expect(verifyRef(renamed, REF)).rejects.toThrow(/页面已变.*重新 snapshot/)

    const roleChanged = new FakeTarget({
      'Accessibility.getPartialAXTree': () => ({
        nodes: [{ backendNodeId: 42, role: { value: 'link' }, name: { value: '删除' } }],
      }),
    })
    await expect(verifyRef(roleChanged, REF)).rejects.toThrow(/页面已变/)

    const gone = new FakeTarget({
      'DOM.describeNode': () => {
        throw new Error('节点没了')
      },
    })
    await expect(verifyRef(gone, REF)).rejects.toThrow(/页面已变/)
  })
})

describe('点击与悬停', () => {
  test('waitForClickPoint 取框中心；零面积/取不到框都等到超时并说清最后的问题', async () => {
    const target = new FakeTarget()
    await expect(waitForClickPoint(target, REF, 1_000)).resolves.toEqual({ x: 60, y: 45 })
    expect(target.sent('Page.getLayoutMetrics')).toHaveLength(1)

    const zero = new FakeTarget({ 'DOM.getBoxModel': () => ({ model: { content: [0, 0, 0, 0, 0, 0, 0, 0] } }) })
    await expect(waitForClickPoint(zero, REF, 120)).rejects.toThrow(/面积是零/)

    const broken = new FakeTarget({
      'DOM.getBoxModel': () => {
        throw new Error('还没渲染')
      },
    })
    await expect(waitForClickPoint(broken, REF, 120)).rejects.toThrow(/还没渲染/)
  })

  test('clickRef：复核 + 禁用检查 + moved/pressed/released；双击两轮，右键用掩码 2', async () => {
    const target = new FakeTarget()
    const single = await clickRef(target, REF)
    expect(single).toEqual({ x: 60, y: 45, clicks: 1, button: 'left' })
    const events = target.sent('Input.dispatchMouseEvent')
    expect(events.map((event) => event['type'])).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(events[1]).toMatchObject({ buttons: 1, clickCount: 1, x: 60, y: 45 })

    const double = await clickRef(new FakeTarget(), REF, { double: true, button: 'right' })
    expect(double.clicks).toBe(2)
    expect(double.button).toBe('right')
    const dbl = new FakeTarget()
    await clickRef(dbl, REF, { double: true, button: 'right' })
    const rounds = dbl.sent('Input.dispatchMouseEvent').filter((event) => event['type'] === 'mousePressed')
    expect(rounds.map((event) => event['clickCount'])).toEqual([1, 2])
    expect(rounds[0]).toMatchObject({ button: 'right', buttons: 2 })
  })

  test('元素禁用：不点、不填，错误里说清先解决前置条件', async () => {
    const disabled = (): { nodes: AxNode[] } => ({
      nodes: [
        {
          backendNodeId: 42,
          role: { value: 'button' },
          name: { value: '删除' },
          properties: [{ name: 'disabled', value: { value: true } }],
        },
      ],
    })
    const target = new FakeTarget({ 'Accessibility.getPartialAXTree': disabled })
    await expect(clickRef(target, REF)).rejects.toThrow(/禁用状态/)
    expect(target.sent('Input.dispatchMouseEvent')).toHaveLength(0)
    await expect(typeIntoRef(target, REF, 'x')).rejects.toThrow(/禁用状态/)
  })

  test('hoverRef 只发 mouseMoved', async () => {
    const target = new FakeTarget()
    await expect(hoverRef(target, REF)).resolves.toEqual({ x: 60, y: 45 })
    expect(target.sent('Input.dispatchMouseEvent').map((event) => event['type'])).toEqual(['mouseMoved'])
  })
})

describe('输入与按键', () => {
  test('typeIntoRef：聚焦 → 全选删（clear）→ insertText → 回车（submit）', async () => {
    const target = new FakeTarget()
    const result = await typeIntoRef(target, REF, '你好', { clear: true, submit: true })
    expect(result).toEqual({ chars: 2, cleared: true, submitted: true })
    expect(target.methods().filter((method) => method === 'DOM.focus')).toHaveLength(1)
    expect(target.sent('Input.insertText')).toEqual([{ text: '你好' }])
    const keys = target.sent('Input.dispatchKeyEvent')
    expect(keys.some((event) => event['type'] === 'rawKeyDown' && event['modifiers'] === 2)).toBe(true)
    expect(keys.some((event) => event['key'] === 'Enter')).toBe(true)

    const plain = new FakeTarget()
    expect(await typeIntoRef(plain, REF, '')).toEqual({ chars: 0, cleared: false, submitted: false })
    expect(plain.sent('Input.insertText')).toHaveLength(0)
  })

  test('pressKey：可先聚焦；带修饰键走 rawKeyDown，普通字符走 keyDown 并带 text', async () => {
    const target = new FakeTarget()
    await pressKey(target, 'Enter', REF)
    expect(target.sent('DOM.focus')).toEqual([{ backendNodeId: 42 }])
    const enter = target.sent('Input.dispatchKeyEvent')
    expect(enter.map((event) => event['type'])).toEqual(['keyDown', 'keyUp'])
    expect(enter[0]).toMatchObject({ windowsVirtualKeyCode: 13, key: 'Enter' })

    const ctrl = new FakeTarget()
    const stroke = await pressKey(ctrl, 'ctrl+a')
    expect(stroke).toMatchObject({ key: 'a', modifiers: 2 })
    expect(ctrl.sent('Input.dispatchKeyEvent')[0]).toMatchObject({ type: 'rawKeyDown', code: 'KeyA' })
  })
})

describe('下拉与滚动', () => {
  test('selectRef：返回选中项；不是 select / 页面异常 / 一个没匹配：各有错误', async () => {
    const ok = new FakeTarget()
    await expect(selectRef(ok, REF, ['A'])).resolves.toEqual({ selected: ['A'] })
    expect(ok.sent('DOM.resolveNode')).toEqual([{ backendNodeId: 42 }])

    const notSelect = new FakeTarget({ 'Runtime.callFunctionOn': () => ({ result: { value: null } }) })
    await expect(selectRef(notSelect, REF, ['A'])).rejects.toThrow(/不是 <select>/)

    const threw = new FakeTarget({
      'Runtime.callFunctionOn': () => ({ exceptionDetails: { text: '页面炸了' } }),
    })
    await expect(selectRef(threw, REF, ['A'])).rejects.toThrow(/页面报错：页面炸了/)

    const none = new FakeTarget({ 'Runtime.callFunctionOn': () => ({ result: { value: [] } }) })
    await expect(selectRef(none, REF, ['x'])).rejects.toThrow(/一个都没匹配上/)

    const noHandle = new FakeTarget({ 'DOM.resolveNode': () => ({ object: {} }) })
    await expect(selectRef(noHandle, REF, ['A'])).rejects.toThrow(/拿不到页面里的对象句柄/)
  })

  test('scrollPage：down 用视口中心；top/bottom 直接 scrollTo；带 ref 先取框中心', async () => {
    const down = new FakeTarget()
    await expect(scrollPage(down, { direction: 'down' })).resolves.toEqual({ x: 400, y: 300, deltaX: 0, deltaY: 500 })
    expect(down.sent('Input.dispatchMouseEvent')).toEqual([
      { type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 500 },
    ])

    const top = new FakeTarget()
    await scrollPage(top, { direction: 'top' })
    expect(String(top.sent('Runtime.evaluate')[0]!['expression'])).toContain('window.scrollTo(0, 0)')

    const bottom = new FakeTarget()
    await scrollPage(bottom, { direction: 'bottom' })
    expect(String(bottom.sent('Runtime.evaluate')[0]!['expression'])).toContain('scrollHeight')

    const withRef = new FakeTarget()
    await scrollPage(withRef, { direction: 'up', ref: REF, deltaY: 120 })
    expect(withRef.sent('Input.dispatchMouseEvent')[0]).toMatchObject({ x: 60, y: 45, deltaY: -120 })
  })
})

describe('填表、求值与上传', () => {
  test('fillForm 先复核全部 ref 再动手；默认 clear；返回填了哪些', async () => {
    const target = new FakeTarget()
    const second: SnapshotRef = { ...REF, ref: 'e6', backendNodeId: 43, role: 'textbox', name: '名字' }
    // 第二个 ref 也要能复核通过：让后端按节点号返回对应名字。
    target.handlers.set('DOM.describeNode', (params) => ({ node: { backendNodeId: params['backendNodeId'] } }))
    target.handlers.set('Accessibility.getPartialAXTree', (params) => ({
      nodes: [
        {
          backendNodeId: params['backendNodeId'],
          role: { value: 'textbox' },
          name: { value: params['backendNodeId'] === 43 ? '名字' : '删除' },
        },
      ],
    }))
    const ok = await fillForm(target, [
      { ref: { ...REF, role: 'textbox' }, value: 'A' },
      { ref: second, value: 'B' },
    ])
    expect(ok).toEqual({ filled: 2, fields: ['e5', 'e6'] })
    expect(target.sent('Input.insertText')).toEqual([{ text: 'A' }, { text: 'B' }])
  })

  test('evaluateInPage：字符串原样、对象 JSON、异常取首行、超长截断、对象描述兜底', async () => {
    expect(await evaluateInPage(new FakeTarget({ 'Runtime.evaluate': () => ({ result: { value: 'hi' } }) }), 'x')).toEqual({
      text: 'hi',
      truncated: false,
    })
    expect(
      await evaluateInPage(new FakeTarget({ 'Runtime.evaluate': () => ({ result: { value: { a: 1 } } }) }), 'x'),
    ).toEqual({ text: '{"a":1}', truncated: false })

    const threw = new FakeTarget({
      'Runtime.evaluate': () => ({ exceptionDetails: { exception: { description: 'TypeError: x\n    at y' } } }),
    })
    await expect(evaluateInPage(threw, 'x')).rejects.toThrow(/页面 JS 抛异常：TypeError: x$/)

    const long = await evaluateInPage(
      new FakeTarget({ 'Runtime.evaluate': () => ({ result: { value: 'x'.repeat(2_500) } }) }),
      'x',
    )
    expect(long.truncated).toBe(true)
    expect(long.text).toContain('已截断到 2000 字')

    expect(
      await evaluateInPage(
        new FakeTarget({ 'Runtime.evaluate': () => ({ result: { type: 'object', description: 'Object' } }) }),
        'x',
      ),
    ).toEqual({ text: 'Object', truncated: false })
  })

  test('uploadFiles：空清单/文件不存在/读禁文件都拒；正常时把绝对路径交给 DOM', async () => {
    const dir = workdir()
    writeFileSync(join(dir, 'ok.txt'), 'x', 'utf8')
    writeFileSync(join(dir, '.env'), 'SECRET=1', 'utf8')

    await expect(uploadFiles(new FakeTarget(), REF, [], dir)).rejects.toThrow(/没有给要上传的文件路径/)
    await expect(uploadFiles(new FakeTarget(), REF, ['missing.txt'], dir)).rejects.toThrow(/文件不存在/)
    await expect(uploadFiles(new FakeTarget(), REF, ['.env'], dir)).rejects.toThrow(/不能上传这个文件/)

    const target = new FakeTarget()
    const ok = await uploadFiles(target, REF, ['ok.txt'], dir)
    expect(ok.files).toEqual([join(dir, 'ok.txt')])
    expect(target.sent('DOM.setFileInputFiles')).toEqual([{ files: [join(dir, 'ok.txt')], backendNodeId: 42 }])
  })
})

describe('对话框、截图与页面状态', () => {
  test('handleDialog：accept 与 promptText 原样交给浏览器', async () => {
    const target = new FakeTarget()
    await handleDialog(target, { accept: false })
    await handleDialog(target, { accept: true, promptText: '好' })
    expect(target.sent('Page.handleJavaScriptDialog')).toEqual([
      { accept: false },
      { accept: true, promptText: '好' },
    ])
  })

  test('captureScreenshot：拿不到数据就报错；fullPage 带 captureBeyondViewport', async () => {
    expect(await captureScreenshot(new FakeTarget(), false)).toEqual({ base64: 'iVBOR', fullPage: false })
    const full = new FakeTarget()
    await captureScreenshot(full, true)
    expect(full.sent('Page.captureScreenshot')[0]).toEqual({ format: 'png', captureBeyondViewport: true })

    await expect(captureScreenshot(new FakeTarget({ 'Page.captureScreenshot': () => ({}) }), false)).rejects.toThrow(
      /没返回图像数据/,
    )
  })

  test('readDocumentState / waitForPageLoad / waitForCondition', async () => {
    const state = new FakeTarget({
      'Runtime.evaluate': () => ({ result: { value: { url: 'https://e', title: 'T', readyState: 'complete' } } }),
    })
    expect(await readDocumentState(state)).toEqual({ url: 'https://e', title: 'T', readyState: 'complete' })

    const missing = new FakeTarget({ 'Runtime.evaluate': () => ({ result: { value: {} } }) })
    expect(await readDocumentState(missing)).toEqual({ url: '', title: '', readyState: 'unknown' })

    let reads = 0
    const loading = new FakeTarget({
      'Runtime.evaluate': () => {
        reads += 1
        return { result: { value: { url: 'u', title: 't', readyState: reads === 1 ? 'loading' : 'interactive' } } }
      },
    })
    expect(await waitForPageLoad(loading, 2_000)).toMatchObject({ readyState: 'interactive' })

    const never = new FakeTarget({
      'Runtime.evaluate': () => ({ result: { value: { readyState: 'loading' } } }),
    })
    expect(await waitForPageLoad(never, 100)).toMatchObject({ readyState: 'loading' })

    const hit = new FakeTarget({ 'Runtime.evaluate': () => ({ result: { value: true } }) })
    expect(await waitForCondition(hit, { text: '好' }, 200)).toMatchObject({ matched: true })
    expect(String(hit.sent('Runtime.evaluate')[0]!['expression'])).toContain('innerText.includes("好")')

    const selector = new FakeTarget({ 'Runtime.evaluate': () => ({ result: { value: true } }) })
    await waitForCondition(selector, { selector: '#x' }, 200)
    expect(String(selector.sent('Runtime.evaluate')[0]!['expression'])).toContain('querySelector("#x")')

    const miss = new FakeTarget({ 'Runtime.evaluate': () => ({ result: { value: false } }) })
    expect(await waitForCondition(miss, { text: 'no' }, 120)).toMatchObject({ matched: false })
  })
})

describe('标签页与下载', () => {
  test('setDownloadBehavior 带上 downloads 目录；目标列表/附加/新建/关闭/激活/主 frame', async () => {
    const sender: CdpSender = { send: async () => ({}) as never }
    const calls: Array<{ method: string; params: unknown }> = []
    const recording: CdpSender = {
      send: async <T,>(method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params })
        return {} as T
      },
    }
    await setDownloadBehavior(recording, 'C:\\dl')
    expect(calls[0]).toEqual({
      method: 'Browser.setDownloadBehavior',
      params: { behavior: 'allow', downloadPath: 'C:\\dl', eventsEnabled: false },
    })
    expect(typeof sender.send).toBe('function')

    const browser = new FakeTarget()
    await expect(listTargets(browser as never)).resolves.toEqual([{ targetId: 't1' }, { targetId: 't2' }])
    await expect(attachToTarget(browser as never, 't1')).resolves.toBe('S1')
    await expect(createTarget(browser as never, 'https://e')).resolves.toBe('t9')
    await closeTarget(browser as never, 't1')
    await expect(mainFrameId(browser)).resolves.toBe('F1')
    expect(browser.sent('Target.closeTarget')).toEqual([{ targetId: 't1' }])

    const broken = new FakeTarget({
      'Target.attachToTarget': () => ({}),
      'Target.createTarget': () => ({}),
    })
    await expect(attachToTarget(broken as never, 't1')).rejects.toThrow(/没给 sessionId/)
    await expect(createTarget(broken as never, 'u')).rejects.toThrow(/没给 targetId/)
  })
})
