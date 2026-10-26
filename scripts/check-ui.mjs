/**
 * UI 自检总闸：把 `scripts/ui-*-test.mjs` 全部跑一遍。
 *
 * 为什么要这条：壳的回归面一直靠人记「我改了壳，该手跑哪几条」——
 * 库里曾有 38 条探针，聚合门禁只挂了 5 条，剩下的散在文档和历史提交里，
 * 改一处忘了跑一条就会漏。这里改成**按文件名自动发现**：新加一条探针
 * 命名成 `ui-<话题>-test.mjs` 就自动进门禁，不必再改 package.json。
 *
 * 两档，按「要不要真 Chromium」切：
 *   - 默认（`check:ui`）：纯 Node 探针，起隔离宿主 / 读源码 / 纯函数，秒级到十几秒；
 *   - `--e2e`（`check:ui:e2e`）：要真 Electron + 真 Chromium，慢且依赖 `desktop/node_modules/electron`。
 *
 * 分工不是按「重要程度」分，而是按「跑得动跑不动」分：机器上没有 Electron 的解包产物，
 * 默认档仍应当全绿。`ui-hmr-machine.mjs` 是真机走查（要真 Electron 且会改源码再还原），
 * 不叫 `-test`，有意不进这两档，手动跑：`node scripts/ui-hmr-machine.mjs`。
 *
 * 用法：
 *   node scripts/check-ui.mjs            # 纯 Node 那批
 *   node scripts/check-ui.mjs --e2e      # 真 Chromium 那批
 *   node scripts/check-ui.mjs --list     # 只列会跑哪些，不跑
 *   node scripts/check-ui.mjs ui-serve-test.mjs ...   # 只跑点名的（调试用）
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const scriptsDir = resolve(here)

/**
 * 要真 Chromium 的那几条：默认档不跑。
 *
 * 判据是**命名**：叫 `*-e2e.mjs` 的自动归 e2e 档。`ui-cordis-test.mjs` 是历史名字，
 * 早于这套命名约定，列在这里而不是改名——它被文档和提交信息引用过，改名会让旧引用断掉。
 * 新写的真机探针请一律叫 `ui-<话题>-e2e.mjs`，不必再回来加一行。
 */
const E2E_EXTRA = new Set(['ui-cordis-test.mjs'])
const isE2e = (file) => file.endsWith('-e2e.mjs') || E2E_EXTRA.has(file)

const args = process.argv.slice(2)
const wantE2e = args.includes('--e2e')
const listOnly = args.includes('--list')
const named = args.filter((a) => !a.startsWith('--'))

const all = readdirSync(scriptsDir)
  .filter((f) => f.startsWith('ui-') && (f.endsWith('-test.mjs') || f.endsWith('-e2e.mjs')))
  .sort()

const picked = named.length
  ? named.map((n) => (n.endsWith('.mjs') ? n : n + '.mjs'))
  : all.filter((f) => (wantE2e ? isE2e(f) : !isE2e(f)))

if (picked.length === 0) {
  console.error(wantE2e ? '没有匹配的 e2e 探针' : '没找到任何 ui-*-test.mjs')
  process.exit(2)
}

if (listOnly) {
  for (const f of picked) console.log(f)
  process.exit(0)
}

/** 一条探针的结论：只认它自己打印的 PASS/FAIL 计数，以及退出码。 */
function runOne(file) {
  return new Promise((done) => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, [join(scriptsDir, file)], {
      cwd: resolve(scriptsDir, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('close', (code) => {
      const text = out + err
      // 探针之间的汇总写法不统一（「N 项通过」「N PASS」「N/M 通过」都有），所以只取
      // **最后一行**含「通过」或 PASS 的当作它自己的结论，纯粹给人看；判定一律以退出码为准。
      const line = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /通过|\bPASS\b/.test(l))
        .pop()
      done({
        file,
        code,
        ms: Date.now() - startedAt,
        text,
        summary: line ? line.slice(0, 46) : '',
      })
    })
  })
}

const results = []
for (const file of picked) {
  process.stdout.write(`  ${file.padEnd(34)} `)
  const r = await runOne(file)
  results.push(r)
  if (r.code === 0) {
    console.log(`ok  ${String(r.ms).padStart(6)}ms  ${r.summary}`)
  } else {
    console.log(`FAIL (exit ${r.code})  ${String(r.ms).padStart(6)}ms`)
  }
}

const failed = results.filter((r) => r.code !== 0)
console.log('')
if (failed.length) {
  for (const r of failed) {
    console.log(`── ${r.file} ───────────────────────────────────`)
    console.log(r.text.trimEnd().split('\n').slice(-40).join('\n'))
    console.log('')
  }
}
const totalMs = results.reduce((n, r) => n + r.ms, 0)
console.log(`${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 条失败` : ''}（合计 ${(totalMs / 1000).toFixed(1)}s）`)
process.exit(failed.length ? 1 : 0)
