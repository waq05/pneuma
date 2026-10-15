/**
 * 设置 → 模型页的版式探针（2026-10-15 改版：一条条端点卡 → 左端点 + 右详情两栏）。
 *
 * 改版前那一页是「端点卡竖着堆、卡内一行模型 chip」；用户要求照 ZCode 的模型设置页
 * （左供应商列表、点一个在右侧看它的配置与模型列表）与 dsh 的端点卡重做，并且**每个
 * 模型都能配能力**。这一条探针钉的就是这版版式与它的几条硬口径——不是钉观感（观感靠
 * 实机走查的截图），是钉「结构、钩子、写路径、样式门」这四样东西：
 *
 *   [1] 骨架：两栏卡 + 正文填满高度（`.settings-body-fill` 由 ui.tsx 在 models 分区加）
 *   [2] 左栏：端点行（头像 / 默认标 / 密钥状态点 / 编辑中小点）+ 添加端点 + 两个文件路径
 *   [3] 右栏：详情头 + 连接卡（Base URL 与密钥就地改就地存）+ 模型块（拉取 / 批量 / 添加）
 *   [4] 模型行与能力编辑器：默认模型圆点、测试连接、编辑/删除，能力编辑器展开在行下面；
 *       一次只开一个编辑器、草稿按对象记（切走再切回来还在）
 *   [5] 写路径：写口仍只有三个桥方法，单模型保存借 `saveProvider` 整份写；删默认模型时
 *       顺手把默认挪到剩下的第一个；清密钥过确认框
 *   [6] 样式门：`.setting-input` 的 220px 下限在窄格里逐处收回、新类名不许出现硬编码色值、
 *       头像六档色全走令牌、窄屏 ≤900 折成一列、不用 `:has()`（手机上可能是老内核）
 *   [7] 负向验证：把一段带硬编码色的假 CSS 与一段带旧类名的假源码喂给同一套扫描器，
 *       必须抓到（否则这几条闸是空转的）
 *
 * 运行：node scripts/ui-models-page-test.mjs（读源码与样式，不需要先编译）
 *
 * @module dsc/scripts/ui-models-page-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')
// 本仓工作区是 CRLF：跨行文本钉一律先摊平（否则 `{\n  …` 这种写照永远匹配不上）。
const flat = (text) => text.replace(/\r\n/g, '\n')

let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`  ok  ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
}

const models = flat(read('ui-shell/src/plugins/settings/models.tsx'))
const panel = flat(read('ui-shell/src/plugins/settings/ui.tsx'))
const views = flat(read('ui-shell/src/legacy/views.css'))
const shellStyles = flat(read('ui-shell/src/styles.css'))

/** 规则块里带硬编码色值的那些（`#rgb` / `#rrggbb` / `rgb(` / `rgba(`）——配色一律走令牌。 */
function hardcodedColors(css, classNames) {
  const hits = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').trim().split('\n').pop()?.trim() ?? ''
    if (selector.startsWith('@')) continue
    if (!classNames.some((name) => selector.includes(`.${name}`))) continue
    const body = match[2] ?? ''
    if (/(#[0-9a-fA-F]{3,8}\b|rgba?\()/.test(body)) hits.push(`${selector} { ${body.trim()} }`)
  }
  return hits
}

/** 这些类名是这一版新增的（清一色走令牌）：负向验证也拿同一张单子。 */
const NEW_CLASSES = ['models-page', 'models-panes', 'models-rail', 'models-detail', 'conn-card', 'conn-dot', 'provider-avatar', 'model-list', 'model-item', 'model-pick', 'model-ctx', 'model-edit', 'pane-form']
/** 旧版端点卡那一套（改版后不该再出现）。 */
const OLD_CLASSES = ['provider-card', 'provider-row', 'provider-main', 'provider-name', 'provider-sub', 'provider-actions', 'provider-key', 'provider-models', 'provider-nomodel', 'model-chip', 'model-slot']

console.log('[1] 骨架：两栏卡 + 正文填满高度')
{
  check('两栏卡在源码里（左栏 + 右栏 + 详情区）', models.includes('className="models-panes"') && models.includes('className="models-rail"') && models.includes('className="models-detail"'))
  check('页面根上带着 `.models` 与 `.models-page`（设置面板按分区挂它）', models.includes('className="settings-fields models models-page"'))
  check('设置面板在 models 分区给正文加 fill 类（其余分区照旧整页滚）', panel.includes("active === 'models' ? ' settings-body-fill' : ''"))
  check('fill 类取消正文滚动、让子元素吃满高度', /\.settings-body-fill \{[^}]*overflow: hidden;/.test(views) && /\.settings-body-fill > \.models-page \{[^}]*flex: 1;[^}]*min-height: 0;/.test(views))
  check('左栏 + 右栏各滚各的（两处 overflow-y: auto）', /\.models-rail-list \{[^}]*overflow-y: auto;/.test(views) && /\.models-detail \{[^}]*overflow-y: auto;/.test(views))
  check('默认模型那一行在页面顶部（全局旋钮，与选中的端点无关）', models.indexOf('className="setting-row"') < models.indexOf('className="models-panes"'))
  check('设置面板宽了一档（980 → 1080：两栏要放得下）', /\.settings \{[^}]*width: min\(1080px, calc\(100vw - 80px\)\);/.test(views))
  check('两栏卡给了最小高度（窗口很矮时不会被压没）', /\.models-panes \{[^}]*min-height: 200px;/.test(views))
}

console.log('[2] 左栏：端点是主角')
{
  check('端点行带 `data-provider`（自检脚本与别的探针认它）', models.includes('data-provider={provider.name}'))
  check('首字头像按名取稳定的色调档（三档，色走令牌）', models.includes('const AVATAR_TONES = 3') && views.includes('.provider-avatar.av-2'))
  check('头像只取冷色三档（绿 / 黄 / 橙 在这一页是状态色，不掺进头像）', [0, 1, 2].every((tone) => new RegExp(`\\.provider-avatar\\.av-${String(tone)} \\{[^}]*color: var\\(--dsc-(accent-text|cyan|purple)\\);`).test(views)) && !/\.provider-avatar\.av-[0-9] \{[^}]*var\(--dsc-(green|yellow|orange|red)\)/.test(views))
  check('密钥状态点：绿 = 已配、黄 = 还没配', views.includes('.provider-dot.ok {\n  background: var(--dsc-green);') && views.includes('.provider-dot.warn {\n  background: var(--dsc-yellow);'))
  check('「默认」标挂在默认端点那一行', models.includes('{props.isDefault ? <span className="tag">默认</span> : null}'))
  check('有未保存改动的端点挂一颗小点（切走也看得出来）', models.includes('models-rail-editing') && views.includes('.models-rail-editing'))
  check('「添加端点」虚线卡还在，旧钩子 `[data-models-add]` 保留', models.includes('data-provider-add="1" data-models-add="1"'))
  check('新增端点时左栏出现它的位置（伪条目）', models.includes('NEW_PROVIDER_KEY') && models.includes('models-rail-name">新增端点'))
  check('文件路径挪到左栏底部（改配置时要照着找文件）', models.includes('className="models-paths"') && views.includes('.models-path .mono'))
  check('只读档说明那条钩子还在（浏览器里没桥时整页只读）', models.includes('data-models-readonly="1"'))
  check('旧版端点卡那一套已经不在源码里', OLD_CLASSES.every((name) => !models.includes(`"${name}`) && !models.includes(` ${name}"`)) && !models.includes('className={`model-chip'))
  check('旧版端点卡那一套的样式也清了（只留 `.provider-id`）', OLD_CLASSES.filter((name) => name !== 'provider-id').every((name) => !new RegExp(`\\n\\.${name}[ ,{]`).test(views)))
}

console.log('[3] 右栏：详情头 + 连接卡 + 模型块')
{
  check('详情头：头像 + 名字 + id + 默认标 + 端点级两颗动作', models.includes('className="provider-head"') && models.includes('data-provider-edit="1"') && models.includes('data-provider-remove="1"'))
  check('连接卡两行：Base URL 与 API Key', models.includes('className="conn-card"') && models.includes('>Base URL</span>') && models.includes('>API Key</span>'))
  check('Base URL 就地改就地存（失焦或回车保存，不是只读文本）', models.includes('function BaseUrlInput(') && /onBlur=\{\(\) => \{\s*\n\s*props\.onSave\(value\)/.test(models) && models.includes("if (event.key === 'Enter') event.currentTarget.blur()"))
  check('密钥行：已配显示状态 + 替换/清除；未配给「填写」', models.includes("data-key-edit=\"1\"") && models.includes("data-key-clear=\"1\"") && models.includes("{provider.keyConfigured ? '替换' : '填写'}"))
  check('密钥录入行（密码框 + 保存 + 取消，回车保存）', models.includes('className="conn-key-edit"') && /type="password"[\s\S]{0,400}placeholder=\{`粘贴 \$\{provider\.keyRef\} 的值`\}/.test(models))
  check('模型块头：计数 + 三个动作（批量文本 / 拉取清单 / 添加模型）', models.includes('className="model-block-head"') && models.includes('data-model-bulk="1"') && models.includes('data-model-discover="1"') && models.includes('data-model-add="1"'))
  check('拉取清单弹窗照旧（钩子没动：自检与界面探针认它）', models.includes('data-models-discover="1"') && models.includes('data-discover-item={id}') && models.includes('data-models-discover-adopt="1"'))
  check('空态说清下一步（没有端点 / 端点没有模型各一句）', models.includes('models-detail-empty-hint') && models.includes('model-list-empty'))
}

console.log('[4] 模型行与能力编辑器')
{
  check('模型行钩子：`[data-model-chip]`（旧自检认它）', models.includes('data-model-chip={model.id}'))
  check('默认模型那颗圆点：`[data-model-set-default]` + aria-pressed', models.includes('data-model-set-default={model.id}') && models.includes('aria-pressed={isDefault}'))
  check('测试连接的钮与结论点都在这行里', models.includes('data-probe-model={model.id}') && models.includes("data-probe={result.ok ? 'ok' : 'fail'}"))
  check('行尾还有编辑与删除（钩子给自检用）', models.includes('data-model-edit={model.id}') && models.includes('data-model-remove={model.id}'))
  check('能力编辑器展开在那一行下面（同一张卡的下半截）', models.includes('data-model-edit-box={model.id}') && views.includes('.model-edit {'))
  check('能力项与旧版逐项对齐（四档 chip / 档位字段 Select / 线上值 / 三档输入）', models.includes('data-cap-level={level}') && models.includes('ariaLabel="思考档位字段"') && models.includes('data-cap-wire={level}') && models.includes('data-cap-modality={modality}'))
  check('保存按钮两态：改行的 `data-model-save={model.id}`、新行的 `data-model-save="new"`', models.includes('data-model-save={model.id}') && models.includes('data-model-save="new"'))
  check('新加的一行也长在列表里（`[data-model-add-box]`）', models.includes('data-model-add-box="1"'))
  check('一次只开一个编辑器（一个 modelDraft 状态，index 为 null = 新增）', models.includes('const [modelDraft, setModelDraft] = useState<ModelDraft | null>(null)') && models.includes('index: number | null'))
  check('草稿按对象记：切端点回来还在（比的是端点名）', models.includes('modelDraft.provider === current.name ? modelDraft : null'))
  check('删模型过确认框', /\bremoveModel = \(provider: ProviderView, index: number\)/.test(models) && /删除模型「\$\{model\.id\}」？/.test(models))
  check('端点表单里也摆着模型（宿主要求至少一个模型，空清单会被拒收）', models.includes('宿主要求至少一个模型') && models.includes('models: [blankModel()]'))
}

console.log('[5] 写路径：写口仍只有三个桥方法')
{
  const ops = [...models.matchAll(/bridgeWrite\(\s*'([a-zA-Z]+)'/g)].map((match) => match[1])
  check('桥写只经 saveProvider / removeProvider / setProviderKey', ops.every((op) => ['saveProvider', 'removeProvider', 'setProviderKey'].includes(op)), ops.join(','))
  check('单模型保存借 `saveProvider` 整份写（并回端点的模型清单再走同一套校验）', models.includes('const payload = draftOf(provider, models)') && models.includes('const problem = validateDraft(payload, providers)'))
  check('删的正好是默认模型时，顺手把默认挪到剩下的第一个', models.includes('const wasDefault = config.defaultProvider === provider.name && config.defaultModel === model.id') && models.includes('setDefault(provider.name, next.id)'))
  check('清密钥过确认框（凭据库里删掉就找不回来了）', /清除 \$\{current\.keyRef\}？/.test(models) && models.includes("writeKey(current, null, 'API key 已从凭据库移除')"))
  check('测连接与拉清单仍走界面通道（浏览器里也能点）', models.includes(".invoke<ConnectionTestView>('testConnection', [provider, model])") && models.includes(".invoke<string[]>('discoverModels', [provider])"))
  check('默认模型仍走界面通道 `setDefaultModel`', models.includes(".invoke<SettingsMutation>('setDefaultModel', [provider, model])"))
  check('校验与宿主同款：Base URL 要 http(s)、上下文窗口要正整数、至少一个模型', models.includes('const URL_PATTERN = /^https?:\\/\\/\\S+$/') && models.includes('至少要有一个模型') && models.includes('的上下文窗口要填正整数'))
}

console.log('[6] 样式门')
{
  check('`.setting-input` 的通用下限仍是 220px（别处照旧）', /\.setting-input,\s*\n\.setting-select \{[\s\S]{0,400}min-width: 220px/.test(views))
  check('窄格里逐处收回下限：模型行 / 线上值 / 端点表单 / 连接行', /\.model-row-field \.setting-input \{\s*\n\s*min-width: 0;/.test(views) && /\.cap-wire-input \{[\s\S]{0,200}min-width: 0;/.test(views) && /\.pane-form-grid \.field \.setting-input \{\s*\n\s*min-width: 0;/.test(views) && /\.conn-input \{\s*\n\s*flex: 1;\s*\n\s*min-width: 0;/.test(views))
  const hits = hardcodedColors(views, NEW_CLASSES)
  check('新类名的规则里没有硬编码色值（配色一律 `var(--dsc-*)` / color-mix）', hits.length === 0, hits.slice(0, 3).join(' | '))
  check('头像六档色全部走令牌（没有写死 hex）', [0, 1, 2].every((tone) => new RegExp(`\\.provider-avatar\\.av-${String(tone)} \\{[^}]*color-mix\\(in srgb, var\\(--dsc-`).test(views)))
  check('窄屏 ≤900 折成一列（手机上不摆两栏各自滚的架子）', /@media \(max-width: 900px\) \{[\s\S]{0,600}\.models-panes \{\s*\n\s*flex: none;\s*\n\s*flex-direction: column;/.test(views))
  // `:has()` 在别的视图里有几处（都带 @supports 兜底），这里管的是**这一页新增的规则**：
  // 模型页整块样式不许用它（手机 WebView 可能是老内核，见 ui-primitives/compat.ts 的口径）。
  const modelsBlock = /\n\/\* ══════════ 设置「模型」分区：左栏端点 \+ 右栏详情 ══════════[\s\S]*?\n\/\* ── 旧版端点卡那一套/.exec(views)?.[0] ?? ''
  check('模型页那一块样式在（切得出来，下面几条才有意义）', modelsBlock.length > 4000, String(modelsBlock.length))
  check('模型页没用 `:has()`（老内核兜底口径）', !modelsBlock.includes(':has('))
  check('旧 `.model-chip` 的尺寸覆盖从壳的 override 里清了', !/\.model-chip \{/.test(shellStyles))
}

console.log('[7] 负向验证：这几条闸不是空转的')
{
  const fakeCss = '\n.models-rail-item {\n  color: #ffffff;\n}\n'
  const fakeHits = hardcodedColors(fakeCss, NEW_CLASSES)
  check('造一段带 `#ffffff` 的新类名规则，颜色扫描器抓得到', fakeHits.length === 1 && fakeHits[0].includes('#ffffff'), JSON.stringify(fakeHits))
  const fakeInline = '\n.models-page .x {\n  background: rgb(0 0 0 / 40%);\n}\n'
  check('`rgb()` 写法也抓得到', hardcodedColors(fakeInline, NEW_CLASSES).length === 1)
  const fakeOther = '\n.some-other-class {\n  color: #ffffff;\n}\n'
  check('别的类名的规则不误报', hardcodedColors(fakeOther, NEW_CLASSES).length === 0)
  const fakeSource = 'const x = <div className="provider-card">'
  check('旧类名那一条扫的是源码里的 className（负向：造一段旧源码能抓到）', OLD_CLASSES.some((name) => fakeSource.includes(`"${name}`)))
}

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 条失败`)
process.exit(failures === 0 ? 0 : 1)
