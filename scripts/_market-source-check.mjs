/**
 * 临时自检：ClawHub 与 skills.sh 两个新源能不能真浏览、真安装。
 *
 * 用法：node scripts/_market-source-check.mjs（联网，约 10–60 秒）
 * 只写系统临时目录，不碰 ~/.dsc 里的技能目录。
 *
 * @module dsc/scripts/_market-source-check
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { browseMarketSource, installMarketEntry } = await import(
  '../lib/node_modules/@pneuma/config-core/market.js'
)

const box = mkdtempSync(join(tmpdir(), 'dsc-market-check-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

try {
  // ── 1. ClawHub 榜单 ──
  const claw = await browseMarketSource({
    name: 'ClawHub',
    url: 'https://clawhub.ai/api/v1/skills?sort=downloads&limit=100',
  })
  check('ClawHub 拉到条目', claw.length > 50, `${claw.length} 条`)
  const first = claw[0]
  check('ClawHub 条目有名字与描述', first !== undefined && first.name !== '' && first.description !== '')
  check('ClawHub 条目带下载读数', first?.stats?.downloads !== undefined, JSON.stringify(first?.stats))
  check('ClawHub 条目是 zip 类型', first?.kind === 'zip', String(first?.kind))

  // ── 2. ClawHub 安装（zip 解压） ──
  if (first !== undefined) {
    const result = await installMarketEntry(first, join(box, 'claw'))
    const skillMd = join(box, 'claw', first.name, 'SKILL.md')
    check('ClawHub 装出 SKILL.md', existsSync(skillMd), result.target)
    check('ClawHub 装了不止一个文件', result.files > 1, `${result.files} 个文件`)
    if (existsSync(skillMd)) {
      const head = readFileSync(skillMd, 'utf8').slice(0, 200)
      check('SKILL.md 有 frontmatter', head.includes('name:') || head.includes('description:'))
    }
  }

  // ── 3. skills.sh 搜索 ──
  const sh = await browseMarketSource({ name: 'skills.sh', url: 'https://skills.sh/api/search' }, { query: 'git' })
  check('skills.sh 搜到条目', sh.length > 0, `${sh.length} 条`)
  check('skills.sh 条目是 repo-dir 类型', sh[0]?.kind === 'repo-dir', String(sh[0]?.kind))

  // ── 4. skills.sh 空查询要报错，不冒充空结果 ──
  let emptyError = ''
  try {
    await browseMarketSource({ name: 'skills.sh', url: 'https://skills.sh/api/search' }, { query: '' })
  } catch (error) {
    emptyError = String(error?.message ?? error)
  }
  check('skills.sh 空查询报错', emptyError.includes('搜索'), emptyError.slice(0, 80))

  // ── 5. skills.sh 安装（仓库里定位目录） ──
  const installable = sh.find((entry) => entry.name === 'git-commit') ?? sh[0]
  if (installable !== undefined) {
    const result = await installMarketEntry(installable, join(box, 'sh'))
    const skillMd = join(box, 'sh', installable.name, 'SKILL.md')
    check('skills.sh 装出 SKILL.md', existsSync(skillMd), result.target)
  }
} catch (error) {
  failures += 1
  console.log(`FAIL  自检中断：${String(error?.stack ?? error)}`)
} finally {
  rmSync(box, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
