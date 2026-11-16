/**
 * dsh 家目录兼容层（`core/dsh-compat/shims/home-paths.ts`）：dsc 家目录与 dsh 家目录的映射、
 * 优先级（显式 → 环境变量 → 默认根）、`~` 展开、显示口径与监视路径的 realpath 规范化。
 *
 * 隔离：`DSC_HOME` / `HOME` / `USERPROFILE` 全部指向 `mkdtempSync` 的临时目录，并且**在
 * import 之前**设好（`path-policy` 在模块求值时就把 `DSC_HOME` 算成了常量）。收尾恢复
 * 三个环境变量；临时目录删除容忍 Windows 上的 EPERM（句柄还没放开）。
 *
 * @module dsc/core/dsh-compat/tests/home-paths.spec
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

const ROOT = mkdtempSync(join(tmpdir(), 'dsc-home-paths-'))
const HOME = join(ROOT, 'home')
const DSC_HOME = join(ROOT, 'dsc-home')
mkdirSync(HOME, { recursive: true })
mkdirSync(DSC_HOME, { recursive: true })

const savedEnv = {
  DSC_HOME: process.env['DSC_HOME'],
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
}
process.env['DSC_HOME'] = DSC_HOME
process.env['HOME'] = HOME
process.env['USERPROFILE'] = HOME

const hp = await import('../shims/home-paths.js')

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 上目录可能还被句柄占着：留给系统清，不让收尾拖红测试。
  }
})

describe('默认根与常量', () => {
  test('dsc 家目录顶替 dsh 家目录；共享配置根仍是 ~/.agents', () => {
    expect(hp.DSH_HOME_DIR_NAME).toBe('.dsc')
    expect(hp.DEFAULT_DSH_HOME_DISPLAY).toBe('~/.dsc')
    expect(hp.DSH_HOME_ENV).toBe('DSH_HOME')
    expect(hp.AGENTS_HOME_DIR_NAME).toBe('.agents')
    expect(hp.DEFAULT_AGENTS_HOME_DISPLAY).toBe('~/.agents')
    expect(hp.AGENTS_HOME_ENV).toBe('DSH_AGENTS_HOME')

    expect(hp.defaultDshHome()).toBe(resolve(DSC_HOME))
    expect(hp.defaultAgentsHome()).toBe(join(homedir(), '.agents'))
  })
})

describe('解析优先级与 ~ 展开', () => {
  test('resolveDshHome：显式配置 > $DSH_HOME > 默认根；空白环境变量等于没设', () => {
    expect(hp.resolveDshHome(join(ROOT, 'configured'), { DSH_HOME: join(ROOT, 'from-env') })).toBe(
      resolve(ROOT, 'configured'),
    )
    expect(hp.resolveDshHome(undefined, { DSH_HOME: join(ROOT, 'from-env') })).toBe(resolve(ROOT, 'from-env'))
    expect(hp.resolveDshHome(undefined, {})).toBe(resolve(DSC_HOME))
    expect(hp.resolveDshHome(undefined, { DSH_HOME: '   ' })).toBe(resolve(DSC_HOME))
  })

  test('resolveDshHome：~、~/x、~\\x 都展开到真实主目录', () => {
    expect(hp.resolveDshHome('~', {})).toBe(resolve(homedir()))
    expect(hp.resolveDshHome('~/nested', {})).toBe(resolve(join(homedir(), 'nested')))
    expect(hp.resolveDshHome('~\\nested', {})).toBe(resolve(join(homedir(), 'nested')))
    expect(hp.resolveDshHome('relative-dir', {})).toBe(resolve('relative-dir'))
    expect(hp.resolveDshHome('~/nested', { DSH_HOME: join(ROOT, 'ignored') })).toBe(
      resolve(join(homedir(), 'nested')),
    )
  })

  test('resolveAgentsHome：同一套优先级，环境变量是 $DSH_AGENTS_HOME', () => {
    expect(hp.resolveAgentsHome(join(ROOT, 'agents'), { DSH_AGENTS_HOME: join(ROOT, 'from-env') })).toBe(
      resolve(ROOT, 'agents'),
    )
    expect(hp.resolveAgentsHome(undefined, { DSH_AGENTS_HOME: join(ROOT, 'from-env') })).toBe(
      resolve(ROOT, 'from-env'),
    )
    expect(hp.resolveAgentsHome(undefined, {})).toBe(resolve(join(homedir(), '.agents')))
    expect(hp.resolveAgentsHome(undefined, { DSH_AGENTS_HOME: '~/agents' })).toBe(
      resolve(join(homedir(), 'agents')),
    )
  })
})

describe('拼路径与显示口径', () => {
  test('dshHomePath 拼在 dsc 家目录下；dshCachePath 两种调用形状都认', () => {
    expect(hp.dshHomePath()).toBe(resolve(DSC_HOME))
    expect(hp.dshHomePath('a', 'b')).toBe(join(resolve(DSC_HOME), 'a', 'b'))

    // 字符串形式 = 第一个路径段（拼在 cache 下）。
    expect(hp.dshCachePath()).toBe(join(resolve(DSC_HOME), 'cache'))
    expect(hp.dshCachePath('x', 'y')).toBe(join(resolve(DSC_HOME), 'cache', 'x', 'y'))
    // 对象形式 = 显式根覆盖。
    expect(hp.dshCachePath({ dshHome: join(ROOT, 'explicit') }, 'k')).toBe(
      join(resolve(ROOT, 'explicit'), 'cache', 'k'),
    )
    expect(hp.dshCachePath({}, 'k')).toBe(join(resolve(DSC_HOME), 'cache', 'k'))
  })

  test('display：默认根给 ~ 写法，覆盖过的给环境变量名', () => {
    expect(hp.dshHomeDisplay(resolve(DSC_HOME))).toBe('~/.dsc')
    expect(hp.dshHomeDisplay(join(ROOT, 'other'))).toBe('$DSH_HOME')
    expect(hp.agentsHomeDisplay(resolve(join(homedir(), '.agents')))).toBe('~/.agents')
    expect(hp.agentsHomeDisplay(join(ROOT, 'other'))).toBe('$DSH_AGENTS_HOME')
  })
})

describe('canonicalizeWatchPath', () => {
  test('已存在的路径走 realpath；缺失的尾段原样拼回已规范化的祖先', async () => {
    const dir = join(ROOT, 'watch')
    mkdirSync(dir, { recursive: true })
    const real = realpathSync(dir)

    expect(await hp.canonicalizeWatchPath(dir)).toBe(real)
    expect(await hp.canonicalizeWatchPath(join(dir, 'missing', 'file.txt'))).toBe(
      join(real, 'missing', 'file.txt'),
    )
    expect(await hp.canonicalizeWatchPath(join(dir, 'a', 'b', 'c'))).toBe(join(real, 'a', 'b', 'c'))
  })

  test('非 ENOENT 的失败原样抛出（不吞成「最深祖先」那个假答案）', async () => {
    // NUL 在 Windows/Linux 上都是非法参数（ERR_INVALID_ARG_VALUE），不是 ENOENT。
    await expect(hp.canonicalizeWatchPath(join(ROOT, `bad${String.fromCharCode(0)}name`))).rejects.toThrow()

    // 最深祖先是个文件而不是目录：realpath 成功、opendir 失败（ENOTDIR），也要抛。
    const file = join(ROOT, 'plain.txt')
    writeFileSync(file, 'x', 'utf8')
    await expect(hp.canonicalizeWatchPath(join(file, 'child'))).rejects.toThrow()
  })
})
