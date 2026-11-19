/**
 * `numa plugin list` 的集成用例（迁自 `scripts/plugin-list-test.mjs`）。
 *
 * 这一屏是用户唯一能看见「应用里装了什么、哪一行停了、哪一行被我换过」的地方。它读的是
 * 磁盘（`@pneuma/base` 的 patch + 每个包的 package.json），最容易在包搬家、改名、改字段
 * 之后悄悄跟产物漂移——那正是 0.8.1 的老毛病。
 *
 * ## 为什么走 `runCli` 而不是 import `plugin-cli.ts`
 *
 * 被测对象是**命令的输出**：列几行、每一行写什么、`--profile` 指别处时覆盖算不算数。
 * 直接调 `runCli(['plugin', 'list'])` 起的是一次真入口进程，命令行解析、环境变量读取、
 * 退出码全在断言范围内；import 内部函数只能测到「渲染函数被调过」，测不到用户看到什么。
 *
 * ## 覆盖只在「这个 profile 真的生效」时才算数
 *
 * `--profile 别的目录` 只影响列清单，内核仍用 activeProfileDir（`profile-dir.ts:24`）——
 * 两边不能显示成一样。这是本文件第三条用例钉的边界。
 *
 * ## 隔离
 *
 * `runCli` 每次建自己的临时 HOME 并删掉继承的 `DSC_HOME`；这里再显式传一份临时
 * `DSC_HOME`，profile 目录造在那底下。真实 `~/.dsc` 一个字节都不动。
 *
 * @module dsc/tests/integration/plugin-list.int.spec
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { runCli, tempHome, type RunCliResult } from '../../tests/harness.js'

/** 临时主目录；`DSC_HOME` 也落在这里，profile 目录由用例自己铺。 */
const home = tempHome('dsc-plugin-list-')
const DSC_HOME = join(home.home, '.dsc')

/** 应用版本：pinned 的行显示的是它（不是包自己的版本）。读清单，改版本号时这里不用跟着改。 */
const APP_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version

/** 一行清单的输出形状：`  <id>  v<版本>   <开|关> ...`。 */
const ROW_PATTERN = /^ {2}\S+ {2,}v\S+ +(开|关) /

/** 在某个 profile 里放一份「改过的」包（只写清单，这一屏只用得到它）。 */
function putPackage(profileDir: string, name: string, manifest: Record<string, unknown>): void {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, type: 'module', exports: { '.': './index.js' }, ...manifest }, null, 2),
  )
}

/** 造一个 profile；`default` 这份会被 activeProfileDir 认作当前生效的那一个。 */
function makeProfile(name: string): string {
  const dir = join(DSC_HOME, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'pneuma-profile', private: true, dsh: { profile: { bundles: [] } } }, null, 2),
  )
  return dir
}

/** 两次真入口调用的结果：「当前 profile」与 `--profile other`。 */
let run: RunCliResult
let otherRun: RunCliResult

beforeAll(async () => {
  const active = makeProfile('default')
  // todo 是 overridable：profile 里装一份改过的，就该按 profile 那份显示。
  putPackage(active, '@pneuma/todo', { version: '9.9.9', pneuma: { title: '待办清单（我改过的）' } })
  // waiting 是 pinned：profile 里的同名副本不生效，显示应用那份。
  putPackage(active, '@pneuma/waiting', { version: '8.8.8', pneuma: { title: '不该出现' } })
  // spill 的覆盖版要求下一代契约：这一行启动时会被版本闸跳过，列表要如实说。
  putPackage(active, '@pneuma/spill', {
    version: '6.6.6',
    engines: { pneuma: '>=2.0.0' },
    pneuma: { title: '要求下一代契约的长输出转存' },
  })

  const other = makeProfile('other')
  putPackage(other, '@pneuma/todo', { version: '7.7.7', pneuma: { title: '别的 profile 里的待办' } })

  const env = { DSC_HOME, DSC_PROFILE: '', DSC_UI_SERVER: '0' }
  run = await runCli(['plugin', 'list'], { env, timeoutMs: 120_000 })
  otherRun = await runCli(['plugin', 'list', '--profile', 'other'], { env, timeoutMs: 120_000 })
})

afterAll(() => {
  home.restore()
})

/** 输出里每一行清单行。 */
function rowsOf(result: RunCliResult): string[] {
  return result.stdout.split('\n').filter((line) => ROW_PATTERN.test(line))
}

/** 某一行（按行 id 找；行 id 是行首那一段）。 */
function rowOf(result: RunCliResult, id: string): string {
  return rowsOf(result).find((line) => line.trimStart().startsWith(`${id} `)) ?? ''
}

describe('① 清单本身：81 行、带开关、表头写了行数', () => {
  test('命令正常退出', () => {
    expect(run.code).toBe(0)
    expect(run.stderr.slice(0, 400)).toBe('')
  })

  test('列出了 81 行（应用自带的全部功能与界面单元）', () => {
    expect(rowsOf(run)).toHaveLength(81)
  })

  test('表头写了行数', () => {
    expect(run.stdout).toMatch(/（81 行）/)
  })

  test('每一行都带开关', () => {
    const withoutSwitch = rowsOf(run).filter((line) => !/ (开|关) /.test(line))
    expect(withoutSwitch).toEqual([])
  })

  test('默认关的行显示为关、默认开的行显示为开', () => {
    expect(rowOf(run, 'browser')).not.toMatch(/ 开 /)
    expect(rowOf(run, 'browser')).toMatch(/ 关 /)
    expect(rowOf(run, 'todo')).toMatch(/ 开 /)
  })
})

describe('② 覆盖与 pinned：这一行现在到底用的是哪份代码', () => {
  test('overridable 的行显示 profile 那份的版本，并标了「profile 覆盖」', () => {
    expect(rowOf(run, 'todo')).toContain('v9.9.9')
    expect(rowOf(run, 'todo')).toContain('← profile 覆盖')
  })

  test('pinned 的行仍显示应用的版本，并说明副本为什么不生效', () => {
    expect(rowOf(run, 'waiting')).toContain(`v${APP_VERSION}`)
    expect(rowOf(run, 'waiting')).not.toContain('v8.8.8')
    expect(rowOf(run, 'waiting')).toMatch(/pinned 不生效/)
  })

  test('版本闸不过的行标出来了（要求什么写清楚）', () => {
    expect(rowOf(run, 'spill')).toMatch(/版本闸不过/)
    expect(rowOf(run, 'spill')).toContain('>=2.0.0')
  })

  test('汇总行数对得上（2 行用 profile 覆盖版）', () => {
    expect(run.stdout).toMatch(/其中 2 行用的是 profile 里的覆盖版/)
  })
})

describe('③ --profile 指到别的目录：只列那个目录，覆盖不算数', () => {
  test('仍列出 81 行', () => {
    expect(rowsOf(otherRun)).toHaveLength(81)
  })

  test('不算覆盖：仍显示应用版本，也不打「profile 覆盖」', () => {
    expect(rowOf(otherRun, 'todo')).toContain(`v${APP_VERSION}`)
    expect(rowOf(otherRun, 'todo')).not.toContain('v7.7.7')
    expect(otherRun.stdout).not.toContain('← profile 覆盖')
  })
})
