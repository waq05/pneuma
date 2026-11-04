/**
 * Win32 的字符串入参口径（全仓库唯一一份）。
 *
 * Win32 的 `PCWSTR` / `str16` 要的是 NUL 结尾的 UTF-16 缓冲；不结尾时 API 会
 * 一路读到未映射内存。`sandbox/win/acl.ts` 与 `sandbox/win/runner-entry.ts`
 * 此前各写了一份逐字相同的实现。
 *
 * @module dsc/core/sandbox/win/utf16
 */

/** 任意字符串 → NUL 结尾的 UTF-16 缓冲（Win32 的 str16 入参口径）。 */
export function utf16Buffer(text: string): Buffer {
  const buffer = Buffer.alloc(text.length * 2 + 2)
  buffer.write(text, 0, 'utf16le')
  return buffer
}
