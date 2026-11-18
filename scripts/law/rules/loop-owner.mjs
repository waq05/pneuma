/**
 * 铁律 3：新功能挂 cordis 扩展点，不改 `src/packages/session-core/loop.ts`。
 *
 * 判据：`git diff --name-only --diff-filter=ACMR -M <base>...HEAD` 命中该文件即违规。
 * base 由主入口解析（`--base` / `NUMA_LAW_BASE` / 缺省 `dev`）；拿不到 base 由主入口
 * 退 2 并提示 `fetch-depth: 0`，不许当「没改动」判 0。
 *
 * severity 为什么是 `warn`：历史 PR 无法回溯，先打两周 WARN 再转阻塞（设计 §Q2：
 * 从 2026-11-18 起两周，到 2026-12-02 改成 `error`）；这两周里只打印、不改退出码。
 *
 * @module scripts/law/rules/loop-owner
 */

/** 受保护文件（设计 §Q2 实测的真实路径；`src/core/session-core/loop.ts` 不存在）。 */
export const PROTECTED_FILE = 'src/packages/session-core/loop.ts'

function check(ctx) {
  const changedFiles = ctx.changedFiles
  const violations = changedFiles
    .filter((file) => file === PROTECTED_FILE)
    .map((file) => ({
      file,
      line: null,
      message: '铁律 3：新功能挂 cordis 扩展点，不改 loop.ts（新功能别往这一层塞）',
    }))
  return {
    violations,
    stats: { base: ctx.base, changedFiles: changedFiles.length, protectedHit: violations.length },
  }
}

export default {
  id: 'loop-owner',
  title: '不改 src/packages/session-core/loop.ts（新功能挂 cordis 扩展点）',
  severity: 'warn',
  check,
}
