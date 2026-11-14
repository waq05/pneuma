/**
 * 待发贴图「点一下看大图」的浮层组件出口（ui 层）。
 *
 * 来源：`scripts/ui-attach-preview-test.mjs` 第 [2] 段（基元库真的把 ImageLightbox 转出）。
 * 原探针说「漏一行的表现是插件拿到的 `ImageLightbox` 是 undefined」——这正好是能**行为化**
 * 的那条：import 基元库的桶文件，断言名字真的在上面（方案 A：断言导出对象）。别的插件经
 * `@dsc/ui-primitives` 拿到的就是这份桶，少一行 `export *` 时这里当场红。
 *
 * 不迁的部分（原探针）：第 [1][3][4][5] 段——`image-lightbox.tsx` 的门户 / Esc / 焦点归还、
 * `ui.tsx` 的按钮接法与负向钉（不许 `<a href={previewUrl}>`）、`.attach-zoom` 样式、视频分支
 * 的形状——全部要真渲染组件（或 CSS 比对）才有行为接缝，归组件渲染批（缺口清单）。
 *
 * @module dsc-ui-primitives/ui/image-lightbox.spec
 */
import { expect, test } from 'vitest'
import * as primitives from './index.js'
import { ImageLightbox } from './image-lightbox.js'

test('模块导出 ImageLightbox（是个组件函数）', () => {
  expect(typeof ImageLightbox).toBe('function')
})

test('基元库的桶文件把 ImageLightbox 转出（插件经 @dsc/ui-primitives 拿到的就是它）', () => {
  expect(primitives.ImageLightbox).toBe(ImageLightbox)
})
