/**
 * `core/plugin-npm.ts` 的缺口补齐：坏清单的宽松解析、Electron 当 node 的兜底、原生
 * `pnpm.exe` 直起、起不来的可执行文件留下的 spawn 错误。
 *
 * 假 pnpm 是一个真 node 脚本（同 `plugin-loader-extra.spec.ts` 的做法）：跑的是真实
 * `spawn` 路径，只是「pnpm 的行为」被脚本写死。`DSC_HOME` 指到临时目录。
 *
 * @module dsc/core/w14b-plugin-npm.spec
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14b-npm-'))
const WORK = join(HOME, 'work')
process.env['DSC_HOME'] = HOME
mkdirSync(WORK, { recursive: true })

type Npm = typeof import('./plugin-npm.js')
let npm: Npm

/** 正常假 pnpm：把包名写进 dependencies，并造出包目录与 patch；退出 0。 */
const FAKE_PNPM = join(HOME, 'fake-pnpm.cjs')
/** 坏清单假 pnpm：把 package.json 写成非法 JSON，退出 0。 */
const FAKE_PNPM_BAD = join(HOME, 'fake-pnpm-bad.cjs')

beforeAll(async () => {
  writeFileSync(
    FAKE_PNPM,
    [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      'const [cmd, spec] = process.argv.slice(2)',
      'const dir = process.cwd()',
      "const pkgFile = path.join(dir, 'package.json')",
      'const read = () => { try { return JSON.parse(fs.readFileSync(pkgFile, "utf8")) } catch { return {} } }',
      'const write = (value) => fs.writeFileSync(pkgFile, JSON.stringify(value, null, 2) + "\\n")',
      "if (cmd === 'add') {",
      '  const manifest = read()',
      "  const depName = spec.replace(/@[^@/]*$/, '')",
      "  manifest.dependencies = { ...(manifest.dependencies || {}), [depName]: '1.0.0' }",
      '  write(manifest)',
      "  const bundleDir = path.join(dir, 'node_modules', ...depName.split('/'))",
      '  fs.mkdirSync(bundleDir, { recursive: true })',
      "  fs.writeFileSync(path.join(bundleDir, 'package.json'), JSON.stringify({ name: depName, version: '1.2.3' }))",
      '  process.exit(0)',
      '}',
      'process.exit(0)',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    FAKE_PNPM_BAD,
    [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "const pkgFile = path.join(process.cwd(), 'package.json')",
      "fs.writeFileSync(pkgFile, '{不是 JSON')",
      'process.exit(0)',
      '',
    ].join('\n'),
    'utf8',
  )
  chmodSync(FAKE_PNPM, 0o755)
  chmodSync(FAKE_PNPM_BAD, 0o755)
  npm = await import('./plugin-npm.js')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5 })
})

/** 建一个 profile 目录（带 package.json）。 */
function profile(name: string): string {
  const dir = join(WORK, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: [] } } }), 'utf8')
  return dir
}

describe('parseManifest：pnpm 之后清单坏掉', () => {
  test('坏 JSON 当空对象，包名从 spec 猜得到，安装仍算成功并如实说读不到包', async () => {
    const dir = profile('bad-manifest')
    const outcome = await npm.installNpmBundle('some-pkg', { profileDir: dir, pnpmPath: FAKE_PNPM_BAD })
    expect(outcome.ok).toBe(true)
    expect(outcome.name).toBe('some-pkg')
    expect(outcome.detail).toContain('读不到它的 package.json')
    // 清单被重写成合法 JSON（坏内容随后被 to-bundles 那次写盘覆盖）。
    expect(() => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).not.toThrow()
  })
})

describe('nodeTarget：Electron 当 node 的兜底', () => {
  test('PATH 里找不到 node 且进程是 Electron：显式带 ELECTRON_RUN_AS_NODE', async () => {
    const dir = profile('electron-fallback')
    const savedPath = process.env['PATH']
    const versions = process.versions as Record<string, unknown>
    const hadElectron = 'electron' in versions
    delete process.env['PATH']
    versions['electron'] = '39.0.0'
    try {
      const outcome = await npm.installNpmBundle('electron-pkg', { profileDir: dir, pnpmPath: FAKE_PNPM })
      expect(outcome.ok).toBe(true)
      expect(outcome.name).toBe('electron-pkg')
    } finally {
      if (savedPath === undefined) delete process.env['PATH']
      else process.env['PATH'] = savedPath
      if (hadElectron) versions['electron'] = '39.0.0'
      else delete versions['electron']
    }
  })
})

describe('pnpmTarget：原生可执行文件直起', () => {
  test('路径是 .exe（不是 .cmd）：不经过 node、直接把文件交给 spawn', async () => {
    const dir = profile('native-exe')
    // process.execPath 是 node.exe：作为「pnpm」起必然参数不对而退出非零，正好走失败分支。
    const outcome = await npm.installNpmBundle('native-pkg', { profileDir: dir, pnpmPath: process.execPath })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('安装失败')
    expect(outcome.restored).toBe(true)
  })

  test('可执行文件起不来（不是有效 PE）：spawn 的 error 事件折成失败文案', async () => {
    const dir = profile('broken-exe')
    const broken = join(HOME, 'broken-pnpm.exe')
    writeFileSync(broken, 'not a real executable', 'utf8')
    const outcome = await npm.installNpmBundle('broken-pkg', { profileDir: dir, pnpmPath: broken })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('安装失败')
    expect(outcome.detail).toMatch(/没能启动 pnpm|找不到 pnpm/)
  })
})
