/**
 * 包级测试闸：跑 `src/packages/<id>/tests/*.test.mjs`，一个文件起一个 Node 进程。
 *
 * 为什么要有它：仓库级探针（`scripts/*-test.mjs`，由 check-core / check-ui 自动发现）
 * 测的是「整套内核装配起来之后」的行为，改一个包的内部逻辑得先想起该跑哪条探针。
 * 包级测试把「这个包自己的契约」钉在包里面，改哪个包就跑哪个包的 tests/。
 *
 * 发现规则（只认一条）：
 *   src/packages/<id>/tests/*.test.mjs —— 每个文件一条用例，文件名以 .test.mjs 结尾；
 *   没有 tests/ 目录的包不算，有目录但没 .test.mjs 的也不算。
 * 进程隔离：每个文件 spawn 一个独立的 node，cwd 是仓库根，失败按退出码判定
 *   （文件里打印的「通过 N」只当断言计数，不当判据）；任一文件非零退出，本闸退出 1。
 * 产物依赖：测试 import 的是 lib/ 下的编译结果，跑之前先 `pnpm run build`。
 * 接在 package.json 的 check:plugin 里、plugin-standard-check 之后。
 *
 * 分工边界（写测试的人照这个切）：
 *   包级测试只测这个包自己的东西——导出的插件对象、工具 schema、注册/销毁、纯函数、
 *   设置分区的字段与默认值、package.json 与 cordis.patch.yml 的声明；
 *   凡是需要整套内核才成立的事（会话、模型、磁盘上的 ~/.dsc、真窗口、跨包联动），
 *   一律不写在这里，留在 scripts/ 的集成探针里，那些才是它们的主场。
 *
 * 用法：
 *   node scripts/package-tests.mjs          # 全部
 *   node scripts/package-tests.mjs --list   # 只列会跑哪些文件
 *   单个文件：node src/packages/<id>/tests/<name>.test.mjs
 *
 * @module dsc/scripts/package-tests
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packagesDir = join(root, 'src', 'packages')

/** 单条用例的上限：包级测试只摸本包，超过这个数说明它偷偷去干集成的活了。 */
const CASE_TIMEOUT_MS = 120_000

/** 按目录扫一遍：`src/packages/<id>/tests/*.test.mjs`，文件名升序。 */
function collect() {
  const cases = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const testsDir = join(packagesDir, entry.name, 'tests')
    if (!existsSync(testsDir) || !statSync(testsDir).isDirectory()) continue
    for (const file of readdirSync(testsDir).filter((name) => name.endsWith('.test.mjs')).sort()) {
      cases.push({ pkg: entry.name, file: `src/packages/${entry.name}/tests/${file}` })
    }
  }
  return cases.sort((a, b) => a.file.localeCompare(b.file))
}

/** 跑一个文件：独立进程、独立 stdout/stderr，超时就杀掉。 */
function runOne(file) {
  return new Promise((done) => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, [join(root, file)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    const timer = setTimeout(() => {
      child.kill()
      out += `\n[runner] 超过 ${String(CASE_TIMEOUT_MS)}ms，被中止\n`
    }, CASE_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      // 断言数只从文件最后一行「通过 N」里取；判据始终是退出码。
      const line = out
        .split('\n')
        .map((row) => row.trim())
        .filter((row) => /^通过 \d+/.test(row))
        .pop()
      const assertions = line === undefined ? 0 : Number(/^通过 (\d+)/.exec(line)[1])
      done({ file, code, ms: Date.now() - startedAt, out, assertions })
    })
  })
}

const cases = collect()

if (process.argv.slice(2).includes('--list')) {
  for (const item of cases) console.log(item.file)
  process.exit(0)
}

if (cases.length === 0) {
  console.error('没找到任何包级测试（src/packages/<id>/tests/*.test.mjs）')
  process.exit(1)
}

if (!existsSync(join(root, 'lib', 'packages'))) {
  console.error('缺少构建产物 lib/packages：包级测试 import 的是 lib/ 下的编译结果，先跑 pnpm run build')
  process.exit(1)
}

const failed = []
let passed = 0
let assertions = 0
let totalMs = 0

const columnWidth = Math.max(...cases.map((item) => item.file.length)) + 2

for (const item of cases) {
  process.stdout.write(`  ${item.file.padEnd(columnWidth)} `)
  const result = await runOne(item.file)
  assertions += result.assertions
  totalMs += result.ms
  if (result.code === 0) {
    passed += 1
    console.log(`ok  ${String(result.ms).padStart(6)}ms  ${result.assertions} 断言`)
  } else {
    failed.push(result)
    console.log(`FAIL（退出码 ${String(result.code)}）  ${String(result.ms).padStart(6)}ms`)
  }
}

if (failed.length > 0) {
  console.log('')
  for (const result of failed) {
    console.log(`── ${result.file} ───────────────────────────────`)
    console.log(result.out.trimEnd().split('\n').slice(-25).join('\n'))
    console.log('')
  }
}

const packageCount = new Set(cases.map((item) => item.pkg)).size
console.log(`${String(packageCount)} 个包 / ${String(cases.length)} 个用例 / 通过 ${String(passed)} 失败 ${String(failed.length)}`)
console.log(`（共 ${String(assertions)} 条断言，合计 ${(totalMs / 1000).toFixed(1)}s）`)
process.exit(failed.length === 0 ? 0 : 1)
