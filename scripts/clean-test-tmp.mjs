#!/usr/bin/env node
/**
 * 手动清理测试临时目录（`pnpm run clean:test-tmp`）。
 *
 * ## 为什么单独一份，不 import `tests/support/tmp-clean.ts`
 *
 * 那个模块是 TypeScript，脚本要能直接 `node` 跑，就得带 `--experimental-strip-types`
 * 之类的旗标，而旗标随 Node 版本变（engines 是 >=22.19）。手动清理是低频动作，
 * 重复这二十行比引入一条版本敏感的启动路径划算。两边的判定口径一致：
 * 只认系统临时目录下、名字以 `dsc-` 开头、且不是软链接的目录。
 *
 * ## 与测试收尾的分工
 *
 * 测试跑完的正常收尾在 `tests/support/tmp-dir.ts`；过期清扫在
 * `tests/setup/global-clean.ts`。这个脚本是「现在就清，不管年龄」的手动入口，
 * 用于开发机磁盘告警、或想立刻确认清干净时。
 *
 * 用完即走，不改任何仓库文件。
 */
import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'dsc-'
const root = tmpdir()

/** 递归算大小；算不出来按 0 计（不影响删除）。 */
function sizeOf(dir) {
  let sum = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) sum += sizeOf(path)
      else if (entry.isFile()) sum += lstatSync(path).size
    }
  } catch {
    return 0
  }
  return sum
}

let removed = 0
let failed = 0
let bytes = 0

for (const name of readdirSync(root)) {
  if (!name.startsWith(PREFIX)) continue
  const dir = join(root, name)
  try {
    const info = lstatSync(dir)
    if (info.isSymbolicLink() || !info.isDirectory()) continue
    const size = sizeOf(dir)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    removed += 1
    bytes += size
  } catch (error) {
    failed += 1
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`删不掉：${dir}（${reason}）`)
  }
}

const mb = (bytes / 1024 / 1024).toFixed(1)
if (removed === 0 && failed === 0) {
  console.log(`没有可清理的临时目录（${root}）`)
} else {
  console.log(`清理完成：${removed} 个目录，释放 ${mb} MB；失败 ${failed} 个`)
}
// 有删不掉的就以非 0 退出，便于脚本/CI 判断。
process.exitCode = failed > 0 ? 1 : 0
