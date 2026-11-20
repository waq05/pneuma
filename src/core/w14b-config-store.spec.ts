/**
 * `core/config-store.ts` 的缺口补齐：dsh 凭据库只读判定、思考档位校验、reasoning-effort 的
 * effortMap 写盘。
 *
 * 隔离：`homedir()` 被替换到临时目录（dsh 凭据的路径在 migrate 模块加载时算出来，必须提前换），
 * `DSC_HOME` 另指一个临时目录。真实 `~/.dsc` 与 `~/.dsh` 一个字节都不动。
 *
 * @module dsc/core/w14b-config-store.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

/** 假的家目录：`~/.dsh/.credentials.yaml` 落在这里。 */
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'dsc-w14b-home-'))
/** dsc 数据目录。 */
const DSC_HOME = mkdtempSync(join(tmpdir(), 'dsc-w14b-dsc-'))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})

process.env['DSC_HOME'] = DSC_HOME

type Store = typeof import('./config-store.js')
let store: Store

beforeAll(async () => {
  mkdirSync(join(FAKE_HOME, '.dsh'), { recursive: true })
  writeFileSync(join(FAKE_HOME, '.dsh', '.credentials.yaml'), 'refs:\n  DSH_ONLY_KEY: from-dsh\n  EMPTY_KEY: ""\n', 'utf8')
  store = await import('./config-store.js')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  for (const dir of [FAKE_HOME, DSC_HOME]) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

/** 一份最小合法草稿；模型能力字段由用例自己加。 */
function draft(overrides: Record<string, unknown> = {}) {
  return {
    oldName: null,
    name: 'demo',
    displayName: '演示',
    baseUrl: 'http://127.0.0.1:1234/v1/',
    models: [{ id: 'm', name: 'm', contextWindow: 1000, maxTokens: 100 }],
    ...overrides,
  } as Parameters<typeof store.upsertProvider>[1]
}

describe('dsh 凭据库（只读）', () => {
  test('值是字符串才认；空串与缺键都不算有 key', () => {
    expect(store.keyAvailable('DSH_ONLY_KEY')).toBe(true)
    // 只读判定：dsh 文件里的空值不算有 key，也不去写它。
    expect(store.keyAvailable('EMPTY_KEY')).toBe(false)
    expect(store.keyAvailable('NOT_IN_DSH')).toBe(false)
  })
})

describe('validateDraft 的思考档位', () => {
  test('没勾任何档位又要求发思考字段：报错', () => {
    expect(() =>
      store.validateDraft(
        draft({ models: [{ id: 'm', contextWindow: 1, maxTokens: 1, thinkingParam: 'thinking', thinkingLevels: [] }] }),
      ),
    ).toThrow(/没勾任何思考档位/)
  })

  test('档位字段选 none 时允许空档位', () => {
    expect(() =>
      store.validateDraft(
        draft({ models: [{ id: 'm', contextWindow: 1, maxTokens: 1, thinkingParam: 'none', thinkingLevels: [] }] }),
      ),
    ).not.toThrow()
  })
})

describe('toFileModel：reasoning-effort 写 effortMap', () => {
  test('只写显式给了值的档位，null 也照写；偏离缺省的字段才落盘', () => {
    store.writeConfigDoc({ providers: {} })
    const name = store.upsertProvider(
      null,
      draft({
        models: [
          {
            id: 'm',
            name: 'm',
            contextWindow: 1000,
            maxTokens: 100,
            thinkingLevels: ['low', 'high'],
            thinkingParam: 'reasoning-effort',
            effortMap: { low: 'low-effort', high: null },
          },
        ],
      }),
    )
    expect(name).toBe('demo')
    const model = store.readConfigDoc().providers.demo?.models?.[0]
    expect(model).toMatchObject({
      id: 'm',
      contextWindow: 1000,
      maxTokens: 100,
      thinkingLevels: ['low', 'high'],
      thinkingParam: 'reasoning-effort',
      effortMap: { low: 'low-effort', high: null },
    })
  })
})
