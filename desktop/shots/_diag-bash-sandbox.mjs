/**
 * 诊断：全新 HOME 下第一次调用 bash 时，沙箱是不是因为「可写根目录还不存在」而失败。
 *
 * 两种启动各跑一次，对比同一条消息的结果：
 *   A. 什么都不预建（等于用户第一次安装后开箱就用）
 *   B. 预建 `<HOME>/.dsc/sandbox/tmp`
 *
 * 运行：node desktop/shots/_diag-bash-sandbox.mjs
 */
process.on('unhandledRejection', () => {})

import { withApp } from './_pkg-harness.mjs'

const fake = {
  tool: { name: 'bash', args: { command: 'echo marker-numa' } },
  script: { content: ['跑完了。'] },
}

const run = async (id, index, preCreate) => {
  await withApp({ id, index, fake, preCreate }, async (ctx) => {
    await ctx.type('执行 echo')
    const done = await ctx.waitText('跑完了', 40000)
    const dom = await ctx.evaluate(`
      const text = document.body.innerText
      const cards = document.querySelectorAll('.tool-card, .entry.tool-card, [class*="tool-card"]')
      return {
        cards: cards.length,
        hasMarker: text.includes('marker-numa'),
        hasSandboxError: /打 ACL 失败|受限令牌后端已降级/.test(text),
        tail: text.slice(-420),
      }
    `)
    console.log('  [' + id + '] 回合结束=' + String(done) + ' 工具卡=' + String(dom.cards) + ' 命令原文=' + String(dom.hasMarker) + ' 沙箱报错=' + String(dom.hasSandboxError))
    console.log('    尾部：' + dom.tail.replace(/\s+/g, ' ').slice(-260))
  })
}

console.log('[A] 全新 HOME，不预建 sandbox/tmp')
await run('sandbox-fresh', 11, undefined)
console.log('[B] 预建 sandbox/tmp')
await run('sandbox-pre', 12, ['sandbox/tmp'])
process.exit(0)
