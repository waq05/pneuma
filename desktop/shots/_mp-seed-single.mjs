/**
 * 单端点种子（开发辅助）：只有一个端点时输入区模型菜单应当**扁铺**（不摆厂商一级、
 * 面板宽度按模型行给）。用法同 `_mp-seed.mjs`。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const HOME_DIR = join(here, 'mp-home-single')
const dsc = join(HOME_DIR, '.dsc')
const ws = join(HOME_DIR, 'ws')

rmSync(HOME_DIR, { recursive: true, force: true })
mkdirSync(dsc, { recursive: true })
mkdirSync(ws, { recursive: true })
writeFileSync(join(ws, 'readme.txt'), '单端点走查。\n', 'utf8')

writeFileSync(
  join(dsc, 'config.yaml'),
  `default:
  provider: deepseek
  model: deepseek-v4.1-flash
providers:
  deepseek:
    displayName: DeepSeek 官方
    baseURL: http://127.0.0.1:18999/v1
    apiKeyEnv: MP_FAKE_KEY
    models:
      - id: deepseek-v4.1-flash
        name: DeepSeek V4.1 Flash
        contextWindow: 512000
        maxTokens: 8192
        modalities: [text, image]
        thinkingLevels: [off, low, high, max]
        thinkingParam: thinking
      - id: deepseek-v4-pro
        name: DeepSeek V4 Pro
        contextWindow: 1000000
        maxTokens: 8192
        thinkingLevels: [off, low, high, max]
        thinkingParam: thinking
      - id: deepseek-v4.1-lite
        name: DeepSeek V4.1 Lite
        contextWindow: 128000
        maxTokens: 4096
`,
  'utf8',
)
writeFileSync(join(dsc, 'settings.json'), `${JSON.stringify({ defaultPolicy: 'full-access' }, null, 2)}\n`, 'utf8')
process.stdout.write(`[mp-seed-single] ${HOME_DIR}\n`)
