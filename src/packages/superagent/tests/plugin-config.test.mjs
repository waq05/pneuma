/**
 * @pneuma/superagent 插件配置的包级测试：测包入口导出的 `legacyPluginKeys` 纯函数。
 *
 * 钉的是「哪些旧键算数、哪些不算」：用户从旧版升级后 `plugins.json` 里还留着
 * `repoPath` / `ticketTimeoutSeconds` / `confirmInferred` / `githubTokenEnv` 四个键，
 * 本版一个都不读；漏报等于改了配置没反应，多报等于新键也被当成废弃键吓唬用户。
 * 只挑这四个，顺序固定；本版读的键（`stateDir` 等）和无关键都不算，非对象输入当没配。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { legacyPluginKeys } = await import('../../../../lib/packages/superagent/index.js')

let passed = 0

test('只挑四个旧插件配置键，本版读的键与无关键都不算', () => {
  // 全都给上：返回值按 lex 固定顺序，与输入里键的先后无关。
  assert.deepEqual(legacyPluginKeys({
    unrelated: 1,
    githubTokenEnv: 'GH_TOKEN',
    stateDir: '/srv/state',
    ticketTimeoutSeconds: 1800,
    promptMaxChars: 100_000,
    repoPath: '/srv/widgets',
    confirmInferred: true,
  }), ['repoPath', 'ticketTimeoutSeconds', 'confirmInferred', 'githubTokenEnv'])
  // 只有一部分旧键时只报命中的那些。
  assert.deepEqual(legacyPluginKeys({ githubTokenEnv: 'GH_TOKEN', repoPath: '/srv/widgets' }), ['repoPath', 'githubTokenEnv'])
  // 本版配置键一个都不算。
  assert.deepEqual(legacyPluginKeys({ stateDir: '/srv/state', promptMaxChars: 1, admissionContextMaxPages: 2 }), [])
  // 非对象输入（插件这一行可能压根没配置）当没配，不抛。
  for (const raw of [undefined, null, [], 'repoPath', 42, true]) assert.deepEqual(legacyPluginKeys(raw), [])
  // 键在就算命中，即使值为 undefined：用户写了键就想让旧实现生效。
  assert.deepEqual(legacyPluginKeys({ repoPath: undefined }), ['repoPath'])
  passed += 1
})

after(() => {
  console.log(`通过 ${passed}`)
})
