/**
 * 字符串小判定（全仓库唯一一份）。
 *
 * 两个函数，各自此前抄了两三份：
 * - `splitList`：把「逗号或空白分隔」的配置串拆成数组（中英文逗号都认），
 *   生命周期钩子的白名单、浏览器插件的域名清单、computer-use 的允许应用清单都用它；
 * - `nonEmptyString`：把 `unknown` 收成「非空字符串」，空串、纯空白、非字符串一律当没给。
 *
 * @module dsc/core/strings
 */

/** 拆逗号 / 空白分隔的清单（中英文逗号都认），空项丢掉。 */
export function splitList(text: string): string[] {
  return text
    .split(/[,，\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/** 非空字符串才要，其余（含非字符串、纯空白）当没给。 */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
