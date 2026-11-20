/**
 * `core/prefs.ts` 的补测（W14）：读档时几条「手改坏 / 旧版本残留」的归一分支。
 *
 * `DSC_SETTINGS_JSON` 是模块顶层常量，所以先改 `DSC_HOME` 再动态 import，把
 * settings.json 落到临时目录（真实 `~/.dsc` 一个字节都不会碰）。
 *
 * 覆盖的明细行：64-65（源清单与旧出厂默认长度相同但内容不同：`every` 的逐项判据）、
 * 425-427（workspaceAliases 里非字符串跳过 + 空白归一 + 空别名丢弃）、
 * 496-499（sessionOrder 非数组跳过、过滤空串、封顶）、524-525（旧档 `ai-review`
 * 落成「完全访问 + AI 复核」）。
 *
 * @module dsc/core/w14-prefs.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { createTempDir } from '../../tests/support/tmp-dir.js'

const HOME = createTempDir('dsc-w14-prefs-')
const DSC_HOME = join(HOME, '.dsc')
const originalHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = DSC_HOME
mkdirSync(DSC_HOME, { recursive: true })

const { DSC_SETTINGS_JSON, readPrefs } = await import('./prefs.js')

afterAll(() => {
  if (originalHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = originalHome
})

/** 把一份 settings.json 写进临时 DSC_HOME（一次性用例用，后写的覆盖前面的）。 */
function writeSettings(doc: unknown): void {
  writeFileSync(DSC_SETTINGS_JSON, JSON.stringify(doc), 'utf8')
}

describe('prefs 读档归一', () => {
  test('settings.json 落在临时 DSC_HOME 里（不碰真实用户目录）', () => {
    expect(DSC_SETTINGS_JSON.startsWith(DSC_HOME)).toBe(true)
  })

  test('源清单与旧出厂默认一样长但内容不同：按用户自定义保留', () => {
    writeSettings({
      marketSources: [
        { name: '私有源', url: 'https://example.invalid/a' },
        { name: '另一个', url: 'https://example.invalid/b' },
      ],
    })
    const prefs = readPrefs()
    expect(prefs.marketSources).toEqual([
      { name: '私有源', url: 'https://example.invalid/a' },
      { name: '另一个', url: 'https://example.invalid/b' },
    ])
  })

  test('workspaceAliases：非字符串跳过，空白压缩并去首尾，空别名不登记', () => {
    writeSettings({
      ui: {
        workspaceAliases: {
          'D:\\work\\a': '  两个   词  ',
          'D:\\work\\b': 42,
          'D:\\work\\c': '   ',
        },
      },
    })
    const prefs = readPrefs()
    expect(prefs.ui.workspaceAliases['D:\\work\\a']).toBe('两个 词')
    expect(prefs.ui.workspaceAliases['D:\\work\\b']).toBeUndefined()
    expect(prefs.ui.workspaceAliases['D:\\work\\c']).toBeUndefined()
  })

  test('sessionOrder：非数组的整项跳过，空串过滤，正常项照收', () => {
    writeSettings({
      ui: {
        sessionOrder: {
          'D:\\work\\a': ['id-1', '', 7, 'id-2'],
          'D:\\work\\b': '不是数组',
        },
      },
    })
    const prefs = readPrefs()
    expect(prefs.ui.sessionOrder['D:\\work\\a']).toEqual(['id-1', 'id-2'])
    expect(prefs.ui.sessionOrder['D:\\work\\b']).toBeUndefined()
  })

  test('旧档 defaultPolicy: ai-review 落成完全访问 + AI 复核', () => {
    writeSettings({ defaultPolicy: 'ai-review' })
    const prefs = readPrefs()
    expect(prefs.defaultPolicy).toBe('full-access')
    expect(prefs.defaultReviewer).toBe('auto-review')
  })
})
