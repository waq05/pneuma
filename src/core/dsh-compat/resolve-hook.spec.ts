/**
 * dsh 兼容解析钩子的代数戳与注册前置（`core/dsh-compat/resolve-hook.ts`）。
 *
 * 不在这里真的 import 插件（那会把全局 hooks 装进测试进程）；钉的是可观察的约定：
 * 代数从 0 起、每次换代 +1；缺应用根时注册要响亮失败；重复登记不抛。
 *
 * @module dsc/core/dsh-compat/resolve-hook.spec
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  bumpGeneration,
  currentGeneration,
  ensureResolveHook,
  registerGenerationRoot,
  setResolveHookAppRoot,
} from './resolve-hook.js'

describe('代数戳', () => {
  test('0 代是启动态，每次 bump +1', () => {
    expect(currentGeneration()).toBe(0)
    expect(bumpGeneration()).toBe(1)
    expect(currentGeneration()).toBe(1)
    expect(bumpGeneration()).toBe(2)
  })
})

describe('ensureResolveHook 的前置与幂等', () => {
  test('缺应用根：抛一句说清怎么办', () => {
    expect(() => ensureResolveHook([])).toThrow(/缺少应用安装目录/)
  })

  test('登记空目录不抛；注册一次之后再调只追加解析根', () => {
    const app = mkdtempSync(join(tmpdir(), 'dsc-resolve-hook-'))
    setResolveHookAppRoot(app)
    expect(() => registerGenerationRoot('')).not.toThrow()
    expect(() => registerGenerationRoot(join(app, 'lib', 'packages', 'x'))).not.toThrow()
    expect(() => ensureResolveHook([join(app, 'plugins')], app)).not.toThrow()
    expect(() => ensureResolveHook([join(app, 'other')], app)).not.toThrow()
  })
})
