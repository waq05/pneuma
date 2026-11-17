/**
 * 诊断：bash 命令卡在「进行中」时，界面上到底有没有审批卡、按钮叫什么。
 *
 * 运行：node desktop/shots/_diag-approval-card.mjs
 */
process.on('unhandledRejection', () => {})

import { withApp } from './_pkg-harness.mjs'

const fake = {
  tool: { name: 'bash', args: { command: 'node -e "console.log(1+1)"' } },
  script: { content: ['跑完了。'] },
}

await withApp({ id: 'approval-card', index: 130, fake, workspace: 'home' }, async (ctx) => {
  await ctx.type('跑一条命令')
  await new Promise((resolve) => setTimeout(resolve, 5000))
  const report = await ctx.evaluate(`
    return {
      buttons: [...document.querySelectorAll('button')].map((n) => (n.textContent ?? '').trim()).filter((t) => t !== '').slice(0, 40),
      body: document.body.innerText.slice(0, 900),
    }
  `)
  console.log(JSON.stringify(report, null, 2))
  await ctx.shot('diag-approval-card.png')
})
process.exit(0)
