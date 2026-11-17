/**
 * `@pneuma/cdp` 的长尾分支：快照序列化、按行截断、ref 复核、报告口径、环缓冲与按键解析。
 *
 * 已有 spec 覆盖 actions 的真实转发与 launch/transport 的状态机；这一份只补「没被走到的
 * 数据结构与错误分支」——角色/名字缺失时的兜底、visited 防环、深度封顶、ref 代际三种
 * 拒绝理由、`safeStringify` 的循环引用、以及每一类敏感原语。全部是纯函数 / 结构类型，
 * 不开浏览器。
 *
 * @module @pneuma/cdp/tests/w11-branches.spec
 */
import { describe, expect, test } from 'vitest'
import { CLOUD_METADATA_HOSTS } from '../cloud-metadata.js'
import { RingBuffer } from '../ring-buffer.js'
import {
  CONSOLE_LINE_MAX,
  consoleLine,
  consoleLineTextOf,
  describeRef,
  networkLine,
  report,
  safeStringify,
} from '../report.js'
import {
  lookupSnapshotRef,
  refRecordMatches,
  serializeAxTree,
  truncateByLines,
  type AxNode,
  type AxTree,
  type SnapshotRef,
} from '../snapshot.js'
import { resolveKey, scanExpression, verifyRef } from '../actions.js'
import type { CdpCommandTarget } from '../transport.js'

const refOf = (over: Partial<SnapshotRef> = {}): SnapshotRef => ({
  ref: 'e1',
  backendNodeId: 5,
  role: 'button',
  name: '提交',
  generation: 1,
  ...over,
})

describe('cloud-metadata：清单本体还在（供两个插件共用）', () => {
  test('云元数据主机包含四大云的实例元数据地址', () => {
    expect(CLOUD_METADATA_HOSTS).toContain('169.254.169.254')
    expect(CLOUD_METADATA_HOSTS.length).toBeGreaterThanOrEqual(5)
  })
})

describe('RingBuffer：容量 0 / resize / find / 拷贝语义', () => {
  test('容量 0 不丢东西；resize 收窄只丢最旧的', () => {
    const buffer = new RingBuffer<number>(0)
    buffer.push(1)
    buffer.push(2)
    expect(buffer.toArray()).toEqual([1, 2])
    buffer.resize(1)
    expect(buffer.toArray()).toEqual([2])
    buffer.resize(0)
    buffer.push(3)
    expect(buffer.toArray()).toEqual([2, 3])
  })

  test('find / toArray 是快照 / clear', () => {
    const buffer = new RingBuffer<{ id: string }>(3)
    buffer.push({ id: 'a' })
    buffer.push({ id: 'b' })
    expect(buffer.find((item) => item.id === 'b')).toEqual({ id: 'b' })
    expect(buffer.find((item) => item.id === 'z')).toBeUndefined()
    const snapshot = buffer.toArray()
    snapshot.push({ id: 'c' })
    expect(buffer.size).toBe(2)
    buffer.clear()
    expect(buffer.size).toBe(0)
  })
})

describe('report：兜底字符串化与逐行口径', () => {
  test('safeStringify：字符串原样、对象 JSON、undefined 走 String、循环引用不抛', () => {
    expect(safeStringify('x')).toBe('x')
    expect(safeStringify({ a: 1 })).toBe('{"a":1}')
    expect(safeStringify(undefined)).toBe('undefined')
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(safeStringify(cyclic)).toBe('[object Object]')
  })

  test('describeRef：有名字带引号，没名字只剩角色', () => {
    expect(describeRef(refOf())).toBe('button "提交"')
    expect(describeRef(refOf({ name: '' }))).toBe('button')
  })

  test('consoleLineTextOf：原始值 / 描述 / 类型三种兜底，非数组给空串，超长截断', () => {
    expect(consoleLineTextOf({ args: [{ value: 'hi' }, { description: 'obj' }, { type: 'number' }] })).toBe('hi obj number')
    expect(consoleLineTextOf({ args: undefined })).toBe('')
    expect(consoleLineTextOf({ args: ['不是对象'] })).toBe('?')
    const long = consoleLineTextOf({ args: [{ value: 'x'.repeat(500) }] })
    expect(long).toHaveLength(CONSOLE_LINE_MAX)
  })

  test('consoleLine 与 networkLine：进行中 / 失败 / 带 mime', () => {
    expect(consoleLine({ ts: 0, level: 'log', text: 'hi' })).toContain('log: hi')
    expect(networkLine({ ts: 0, requestId: 'r', method: 'GET', url: 'https://a/', status: 0, mimeType: '', failed: '' })).toContain('进行中')
    expect(networkLine({ ts: 0, requestId: 'r', method: 'GET', url: 'https://a/', status: 0, mimeType: '', failed: 'net::ERR' })).toContain('失败：net::ERR')
    expect(networkLine({ ts: 0, requestId: 'r', method: 'GET', url: 'https://a/', status: 200, mimeType: 'text/html', failed: '' })).toContain(' text/html')
  })

  test('report：摘要一行 + JSON 一行', () => {
    const text = report('完成', { action: 'x' })
    expect(text.split('\n')).toEqual(['完成', '{"action":"x"}'])
  })
})

describe('snapshot.serializeAxTree：缺失字段、防环、深度封顶', () => {
  test('角色/名字/值不是字符串：给 unknown / 空名 / 字符串化', () => {
    const tree = {
      nodes: [
        { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: '页' }, childIds: ['n1', 'n2', 'n3'] },
        { nodeId: 'n1', parentId: 'root', role: { value: 7 }, name: { value: 9 }, childIds: [] },
        { nodeId: 'n2', parentId: 'root', role: { value: 'textbox' }, value: { value: true }, backendDOMNodeId: 11 },
        { nodeId: 'n3', parentId: 'root', role: { value: 'StaticText' }, name: { value: '正文' }, backendDOMNodeId: 12 },
      ],
    }
    const result = serializeAxTree(tree as unknown as AxTree, { full: true, generation: 2 })
    expect(result.text).toContain('unknown')
    expect(result.text).toContain('true')
    const valueRef = [...result.refs.values()].find((ref) => ref.backendNodeId === 11)
    expect(valueRef?.role).toBe('textbox')
  })

  test('没有 nodeId 的节点照画；childIds 成环不会转死', () => {
    const tree = {
      nodes: [
        { role: { value: 'button' }, name: { value: '无 id' }, backendDOMNodeId: 21 },
        { nodeId: 'a', role: { value: 'RootWebArea' }, childIds: ['a'] },
      ],
    }
    const result = serializeAxTree(tree, { full: false, generation: 1 })
    expect(result.text).toContain('无 id')
    expect(result.refs.size).toBe(1)
  })

  test('可交互但没有 backendDOMNodeId：不建 ref；非 full 下非交互节点也不建 ref', () => {
    const tree = {
      nodes: [
        { nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['b', 't'] },
        { nodeId: 'b', parentId: 'root', role: { value: 'button' }, name: { value: '无后端号' } },
        { nodeId: 't', parentId: 'root', role: { value: 'heading' }, name: { value: '文本' }, backendDOMNodeId: 31 },
      ],
    }
    const compact = serializeAxTree(tree, { full: false, generation: 1 })
    expect(compact.refCount).toBe(0)
    const full = serializeAxTree(tree, { full: true, generation: 1 })
    expect(full.refCount).toBe(1)
  })

  test('嵌套超过 6 层：collectText 停手，不把整页正文吸进来', () => {
    const nodes: AxNode[] = [{ nodeId: 'n0', role: { value: 'heading' }, childIds: ['n1'], name: { value: '外层' } }]
    for (let index = 1; index <= 8; index += 1) {
      nodes.push({
        nodeId: `n${String(index)}`,
        parentId: `n${String(index - 1)}`,
        role: { value: index === 8 ? 'StaticText' : 'generic' },
        childIds: index === 8 ? [] : [`n${String(index + 1)}`],
        name: { value: index === 8 ? '深处文本' : '' },
      })
    }
    const result = serializeAxTree({ nodes }, { full: true, generation: 1 })
    expect(result.text).toContain('外层')
    expect(result.text).not.toContain('深处文本')
  })
})

describe('snapshot.truncateByLines / ref 复核 / 代际', () => {
  test('不超限原样；超限留整行；一行都放不下也留整行', () => {
    const short = truncateByLines('a\nb', 100, () => 'note')
    expect(short).toEqual({ text: 'a\nb', truncated: false, shownLines: 2, totalLines: 2 })

    const cut = truncateByLines('aaaa\nbbbb\ncccc', 10, (remaining) => `剩 ${String(remaining)} 行`)
    expect(cut.truncated).toBe(true)
    expect(cut.text).toContain('剩')
    expect(cut.shownLines).toBeGreaterThanOrEqual(1)

    const huge = truncateByLines('x'.repeat(50), 4, () => 'n')
    expect(huge.truncated).toBe(true)
    expect(huge.shownLines).toBe(1)
    expect(huge.text.startsWith('x'.repeat(50))).toBe(true)
  })

  test('refRecordMatches：节点没了 / 隐藏 / 后端号变了 / 角色变了 / 名字变了', () => {
    const record = refOf()
    expect(refRecordMatches(record, undefined)).toBe(false)
    expect(refRecordMatches(record, { ignored: true })).toBe(false)
    expect(refRecordMatches(record, { backendDOMNodeId: 99, role: { value: 'button' }, name: { value: '提交' } })).toBe(false)
    expect(refRecordMatches(record, { backendDOMNodeId: 5, role: { value: 'link' }, name: { value: '提交' } })).toBe(false)
    expect(refRecordMatches(record, { backendDOMNodeId: 5, role: { value: 'button' }, name: { value: '清空' } })).toBe(false)
    // 角色给不出（unknown）时不比角色，只比名字。
    expect(refRecordMatches(record, { backendDOMNodeId: 5, role: { value: 1 }, name: { value: '提交' } } as unknown as AxNode)).toBe(true)
  })

  test('lookupSnapshotRef：空 ref / 不认识（带不带作废原因）/ 上一代 / 命中', () => {
    expect(lookupSnapshotRef(new Map(), '  ', 1)).toMatchObject({ ok: false })
    const unknown = lookupSnapshotRef(new Map(), 'e9', 1, '页面已经跳转')
    expect(unknown.ok).toBe(false)
    expect(unknown.ok ? '' : unknown.reason).toContain('页面已经跳转')
    expect(lookupSnapshotRef(new Map(), 'e9', 1).ok).toBe(false)
    const refs = new Map([['e1', refOf({ generation: 1 })]])
    expect(lookupSnapshotRef(refs, ' e1 ', 2).ok).toBe(false)
    expect(lookupSnapshotRef(refs, 'e1', 1)).toEqual({ ok: true, ref: refOf() })
  })
})

describe('actions.scanExpression / resolveKey', () => {
  test('敏感原语逐条命中；普通表达式不误报', () => {
    expect(scanExpression('require("fs")').sensitive).toContain('require(')
    expect(scanExpression('process . binding').sensitive).toContain('process.binding')
    expect(scanExpression('child_process').sensitive).toContain('child_process')
    expect(scanExpression('window.electron.ipcRenderer').sensitive).toContain('electron')
    expect(scanExpression('document.title').sensitive).toEqual([])
  })

  test('表达式里的地址：去掉尾部标点，空表达式给空表', () => {
    expect(scanExpression('fetch("https://example.com/a?b=1"),').urls).toEqual(['https://example.com/a?b=1'])
    expect(scanExpression('nothing').urls).toEqual([])
    expect(scanExpression('')).toEqual({ sensitive: [], urls: [] })
  })

  test('resolveKey：空串 / 未知修饰键 / 特殊键带 text / 组合键不给 text', () => {
    expect(() => resolveKey('')).toThrow('按键名是空的')
    expect(() => resolveKey('hyper+a')).toThrow('不认识的修饰键')
    const enter = resolveKey('Enter')
    expect(enter).toMatchObject({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' })
    const ctrlEnter = resolveKey('ctrl+Enter')
    expect(ctrlEnter.text).toBeUndefined()
    expect(ctrlEnter.modifiers).toBe(2)
  })

  test('resolveKey：单字母 / 数字 / 符号 / shift 大写 / 多字符报错', () => {
    expect(resolveKey('a')).toMatchObject({ key: 'a', code: 'KeyA', vk: 65, text: 'a' })
    expect(resolveKey('shift+a')).toMatchObject({ code: 'KeyA', modifiers: 8, text: 'A' })
    expect(resolveKey('5')).toMatchObject({ code: 'Digit5', vk: 53 })
    expect(resolveKey('?')).toMatchObject({ code: '', text: '?' })
    expect(() => resolveKey('Hello')).toThrow('不认识的按键')
  })
})

// ── verifyRef：四条「页面已变」出口 ─────────────────────────────────────────

function pageOf(responses: Record<string, (params: Record<string, unknown>) => unknown>): CdpCommandTarget {
  return {
    send: <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      const responder = responses[method]
      if (responder === undefined) return Promise.reject(new Error(`unexpected: ${method}`))
      try {
        return Promise.resolve(responder(params) as T)
      } catch (error) {
        return Promise.reject(error)
      }
    },
  } as unknown as CdpCommandTarget
}

describe('actions.verifyRef：节点没了 / 号变了 / 无障碍取不到 / 全对', () => {
  test('DOM.describeNode 抛错：报页面已变', async () => {
    const page = pageOf({
      'DOM.describeNode': () => {
        throw new Error('gone')
      },
    })
    await expect(verifyRef(page, refOf())).rejects.toThrow('页面已变')
  })

  test('后端节点号对不上：报页面已变', async () => {
    const page = pageOf({ 'DOM.describeNode': () => ({ node: { backendNodeId: 99 } }) })
    await expect(verifyRef(page, refOf())).rejects.toThrow('页面已变')
  })

  test('无障碍树取不到：报页面已变', async () => {
    const page = pageOf({
      'DOM.describeNode': () => ({ node: { backendNodeId: 5 } }),
      'Accessibility.getPartialAXTree': () => {
        throw new Error('ax')
      },
    })
    await expect(verifyRef(page, refOf())).rejects.toThrow('页面已变')
  })

  test('无障碍节点为空 / 角色变了：报页面已变', async () => {
    const empty = pageOf({
      'DOM.describeNode': () => ({ node: { backendNodeId: 5 } }),
      'Accessibility.getPartialAXTree': () => ({ nodes: [] }),
    })
    await expect(verifyRef(empty, refOf())).rejects.toThrow('页面已变')

    const changed = pageOf({
      'DOM.describeNode': () => ({ node: { backendNodeId: 5 } }),
      'Accessibility.getPartialAXTree': () => ({
        nodes: [{ backendDOMNodeId: 5, role: { value: 'link' }, name: { value: '提交' } }],
      }),
    })
    await expect(verifyRef(changed, refOf())).rejects.toThrow('页面已变')
  })

  test('一切没变：安静通过', async () => {
    const page = pageOf({
      'DOM.describeNode': () => ({ node: { backendNodeId: 5 } }),
      'Accessibility.getPartialAXTree': () => ({
        nodes: [{ backendDOMNodeId: 5, role: { value: 'button' }, name: { value: '提交' } }],
      }),
    })
    await expect(verifyRef(page, refOf())).resolves.toBeUndefined()
  })
})
