/**
 * 工具入参的两种收口：路径收成绝对路径、必填字符串当场校验。
 *
 * `fs-tools` 与 `image-tool` 各抄过一份，逐字相同。抄两份的代价不是体积，
 * 是报错文案会分叉——模型看到的 `path 必须是非空字符串` 如果在一个工具里变成别的说法，
 * 它下次猜的参数形状就跟着变。
 *
 * @module dsc/core/tools/path-args
 */
import { isAbsolute, resolve } from 'node:path'

/** 把工具收到的 `path` 参数收成绝对路径；空串与非字符串当场报错。 */
export function absPath(cwd: string, value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new Error('path 必须是非空字符串')
  return isAbsolute(value) ? value : resolve(cwd, value)
}

/** 必填字符串参数；缺了就用调用方给的字段名报错。 */
export function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`)
  return value
}
