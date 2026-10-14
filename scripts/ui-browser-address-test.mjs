/**
 * 地址栏输入整成可加载地址（`ui-shell/src/plugins/browser/address.ts`）的确定性探针。
 *
 * 为什么单钉这一份：它是**地址栏唯一能去哪些地方**的判定口——原生视图那边只在校验
 * 「壳发起的 load 是 http/https」（`desktop/electron/main/dock.ts` 的 `navigateDockBrowser`），
 * 输入怎么整成地址这一步全在这里。这条闸门松一格，`javascript:` / `file:` 就能顺着
 * 地址栏进到那个网页视图里。
 *
 * 三段：
 *   [1] 便利：没写协议补 https（本机地址补 http）、前后空格去掉；
 *   [2] 闸门：非 http/https、带凭据、空串、超长一律 null；
 *   [3] 形态钉：插件确实用这个纯函数当唯一入口（不许有人自己再写一份 `startsWith('http')`）。
 *
 * 纯逻辑按 Node 的类型擦除直读 .ts（同 `ui-paging-test.mjs`，不需要先 build）。
 *
 * 运行：node scripts/ui-browser-address-test.mjs
 *
 * @module dsc/scripts/ui-browser-address-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const address = await import(new URL('../ui-shell/src/plugins/browser/address.ts', import.meta.url).href)
const { normalizeAddress, isBrowsableUrl } = address

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

console.log('\n[1] 少打字也能用（本机补 http，其余补 https）')
check('裸域名补 https', normalizeAddress('github.com') === 'https://github.com/')
check('带路径的裸域名补 https', normalizeAddress('github.com/foo/bar?q=1') === 'https://github.com/foo/bar?q=1')
check('localhost 补 http（开发服务器基本是明文）', normalizeAddress('localhost:5173') === 'http://localhost:5173/')
check('127.0.0.1 补 http', normalizeAddress('127.0.0.1:8080/x') === 'http://127.0.0.1:8080/x')
check('IPv6 本机地址补 http', normalizeAddress('[::1]:3000') === 'http://[::1]:3000/')
check('写了协议就原样用（https）', normalizeAddress('https://example.com/a') === 'https://example.com/a')
check('写了 http 不会被改成 https', normalizeAddress('http://example.com/') === 'http://example.com/')
check('前后空格去掉', normalizeAddress('  https://example.com  ') === 'https://example.com/')

console.log('\n[2] 闸门：整不出来的一律 null')
check('空串', normalizeAddress('') === null)
check('全是空格', normalizeAddress('   ') === null)
check('javascript: 伪协议', normalizeAddress('javascript:alert(1)') === null)
check('data: 伪协议', normalizeAddress('data:text/html,<b>x</b>') === null)
check('file: 带 // 的写法', normalizeAddress('file:///etc/passwd') === null)
check('file: 不带 // 的写法', normalizeAddress('file:/etc/passwd') === null)
check('mailto:', normalizeAddress('mailto:a@b.c') === null)
check('自造协议', normalizeAddress('dsc://whatever') === null)
check('带凭据的地址（会把账号密码留在地址栏）', normalizeAddress('https://user:pw@example.com/') === null)
check('只有协议、没有主机', normalizeAddress('https://') === null)
check('超长地址', normalizeAddress(`https://example.com/${'x'.repeat(5000)}`) === null)

console.log('\n[3] 形态钉：插件只有这一个入口')
const plugin = read('ui-shell/src/plugins/browser/ui.tsx')
check('插件 import 的是这个纯函数', plugin.includes("import { normalizeAddress } from './address'"))
check('回车走它（不是自己判 startsWith）', plugin.includes('const target = normalizeAddress(draft)'))
check('插件里没有第二份协议判断', !/startsWith\(['"]https?:\/\//.test(plugin))
check('非 http/https 给的是人话提示', plugin.includes("'只支持 http/https 地址'"))
check('地址栏确实是「输入 HTTP(S) 地址」的空态（对齐 dsh）', plugin.includes('输入 HTTP(S) 地址开始浏览'))
check('isBrowsableUrl 只认 http/https', isBrowsableUrl('https://a.b') && isBrowsableUrl('HTTP://a.b') && !isBrowsableUrl('file:///x') && !isBrowsableUrl(' //a.b'))

console.log(
  failures === 0 ? `\n${String(passed)} 条断言全部通过` : `\n${String(failures)}/${String(passed + failures)} 条断言失败`,
)
process.exit(failures === 0 ? 0 : 1)
