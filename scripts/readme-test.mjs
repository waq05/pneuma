/**
 * README 展示面（仓库首页）的确定性探针。
 *
 * 为什么值得单钉一份：README 是**唯一一处不用编译就能对外说谎的地方**。它引的图片、
 * 指的相对路径、写的数字，全都没有别的闸门看着——图片路径写错 GitHub 上就是一张裂图，
 * 插件数写错（18 写成 17）读者照着数就是错的。这条探针把三件事钉住：
 *
 *   [1] 顶部块形态：居中横幅 + 一行徽章 + `# 名字` + 引用块简介，HTML 标签闭合对称；
 *   [2] 相对路径全部命中：README 里每个相对链接 / 图片在磁盘上真实存在，
 *       且图片只从 `docs/assets/` 出（`shots/` 整目录被 gitignore，指过去必 404）；
 *   [3] 节序与锚点：H2 清单与设计一致，正文里 `](#锚点)` 引的标题真的在；
 *   [4] 数字口径对齐源码：功能包 56 个 / 默认关 13 个 / 工具 10 件；
 *   [5] 正文点名的仓库路径都存在（架构树、`scripts/xxx.mjs` 这类示例最容易腐坏——
 *       写「跑 node scripts/xxx-test.mjs」而那个文件早改名了，读者照着敲就是空跑）。
 *
 * 运行：node scripts/readme-test.mjs
 *
 * @module dsc/scripts/readme-test
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readSource } from './_source.mjs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}/${rel}`, 'utf8')
// 工作区检出是 CRLF：先归一化，否则逐行比对会被行尾的 \r 判红
const readme = read('README.md').replace(/\r\n/g, '\n')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ── [1] 顶部块形态 ──────────────────────────────────────────────────────────
console.log('[1] 顶部块：居中横幅 + 徽章行 + H1 + 引用块')

const lines = readme.split('\n')
const h1Index = lines.findIndex((line) => line.startsWith('# '))
const firstHeadingIndex = lines.findIndex((line) => /^#{1,6} /.test(line))
const top = lines.slice(0, firstHeadingIndex).join('\n')
const opens = (top.match(/<p align="center">/g) ?? []).length
const closes = (top.match(/<\/p>/g) ?? []).length

check('文件以居中块开头', readme.trimStart().startsWith('<p align="center">'))
check('居中块开合对称（两块：横幅一块、徽章一块）', opens === 2 && closes === 2, `开 ${String(opens)} 闭 ${String(closes)}`)
check('横幅引的是仓库内的 PNG', top.includes('<img src="docs/assets/readme/banner.png" width="560"'))
check('横幅有 alt 文案', /<img src="docs\/assets\/readme\/banner\.png"[^>]*alt="[^"]+"/.test(top))
check('第一个标题是一级标题', h1Index === firstHeadingIndex && lines[h1Index] === '# Pneuma', lines[h1Index])
check('H1 之后紧跟引用块简介（替掉旧的长标题）', lines[h1Index + 2]?.startsWith('> **全自研**'))

const badgeBlock = top.slice(top.lastIndexOf('<p align="center">'))
const badgeImages = (badgeBlock.match(/<img /g) ?? []).length
const badgeLinks = (badgeBlock.match(/<a href="/g) ?? []).length
check('徽章四枚', badgeImages === 4, `实际 ${String(badgeImages)} 枚`)
check('每枚徽章都包着链接', badgeLinks === 4, `实际 ${String(badgeLinks)} 个链接`)
check('徽章用 flat-square 风格（GitHub 原生那枚除外）', (badgeBlock.match(/style=flat-square/g) ?? []).length === 3)

// ── [2] 相对路径全部命中 ────────────────────────────────────────────────────
console.log('\n[2] 相对路径 / 图片')

const markdownTargets = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1])
const isExternal = (target) => /^https?:\/\//.test(target) || target.startsWith('mailto:')
const htmlTargets = [...readme.matchAll(/src="([^"]+)"/g)].map((match) => match[1]).filter((target) => !isExternal(target))

const missing = markdownTargets
  .filter((target) => !isExternal(target) && !target.startsWith('#'))
  .map((target) => target.split('#')[0])
  .filter((path) => path !== '' && !existsSync(`${root}/${path}`))
check('README 里每个相对链接都存在', missing.length === 0, missing.join('、'))

const missingAssets = htmlTargets.filter((target) => !existsSync(`${root}/${target}`))
check('每个 <img src> 都存在', missingAssets.length === 0, missingAssets.join('、'))

const outsideAssets = htmlTargets.filter((target) => !target.startsWith('docs/assets/'))
check(
  '图片只在 docs/assets/ 下（shots/ 被 gitignore，指过去 GitHub 上是裂图）',
  outsideAssets.length === 0,
  outsideAssets.join('、'),
)

const banner = `${root}/docs/assets/readme/banner.png`
check('横幅是张真 PNG（前 8 字节是签名）', existsSync(banner) && readFileSync(banner).subarray(0, 8).toString('hex') === '89504e470d0a1a0a')
check('横幅体积在合理区间（20KB–1MB）', existsSync(banner) && statSync(banner).size > 20_000 && statSync(banner).size < 1_000_000)
check('横幅留了可重建的源文件', existsSync(`${root}/docs/assets/readme/banner.src.html`))
check(
  '横幅源文件指的是仓库里的图标',
  read('docs/assets/readme/banner.src.html').includes('../../../desktop/build/icon.png'),
)

check('没有指向改名前的旧仓/旧包', !readme.includes('muse-code') && !readme.includes('waq05/dsc'))

// ── [3] 节序与锚点 ──────────────────────────────────────────────────────────
console.log('\n[3] 节序与锚点')

const EXPECTED_H2 = [
  '有什么',
  '快速开始',
  '快捷键与斜杠命令',
  '工具集（10 件）',
  '配置',
  '插件',
  '架构',
  '权限与安全边界',
  '已知限制',
  '开发',
  '文档',
  '许可',
]
const h2 = lines.filter((line) => line.startsWith('## ')).map((line) => line.slice(3).trim())
check('H2 清单与设计一致（顺序也算）', JSON.stringify(h2) === JSON.stringify(EXPECTED_H2), h2.join(' / '))

const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{Script=Han}\w\- ]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
const anchors = new Set(lines.filter((line) => line.startsWith('## ')).map((line) => slug(line.slice(3).trim())))
const referenced = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1])
const dangling = referenced.filter((anchor) => !anchors.has(anchor))
check('正文里引的锚点都存在', dangling.length === 0, dangling.join('、'))

// ── [4] 数字口径对齐源码 ────────────────────────────────────────────────────
console.log('\n[4] 数字口径')

// 0.9 起功能都在 src/packages/<id>/：总数看目录，默认关看各自 patch 行上的 disabled。
const packageIds = readdirSync(join(root, 'src', 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(root, 'src', 'packages', name, 'cordis.patch.yml')))
let defaultOff = 0
for (const id of packageIds) {
  if (/^\s*disabled: true$/m.test(read(join('src', 'packages', id, 'cordis.patch.yml')))) defaultOff += 1
}

const pluginsClaim = Number(/功能包共 \*\*(\d+) 个\*\*/.exec(readme)?.[1] ?? '0')
check('功能包数写的是磁盘上的数', pluginsClaim === packageIds.length, `README ${String(pluginsClaim)} / 磁盘 ${String(packageIds.length)}`)
const offClaim = Number(/默认关 (\d+) 个/.exec(readme)?.[1] ?? '0')
check('默认关的个数与包清单一致', offClaim === defaultOff, `README ${String(offClaim)} / 包清单 ${String(defaultOff)}`)
check('默认关是少数（一半以下）', defaultOff < packageIds.length, `${String(defaultOff)}/${String(packageIds.length)}`)

// bash / search-tools 的实现已搬进 tools-default 包，readSource 顺着转发桩读真文件
const toolModules = ['bash', 'fs-tools', 'search-tools'].map((name) => readSource(`src/core/tools/${name}.ts`))
const toolNames = new Set(toolModules.flatMap((source) => [...source.matchAll(/^ {2,}name: '([a-z_]+)',$/gm)].map((match) => match[1])))
const toolsClaim = Number(/## 工具集（(\d+) 件）/.exec(readme)?.[1] ?? '0')
check('工具数写的是注册表里的数', toolsClaim === toolNames.size, `README ${String(toolsClaim)} / 源码 ${String(toolNames.size)}`)

const namedInReadme = ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'job_output', 'job_list', 'job_kill', 'terminal']
const unknown = namedInReadme.filter((name) => !toolNames.has(name))
check('正文点名的 10 件工具在注册表里都有', unknown.length === 0, unknown.join('、'))

// ── [5] 正文点名的仓库路径都存在 ────────────────────────────────────────────
console.log('\n[5] 正文点名的仓库路径')

// 只认这几个**检出后必然存在**的顶层目录：`lib/` 之类要 build 才有，不在此列。
// 末尾的标点要吃掉（中文句子里路径后面常跟 `、` `，` `）`）。
const mentioned = [
  ...new Set(
    [...readme.matchAll(/(?:^|[\s`(`（[|])((?:bin|src|scripts|examples|desktop|ui-shell)\/[A-Za-z0-9_./-]+)/gm)].map((match) =>
      match[1].replace(/[.,、，。；;）)]+$/, ''),
    ),
  ),
]
const absent = mentioned.filter((path) => !existsSync(`${root}/${path}`))
check('正文里点名的路径都在磁盘上', absent.length === 0, absent.join('、'))

const probeExamples = mentioned.filter((path) => path.startsWith('scripts/') && path.endsWith('.mjs'))
check('把自检脚本当例子举的时候，举的是真文件', probeExamples.every((path) => existsSync(`${root}/${path}`)), probeExamples.join('、'))

console.log(
  failures === 0 ? `\n${String(passed)} 条断言全部通过` : `\n${String(failures)}/${String(passed + failures)} 条断言失败`,
)
process.exit(failures === 0 ? 0 : 1)
