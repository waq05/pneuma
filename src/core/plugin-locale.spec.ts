/**
 * 插件清单本地化的单元用例（迁自 `scripts/plugin-locale-test.mjs` 的第 [1]–[4] 段）。
 *
 * 用户要求：`numa plugin list` 与插件中心能按语言显示标题与说明，只本地化清单里给用户看的
 * 那两行字（`pneuma.title` / `pneuma.description`）。做法：每个包带一份 `locale/en.json`，
 * 读取端先查译本、没译过回落清单原文；语言从 `config.yaml` 的 `language` 来，只分 `en`
 * 与「其余（含中文）」两档。
 *
 * ## 为什么是 unit 而不是 integration
 *
 * 被测的是 `src/core/plugin-locale.ts` 的纯逻辑：语言怎么读、译本怎么回落、缓存怎么算。
 * 这些不需要内核——起内核只会把「装配」混进「取值」。**接线**那一半（loader 与 CLI 是否
 * 真的用了这条路径）是另一回事，已换成行为断言放在
 * `tests/integration/plugin-locale.int.spec.ts`；原探针第 [5] 段的 5 条源码文本断言因此
 * 没有搬（迁移手册第 2 节：文本断言改引号就假红、逻辑改坏但留着字面量就假绿）。
 *
 * ## 隔离
 *
 * `tempHome()` 必须在 `config.ts` / `path-policy.ts` 被加载之前调用：`DSC_HOME` 是模块
 * 顶层常量（`src/core/path-policy.ts:23`）。所以本文件里这两块一律 `await import()`。
 *
 * @module dsc/core/plugin-locale.spec
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { tempHome } from '../../tests/harness.js'

/** 临时主目录；`DSC_HOME` 由它派生，配置与假包都落在这里。 */
const home = tempHome('dsc-plugin-locale-')
/** 仓库里的包目录：第 [1] 段要逐个核对每份清单与译本。 */
const PACKAGES_DIR = fileURLToPath(new URL('../packages/', import.meta.url))
/** 临时 `config.yaml`。 */
const CONFIG_FILE = join(home.home, '.dsc', 'config.yaml')

/** 一份只有 providers 的合法配置（没有 `language` 键 = 没配语言）。 */
const PLAIN_CONFIG =
  'default:\n  provider: p\n  model: m\nproviders:\n  p:\n    baseURL: http://127.0.0.1:1/v1\n' +
  '    apiKeyEnv: LOCALE_TEST_KEY\n    models:\n      - id: m\n        name: m\n'

/** 被测模块：`beforeAll` 里加载，保证 HOME 已经换好。 */
let config: typeof import('./config.js')
let locale: typeof import('./plugin-locale.js')

/** 写一份 `config.yaml`；没有 `language` 键就是「没配语言」。 */
function writeConfig(body: string): void {
  writeFileSync(CONFIG_FILE, body, 'utf8')
}

/** 读一个真包的清单（与内核用的就是同一份文件）。 */
function manifestOf(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PACKAGES_DIR, id, 'package.json'), 'utf8')) as Record<string, unknown>
}

/** 造一个只有清单（可带译本）的假包目录。 */
function makePackage(name: string, title: string, description: string, locale: unknown): string {
  const dir = join(home.home, 'pkgs', name)
  mkdirSync(join(dir, 'locale'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: `@pneuma/${name}`, pneuma: { title, description } }, null, 2)}\n`,
    'utf8',
  )
  if (locale === undefined) rmSync(join(dir, 'locale'), { recursive: true, force: true })
  else writeFileSync(join(dir, 'locale', 'en.json'), typeof locale === 'string' ? locale : `${JSON.stringify(locale, null, 2)}\n`, 'utf8')
  return dir
}

beforeAll(async () => {
  mkdirSync(join(home.home, '.dsc'), { recursive: true })
  config = await import('./config.js')
  locale = await import('./plugin-locale.js')
})

afterAll(() => {
  home.restore()
})

test('每个包都声明了 ./locale/*.json 键，且 locale/en.json 齐全、只有 title/description 两行', () => {
  const ids = readdirSync(PACKAGES_DIR)
    .filter((name) => existsSync(join(PACKAGES_DIR, name, 'package.json')))
    .sort()
  expect(ids.length).toBeGreaterThan(0)

  const problems: string[] = []
  for (const id of ids) {
    const manifest = manifestOf(id)
    const exportsField = manifest['exports'] as Record<string, unknown> | undefined
    if (exportsField?.['./locale/*.json'] !== './locale/*.json') problems.push(`${id}: 清单没声明 ./locale/*.json`)
    const file = join(PACKAGES_DIR, id, 'locale', 'en.json')
    if (!existsSync(file)) {
      problems.push(`${id}: 缺 locale/en.json`)
      continue
    }
    let doc: Record<string, unknown>
    try {
      doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch (error) {
      problems.push(`${id}: locale/en.json 不是合法 JSON（${String(error)}）`)
      continue
    }
    const keys = Object.keys(doc).sort().join(',')
    // 多一个字段就是没人读的死键；少一个说明翻译没做完。
    if (keys !== 'description,title') problems.push(`${id}: 键集是 ${keys}，要求 title,description`)
    if (typeof doc['title'] !== 'string' || doc['title'].trim() === '') problems.push(`${id}: title 不是非空字符串`)
    if (typeof doc['description'] !== 'string' || doc['description'].trim() === '')
      problems.push(`${id}: description 不是非空字符串`)
    // 中英不能是同一句话：长度上限只兜最明显的那种「直接把中文抄过来」。
    if (typeof doc['title'] === 'string' && doc['title'].length > 24) problems.push(`${id}: title 超过 24 字符`)
    if (typeof doc['description'] === 'string' && doc['description'].length > 80)
      problems.push(`${id}: description 超过 80 字符`)
  }
  expect(problems.slice(0, 5)).toEqual([])

  // 抽查一份：英文译本与中文原文确实是两种语言（都用 ASCII 之外的字符判）。
  const sample = JSON.parse(readFileSync(join(PACKAGES_DIR, 'agent', 'locale', 'en.json'), 'utf8')) as {
    title: string
    description: string
  }
  expect(/[\u4e00-\u9fff]/.test(sample.title + sample.description)).toBe(false)
})

test('语言从 config.yaml 读：缺省中文，en / en-US 算英文，其余原样返回', () => {
  rmSync(CONFIG_FILE, { force: true })
  expect(config.readConfig().language).toBe('zh-CN')

  writeConfig(PLAIN_CONFIG)
  expect(config.readConfig().language).toBe('zh-CN')
  expect(locale.languageOfConfigFile(CONFIG_FILE)).toBe('zh-CN')

  writeConfig(`${PLAIN_CONFIG}language: en\n`)
  expect(config.readConfig().language).toBe('en')
  expect(locale.languageOfConfigFile(CONFIG_FILE)).toBe('en')

  writeConfig(`${PLAIN_CONFIG}language: en-US\n`)
  expect(config.readConfig().language).toBe('en-US')

  writeConfig(`${PLAIN_CONFIG}language: zh-CN\n`)
  expect(config.readConfig().language).toBe('zh-CN')

  writeConfig(`${PLAIN_CONFIG}language: fr\n`)
  expect(config.readConfig().language).toBe('fr')

  writeConfig(`${PLAIN_CONFIG}language: ""\n`)
  expect(config.readConfig().language).toBe('zh-CN')
})

test('配置文档形状不认识时也不抛（轻量读法给缺省语言）', () => {
  expect(locale.languageOfConfig(null)).toBe('zh-CN')
  expect(locale.languageOfConfig('en')).toBe('zh-CN')
})

/** `readConfig()` 的 language 字段是可选的；本文件一律按「读出来的那一份」喂给被测函数。 */
function languageOfConfig(): string {
  return config.readConfig().language ?? 'zh-CN'
}

test('真包：切 en 读英文译本，切回默认读中文原文', () => {
  const dir = join(PACKAGES_DIR, 'plugin-manager')
  const manifest = manifestOf('plugin-manager')

  writeConfig(`${PLAIN_CONFIG}language: en\n`)
  const en = locale.pluginDisplayOf(manifest, dir, languageOfConfig())
  expect(en.title).toBe('Plugin manager')
  expect(en.description).toBe(
    'List, toggle and install local or remote plugins; writes are approved first',
  )

  writeConfig(PLAIN_CONFIG)
  const zh = locale.pluginDisplayOf(manifest, dir, languageOfConfig())
  const raw = manifest['pneuma'] as { title: string; description: string }
  expect(zh.title).toBe(raw.title)
  expect(zh.description).toBe(raw.description)
  expect(/[\u4e00-\u9fff]/.test(`${zh.title}${zh.description}`)).toBe(true)
})

test('en-US 也取英文译本；fr 不在两档里，回落中文原文', () => {
  const dir = join(PACKAGES_DIR, 'plugin-manager')
  const manifest = manifestOf('plugin-manager')
  const raw = manifest['pneuma'] as { title: string }

  writeConfig(`${PLAIN_CONFIG}language: en-US\n`)
  expect(locale.pluginDisplayOf(manifest, dir, languageOfConfig()).title).toBe('Plugin manager')

  writeConfig(`${PLAIN_CONFIG}language: fr\n`)
  expect(locale.pluginDisplayOf(manifest, dir, languageOfConfig()).title).toBe(raw.title)
})

test('没有译本 / 译本坏 / 只译一半：都不抛，逐字段回落', () => {
  const bare = makePackage('bare', '没有译本', '这一包只有清单原文', undefined)
  const bareManifest = JSON.parse(readFileSync(join(bare, 'package.json'), 'utf8')) as Record<string, unknown>
  expect(locale.pluginDisplayOf(bareManifest, bare, 'en')).toEqual({
    title: '没有译本',
    description: '这一包只有清单原文',
  })

  const half = makePackage('half', '只译了一半', '这个包只译了标题', { title: 'Half translated' })
  const halfManifest = JSON.parse(readFileSync(join(half, 'package.json'), 'utf8')) as Record<string, unknown>
  const halfOut = locale.pluginDisplayOf(halfManifest, half, 'en')
  expect(halfOut.title).toBe('Half translated')
  expect(halfOut.description).toBe('这个包只译了标题')

  const broken = makePackage('broken', '坏译本', '翻译文件不是合法 JSON', '{ oops')
  const brokenManifest = JSON.parse(readFileSync(join(broken, 'package.json'), 'utf8')) as Record<string, unknown>
  expect(locale.pluginDisplayOf(brokenManifest, broken, 'en')).toEqual({
    title: '坏译本',
    description: '翻译文件不是合法 JSON',
  })
})

test('同一个包目录只读一次盘：删掉译本后仍返回缓存', () => {
  const dir = makePackage('countable', '只读一次', '删掉文件后应当还读得到缓存', {
    title: 'Cached title',
    description: 'Cached description',
  })
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
  expect(locale.pluginDisplayOf(manifest, dir, 'en').title).toBe('Cached title')

  rmSync(join(dir, 'locale', 'en.json'), { force: true })
  expect(locale.pluginDisplayOf(manifest, dir, 'en').title).toBe('Cached title')
  expect(locale.pluginLocaleOf(dir, 'en').title).toBe('Cached title')
  // 中文档不读译本：返回空对象（标题/说明走清单原文）。
  expect(Object.keys(locale.pluginLocaleOf(dir, 'zh-CN'))).toEqual([])
})
