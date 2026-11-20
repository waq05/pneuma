/**
 * `core/plugin-npm.ts`：`spawn` 同步抛错，以及子进程 `error` 事件（起不来的可执行文件）。
 *
 * 真机上这两条只会在「可执行文件坏了 / 解释器被拦」时出现，没法稳定制造，所以把
 * `node:child_process.spawn` 换成两种确定性假实现；被测的解析、回滚、文案仍是真代码。
 *
 * @module dsc/core/w14b-plugin-npm-spawn.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { EventEmitter as NodeEventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

/** 假 spawn 的行为：同步抛 / 异步 error 事件。 */
const control = vi.hoisted(() => ({ mode: 'throw' as 'throw' | 'error' }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  return {
    ...actual,
    spawn: () => {
      if (control.mode === 'throw') {
        throw Object.assign(new Error('spawn 同步失败'), { code: 'EINVAL' })
      }
      const child = new EventEmitter() as NodeEventEmitter & {
        stdout: NodeEventEmitter
        stderr: NodeEventEmitter
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      setImmediate(() => {
        child.emit('error', Object.assign(new Error('找不到可执行文件'), { code: 'ENOENT' }))
      })
      return child
    },
  }
})

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14b-npm-spawn-'))
process.env['DSC_HOME'] = HOME

type Npm = typeof import('./plugin-npm.js')
let npm: Npm

beforeAll(async () => {
  npm = await import('./plugin-npm.js')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5 })
})

beforeEach(() => {
  control.mode = 'throw'
})

/** 建一个带 package.json 的 profile，返回目录与原文。 */
function profile(name: string): { dir: string; original: string } {
  const dir = join(HOME, name)
  mkdirSync(dir, { recursive: true })
  const original = JSON.stringify({ name: 'p', dsh: { profile: { bundles: [] } } }, null, 2) + '\n'
  writeFileSync(join(dir, 'package.json'), original, 'utf8')
  return { dir, original }
}

/** 一个真实存在的 .cjs：解析出 pnpm 后走 node 起脚本那一路。 */
function fakePnpm(): string {
  const file = join(HOME, 'pnpm.cjs')
  writeFileSync(file, 'process.exit(0)\n', 'utf8')
  return file
}

describe('runPnpm：spawn 同步抛错', () => {
  test('安装失败并带上错误码；package.json 原样还原', async () => {
    const { dir, original } = profile('sync-throw')
    const outcome = await npm.installNpmBundle('any-pkg', { profileDir: dir, pnpmPath: fakePnpm() })
    expect(outcome.ok).toBe(false)
    expect(outcome.restored).toBe(true)
    expect(outcome.detail).toContain('没能启动 pnpm（EINVAL）')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(original)
  })
})

describe('runPnpm：子进程 error 事件', () => {
  test('起不来的解释器：按 ENOENT 说「找不到 pnpm」，清单还原', async () => {
    control.mode = 'error'
    const { dir, original } = profile('async-error')
    const outcome = await npm.installNpmBundle('any-pkg', { profileDir: dir, pnpmPath: fakePnpm() })
    expect(outcome.ok).toBe(false)
    expect(outcome.restored).toBe(true)
    expect(outcome.detail).toContain('找不到 pnpm')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(original)
  })
})
