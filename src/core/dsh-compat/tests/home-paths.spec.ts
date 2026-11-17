/**
 * dsh 家目录兼容层（`core/dsh-compat/shims/home-paths.ts`）：dsc 家目录与 dsh 家目录的映射、
 * 优先级（显式 → 环境变量 → 默认根）、`~` 展开、显示口径与监视路径的 realpath 规范化。
 *
 * 隔离：`DSC_HOME` / `HOME` / `USERPROFILE` 全部指向 `mkdtempSync` 的临时目录，并且**在
 * import 之前**设好（`path-policy` 在模块求值时就把 `DSC_HOME` 算成了常量）。`$DSH_HOME`
 * 与 `$DSH_AGENTS_HOME` 必须删掉：它们是被测模块的合法输入（`shims/home-paths.ts:81` /
 * `:91` 的默认参数直接读 `process.env`），宿主设了就会让「环境变量未设、回落默认根」这类
 * 断言测到真实主目录而不是临时目录——本机 `DSH_HOME=C:\Users\waq\.dsh` 曾让本文件稳定红。
 * 收尾还原全部五个环境变量；临时目录删除容忍 Windows 上的 EPERM（句柄还没放开）。
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

/**
 * 被测模块会读的全部环境变量，一个都不能少：
 * - `DSC_HOME`：`path-policy.ts:20` 在模块求值时算成常量，import 前必须设好；
 * - `DSH_HOME` / `DSH_AGENTS_HOME`：`shims/home-paths.ts:26` / `:35` 定义、`:81` / `:91`
 *   的默认参数读 `process.env`；
 * - `HOME` / `USERPROFILE`：`os.homedir()` 在 POSIX / Windows 各认一个。
 * 少收一个，宿主设了它就会漏进断言——`DSH_HOME` 正是本文件曾经稳定红的原因。
 */
const savedEnv = {
  DSC_HOME: process.env['DSC_HOME'],
  DSH_HOME: process.env['DSH_HOME'],
  DSH_AGENTS_HOME: process.env['DSH_AGENTS_HOME'],
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
}
process.env['DSC_HOME'] = DSC_HOME
process.env['HOME'] = HOME
process.env['USERPROFILE'] = HOME
// 删掉而不是设成假值：本文件要验「环境变量没设时回落默认根」，设成假值会把那条用例
// 变成「环境变量生效」的又一次重复，反而测不到回退分支。
delete process.env['DSH_HOME']
delete process.env['DSH_AGENTS_HOME']

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

  test('不传 env 时也按同一条优先级：$DSH_HOME 压过默认根，显式参数再压过 $DSH_HOME', () => {
    // 文档：`shims/home-paths.ts:76`「优先级：显式路径 → $DSH_HOME → ~/.dsc」（模块头注释
    // `:5-6` 同一条）。上面那条用例只验了显式传进来的 env 表；默认参数走的是 `process.env`
    // （`:81`），`dshHomePath()` 内部就靠它——这里补上，免得宿主环境变量再次无声漏进来。
    // 场景：DSC_HOME（本文件里是临时目录 B）作默认根，DSH_HOME 指向 A。
    const fromEnv = join(ROOT, 'env-dsh-home')
    const saved = process.env['DSH_HOME']
    process.env['DSH_HOME'] = fromEnv
    try {
      // 环境变量压过默认根 B。
      expect(hp.resolveDshHome()).toBe(resolve(fromEnv))
      // 拼路径的公开入口吃的是同一份解析结果。
      expect(hp.dshHomePath('x')).toBe(join(resolve(fromEnv), 'x'))
      expect(hp.dshCachePath()).toBe(join(resolve(fromEnv), 'cache'))
      // 显示口径跟着说「是环境变量覆盖过的」。
      expect(hp.dshHomeDisplay(resolve(fromEnv))).toBe('$DSH_HOME')
      // 显式参数最优先：即便环境变量指向 A，显式给的 C 仍然赢。
      expect(hp.resolveDshHome(join(ROOT, 'configured'))).toBe(resolve(ROOT, 'configured'))
    } finally {
      if (saved === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = saved
    }
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
