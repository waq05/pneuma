/**
 * P6 的包级测试：worker 提示词从「一篇固定文件」改成「两卷可覆盖 + 主会话可存」。
 *
 * 七组用例，每组钉一件会「悄悄坏掉」的事：
 *   1. 默认两卷的来源都是 `default`，拼起来含工单占位符段与报告工具说明；
 *   2. 六个占位符都替换掉，正文里不留 `{{`；
 *   3. 在临时 `DSC_HOME` 里放一卷覆盖文件：那一卷来源变 `override`、文本就是写进去的，
 *      另一卷仍是 `default`；
 *   4. 包内文件读不到时两卷来源变 `fallback`，且兜底常量与源码树里的两卷 md 逐字一致
 *      （两层都测：兜底路径真的走通、常量与 md 真的没漂移）；
 *   5. `superagent_prompts_save` 正常写时文件真落盘、返回的 path 对；role 不认识 / text 空 /
 *      超 20000 字三种被拒且不落盘；
 *   6. `superagent_read` 的 `prompts` 资源两卷都在、`source` 字段对；
 *   7. worker 会话里调 `superagent_prompts_save` 被拒（主会话身份闸）。
 *
 * 第 5、6 组用真运行期（临时库 + 假执行器）：要证的是「工具 → 运行期 → 磁盘」这条链真的
 * 通，而不是假端口上的一次字符串比较。这里 import 的是 `lib/` 的构建产物，跑之前先
 * `pnpm run build`；`DSC_HOME` 指到 `tmpdir()` 下的临时目录，绝不碰用户真实的 `~/.dsc`。
 *
 * @module @pneuma/superagent/tests/prompts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'superagent-prompts-home-'))
process.env['DSC_HOME'] = home

const { buildWorkerPrompt, loadPromptVolumes } = await import('../../../../lib/packages/superagent/adapters/executor.js')
const { openStore } = await import('../../../../lib/packages/superagent/adapters/store.js')
const { SuperagentRuntime } = await import('../../../../lib/packages/superagent/runtime.js')
const { createMainTools } = await import('../../../../lib/packages/superagent/main-tools.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  rmSync(home, { recursive: true, force: true })
  console.log(`通过 ${passed}`)
})

/** 记一条通过的断言；失败照常抛给 node:test。 */
function ok(value, message) {
  assert.ok(value, message)
  passed += 1
}

/** 严格相等。 */
function equal(actual, expected, message) {
  assert.equal(actual, expected, message)
  passed += 1
}

/** 深比较（对象 / 数组）。 */
function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
  passed += 1
}

/** 异步拒绝：工具都是 async 的，抛错会变成 rejected promise。 */
async function rejects(promise, pattern, message) {
  await assert.rejects(promise, pattern, message)
  passed += 1
}

/** 固定时钟：断言不依赖「跑得快慢」。 */
const AT = '2026-01-01T00:00:00.000Z'

/** 主会话 id；工具只拿它问 `isWorkerSession`。 */
const MAIN_SESSION = 'session-main'

/** 一次工具调用的上下文（`ToolContext` 里工具真用到的几项）。 */
function ctxOf(sessionId = MAIN_SESSION) {
  return { cwd: '.', sessionId, sessionPath: '', signal: new AbortController().signal }
}

/** 一份固定的工单事实：占位符断言全按它算。 */
const INPUT = {
  title: '改登录页文案',
  body: '把「登录」按钮改成「进入」',
  branch: 'agent/fix-login-8f9a1c69',
  repo: join(tmpdir(), 'repo'),
  dir: join(tmpdir(), 'worktrees', 'fix-login-8f9a1c69'),
  blockedCommands: ['pnpm publish', 'git push'],
}

/** 六个占位符换完之后应该出现的那六段值。 */
const PLACEHOLDER_VALUES = [
  INPUT.title,
  INPUT.body,
  INPUT.branch,
  INPUT.repo,
  INPUT.dir,
  'pnpm publish、git push',
]

/** 源码树里的 md 正文：文件头注释剥掉、首尾空白去掉（与运行时读法同口径）。 */
function bodyOf(file) {
  return readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/^\uFEFF?\s*<!--[\s\S]*?-->/, '')
    .trim()
}

/** 临时换一个 `DSC_HOME`，跑完无论成败都换回来：覆盖相关的用例各自要一个干净的根。 */
async function withHome(work) {
  const previous = process.env['DSC_HOME']
  const root = mkdtempSync(join(tmpdir(), 'superagent-prompts-run-'))
  process.env['DSC_HOME'] = root
  try {
    return await work(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
    if (previous === undefined) delete process.env['DSC_HOME']
    else process.env['DSC_HOME'] = previous
  }
}

/**
 * 装一套真运行期跑完 `work`，结束时按「运行期 → 库」的顺序收尾。
 *
 * 注入假执行器：工具链路的用例不派工、不建会话，`commands()` 里的提示词读写已经够真。
 */
async function withRuntime(work) {
  const store = openStore()
  const runtime = new SuperagentRuntime(store, {
    now: () => AT,
    log: () => {},
    executor: { start() {}, deliver() {}, stop() {} },
  })
  try {
    return await work(runtime)
  } finally {
    runtime.close()
    store.close()
  }
}

/** 按名字建工具索引；`host` 每次现取，与 `index.ts` 的注册方式同形。 */
function toolsOf(host) {
  return new Map(createMainTools({ host: () => host }).map((tool) => [tool.name, tool]))
}

test('默认两卷：来源都是 default，拼起来含工单占位符段与报告工具说明', () => {
  const volumes = loadPromptVolumes()
  equal(volumes.shared.role, 'shared')
  equal(volumes.shared.source, 'default', '没存过覆盖文件时共用约定卷来自包内 md')
  equal(volumes.worker.role, 'worker')
  equal(volumes.worker.source, 'default', '没存过覆盖文件时执行者卷来自包内 md')
  ok(volumes.shared.text.includes('<工单>') && volumes.shared.text.includes('{{title}}'), '共用约定卷带工单占位符段')
  ok(volumes.worker.text.includes('<报告状态>'), '执行者卷带报告状态段')
  ok(volumes.worker.text.includes('superagent_report') && volumes.worker.text.includes('superagent_ack'), '报告工具说明在执行者卷')

  const prompt = buildWorkerPrompt(INPUT)
  ok(prompt.text.startsWith('你是超级智能体的执行者'), '拼起来的正文从共用约定卷第一句开始')
  ok(prompt.text.includes('<交付要求>') && prompt.text.includes('<报告状态>'), '两卷的内容都在最终提示词里')
  ok(
    prompt.text.indexOf('<交付要求>') < prompt.text.indexOf('<报告状态>'),
    '共用约定在前、执行者在后（顺序反了，工具说明会落在「交付要求」前面）',
  )
  deepEqual(prompt.sections.map((section) => section.id), ['superagent-shared', 'superagent-worker'], '两卷各一段')
  equal(prompt.sections[0].chars + prompt.sections[1].chars + 2, prompt.text.length, '两段字数 + 一个空行 = 正文长度')
})

test('占位符替换：六个都换掉，正文不留 {{', () => {
  const text = buildWorkerPrompt(INPUT).text
  for (const value of PLACEHOLDER_VALUES) {
    ok(text.includes(value), `占位符要换成实际值：${value}`)
  }
  ok(!text.includes('{{'), '六个占位符换完之后正文里不该再有 {{')
})

test('覆盖：临时 DSC_HOME 里放 shared.md，共用约定卷来源变 override，执行者卷仍是 default', async () => {
  await withHome(async (root) => {
    const dir = join(root, 'superagent', 'prompts')
    mkdirSync(dir, { recursive: true })
    const custom = '共用约定（覆盖版）\n\n<工单>\n标题：{{title}}\n</工单>'
    writeFileSync(join(dir, 'shared.md'), custom, 'utf8')

    const volumes = loadPromptVolumes()
    equal(volumes.shared.source, 'override', '覆盖文件存在时优先用它')
    equal(volumes.shared.text, custom, '读到的是写进去的那段（注释剥离后原样）')
    equal(volumes.worker.source, 'default', '没覆盖的那一卷不受影响')

    const prompt = buildWorkerPrompt(INPUT)
    ok(prompt.text.startsWith('共用约定（覆盖版）'), '拼装也走同一条读法：覆盖内容在最前面')
    ok(prompt.text.includes('标题：改登录页文案'), '覆盖卷里的占位符照样替换')
    equal(prompt.sections[0].chars, custom.replace('{{title}}', INPUT.title).length, '第一段的字数是覆盖卷渲染后的长度')
  })
})

test('兜底：包内文件读不到时两卷来源变 fallback，且常量与源码 md 逐字一致', () => {
  const missing = join(tmpdir(), `superagent-no-prompts-${process.pid}`, 'prompts')
  equal(existsSync(missing), false, '这个路径必须不存在，否则测的不是兜底')

  const volumes = loadPromptVolumes({ packageDir: missing })
  equal(volumes.shared.source, 'fallback')
  equal(volumes.worker.source, 'fallback')
  equal(volumes.shared.text, bodyOf('../prompts/shared.md'), '兜底常量与 shared.md 逐字一致')
  equal(volumes.worker.text, bodyOf('../prompts/worker.md'), '兜底常量与 worker.md 逐字一致')

  // 第二层：正常读到的包内 md 与兜底常量也一字不差（产物漏拷 md 时文案才不漂移）。
  const defaults = loadPromptVolumes({ overrideDir: missing })
  equal(defaults.shared.source, 'default')
  equal(defaults.worker.source, 'default')
  equal(defaults.shared.text, volumes.shared.text, '包内 shared.md 与兜底常量一致')
  equal(defaults.worker.text, volumes.worker.text, '包内 worker.md 与兜底常量一致')
})

test('superagent_prompts_save：正常写落盘、path 对；三种非法输入被拒且不落盘', async () => {
  await withHome(async (root) => {
    await withRuntime(async (runtime) => {
      const byName = toolsOf(runtime.commands())
      const save = byName.get('superagent_prompts_save')
      equal(save.risk, 'write', '存提示词是写操作')
      const dir = join(root, 'superagent', 'prompts')

      await rejects(save.run({ role: 'nope', text: '随便一段' }, ctxOf()), /role 只能是/, 'role 不认识要拒')
      await rejects(save.run({ role: 'shared', text: '   ' }, ctxOf()), /text 不能为空/, 'text 空要拒')
      await rejects(
        save.run({ role: 'worker', text: '一'.repeat(20_001) }, ctxOf()),
        /最多 20000 字/,
        '超过 20000 字要拒',
      )
      equal(existsSync(dir), false, '三种被拒的调用一个文件都没落盘')

      const body = '共用约定（人工改过）\n\n<工单>\n标题：{{title}}\n</工单>'
      const out = JSON.parse((await save.run({ role: 'shared', text: body }, ctxOf())).text)
      equal(out.role, 'shared', '返回里带卷名')
      equal(out.chars, [...body].length, 'chars 按码点算')
      equal(out.path, join(dir, 'shared.md'), '返回的 path 就是覆盖文件的位置')
      equal(readFileSync(out.path, 'utf8'), body, '原样落盘（占位符也留着）')
      equal(loadPromptVolumes().shared.source, 'override', '存完再读，来源立刻变成 override')
    })
  })
})

test('superagent_read 的 prompts 资源：两卷都在、source 字段对', async () => {
  await withHome(async () => {
    await withRuntime(async (runtime) => {
      const body = '覆盖后的共用约定\n<工单>\n标题：{{title}}\n</工单>'
      runtime.commands().savePrompt('shared', body)
      const byName = toolsOf(runtime.commands())
      const out = JSON.parse((await byName.get('superagent_read').run({ resource: 'prompts' }, ctxOf())).text)
      equal(out.roles.length, 2, '两卷都在')
      deepEqual(out.roles.map((volume) => volume.role), ['shared', 'worker'], '顺序固定：共用约定 → 执行者')
      equal(out.roles[0].source, 'override', '存过覆盖的那一卷来源是 override')
      equal(out.roles[0].text, body, '读回来的是模板原文（占位符没被替换）')
      equal(out.roles[0].chars, [...body].length, 'chars 是这一卷的字数')
      equal(out.roles[1].source, 'default', '没覆盖的那一卷来源是 default')
      ok(out.roles[1].text.includes('superagent_report'), '执行者卷的全文也读得到')
    })
  })
})

test('主会话身份闸：worker 会话里调 superagent_prompts_save 被拒', async () => {
  let saved = 0
  const host = {
    isWorkerSession: (sessionId) => sessionId === 'session-worker',
    savePrompt() {
      saved += 1
      return { role: 'shared', path: '/never/written' }
    },
  }
  const save = toolsOf(host).get('superagent_prompts_save')
  await rejects(
    save.run({ role: 'shared', text: '偷偷改提示词' }, ctxOf('session-worker')),
    /只在主会话里可用/,
    'worker 会话里不能改提示词',
  )
  equal(saved, 0, '被拒时一次 savePrompt 都没调')
})
