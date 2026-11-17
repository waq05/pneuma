/**
 * 设置半的第二批补测（ui 层，真渲染）。
 *
 * 已有四份 spec 的分工：`ui-extra` / `nav` / `models-extra` / `usage-layout` 钉住了设置面板
 * 骨架、导航筛选、模型页主流程与用量页版式。这一份只补它们没走到的分支：
 *
 * - 模式页（`presets.tsx`）：分组徽标、用 / 设默认 / 刷新、查看原文、编辑与新建表单校验、
 *   工具白名单两态、删除的行内二次确认、两种读失败；
 * - 归档页（`archive.tsx`）：按工作区分组排序、标题兜底、时间文案四档、单条 / 整组恢复、
 *   结果失败与调用失败、回收站目录的桥三态；
 * - 用量页（`usage.tsx`）：读取失败与重试、两档空态、汇总卡（峰值缺失 / 缓存命中率）、
 *   单日折线、模型多于四条时的截取、环形图空态、趋势 30 日切换；
 * - 模型页剩余分支：拉清单失败、批量保存失败（面板不收起）、删除端点取消；
 * - 手机连接弹窗（`pair-modal.tsx`）：二维码、复制、重新生成、过期、局域网/服务未跑引导、
 *   Esc / 遮罩 / X 三条关闭路径与 Tab 焦点环。
 *
 * @module dsc-ui-settings/ui/settings-more.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type {
  ArchivedPage,
  ModelConfigView,
  PairShareData,
  PresetDraft,
  PresetSurface,
  ProviderModelView,
  SettingsMutation,
  ToolEntryView,
  UsageDayView,
  UsageStatsView,
} from '@dsc/ui'
import { PresetsGroup } from './presets.js'
import { ArchiveGroup } from './archive.js'
import { UsageGroup } from './usage.js'
import { ModelsGroup } from './models.js'
import { PairModal } from './pair-modal.js'

// 二维码库在 jsdom 里没有画布：换成固定 dataURL，弹窗的「画码」那条路仍然真跑。
vi.mock('qrcode', () => ({
  default: { toDataURL: (): Promise<string> => Promise.resolve('data:image/png;base64,QQ==') },
}))

// ── 假宿主 / 假桥 ──────────────────────────────────────────────────────────

interface Recorded {
  method: string
  args: unknown[]
}

type Reply = (args: unknown[]) => unknown

/** 按方法名路由的假通道；handler 返回 Error 表示 reject。 */
function channelOf(routes: Record<string, Reply>): { channel: HostChannel; calls: Recorded[] } {
  const calls: Recorded[] = []
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
      const handler = routes[method]
      if (handler === undefined) return Promise.resolve({ ok: true } as T)
      try {
        const value = handler(args)
        if (value instanceof Error) return Promise.reject(value) as Promise<T>
        return Promise.resolve(value) as Promise<T>
      } catch (error: unknown) {
        return Promise.reject(error) as Promise<T>
      }
    },
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

const mount = (channel: HostChannel, node: ReactNode): ReturnType<typeof render> =>
  render(<RuntimeProvider channel={channel}>{node}</RuntimeProvider>)

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })

const callsOf = (calls: Recorded[], method: string): unknown[][] =>
  calls.filter((call) => call.method === method).map((call) => call.args)

const toastText = (): string =>
  [...document.querySelectorAll('.dsc-toasts .dsc-toast__text')].map((node) => node.textContent ?? '').join('|')

const buttonWithText = (scope: ParentNode, text: string): HTMLButtonElement | undefined =>
  ([...scope.querySelectorAll('button')] as HTMLButtonElement[]).find((node) => node.textContent?.includes(text))

function fakeNative(call: (op: string, args: unknown[]) => unknown): Array<{ op: string; args: unknown[] }> {
  const calls: Array<{ op: string; args: unknown[] }> = []
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (op: string, args: unknown[] = []) => {
      calls.push({ op, args })
      try {
        return Promise.resolve(call(op, args))
      } catch (error: unknown) {
        return Promise.reject(error)
      }
    },
    on: () => () => undefined,
  }
  return calls
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  delete (globalThis as { dscNative?: unknown }).dscNative
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(() => Promise.resolve()) },
  })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.querySelectorAll('.dsc-toasts, .dsc-confirm').forEach((node) => node.remove())
  delete (globalThis as { dscNative?: unknown }).dscNative
  Reflect.deleteProperty(navigator, 'clipboard')
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

// ── 模式页 ────────────────────────────────────────────────────────────────

function presetView(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    label: name,
    description: `${name} 的说明`,
    tools: null,
    drop: [],
    deny: [],
    replace: false,
    prompt: '',
    builtin: false,
    ...over,
  }
}

function presetSurface(): PresetSurface {
  return {
    current: 'fast',
    defaultName: 'review',
    options: [
      presetView('fast', { label: '快速', description: '少绕弯', builtin: true }),
      presetView('review', {
        label: '审查',
        description: '专找问题',
        tools: ['read', 'exec'],
        drop: ['team'],
        prompt: '只找问题。',
        problem: '工具缺失',
      }),
      presetView('bare', { label: '裸', description: '', tools: [] }),
    ],
    droppable: [{ id: 'team', label: '团队协作段' }],
  } as unknown as PresetSurface
}

const TOOLS: ToolEntryView[] = [
  { name: 'read', risk: 'read', description: '读文件' },
  { name: 'exec', risk: 'exec', description: '跑命令', presets: ['review'] },
]

const presetRoutes = (surface: PresetSurface = presetSurface()): Record<string, Reply> => ({
  listPresets: () => surface,
  listTools: () => TOOLS,
  readPreset: (args) => ({ ok: true, name: String(args[0]), text: `# ${String(args[0])}\n正文` }),
})

const cardOf = (container: HTMLElement, label: string): HTMLElement => {
  const found = ([...container.querySelectorAll('.preset-card')] as HTMLElement[]).find((card) =>
    card.textContent?.includes(label),
  )
  if (found === undefined) throw new Error(`没有模式卡片 ${label}`)
  return found
}

describe('模式页', () => {
  test('内置 / 自定义分组与徽标：当前、默认、工具两态、去掉段、提示词字数、问题与空说明', async () => {
    const { channel } = channelOf(presetRoutes())
    const { container } = mount(channel, <PresetsGroup />)
    await waitFor(() => expect(container.querySelectorAll('.preset-card')).toHaveLength(3))

    const heads = [...container.querySelectorAll('.models-head')] as HTMLElement[]
    expect(heads[0]?.textContent).toContain('内置')
    expect(heads[0]?.querySelector('.count')?.textContent).toBe('1')
    expect(heads[1]?.textContent).toContain('自定义')
    expect(heads[1]?.querySelector('.count')?.textContent).toBe('2')

    const fast = cardOf(container, '快速')
    expect(fast.classList.contains('on')).toBe(true)
    expect(fast.textContent).toContain('当前')
    expect(fast.textContent).toContain('工具：全量（跟随当前挂载的插件）')
    expect(buttonWithText(fast, '使用中')?.disabled).toBe(true)
    expect(buttonWithText(fast, '删除')).toBeUndefined()

    const review = cardOf(container, '审查')
    expect(review.textContent).toContain('新会话默认')
    expect(review.textContent).toContain('工具：read、exec')
    expect(review.textContent).toContain('去掉提示段：team')
    expect(review.textContent).toContain('带 5 字提示词')
    expect(review.textContent).toContain('工具缺失')

    const bare = cardOf(container, '裸')
    expect(bare.textContent).toContain('没有写说明')
    expect(bare.textContent).toContain('工具：一个都不给')
  })

  test('用 / 设为默认 / 刷新 / 查看原文四条动作各自回传参数并重取清单', async () => {
    const { channel, calls } = channelOf(presetRoutes())
    const { container } = mount(channel, <PresetsGroup />)
    await waitFor(() => expect(container.querySelectorAll('.preset-card')).toHaveLength(3))

    const review = cardOf(container, '审查')
    fireEvent.click(buttonWithText(review, '用这个') as HTMLButtonElement)
    await waitFor(() => expect(callsOf(calls, 'usePreset')).toEqual([['review']]))
    await waitFor(() => expect(container.querySelector('.settings-note')?.textContent).toBe('已保存'))

    fireEvent.click(buttonWithText(cardOf(container, '快速'), '设为默认') as HTMLButtonElement)
    await waitFor(() => expect(callsOf(calls, 'setDefaultPreset')).toEqual([['fast']]))

    fireEvent.click(buttonWithText(cardOf(container, '快速'), '查看配置') as HTMLButtonElement)
    await waitFor(() => expect(container.querySelector('.preset-raw pre')?.textContent).toContain('# fast'))
    fireEvent.click(buttonWithText(container.querySelector('.preset-raw') as HTMLElement, '关闭') as HTMLButtonElement)
    expect(container.querySelector('.preset-raw')).toBeNull()

    const before = callsOf(calls, 'listPresets').length
    fireEvent.click(container.querySelector('.presets-refresh') as HTMLButtonElement)
    await waitFor(() => expect(callsOf(calls, 'listPresets').length).toBe(before + 1))
  })

  test('查看原文失败：宿主回 ok:false 与调用 reject 都摊在说明条里', async () => {
    const notFound = channelOf({
      ...presetRoutes(),
      readPreset: () => ({ ok: false, error: '文件没了' }),
    })
    const first = mount(notFound.channel, <PresetsGroup />)
    await waitFor(() => expect(first.container.querySelectorAll('.preset-card')).toHaveLength(3))
    fireEvent.click(buttonWithText(cardOf(first.container, '快速'), '查看配置') as HTMLButtonElement)
    await waitFor(() => expect(first.container.querySelector('.settings-note.error')?.textContent).toContain('读取失败：文件没了'))
    expect(first.container.querySelector('.preset-raw')).toBeNull()
    cleanup()

    const broken = channelOf({
      ...presetRoutes(),
      readPreset: () => new Error('读盘失败'),
    })
    const second = mount(broken.channel, <PresetsGroup />)
    await waitFor(() => expect(second.container.querySelectorAll('.preset-card')).toHaveLength(3))
    fireEvent.click(buttonWithText(cardOf(second.container, '快速'), '查看配置') as HTMLButtonElement)
    await waitFor(() => expect(second.container.querySelector('.settings-note.error')?.textContent).toContain('读盘失败'))
  })

  test('编辑表单：非法名与重名拦住保存；工具全量 / 白名单互换、去掉段与提示词一起写回', async () => {
    const { channel, calls } = channelOf({
      ...presetRoutes(),
      savePreset: () => ({ ok: true }),
    })
    const { container } = mount(channel, <PresetsGroup />)
    await waitFor(() => expect(container.querySelectorAll('.preset-card')).toHaveLength(3))
    fireEvent.click(buttonWithText(cardOf(container, '审查'), '编辑') as HTMLButtonElement)
    const form = container.querySelector('.preset-form') as HTMLElement
    expect(form.textContent).toContain('编辑模式「review」')

    const nameInput = form.querySelector('input.setting-input') as HTMLInputElement
    const save = buttonWithText(form, '保存') as HTMLButtonElement
    fireEvent.change(nameInput, { target: { value: 'Bad Name' } })
    expect(form.querySelector('.preset-problem')?.textContent).toContain('标识只能用小写字母')
    expect(save.disabled).toBe(true)

    fireEvent.change(nameInput, { target: { value: 'fast' } })
    expect(form.textContent).toContain('已经有一个叫「fast」的模式了')
    expect(save.disabled).toBe(true)

    fireEvent.change(nameInput, { target: { value: 'deep-review' } })
    expect(save.disabled).toBe(false)

    // 白名单初始是 read/exec：先取消 exec；再勾「全量」→ 多选整块收起；再取消 → 空名单（一个工具都不给）。
    const execLabel = ([...form.querySelectorAll('.preset-tool-grid .preset-tool')] as HTMLElement[]).find((node) =>
      node.textContent?.includes('exec'),
    ) as HTMLElement
    expect(execLabel.textContent).toContain('执行')
    expect(execLabel.textContent).toContain('仅 review')
    fireEvent.click(execLabel.querySelector('input') as HTMLInputElement)

    const all = form.querySelector('.preset-switch input') as HTMLInputElement
    expect(all.checked).toBe(false)
    fireEvent.click(all)
    expect(all.checked).toBe(true)
    expect(form.querySelector('.preset-tool-grid')).toBeNull()
    fireEvent.click(all)
    expect(all.checked).toBe(false)
    const toolRows = [...form.querySelectorAll('.preset-tool-grid .preset-tool input')] as HTMLInputElement[]
    expect(toolRows).toHaveLength(2)
    expect(toolRows.every((input) => input.checked === false)).toBe(true)

    const dropLabel = ([...form.querySelectorAll('.preset-tool')] as HTMLElement[]).find((node) =>
      node.textContent?.includes('team'),
    ) as HTMLElement
    // review 原本就带 team，这次点一下取消。
    fireEvent.click(dropLabel.querySelector('input') as HTMLInputElement)

    const prompt = form.querySelector('.preset-prompt') as HTMLTextAreaElement
    fireEvent.change(prompt, { target: { value: '新的提示词' } })

    fireEvent.click(save)
    await waitFor(() => expect(callsOf(calls, 'savePreset')).toHaveLength(1))
    const draft = callsOf(calls, 'savePreset')[0]?.[0] as PresetDraft
    expect(draft.oldName).toBe('review')
    expect(draft.name).toBe('deep-review')
    expect(draft.tools).toEqual([])
    expect(draft.drop).toEqual([])
    expect(draft.prompt).toBe('新的提示词')
    await waitFor(() => expect(container.querySelector('.preset-form')).toBeNull())
    expect(container.querySelector('.settings-note')?.textContent).toBe('模式已保存')
  })

  test('新建表单：空名不能保存；保存被宿主拒收时留在表单里；取消丢弃草稿', async () => {
    const { channel, calls } = channelOf({
      ...presetRoutes(),
      savePreset: () => ({ ok: false, error: '磁盘满' }),
    })
    const { container } = mount(channel, <PresetsGroup />)
    await waitFor(() => expect(container.querySelectorAll('.preset-card')).toHaveLength(3))
    fireEvent.click(buttonWithText(container, '新建模式') as HTMLButtonElement)
    const form = container.querySelector('.preset-form') as HTMLElement
    const save = buttonWithText(form, '创建') as HTMLButtonElement
    expect(save.disabled).toBe(true)

    fireEvent.change(form.querySelector('input.setting-input') as HTMLInputElement, { target: { value: 'mine' } })
    fireEvent.click(save)
    await waitFor(() => expect(container.querySelector('.settings-note.error')?.textContent).toBe('保存失败：磁盘满'))
    expect(container.querySelector('.preset-form')).not.toBeNull()
    expect(callsOf(calls, 'savePreset')[0]?.[0]).toMatchObject({ oldName: null, name: 'mine' })

    fireEvent.click(buttonWithText(form, '取消') as HTMLButtonElement)
    expect(container.querySelector('.preset-form')).toBeNull()
  })

  test('删除：内置没有删除钮；自定义两步确认，取消不调宿主，确认后走 removePreset；宿主拒收给原因', async () => {
    const { channel, calls } = channelOf({
      ...presetRoutes(),
      removePreset: () => ({ ok: true }),
    })
    const { container } = mount(channel, <PresetsGroup />)
    await waitFor(() => expect(container.querySelectorAll('.preset-card')).toHaveLength(3))
    const review = cardOf(container, '审查')
    fireEvent.click(buttonWithText(review, '删除') as HTMLButtonElement)
    expect(buttonWithText(review, '确认删除')).not.toBeUndefined()
    fireEvent.click(buttonWithText(review, '取消') as HTMLButtonElement)
    expect(callsOf(calls, 'removePreset')).toHaveLength(0)
    expect(buttonWithText(review, '删除')).not.toBeUndefined()

    fireEvent.click(buttonWithText(review, '删除') as HTMLButtonElement)
    fireEvent.click(buttonWithText(review, '确认删除') as HTMLButtonElement)
    await waitFor(() => expect(callsOf(calls, 'removePreset')).toEqual([['review']]))
    await waitFor(() => expect(container.querySelector('.settings-note')?.textContent).toBe('已保存'))
    cleanup()

    const refused = channelOf({
      ...presetRoutes(),
      removePreset: () => ({ ok: false, error: '不能删' }),
    })
    const second = mount(refused.channel, <PresetsGroup />)
    await waitFor(() => expect(second.container.querySelectorAll('.preset-card')).toHaveLength(3))
    const secondReview = cardOf(second.container, '审查')
    fireEvent.click(buttonWithText(secondReview, '删除') as HTMLButtonElement)
    fireEvent.click(buttonWithText(secondReview, '确认删除') as HTMLButtonElement)
    await waitFor(() => expect(second.container.querySelector('.settings-note.error')?.textContent).toBe('操作失败：不能删'))
  })

  test('读失败：清单与工具目录各自说清；自定义为空时给手写文件的提示', async () => {
    const broken = channelOf({
      listPresets: () => new Error('目录不可读'),
      listTools: () => new Error('工具表坏了'),
    })
    const first = mount(broken.channel, <PresetsGroup />)
    await flush()
    // 清单本身没取到时整页停在加载态（说明条挂在正式面里），工具目录的失败单独验。
    expect(first.container.textContent).toContain('正在读取模式')
    cleanup()

    const toolsBroken = channelOf({
      listPresets: () => presetSurface(),
      listTools: () => new Error('工具表坏了'),
    })
    const second = mount(toolsBroken.channel, <PresetsGroup />)
    await waitFor(() => expect(second.container.querySelector('.settings-note.error')?.textContent).toContain('读取工具目录失败'))
    expect(second.container.textContent).toContain('读取工具目录失败，工具多选这一块是空的')
    cleanup()

    const empty = channelOf({
      listPresets: () => ({ current: 'a', defaultName: 'a', options: [], droppable: [] }),
      listTools: () => [],
    })
    const third = mount(empty.channel, <PresetsGroup />)
    await waitFor(() => expect(third.container.textContent).toContain('还没有自定义模式'))
  })
})

// ── 归档页 ────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000

function archivedPage(): ArchivedPage {
  const now = Date.now()
  return {
    items: [
      { path: 'C:/a/old.jsonl', cwd: 'C:/work/alpha', title: '旧会话', createdAt: 1, updatedAt: 2, archivedAt: now - 6 * DAY },
      { path: 'C:/a/new.jsonl', cwd: 'C:/work/alpha', createdAt: 1, updatedAt: 2, archivedAt: now - 5 * 60_000 },
      { path: 'C:/b/solo.jsonl', cwd: 'D:/work/beta', title: undefined, createdAt: 1, updatedAt: 2, archivedAt: now - 2 * 60 * 60_000 },
      { path: 'C:/c/just.jsonl', cwd: 'D:/work/beta', createdAt: 1, updatedAt: 2, archivedAt: now - 30_000 },
    ],
    trashDir: 'C:/trash',
    trashCount: 3,
  } as unknown as ArchivedPage
}

describe('归档页', () => {
  test('按工作区分组、组内按归档时间倒序；标题兜底与刚刚 / 小时 / 天三档时间文案', async () => {
    const { channel } = channelOf({ listArchivedSessions: () => archivedPage() })
    const { container } = mount(channel, <ArchiveGroup />)
    await waitFor(() => expect(container.querySelectorAll('.arch-group')).toHaveLength(2))
    const groups = [...container.querySelectorAll('.arch-group')] as HTMLElement[]
    // beta 组最新的归档时间更近，排前面。
    expect(groups[0]?.querySelector('.dir')?.textContent).toBe('beta')
    expect(groups[0]?.querySelectorAll('.arch-row')).toHaveLength(2)
    expect(groups[1]?.querySelector('.dir')?.textContent).toBe('alpha')
    expect(container.querySelector('.arch-head')?.textContent).toContain('已归档会话 4 个')
    const rows = [...container.querySelectorAll('.arch-row')] as HTMLElement[]
    const just = rows.find((row) => row.getAttribute('data-tip') === 'C:/c/just.jsonl') as HTMLElement
    expect(just.querySelector('.when')?.textContent).toContain('刚刚')
    const solo = rows.find((row) => row.getAttribute('data-tip') === 'C:/b/solo.jsonl') as HTMLElement
    expect(solo.querySelector('.title')?.textContent).toBe('未命名会话')
    expect(solo.querySelector('.when')?.textContent).toContain('2 小时前')
    const old = rows.find((row) => row.getAttribute('data-tip') === 'C:/a/old.jsonl') as HTMLElement
    expect(old.querySelector('.when')?.textContent).toContain('6 天前')
    expect(container.querySelector('.arch-foot')?.textContent).toContain('现有 3 个文件')
  })

  test('空归档：画空态卡而不是空白；恢复单条与整组各自回传路径并重取', async () => {
    const empty = channelOf({
      listArchivedSessions: () => ({ items: [], trashDir: 'C:/trash', trashCount: 0 }),
    })
    const first = mount(empty.channel, <ArchiveGroup />)
    await waitFor(() => expect(first.container.querySelector('.empty-card')).not.toBeNull())
    expect(first.container.querySelector('.empty-card-title')?.textContent).toBe('归档区是空的')
    cleanup()

    const page = archivedPage()
    const { channel, calls } = channelOf({
      listArchivedSessions: () => page,
      restoreSessions: () => ({ ok: true }),
    })
    const second = mount(channel, <ArchiveGroup />)
    await waitFor(() => expect(second.container.querySelectorAll('.arch-row')).toHaveLength(4))

    const alpha = [...second.container.querySelectorAll('.arch-group')].find((group) =>
      group.querySelector('.dir')?.textContent === 'alpha',
    ) as HTMLElement
    fireEvent.click(buttonWithText(second.container.querySelector('[data-tip="C:/c/just.jsonl"]') as HTMLElement, '恢复') as HTMLButtonElement)
    await waitFor(() => expect(callsOf(calls, 'restoreSessions')).toEqual([[['C:/c/just.jsonl']]]))
    await waitFor(() => expect(second.container.querySelector('.settings-note')?.textContent).toBe('已恢复到会话列表'))

    fireEvent.click(buttonWithText(alpha, '全部恢复') as HTMLButtonElement)
    await waitFor(() => expect(callsOf(calls, 'restoreSessions')).toHaveLength(2))
    expect(callsOf(calls, 'restoreSessions')[1]?.[0]).toEqual(['C:/a/new.jsonl', 'C:/a/old.jsonl'])
    await waitFor(() => expect(second.container.querySelector('.settings-note')?.textContent).toBe('已恢复这个工作区的 2 个会话'))
  })

  test('恢复失败与调用失败：宿主拒收给 error，通道 reject 给原文', async () => {
    const refused = channelOf({
      listArchivedSessions: () => archivedPage(),
      restoreSessions: () => ({ ok: false, error: '文件被占用' }),
    })
    const first = mount(refused.channel, <ArchiveGroup />)
    await waitFor(() => expect(first.container.querySelectorAll('.arch-row')).toHaveLength(4))
    fireEvent.click(buttonWithText(first.container.querySelector('[data-tip="C:/c/just.jsonl"]') as HTMLElement, '恢复') as HTMLButtonElement)
    await waitFor(() => expect(first.container.querySelector('.settings-note.error')?.textContent).toBe('操作失败：文件被占用'))
    cleanup()

    const broken = channelOf({
      listArchivedSessions: () => archivedPage(),
      restoreSessions: () => new Error('通道断了'),
    })
    const second = mount(broken.channel, <ArchiveGroup />)
    await waitFor(() => expect(second.container.querySelectorAll('.arch-row')).toHaveLength(4))
    fireEvent.click(buttonWithText(second.container.querySelector('[data-tip="C:/c/just.jsonl"]') as HTMLElement, '恢复') as HTMLButtonElement)
    await waitFor(() => expect(second.container.querySelector('.settings-note.error')?.textContent).toContain('通道断了'))
  })

  test('打开回收站：桥缺席、桥返回成功、桥返回问题、桥抛错四条路', async () => {
    const noBridge = channelOf({ listArchivedSessions: () => archivedPage() })
    const first = mount(noBridge.channel, <ArchiveGroup />)
    await waitFor(() => expect(first.container.querySelector('.arch-foot')).not.toBeNull())
    fireEvent.click(buttonWithText(first.container.querySelector('.arch-foot') as HTMLElement, '打开回收站') as HTMLButtonElement)
    await waitFor(() => expect(first.container.querySelector('.settings-note.error')?.textContent).toContain('这个窗口里没有原生桥'))
    cleanup()

    const okCalls = fakeNative(() => '')
    const second = mount(channelOf({ listArchivedSessions: () => archivedPage() }).channel, <ArchiveGroup />)
    await waitFor(() => expect(second.container.querySelector('.arch-foot')).not.toBeNull())
    fireEvent.click(buttonWithText(second.container.querySelector('.arch-foot') as HTMLElement, '打开回收站') as HTMLButtonElement)
    await waitFor(() => expect(second.container.querySelector('.settings-note')?.textContent).toBe('已在文件管理器中打开回收站'))
    expect(okCalls).toContainEqual({ op: 'openPath', args: ['C:/trash'] })
    cleanup()

    fakeNative(() => '权限不足')
    const third = mount(channelOf({ listArchivedSessions: () => archivedPage() }).channel, <ArchiveGroup />)
    await waitFor(() => expect(third.container.querySelector('.arch-foot')).not.toBeNull())
    fireEvent.click(buttonWithText(third.container.querySelector('.arch-foot') as HTMLElement, '打开回收站') as HTMLButtonElement)
    await waitFor(() => expect(third.container.querySelector('.settings-note.error')?.textContent).toBe('打开失败：权限不足'))
    cleanup()

    fakeNative(() => {
      throw new Error('桥炸了')
    })
    const fourth = mount(channelOf({ listArchivedSessions: () => archivedPage() }).channel, <ArchiveGroup />)
    await waitFor(() => expect(fourth.container.querySelector('.arch-foot')).not.toBeNull())
    fireEvent.click(buttonWithText(fourth.container.querySelector('.arch-foot') as HTMLElement, '打开回收站') as HTMLButtonElement)
    await waitFor(() => expect(fourth.container.querySelector('.settings-note.error')?.textContent).toContain('桥炸了'))
  })
})

// ── 用量页 ────────────────────────────────────────────────────────────────

function dayOf(date: string, input: number, output: number, byModel: Record<string, number> = {}): UsageDayView {
  return { date, inputTokens: input, outputTokens: output, turns: 1, byModel } as UsageDayView
}

function statsOf(over: Partial<UsageStatsView> = {}): UsageStatsView {
  const days = [dayOf('2026-11-14', 100, 50, { 'p/m1': 150 }), dayOf('2026-11-15', 200, 100, { 'p/m1': 200, 'p/m2': 100 })]
  return {
    sinceTs: 1,
    totalInputTokens: 300,
    totalOutputTokens: 150,
    totalCacheHitTokens: 0,
    totalCacheMissTokens: 0,
    totalTurns: 2,
    activeDays: 2,
    currentStreakDays: 2,
    longestStreakDays: 2,
    peakDay: days[1] as UsageDayView,
    days,
    models: [
      { key: 'p/m1', inputTokens: 200, outputTokens: 100, turns: 2, cacheHitTokens: 0, cacheMissTokens: 0 },
      { key: 'p/m2', inputTokens: 100, outputTokens: 50, turns: 1, cacheHitTokens: 0, cacheMissTokens: 0 },
    ],
    ...over,
  } as UsageStatsView
}

describe('用量页', () => {
  test('读取失败给原因与重试；重试成功后画正式面', async () => {
    let attempts = 0
    const { channel } = channelOf({
      usageStats: () => {
        attempts += 1
        return attempts === 1 ? new Error('文件损坏') : statsOf()
      },
    })
    const { container } = mount(channel, <UsageGroup />)
    await waitFor(() => expect(container.querySelector('.settings-empty')?.textContent).toContain('用量统计读取失败：文件损坏'))
    fireEvent.click(buttonWithText(container, '重试') as HTMLButtonElement)
    await waitFor(() => expect(container.querySelector('.usage')).not.toBeNull())
    expect(attempts).toBe(2)
  })

  test('两档空态：没有任何记录与记录损坏', async () => {
    const none = channelOf({ usageStats: () => statsOf({ sinceTs: null, days: [], models: [], peakDay: null }) })
    const first = mount(none.channel, <UsageGroup />)
    await waitFor(() => expect(first.container.querySelector('.usage-empty')?.textContent).toContain('还没有任何用量记录。'))
    expect(first.container.querySelector('.usage-empty')?.textContent).toContain('开始使用后显示统计。')
    cleanup()

    const broken = channelOf({ usageStats: () => statsOf({ sinceTs: 1, days: [] }) })
    const second = mount(broken.channel, <UsageGroup />)
    await waitFor(() => expect(second.container.querySelector('.settings-empty')?.textContent).toBe('用量记录存在，但没有逐日数据（记录文件可能损坏）。'))
  })

  test('汇总卡：亿 / 万亿换算、峰值缺失写「—」、缓存命中率只在有上报时出现', async () => {
    const { channel } = channelOf({
      usageStats: () =>
        statsOf({
          totalInputTokens: 100_000_000,
          totalOutputTokens: 50_000_000,
          peakDay: null,
          totalCacheHitTokens: 40,
          totalCacheMissTokens: 10,
        }),
    })
    const { container } = mount(channel, <UsageGroup />)
    await waitFor(() => expect(container.querySelector('.usage-cards')).not.toBeNull())
    const cards = [...container.querySelectorAll('.usage-card')] as HTMLElement[]
    const cardText = (label: string): string =>
      cards.find((card) => card.querySelector('.usage-card-label')?.textContent === label)?.querySelector('.usage-card-value')?.textContent ?? ''
    expect(cardText('累计 Token')).toBe('1.50 亿')
    expect(cardText('单日峰值 Token')).toBe('—')
    expect(cardText('活跃天数')).toBe('2 天')
    expect(cardText('当前连续')).toBe('2 天')
    expect(cardText('最长连续')).toBe('2 天')
    expect(cardText('前缀缓存命中')).toBe('80%')
    expect(container.querySelector('.usage-foot')?.textContent).toContain('起记录 · 共 2 轮请求')
  })

  test('趋势：单日居中、四条线截取、30 日切换；模型全零时环形图给空态', async () => {
    const oneDay = statsOf({
      days: [dayOf('2026-11-15', 2_000_000, 1_000_000, { 'p/m1': 3_000_000 })],
      models: [
        { key: 'p/m1', inputTokens: 1, outputTokens: 1, turns: 1, cacheHitTokens: 0, cacheMissTokens: 0 },
        { key: 'p/m2', inputTokens: 1, outputTokens: 1, turns: 1, cacheHitTokens: 0, cacheMissTokens: 0 },
        { key: 'p/m3', inputTokens: 1, outputTokens: 1, turns: 1, cacheHitTokens: 0, cacheMissTokens: 0 },
        { key: 'p/m4', inputTokens: 1, outputTokens: 1, turns: 1, cacheHitTokens: 0, cacheMissTokens: 0 },
        { key: 'p/m5', inputTokens: 1, outputTokens: 1, turns: 1, cacheHitTokens: 0, cacheMissTokens: 0 },
      ],
      peakDay: dayOf('2026-11-15', 2_000_000, 1_000_000),
    })
    const { channel } = channelOf({ usageStats: () => oneDay })
    const { container } = mount(channel, <UsageGroup />)
    await waitFor(() => expect(container.querySelector('.usage')).not.toBeNull())

    // 五条模型只画前四条图例；单日折线的 x 落在画布中线（640 - 52 - 12 = 576）。
    const legend = [...container.querySelectorAll('.trend-legend-item')]
    expect(legend).toHaveLength(4)
    expect(container.querySelector('.trend-line')?.getAttribute('d')).toBe('M340.0 80.8')
    expect(container.querySelector('.usage-foot')?.textContent).toBeTruthy()

    const ranges = [...container.querySelectorAll('.usage-block')][1]?.querySelectorAll('.dsc-segmented__btn') ?? []
    const last30 = [...ranges][1] as HTMLButtonElement
    fireEvent.click(last30)
    await flush()
    expect(last30.getAttribute('aria-selected')).toBe('true')

    expect(container.querySelector('.donut-svg')).not.toBeNull()
    cleanup()

    const zero = statsOf({
      models: [{ key: 'p/m1', inputTokens: 0, outputTokens: 0, turns: 0, cacheHitTokens: 0, cacheMissTokens: 0 }],
    })
    const second = mount(channelOf({ usageStats: () => zero }).channel, <UsageGroup />)
    await waitFor(() => expect(second.container.querySelector('.donut-empty, .settings-empty')).not.toBeNull())
    expect(second.container.textContent).toContain('还没有模型用量。')
  })

  test('趋势没有模型：图例写「这段时间没有请求」', async () => {
    const { channel } = channelOf({ usageStats: () => statsOf({ models: [] }) })
    const { container } = mount(channel, <UsageGroup />)
    await waitFor(() => expect(container.querySelector('.trend-legend')).not.toBeNull())
    expect(container.querySelector('.trend-legend')?.textContent).toBe('这段时间没有请求')
  })

  test('刷新按钮重新取一次数据', async () => {
    const { channel, calls } = channelOf({ usageStats: () => statsOf() })
    const { container } = mount(channel, <UsageGroup />)
    await waitFor(() => expect(container.querySelector('.usage')).not.toBeNull())
    const before = callsOf(calls, 'usageStats').length
    fireEvent.click(buttonWithText(container.querySelector('.usage-foot') as HTMLElement, '刷新') as HTMLButtonElement)
    await waitFor(() => expect(callsOf(calls, 'usageStats').length).toBe(before + 1))
  })
})

// ── 模型页剩余分支 ─────────────────────────────────────────────────────────

function modelOf(id: string): ProviderModelView {
  return {
    id,
    name: id,
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinkingLevels: ['off', 'low', 'high', 'max'],
    thinkingParam: 'thinking',
    effortMap: {},
    modalities: ['text'],
  }
}

function modelConfig(): ModelConfigView {
  return {
    providers: [
      {
        name: 'deepseek',
        displayName: 'DeepSeek 官方',
        baseUrl: 'https://api.deepseek.com/v1',
        keyRef: 'DEEPSEEK_API_KEY',
        keyConfigured: true,
        models: [modelOf('deepseek-chat')],
      },
      {
        name: 'lab',
        displayName: '',
        baseUrl: 'https://lab.example/v1',
        keyRef: 'LAB_KEY',
        keyConfigured: false,
        models: [modelOf('lab-mini')],
      },
    ],
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek-chat',
    temperature: null,
    configFile: 'D:\\dsc\\config.yaml',
    credentialsFile: 'D:\\dsc\\credentials.yaml',
  }
}

const answerConfirm = async (accept: boolean): Promise<void> => {
  await waitFor(() => expect(document.querySelector('.dsc-confirm')).not.toBeNull())
  const buttons = document.querySelectorAll('.dsc-confirm__actions button')
  fireEvent.click(buttons[accept ? 1 : 0] as HTMLElement)
}

describe('模型页剩余分支', () => {
  test('拉清单失败与批量保存失败都留回执，批量面板不收起', async () => {
    // 批量保存走原生桥的 saveProvider（与写 key 同一档），所以桥按 op 回失败。
    const nativeCalls = fakeNative((op) => (op === 'saveProvider' ? { ok: false, error: '写不了' } : { ok: true }))
    const { channel, calls } = channelOf({
      getModelConfig: () => modelConfig(),
      discoverModels: () => new Error('端点连不上'),
    })
    const { container } = mount(channel, <ModelsGroup />)
    await waitFor(() => expect(container.querySelector('[data-provider="deepseek"]')).not.toBeNull())

    fireEvent.click(container.querySelector('[data-model-discover="1"]') as HTMLButtonElement)
    await waitFor(() => expect(toastText()).toContain('拉取失败：端点连不上'))

    fireEvent.click(container.querySelector('[data-model-bulk="1"]') as HTMLButtonElement)
    const bulkBox = container.querySelector('[data-model-bulk-box="1"]') as HTMLElement
    expect(bulkBox).not.toBeNull()
    const textarea = bulkBox.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'deepseek-chat, Chat, 128000, 8192' } })
    fireEvent.click(container.querySelector('[data-model-bulk-save="1"]') as HTMLButtonElement)
    await waitFor(() => expect(toastText()).toContain('操作失败：写不了'))
    expect(container.querySelector('[data-model-bulk-box="1"]')).not.toBeNull()
    expect(nativeCalls.filter((call) => call.op === 'saveProvider')).toHaveLength(1)
    expect(callsOf(calls, 'saveProvider')).toHaveLength(0)
  })

  test('删除端点：取消不调桥，确认后才调 removeProvider', async () => {
    const nativeCalls = fakeNative(() => ({ ok: true }))
    const { channel } = channelOf({ getModelConfig: () => modelConfig() })
    const { container } = mount(channel, <ModelsGroup />)
    await waitFor(() => expect(container.querySelector('[data-provider="deepseek"]')).not.toBeNull())

    fireEvent.click(container.querySelector('[data-provider-remove="1"]') as HTMLButtonElement)
    await answerConfirm(false)
    expect(nativeCalls.some((call) => call.op === 'removeProvider')).toBe(false)

    fireEvent.click(container.querySelector('[data-provider-remove="1"]') as HTMLButtonElement)
    await answerConfirm(true)
    await waitFor(() => expect(nativeCalls.some((call) => call.op === 'removeProvider')).toBe(true))
  })
})

// ── 手机连接弹窗 ───────────────────────────────────────────────────────────

function pairData(over: Partial<PairShareData> = {}): PairShareData {
  return {
    kind: 'pair-code',
    code: '12345678',
    url: 'http://192.168.1.2:3456/?code=12345678',
    expiresAt: Date.now() + 60_000,
    reach: 'lan',
    ...over,
  }
}

const noopResult = async (): Promise<{ ok: false; error: string }> => ({ ok: false, error: '没做' })

describe('手机连接弹窗', () => {
  test('局域网可达：画二维码、配对码与地址都能复制，Esc 关闭', async () => {
    const onClose = vi.fn()
    const { container } = render(
      <PairModal data={pairData()} onRegenerate={() => Promise.resolve({ ok: true, data: pairData() })} onEnableLan={noopResult} onClose={onClose} />,
    )
    const image = await waitFor(() => {
      const node = document.querySelector('.pair-qr-img') as HTMLImageElement | null
      expect(node).not.toBeNull()
      return node as HTMLImageElement
    })
    expect(image.getAttribute('src')).toBe('data:image/png;base64,QQ==')
    expect(image.getAttribute('alt')).toBe('配对二维码，指向 http://192.168.1.2:3456/?code=12345678')
    expect(document.querySelector('.pair-code')?.textContent).toBe('12345678')
    expect(document.querySelector('.pair-url-text')?.textContent).toBe('http://192.168.1.2:3456/?code=12345678')
    expect(document.querySelector('.pair-count')?.textContent).toMatch(/剩余有效时间 0[01]:\d\d/)

    const copyButtons = [...document.querySelectorAll('.pair-code-row button, .pair-url button')] as HTMLButtonElement[]
    fireEvent.click(copyButtons[0] as HTMLButtonElement)
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('12345678'))
    await waitFor(() => expect(toastText()).toContain('已复制'))
    fireEvent.click(copyButtons[1] as HTMLButtonElement)
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('http://192.168.1.2:3456/?code=12345678'))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(container).toBeTruthy()
  })

  test('过期：二维码与码变灰、复制禁用、倒计时写过期', async () => {
    render(
      <PairModal
        data={pairData({ expiresAt: Date.now() - 1_000 })}
        onRegenerate={() => Promise.resolve({ ok: false, error: 'x' })}
        onEnableLan={noopResult}
        onClose={() => undefined}
      />,
    )
    await waitFor(() => expect(document.querySelector('.pair-count')?.textContent).toBe('配对码已过期，请重新生成'))
    expect(document.querySelector('.pair-code-row')?.classList.contains('expired')).toBe(true)
    expect(document.querySelector('.pair-qr')?.classList.contains('expired')).toBe(true)
    const copyButtons = [...document.querySelectorAll('.pair-code-row button, .pair-url button')] as HTMLButtonElement[]
    expect(copyButtons.every((button) => button.disabled)).toBe(true)
  })

  test('只允许本机：不画码，给引导；点「打开局域网访问」成功后原地换新码', async () => {
    const pending: { resolve: ((value: { ok: true; data: PairShareData }) => void) | null } = { resolve: null }
    const onEnableLan = vi.fn(
      () =>
        new Promise<{ ok: true; data: PairShareData }>((resolve) => {
          pending.resolve = resolve
        }),
    )
    render(
      <PairModal
        data={pairData({ reach: 'local' })}
        onRegenerate={() => Promise.resolve({ ok: false, error: 'x' })}
        onEnableLan={onEnableLan}
        onClose={() => undefined}
      />,
    )
    expect(document.querySelector('.pair-qr-guide-title')?.textContent).toBe('手机连不上：现在只允许本机访问')
    expect(document.querySelector('.pair-qr-guide-body')?.textContent).toContain('127.0.0.1')
    expect(document.querySelector('.pair-qr-img')).toBeNull()
    const button = document.querySelector('.pair-qr-guide .btn-primary') as HTMLButtonElement
    expect(button.textContent).toBe('打开局域网访问并生成二维码')

    fireEvent.click(button)
    await waitFor(() => expect(button.textContent).toBe('正在生成…'))
    expect(button.disabled).toBe(true)
    pending.resolve?.({ ok: true, data: pairData({ code: '87654321' }) })
    await waitFor(() => expect(document.querySelector('.pair-code')?.textContent).toBe('87654321'))
    expect(document.querySelector('.pair-qr-guide')).toBeNull()
    await waitFor(() => expect(document.querySelector('.pair-qr-img')).not.toBeNull())
  })

  test('服务没跑：引导文案不同；打开失败把原因留在弹窗里，重新生成成功原地换数据', async () => {
    render(
      <PairModal
        data={pairData({ reach: 'down' })}
        onRegenerate={() => Promise.resolve({ ok: true, data: pairData({ code: '99999999' }) })}
        onEnableLan={() => Promise.resolve({ ok: false, error: '端口被占用' })}
        onClose={() => undefined}
      />,
    )
    expect(document.querySelector('.pair-qr-guide-title')?.textContent).toBe('手机连不上：远程服务没在跑')
    const guideButton = document.querySelector('.pair-qr-guide .btn-primary') as HTMLButtonElement
    expect(guideButton.textContent).toBe('重新打开远程控制并生成二维码')
    fireEvent.click(guideButton)
    await waitFor(() => expect(document.querySelector('.pair-error')?.textContent).toBe('端口被占用'))

    fireEvent.click(buttonWithText(document, '重新生成') as HTMLButtonElement)
    await waitFor(() => expect(document.querySelector('.pair-code')?.textContent).toBe('99999999'))
  })

  test('关闭路径：点遮罩与 X 都回调；Tab 在弹窗内首尾回环', async () => {
    const onClose = vi.fn()
    render(
      <PairModal
        data={pairData()}
        onRegenerate={() => Promise.resolve({ ok: false, error: 'x' })}
        onEnableLan={noopResult}
        onClose={onClose}
      />,
    )
    const card = document.querySelector('.pair-card') as HTMLElement
    const overlay = document.querySelector('.pair-modal') as HTMLElement

    const focusables = [...card.querySelectorAll<HTMLElement>('button:not([disabled])')]
    focusables[focusables.length - 1]?.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(focusables[0])
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(focusables[focusables.length - 1])

    fireEvent.mouseDown(overlay)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(card.querySelector('.pair-head .icon-btn') as HTMLButtonElement)
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
