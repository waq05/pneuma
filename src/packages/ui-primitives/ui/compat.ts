/**
 * 老内核缺的那几个标准方法的替身。
 *
 * 为什么要有这个模块：界面在**手机浏览器 / 老 WebView** 里也要能跑（远程页 `remote-web`
 * 就是给手机看的），而那些内核可能比桌面 Chromium 旧好几年。用一个「太新」的标准方法，
 * 报错不是「这块样式不对」而是 `xxx is not a function` 当场抛——一整块界面直接白掉。
 * 2026-10 那次手机报障留下的证据是 `AbortSignal.timeout is not a function`（Chromium 103 才有），
 * 说明对面的内核确实停在 2022 年前后。
 *
 * 边界写在 `docs/development.md` 的「浏览器底线」一节：**不许直接用**这几个
 * （要就加到这里来）——`AbortSignal.timeout` / `AbortSignal.any`、`Array.prototype.findLast` /
 * `findLastIndex`、`Array.prototype.toSorted` / `toReversed` / `with`、`structuredClone`、
 * `Object.groupBy`、`Promise.withResolvers`。`scripts/ui-legacy-compat-test.mjs` 会扫源码把这条钉住。
 *
 * 更旧、已经到处在用的那几个（`?.` / `??`、`String.replaceAll`、`Array.prototype.at`、
 * `Intl.Segmenter`——最后一个在用的地方自带 `typeof` 兜底）算在底线之内，不在此列。
 *
 * @module dsc-ui-shell/ui-primitives/compat
 */

/**
 * `Array.prototype.findLast` 的替身（Chromium 97 才有）。
 *
 * 签名与标准一致，带类型谓词重载：调用处的 `row is Row & {…}` 收窄照旧成立，
 * 否则改用它反而要到处补断言。
 */
export function findLast<T, S extends T>(
  list: readonly T[],
  test: (item: T, index: number) => item is S,
): S | undefined
export function findLast<T>(list: readonly T[], test: (item: T, index: number) => boolean): T | undefined
export function findLast<T>(
  list: readonly T[],
  test: (item: T, index: number) => boolean,
): T | undefined {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i]
    if (test(item, i)) return item
  }
  return undefined
}
