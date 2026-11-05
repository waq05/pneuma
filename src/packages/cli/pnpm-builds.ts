/**
 * pnpm 的「安装脚本被跳过」怎么读、该对用户说什么。
 *
 * 为什么要这一层：pnpm 10 起默认**不执行**第三方包的安装脚本（postinstall 这类），
 * 只打一行 `Ignored build scripts: …` 或在 `pnpm ignored-builds` 里列出来。装插件的人
 * 看到「装上了」就走，依赖原生编译的插件会到用时才炸，而且不知道是这一步欠的。
 * dsh 的做法是把这些名字记进 profile 的 `allowBuilds` 再让人逐个点头
 * （`packages/boot/plugin-manager/src/build-approval.ts`）；我们这一层只做「读出来 + 说清楚
 * 下一步」，授权本身交给 pnpm 自己的 `approve-builds`——不另造一份策略文件。
 *
 * 为什么单独成文件：`plugin-cli.ts` 顶层就 process.exit，当库 import 跑不起来；
 * 解析逻辑放这里，包级测试才能直接钉住它。
 *
 * @module @pneuma/cli/pnpm-builds
 */

/** 被跳过的安装脚本：包名（pnpm 会带版本，原样保留）。 */
export function ignoredBuildsOf(text: string): string[] {
  const names: string[] = []
  /** 是否正在读 `pnpm ignored-builds` 的列表段。 */
  let inList = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') {
      inList = false
      continue
    }
    // pnpm add 的一行摘要：`Ignored build scripts: esbuild@0.21.5, sharp@0.33.0.`
    const inline = /ignored build scripts:\s*(.+)$/i.exec(line)
    if (inline !== null) {
      for (const item of inline[1].split(',')) {
        const name = item.trim().replace(/\.$/, '')
        if (name !== '') names.push(name)
      }
      continue
    }
    // `pnpm ignored-builds` 的表头，下面缩进的每一行是一个包。
    if (/ignored builds/i.test(line) && line.endsWith(':')) {
      inList = true
      continue
    }
    if (!inList) continue
    // 列表后面又接了一段说明：pnpm 的名单是「小写包名@版本」，说明句首是大写字母。
    // 用大小写当分界，比「带不带 @ 或 /」稳——没写过版本的包名（`esbuild`）也是合法的。
    if (/^[A-Z]/.test(line)) {
      inList = false
      continue
    }
    names.push(line.replace(/^[-*]\s*/, ''))
  }
  return [...new Set(names)]
}

/**
 * 该对用户说的那两行。
 *
 * 说清三件事：跳过了哪些、为什么不影响装载、要跑该在哪跑。最后一句给的是 pnpm 自己的
 * 命令（interactive 勾选 + rebuild），不是我们另造的开关。
 * @param names - {@link ignoredBuildsOf} 读出来的名字
 * @param dir - profile 目录（命令要在它里面跑）
 */
export function installScriptsAdvice(names: readonly string[], dir: string): string {
  return [
    '有安装脚本被 pnpm 跳过：' + names.join('、'),
    '  pnpm 默认不执行第三方包的安装脚本，所以这些没跑。插件照样能装载；依赖原生编译的插件会在用到时才报错。',
    '  要跑：cd ' + dir + ' && pnpm approve-builds（交互式勾选），然后 pnpm rebuild。',
  ].join('\n')
}
