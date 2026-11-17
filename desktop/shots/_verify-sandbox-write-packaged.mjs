/**
 * 验收 BUG-0001 修好之后的行为面：命令真的在系统级沙箱里跑，且写边界是硬的。
 *
 * 一条 bash 命令里干三件事：
 *   1. 打印 cwd
 *   2. 往 cwd 里写 inside.txt（写根内，预期成功）
 *   3. 往写根外写一个固定路径（预期被系统层拒）
 *
 * 证据不靠界面文本（界面会把命令原文也画出来，容易被自己骗），直接读会话 jsonl 里
 * 那条 `type:"tool"` 的结果——那是命令真实的 stdout/退出码。
 *
 * 判据（全部要满足）：
 *   - 没有「打 ACL 失败 / 受限令牌后端已降级」
 *   - 工具结果里有 INSIDE_OK，并且 cwd 下真的多了 inside.txt
 *   - 工具结果里有 OUTSIDE_DENIED，并且那个越界文件确实不存在
 *
 * 运行：node desktop/shots/_verify-sandbox-write-packaged.mjs
 */
process.on('unhandledRejection', () => {})

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withApp } from './_pkg-harness.mjs'

const home = join(tmpdir(), 'dsc-shots', '_pkg-sandbox-write-home')
const outside = 'D:/dsc/desktop/shots/out/_outside-should-not-exist.txt'
rmSync(outside.replace(/\//g, '\\'), { force: true })

// 一行写完：多行脚本经 PowerShell 5.1 转手会把引号撕碎（第一版就是这么失败的）。
// 标记都拆成两段拼，命令原文里不会出现成品标记。
const command = 'node -e "const fs=require(\'fs\');'
  + 'console.log(\'CWD=\'+process.cwd());'
  + 'fs.writeFileSync(\'inside.txt\',\'ok\');'
  + 'console.log(\'INSIDE\'+\'_OK\');'
  + 'try{fs.writeFileSync(\'' + outside + '\',\'bad\');console.log(\'OUTSIDE\'+\'_WRITTEN\')}'
  + 'catch(e){console.log(\'OUTSIDE\'+\'_DENIED\'+\' \'+e.code)}"'

const fake = {
  tool: { name: 'bash', args: { command } },
  script: { content: ['跑完了。'] },
}

/** 读最近一条 bash 工具结果（会话 jsonl 的 `type:"tool"` 行）。 */
function readToolResult() {
  const dir = join(home, '.dsc', 'sessions')
  const files = []
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name)
      const info = statSync(full)
      if (info.isDirectory()) walk(full)
      else if (name.endsWith('.jsonl')) files.push({ full, at: info.mtimeMs })
    }
  }
  try {
    walk(dir)
  } catch {
    return null
  }
  files.sort((a, b) => b.at - a.at)
  for (const file of files) {
    const lines = readFileSync(file.full, 'utf8').split('\n').filter((line) => line.includes('"type":"tool"'))
    if (lines.length > 0) return JSON.parse(lines[lines.length - 1])
  }
  return null
}

await withApp({ id: 'sandbox-write', index: 101, fake }, async (ctx) => {
  await ctx.type('执行写文件测试')
  // 这条命令不在白名单里，会先出审批卡；按钮文案后面跟着快捷键提示，用前缀匹配。
  const approved = await ctx.evaluate(`
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 120; i += 1) {
      const btn = [...document.querySelectorAll('button')]
        .filter((n) => (n.textContent ?? '').trim().startsWith('这次允许'))[0]
      if (btn !== undefined) { btn.click(); return true }
      await wait(250)
    }
    return false
  `)
  const done = await ctx.waitText('跑完了', 90000)
  const body = await ctx.body()
  const tool = readToolResult()
  const text = tool?.text ?? ''
  const cwd = (/CWD=([^\r\n]+)/.exec(text) ?? [])[1] ?? null
  const insideFile = cwd === null ? null : join(cwd, 'inside.txt')
  const insideWritten = insideFile !== null && existsSync(insideFile)
  if (insideWritten) rmSync(insideFile, { force: true })

  const report = {
    turnDone: done,
    approved,
    sandboxError: /打 ACL 失败|受限令牌后端已降级/.test(body),
    toolText: text.replace(/\s+/g, ' ').slice(0, 300),
    cwd,
    insideOk: text.includes('INSIDE_OK'),
    insideWritten,
    outsideDenied: text.includes('OUTSIDE_DENIED'),
    outsideWritten: text.includes('OUTSIDE_WRITTEN'),
    outsideFileExists: existsSync(outside.replace(/\//g, '\\')),
  }
  console.log(JSON.stringify(report, null, 2))
  const ok =
    report.turnDone &&
    !report.sandboxError &&
    report.insideOk &&
    report.insideWritten &&
    report.outsideDenied &&
    !report.outsideWritten &&
    !report.outsideFileExists
  console.log(ok ? '结论：PASS' : '结论：FAIL')
  await ctx.shot('verify-sandbox-write.png')
  process.exitCode = ok ? 0 : 1
})
process.exit(process.exitCode ?? 0)
