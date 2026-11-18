#!/usr/bin/env node
/**
 * `scripts/law-check.mjs` 的自测：8 条断言，全部在 mkdtempSync 的临时 git 仓库里做，
 * 跑完删掉（不碰真实检出、不碰 ~/.dsc）。
 *
 * 用 `--root <临时仓库>` 让检查器扫临时仓库；`--root` 是 test-only 参数。
 * 断言从 ① 到 ⑧ 对应设计 §Q2「自测」那行的七条 + F2 补的第八条：
 *   ① 干净仓库 → 0；② src/core 里 import 'react' → 1 且点名行号；
 *   ③ ui 包 channel.invoke('不存在的方法') → 1；④ desktop protocol.invoke('nope') → 1；
 *   ⑤ 动态调用未登记 → 1；⑥ 无 .git → 2；⑦ --stats 分项之和 = 总数；
 *   ⑧ TSX 文本里的撇号（Don't）不许遮掉同一行的非法 `.invoke`。
 *
 * 输出：每条 PASS/FAIL；失败打印期望 vs 实际与复现命令，最后按失败数退 0/1。
 *
 * @module scripts/law-test
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CHECKER = path.join(HERE, 'law-check.mjs')
const WHITELIST = "export const INVOKABLE_METHODS = ['submit', 'listModels'] as const\n"
const BASE_DIRS = ['desktop/electron', 'ui-shell/src', 'remote-web/src', 'src/core', 'src/packages']

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function put(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text, 'utf8')
}

/** 造一个临时仓库：基线提交在 dev 分支上，当前分支是 feat（这样 base=dev 能解析）。 */
function makeRepo({ withGit = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'numa-law-'))
  for (const dir of BASE_DIRS) fs.mkdirSync(path.join(root, dir), { recursive: true })
  put(root, 'src/core/host-methods.ts', WHITELIST)
  put(root, 'README.md', '# fixture\n')
  if (withGit) {
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'law-test@example.invalid'])
    git(root, ['config', 'user.name', 'law-test'])
    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'fixture'])
    git(root, ['branch', '-M', 'dev'])
    git(root, ['checkout', '-qb', 'feat'])
  }
  return root
}

function run(root, args = []) {
  const result = spawnSync(process.execPath, [CHECKER, '--root', root, ...args], { encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function failing(assertion, root, context) {
  const detail = assertion instanceof Error ? assertion.message : String(assertion)
  throw new Error(`${context}\n  实际：${detail}\n  临时仓库：${root}（已删；复现：node scripts/law-check.mjs --root <临时目录>）`)
}

const CASES = [
  [
    '① 干净仓库 → 0，且 --json 可 JSON.parse',
    () => {
      const root = makeRepo()
      try {
        put(root, 'src/packages/ui-boot/ui/ok.tsx', "export const ok = (channel) => channel.invoke('submit')\n")
        put(root, 'desktop/electron/main/ok.ts', "export const ok = (protocol) => protocol.invoke('submit')\n")
        const result = run(root)
        assert.equal(result.code, 0, `期望退 0，实际 ${result.code}：${result.err}`)
        const json = run(root, ['--json'])
        assert.equal(json.code, 0, `--json 期望退 0，实际 ${json.code}：${json.err}`)
        const payload = JSON.parse(json.out)
        assert.equal(payload.ok, true)
        assert.deepEqual(payload.rules.map((rule) => rule.status), ['pass', 'pass', 'pass'])
      } catch (error) {
        failing(error, root, '① 干净仓库应通过')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  ],
  [
    "② src/core/x.ts 里 import 'react' → 1 且点名行号",
    () => {
      const root = makeRepo()
      try {
        put(root, 'src/core/x.ts', "import 'react'\nexport const x = 1\n")
        const result = run(root)
        assert.equal(result.code, 1, `期望退 1，实际 ${result.code}`)
        assert.match(result.out, /src\/core\/x\.ts:1/i, '失败输出要点名 src/core/x.ts:1')
        assert.match(result.out, /src\/contract 或事件/, '失败输出要给出改法')
      } catch (error) {
        failing(error, root, '② 注释/字符串之外的 import 必须报')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  ],
  [
    "③ ui 包 channel.invoke('not.exist') → 1",
    () => {
      const root = makeRepo()
      try {
        put(root, 'src/packages/ui-x/ui/x.tsx', "export const x = (channel) => channel.invoke('not.exist')\n")
        const result = run(root)
        assert.equal(result.code, 1, `期望退 1，实际 ${result.code}`)
        assert.match(result.out, /src\/packages\/ui-x\/ui\/x\.tsx:1/)
        assert.match(result.out, /not\.exist/)
      } catch (error) {
        failing(error, root, '③ 白名单外的方法必须报')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  ],
  [
    "④ desktop/electron protocol.invoke('nope') → 1",
    () => {
      const root = makeRepo()
      try {
        put(root, 'desktop/electron/main/x.ts', "export const x = (protocol) => protocol.invoke('nope')\n")
        const result = run(root)
        assert.equal(result.code, 1, `期望退 1，实际 ${result.code}`)
        assert.match(result.out, /desktop\/electron\/main\/x\.ts:1/)
        assert.match(result.out, /nope/)
      } catch (error) {
        failing(error, root, '④ desktop 侧白名单外的方法必须报')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  ],
  [
    '⑤ 动态调用未登记 → 1',
    () => {
      const root = makeRepo()
      try {
        put(root, 'src/packages/ui-x/ui/x.tsx', "export const x = (channel, method, args) => channel.invoke(method, args)\n")
        const result = run(root)
        assert.equal(result.code, 1, `期望退 1，实际 ${result.code}`)
        assert.match(result.out, /动态调用未登记/)
        assert.match(result.out, /manual-confirm\.json/)
      } catch (error) {
        failing(error, root, '⑤ 首参非字面量的调用必须逼着登记')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  ],
  [
    '⑥ 无 .git → 2（工具错误，不是「没改动」当通过）',
    () => {
      const root = makeRepo({ withGit: false })
      try {
        const result = run(root)
        assert.equal(result.code, 2, `期望退 2，实际 ${result.code}`)
        assert.match(result.err, /git/i)
      } catch (error) {
        failing(error, root, '⑥ 没有 git 时必须退 2')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  ],
  [
    '⑦ --stats 分项之和 = 总数',
    () => {
      const root = makeRepo()
      try {
        put(
          root,
          'src/packages/ui-x/ui/x.tsx',
          [
            "export const a = (channel) => channel.invoke('submit')",
            "export const b = (native) => native.invoke('pickDirectory')",
            'export const c = (channel, method) => channel.invoke(method, [])',
            '',
          ].join('\n'),
        )
        put(root, 'desktop/electron/main/x.ts', "export const d = (protocol) => protocol.invoke('submit')\n")
        put(root, 'desktop/electron/main/y.ts', "export const e = (ipcRenderer) => ipcRenderer.invoke('dsc:x')\n")
        put(
          root,
          'scripts/law/manual-confirm.json',
          `${JSON.stringify(
            [{ file: 'src/packages/ui-x/ui/x.tsx', line: 3, reason: '自测夹具：转发一名动态方法', owner: 'test' }],
            null,
            2,
          )}\n`,
        )
        const result = run(root, ['--json', '--stats'])
        assert.equal(result.code, 0, `期望退 0，实际 ${result.code}：${result.err}`)
        const payload = JSON.parse(result.out)
        const stats = payload.rules.find((rule) => rule.id === 'whitelist').stats
        const receiverSum = Object.values(stats.byReceiver).reduce((sum, n) => sum + n, 0)
        assert.equal(stats.partitionSum, stats.total, `分项之和 ${stats.partitionSum} ≠ 总数 ${stats.total}`)
        assert.equal(receiverSum + stats.dynamic + stats.unclassified, stats.total)
        const text = run(root, ['--stats'])
        assert.match(text.out, /分项之和 5 = 总数 5/)
      } catch (error) {
        failing(error, root, '⑦ --stats 的计数必须自洽')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  ],
  [
    "⑧ TSX 文本里的撇号（Don't）不遮掉同一行的非法 .invoke",
    () => {
      const root = makeRepo()
      try {
        put(
          root,
          'src/packages/ui-x/ui/x.tsx',
          "export const a = () => <p>Don't <button onClick={() => channel.invoke('no.apos')}>x</button></p>\n",
        )
        const result = run(root)
        assert.equal(result.code, 1, `期望退 1，实际 ${result.code}：${result.err}`)
        assert.match(result.out, /src\/packages\/ui-x\/ui\/x\.tsx:1/, '必须点名第 1 行')
        assert.match(result.out, /no\.apos/, '必须报出被撇号遮住的非法方法名')
      } catch (error) {
        failing(error, root, '⑧ JSX 文本撇号不能把同行的 .invoke 遮掉')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  ],
]

let passed = 0
let failed = 0
for (const [title, fn] of CASES) {
  try {
    fn()
    passed++
    process.stdout.write(`PASS ${title}\n`)
  } catch (error) {
    failed++
    process.stdout.write(`FAIL ${title}\n  ${String(error?.message ?? error).split('\n').join('\n  ')}\n`)
  }
}
process.stdout.write(`\n${passed} PASS / ${failed} FAIL（临时仓库已清理）\n`)
process.exitCode = failed === 0 ? 0 : 1
