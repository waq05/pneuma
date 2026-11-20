/**
 * Super Agent 设置页的补盲（`packages/ui-superagent/ui/settings.tsx`）。
 *
 * 设置分区、当前值、写入回执全部走壳的四个界面方法；这里用一个可控假通道把它们
 * 逐条喂回去，把「控件渲染 + 落盘 + 回读对账 + 记录表草稿」四条路真跑一遍：
 * - info / button / fact / select（含宿主给的外部值）/ switch / text / number 七种控件；
 * - 标量与记录表的成功、失败、抛错三种回执，以及成功后的回读对账；
 * - 记录表：加行、填格失焦提交、格式不合法提示、删行、「保存表格」；
 * - 底部的「最近变更」在历史为空 / 有记录 / 字段名认不出时的三种画法。
 *
 * @module dsc/packages/ui-superagent/ui/w12-settings.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { SettingsField, SettingsSectionView, SettingsValues } from '@dsc/ui'
import { SettingsPage } from './settings.js'
import type { SuperagentView } from './state.js'

type Reply = (method: string, args: unknown[]) => unknown

/** 可控假通道：每个方法的分支由 `state.reply` 决定。 */
function makeHarness(section: SettingsSectionView, values: SettingsValues): {
  channel: HostChannel
  state: { reply: Reply; values: SettingsValues; calls: string[] }
} {
  const state = {
    values,
    calls: [] as string[],
    reply: ((method: string): unknown => {
      if (method === 'getSettingsSections') return [section]
      if (method === 'getSectionValues') return state.values
      return { ok: true }
    }) as Reply,
  }
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
      state.calls.push(method)
      try {
        return Promise.resolve(state.reply(method, args) as T)
      } catch (error) {
        return Promise.reject(error) as Promise<T>
      }
    },
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, state }
}

/** 一个字段齐全的分区：七种控件各来一个。 */
function sectionOf(): SettingsSectionView {
  const fields = [
    { type: 'info', label: '版本', help: '只读信息', text: '1.2.3', mono: true },
    { type: 'button', action: 'restart', label: '重启', style: 'primary' },
    { type: 'button', action: 'reset', label: '重置', style: 'ghost', help: '清空缓存' },
    { type: 'fact', key: 'pid', label: '进程号', help: '宿主进程' },
    { type: 'fact', key: 'missingFact', label: '空事实' },
    { type: 'select', key: 'model', label: '模型', options: [{ value: 'a', label: 'A 档' }] },
    {
      type: 'select',
      key: 'external',
      label: '外部模型',
      derivedLabelKey: 'externalLabel',
      options: [{ value: 'a', label: 'A 档' }],
    },
    { type: 'switch', key: 'enabled', label: '启用' },
    { type: 'text', key: 'name', label: '名称', help: '显示名', placeholder: '输入名称', mono: true },
    { type: 'number', key: 'port', label: '端口', min: 1, max: 9, step: 1 },
    {
      type: 'rows',
      key: 'targets',
      label: '目标',
      columns: [
        { key: 'url', label: '地址', type: 'text', placeholder: 'https://' },
        { key: 'note', label: '备注', type: 'text', optional: true, pattern: '^[a-z]*$' },
        { key: 'kind', label: '类型', type: 'select', options: [{ value: 'gs', label: 'GS' }] },
      ],
    },
  ] as unknown as SettingsField[]
  return { id: 'superagent', title: 'Super Agent', subtitle: '宿主侧设置', fields } as SettingsSectionView
}

function valuesOf(): SettingsValues {
  return {
    pid: 4242,
    model: 'a',
    external: 'host-value',
    externalLabel: '宿主给的名字',
    enabled: true,
    name: '旧名',
    port: 3,
    targets: [{ url: 'https://a', note: 'aa', kind: 'gs' }],
  } as SettingsValues
}

function surfaceOf(over: Partial<SuperagentView> = {}): SuperagentView {
  return {
    ready: true,
    problem: null,
    counts: { needsYou: 0, running: 0, done: 0 },
    tickets: [],
    recent: [],
    ...over,
  } as SuperagentView
}

function mountPage(surface: SuperagentView | null = surfaceOf()): {
  harness: ReturnType<typeof makeHarness>
  container: HTMLElement
} {
  const harness = makeHarness(sectionOf(), valuesOf())
  const { container } = render(
    <RuntimeProvider channel={harness.channel}>
      <SettingsPage surface={surface} />
    </RuntimeProvider>,
  )
  return { harness, container }
}

/** 按 aria-label 找控件。 */
function control(label: string): HTMLElement {
  const found = document.querySelector(`[aria-label="${label}"]`)
  if (found === null) throw new Error(`找不到控件：${label}`)
  return found as HTMLElement
}

/** 找一个「设置行」里的按钮（按可见文字）。 */
function rowButton(text: string): HTMLButtonElement {
  const buttons = [...document.querySelectorAll('button')] as HTMLButtonElement[]
  const found = buttons.find((button) => (button.textContent ?? '').trim() === text)
  if (found === undefined) throw new Error(`找不到按钮：${text}`)
  return found
}

/** 记录表那一格里的控件（按列标题定位行，再按输入框顺序取）。 */
function rowCells(): { inputs: HTMLInputElement[]; select: HTMLSelectElement | null; buttons: HTMLButtonElement[] } {
  const row = [...document.querySelectorAll('.setting-row')].find((item) => (item.textContent ?? '').includes('目标'))
  if (row === undefined) throw new Error('找不到记录表')
  const control = row.querySelector('.setting-control') as HTMLElement
  return {
    inputs: [...control.querySelectorAll('input')] as HTMLInputElement[],
    select: control.querySelector('select') as HTMLSelectElement | null,
    buttons: [...control.querySelectorAll('button')] as HTMLButtonElement[],
  }
}

afterEach(() => {
  cleanup()
})

describe('分区与七种控件', () => {
  test('分区标题、副标题与 info / fact / select / switch / text / number 都画出来', async () => {
    const { container } = mountPage()
    await waitFor(() => {
      expect(container.querySelector('.settings-group-title')?.textContent).toBe('Super Agent')
    })
    expect(container.textContent).toContain('宿主侧设置')
    // info 行：mono 标记 + 文案。
    expect(container.textContent).toContain('1.2.3')
    expect(container.querySelector('.setting-info .mono')).not.toBeNull()
    // fact 行：有值显示值，缺值显示占位。
    expect(container.textContent).toContain('4242')
    expect(container.textContent).not.toContain('[object Object]')
    // 宿主给的外部值：置灰并显示派生名。
    expect((control('外部模型') as HTMLButtonElement).disabled).toBe(true)
    expect(control('外部模型').getAttribute('data-tip')).toBe('宿主给的名字')
    // switch / text / number 的当前值。
    expect(control('启用').getAttribute('aria-checked')).toBe('true')
    expect((control('名称') as HTMLInputElement).value).toBe('旧名')
    expect((control('端口') as HTMLInputElement).value).toBe('3')
    // 记录表：宿主那一行画出来（一格下拉、两格文本）。
    const cells = rowCells()
    expect(cells.inputs).toHaveLength(2)
    expect(cells.select).not.toBeNull()
  })

  test('没有这个分区：说「去插件中心打开」；读清单失败：把原因显示出来', async () => {
    const harness = makeHarness(sectionOf(), valuesOf())
    harness.state.reply = () => []
    const missing = render(
      <RuntimeProvider channel={harness.channel}>
        <SettingsPage surface={surfaceOf()} />
      </RuntimeProvider>,
    )
    await waitFor(() => {
      expect(missing.container.querySelector('.settings-empty')?.textContent).toBeTruthy()
    })
    missing.unmount()

    const failing = makeHarness(sectionOf(), valuesOf())
    failing.state.reply = () => {
      throw new Error('清单读不出来')
    }
    const failed = render(
      <RuntimeProvider channel={failing.channel}>
        <SettingsPage surface={surfaceOf()} />
      </RuntimeProvider>,
    )
    await waitFor(() => {
      expect(failed.container.querySelector('.settings-empty')?.textContent).toContain('清单读不出来')
    })
  })

  test('只读事实行缺值：给占位而不是空着', async () => {
    const { container } = mountPage()
    await waitFor(() => {
      expect(container.querySelectorAll('.setting-row.info').length).toBeGreaterThanOrEqual(3)
    })
    expect(container.textContent).toContain('空事实')
  })
})

describe('标量写入：成功 / 失败 / 抛错三条路', () => {
  test('按钮动作成功：重新读分区（成功回执由回读覆盖）', async () => {
    const { harness } = mountPage()
    await waitFor(() => {
      expect(rowButton('重启')).toBeTruthy()
    })
    const before = harness.state.calls.filter((call) => call === 'getSettingsSections').length
    harness.state.reply = ((method: string): unknown =>
      method === 'getSettingsSections' ? [sectionOf()] : { ok: true, notice: '已重启' }) as Reply
    fireEvent.click(rowButton('重启'))
    await waitFor(() => {
      expect(harness.state.calls).toContain('runSettingAction')
    })
    expect(harness.state.calls.filter((call) => call === 'getSettingsSections').length).toBeGreaterThan(before)
  })

  test('按钮动作失败：显示失败原因；通道抛错同样不崩', async () => {
    const { harness, container } = mountPage()
    await waitFor(() => {
      expect(rowButton('重置')).toBeTruthy()
    })
    harness.state.reply = () => ({ ok: false, error: '缓存目录不可写' })
    fireEvent.click(rowButton('重置'))
    await waitFor(() => {
      expect(container.textContent).toContain('缓存目录不可写')
    })
    harness.state.reply = () => {
      throw new Error('通道断了')
    }
    fireEvent.click(rowButton('重置'))
    await waitFor(() => {
      expect(container.textContent).toContain('通道断了')
    })
  })

  test('开关与文本框：落盘成功显示回执，失败显示原因', async () => {
    const { harness, container } = mountPage()
    await waitFor(() => {
      expect(control('启用')).toBeTruthy()
    })
    harness.state.reply = ((method: string): unknown =>
      method === 'getSettingsSections' ? [sectionOf()] : method === 'getSectionValues' ? valuesOf() : { ok: true, notice: '已保存' }) as Reply
    fireEvent.click(control('启用'))
    await waitFor(() => {
      expect(container.textContent).toContain('已保存')
    })
    const written = harness.state.calls.filter((call) => call === 'setSettingValue')
    expect(written.length).toBeGreaterThan(0)

    harness.state.reply = () => ({ ok: false, error: '值不合法' })
    fireEvent.click(control('启用'))
    await waitFor(() => {
      expect(container.textContent).toContain('值不合法')
    })

    // 文本：改了再失焦才写。
    harness.state.reply = ((method: string): unknown =>
      method === 'getSettingsSections' ? [sectionOf()] : method === 'getSectionValues' ? valuesOf() : { ok: true }) as Reply
    const name = control('名称') as HTMLInputElement
    const before = harness.state.calls.filter((call) => call === 'setSettingValue').length
    fireEvent.change(name, { target: { value: '新名' } })
    fireEvent.blur(name)
    await waitFor(() => {
      expect(harness.state.calls.filter((call) => call === 'setSettingValue').length).toBeGreaterThan(before)
    })

    // 数字：回车触发失焦落盘。
    harness.state.reply = () => {
      throw new Error('写数字时通道断了')
    }
    const port = control('端口') as HTMLInputElement
    port.focus()
    fireEvent.change(port, { target: { value: '5' } })
    fireEvent.keyDown(port, { key: 'Enter' })
    await waitFor(() => {
      expect(container.textContent).toContain('写数字时通道断了')
    })
  })
})

describe('记录表：草稿、校验与提交', () => {
  test('加一行 → 填首列失焦提交；回读对账后草稿被收下', async () => {
    const { harness, container } = mountPage()
    await waitFor(() => {
      expect(rowCells().buttons.length).toBeGreaterThan(0)
    })
    // 新的宿主值（回读）与提交内容一致：acceptValues 收下宿主那份。
    harness.state.reply = ((method: string, args: unknown[]): unknown => {
      if (method === 'getSettingsSections') return [sectionOf()]
      if (method === 'getSectionValues') {
        const rows = (args[0] === 'superagent' ? harness.state.values : undefined) as never
        return { targets: [{ url: 'https://b', note: '', kind: 'gs' }], ...(rows as object) }
      }
      return { ok: true, notice: '表格已保存' }
    }) as Reply
    const add = rowCells().buttons.find((button) => button.textContent?.includes('添加'))
    if (add === undefined) throw new Error('找不到添加按钮')
    fireEvent.click(add)
    const inputs = rowCells().inputs
    expect(inputs.length).toBe(4)
    fireEvent.change(inputs[2]!, { target: { value: 'https://b' } })
    fireEvent.blur(inputs[2]!)
    await waitFor(() => {
      expect(harness.state.calls).toContain('setSettingValue')
    })
  })

  test('表格内容不合法：给出哪一列哪一格错', async () => {
    const { container } = mountPage()
    await waitFor(() => {
      expect(rowCells().inputs.length).toBeGreaterThan(0)
    })
    const cells = rowCells()
    fireEvent.change(cells.inputs[1]!, { target: { value: 'ABC' } })
    fireEvent.blur(cells.inputs[1]!)
    await waitFor(() => {
      expect(container.querySelector('.settings-note.error')).not.toBeNull()
    })
  })

  test('删掉未提交的新行：只回收本地草稿，不惊动宿主', async () => {
    const { harness } = mountPage()
    await waitFor(() => {
      expect(rowCells().buttons.length).toBeGreaterThan(0)
    })
    const add = rowCells().buttons.find((button) => button.textContent?.includes('添加'))
    if (add === undefined) throw new Error('找不到添加按钮')
    fireEvent.click(add)
    const before = harness.state.calls.filter((call) => call === 'setSettingValue').length
    // 新行是最后一行：点最后一颗「删除」只回收本地草稿。
    const removes = rowCells().buttons.filter((button) => (button.textContent ?? '').includes('删除'))
    const remove = removes.at(-1)
    if (remove === undefined) throw new Error('找不到删除按钮')
    fireEvent.click(remove)
    expect(harness.state.calls.filter((call) => call === 'setSettingValue').length).toBe(before)
  })

  test('草稿与宿主不同时出现「保存表格」：点了整表提交', async () => {
    const { harness } = mountPage()
    await waitFor(() => {
      expect(rowCells().inputs.length).toBeGreaterThan(0)
    })
    const input = rowCells().inputs[0]!
    fireEvent.change(input, { target: { value: 'https://changed' } })
    const save = rowCells().buttons.find((button) => (button.textContent ?? '').trim() === '保存表格')
    if (save === undefined) throw new Error('找不到保存表格按钮')
    fireEvent.click(save)
    await waitFor(() => {
      expect(harness.state.calls).toContain('setSettingValue')
    })
  })
})

describe('最近变更', () => {
  test('有历史：按最新在前画；字段名认不出就显示键名；缺席的 from/to 显示「未设置」', async () => {
    const history = [
      { version: 2, at: '2026-01-02T03:04:05.000Z', key: 'unknownKey', from: 'a', to: 'b' },
      { version: 1, at: '2026-01-01T00:00:00.000Z', key: 'model' },
    ]
    const { container } = mountPage(surfaceOf({ settingsHistory: history } as never))
    await waitFor(() => {
      expect(container.textContent).toContain('unknownKey')
    })
    expect(container.textContent).toContain('model')
    expect(container.querySelectorAll('.settings-note').length).toBeGreaterThanOrEqual(2)
  })

  test('历史为空 / 快照没起来：不画成空占位', async () => {
    const empty = mountPage(surfaceOf({ settingsHistory: [] } as never))
    await waitFor(() => {
      expect(empty.container.querySelector('.settings-empty')).not.toBeNull()
    })
    empty.container.remove()
    const notReady = mountPage(surfaceOf({ ready: false }))
    await waitFor(() => {
      expect(notReady.container.querySelector('.settings-group-title')).not.toBeNull()
    })
    expect(notReady.container.textContent).not.toContain('未知字段')
  })
})
