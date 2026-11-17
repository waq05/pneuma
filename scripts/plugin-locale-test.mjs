/**
 * 插件清单本地化（`locale/`）的确定性探针。
 *
 * 用户要求：`numa plugin list` 与插件中心能按语言显示标题与说明，只本地化清单里给用户看的
 * 那两行字（`pneuma.title` / `pneuma.description`）。做法：每个包带一份 `locale/en.json`，
 * 内核读取端先查译本、没译过回落清单原文；语言从 `config.yaml` 的 `language` 来，
 * 只分 `en` 与「其余（含中文）」两档。
 *
 * 五段：
 *   [1] 92 个包都声明了 `./locale/*.json` 键，且都有 `locale/en.json`：title / description
 *       非空、键集恰好这两个（多一个字段就是没人读的死键）；
 *   [2] 语言从临时 `config.yaml` 读：缺省 / en / en-US / zh-CN / fr / 空串；
 *   [3] 同一条链读真包：切成 en 读英文，切回默认读中文；
 *   [4] 回落与缓存：没有译本、译本坏、只译了一半、语言不认识都不报错；同一个包目录只读一次盘；
 *   [5] 接线钉：内核与 CLI 的读取端确实走了 `pluginDisplayOf`。
 *
 * 隔离：临时 HOME + 临时 DSC_HOME + 临时 config.yaml，真实 ~/.dsc 一个字节都不动。
 * 不依赖构建产物：`.ts` 源码直读，靠一个把 `.js` 说明符回落成 `.ts` 的解析钩子。
 *
 * 用法：node scripts/plugin-locale-test.mjs
 *
 * @module dsc/scripts/plugin-locale-test
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readSource } from './_source.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(root, 'src', 'packages')

/** 临时 HOME：`homedir()` 读它，dsh 的凭据/设置也就落在临时目录里，不碰真实主目录。 */
const home = mkdtempSync(join(tmpdir(), 'dsc-plugin-locale-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })
const configFile = join(process.env.DSC_HOME, 'config.yaml')

/**
 * `.ts` 源码里的相对 import 写的是编译口径（`./x.js`），盘上只有 `x.ts`。
 * 解析不到 `.js` 时把后缀换成 `.ts` 再试一次——这样探针能直接 import 内核源码，
 * 不必先跑 `pnpm build`（新加的模块还没有编译产物）。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.endsWith('.js')) return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      throw error
    }
  },
})

const importTs = (rel) => import(pathToFileURL(resolve(root, rel)).href)

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

/** 写一份 config.yaml；没有 language 键就是「没配语言」。 */
const writeConfig = (body) => writeFileSync(configFile, body, 'utf8')
/** 一份只有 providers 的合法配置（没有 language 键）。 */
const PLAIN_CONFIG = 'default:\n  provider: p\n  model: m\nproviders:\n  p:\n    baseURL: http://127.0.0.1:1/v1\n    apiKeyEnv: LOCALE_TEST_KEY\n    models:\n      - id: m\n        name: m\n'

const { readConfig } = await importTs('src/core/config.ts')
const { pluginDisplayOf, languageOfConfig, languageOfConfigFile, pluginLocaleOf } = await importTs('src/core/plugin-locale.ts')

/** 读一个真包的清单（与内核用的就是同一份文件）。 */
const manifestOf = (id) => JSON.parse(readFileSync(join(packagesDir, id, 'package.json'), 'utf8'))

// ── 1. 92 个包都有译本，且译本只有两行 ───────────────────────────────────────
console.log('[1] 每个包都声明了 ./locale/*.json，且 locale/en.json 齐全')
{
  const ids = readdirSync(packagesDir)
    .filter((name) => existsSync(join(packagesDir, name, 'package.json')))
    .sort()
  check('包目录数与门禁口径一致（93）', ids.length === 93, String(ids.length))
  const problems = []
  let declared = 0
  for (const id of ids) {
    const manifest = manifestOf(id)
    if (manifest.exports?.['./locale/*.json'] !== './locale/*.json') problems.push(`${id}: 清单没声明 ./locale/*.json`)
    else declared += 1
    const file = join(packagesDir, id, 'locale', 'en.json')
    if (!existsSync(file)) {
      problems.push(`${id}: 缺 locale/en.json`)
      continue
    }
    let doc = null
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      problems.push(`${id}: locale/en.json 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`)
      continue
    }
    const keys = Object.keys(doc ?? {}).sort().join(',')
    if (keys !== 'description,title') problems.push(`${id}: 键集是 ${keys}，要求 title,description`)
    for (const field of ['title', 'description']) {
      if (typeof doc?.[field] !== 'string' || doc[field].trim() === '') problems.push(`${id}: ${field} 不是非空字符串`)
    }
    // 中英不能是同一句话：那等于没翻译（专有名词本来相同的包除外，这里只查长度上限）。
    if (typeof doc?.title === 'string' && doc.title.length > 24) problems.push(`${id}: title 超过 24 字符（${doc.title.length}）`)
    if (typeof doc?.description === 'string' && doc.description.length > 80) problems.push(`${id}: description 超过 80 字符（${doc.description.length}）`)
  }
  check('全部包都声明了 ./locale/*.json 键', declared === ids.length, `${declared}/${ids.length}`)
  check('全部包都有合法的 title/description 译本', problems.length === 0, problems.slice(0, 5).join('；'))
  // 抽查一份：英文译本与中文原文确实是两种语言（都用 ASCII 之外的字符判）
  const sample = JSON.parse(readFileSync(join(packagesDir, 'agent', 'locale', 'en.json'), 'utf8'))
  check(
    '抽查 agent：英文译本没有中文字符',
    !/[\u4e00-\u9fff]/.test(sample.title + sample.description),
    JSON.stringify(sample),
  )
}

// ── 2. 语言从 config.yaml 读 ────────────────────────────────────────────────
console.log('[2] 语言从临时 config.yaml 读（只有 en 与「其余」两档）')
{
  rmSync(configFile, { force: true })
  check('没有配置文件时缺省中文', readConfig().language === 'zh-CN', String(readConfig().language))
  writeConfig(PLAIN_CONFIG)
  check('配置里没写 language 时缺省中文', readConfig().language === 'zh-CN', String(readConfig().language))
  check('同一个文件用轻量读法也得到中文', languageOfConfigFile(configFile) === 'zh-CN', languageOfConfigFile(configFile))
  writeConfig(`${PLAIN_CONFIG}language: en\n`)
  check('language: en 读成 en', readConfig().language === 'en', String(readConfig().language))
  check('轻量读法与 readConfig 一致', languageOfConfigFile(configFile) === 'en', languageOfConfigFile(configFile))
  writeConfig(`${PLAIN_CONFIG}language: en-US\n`)
  check('en-US 也算英文（en 开头）', readConfig().language === 'en-US', String(readConfig().language))
  writeConfig(`${PLAIN_CONFIG}language: zh-CN\n`)
  check('language: zh-CN 读成 zh-CN', readConfig().language === 'zh-CN', String(readConfig().language))
  writeConfig(`${PLAIN_CONFIG}language: fr\n`)
  check('不认识的语言原样返回（fr）', readConfig().language === 'fr', String(readConfig().language))
  writeConfig(`${PLAIN_CONFIG}language: ""\n`)
  check('language 是空串时回落中文', readConfig().language === 'zh-CN', String(readConfig().language))
  check('配置文档形状不认识时也不抛', languageOfConfig(null) === 'zh-CN' && languageOfConfig('en') === 'zh-CN')
}

// ── 3. 同一条链读真包：en 英文、默认中文 ────────────────────────────────────
console.log('[3] 真包：切 en 读英文，切回默认读中文')
{
  const dir = join(packagesDir, 'plugin-manager')
  const manifest = manifestOf('plugin-manager')
  writeConfig(`${PLAIN_CONFIG}language: en\n`)
  const en = pluginDisplayOf(manifest, dir, readConfig().language)
  check('en：标题取译本', en.title === 'Plugin manager', String(en.title))
  check('en：说明取译本', en.description === 'List, toggle and install local or remote plugins; writes are approved first', String(en.description))
  writeConfig(PLAIN_CONFIG)
  const zh = pluginDisplayOf(manifest, dir, readConfig().language)
  check('默认：标题回到清单原文', zh.title === manifest.pneuma.title, String(zh.title))
  check('默认：说明回到清单原文', zh.description === manifest.pneuma.description, String(zh.description))
  check('默认读到的就是中文', /[\u4e00-\u9fff]/.test(zh.title + zh.description), `${zh.title}/${zh.description}`)
  writeConfig(`${PLAIN_CONFIG}language: en-US\n`)
  const enUs = pluginDisplayOf(manifest, dir, readConfig().language)
  check('en-US 也取英文译本', enUs.title === 'Plugin manager', String(enUs.title))
  writeConfig(`${PLAIN_CONFIG}language: fr\n`)
  const fr = pluginDisplayOf(manifest, dir, readConfig().language)
  check('fr 不在两档里，回落中文原文', fr.title === manifest.pneuma.title, String(fr.title))
}

// ── 4. 回落与缓存 ───────────────────────────────────────────────────────────
console.log('[4] 没有译本 / 译本坏 / 只译一半 / 同一个包目录只读一次')
{
  const sandbox = join(home, 'pkgs')
  /** 造一个只有清单（没有 locale/）的包目录。 */
  const makePkg = (name, title, description, locale) => {
    const dir = join(sandbox, name)
    mkdirSync(join(dir, 'locale'), { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: '@pneuma/' + name, pneuma: { title, description } }, null, 2)}\n`,
      'utf8',
    )
    if (locale === undefined) rmSync(join(dir, 'locale'), { recursive: true, force: true })
    else writeFileSync(join(dir, 'locale', 'en.json'), typeof locale === 'string' ? locale : `${JSON.stringify(locale, null, 2)}\n`, 'utf8')
    return dir
  }

  const bare = makePkg('bare', '没有译本', '这一包只有清单原文')
  const bareManifest = JSON.parse(readFileSync(join(bare, 'package.json'), 'utf8'))
  let bareOut
  let bareError = null
  try {
    bareOut = pluginDisplayOf(bareManifest, bare, 'en')
  } catch (error) {
    bareError = error
  }
  check('没有 locale 文件的包不报错', bareError === null, bareError === null ? undefined : String(bareError))
  check('没有 locale 文件的包回落中文标题', bareOut?.title === '没有译本', String(bareOut?.title))
  check('没有 locale 文件的包回落中文说明', bareOut?.description === '这一包只有清单原文', String(bareOut?.description))

  const half = makePkg('half', '只译了一半', '这个包只译了标题', { title: 'Half translated' })
  const halfManifest = JSON.parse(readFileSync(join(half, 'package.json'), 'utf8'))
  const halfOut = pluginDisplayOf(halfManifest, half, 'en')
  check('只译了标题时标题用译本', halfOut.title === 'Half translated', String(halfOut.title))
  check('只译了标题时说明回落原文', halfOut.description === '这个包只译了标题', String(halfOut.description))

  const broken = makePkg('broken', '坏译本', '翻译文件不是合法 JSON', '{ oops')
  const brokenManifest = JSON.parse(readFileSync(join(broken, 'package.json'), 'utf8'))
  let brokenError = null
  let brokenOut
  try {
    brokenOut = pluginDisplayOf(brokenManifest, broken, 'en')
  } catch (error) {
    brokenError = error
  }
  check('坏 JSON 的译本不抛错', brokenError === null, brokenError === null ? undefined : String(brokenError))
  check('坏 JSON 的译本整条回落中文', brokenOut?.title === '坏译本', String(brokenOut?.title))

  const countable = makePkg('countable', '只读一次', '删掉文件后应当还读得到缓存', { title: 'Cached title', description: 'Cached description' })
  const countableManifest = JSON.parse(readFileSync(join(countable, 'package.json'), 'utf8'))
  const first = pluginDisplayOf(countableManifest, countable, 'en')
  rmSync(join(countable, 'locale', 'en.json'), { force: true })
  const second = pluginDisplayOf(countableManifest, countable, 'en')
  check('第一次读到的是译本', first.title === 'Cached title', String(first.title))
  check('删掉译本后仍返回缓存（同一个包目录只读一次盘）', second.title === 'Cached title', String(second.title))
  const direct = pluginLocaleOf(countable, 'en')
  check('pluginLocaleOf 也走同一份缓存', direct.title === 'Cached title', String(direct.title))
  check('中文档不读译本（空对象）', Object.keys(pluginLocaleOf(countable, 'zh-CN')).length === 0)
}

// ── 5. 接线钉：内核与 CLI 的读取端 ──────────────────────────────────────────
console.log('[5] 接线钉：内核与 numa plugin list 都走同一条取值路径')
{
  const loader = readSource('src/core/plugin-loader.ts')
  check('plugin-loader 用了 pluginDisplayOf', /pluginDisplayOf\(/.test(loader))
  check('plugin-loader 把语言放进了挂载上下文', /language: string/.test(loader) && /language: languageOfConfigFile\(activeConfigFile\(\)\)/.test(loader))
  check('plugin-loader 的标题/说明取 display', /const rowName = display\.title/.test(loader) && /description: display\.description/.test(loader))
  const config = readSource('src/core/config.ts')
  check('config.ts 读 language', /languageOfConfig\(doc\)/.test(config) && /\blanguage\b/.test(config))
  const cli = readSource('src/packages/cli/plugin-cli.ts')
  check('numa plugin list 的标题也查译本', /pluginDisplayOf\(manifest, dir, language\)/.test(cli))
  check('CLI 只读一次语言', /const language = languageOfConfigFile\(activeConfigFile\(\)\)/.test(cli))
}

console.log('')
console.log(`插件清单本地化：${passed} 条通过，${failures} 条失败`)
process.exit(failures === 0 ? 0 : 1)
