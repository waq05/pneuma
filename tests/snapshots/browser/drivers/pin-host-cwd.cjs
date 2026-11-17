/**
 * 宿主进程的「钉死工作目录」预加载（经 `node --require` 注入，见 `dom.snapshot.ts` 的
 * `gitFixture` / `seedGitFixture`）。
 *
 * ## 为什么需要它
 *
 * 状态面板收起胶囊那行「更改」、输入框上方的分支名，读的都是**当前会话工作目录**的 git
 * 状态；而当前会话（还没发过消息那条）的 cwd 来自宿主进程的 cwd：
 *
 * - `src/host/kernel.ts:47`：`session: { resumeSessionPath, cwd: process.cwd() }`
 * - `src/host/kernel.ts:48`：`'desktop-dock': { cwd: process.cwd() }`
 *
 * `startUiHost` 固定以仓库根为 cwd 起宿主（`tests/e2e/support/host.ts:102`），于是 golden
 * 里的 git 读数取决于「跑测试时这个 checkout 脏不脏」：干净时状态面板整块不挂、
 * `dom.buttons` 少 5、`dom.elements` 少 53，那行「更改」也消失。
 *
 * ## 口径
 *
 * 只 `process.chdir()`，不改任何业务开关：宿主之后读到的 cwd 就是种子仓库，界面画的
 * 分组名 / 分支名 / 脏文件数全部由场景的种子决定。未设 `DSC_DOM_HOST_CWD` 时本文件什么
 * 都不做——其它场景照旧在仓库根启动（会话列表分组仍按 `<repo>` 归一）。
 *
 * `--require` 的预加载跑在入口（`bin/headless.cjs`）之前，而 headless 的入口路径是
 * `__dirname` 拼的绝对路径，所以先 chdir 不影响模块解析；配置 / 插件 / 会话目录都走
 * `DSC_HOME`（本来就是隔离的临时目录），也不受 cwd 影响。
 */
'use strict'

const dir = process.env['DSC_DOM_HOST_CWD']
if (typeof dir === 'string' && dir !== '') {
  try {
    process.chdir(dir)
  } catch (error) {
    // 钉不住就**直接失败**，不许留在仓库根继续跑：种子仓库与「脏的检出」在归一化后的
    // golden 文本里同形（都只有一行「更改」、不记条数），吞掉异常会让「钉法失效」的跑法
    // 照样全绿——这是最坏的一种假绿（2026-11-17 验收 F1）。宿主以非 0 退出时，测试会在
    // 起宿主那一步红并打印 stderr，指向真正的原因。
    console.error('[dom] 钉宿主工作目录失败：', error)
    process.exit(1)
  }
}
