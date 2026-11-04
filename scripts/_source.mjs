/**
 * 源码直读探针的取源助手：顺着转发桩找到真文件。
 *
 * 为什么需要：内核的实现按域搬进 `src/packages/<id>/` 之后，`src/core/<x>.ts` 只剩一行
 * `export * from '../packages/<id>/<x>.js';`（转发桩，保证运行时只有一份实例）。
 * 但有一类探针断言的是**实现文本**（"这一行还在不在""有没有多出一个 import"），
 * 它们读的就是 `src/core/<x>.ts`。桩只有一行，断言会全部变成假失败。
 *
 * 所以这里把桩跟到底（多层转发也跟），拿到真文件的文本与路径。断言写的内容一个字不用改，
 * 探针的语义也没变：它要钉的还是那份实现。
 *
 * `importSource` 供直读 .ts 的探针用（Node 类型擦除），拿到的是真文件 URL —— 桩里的
 * 目标是编译口径的 `.js`，Node 不会把它回落到 `.ts`，所以必须在这里换。
 *
 * @module dsc/scripts/_source
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 项目根（本文件在 scripts/ 下）。 */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 转发桩的形状：整份文件只有一行再导出。 */
const STUB = /^\s*export \* from '(\.[^']+)';?\s*$/

/** 桩里的路径是编译口径（.js），源码盘上是 .ts —— 先认盘上的真名。 */
function realFile(from, specifier) {
  const target = resolve(dirname(from), specifier)
  if (existsSync(target)) return target
  const asTs = target.replace(/\.js$/, '.ts')
  return asTs
}

/**
 * 读一份源码；若它是转发桩，就跟到真文件。
 * @param {string} rel 相对项目根的路径，如 'src/core/tools/bash.ts'
 * @returns {string} 真文件全文
 */
export function readSource(rel) {
  return resolveSource(rel).text
}

/**
 * 同 `readSource`，但返回落点信息，供需要报路径的探针用。
 * @param {string} rel 相对项目根的路径
 * @returns {{ path: string, text: string }}
 */
export function resolveSource(rel) {
  let file = resolve(REPO_ROOT, rel)
  for (let hop = 0; hop < 8; hop += 1) {
    const text = readFileSync(file, 'utf8')
    const hit = STUB.exec(text)
    if (hit === null) return { path: file, text }
    file = realFile(file, hit[1])
  }
  throw new Error(`${rel}: 转发桩连跟 8 层都没到底，检查是不是环`)
}

/**
 * 动态 import 一份源模块；是转发桩就跟到真文件再 import。
 * @param {string} rel 相对项目根的路径
 * @returns {Promise<any>} 模块命名空间
 */
export function importSource(rel) {
  return import(pathToFileURL(resolveSource(rel).path).href)
}
