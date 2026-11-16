/**
 * 「将做的改动」推演（`intended-diff.ts`）的边界补测（ui 层）。
 *
 * 既有 spec 没有直接钉这一份：工具卡只借它渲染。这里把三段纯函数与 hook 的每条降级路
 * 单独拉出来：
 *
 *  - `parseIntended`：非写类工具、坏 JSON、非对象、缺/空路径，以及 write / edit /
 *    ops_edit_file / ops_replace 各自的参数不齐；
 *  - `toAbsPath`：Windows 盘符、UNC、POSIX 绝对路径、空 cwd、两种分隔符与尾分隔符；
 *  - `diffToView`：内容一致、新建、修改、超 800 行按预算砍尾（含第一段吃满预算后
 *    后续段直接跳过）、超大差异走摘要（`ok=false`）时返回 null；
 *  - `useIntendedDiff`：盘上读得到 / 读不到 / 抛错三条入口，write、edit（命中 / 缺失 /
 *    多处）、ops_edit_file（多处替换、缺失、多处匹配、区间重叠）、ops_replace（有盘上
 *    现值 / 回落参数），以及非 running / disabled / 参数坏掉时不发 `dock fs-read`。
 *
 * @module dsc-ui-transcript/ui/intended-diff-extra.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement, type ReactElement, type ReactNode } from 'react'
import type { ToolCallView } from '@dsc/ui'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import {
  diffToView,
  parseIntended,
  toAbsPath,
  useIntendedDiff,
  type IntendedDiff,
} from './intended-diff.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const noop = (): void => undefined

/** 假宿主通道：只让 invoke 可观察。 */
function channelOf(invoke: (method: string, args: unknown[]) => Promise<unknown>): HostChannel {
  return {
    getSnapshot: () => null,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => noop,
    onAsk: () => noop,
    subscribe: () => noop,
    invoke: invoke as unknown as HostChannel['invoke'],
    reconnect: noop,
    close: noop,
  }
}

/** 一条工具调用。 */
function callOf(name: string, args: unknown, status: ToolCallView['status'] = 'running'): ToolCallView {
  return { callId: 'c1', name, argsText: JSON.stringify(args), status }
}

/** 把 hook 探针包进 RuntimeProvider（`.spec.ts` 里不能写 JSX，统一走 createElement）。 */
function tree(
  channel: HostChannel,
  call: ToolCallView,
  workdir: string,
  enabled: boolean,
  onState: (value: IntendedDiff | null) => void,
): ReactElement {
  return createElement(RuntimeProvider, {
    channel,
    children: createElement(HookProbe, { call, workdir, enabled, onState }),
  })
}

/** 把 hook 的返回值提出来。 */
function HookProbe({
  call,
  workdir,
  enabled,
  onState,
}: {
  call: ToolCallView
  workdir: string
  enabled: boolean
  onState(state: IntendedDiff | null): void
}): ReactNode {
  const state = useIntendedDiff(call, workdir, enabled)
  onState(state)
  return null
}

/** 等 effect 里的那条 invoke 落地并在 act 里完成重渲染。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** 挂一个 hook 探针，返回 invoke 替身与最新状态。 */
async function mountDiff(
  call: ToolCallView,
  workdir: string,
  invokeImpl: (method: string, args: unknown[]) => Promise<unknown>,
  enabled = true,
): Promise<{
  invoke: ReturnType<typeof vi.fn>
  state: () => IntendedDiff | null
  unmount: () => void
}> {
  const invoke = vi.fn(invokeImpl)
  const channel = channelOf((method, args) => invoke(method, args) as Promise<unknown>)
  let state: IntendedDiff | null = null
  const onState = (value: IntendedDiff | null): void => {
    state = value
  }
  const view = render(tree(channel, call, workdir, enabled, onState))
  await flush()
  return { invoke, state: () => state, unmount: () => { view.unmount() } }
}
/** 造 n 行带前缀的文本行。 */
const lines = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}${String(index)}`)

// ── parseIntended：参数形状 ─────────────────────────────────────────────────

describe('parseIntended：认不出来的入参一律 null', () => {
  test('非写类工具、坏 JSON、非对象、缺路径、字段类型不对都拒绝', () => {
    expect(parseIntended('read', JSON.stringify({ path: 'a', content: 'x' }))).toBeNull()
    expect(parseIntended('write', '{bad')).toBeNull()
    expect(parseIntended('write', 'null')).toBeNull()
    expect(parseIntended('write', '[]')).toBeNull()
    expect(parseIntended('write', '"x"')).toBeNull()
    expect(parseIntended('write', JSON.stringify({ content: 'x' }))).toBeNull()
    expect(parseIntended('write', JSON.stringify({ path: '', content: 'x' }))).toBeNull()
    expect(parseIntended('write', JSON.stringify({ path: 7, content: 'x' }))).toBeNull()
    expect(parseIntended('write', JSON.stringify({ path: 'a', content: 7 }))).toBeNull()
    expect(parseIntended('edit', JSON.stringify({ path: 'a', old: 'x' }))).toBeNull()
    expect(parseIntended('edit', JSON.stringify({ path: 'a', new: 'x' }))).toBeNull()
    expect(parseIntended('edit', JSON.stringify({ path: 'a', old: 1, new: 'x' }))).toBeNull()
  })

  test('ops_edit_file：空数组、非数组、非对象条目、空原文都拒绝', () => {
    expect(parseIntended('ops_edit_file', JSON.stringify({ path: 'a' }))).toBeNull()
    expect(parseIntended('ops_edit_file', JSON.stringify({ path: 'a', edits: 'x' }))).toBeNull()
    expect(parseIntended('ops_edit_file', JSON.stringify({ path: 'a', edits: [] }))).toBeNull()
    expect(parseIntended('ops_edit_file', JSON.stringify({ path: 'a', edits: [null] }))).toBeNull()
    expect(parseIntended('ops_edit_file', JSON.stringify({ path: 'a', edits: [{ oldText: 1, newText: 'x' }] }))).toBeNull()
  })

  test('ops_replace：pattern 缺失 / 空串 / replacement 不是字符串都拒绝', () => {
    expect(parseIntended('ops_replace', JSON.stringify({ path: 'a', replacement: 'r' }))).toBeNull()
    expect(parseIntended('ops_replace', JSON.stringify({ path: 'a', pattern: '', replacement: 'r' }))).toBeNull()
    expect(parseIntended('ops_replace', JSON.stringify({ path: 'a', pattern: 'p' }))).toBeNull()
    expect(parseIntended('ops_replace', JSON.stringify({ path: 'a', pattern: 'p', replacement: 1 }))).toBeNull()
  })
})

describe('parseIntended：四种写类工具的正常形状', () => {
  test('write / edit / ops_edit_file / ops_replace 各自归一成 IntendedInput', () => {
    expect(parseIntended('write', JSON.stringify({ path: 'a', content: 'x' }))).toEqual({ path: 'a', content: 'x' })
    expect(parseIntended('ops_write_file', JSON.stringify({ path: 'a', content: 'x' }))).toEqual({
      path: 'a',
      content: 'x',
    })
    expect(parseIntended('edit', JSON.stringify({ path: 'a', old: 'o', new: 'n' }))).toEqual({
      path: 'a',
      content: 'n',
      old: 'o',
    })
    expect(
      parseIntended('ops_edit_file', JSON.stringify({ path: 'a', edits: [{ oldText: 'o', newText: 'n' }] })),
    ).toEqual({ path: 'a', content: '', edits: [{ old: 'o', new: 'n' }] })
    expect(parseIntended('ops_replace', JSON.stringify({ path: 'a', pattern: 'p', replacement: 'r' }))).toEqual({
      path: 'a',
      content: '',
      replace: { pattern: 'p', replacement: 'r' },
    })
  })
})

// ── toAbsPath：路径归一 ─────────────────────────────────────────────────────

describe('toAbsPath：绝对形状直接用，相对路径拼 cwd', () => {
  test('盘符 / UNC / POSIX 绝对路径原样返回', () => {
    expect(toAbsPath('C:\\work\\a.ts', 'D:\\proj')).toBe('C:\\work\\a.ts')
    expect(toAbsPath('C:/work/a.ts', 'D:\\proj')).toBe('C:/work/a.ts')
    expect(toAbsPath('\\\\server\\share\\a.ts', 'D:\\proj')).toBe('\\\\server\\share\\a.ts')
    expect(toAbsPath('/opt/a.ts', 'D:\\proj')).toBe('/opt/a.ts')
  })

  test('相对路径按 cwd 的分隔符拼；空 cwd 与尾分隔符各有口径', () => {
    expect(toAbsPath('src/a.ts', 'D:\\proj')).toBe('D:\\proj\\src/a.ts')
    expect(toAbsPath('src/a.ts', 'D:/proj/')).toBe('D:/proj/src/a.ts')
    expect(toAbsPath('src/a.ts', '')).toBe('src/a.ts')
  })
})

// ── diffToView：差异视图与预算 ───────────────────────────────────────────────

describe('diffToView：一致 / 新建 / 修改', () => {
  test('完全一致返回 null；改前为空是新增，否则是修改', () => {
    expect(diffToView('a.ts', 'same', 'same')).toBeNull()

    const added = diffToView('new.ts', '', 'l1\nl2')
    expect(added?.status).toBe('added')
    expect(added?.added).toBe(2)
    expect(added?.removed).toBe(0)
    expect(added?.hunks.length).toBe(1)
    expect(added?.truncated).toBeUndefined()

    const modified = diffToView('a.ts', 'one\ntwo\nthree', 'one\nTWO\nthree')
    expect(modified?.status).toBe('modified')
    expect(modified?.added).toBe(1)
    expect(modified?.removed).toBe(1)
    expect(modified?.hunks[0]?.lines.some((line) => line.kind === 'remove')).toBe(true)
    expect(modified?.hunks[0]?.lines.some((line) => line.kind === 'add')).toBe(true)
  })
})

describe('diffToView：行数预算与超大差异', () => {
  test('超过 800 行砍尾并标 truncated；第一段吃满预算后后续段直接跳过', () => {
    // 第一段 900 行全改（每行都是删 + 增 = 1800 行），10 行公用，第二段再改 10 行。
    const shared = lines('same', 10)
    const before = [...lines('old', 900), ...shared, ...lines('before', 10)].join('\n')
    const after = [...lines('new', 900), ...shared, ...lines('after', 10)].join('\n')
    const view = diffToView('big.ts', before, after)

    expect(view?.truncated).toBe(true)
    // 第二段没进预算：只剩第一段，且正好砍到 800 行。
    expect(view?.hunks.length).toBe(1)
    expect(view?.hunks[0]?.lines.length).toBe(800)
    // 统计数字仍是整篇的，不受展示预算影响。
    expect(view?.added).toBe(910)
    expect(view?.removed).toBe(910)
  })

  test('差异矩阵超上限走摘要（ok=false）：不产出逐行视图', () => {
    const before = lines('old', 3000).join('\n')
    const after = lines('new', 3000).join('\n')
    expect(diffToView('huge.ts', before, after)).toBeNull()
  })
})

// ── useIntendedDiff：读盘成功 / 回落 / 异常 ─────────────────────────────────

describe('useIntendedDiff：write 的两条入口', () => {
  test('盘上读得到：按真实全文算差异，invoke 用绝对路径', async () => {
    const { invoke, state } = await mountDiff(
      callOf('write', { path: 'src/x.ts', content: 'one\nTWO\nthree' }),
      'D:/proj',
      () => Promise.resolve({ kind: 'text', text: 'one\ntwo\nthree' }),
    )
    expect(invoke).toHaveBeenCalledWith('dock', ['fs-read', { file: 'D:/proj/src/x.ts' }])
    expect(state()?.absPath).toBe('D:/proj/src/x.ts')
    expect(state()?.fellBack).toBe(false)
    expect(state()?.mismatch).toBeUndefined()
    expect(state()?.file?.status).toBe('modified')
    expect(state()?.file?.added).toBe(1)
    expect(state()?.file?.removed).toBe(1)
  })

  test('写入内容与盘上一致：file 为 null（写了个寂寞）', async () => {
    const { state } = await mountDiff(
      callOf('write', { path: 'a.txt', content: 'same' }),
      'D:/proj',
      () => Promise.resolve({ kind: 'text', text: 'same' }),
    )
    expect(state()).not.toBeNull()
    expect(state()?.file).toBeNull()
    expect(state()?.fellBack).toBe(false)
  })

  test('盘上不是文本或 invoke 抛错：回落参数，write 按空文件起算', async () => {
    const binary = await mountDiff(
      callOf('write', { path: 'a.bin', content: 'x\ny' }),
      'D:/proj',
      () => Promise.resolve({ kind: 'binary' }),
    )
    expect(binary.state()?.fellBack).toBe(true)
    expect(binary.state()?.file?.status).toBe('added')
    expect(binary.state()?.file?.added).toBe(2)

    const rejected = await mountDiff(
      callOf('write', { path: 'a.txt', content: 'x\ny' }),
      'D:/proj',
      () => Promise.reject(new Error('读不到')),
    )
    expect(rejected.state()?.fellBack).toBe(true)
    expect(rejected.state()?.file?.status).toBe('added')
    expect(rejected.state()?.file?.added).toBe(2)
  })
})

describe('useIntendedDiff：edit 的命中与两种不匹配', () => {
  const before = 'one\ntwo\nthree'

  test('old 恰好匹配一处：按盘上全文替换后算差异', async () => {
    const { state } = await mountDiff(
      callOf('edit', { path: 'a.txt', old: 'two', new: 'TWO' }),
      'D:/proj',
      () => Promise.resolve({ kind: 'text', text: before }),
    )
    expect(state()?.fellBack).toBe(false)
    expect(state()?.mismatch).toBeUndefined()
    expect(state()?.file?.status).toBe('modified')
    expect(state()?.file?.added).toBe(1)
    expect(state()?.file?.removed).toBe(1)
  })

  test('old 匹配不到：mismatch=missing，差异退化为参数 old→new', async () => {
    const { state } = await mountDiff(
      callOf('edit', { path: 'a.txt', old: 'zzz', new: 'ZZZ' }),
      'D:/proj',
      () => Promise.resolve({ kind: 'text', text: before }),
    )
    expect(state()?.fellBack).toBe(false)
    expect(state()?.mismatch).toBe('missing')
    expect(state()?.file?.status).toBe('modified')
  })

  test('old 匹配多处：mismatch=ambiguous', async () => {
    const { state } = await mountDiff(
      callOf('edit', { path: 'a.txt', old: 'aa', new: 'b' }),
      'D:/proj',
      () => Promise.resolve({ kind: 'text', text: 'aa\naa' }),
    )
    expect(state()?.mismatch).toBe('ambiguous')
    expect(state()?.fellBack).toBe(false)
  })
})

describe('useIntendedDiff：ops_edit_file 的多处替换', () => {
  test('盘上读不到：只拿第一处参数差异兜底', async () => {
    const { state } = await mountDiff(
      callOf('ops_edit_file', { path: 'a.txt', edits: [{ oldText: 'a', newText: 'A' }, { oldText: 'b', newText: 'B' }] }),
      'D:/proj',
      () => Promise.resolve({ kind: 'binary' }),
    )
    expect(state()?.fellBack).toBe(true)
    expect(state()?.mismatch).toBeUndefined()
    expect(state()?.file?.added).toBe(1)
    expect(state()?.file?.removed).toBe(1)
  })

  test('多处都唯一：按位置从后往前替换（参数顺序不影响结果）', async () => {
    const { state } = await mountDiff(
      callOf('ops_edit_file', {
        path: 'a.txt',
        // 故意倒序：实现里要先排序再倒着贴。
        edits: [
          { oldText: 'c', newText: 'C' },
          { oldText: 'a', newText: 'A' },
        ],
      }),
      'D:/proj',
      () => Promise.resolve({ kind: 'text', text: 'a\nb\nc' }),
    )
    expect(state()?.fellBack).toBe(false)
    expect(state()?.mismatch).toBeUndefined()
    expect(state()?.file?.added).toBe(2)
    expect(state()?.file?.removed).toBe(2)
  })

  test('某一处匹配不到 / 匹配多处 / 两处区间重叠都是 ambiguous 或 missing', async () => {
    const missing = await mountDiff(
      callOf('ops_edit_file', { path: 'a.txt', edits: [{ oldText: 'zzz', newText: 'Z' }] }),
      'D:/proj',
      () => Promise.resolve({ kind: 'text', text: 'abc' }),
    )
    expect(missing.state()?.mismatch).toBe('missing')

    const ambiguous = await mountDiff(
      callOf('ops_edit_file', { path: 'a.txt', edits: [{ oldText: 'aa', newText: 'b' }] }),
      'D:/proj',
      () => Promise.resolve({ kind: 'text', text: 'aaXaa' }),
    )
    expect(ambiguous.state()?.mismatch).toBe('ambiguous')

    // ab 与 bc 各自只匹配一次，但区间 [0,2) 与 [1,3) 重叠。
    const overlap = await mountDiff(
      callOf('ops_edit_file', {
        path: 'a.txt',
        edits: [
          { oldText: 'ab', newText: 'X' },
          { oldText: 'bc', newText: 'Y' },
        ],
      }),
      'D:/proj',
      () => Promise.resolve({ kind: 'text', text: 'abc' }),
    )
    expect(overlap.state()?.mismatch).toBe('ambiguous')
  })
})

describe('useIntendedDiff：ops_replace 的字面量批量替换', () => {
  test('有盘上现值：整篇 split/join；读不到：只对比 pattern 与 replacement', async () => {
    const replaced = await mountDiff(
      callOf('ops_replace', { path: 'a.txt', pattern: 'foo', replacement: 'baz' }),
      'D:/proj',
      () => Promise.resolve({ kind: 'text', text: 'foo bar foo' }),
    )
    expect(replaced.state()?.fellBack).toBe(false)
    expect(replaced.state()?.file?.status).toBe('modified')
    // 同一行里两处替换：整行算一删一增。
    expect(replaced.state()?.file?.added).toBe(1)
    expect(replaced.state()?.file?.removed).toBe(1)

    const fallback = await mountDiff(
      callOf('ops_replace', { path: 'a.txt', pattern: 'foo', replacement: 'baz' }),
      'D:/proj',
      () => Promise.resolve({ kind: 'binary' }),
    )
    expect(fallback.state()?.fellBack).toBe(true)
    expect(fallback.state()?.file?.status).toBe('modified')
    expect(fallback.state()?.file?.added).toBe(1)
    expect(fallback.state()?.file?.removed).toBe(1)
  })
})

// ── useIntendedDiff：不该发请求的三种情形 ───────────────────────────────────

describe('useIntendedDiff：非 running / disabled / 参数坏掉', () => {
  test('三种情形都不发 dock fs-read', async () => {
    const done = await mountDiff(
      callOf('write', { path: 'a.txt', content: 'x' }, 'done'),
      'D:/proj',
      () => Promise.resolve({ kind: 'text', text: '' }),
    )
    expect(done.invoke).not.toHaveBeenCalled()
    expect(done.state()).toBeNull()

    const disabled = await mountDiff(
      callOf('write', { path: 'a.txt', content: 'x' }),
      'D:/proj',
      () => Promise.resolve({ kind: 'text', text: '' }),
      false,
    )
    expect(disabled.invoke).not.toHaveBeenCalled()
    expect(disabled.state()).toBeNull()

    const badArgs = await mountDiff(
      { callId: 'c2', name: 'write', argsText: '{bad', status: 'running' },
      'D:/proj',
      () => Promise.resolve({ kind: 'text', text: '' }),
    )
    expect(badArgs.invoke).not.toHaveBeenCalled()
    expect(badArgs.state()).toBeNull()
  })

  test('running 变 done 之后状态清空', async () => {
    const invoke = vi.fn(() => Promise.resolve({ kind: 'text', text: 'one' }))
    const channel = channelOf(invoke as unknown as (method: string, args: unknown[]) => Promise<unknown>)
    let state: IntendedDiff | null = null
    const onState = (value: IntendedDiff | null): void => {
      state = value
    }
    const readState = (): IntendedDiff | null => state
    const running = callOf('write', { path: 'a.txt', content: 'two' })
    const view = render(tree(channel, running, 'D:/proj', true, onState))
    await flush()
    expect(readState()?.file?.status).toBe('modified')

    view.rerender(tree(channel, { ...running, status: 'done' }, 'D:/proj', true, onState))
    await flush()
    expect(readState()).toBeNull()
  })

  test('卸载之后才落地的读盘结果不再回写状态（then / catch 两条）', async () => {
    let resolveRead!: (value: unknown) => void
    const pending = vi.fn(
      () => new Promise<unknown>((resolve) => {
        resolveRead = resolve
      }),
    )
    let state: IntendedDiff | null = null
    const pendingChannel = channelOf(
      pending as unknown as (method: string, args: unknown[]) => Promise<unknown>,
    )
    const view = render(
      tree(pendingChannel, callOf('write', { path: 'a.txt', content: 'x' }), 'D:/proj', true, (value) => {
        state = value
      }),
    )
    await flush()
    expect(pending).toHaveBeenCalled()
    view.unmount()
    await act(async () => {
      resolveRead({ kind: 'text', text: 'y' })
      await Promise.resolve()
    })
    expect(state).toBeNull()

    let rejectRead!: (error: Error) => void
    const failing = vi.fn(
      () => new Promise<unknown>((_resolve, reject) => {
        rejectRead = reject
      }),
    )
    let afterCatch: IntendedDiff | null = null
    const failingChannel = channelOf(
      failing as unknown as (method: string, args: unknown[]) => Promise<unknown>,
    )
    const second = render(
      tree(failingChannel, callOf('write', { path: 'b.txt', content: 'x' }), 'D:/proj', true, (value) => {
        afterCatch = value
      }),
    )
    await flush()
    second.unmount()
    await act(async () => {
      rejectRead(new Error('boom'))
      await Promise.resolve()
    })
    expect(afterCatch).toBeNull()
  })
})
