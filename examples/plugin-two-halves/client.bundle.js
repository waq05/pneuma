/**
 * 界面半：一份「工厂注册」形状的 bundle（与壳的构建产物同一形状）。
 *
 * 执行它只注册工厂，真正的副作用在壳物化时跑——与 dsh 的惰性 CJS 模型同义。
 * 手写也行：壳给工厂的是受控的 require/module/exports，白名单外的模块名一律拒绝。
 */
;(globalThis.__DSC_UI_FACTORIES__ ??= {})['dsc-demo-two-halves'] = function (require, module, exports) {
  const React = require('react')
  const api = require('@dsc/ui')

  exports.default = api.defineUiPlugin({
    name: '两半示例',
    apply(ui) {
      ui.slots.register('shell.statusbar', { id: 'twoHalves.readout', order: 50 }, function Readout() {
        return React.createElement('span', { 'data-two-halves': '1', title: '宿主半与界面半来自同一个包' }, '两半示例')
      })
    },
  })
}
