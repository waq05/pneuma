import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON = join(root, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
const DRIVER = join(root, 'desktop', 'shots', '_plugin-center-main.cjs')
const SHOT = join(root, 'desktop', 'shots', 'plugin-center.png')
const RESULT = join(root, 'desktop', 'shots', 'plugin-center.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const port = await new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })
const home = mkdtempSync(join(tmpdir(), 'dsc-plugin-center-'))
mkdirSync(join(home, '.dsc'), { recursive: true })

// 造一个组合包 + profile：验证插件中心能显示「组合包 X」与「界面能力（只列不加载）」。
const profileDir = join(home, '.dsc', 'profiles', 'test')
const bundleDir = join(profileDir, 'node_modules', 'demo-bundle')
mkdirSync(join(bundleDir, 'plugins'), { recursive: true })
writeFileSync(
  join(bundleDir, 'package.json'),
  JSON.stringify({ name: 'demo-bundle', version: '1.0.0', engines: { dsh: '>=0.2.0-0 <0.3.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2),
  'utf8',
)
writeFileSync(join(bundleDir, 'cordis.patch.yml'), '- insert:\n    - id: demo-hello\n      name: ./plugins/hello.js\n', 'utf8')
writeFileSync(
  join(bundleDir, 'plugins', 'hello.js'),
  [
    "export const name = '组合包演示插件'",
    "export const description = '来自组合包，演示界面能力只列不加载'",
    "export const inject = ['tools']",
    "export const client = { platform: 'web', inject: ['tools'], card: true }",
    'export function apply(ctx) {',
    '  const off = ctx.tools.register({',
    "    name: 'bundle_demo',",
    "    description: 'demo tool',",
    '    parameters: { type: "object", properties: {} },',
    "    risk: 'read',",
    "    run: async () => 'ok',",
    '  })',
    '  return () => off()',
    '}',
  ].join('\n'),
  'utf8',
)
writeFileSync(
  join(profileDir, 'package.json'),
  JSON.stringify({ name: 'test-profile', dsh: { profile: { bundles: ['demo-bundle'] } } }, null, 2),
  'utf8',
)
const host = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
  cwd: root,
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DSC_HOME: join(home, '.dsc'),
    DSC_UI_SERVER: '1',
    DSC_UI_PORT: String(port),
    DSC_PROFILE: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let url = ''
const seen = []
host.stdout.setEncoding('utf8')
host.stdout.on('data', (chunk) => {
  seen.push(String(chunk).slice(0, 200))
  const found = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(chunk)
  if (found && url === '') url = found[0]
})
const hostErr = []
host.stderr.setEncoding('utf8')
host.stderr.on('data', (chunk) => hostErr.push(String(chunk).slice(0, 300)))
for (let i = 0; i < 120 && url === ''; i += 1) await sleep(250)
if (url === '') {
  console.error('没有拿到界面地址；stdout：' + seen.join(' | ').slice(0, 800))
  console.error('stderr：' + hostErr.join(' | ').slice(0, 800))
  host.kill()
  process.exit(1)
}

const env = { ...process.env }
delete env['ELECTRON_RUN_AS_NODE']
env['DSC_SHOT'] = SHOT
env['DSC_RESULT'] = RESULT
const electron = spawn(ELECTRON, [DRIVER, url], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] })
for (let i = 0; i < 240 && !existsSync(RESULT); i += 1) await sleep(500)
await sleep(500)
const result = existsSync(RESULT) ? JSON.parse(readFileSync(RESULT, 'utf8')) : null
console.log(JSON.stringify(result, null, 1))
electron.kill()
host.kill()
rmSync(home, { recursive: true, force: true })
process.exit(result === null ? 1 : 0)
