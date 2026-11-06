/**
 * 插件清单快照：启一遍内核，把「现在到底有哪些插件、哪些设置分区、哪些界面单元」
 * 导成机器可读的 JSON，用作改造前后的 golden 对比。
 *
 * 为什么不用 `numa plugin list`：那是交互入口，要跑 TUI；这个脚本用临时 DSC_HOME
 * 起一个不落真实用户数据的内核，只读地取三份清单。
 *
 * 用法：node scripts/plugin-inventory.mjs > docs/baseline/<版本>/inventory.json
 *
 * @module scripts/plugin-inventory
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'numa-inventory-'))
process.env['DSC_HOME'] = home
process.env['DSC_UI_SERVER'] = '0'
// 环境里带的 profile 会让清单跟着开发机的目录漂：快照只认「第一次启动」的样子。
delete process.env['DSC_PROFILE']

const { readConfig } = await import('../lib/core/config.js')
const { createKernel } = await import('../lib/host/kernel.js')
const { listPluginInfos } = await import('../lib/core/plugin-registry.js')

// 挂载期间屏蔽 stdout：tui 会写整屏横幅，host-stdio 会写一行 hello，两者都会顶掉 JSON。
const realWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = () => true
// headless：不挂 tui 那一行（整屏横幅）。
// 因此清单里的 plugins 数**比功能包少 1**（74 vs 75）：tui 是唯一按 surface 跳过的行，
// 不是少了一个包。对着这个数字判断「有没有包掉队」时先减掉它。
const root = await createKernel({ config: readConfig(), resumeSessionPath: null, surface: 'headless' })
process.stdout.write = realWrite

const plugins = listPluginInfos()
  .map((info) => ({
    file: info.file,
    name: info.name,
    enabled: info.enabled,
    toggleable: info.toggleable,
    source: info.source,
    settingsSection: info.settingsSection ?? null,
    bundle: info.bundle ?? null,
  }))
  .sort((a, b) => a.file.localeCompare(b.file))

const sections = root.settings
  .sections()
  .map((section) => ({ id: section.id, title: section.title, order: section.order ?? 100, builtin: section.builtin }))
  .sort((a, b) => a.id.localeCompare(b.id))

let ui = null
try {
  const dir = fileURLToPath(new URL('../lib/ui/plugins', import.meta.url))
  ui = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const bundleFile = join(dir, entry.name, 'bundle.json')
      let declared = {}
      try {
        declared = JSON.parse(readFileSync(bundleFile, 'utf8'))
      } catch {
        declared = {}
      }
      return {
        id: typeof declared.id === 'string' && declared.id !== '' ? declared.id : entry.name,
        platform: typeof declared.platform === 'string' ? declared.platform : 'web',
        api: typeof declared.api === 'string' ? declared.api : null,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
} catch (error) {
  ui = { error: error instanceof Error ? error.message : String(error) }
}

console.log(JSON.stringify({ version: 1, plugins, sections, ui }, null, 2))

rmSync(home, { recursive: true, force: true })
process.exit(0)
