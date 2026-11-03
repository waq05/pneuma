/**
 * 生成 GitHub Release 正文：安装方式 + CHANGELOG 当前版本那一节 + 完整记录链接。
 *
 * 为什么有它：`release.yml` 原来用 `generate_release_notes`，发布页只有一行
 * “Full Changelog”，用户看不出这一版改了什么；0.8.1 是手工补的，下一版还得再补一次。
 * 现在把它做成一次构建步骤：tag 推上去，正文就从仓库里的 CHANGELOG 长出来。
 *
 * 取哪一节：标题形如 `## 0.8.1 — 2026-11-03`，取到下一个 `## ` 之前；标题行本身去掉。
 * 找不到这一版时给一段兜底（安装方式 + 对比链接），不让发版卡住。
 *
 * 用法：
 *   node scripts/release-notes.mjs v0.8.1                 # 打到 stdout
 *   node scripts/release-notes.mjs v0.8.1 --out notes.md  # 写到文件（CI 用这个）
 *
 * @module dsc/scripts/release-notes
 */
import { readFileSync, writeFileSync } from 'node:fs'

const DEFAULT_CHANGELOG = 'CHANGELOG.md'
const DEFAULT_REPO = 'waq05/pneuma'

/** 版本号去掉前缀 `v`。 */
const bare = (tag) => tag.replace(/^v/, '')

/** 从 `repository.url` 里抠出 `owner/repo`（抠不到就用仓库默认值）。 */
function repoOf(packageJson) {
  const url = typeof packageJson?.repository === 'string'
    ? packageJson.repository
    : packageJson?.repository?.url
  const match = typeof url === 'string' ? /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url) : null
  return match === null ? DEFAULT_REPO : `${match[1]}/${match[2]}`
}

/**
 * 纯函数：把 CHANGELOG 文本渲染成发布正文。
 * @param {object} input
 * @param {string} input.changelog - CHANGELOG 全文。
 * @param {string} input.version - 版本号（可带 `v`）。
 * @param {string} input.packageName - npm 包名（装 CLI 那条用）。
 * @param {string} [input.repo] - `owner/repo`（链接用）。
 * @returns {{ body: string, found: boolean }}
 */
export function renderReleaseNotes({ changelog, version, packageName, repo = DEFAULT_REPO }) {
  const v = bare(version)
  const install = [
    '### 装哪个',
    '',
    `- **Windows 安装版**：\`pneuma-setup-${v}.exe\`（覆盖安装即可，配置与会话在 \`~/.dsc\`）`,
    `- **免安装**：\`pneuma-portable-${v}.exe\``,
    `- **终端 CLI**：\`npm i -g ${packageName}@${v}\``,
  ].join('\n')
  const footer = `完整记录见 [CHANGELOG.md](https://github.com/${repo}/blob/main/CHANGELOG.md)。`

  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^##\\s+v?${v.replace(/\./g, '\\.')}(\\s|$)`).test(line))
  if (start < 0) {
    // 兜底：这一版没写更新日志也别让发布失败，给对比链接让人自己翻提交
    const fallback = [
      install,
      '',
      `本版没有单独写在 CHANGELOG 里的条目，逐条改动见提交记录。`,
      '',
      '---',
      '',
      footer,
      '',
    ].join('\n')
    return { body: fallback, found: false }
  }

  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) {
      end = index
      break
    }
  }
  const section = lines.slice(start + 1, end).join('\n').trim()
  const body = [install, '', section, '', '---', '', footer, ''].join('\n')
  return { body, found: true }
}

/** 命令行入口：参数见文件头注释。 */
function main(argv) {
  const args = argv.slice(2)
  const at = (name) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const version = (() => {
    // 第一个「不是选项、也不是选项的值」的参数就是版本号
    const takesValue = new Set(['--out', '--changelog', '--package'])
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      if (takesValue.has(arg)) {
        index += 1
        continue
      }
      if (!arg.startsWith('--')) return arg
    }
    return undefined
  })()
  if (version === undefined) {
    console.error('用法：node scripts/release-notes.mjs <v版本号> [--out 文件] [--changelog 文件]')
    process.exit(2)
  }
  const changelogPath = at('--changelog') ?? DEFAULT_CHANGELOG
  const packagePath = at('--package') ?? 'package.json'
  const out = at('--out')
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
  const { body, found } = renderReleaseNotes({
    changelog: readFileSync(changelogPath, 'utf8'),
    version,
    packageName: packageJson.name,
    repo: repoOf(packageJson),
  })
  if (!found) console.error(`提示：${changelogPath} 里没有 ${bare(version)} 这一节，已用兜底正文`)
  if (out !== undefined) {
    writeFileSync(out, body)
    console.log(`写入 ${out}（${String(body.length)} 字符）`)
  } else {
    process.stdout.write(body)
  }
}

// 只有直接运行时才读文件：被测试 import 时不该碰磁盘
if (process.argv[1] !== undefined && process.argv[1].replace(/\\/g, '/').endsWith('scripts/release-notes.mjs')) {
  main(process.argv)
}
