/**
 * 清单快照闸：把「现在有哪些插件 / 设置分区 / 界面单元」与入库的快照逐项比。
 *
 * 为什么要有它：`plugin-inventory.mjs` 能导出一份清单，但没人比就没有意义。改造期间
 * 靠人眼 diff 三份 JSON 的结果是「哪次少了一行没人发现」。这个脚本把对比做成门禁：
 * 少的、多的、字段变了的，一条一条列出来，非零退出。
 *
 * 快照文件：`docs/baseline/0.9.0/inventory.json`（0.9 = 功能包化之后的样子；
 * 0.8.1 那份留在原地，用于对照「改造前后差了什么」）。
 *
 * 用法：
 *   node scripts/plugin-inventory-check.mjs            # 比，不一致就红
 *   node scripts/plugin-inventory-check.mjs --write    # 确认变化是有意的，重写快照
 *
 * @module scripts/plugin-inventory-check
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repo = fileURLToPath(new URL('..', import.meta.url))
const snapshotFile = join(repo, 'docs', 'baseline', '0.9.0', 'inventory.json')
const write = process.argv.includes('--write')

/** 起一遍清单脚本，拿它打印的 JSON（子进程：内核的 stdout 屏蔽不会污染这里）。 */
function currentInventory() {
  const result = spawnSync(process.execPath, [join(repo, 'scripts', 'plugin-inventory.mjs')], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 300_000,
    // 环境里的 profile 不该改变快照（子进程里也会再删一次，这里先挡一道）
    env: { ...process.env, DSC_PROFILE: '' },
  })
  if (result.status !== 0) {
    console.error('清单脚本没跑成功（exit ' + String(result.status) + '）：')
    console.error((result.stderr ?? '').slice(0, 2000))
    process.exit(2)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    console.error('清单脚本的输出不是 JSON（前面几行）：')
    console.error((result.stdout ?? '').slice(0, 400))
    process.exit(2)
  }
}

/**
 * 比两组「有 id 的对象」。
 * @param label - 打印用的名字
 * @param key - 主键字段
 * @param expected - 快照里的
 * @param actual - 现在的
 * @returns 差异行（空数组 = 一致）
 */
function compareList(label, key, expected, actual) {
  const diffs = []
  const byKey = (list) => new Map(list.map((item) => [item[key], item]))
  const want = byKey(Array.isArray(expected) ? expected : [])
  const have = byKey(Array.isArray(actual) ? actual : [])
  for (const id of want.keys()) {
    if (!have.has(id)) diffs.push(label + '：少了「' + id + '」')
  }
  for (const [id, now] of have) {
    const before = want.get(id)
    if (before === undefined) {
      diffs.push(label + '：多了「' + id + '」')
      continue
    }
    for (const field of Object.keys(now)) {
      const a = JSON.stringify(before[field] ?? null)
      const b = JSON.stringify(now[field] ?? null)
      if (a !== b) diffs.push(label + '：' + id + '.' + field + ' 从 ' + a + ' 变成 ' + b)
    }
    for (const field of Object.keys(before)) {
      if (!(field in now)) diffs.push(label + '：' + id + '.' + field + ' 没了（快照里是 ' + JSON.stringify(before[field]) + '）')
    }
  }
  return diffs
}

const current = currentInventory()
if (write) {
  mkdirSync(dirname(snapshotFile), { recursive: true })
  writeFileSync(snapshotFile, JSON.stringify(current, null, 2) + '\n', 'utf8')
  console.log(
    '已重写快照 ' + snapshotFile + '：' + String(current.plugins.length) + ' 个插件 / ' +
      String(current.sections.length) + ' 个设置分区 / ' + String(Array.isArray(current.ui) ? current.ui.length : 0) + ' 个界面单元',
  )
  process.exit(0)
}

let expected
try {
  expected = JSON.parse(readFileSync(snapshotFile, 'utf8'))
} catch (error) {
  console.error('快照读不了（' + snapshotFile + '）：' + (error instanceof Error ? error.message : String(error)))
  console.error('先跑一次 node scripts/plugin-inventory-check.mjs --write 生成它。')
  process.exit(2)
}

const diffs = [
  ...compareList('插件', 'file', expected.plugins, current.plugins),
  ...compareList('设置分区', 'id', expected.sections, current.sections),
  ...compareList('界面单元', 'id', expected.ui, current.ui),
]
if (expected.version !== current.version) diffs.push('清单格式版本从 ' + String(expected.version) + ' 变成 ' + String(current.version))

if (diffs.length === 0) {
  console.log(
    '清单一致：' + String(current.plugins.length) + ' 个插件 / ' + String(current.sections.length) +
      ' 个设置分区 / ' + String(Array.isArray(current.ui) ? current.ui.length : 0) + ' 个界面单元',
  )
  process.exit(0)
}
console.log('清单与快照不一致（' + String(diffs.length) + ' 处）：')
for (const line of diffs) console.log('  ' + line)
console.log('')
console.log('确认这次变化是有意的：node scripts/plugin-inventory-check.mjs --write')
process.exit(1)
