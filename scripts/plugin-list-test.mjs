/**
 * `numa plugin list` 自检：应用自带的 74 行（53 个功能包 + 21 个界面单元）、开关、
 * 以及「这一行现在到底用的是哪份代码」。
 *
 * 为什么要单独一条：这一屏是用户唯一能看见「应用里装了什么、哪一行停了、哪一行被我换过」
 * 的地方。它读的是磁盘（`@pneuma/base` 的 patch + 每个包的 package.json），最容易在
 * 包搬家、改名、改字段之后悄悄跟产物漂移——那正是 0.8.1 的老毛病。
 *
 * 覆盖只在「这个 profile 真的生效」时才算数：`--profile 别的目录` 只影响列清单，
 * 内核仍用 activeProfileDir，两边不能显示成一样。
 *
 * 运行：pnpm build && node scripts/plugin-list-test.mjs
 *
 * @module dsc/scripts/plugin-list-test
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repo = fileURLToPath(new URL('..', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'numa-list-'))

/** 应用版本：pinned 的行显示的是它（不是包自己的版本）。读清单，改版本号时这里不用跟着改。 */
const appVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version

let pass = 0
let fail = 0
const check = (label, ok, extra) => {
  if (ok) {
    pass += 1
    console.log('PASS  ' + label)
    return
  }
  fail += 1
  console.log('FAIL  ' + label + (extra === undefined || extra === '' ? '' : ' → ' + String(extra)))
}

/** 在某个 profile 里放一份「改过的」包（只写清单，这一屏只用得到它）。 */
function putPackage(profileDir, name, manifest) {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', exports: { '.': './index.js' }, ...manifest }, null, 2))
}

/** 造一个 profile。 */
function makeProfile(name) {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pneuma-profile', private: true, dsh: { profile: { bundles: [] } } }, null, 2))
  return dir
}

/** 跑一次 `numa plugin list`。 */
function list(args) {
  const result = spawnSync(process.execPath, [join(repo, 'bin', 'dsc.js'), 'plugin', 'list', ...args], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DSC_HOME: home, DSC_PROFILE: '', DSC_UI_SERVER: '0' },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const active = makeProfile('default')
// todo 是 overridable：profile 里装一份改过的，就该按 profile 那份显示
putPackage(active, '@pneuma/todo', { version: '9.9.9', pneuma: { title: '待办清单（我改过的）' } })
// waiting 是 pinned：profile 里的同名副本不生效，显示应用那份
putPackage(active, '@pneuma/waiting', { version: '8.8.8', pneuma: { title: '不该出现' } })
// spill 的覆盖版要求下一代契约：这一行启动时会被版本闸跳过，列表要如实说
putPackage(active, '@pneuma/spill', { version: '6.6.6', engines: { pneuma: '>=2.0.0' }, pneuma: { title: '要求下一代契约的长输出转存' } })

const run = list([])
check('命令正常退出', run.status === 0, 'exit ' + String(run.status) + ' / ' + run.stderr.slice(0, 200))
const lines = run.stdout.split('\n')
const rows = lines.filter((line) => /^ {2}\S+ {2,}v\S+ +(开|关) /.test(line))
check('列出了 74 行（应用自带的全部功能与界面单元）', rows.length === 74, String(rows.length))
check('表头写了行数', /（74 行）/.test(run.stdout), lines[0])
const rowOf = (id) => rows.find((line) => line.trimStart().startsWith(id + ' ')) ?? ''
check('每一行都带开关', rows.every((line) => / (开|关) /.test(line)), JSON.stringify(rows.filter((line) => !/ (开|关) /.test(line)).slice(0, 3)))
check('默认关的行显示为关', / 开 /.test(rowOf('browser')) === false && / 关 /.test(rowOf('browser')), rowOf('browser'))
check('默认开的行显示为开', / 开 /.test(rowOf('todo')), rowOf('todo'))
check('overridable 的行显示 profile 那份的版本', rowOf('todo').includes('v9.9.9'), rowOf('todo'))
check('overridable 的行标了「profile 覆盖」', rowOf('todo').includes('← profile 覆盖'), rowOf('todo'))
check('pinned 的行仍显示应用的版本', rowOf('waiting').includes('v' + appVersion) && !rowOf('waiting').includes('v8.8.8'), rowOf('waiting'))
check('pinned 的行说明了副本为什么不生效', /pinned 不生效/.test(rowOf('waiting')), rowOf('waiting'))
check('版本闸不过的行标出来了', /版本闸不过/.test(rowOf('spill')) && rowOf('spill').includes('>=2.0.0'), rowOf('spill'))
check('汇总行数对得上', /其中 2 行用的是 profile 里的覆盖版/.test(run.stdout), lines.filter((line) => line.includes('其中')).join(' | '))

// --profile 指到别的目录：只列那个目录，但覆盖不算数（内核不会用它）
const other = makeProfile('other')
putPackage(other, '@pneuma/todo', { version: '7.7.7', pneuma: { title: '别的 profile 里的待办' } })
const otherRun = list(['--profile', 'other'])
const otherRows = otherRun.stdout.split('\n').filter((line) => /^ {2}\S+ {2,}v\S+ +(开|关) /.test(line))
const otherTodo = otherRows.find((line) => line.trimStart().startsWith('todo ')) ?? ''
check('--profile 指到别处时仍列出 74 行', otherRows.length === 74, String(otherRows.length))
check('--profile 指到别处时不算覆盖（仍显示应用版本）', otherTodo.includes('v' + appVersion), otherTodo)
check('--profile 指到别处时不打「profile 覆盖」', !otherRun.stdout.includes('← profile 覆盖'), otherTodo)

console.log('')
console.log(pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
