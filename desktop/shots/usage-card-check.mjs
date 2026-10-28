/**
 * 「会话用量」卡对齐 dsh 的直测（0.6.49 报障：这个卡的字段口径和 dsh 不一致）。
 *
 * 被标的实现两处：
 *   1. 壳进程投影 `electron/main/session-usage.ts` 的 `readSessionUsage` —— 按会话汇总
 *      usage.jsonl，本轮新增 ch/cm 两栏聚合（只有成对上报的行进分母）；
 *   2. 渲染层格式化 `src/renderer/token-estimate.ts` 的 `formatExactTokens` /
 *      `formatCacheHitPercent` —— 后者照 dsh 的算法，部分命中绝不显示成 100%。
 *
 * 两个模块都不能让 node 裸 import（前者 import electron，后者 re-export @dsc/runtime），
 * 所以先用 esbuild 打包、把这两处依赖 alias 成临时 stub，再 import 产物——测的是真代码。
 *
 * 断言：请求数/输入/输出汇总、缓存两栏只算上报行、最后一次输入按时间戳取、没有记录
 * 的会话返回 null；命中率分母不吃老行、满命中给 100、无输入给 null、部分命中不四舍五入
 * 成 100%；精确数量千分位。
 *
 * 用法：node desktop/shots/usage-card-check.mjs
 *
 * @module dsc/desktop/shots/usage-card-check
 */
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const root = 'D:/dsc/desktop'
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// ---- esbuild 没有 .bin 入口，自己在 pnpm store 里挑一份最新的 ----
const pnpm = join(root, 'node_modules/.pnpm')
const esbuildDir = readdirSync(pnpm).filter((name) => name.startsWith('esbuild@')).sort().at(-1)
const esbuild = await import(pathToFileURL(join(pnpm, esbuildDir, 'node_modules/esbuild/lib/main.js')).href)

const out = mkdtempSync(join(tmpdir(), 'dsc-usage-card-'))
const stubs = mkdtempSync(join(tmpdir(), 'dsc-usage-card-stub-'))
const electronStub = join(stubs, 'electron.mjs')
writeFileSync(electronStub, 'export const app = { getPath: () => process.env.DSC_USAGE_TEST_HOME }\n')
const runtimeStub = join(stubs, 'runtime-token-estimate.mjs')
writeFileSync(runtimeStub, 'export function estimateTextTokens(text) { return String(text).length }\n')

// 一次一个入口：多入口时 esbuild 把入口的公共祖先当 outbase，产物会落到子目录里，
// 单入口才保证 `<outdir>/<文件名>.mjs` 这个直白路径。
const buildOne = (entry) => esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outdir: out,
  outExtension: { '.js': '.mjs' },
  alias: { electron: electronStub, '@dsc/runtime/core/token-estimate.js': runtimeStub },
  logLevel: 'warning',
})
await buildOne(join(root, 'electron/main/session-usage.ts'))
await buildOne(join(root, 'src/renderer/token-estimate.ts'))

// ---- 造一份临时 HOME 的用量日志 ----
const home = mkdtempSync(join(tmpdir(), 'dsc-usage-card-home-'))
mkdirSync(join(home, '.dsc/usage'), { recursive: true })
const lines = [
  '{"t":1000,"i":100,"o":10,"sid":"me"}', // 老行：没有 ch/cm
  '{"t":2000,"i":200,"o":20,"ch":150,"cm":50,"sid":"me"}',
  '{"t":3000,"i":300,"o":30,"ch":300,"cm":0,"sid":"me"}', // 全命中
  '{"t":4000,"i":50,"o":5,"sid":"other"}', // 别的会话
  'not json', // 半截行
  '{"t":5000,"i":10,"o":1,"ch":-1,"cm":10,"sid":"me"}', // 负数 ch：按没上报
]
writeFileSync(join(home, '.dsc/usage/usage.jsonl'), `${lines.join('\n')}\n`)
process.env.DSC_USAGE_TEST_HOME = home

const { readSessionUsage } = await import(pathToFileURL(join(out, 'session-usage.mjs')).href)
const { formatCacheHitPercent, formatExactTokens } =
  await import(pathToFileURL(join(out, 'token-estimate.mjs')).href)

// ---- 壳进程投影 ----
const usage = readSessionUsage('me')
check('命中会话返回投影', usage !== null)
check('请求条数只数本会话', usage?.requests === 4, String(usage?.requests))
check('输入 token 汇总', usage?.inputTokens === 610, String(usage?.inputTokens))
check('输出 token 汇总', usage?.outputTokens === 61, String(usage?.outputTokens))
check('缓存读取只算上报行', usage?.cacheHitTokens === 450, String(usage?.cacheHitTokens))
check('未缓存输入只算上报行', usage?.cacheMissTokens === 50, String(usage?.cacheMissTokens))
check('最后一次输入按时间戳取', usage?.lastInputTokens === 10, String(usage?.lastInputTokens))
check('最近请求时刻取最大值', usage?.lastAt === 5000, String(usage?.lastAt))
check('没有记录的会话返回 null', readSessionUsage('nobody') === null)

// ---- 命中率 ----
const prompt = (usage?.cacheHitTokens ?? 0) + (usage?.cacheMissTokens ?? 0)
check('老行不进分母（450/500 = 90%）',
  formatCacheHitPercent(450, prompt) === '90', String(formatCacheHitPercent(450, prompt)))
check('满命中给 100', formatCacheHitPercent(1000, 1000) === '100')
check('没有输入给 null', formatCacheHitPercent(0, 0) === null)
check('部分命中不四舍五入成 100%',
  formatCacheHitPercent(999, 1000) === '99.9', String(formatCacheHitPercent(999, 1000)))
check('差一个 token 也照样区分',
  formatCacheHitPercent(999999, 1000000) !== '100', String(formatCacheHitPercent(999999, 1000000)))

// ---- 精确数量 ----
check('精确千分位', formatExactTokens(6912345) === '6,912,345', formatExactTokens(6912345))
check('千位以下原样', formatExactTokens(742) === '742', formatExactTokens(742))

console.log(failures === 0 ? 'usage-card: ALL PASS' : `usage-card: ${String(failures)} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
