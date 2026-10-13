// 第三方界面插件的最小示例（手写 CJS，不需要构建工具）。
//
// 安装：把整个目录拷进 ~/.dsc/plugins/demo-greeter/（plugin.json 与 ui/client.js
// 两个文件都要在），首次启动后终端里会出现「还没有信任记录」的提示，用
// /ui-trust demo-greeter 确认一次，重启后装载。
//
// 两条规矩（详见 docs/plugin-development.md §10）：
//   1. 工厂注册名必须等于目录 id（装载器按 id 从工厂表里取）；
//   2. plugin.json 必须声明 api（@dsc/ui 的 semver 区间）——宿主拿它对当前壳做门禁。
//
// 插件只 require 三样：react / react/jsx-runtime / @dsc/ui（白名单表外的 require 一律被拒）。
// 渲染走 @dsc/ui 的载体基元（Text），同一份文件在浏览器壳与终端壳里各渲染各的。
//
// @module examples/ui-plugin-demo/ui/client
(globalThis.__DSC_UI_FACTORIES__ ??= {})['demo-greeter'] = function (require, module, exports) {
  const React = require('react')
  const { defineUiPlugin, TUI_SLOTS, Text } = require('@dsc/ui')

  module.exports = defineUiPlugin({
    name: '示例问候',
    apply(ui) {
      // 工具卡尾巴的扩展行（D2 的扩展点）：transcript 插件用 Factory 的 children 声明了
      // 'transcript.toolcard.footer'，这里用 injectSlot 等它出现再注册——不靠加载顺序。
      // 同一行代码两种载体都跑：web 上槽会被声明、注册生效；TUI 没有工具卡，等待自然挂着。
      ui.slots.injectSlot('transcript.toolcard.footer', () =>
        ui.slots.register('transcript.toolcard.footer', { id: 'demo.footer', order: 2 }, function DemoFooter() {
          return React.createElement(Text, { className: 'hello-badge' }, '来自第三方插件 demo-greeter 的一行')
        }),
      )
      // 终端壳：壳声明的通知区扩展槽（tui.notice.extensions）。
      if (ui.host.platform === 'tui') {
        ui.slots.injectSlot(TUI_SLOTS.noticeExtensions, () =>
          ui.slots.register(TUI_SLOTS.noticeExtensions, { id: 'demo.line', order: 5 }, function DemoTuiLine() {
            return React.createElement(Text, null, '来自第三方插件 demo-greeter 的问候（同一份 bundle）')
          }),
        )
      }
    },
  })
}
