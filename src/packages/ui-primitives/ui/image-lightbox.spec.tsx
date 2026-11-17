/**
 * 待发贴图「点一下看大图」的浮层组件出口（ui 层）。
 *
 * 来源：`scripts/ui-attach-preview-test.mjs` 第 [2] 段（基元库真的把 ImageLightbox 转出）。
 * 原探针说「漏一行的表现是插件拿到的 `ImageLightbox` 是 undefined」——这正好是能**行为化**
 * 的那条：import 基元库的桶文件，断言名字真的在上面（方案 A：断言导出对象）。别的插件经
 * `@dsc/ui-primitives` 拿到的就是这份桶，少一行 `export *` 时这里当场红。
 *
 * 渲染半边（组件渲染批补上）：第 [1] 段的门户 / Esc / 点根关 / 焦点归还——全是可观察
 * 行为，真渲染 `ImageLightbox` 直接从 DOM 验。第 [3][4][5] 段（`ui.tsx` 的按钮接法与负向
 * 钉、`.attach-zoom` 样式、视频分支形状）是 composer 输入区私有组件的源码形状与 CSS 文本钉，
 * 渲染接缝归缺口清单（composer 输入区组件未导出、jsdom 不吃样式表）。
 *
 * @module dsc-ui-primitives/ui/image-lightbox.spec
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import * as primitives from './index.js'
import { ImageLightbox } from './image-lightbox.js'

test('模块导出 ImageLightbox（是个组件函数）', () => {
  expect(typeof ImageLightbox).toBe('function')
})

test('基元库的桶文件把 ImageLightbox 转出（插件经 @dsc/ui-primitives 拿到的就是它）', () => {
  expect(primitives.ImageLightbox).toBe(ImageLightbox)
})

// ── 渲染半边：浮层的行为面（portal / Esc / 点根关 / 焦点归还） ────────────────

afterEach(() => {
  cleanup()
  // portal 挂在 document.body 上，卸载后要摘干净（下一格用例才不会读到上一格的浮层）。
  document.querySelectorAll('.img-lightbox').forEach((node) => node.remove())
})

test('浮层经 portal 挂到 body：role/aria 齐、图片带 alt（读屏拿得到名字）', () => {
  const page = render(<ImageLightbox src="data:image/png;base64,AAA" alt="shot.png" onClose={() => undefined} />)
  // 组件自身渲染 null（portal 出去了）：container 里没有它，body 上才有。
  expect(page.container.querySelector('.img-lightbox')).toBeNull()
  const box = document.querySelector('.img-lightbox') as HTMLElement
  expect(box.getAttribute('role')).toBe('dialog')
  expect(box.getAttribute('aria-modal')).toBe('true')
  expect(box.getAttribute('aria-label')).not.toBe('')
  const img = box.querySelector('img') as HTMLImageElement
  expect(img.getAttribute('src')).toBe('data:image/png;base64,AAA')
  expect(img.getAttribute('alt')).toBe('shot.png')
})

test('点根节点就关（点图、点遮罩都关：图不拦事件）', () => {
  const onClose = vi.fn()
  render(<ImageLightbox src="data:image/png;base64,AAA" alt="a" onClose={onClose} />)
  fireEvent.click(document.querySelector('.img-lightbox') as HTMLElement)
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('Esc 关；卸载时把监听摘掉（再按 Esc 不再误关别的东西）', () => {
  const onClose = vi.fn()
  const page = render(<ImageLightbox src="data:image/png;base64,AAA" alt="a" onClose={onClose} />)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
  page.unmount()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('关闭时把焦点还给打开它的那个节点（只在节点还连着文档时）', async () => {
  // 借真实 DOM 造一个「打开浮层前的焦点」：按钮聚焦 → 挂浮层 → 卸载 → 焦点回到按钮。
  const opener = document.createElement('button')
  document.body.appendChild(opener)
  opener.focus()
  expect(document.activeElement).toBe(opener)
  const page = render(<ImageLightbox src="data:image/png;base64,AAA" alt="a" onClose={() => undefined} />)
  await waitFor(() => expect(document.querySelector('.img-lightbox')).not.toBeNull())
  page.unmount()
  expect(document.activeElement).toBe(opener)
  opener.remove()
})

test('浮层开着时焦点节点被移除（上传失败把缩略图摘了）→ 卸载不抛、焦点不还死人', async () => {
  const opener = document.createElement('button')
  document.body.appendChild(opener)
  opener.focus()
  const page = render(<ImageLightbox src="data:image/png;base64,AAA" alt="a" onClose={() => undefined} />)
  await waitFor(() => expect(document.querySelector('.img-lightbox')).not.toBeNull())
  opener.remove()
  expect(() => page.unmount()).not.toThrow()
})
