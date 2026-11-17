/**
 * read_image 工具卡渲染体的渲染断言（ui 层）。
 *
 * 来源：`scripts/ui-tool-read-image-test.mjs` 第 [3] 段里「渲染体行为」的那一半。原探针读
 * `read-image-view.tsx` 源码钉「fs-read 现读、invoke 只出现一次、可点性」——真渲染下全部
 * 有行为等价物，而且比文本钉更硬：
 *
 * - 「展开体按路径现读」→ 渲染落定（done）的卡，假通道收到了一次 `fs-read`，参数里是
 *   cwd 拼好的**绝对**路径；
 * - 「跑动 / 被拒 / 中止不读盘」→ 同一张卡在 `running` / `rejected` / `aborted` 下渲染，
 *   invoke 一次都不发生（绕过用户的拒绝给他看内容，比闪错严重）；
 * - 「一次挂载只读一次盘」→ 同一渲染里 invoke 计数 = 1；
 * - 「四种状态各占一格」→ tooLarge 说「太大」、读不到说「点上方路径」、成功画出 img
 *   （`data:` 源 + alt 是文件名）；
 * - 「图片可点」→ img 带 `role="button"` / `tabIndex`，Enter / Space 也走 open（jsdom 里
 *   `setDockPreview` 是全局函数，渲染不点它就不接缝——这里只钉可点性与按键路径不抛）；
 * - 「尺寸取自 naturalWidth / naturalHeight」→ jsdom 的 img 不加载，naturalWidth 恒 0，
 *   组件按产品口径不画「宽×高」那一行（假读数比没有读数糟）。
 *
 * 判据与回执解析的**数据**半边（`read-image-model.ts`）已由 `read-image-model.spec.ts`
 * 覆盖；头行徽章的装配半边在 `factory.spec.tsx`。
 *
 * @module dsc-ui-transcript/ui/tool-card/read-image-view.spec
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import type { ToolCallView } from '@dsc/ui'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { DockFsRead } from './read-image-model.js'
import { ReadImageBody } from './read-image-view.js'

afterEach(cleanup)

/**
 * 记录 invoke 的假通道。`calls` 收下每一次调用的方法与参数，用例自己断言次数与内容。
 */
function recordingChannel(reply: DockFsRead | Error): { channel: HostChannel; calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = []
  const channel: HostChannel = {
    getSnapshot: () => null,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: <T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      return (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)) as Promise<T>
    },
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

/** 一条 read_image 调用。 */
function callOf(status: ToolCallView['status']): ToolCallView {
  return { callId: 'c1', name: 'read_image', argsText: '{"path":"shots/shot.png"}', status }
}

const PNG: DockFsRead = { kind: 'image', mime: 'image/png', base64: 'aVZCT1J3' }

function body(status: ToolCallView['status'], channel: HostChannel, cwd = 'D:\\work'): ReturnType<typeof render> {
  return render(
    <RuntimeProvider channel={channel}>
      <ReadImageBody call={callOf(status)} image={{ path: 'shots/shot.png' }} cwd={cwd} />
    </RuntimeProvider>,
  )
}

test('落定（done）才读盘：dock fs-read 一次，参数是 cwd 拼好的绝对路径', async () => {
  const { channel, calls } = recordingChannel(PNG)
  const card = body('done', channel)
  await waitFor(() => expect(card.container.querySelector('.tc-shot-img')).not.toBeNull())
  expect(calls).toHaveLength(1)
  expect(calls[0]?.method).toBe('dock')
  // invoke 的第二参数是 [op, args]：op 是 fs-read，参数里是 cwd 拼好的绝对路径
  // （分隔符跟基准目录走：基准是 Windows 形状，参数原文里的 `/` 原样保留）。
  expect(calls[0]?.args[0]).toBe('fs-read')
  expect(calls[0]?.args[1]).toEqual({ file: 'D:\\work\\shots/shot.png' })
})

test('读不到（reject）→「读不到」那一格；不是重试一次都不给', async () => {
  const { channel, calls } = recordingChannel(new Error('路径超出工作目录'))
  const card = body('done', channel)
  await waitFor(() => expect(card.container.textContent).toContain('读不到这张图'))
  expect(calls).toHaveLength(1)
  expect(card.container.querySelector('.tc-shot-img')).toBeNull()
})

test('跑动 / 被拒 / 中止不读盘：invoke 一次都不发生（绕过拒绝等于偷看）', () => {
  for (const status of ['running', 'rejected', 'aborted', 'preparing'] as const) {
    const { channel, calls } = recordingChannel(PNG)
    const card = body(status, channel)
    // 非落定画的是「读不到」那一格（那几种状态本来就没有图可画），但盘一次都不读。
    expect(calls, `${status} 不应发 fs-read`).toHaveLength(0)
    card.unmount()
  }
})

test('tooLarge 单独一格：说「超过 5MB」，不说「读不到」', async () => {
  const { channel } = recordingChannel({ kind: 'image', mime: 'image/png', base64: 'x', tooLarge: true } as DockFsRead)
  const card = body('done', channel)
  await waitFor(() => expect(card.container.textContent).not.toBe(''))
  expect(card.container.textContent).toContain('超过 5MB')
  expect(card.container.textContent).not.toContain('读不到这张图')
})

test('回执不是图片（kind 不对 / MIME 空）→「读不到」那一格', async () => {
  const { channel } = recordingChannel({ kind: 'other' })
  const card = body('done', channel)
  await waitFor(() => expect(card.container.textContent).toContain('读不到这张图'))
})

test('成功：img 的 src 是 data: 源、alt 是文件名（读屏拿得到名字）', async () => {
  const { channel } = recordingChannel(PNG)
  const card = body('done', channel)
  await waitFor(() => expect(card.container.querySelector('.tc-shot-img')).not.toBeNull())
  const img = card.container.querySelector('.tc-shot-img') as HTMLImageElement
  expect(img.getAttribute('src')).toBe(`data:image/png;base64,${PNG.base64}`)
  expect(img.getAttribute('alt')).toBe('shot.png')
})

test('图片可点：role=button + tabIndex，Enter / Space 也走同一条 open（不抛）', async () => {
  const { channel } = recordingChannel(PNG)
  const card = body('done', channel)
  await waitFor(() => expect(card.container.querySelector('.tc-shot-img')).not.toBeNull())
  const img = card.container.querySelector('.tc-shot-img') as HTMLElement
  expect(img.getAttribute('role')).toBe('button')
  expect(img.getAttribute('tabindex')).toBe('0')
  // jsdom 不加载图、setDockPreview 也不在测试里落地；可点性与键盘路径的存在性在这里钉。
  expect(() => fireEvent.click(img)).not.toThrow()
  expect(() => fireEvent.keyDown(img, { key: 'Enter' })).not.toThrow()
  expect(() => fireEvent.keyDown(img, { key: ' ' })).not.toThrow()
})

test('jsdom 不加载图（naturalWidth 恒 0）→ 不画「宽×高」那一行（假读数比没有读数糟）', async () => {
  const { channel } = recordingChannel(PNG)
  const card = body('done', channel)
  await waitFor(() => expect(card.container.querySelector('.tc-shot-img')).not.toBeNull())
  expect(card.container.querySelector('.tc-shot-meta')).toBeNull()
})
