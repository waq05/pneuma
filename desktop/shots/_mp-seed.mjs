/**
 * 输入区「模型 / 思考档位」两颗 chip 的实机走查种子（开发辅助，`desktop/shots/` 整目录 gitignored）。
 *
 * 造一间一次性 HOME：`~/.dsc/config.yaml` 里三个端点，专为照出 0.6.71 那三条报障而配：
 *
 *   - **`deepseek` 与 `command` 下各有一个叫 `deepseek-v4.1-flash` 的模型**——裸名相同、
 *     端点不同。旧版拿 `value === 裸名` 判勾，这一条永远不亮；新版靠 `status.provider`
 *     精确落到 `deepseek` 那一行（截图里可以数出来）。
 *   - **`local` 下的 `llama-3-8b` 声明 `n: []`**（没有思考开关）——档位 chip 应当退化成
 *     一颗不可点的标签，而不是给一张空菜单。
 *   - 三个端点 → 模型 chip 上带端点前缀（单端点时那一截是噪音，会被收掉）。
 *   - 默认档位不写（= `default`）——这正是旧版「四个按钮一个都不亮」的那一档。
 *
 * 用法：node desktop/shots/_mp-seed.mjs && node scripts/_ui-shell-serve.mjs
 * （`DSC_UI_SERVE_HOME` 指到本脚本打印的那个目录）
 *
 * @module dsc/desktop/shots/model-picker-seed
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const HOME_DIR = join(here, 'mp-home')
const dsc = join(HOME_DIR, '.dsc')
const ws = join(HOME_DIR, 'ws')

rmSync(HOME_DIR, { recursive: true, force: true })
mkdirSync(dsc, { recursive: true })
mkdirSync(ws, { recursive: true })
writeFileSync(join(ws, 'readme.txt'), '走查用工作区。\n', 'utf8')

/** 四档思考能力的模型（键名照 `core/model-caps.ts` 的 `RawModelCaps`：`thinkingLevels`）。 */
const FOUR_LEVELS = `
        thinkingLevels: [off, low, high, max]
        thinkingParam: thinking`
/** 只有两档的模型：档位菜单该跟着模型变（证明清单不是写死的）。 */
const TWO_LEVELS = `
        thinkingLevels: [off, high]
        thinkingParam: reasoning-effort`
/** 没有思考开关的模型：空清单 + `thinkingParam: none`。 */
const NO_LEVELS = `
        thinkingLevels: []
        thinkingParam: none`
/** 一个模型很多的端点：九个模型，够把飞出卡顶到「比面板还高」那一档。 */
const NINE_MODELS = [
  '      - id: claude-haiku-5-5',
  '        name: Claude Haiku 5.5',
  '        contextWindow: 256000',
  '        maxTokens: 8192',
  '        modalities: [text, image]',
  '      - id: deepseek-v4.1-flash',
  '        name: DeepSeek V4.1 Flash',
  '        contextWindow: 512000',
  '        maxTokens: 8192',
  '        modalities: [text, image]',
  '      - id: glm-5.3',
  '        name: GLM 5.3',
  '        contextWindow: 512000',
  '        maxTokens: 8192',
  '      - id: glm-5.3-flash',
  '        name: GLM 5.3 Flash',
  '        contextWindow: 512000',
  '        maxTokens: 8192',
  '        modalities: [text, image]',
  '      - id: qwen3.8-flash',
  '        name: Qwen 3.8 Flash',
  '        contextWindow: 256000',
  '        maxTokens: 8192',
  '        modalities: [text, image]',
  '      - id: qwen3.8-max',
  '        name: Qwen 3.8 Max',
  '        contextWindow: 512000',
  '        maxTokens: 8192',
  '      - id: step-5-preview-free',
  '        name: Step 5 Preview',
  '        contextWindow: 256000',
  '        maxTokens: 8192',
  '      - id: kimi-k2.5',
  '        name: Kimi K2.5',
  '        contextWindow: 256000',
  '        maxTokens: 8192',
  '        modalities: [text, image, video]',
  '      - id: minimax-m3',
  '        name: MiniMax M3',
  '        contextWindow: 128000',
  '        maxTokens: 4096',
].join('\n')

writeFileSync(
  join(dsc, 'config.yaml'),
  `# 走查专用（不联网）：故意不指向任何真端点，界面只读默认模型名与显示名。
default:
  provider: deepseek
  model: deepseek-v4.1-flash
providers:
  deepseek:
    displayName: DeepSeek
    baseURL: http://127.0.0.1:18999/v1
    apiKeyEnv: MP_FAKE_KEY
    models:
      - id: deepseek-v4.1-flash
        name: DeepSeek V4.1 Flash
        contextWindow: 1000000
        maxTokens: 8192
        modalities: [text, image]${FOUR_LEVELS}
      - id: deepseek-v4-pro
        name: DeepSeek V4 Pro
        contextWindow: 1000000
        maxTokens: 8192${FOUR_LEVELS}
  command:
    displayName: command code
    baseURL: http://127.0.0.1:18999/v1
    apiKeyEnv: MP_FAKE_KEY
    models:
      - id: deepseek-v4.1-flash
        name: DeepSeek V4.1 Flash
        contextWindow: 1000000
        maxTokens: 8192
        modalities: [text, image]${FOUR_LEVELS}
      - id: z-ai/glm-5.3-flash
        name: GLM 5.3 Flash
        contextWindow: 1000000
        maxTokens: 8192
        modalities: [text, image]${TWO_LEVELS}
  local:
    displayName: 本机
    baseURL: http://127.0.0.1:18999/v1
    apiKeyEnv: MP_FAKE_KEY
    models:
      - id: llama-3-8b
        name: Llama 3 8B
        contextWindow: 128000
        maxTokens: 4096${NO_LEVELS}
  # 一个「模型很多」的端点：飞出卡比面板还高时必须压住高度自己滚，
  # 而不是顺着那一行铺下去盖住输入框（夹高度那条判定的实机证据）。
  opencode-go:
    displayName: opencode go
    baseURL: http://127.0.0.1:18999/v1
    apiKeyEnv: MP_FAKE_KEY
    models:
${NINE_MODELS}
`,
  'utf8',
)

// 审批档位住在 settings.json（不是 config.yaml）。走查里没人点卡，给完全访问——只在隔离 HOME 里。
writeFileSync(
  join(dsc, 'settings.json'),
  `${JSON.stringify({ defaultPolicy: 'full-access' }, null, 2)}\n`,
  'utf8',
)

process.stdout.write(`[mp-seed] 隔离 HOME：${HOME_DIR}\n[mp-seed] 工作区：${ws}\n`)
