/**
 * PDF 视图的补盲（`packages/ui-primitives/ui/pdf-view.tsx`）：逐页渲染管线。
 *
 * jsdom 里没有 pdfjs 也没有 canvas 解码，所以把 `pdfjs-dist` 与 worker 资产换成可控替身，
 * 组件本身真挂载、真跑 effect：断言页数、`<img>` 数量、超过 50 页的截断提示，以及
 * 「卸载后不再 setState」的取消路径。
 *
 * @module dsc/packages/ui-primitives/ui/w12-pdf-view.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

/** 假的 pdfjs 模块：每次 getDocument 返回同一份文档。 */
const pdfMock = vi.hoisted(() => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: '' },
}))

vi.mock('pdfjs-dist', () => pdfMock)
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'worker-asset.js' }))

import { PdfView } from './pdf-view.js'

interface FakePage {
  getViewport(): { width: number; height: number }
  render(): { promise: Promise<void> }
}

/** 造一份假文档：`numPages` 页，每页渲染立刻完成。 */
function fakeDocument(numPages: number): { numPages: number; getPage: (index: number) => Promise<FakePage> } {
  return {
    numPages,
    getPage: async () => ({
      getViewport: () => ({ width: 100, height: 200 }),
      render: () => ({ promise: Promise.resolve() }),
    }),
  }
}

let toDataUrlCalls: number

beforeEach(() => {
  toDataUrlCalls = 0
  pdfMock.GlobalWorkerOptions.workerSrc = ''
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
    toDataUrlCalls += 1
    return `data:image/png;base64,p${toDataUrlCalls}`
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  pdfMock.getDocument.mockReset()
})

describe('逐页渲染', () => {
  test('每页画成一张 <img>，worker 地址写进 GlobalWorkerOptions', async () => {
    pdfMock.getDocument.mockReturnValue({ promise: Promise.resolve(fakeDocument(3)) })
    const { container } = render(<PdfView base64="JVBERi0xLjQK" />)
    await waitFor(() => {
      expect(container.querySelectorAll('img.file-pdf-page')).toHaveLength(3)
    })
    expect(pdfMock.GlobalWorkerOptions.workerSrc).toBe('worker-asset.js')
    const images = [...container.querySelectorAll('img.file-pdf-page')]
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      'data:image/png;base64,p1',
      'data:image/png;base64,p2',
      'data:image/png;base64,p3',
    ])
    expect(images[0]!.getAttribute('alt')).toBeTruthy()
  })

  test('超过 50 页：只渲染前 50 页并给截断提示', async () => {
    pdfMock.getDocument.mockReturnValue({ promise: Promise.resolve(fakeDocument(51)) })
    const { container } = render(<PdfView base64="JVBERi0xLjQK" />)
    await waitFor(() => {
      expect(container.querySelectorAll('img.file-pdf-page')).toHaveLength(50)
    })
    const note = container.querySelector('[data-tree-note="truncated"]')
    expect(note).not.toBeNull()
    expect(note!.textContent).toBeTruthy()
  })

  test('渲染中先给「正在渲染」占位，失败时给失败文案', async () => {
    let reject!: (error: Error) => void
    pdfMock.getDocument.mockReturnValue({
      promise: new Promise((_resolve, fail) => {
        reject = fail
      }),
    })
    const { container } = render(<PdfView base64="JVBERi0xLjQK" />)
    expect(container.querySelectorAll('img.file-pdf-page')).toHaveLength(0)
    expect(container.innerHTML).toContain('file-preview-empty')
    reject(new Error('坏文件'))
    await waitFor(() => {
      expect(container.textContent).toContain('坏文件')
    })
  })

  test('挂载中途卸载：不再 setPages（避免已卸载组件更新）', async () => {
    let resolveDoc!: (doc: ReturnType<typeof fakeDocument>) => void
    pdfMock.getDocument.mockReturnValue({
      promise: new Promise((resolve) => {
        resolveDoc = resolve
      }),
    })
    const { container, unmount } = render(<PdfView base64="JVBERi0xLjQK" />)
    unmount()
    resolveDoc(fakeDocument(2))
    await Promise.resolve()
    expect(container.querySelectorAll('img.file-pdf-page')).toHaveLength(0)
  })
})
