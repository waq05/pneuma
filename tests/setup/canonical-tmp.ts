/**
 * 把 Windows 上的临时目录环境变量统一成**真实路径**（长名）。
 *
 * ## 为什么需要
 *
 * GitHub 的 Windows runner 把 `TEMP`/`TMP` 设成 8.3 短名：
 * `C:\Users\RUNNER~1\AppData\Local\Temp`。`os.tmpdir()` 原样返回它，测试于是拿短名
 * 造临时目录、写期望值；而路径策略（`path-policy` / `canonicalizePath` / `realpath`）
 * 一解析就成长名 `C:\Users\runneradmin\AppData\Local\Temp`。两串前缀对不上，表现为：
 *   - 「工作区内写」被判到工作区外（session-core 的 quiet 用例 deny 而不是 pass）；
 *   - junction 指到 `DSC_HOME` 认不出（path-policy 的必拦用例返回 null）；
 *   - `writeRootsFor` 的授权根里多一份短名副本（sandbox win-helpers）；
 *   - `canonicalizeWatchPath` 的期望路径对不上祖先的真实路径。
 * 2026-11-19 之前 Windows 车道那 12 条红全是这一个根因，本机（长名）看不出来。
 *
 * ## 为什么在 worker 启动时就改
 *
 * `os.tmpdir()` 每次都读环境变量，所以把环境变量换成真实路径之后，**所有**测试
 * （包括本仓库既有的 `mkdtempSync(join(tmpdir(), …))` 写法）拿到的都是长名，
 * 不需要逐个用例去 realpath。放在 `setupFiles` 里，保证先于任何测试文件加载。
 *
 * 只处理存在的变量：POSIX 上 `TMPDIR` 通常没设，`tmpdir()` 回落到 `/tmp`，不用管。
 * `realpathSync` 失败（变量指向不存在的目录）时保持原值——那是被测环境的原始状态，
 * 测试自己去报错，别在这里吞掉。
 *
 * @module dsc/tests/setup/canonical-tmp
 */
import { realpathSync } from 'node:fs'

for (const key of ['TEMP', 'TMP', 'TMPDIR'] as const) {
  const value = process.env[key]
  if (value === undefined || value.trim() === '') continue
  try {
    process.env[key] = realpathSync(value)
  } catch {
    // 指向的目录不存在：保留原值，让用例按原始环境报错。
  }
}
