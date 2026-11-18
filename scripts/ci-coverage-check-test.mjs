/**
 * `ci-coverage-check.mjs` 的自测：九个临时目录 fixture。
 *
 * 每个用例在系统临时目录里造一份假仓库（`package.json` + `scripts/gate.json` +
 * `scripts/gate-manual.json` + `.github/workflows/verify.yml`），用 `--root` 指过去跑，
 * 只比对退出码与报告里点名的关键字。九例对应设计 §Q3 的自测清单（第 8 例补 YAML 注释，
 * 第 9 例钉 `NUMA_GATE_DISABLE` 与 `--json` 的 stdout 边界）：
 *   1. 全绿 0（顺带验 `--json` 可解析、`--json --remind` 不污染 stdout、NUMA_GATE_DISABLE 退 0）
 *   2. `check:zzz` 未登记 1
 *   3. 登记了没跑（push 门禁不在 workflow 里）1
 *   4. 台账过期 1
 *   5. `gate.json` 坏 JSON 2
 *   6. cmd 反查不到 2（未知命令形态）
 *   7. `check:all:legacy` 不判孤儿 0
 *   8. push 门禁的 run 行被 YAML 注释掉 1（注释不算跑过，守剥注释那段回归）
 *   9. `NUMA_GATE_DISABLE=ci-coverage` + `--json`：退 0、stdout 可 parse、`skipped=true`
 *
 * 子进程的输出重定向到临时文件，不建命名管道：受限运行环境不允许管道，写文件两条路都能跑
 * （同 `scripts/check-p0.mjs` 的口径）。
 *
 * 用法：`node scripts/ci-coverage-check-test.mjs`；退出 0 = 全过，1 = 有用例失败。
 *
 * @module dsc/scripts/ci-coverage-check-test
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHECKER = resolve(dirname(fileURLToPath(import.meta.url)), 'ci-coverage-check.mjs')

const GREEN_PKG = () => ({
  name: 'fixture',
  version: '0.0.0',
  scripts: {
    'check:all': 'pnpm run check:ui && pnpm run check:style',
    'check:ui': 'node scripts/check-ui.mjs',
    'check:style': 'node scripts/style-check.mjs',
  },
})
const GREEN_GATES = () => ({
  version: 1,
  gates: {
    style: { cmd: 'pnpm run check:style', timeoutMs: 60000, stage: ['push'], needs: [] },
    ui: { cmd: 'pnpm run check:ui', timeoutMs: 600000, stage: ['nightly'], needs: [] },
  },
})
const GREEN_LEDGER = () => ({ version: 1, entries: {} })
const GREEN_WORKFLOW = ['on: [push]', 'jobs:', '  verify:', '    steps:', '      - run: pnpm run check:style', '      - run: pnpm run check:ui', ''].join('\n')

/** 造一份假仓库，返回 { dir, repo, dispose }。 */
function makeRepo({ pkg = GREEN_PKG(), gates = GREEN_GATES(), ledger = GREEN_LEDGER(), workflow = GREEN_WORKFLOW, rawGateJson } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-coverage-test-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  writeFileSync(join(repo, 'scripts', 'gate.json'), rawGateJson ?? JSON.stringify(gates, null, 2) + '\n')
  writeFileSync(join(repo, 'scripts', 'gate-manual.json'), JSON.stringify(ledger, null, 2) + '\n')
  writeFileSync(join(repo, '.github', 'workflows', 'verify.yml'), workflow)
  return { dir, repo, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 跑核对脚本；stdout/stderr 分开落临时文件（不用管道），并给出合并文本方便断言。 */
function runChecker(repo, extraArgs = [], envOverride = {}) {
  const base = join(repo, '..', `checker-${process.pid}-${Math.random().toString(16).slice(2)}`)
  const outFile = `${base}-out.txt`
  const errFile = `${base}-err.txt`
  const outFd = openSync(outFile, 'w')
  const errFd = openSync(errFile, 'w')
  let result
  try {
    result = spawnSync(process.execPath, [CHECKER, '--root', repo, ...extraArgs], {
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env, ...envOverride },
    })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  const stdout = readFileSync(outFile, 'utf8')
  const stderr = readFileSync(errFile, 'utf8')
  rmSync(outFile, { force: true })
  rmSync(errFile, { force: true })
  return { status: result.status, stdout, stderr, text: stdout + stderr }
}

const cases = [
  {
    name: '全绿退 0，--json 可 JSON.parse，--remind 不污染 JSON，NUMA_GATE_DISABLE 跳过',
    run() {
      const fixture = makeRepo()
      try {
        const human = runChecker(fixture.repo)
        assert.equal(human.status, 0, `期望退出 0，实际 ${human.status}\n${human.text}`)
        assert.match(human.text, /通过/)

        const json = runChecker(fixture.repo, ['--json'])
        assert.equal(json.status, 0, `--json 期望退出 0，实际 ${json.status}`)
        const report = JSON.parse(json.text)
        assert.equal(report.ok, true)
        assert.equal(report.gates.total, 2)
        assert.equal(report.errors.length, 0)

        // --json 与 --remind 叠加：stdout 仍只有一份 JSON，提醒条数进 remind 字段。
        const jsonRemind = runChecker(fixture.repo, ['--json', '--remind'])
        assert.equal(jsonRemind.status, 0, `--json --remind 期望退出 0，实际 ${jsonRemind.status}\n${jsonRemind.text}`)
        const remindReport = JSON.parse(jsonRemind.text)
        assert.ok(Object.hasOwn(remindReport, 'remind'), '--remind 的条数应进 JSON 的 remind 字段')

        // 统一回退开关（05-acceptance.md §6）：命中就跳过、打一行、退 0，不许静默。
        const disabled = runChecker(fixture.repo, [], { NUMA_GATE_DISABLE: 'probe-inventory,ci-coverage' })
        assert.equal(disabled.status, 0, `NUMA_GATE_DISABLE 命中期望退出 0，实际 ${disabled.status}\n${disabled.text}`)
        assert.match(disabled.text, /已按 NUMA_GATE_DISABLE 跳过 ci-coverage/)
      } finally {
        fixture.dispose()
      }
    },
  },
  {
    name: 'check:zzz 未登记退 1 并点名',
    run() {
      const pkg = GREEN_PKG()
      pkg.scripts['check:zzz'] = 'node scripts/lint.mjs'
      const fixture = makeRepo({ pkg })
      try {
        const result = runChecker(fixture.repo)
        assert.equal(result.status, 1, `期望退出 1，实际 ${result.status}\n${result.text}`)
        assert.match(result.text, /check:zzz/)
      } finally {
        fixture.dispose()
      }
    },
  },
  {
    name: '登记了没跑（push 门禁不在 workflow）退 1',
    run() {
      const gates = GREEN_GATES()
      gates.gates.ui.stage = ['push']
      const workflow = ['on: [push]', 'jobs:', '  verify:', '    steps:', '      - run: pnpm run check:style', ''].join('\n')
      const fixture = makeRepo({ gates, workflow })
      try {
        const result = runChecker(fixture.repo)
        assert.equal(result.status, 1, `期望退出 1，实际 ${result.status}\n${result.text}`)
        assert.match(result.text, /门禁「ui」/)
      } finally {
        fixture.dispose()
      }
    },
  },
  {
    name: '台账过期退 1',
    run() {
      const ledger = GREEN_LEDGER()
      ledger.entries['check:gone'] = { kind: 'manual', reason: '已删脚本', ref: 'package.json:1' }
      const fixture = makeRepo({ ledger })
      try {
        const result = runChecker(fixture.repo)
        assert.equal(result.status, 1, `期望退出 1，实际 ${result.status}\n${result.text}`)
        assert.match(result.text, /台账过期/)
      } finally {
        fixture.dispose()
      }
    },
  },
  {
    name: 'gate.json 坏 JSON 退 2',
    run() {
      const fixture = makeRepo({ rawGateJson: '{ this is not json' })
      try {
        const result = runChecker(fixture.repo)
        assert.equal(result.status, 2, `期望退出 2，实际 ${result.status}\n${result.text}`)
        assert.match(result.text, /不是合法 JSON/)
      } finally {
        fixture.dispose()
      }
    },
  },
  {
    name: 'cmd 反查不到退 2（未知命令形态）',
    run() {
      const gates = GREEN_GATES()
      gates.gates.style.cmd = 'node scripts/nope.mjs'
      const fixture = makeRepo({ gates })
      try {
        const result = runChecker(fixture.repo)
        assert.equal(result.status, 2, `期望退出 2，实际 ${result.status}\n${result.text}`)
        assert.match(result.text, /未知命令形态/)
      } finally {
        fixture.dispose()
      }
    },
  },
  {
    name: 'check:all:legacy 不判孤儿，退 0',
    run() {
      const pkg = GREEN_PKG()
      pkg.scripts['check:all:legacy'] = 'pnpm run check:all'
      const fixture = makeRepo({ pkg })
      try {
        const result = runChecker(fixture.repo)
        assert.equal(result.status, 0, `期望退出 0，实际 ${result.status}\n${result.text}`)
        assert.doesNotMatch(result.text, /check:all:legacy/)
      } finally {
        fixture.dispose()
      }
    },
  },
  {
    name: 'workflow 里注释掉的 run 行不算跑过，退 1',
    run() {
      const gates = GREEN_GATES()
      gates.gates.ui.stage = ['push']
      const workflow = ['on: [push]', 'jobs:', '  verify:', '    steps:', '      - run: pnpm run check:style', '      # - run: pnpm run check:ui', ''].join('\n')
      const fixture = makeRepo({ gates, workflow })
      try {
        const result = runChecker(fixture.repo)
        assert.equal(result.status, 1, `期望退出 1，实际 ${result.status}\n${result.text}`)
        assert.match(result.text, /门禁「ui」/)
      } finally {
        fixture.dispose()
      }
    },
  },
  {
    name: 'NUMA_GATE_DISABLE + --json：stdout 仍是纯 JSON 且 skipped=true',
    run() {
      const fixture = makeRepo()
      try {
        const result = runChecker(fixture.repo, ['--json'], { NUMA_GATE_DISABLE: 'ci-coverage' })
        assert.equal(result.status, 0, `期望退出 0，实际 ${result.status}\n${result.text}`)
        // 只 parse stdout：人读跳过行必须走 stderr，不能混进 JSON。
        const report = JSON.parse(result.stdout)
        assert.equal(report.skipped, true)
        assert.equal(report.gate, 'ci-coverage')
        assert.equal(report.reason, 'NUMA_GATE_DISABLE')
        assert.match(result.stderr, /已按 NUMA_GATE_DISABLE 跳过 ci-coverage/)
        // stdout 从第一个字符就是 JSON（人读那一行不在 stdout 开头；message 字段里允许带同一句话）。
        assert.ok(result.stdout.trimStart().startsWith('{'), `stdout 应以 JSON 开头，实际：\n${result.stdout}`)
      } finally {
        fixture.dispose()
      }
    },
  },
]

let passed = 0
let failed = 0
for (const testCase of cases) {
  try {
    testCase.run()
    passed += 1
    console.log(`PASS ${testCase.name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${testCase.name}`)
    console.log(
      String(error?.message ?? error)
        .split('\n')
        .map((line) => `     ${line}`)
        .join('\n'),
    )
  }
}

console.log(`\n${passed} PASS / ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
