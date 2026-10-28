/**
 * 安全序列化（全仓库唯一一份）。
 *
 * `JSON.stringify` 遇到循环引用、BigInt、函数会抛；这条路上抛出来会连累整个
 * 界面帧或原生命令的应答。两处（原生桥、界面方法）此前各包了一个 try/catch，
 * 合并到这里，口径固定成「序列化不了就 null」。
 *
 * @module dsc/core/json-text
 */

/** 一段 JSON 文本；序列化不了（循环引用、BigInt、函数）给 null。 */
export function jsonText(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null
  } catch {
    return null
  }
}
