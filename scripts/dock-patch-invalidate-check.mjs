/**
 * P0-11 探针：补丁快照必须跟着**页签 id** 活，不能跟着文件路径活。
 *
 * 纯 Node（不碰 React 渲染），直接跑三份源码：
 *   - `src/packages/ui-dockkit/ui/patch-sources.ts` 的纯函数（记 / 读 / 忘 / 清死人）；
 *   - `src/packages/ui-dockkit/ui/dock-model.ts` 的布局变换（openPreview 的 PREVIEW_MAX
 *     淘汰、openPatch、closeTab）；
 *   - `src/packages/ui-dockkit/ui/dock-state.ts` 的接线（`setDockSession` 切会话、
 *     `setDockPreview` / `setDockFileView`、`dockActions.closeTab`）。
 *
 * 钉这些事：
 *   1. `rememberPatch` 后 `patchOf` 有值；`forgetPatch` 后为 null；订阅者能收到通知；
 *   2. 存活集合里仍存在的页签，快照保留（不能被误清）；
 *   3. `closeTab` 之后清一遍，那张页签的快照变成 null（复现路径的第 3、4 步）；
 *   4. `openPreview` 触发 PREVIEW_MAX 淘汰最旧一张后，被淘汰 id 的快照也清掉；
 *   5. **切会话不删别的会话**（P-1）：A 有补丁页签 t1、B 有 t2，切到 B、切到 C 之后
 *      t1 / t2 都还在（修前这条 FAIL：旧实现拿当前会话布局当存活集合，切到 B 就把 A 的全删）；
 *   6. 把 t1 从 A 的布局里关掉（真的走 `dockActions.closeTab`）→ `patchOf('t1')` 为 null，
 *      B 的 t2 不受牵连；
 *   7. 同一文件同时开着补丁页签与预览页签时，两个 id 各自的快照都有效，关一个不误伤另一个；
 *   8. `setDockFileView` 语义不变（开预览页签 + 挂快照）；之后**不带 patch** 从文件树点开
 *      同一个文件（复用了那张页签）→ 它的快照被清（P-3）；
 *   9. 接线形状：dock-state 三处清理都按全量布局算存活集合；预览组件按 tab.id 读。
 *
 * 加载方式与 `dock-browser-dialog-check.mjs` 同一套：仓库自带的 typescript 现场转译 `.ts`，
 * 跑的是构建前的源码。第 5-8 条要跑 dock-state，它 import `react` 与 `@dsc/ui-core`：
 * 前者给一个只实现 `useSyncExternalStore` 的 data: 桩，后者指到 ui-core 的 `signal.ts`
 * 本体（dock-state 只从整包里取 `createSignal`，拖整包会连图标、markdown 一起拽进来）。
 *
 * @module dsc/scripts/dock-patch-invalidate-check
 */
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const patchSourcesPath = join(root, 'src/packages/ui-dockkit/ui/patch-sources.ts')
const dockStatePath = join(root, 'src/packages/ui-dockkit/ui/dock-state.ts')
const signalPath = join(root, 'src/packages/ui-core/signal.ts')

/**
 * dock-state 只从 react 取 `useSyncExternalStore`：探针不渲染组件树，读一次快照就够。
 *
 * 用 data: URL 而不是落一个桩文件：桩只有这一行，落盘反而是多一份要维护的源码。
 */
const REACT_STUB = `data:text/javascript,${encodeURIComponent(
  'export function useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() }\n',
)}`

let pass = 0
let fail = 0

/** 记一条结果；失败带一句人话，方便一眼看出是哪一步断了。 */
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`PASS ${name}`)
    return
  }
  fail += 1
  console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

function summary() {
  console.log(`\nPASS ${pass} / FAIL ${fail}`)
  if (fail > 0) process.exitCode = 1
}

// 修前这里没有这个纯模块（快照是 dock-state 里一张按文件路径做键的 Map）：探针无从加载，
// 这就是当时的「修前不可测」。替代验证用 `git show` 的旧源码，见终端里那两行提示。
if (!existsSync(patchSourcesPath)) {
  console.log('修前不可测：src/packages/ui-dockkit/ui/patch-sources.ts 不存在。')
  console.log('替代验证（旧实现按文件路径记、且全仓没有失效点）：')
  console.log('  git show HEAD:src/packages/ui-dockkit/ui/dock-state.ts | Select-String "patchSources"')
  console.log('  # 旧码里只有 patchSources.set( 与 patchSources.get(，没有 delete / clear。')
  check('补丁快照有按页签 id 的纯模块（修前没有）', false, 'patch-sources.ts 不存在')
  summary()
  process.exit()
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react') return { url: REACT_STUB, shortCircuit: true }
    // 只指到 signal.ts：整包入口会把图标库、markdown、PDF 视图一起拖进来，Node 里跑不动。
    if (specifier === '@dsc/ui-core') return { url: pathToFileURL(signalPath).href, shortCircuit: true }
    // dock-state 的相对 import 没写扩展名（构建期由打包器补），这里照源码试 .ts / .tsx。
    if (specifier.startsWith('.') && !/\.[a-z0-9]+$/i.test(specifier) && typeof context.parentURL === 'string') {
      for (const ext of ['.ts', '.tsx']) {
        const candidate = new URL(specifier + ext, context.parentURL)
        if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (!/\.tsx?$/.test(new URL(url).pathname)) return nextLoad(url, context)
    const file = fileURLToPath(url)
    const output = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        verbatimModuleSyntax: false,
      },
    })
    return { format: 'module', source: output.outputText, shortCircuit: true }
  },
})

const model = await import(pathToFileURL(join(root, 'src/packages/ui-dockkit/ui/dock-model.ts')).href)
const store = await import(pathToFileURL(patchSourcesPath).href)
// 与上面两份是**同一个模块实例**（同样的绝对 URL 命中 ESM 缓存），所以这里读到的
// `patchOf` 就是 dock-state 写的那张表。
const dock = await import(pathToFileURL(dockStatePath).href)

/** 一份差异快照的假数据（hunks 内容不参与判断，只要引用对得上）。 */
function viewOf(path) {
  return { path, added: 3, removed: 1, hunks: [], status: 'modified' }
}

/** 布局里所有页签 id。 */
function allTabIds(surface) {
  return surface.panes.flatMap((pane) => pane.tabs.map((tab) => tab.id))
}

/** 布局里某 kind + path 的那张页签（造数据时用，找不到就是 undefined）。 */
function tabOf(surface, kind, path) {
  for (const pane of surface.panes) {
    for (const tab of pane.tabs) if (tab.kind === kind && tab.path === path) return tab
  }
  return undefined
}

// ── 1. 纯函数本体 ─────────────────────────────────────────────────────────────

let notified = 0
const off = store.subscribePatches(() => {
  notified += 1
})

const v1 = viewOf('/w/a.ts')
store.rememberPatch('t1', v1)
check('rememberPatch 后 patchOf 有值', store.patchOf('t1') === v1)
check('订阅者收到变化通知', notified >= 1, `notified=${String(notified)}`)
store.forgetPatch('t1')
check('forgetPatch 后为 null', store.patchOf('t1') === null)
off()

// ── 2. 布局里仍活着的页签，快照要留住 ─────────────────────────────────────────

let surface = model.defaultSurface()
surface = model.openPreview(surface, '/w/alive.ts')
const aliveId = tabOf(surface, 'preview', '/w/alive.ts').id
const aliveView = viewOf('/w/alive.ts')
store.rememberPatch(aliveId, aliveView)
store.forgetDeadPatches(allTabIds(surface))
check('存活集合里仍存在的页签，快照保留', store.patchOf(aliveId) === aliveView)

// ── 3. closeTab：关页签之后快照作废（复现路径的核心） ──────────────────────────

const closed = model.closeTab(surface, aliveId)
check('closeTab 之后布局里没有这张页签', !allTabIds(closed).includes(aliveId))
store.forgetDeadPatches(allTabIds(closed))
check('关页签后同一 id 的补丁源为 null', store.patchOf(aliveId) === null)
// 关掉再打开同文件 = 另一张页签，读不到旧快照（旧实现按路径记，这里会捡到上一刀）。
const reopened = model.openPreview(closed, '/w/alive.ts')
const reopenedId = tabOf(reopened, 'preview', '/w/alive.ts').id
store.forgetDeadPatches(allTabIds(reopened))
check(
  '关掉再开同文件是另一张页签、读不到旧快照',
  reopenedId !== aliveId && store.patchOf(reopenedId) === null,
  `newId=${reopenedId} oldId=${aliveId}`,
)

// ── 4. PREVIEW_MAX 淘汰：被挤掉那张的快照也清 ────────────────────────────────
// 上限值不写死在探针里：一直开，直到最早那张从布局里消失（即 dock-model 的 PREVIEW_MAX）。

let crowded = model.defaultSurface()
const crowdedIds = []
let evictedId = null
for (let index = 0; index < 40; index += 1) {
  const path = `/w/p${String(index)}.ts`
  crowded = model.openPreview(crowded, path)
  const id = tabOf(crowded, 'preview', path).id
  crowdedIds.push(id)
  store.rememberPatch(id, viewOf(path))
  if (!allTabIds(crowded).includes(crowdedIds[0])) {
    evictedId = crowdedIds[0]
    break
  }
}
check('预览页签到上限后开始淘汰最旧一张', evictedId !== null, `开了 ${String(crowdedIds.length)} 张都没淘汰`)
store.forgetDeadPatches(allTabIds(crowded))
check('被 PREVIEW_MAX 淘汰的页签，补丁源清掉', store.patchOf(evictedId) === null)
check('没被淘汰的页签，补丁源还在', store.patchOf(crowdedIds[1]) !== null)

// ── 5. 切会话：别的会话里仍开着的页签，快照不能删（P-1） ──────────────────────
// 跑的是真的接线（setDockSession → forgetDeadPatches），不是复刻它的算法。
// 修前这条 FAIL：存活集合只有新会话那一份布局，切到 B 就把 A 的 t1 删了。
// 报名的两个 kind 只给空组件：探针只走布局，不渲染页签体。

model.registerDockTab({ kind: 'patch', label: 'patch', component: () => null })
model.registerDockTab({ kind: 'preview', label: 'preview', component: () => null })

const viewA = viewOf('/w/session-a.ts')
dock.setDockSession('session-a')
dock.setDockPreview({ path: '/w/session-a.ts', patch: viewA })
const t1 = tabOf(dock.dockSurface(), 'patch', '/w/session-a.ts').id
check('会话 A 里补丁页签 t1 挂上了快照', store.patchOf(t1) === viewA, `t1=${String(t1)}`)

const viewB = viewOf('/w/session-b.ts')
dock.setDockSession('session-b')
check('切到会话 B 之后，A 的 t1 快照还在（P-1）', store.patchOf(t1) === viewA)
dock.setDockPreview({ path: '/w/session-b.ts', patch: viewB })
const t2 = tabOf(dock.dockSurface(), 'patch', '/w/session-b.ts').id
check('会话 B 里补丁页签 t2 挂上了快照', store.patchOf(t2) === viewB, `t2=${String(t2)}`)

dock.setDockSession('session-c')
check(
  '切到没有页签的会话 C，A 的 t1 与 B 的 t2 都还在',
  store.patchOf(t1) === viewA && store.patchOf(t2) === viewB,
)

dock.setDockSession('session-a')
check(
  '切回 A，t1 还是同一张页签、快照还在',
  tabOf(dock.dockSurface(), 'patch', '/w/session-a.ts').id === t1 && store.patchOf(t1) === viewA,
)
dock.dockActions.closeTab(t1)
check('从 A 的布局里关掉 t1 后，t1 的快照为 null', store.patchOf(t1) === null)
check('关 t1 不误伤 B 的 t2', store.patchOf(t2) === viewB)

// ── 6. 文件树点开已有预览页签：旧快照必须清掉（P-3） ──────────────────────────

const viewX = viewOf('/w/x.ts')
dock.setDockSession('session-d')
dock.setDockFileView({ path: '/w/x.ts', patch: viewX })
const xTab = tabOf(dock.dockSurface(), 'preview', '/w/x.ts').id
check(
  'setDockFileView 语义不变：开的是预览页签、快照挂在它身上',
  xTab !== undefined && store.patchOf(xTab) === viewX,
  `xTab=${String(xTab)}`,
)
// 文件树点开同一个文件（不带 patch）：openPreview 按路径复用上面那张页签。
dock.setDockPreview({ path: '/w/x.ts' })
check('不带 patch 复用已有预览页签时，那张页签的旧快照被清', store.patchOf(xTab) === null)
check(
  '不带 patch 打开同文件仍然只有一张预览页签',
  dock
    .dockSurface()
    .panes.flatMap((pane) => pane.tabs)
    .filter((tab) => tab.kind === 'preview' && tab.path === '/w/x.ts').length === 1,
)
// 反过来再挂一次：带 patch 的 setDockFileView 仍然把快照挂回去（清旧快照没破坏这条语义）。
dock.setDockFileView({ path: '/w/x.ts', patch: viewX })
check('再走 setDockFileView 时快照照旧挂上（与清快照不互相踩）', store.patchOf(xTab) === viewX)
check('清快照只影响点开的那一张，B 的 t2 还在', store.patchOf(t2) === viewB)

// ── 7. 同一文件两张页签：各记各的，关一个不误伤另一个 ────────────────────────

let both = model.defaultSurface()
both = model.openPatch(both, '/w/same.ts')
both = model.openPreview(both, '/w/same.ts')
const patchTabId = tabOf(both, 'patch', '/w/same.ts').id
const previewTabId = tabOf(both, 'preview', '/w/same.ts').id
const patchView = viewOf('/w/same.ts')
const previewView = { ...viewOf('/w/same.ts'), added: 9, removed: 2 }
store.rememberPatch(patchTabId, patchView)
store.rememberPatch(previewTabId, previewView)
store.forgetDeadPatches(allTabIds(both))
check(
  '同文件的补丁页签与预览页签各自保留快照',
  patchTabId !== previewTabId &&
    store.patchOf(patchTabId) === patchView &&
    store.patchOf(previewTabId) === previewView,
)
const onlyPreview = model.closeTab(both, patchTabId)
store.forgetDeadPatches(allTabIds(onlyPreview))
check(
  '关掉补丁页签不误伤预览页签的快照',
  store.patchOf(previewTabId) === previewView && store.patchOf(patchTabId) === null,
)

// ── 8. 接线形状：三处清理都按全量布局算；消费方按 tab.id 读 ──────────────────

const dockState = readFileSync(dockStatePath, 'utf8')
const previewUi = readFileSync(join(root, 'src/packages/ui-preview/ui/ui.tsx'), 'utf8')

check(
  'setDockPreview 带 patch 时按结果布局的页签 id 记快照',
  /modelOpenPatch\(s, target\.path\)[\s\S]{0,400}?rememberPatch\(tabId/.test(dockState),
)
check(
  'setDockFileView 保留「先开预览页签、再挂快照」的语义',
  /modelOpenPreview\(s, target\.path\)[\s\S]{0,400}?rememberPatch\(tabId/.test(dockState),
)
check(
  '不带 patch 的分支清掉复用页签的快照',
  /modelOpenPreview\(s, target\.path\)[\s\S]{0,400}?forgetPatch\(tabId/.test(dockState),
)
check(
  'mutate / setDockSession / pruneDockKind 三处清理都按全量布局算存活集合',
  (dockState.match(/forgetDeadPatches\(liveTabIds\(\)\)/g) ?? []).length === 3,
  `实际 ${String((dockState.match(/forgetDeadPatches\(liveTabIds\(\)\)/g) ?? []).length)} 处`,
)
check(
  '存活集合扫全部会话的布局，而不是只有当前 surface',
  /for \(const one of Object\.values\(surfaces\)\) collect\(one\)/.test(dockState),
)
check('按文件路径做键的旧补丁源表已删除', !/patchSources\.set|const patchSources = new Map/.test(dockState))
check(
  '预览页签按 tab.id 读补丁源',
  /useDockPatchSource\(tab\.id\)/.test(previewUi) && /useDockPatchSource\(tabId\)/.test(previewUi),
)

// 审查面板的「打开」也开预览页签：绕过 `setDockPreview` 直接调 `dockActions.openPreview`
// 就跳过了「不带 patch 清该页签旧快照」那一步，点开文件会显示上一刀的旧 diff。
const reviewPane = readFileSync(join(root, 'src/packages/ui-layout/ui/review-pane.tsx'), 'utf8')
check(
  '审查面板不再直接调 dockActions.openPreview（会漏清旧快照）',
  !/dockActions\.openPreview\(/.test(reviewPane),
)
check('审查面板的「打开」走 setDockPreview({ path })', /setDockPreview\(\{ path: file\.path \}\)/.test(reviewPane))

summary()
