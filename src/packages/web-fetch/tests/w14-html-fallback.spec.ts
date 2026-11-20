/**
 * web-fetch 的 w14 补测：`renderBody` 的转换兜底——turndown 递归吐 RangeError
 * （畸形标记把递归走爆栈）时交回「整段略去」，不把原始标记递出去。
 *
 * 这条分支只有转换器自己抛错才走得到，所以把 `turndown` 换成会抛 RangeError 的替身；
 * 本文件单独一个 spec，不影响 `w14-gaps.spec.ts` 与 `html.spec.ts` 里的真转换器。
 *
 * @module dsc/packages/web-fetch/tests/w14-html-fallback
 */
import { expect, test, vi } from 'vitest'

vi.mock('turndown', () => ({
  default: class FakeTurndown {
    use(): void {
      // 插件注册在替身上无意义
    }

    addRule(): void {
      // 自定义规则同样不参与转换
    }

    turndown(): string {
      throw new RangeError('Maximum call stack size exceeded')
    }
  },
}))

const { renderBody } = await import('../html.js')

const OMITTED = '[这段 HTML 没能安全转换成 Markdown，已整段略去。]'

test('转换器抛 RangeError：交回固定话术，源被切过时 sourceTruncated 照实标', () => {
  expect(renderBody('html', '<p>正文</p>', 10_000)).toEqual({ text: OMITTED, sourceTruncated: false })
  expect(renderBody('html', '<p>很长的正文</p>', 5)).toEqual({ text: OMITTED, sourceTruncated: true })
})
