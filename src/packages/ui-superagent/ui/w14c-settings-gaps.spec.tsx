/**
 * Super Agent 设置页剩余出口的补测（W14 重 harness 面）。
 *
 * 覆盖目标（对照 W14 缺口清单 `ui-superagent/ui/settings.tsx`）：
 *  - 正则写坏的校验列按通过处理（68）；
 *  - 半成品行交给宿主前的键值查找与「保留用户没填完的行」（124-125 / 174）；
 *  - 回读失败、整表保存失败 / 通道抛错三条错误出口（189 / 252 / 261-262）；
 *  - 记录表里的下拉单元格改动（636-638）、文本格回车失焦（666）、删掉宿主已有的行（682）。
 *
 * 假通道与 `w12-settings.spec` 同形：`getSettingsSections` / `getSectionValues` /
 * `setSettingValue` 三个方法按用例换回答，其余方法不触发。
 *
 * @module dsc-ui-superagent/ui/w14c-settings-gaps.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { SettingsField, SettingsSectionView, SettingsValues } from '@dsc/ui'
import { SettingsPage } from './settings.js'
import type { SuperagentView } from './state.js'

type Reply = (method: string, args: unknown[]) => unknown

interface Harness {
  channel: HostChannel
  state: { reply: Reply; values: SettingsValues; calls: Array<{ method: string; args: unknown[] }> }
}

function makeHarness(section: SettingsSectionView, values: SettingsValues): Harness {
  const state: Harness['state'] = {
    values,
    calls: [],
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
      state.calls.push({ method, args })
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

/** 记录表要用到的列：文本列按需给 `pattern` / `optional`。 */
type RowColumn = Extract<SettingsField, { type: 'rows' }>['columns'][number]

/** 一个只放记录表的分区（各用例按自己需要的列形状拼）。 */
function rowsSection(columns: RowColumn[], over: Partial<SettingsSectionView> = {}): SettingsSectionView {
  const fields = [
    { type: 'switch', key: 'enabled', label: '启用' },
    { type: 'rows', key: 'targets', label: '目标', columns },
  ] as unknown as SettingsField[]
  return { id: 'superagent', title: 'Super Agent', subtitle: '', fields, ...over } as SettingsSectionView
}

function valuesOf(targets: Array<Record<string, string>>): SettingsValues {
  return { enabled: true, targets } as SettingsValues
}

const surfaceOf = (): SuperagentView =>
  ({ ready: true, problem: null, counts: { needsYou: 0, running: 0, done: 0 }, tickets: [], recent: [] }) as SuperagentView

function mount(section: SettingsSectionView, values: SettingsValues): { harness: Harness; container: HTMLElement } {
  const harness = makeHarness(section, values)
  const { container } = render(
    <RuntimeProvider channel={harness.channel}>
      <SettingsPage surface={surfaceOf()} />
    </RuntimeProvider>,
  )
  return { harness, container }
}

/** 记录表那一格里的控件。 */
function rowCells(): { inputs: HTMLInputElement[]; selects: HTMLSelectElement[]; buttons: HTMLButtonElement[] } {
  const row = [...document.querySelectorAll('.setting-row')].find((item) => (item.textContent ?? '').includes('目标'))
  if (row === undefined) throw new Error('找不到记录表')
  const control = row.querySelector('.setting-control') as HTMLElement
  return {
    inputs: [...control.querySelectorAll('input')] as HTMLInputElement[],
    selects: [...control.querySelectorAll('select')] as HTMLSelectElement[],
    buttons: [...control.querySelectorAll('button')] as HTMLButtonElement[],
  }
}

function rowButton(text: string): HTMLButtonElement {
  const buttons = [...document.querySelectorAll('button')] as HTMLButtonElement[]
  const found = buttons.find((button) => (button.textContent ?? '').trim() === text)
  if (found === undefined) throw new Error(`找不到按钮：${text}`)
  return found
}

const writes = (harness: Harness): number => harness.state.calls.filter((call) => call.method === 'setSettingValue').length
const reads = (harness: Harness): number => harness.state.calls.filter((call) => call.method === 'getSectionValues').length

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ── 68：正则写坏的校验列按通过处理 ─────────────────────────────────────────

describe('校验列的正则写坏', () => {
  test('pattern 不是合法正则：new RegExp 抛错被吞，按通过处理并照常提交（68）', async () => {
    const columns = [
      { key: 'url', label: '地址', type: 'text' },
      { key: 'note', label: '备注', type: 'text', pattern: '[' },
    ] as unknown as RowColumn[]
    const { harness } = mount(rowsSection(columns), valuesOf([{ url: 'https://a', note: 'aa' }]))
    await waitFor(() => expect(rowCells().inputs.length).toBeGreaterThan(0))
    const note = rowCells().inputs[1] as HTMLInputElement
    const before = writes(harness)
    fireEvent.change(note, { target: { value: '随便写' } })
    fireEvent.blur(note)
    await waitFor(() => expect(writes(harness)).toBeGreaterThan(before))
    // 没被当成格式错误拦下来：底部没有 error 提示。
    expect(document.querySelector('.settings-note.error')).toBeNull()
  })
})

// ── 124-125 / 174：半成品行的去留 ──────────────────────────────────────────

describe('半成品行与本地草稿', () => {
  test('新加的半成品行（首列有值、必填列空）不交宿主，按首列键去宿主的旧行里找（124-125）', async () => {
    const columns = [
      { key: 'url', label: '地址', type: 'text' },
      { key: 'note', label: '备注', type: 'text' },
    ] as unknown as RowColumn[]
    const { harness } = mount(rowsSection(columns), valuesOf([{ url: 'https://a', note: 'aa' }]))
    await waitFor(() => expect(rowCells().inputs.length).toBeGreaterThan(0))
    // 加一行，只填首列：这一行没填满，不该被交出去。
    fireEvent.click(rowButton('添加一行'))
    const inputs = rowCells().inputs
    fireEvent.change(inputs[2] as HTMLInputElement, { target: { value: 'https://new' } })
    // 改动宿主已有行的备注并失焦 → 整表提交，走 rowsForHost。
    fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: 'bb' } })
    fireEvent.blur(inputs[1] as HTMLInputElement)
    await waitFor(() => expect(writes(harness)).toBeGreaterThan(0))
    const payload = harness.state.calls.find((call) => call.method === 'setSettingValue')?.args[2] as Array<
      Record<string, string>
    >
    expect(payload).toEqual([{ url: 'https://a', note: 'bb' }])
  })

  test('本地草稿与宿主回读不一致：保留草稿，不按宿主那份收（174）', async () => {
    const columns = [
      { key: 'url', label: '地址', type: 'text' },
      { key: 'note', label: '备注', type: 'text', optional: true },
    ] as unknown as RowColumn[]
    const { harness } = mount(rowsSection(columns), valuesOf([{ url: 'https://a', note: 'aa' }]))
    await waitFor(() => expect(rowCells().inputs.length).toBeGreaterThan(0))
    // 只改草稿不提交：本地表与宿主那份不同。
    fireEvent.change(rowCells().inputs[1] as HTMLInputElement, { target: { value: '草稿' } })
    // 用标量写入触发一次回读：acceptValues 按「不一致就留草稿」处理。
    fireEvent.click(document.querySelector('[aria-label="启用"]') as HTMLElement)
    await waitFor(() => expect(reads(harness)).toBeGreaterThan(0))
    expect((rowCells().inputs[1] as HTMLInputElement).value).toBe('草稿')
  })
})

// ── 189：回读失败 ──────────────────────────────────────────────────────────

describe('回读失败', () => {
  test('getSectionValues 拒绝：把原因显示出来，不崩（189）', async () => {
    const columns = [{ key: 'url', label: '地址', type: 'text' }] as unknown as RowColumn[]
    const { harness, container } = mount(rowsSection(columns), valuesOf([{ url: 'https://a' }]))
    await waitFor(() => expect(rowCells().inputs.length).toBeGreaterThan(0))
    harness.state.reply = ((method: string): unknown => {
      if (method === 'getSettingsSections') return [rowsSection(columns)]
      if (method === 'getSectionValues') throw new Error('读值通道断了')
      return { ok: true }
    }) as Reply
    fireEvent.click(document.querySelector('[aria-label="启用"]') as HTMLElement)
    await waitFor(() => expect(container.textContent).toContain('读值通道断了'))
  })
})

// ── 252 / 261-262：整表保存的失败与抛错 ────────────────────────────────────

describe('整表保存的失败出口', () => {
  test('保存表格返回 ok:false：显示失败原因（252）', async () => {
    const columns = [{ key: 'url', label: '地址', type: 'text' }] as unknown as RowColumn[]
    const { harness, container } = mount(rowsSection(columns), valuesOf([{ url: 'https://a' }]))
    await waitFor(() => expect(rowCells().inputs.length).toBeGreaterThan(0))
    fireEvent.change(rowCells().inputs[0] as HTMLInputElement, { target: { value: 'https://changed' } })
    harness.state.reply = ((method: string): unknown => {
      if (method === 'getSettingsSections') return [rowsSection(columns)]
      if (method === 'getSectionValues') return valuesOf([{ url: 'https://a' }])
      if (method === 'setSettingValue') return { ok: false, error: '表格不合法' }
      return { ok: true }
    }) as Reply
    fireEvent.click(rowButton('保存表格'))
    await waitFor(() => expect(container.textContent).toContain('表格不合法'))
  })

  test('通道抛错：显示原因并再回读一次（261-262）', async () => {
    const columns = [{ key: 'url', label: '地址', type: 'text' }] as unknown as RowColumn[]
    const { harness, container } = mount(rowsSection(columns), valuesOf([{ url: 'https://a' }]))
    await waitFor(() => expect(rowCells().inputs.length).toBeGreaterThan(0))
    fireEvent.change(rowCells().inputs[0] as HTMLInputElement, { target: { value: 'https://changed' } })
    harness.state.reply = ((method: string): unknown => {
      if (method === 'getSettingsSections') return [rowsSection(columns)]
      if (method === 'getSectionValues') return valuesOf([{ url: 'https://a' }])
      throw new Error('写表通道断了')
    }) as Reply
    const before = reads(harness)
    fireEvent.click(rowButton('保存表格'))
    await waitFor(() => expect(container.textContent).toContain('写表通道断了'))
    // catch 里补的一次回读：读值次数涨了。
    await waitFor(() => expect(reads(harness)).toBeGreaterThan(before))
  })
})

// ── 636-638 / 666 / 682：记录表的三个格子动作 ──────────────────────────────

describe('记录表格子与删行', () => {
  const columns = [
    { key: 'url', label: '地址', type: 'text' },
    { key: 'note', label: '备注', type: 'text', optional: true },
    {
      key: 'kind',
      label: '类型',
      type: 'select',
      options: [
        { value: 'gs', label: 'GS' },
        { value: 'fs', label: 'FS' },
      ],
    },
  ] as unknown as RowColumn[]

  test('下拉单元格改动：落草稿并顺手提交（636-638）', async () => {
    const { harness } = mount(rowsSection(columns), valuesOf([{ url: 'https://a', note: '', kind: 'gs' }]))
    await waitFor(() => expect(rowCells().selects.length).toBeGreaterThan(0))
    const before = writes(harness)
    fireEvent.change(rowCells().selects[0] as HTMLSelectElement, { target: { value: 'fs' } })
    await waitFor(() => expect(writes(harness)).toBeGreaterThan(before))
  })

  test('文本格按回车：触发失焦并提交（666）', async () => {
    const { harness } = mount(rowsSection(columns), valuesOf([{ url: 'https://a', note: '', kind: 'gs' }]))
    await waitFor(() => expect(rowCells().inputs.length).toBeGreaterThan(0))
    const input = rowCells().inputs[1] as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: '备注' } })
    const before = writes(harness)
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(writes(harness)).toBeGreaterThan(before))
  })

  test('删掉宿主已有的一行：交上去的表不含它，整表提交（682）', async () => {
    const { harness } = mount(
      rowsSection(columns),
      valuesOf([
        { url: 'https://a', note: '', kind: 'gs' },
        { url: 'https://b', note: '', kind: 'fs' },
      ]),
    )
    await waitFor(() => expect(rowCells().inputs.length).toBeGreaterThan(0))
    const before = writes(harness)
    const removes = rowCells().buttons.filter((button) => (button.textContent ?? '').includes('删除'))
    fireEvent.click(removes.at(-1) as HTMLButtonElement)
    await waitFor(() => expect(writes(harness)).toBeGreaterThan(before))
    const payload = harness.state.calls.find((call) => call.method === 'setSettingValue')?.args[2] as Array<
      Record<string, string>
    >
    expect(payload.map((row) => row['url'])).toEqual(['https://a'])
  })
})
