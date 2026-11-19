/**
 * 版本口径单一来源：tag（去掉 tagPrefix）与所有站点清单里的 `version` 严格相等。
 *
 * 为什么要有它：`AGENTS.md` 说「三处」、`release.yml` 的旧 shell 查「四处」、
 * `src/packages/<id>/package.json` 还有一组包各自写版本（plugin-standard-check 强制等于根）。
 * 口径散在几个文件里，改版本号时谁都说不清到底几处；站点清单只写一次在
 * `scripts/version-sites.json`，本脚本与文档都引它。
 *
 * 用法：node scripts/version-check.mjs [--json] [--tag v0.9.1] [--root <dir>]
 *   `--root` 是**只给自测用**的临时目录根：只换被检查的文件在哪，站点清单仍读本脚本旁边那份。
 *
 * 退出码（design/README.md §2.7）：0 全一致 / 1 有不一致 / 2 工具错（文件缺失、JSON 坏、
 * glob 展开为 0、tag 取不到）。预发布版本只做字符串相等、不做 semver 排序（免得 rc.10
 * 被排到 rc.9 前面）。不改版本号；ui-shell 的插件 api 区间由 build-plugins 判，这里只提示。
 *
 * 回退开关（05-acceptance.md §6）：门禁名 `version-check`，设 `NUMA_GATE_DISABLE=version-check`
 * （可逗号分隔多个）时打印一行「已按 NUMA_GATE_DISABLE 跳过 version-check」并退 0，不许静默。
 * 人读模式这行打 stdout；`--json` 模式 stdout 只留一份可 parse 的
 * `{ ok: true, skipped: true, gate, reason, message }`，跳过提示改走 stderr，免得把 JSON 弄坏。
 *
 * @module scripts/version-check
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CONFIG_FILE = join(REPO_ROOT, 'scripts', 'version-sites.json')
const GATE = 'version-check'
const USAGE = '用法：node scripts/version-check.mjs [--json] [--tag v0.9.1] [--root <dir>]'
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
let cliTag = null
let targetRoot = REPO_ROOT

// 统一回退开关（05-acceptance.md §6）：命中就跳过并退 0，不许静默。放在参数解析之前，
// 这样参数写错、tag 取不到都不会挡住这条紧急通道；--json 时必须仍留一份可 parse 的 JSON。
const disabledGates = (process.env.NUMA_GATE_DISABLE ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '')
if (disabledGates.includes(GATE)) {
  const message = `已按 NUMA_GATE_DISABLE 跳过 ${GATE}`
  if (asJson) {
    process.stderr.write(`${message}\n`)
    console.log(JSON.stringify({ ok: true, skipped: true, gate: GATE, reason: 'NUMA_GATE_DISABLE', message }, null, 2))
  } else {
    process.stdout.write(`${message}\n`)
  }
  process.exit(0)
}

/** 检查挂了是 1，工具坏了才是 2：读不到、解析不了、取不到 tag 一律按 2 退。 */
function fail(message) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: message }, null, 2))
  else console.error(`✗ ${message}`)
  process.exit(2)
}

for (let index = 0; index < argv.length; index += 1) {
  const raw = argv[index]
  const eq = raw.indexOf('=')
  const flag = eq === -1 ? raw : raw.slice(0, eq)
  /** 取参数值：`--tag v1` 与 `--tag=v1` 两种写法都认。 */
  const take = () => {
    if (eq !== -1) return raw.slice(eq + 1)
    if (argv[index + 1] === undefined) fail(`${flag} 后面缺值。\n${USAGE}`)
    index += 1
    return argv[index]
  }
  if (flag === '--json') continue
  if (flag === '--tag') cliTag = take().trim()
  else if (flag === '--root') targetRoot = resolve(take())
  else fail(`不认识的参数「${raw}」。\n${USAGE}`)
}

let config
try {
  config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
} catch (error) {
  fail(`读不了站点清单 ${CONFIG_FILE}：${error.message}（严格 JSON，带 BOM 或注释都算坏）`)
}
if (!Array.isArray(config.sites) || config.sites.length === 0) fail('version-sites.json 的 sites 必须是非空数组')
if (typeof config.tagPrefix !== 'string' || config.tagPrefix === '') fail('version-sites.json 的 tagPrefix 必须是非空字符串')
if (config.tagSource !== 'git' && config.tagSource !== 'arg') fail('version-sites.json 的 tagSource 只能是 "git" 或 "arg"')

/** tag 两种写法都认：`v0.9.1` 与 `0.9.1` 去掉前缀后是同一个比较值。 */
function resolveTag() {
  if (config.tagSource === 'arg' && cliTag === null) fail('tagSource=arg：必须传 --tag <tag>')
  if (cliTag !== null) return { tag: cliTag, source: '--tag' }
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: targetRoot, encoding: 'utf8' }).trim()
    if (tag !== '') return { tag, source: 'git describe' }
  } catch {}
  return fail(`取不到 tag：本地无 tag 或不在 git 仓库，请传 --tag <tag>（tagPrefix「${config.tagPrefix}」带不带都行）。\n${USAGE}`)
}
const resolvedTag = resolveTag()
const expected = resolvedTag.tag.toLowerCase().startsWith(config.tagPrefix.toLowerCase())
  ? resolvedTag.tag.slice(config.tagPrefix.length)
  : resolvedTag.tag

/** 读一个 package.json；缺文件、坏 JSON（含 BOM/注释）都按 2 退。 */
function readManifest(rel) {
  let text
  try {
    text = readFileSync(join(targetRoot, rel), 'utf8')
  } catch (error) {
    fail(`读不了 ${rel}：${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(`JSON 坏：${rel}（${text.charCodeAt(0) === 0xfeff ? '开头带 BOM；' : ''}${error.message}）`)
  }
}

/** 展开单层通配：`*` 只匹配一段，中间段收目录、最后一段收文件；目录不存在就当 0 命中。 */
function expandGlob(pattern) {
  const segments = pattern.split('/')
  let paths = ['']
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1
    const matcher = segment.includes('*')
      ? new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')}$`)
      : null
    paths = paths.flatMap((base) => {
      const rel = (name) => (base === '' ? name : `${base}/${name}`)
      if (matcher === null) return [rel(segment)]
      let entries = []
      try {
        entries = readdirSync(join(targetRoot, base), { withFileTypes: true })
      } catch {}
      return entries
        .filter((entry) => matcher.test(entry.name) && (last ? entry.isFile() : entry.isDirectory()))
        .map((entry) => rel(entry.name))
    })
    if (paths.length === 0) break
  }
  return paths.sort()
}

/** 取 `field`，支持点号路径（现在只有 `version`，留着免得以后嵌套字段没处写）。 */
const readField = (manifest, field) => field.split('.').reduce((value, key) => (value == null ? undefined : value[key]), manifest)

const sites = []
for (const site of config.sites) {
  if (typeof site.id !== 'string' || typeof site.field !== 'string') fail('每个站点都要有 id 与 field')
  if (typeof site.path === 'string') {
    if (!existsSync(join(targetRoot, site.path))) {
      if (site.required !== false) fail(`缺文件：${site.path}（站点 ${site.id} 标了 required）`)
      sites.push({ id: site.id, path: site.path, files: [], skipped: true })
      continue
    }
    const version = readField(readManifest(site.path), site.field)
    if (typeof version !== 'string') fail(`${site.id}：${site.path} 的 ${site.field} 不是字符串（${JSON.stringify(version)}）`)
    sites.push({ id: site.id, path: site.path, files: [{ path: site.path, version }] })
  } else if (typeof site.glob === 'string') {
    const matches = expandGlob(site.glob)
    if (matches.length === 0) fail(`glob 展开为 0：${site.glob}——目录不存在或没有命中，不许当「没有包要查」`)
    const files = matches.map((rel) => {
      const version = readField(readManifest(rel), site.field)
      if (typeof version !== 'string') fail(`${site.id}：${rel} 的 ${site.field} 不是字符串（${JSON.stringify(version)}）`)
      return { path: rel, version }
    })
    sites.push({ id: site.id, glob: site.glob, files })
  } else fail(`站点 ${site.id} 既没有 path 也没有 glob`)
}

const mismatches = sites
  .map((site) => ({ ...site, total: site.files.length, files: site.files.filter((file) => file.version !== expected) }))
  .filter((site) => site.files.length > 0)
const ok = mismatches.length === 0

if (asJson) {
  console.log(JSON.stringify({ ok, tag: resolvedTag.tag, tagSource: resolvedTag.source, expected, sites, mismatches }, null, 2))
} else {
  const total = sites.reduce((sum, site) => sum + site.files.length, 0)
  const width = Math.max(...sites.map((site) => site.id.length), 8)
  console.log(`站点清单：scripts/version-sites.json（${String(sites.length)} 个站点 / ${String(total)} 个清单）`)
  console.log(`仓库根：${targetRoot}`)
  console.log(`tag：${resolvedTag.tag}（来源：${resolvedTag.source}），期望版本：${expected}\n`)
  for (const site of sites) {
    const versions = [...new Set(site.files.map((file) => file.version))]
    const summary = site.skipped
      ? '（required=false，缺文件，跳过）'
      : site.files.length === 1
        ? site.files[0].version
        : `${String(site.files.length)} 个包 ${versions.length === 1 ? versions[0] : `（${String(versions.length)} 种版本）`}`
    const mark = site.skipped || site.files.every((file) => file.version === expected) ? '✓' : '✗'
    console.log(`  ${site.id.padEnd(width)}  ${summary}  ${mark}`)
  }
  if (ok) {
    console.log(`\n✓ 版本一致：${resolvedTag.tag} 与 ${String(sites.length)} 个站点全部相等（含 ${String(total)} 个清单）`)
  } else {
    console.log(`\n✗ 版本不一致（tag ${resolvedTag.tag} → 期望 ${expected}）：`)
    for (const site of mismatches) {
      if (site.glob === undefined) {
        console.log(`  ${site.id} ${site.files[0].version} ≠ ${expected}`)
        continue
      }
      console.log(`  ${site.id} 有 ${String(site.files.length)}/${String(site.total)} 个包 ≠ ${expected}`)
      for (const file of site.files.slice(0, 5)) console.log(`    ${file.path} ${file.version}`)
      if (site.files.length > 5) console.log(`    …另有 ${String(site.files.length - 5)} 个`)
    }
    if (mismatches.some((site) => site.glob !== undefined)) console.log('  提示：包组推齐用 node scripts/sync-versions.mjs --write。')
    if (mismatches.some((site) => site.id === 'ui-shell')) {
      console.log('  提示：ui-shell 的 version 同时是插件清单 apiVersion，改它要同批改插件 @dsc/ui 区间——')
      console.log('        请跑 pnpm -C ui-shell run build:plugins 看失配点名（本脚本不判这一项）。')
    }
  }
}
process.exit(ok ? 0 : 1)
