/**
 * web-fetch 的 w14 补测：插件卸载时的三个退订，以及 `findRawTextEnd` 遇到
 * `</scriptfoo>` 这种别名闭合标签时的循环（标签边界判定）。
 *
 * 与 `index.spec.ts` 同一套假 ctx；`DSC_HOME` 指临时目录，插件配置只落那里。
 *
 * @module dsc/packages/web-fetch/tests/w14-gaps
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { exceedsConversionDepth, renderBody } from '../html.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-web-fetch-w14-'))
process.env['DSC_HOME'] = HOME

type WebFetchModule = typeof import('../index.js')
let webFetchPlugin: WebFetchModule['webFetchPlugin']

beforeAll(async () => {
  const policy = await import('@pneuma/runtime/core/path-policy.js')
  expect(policy.DSC_HOME).toBe(HOME)
  webFetchPlugin = (await import('../index.js')).webFetchPlugin
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // 临时目录留给系统清
  }
})

test('插件卸载：工具、提示段、设置分区三个退订都被调用一次', () => {
  mkdirSync(HOME, { recursive: true })
  const offs: string[] = []
  const ctx = {
    tools: {
      register: () => () => {
        offs.push('tool')
      },
    },
    prompt: {
      register: () => () => {
        offs.push('prompt')
      },
    },
    settings: {
      registerSection: () => () => {
        offs.push('section')
      },
    },
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => undefined
    },
  }
  const dispose = webFetchPlugin.apply?.(ctx as unknown as Context, undefined) as (() => void) | undefined
  expect(typeof dispose).toBe('function')
  dispose?.()
  expect(offs).toEqual(['tool', 'prompt', 'section'])
})

test('raw-text 闭合标签认边界：</scriptfoo> 不算结尾，脚本正文里的尖括号不被当标签', () => {
  // 第一个 `</script` 后面跟的是 f，不是 > / 空白：跳过它，继续找真正的 `</script>`。
  const html = '<script></scriptfoo></script><p>正文</p>'
  expect(exceedsConversionDepth(html)).toBe(false)
  expect(renderBody('html', html, 10_000).text).toContain('正文')
})
