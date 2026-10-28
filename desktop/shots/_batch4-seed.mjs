/**
 * ui-batch4-check 的种子：csv / xlsx 预览样本 + 两个第三方界面插件目录（信任卡的样本）。
 *
 * 用法：node desktop/shots/_batch4-seed.mjs <home> <docs>
 *   - <home> 隔离 home（第三方目录写进 <home>/.dsc/plugins/）
 *   - <docs> 种子工作目录（csv/xlsx 样本写进去，点开就有东西可看）
 *
 * xlsx 用壳自己那份 SheetJS 生成（路径固定 D:/dsc，与其他自检脚本同惯例）。
 *
 * @module dsc/desktop/shots/_batch4-seed
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const [home, docs] = process.argv.slice(2)
if (!home || !docs) {
  console.error('用法：node _batch4-seed.mjs <home> <docs>')
  process.exit(1)
}

const require = createRequire(import.meta.url)
const XLSX = require('D:/dsc/ui-shell/node_modules/xlsx')

// csv：三列三行，表头与单元格都是好认的中文（不带尾换行——表格视图不会多出一行空行）
writeFileSync(join(docs, 'samples.csv'), '名称,数量,单价\n螺丝,100,0.1\n螺母,200,0.05\n垫片,300,0.02', 'utf8')

// xlsx：两个 sheet（多页签那条断言要靠它）
const workbook = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(
  workbook,
  XLSX.utils.aoa_to_sheet([
    ['季度', '收入', '成本'],
    ['Q1', 1200, 800],
    ['Q2', 1500, 900],
    ['Q3', 1800, 950],
    ['Q4', 2100, 1000],
  ]),
  '汇总',
)
XLSX.utils.book_append_sheet(
  workbook,
  XLSX.utils.aoa_to_sheet([
    ['项目', '负责人'],
    ['alpha', '小王'],
    ['beta', '小李'],
    ['gamma', '小张'],
  ]),
  '明细',
)
XLSX.writeFile(workbook, join(docs, 'samples.xlsx'))

// 第三方界面插件：一个能装但还没信任（问题=还没有信任记录），一个门禁就不过（区间认不出）
const plugins = join(home, '.dsc', 'plugins')
mkdirSync(join(plugins, 'demo-badge', 'ui'), { recursive: true })
writeFileSync(join(plugins, 'demo-badge', 'plugin.json'), `${JSON.stringify({ api: '^1.0.0', platforms: ['web'] }, null, 2)}\n`, 'utf8')
writeFileSync(
  join(plugins, 'demo-badge', 'ui', 'client.js'),
  '// 自检样本：一份形状正确但不会被加载的第三方界面插件（只验信任卡）\nexport default { name: "demo-badge", apply() {} }\n',
  'utf8',
)
mkdirSync(join(plugins, 'demo-bad', 'ui'), { recursive: true })
writeFileSync(join(plugins, 'demo-bad', 'plugin.json'), `${JSON.stringify({ api: 'workspace:*' }, null, 2)}\n`, 'utf8')
writeFileSync(
  join(plugins, 'demo-bad', 'ui', 'client.js'),
  '// 自检样本：区间认不出，门禁会拦下\n\nexport default { name: "demo-bad", apply() {} }\n',
  'utf8',
)

console.log('seed ok')
