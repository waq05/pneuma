/**
 * dock 浏览器实机走查的**隔离 HOME**（开发辅助，`desktop/shots/` 整目录 gitignored）。
 *
 * 造一间一次性 HOME：一份只指向本机假端点的 `config.yaml` + 一间干净的 git 工作区。
 * 桌面端用 `HOME` / `USERPROFILE` / `DSC_HOME` 三件套指进来（见 `_dock-walkthrough.mjs`），
 * 全程不碰真实 `~/.dsc`。
 *
 * 为什么权限档给了 auto-edit 之外还要关审批：`browser_dock` 是 risk `exec`，
 * 每次调用都会弹审批卡；走查里没有人点卡，所以把审批档设成自动放行——**只在隔离 HOME 里**。
 *
 * 用法：node desktop/shots/_dock-seed.mjs
 *
 * @module dsc/desktop/shots/dock-seed
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const HOME_DIR = join(here, 'dock-home')
const dsc = join(HOME_DIR, '.dsc')
const ws = join(HOME_DIR, 'ws')

/** 假端点端口（与页面服务器分开，避免撞端口）。 */
export const FAKE_PORT = Number(process.env.DSC_DOCK_FAKE_PORT ?? 18_931)
export const WS_DIR = ws

rmSync(HOME_DIR, { recursive: true, force: true })
mkdirSync(dsc, { recursive: true })
mkdirSync(ws, { recursive: true })

const git = (...args) => execFileSync('git', args, { cwd: ws, stdio: 'pipe', windowsHide: true })
writeFileSync(join(ws, 'readme.txt'), '走查用工作区。\n', 'utf8')
writeFileSync(join(ws, '.gitignore'), '.dsc/\n', 'utf8')
git('init', '--quiet')
git('config', 'core.autocrlf', 'false')
git('config', 'user.email', 'dock@local')
git('config', 'user.name', 'dock')
git('add', '.')
git('commit', '--quiet', '-m', 'seed')

writeFileSync(
  join(dsc, 'config.yaml'),
  `# 走查专用：指向本机假端点（不联网）
default:
  provider: fake
  model: dock-flow
providers:
  fake:
    displayName: 走查假端点
    baseURL: http://127.0.0.1:${String(FAKE_PORT)}/v1
    apiKeyEnv: DSC_FAKE_KEY
    models:
      - id: dock-flow
        name: Dock Flow
        contextWindow: 128000
        maxTokens: 4096
`,
  'utf8',
)

// 审批档位与「默认审阅者」住在 settings.json（不是 config.yaml）。
// 走查里没有人点审批卡，所以 `browser_dock`（risk exec）要自动放行——**只在隔离 HOME 里这么干**。
writeFileSync(
  join(dsc, 'settings.json'),
  `${JSON.stringify({ defaultPolicy: 'full-access' }, null, 2)}\n`,
  'utf8',
)

// 走查要开的那条插件（默认关的那几档之一，隔离 HOME 里显式打开）。
// 形状照 plugin-registry 的条目树：`{ version, entries: [{ file, disabled, config }] }`。
writeFileSync(
  join(dsc, 'plugins.json'),
  `${JSON.stringify(
    {
      version: 1,
      entries: [{ file: 'dock-browser', disabled: false, config: { lookWithoutApproval: true } }],
    },
    null,
    2,
  )}\n`,
  'utf8',
)

process.stdout.write(`隔离 HOME：${HOME_DIR}\n工作区：${ws}\n假端点端口：${String(FAKE_PORT)}\n`)
