# 第 3/4 波机制规格：A2 启动分批与懒物化 / A3 combo 批打包 / B 开发态热更（HMR）

> 只读侦察产物。**dsh 侧全部逐字引自 `D:\deepseek-harness\deepseek-harness`**，dsc 侧以宿主代码为准；
> 客户端取数路径（`ui-shell/src/boot.ts` 的 `readBootGraph`/`loadUiPlugins`/`fetchFactory`/`appendScript`、
> `ui-shell/src/plugin-api.ts`、`src/ui/slots.ts`）正被第 2 波施工改动，本文件对它只写**概念 + 落点**，
> 并单列 rebase 点（§7）。所有引用形如 `文件:行号`。
>
> 三条先给的结论（详见 §1.4 / §4.0…）：
> 1. **dsh 的 `bootstrap` 批在 dsc 没有对应物**（dsh 的 bootstrap 批是"页面里的模块系统本身"，
>    必须 parser-blocking 先于壳；dsc 的壳就是普通 ESM app）。硬套 `bootstrap/application` 两个名字
>    会得到一个永远为空的批——建议 dsc 用 `early | application`，只对齐字段名与语义角色。
> 2. **dsh 的"懒物化"也不是"用到才 apply"**：所有图行在 boot 期都会被 Loader 拉起来并物化
>    （`web/src/boot-client.ts:48-56`、`entries.ts:210-231`）。它买到的是"**批脚本只注册工厂**"
>    （便宜、可预取）+ 动态分片 `require.async` 的按需到达（`system.ts:325-378`）。
>    dsc 能对齐的"懒"是**推迟整批的取数与本批条目的 apply**，不是"首次使用才执行模块体"。
> 3. **§7.2「最多三次请求」可以在本机源码定论**：`system.ts:207-249` 逐行可数，
>    ≤3 次/每条缺行（同 URL 重试 1 次 + 单资源 1 次；批已跑过则 1 次；批已记失败则 1 次）。详见 §2.2.4。

---

## 0. dsh 三道机制在源码里的骨架（先给地图）

| 关注点 | dsh 文件 | 关键行 |
| --- | --- | --- |
| 启动图与批描述符（wire 类型） | `packages/client/modules/src/client/manifest.ts` | 52-97（`WebBootEntry`/`WebBootBatch`/`WebBootGraph`）、217-306（`parseBootManifest` 校验） |
| 宿主组图 / combo 生成 / 路由表 | `packages/client/modules/src/index.ts` | 219-222（rev）、227-246（URL 拼法）、271-296（URL 长度分区）、392-459（combo 体）、461-477（批描述符）、552-587（注入 HTML 的行）、596-809（服务本体 + compose）、1128-1149（精确 URL 查表） |
| 浏览器模块表（惰性 CJS） | `packages/client/modules/src/client/system.ts` | 163-178（注册/重注册拒绝）、180-190（同 URL 共享）、207-249（取数 + 回退，请求数算术）、298-322（物化 + 样式归属）、469-485（invalidate） |
| 页面条目对账（含 HMR 换装） | `packages/client/modules/src/client/entries.ts` | 92-98（sync）、104-107（retry）、116-136（reload）、177-190（replace 时序）、192-246（reconcile） |
| 卸载与样式剔除 | `packages/client/modules/src/client/entry-lifecycle.ts` | 9-17（tearDownEntryFiber）、23-28（removeOwnedStyles） |
| 壳 boot（两批时机、pending 呈现） | `packages/client/web/src/boot.ts` / `boot-client.ts` / `boot-page.ts` / `loader-status.ts` | boot.ts:71-83、115-122；boot-client.ts:36-57、66-89；boot-page.ts:61-66、98-102；loader-status.ts:28-35 |
| HMR 宿主半侧（stat 轮询 + SSE） | `packages/client/hmr/src/index.ts` | 60-124（poller）、128-141（看门狗集合 diff）、158-207（`/plugins/events` SSE + graph/rebuilt 帧） |
| HMR 帧类型与浏览器半侧 | `packages/client/hmr/src/events.ts` / `src/client/index.ts` | events.ts:11-13、26-41、44-50；client/index.ts:18-47 |
| 注入行如何落成 HTML | `packages/host/webserver/src/injections.ts` | 47-71（`script-src` = parser-blocking `<script src>`；`script-preload` = `<link rel=preload as=script>`）、86-119 |

---

## 1. 机制一：启动分批与懒物化（dsh 精确语义）

### 1.1 批描述符的原文形状与不变量

`packages/client/modules/src/client/manifest.ts:70-97`：

```ts
/** Initial scheduling phase for one revisioned combo script. */
export type WebBootBatchPhase = 'bootstrap' | 'application'

/** One initial combo script; a scheduling phase may span several descriptors. */
export interface WebBootBatch {
  /** Parser-blocking bootstrap or preloaded application scheduling. */
  phase: WebBootBatchPhase
  /** Content-addressed combo script reference, document-relative like {@link WebBootEntry.url}. */
  url: string
  /** Revision derived from the ordered entry revisions. */
  rev: string
  /** Graph entry ids whose factories the script registers, in execution order. */
  entries: string[]
}

export interface WebBootGraph {
  rev: string
  entries: WebBootEntry[]
  /** Initial combo descriptors; every entry belongs to exactly one descriptor. */
  batches: WebBootBatch[]
}
```

不变量（`parseBootManifest`，manifest.ts:265-304 逐条实现）：
- `phase` 只认 `'bootstrap' | 'application'`，别的值整图抛错（274-276）；
- 批 URL 不许重复（280-283）；
- `entries` 非空字符串数组（284-287）、每个 id 必须在 `entries` 里存在（288-291）、
  **每个 entry 恰好属于一个批**（292-296 + 298-304）；
- `rev` 是"有序 entry revision 的派生"（注释 78 行；实现 §1.2）。

### 1.2 两批怎么划（这是计划的表述需要修正的地方）

`packages/client/modules/src/index.ts:758-809` 的 `compose()`：

```ts
const bootstrap = PARSER_PRELOAD_IDS
  .map(id => this.table.get(id))
  .filter((record): record is WebPluginRecord => record !== undefined)
const bootstrapIds = new Set(bootstrap.map(record => record.entry.id))
const application = entries
  .filter(entry => !bootstrapIds.has(entry.id))
  .map(entry => this.table.get(entry.id))
  .filter((record): record is WebPluginRecord => record !== undefined)
```

而 `PARSER_PRELOAD_IDS` 是**一个常量、一个包**（index.ts:536-539）：

```ts
/** Bootstrap package whose ordinary client bundle supplies the module-system implementation. */
const CLIENT_MODULES_ID = '@deepseek-ai/dsh-client-modules'

/** Dynamic bundles grouped into the parser bootstrap batch before the Vite shell. */
const PARSER_PRELOAD_IDS = [CLIENT_MODULES_ID] as const
```

也就是说：**bootstrap 批永远只含"客户端模块系统"这一个包，其余全部 entry 按模块图顺序进 application 批**。
分区的另一半（`partitionComboRecords`，index.ts:271-296）只由 URL 字节上限触发：

```ts
const MAX_COMBO_URL_BYTES = 3 * 1024   // index.ts:183
...
if (current.length === 0) {
  throw new Error(
    `client-modules: ${record.entry.id} exceeds the ${String(MAX_COMBO_URL_BYTES)}-byte combo URL limit`,
  )
}
```

→ 同一 phase **可以**有多个批描述符；一个 entry 超限则整个组图抛错（不降级）。
**没有任何逐插件"批次优先级"声明**——dsh 的批是"角色 + 长度"决定的结构，不是插件作者声明的调度档位。

### 1.3 两批的时机：注入形态决定"注册"与"物化"的分离

`bootInjections`（index.ts:552-587）按顺序吐注入行：

```ts
const bootstrap = graph.batches.filter(batch => batch.phase === 'bootstrap')
const application = graph.batches.filter(batch => batch.phase === 'application')
const rows: IndexInjection[] = [{ kind: 'script', placement: 'head', text: queue }]
for (const batch of application) {
  rows.push({ kind: 'script-preload', src: batch.url })
}
for (const batch of bootstrap) {
  rows.push({ kind: 'script-src', placement: 'head', src: batch.url })
}
rows.push({ kind: 'global', name: '__DSH_BOOT__', value: graph })
```

而这两种行渲染成什么，见 `packages/host/webserver/src/injections.ts:60-64`：

```ts
case 'script-src':
  return { placement: row.placement, markup: `<script src="…"></script>` }
case 'script-preload':
  return { placement: 'head', markup: `<link rel="preload" as="script" href="…">` }
```

于是**时机**是：

| 阶段 | 形态 | 何时执行 | 何时物化 |
| --- | --- | --- | --- |
| bootstrap 批 | head 里 parser-blocking 的 `<script src>` | 阻塞解析、先于壳 bundle | 队列脚本把注册塞进 `pendingQueue`；壳调用 `__ModuleLoader__.create()` 时**物化它并 drain 队列**（index.ts:554-575 HTML 队列代码；`ClientModuleSystem` 构造器 151-161 只 drain 队列、不物化其余） |
| application 批 | head 里 `<link rel=preload as=script>`（只取字节，不执行） | 第一次有人要这个批里的工厂时：`loadShared(url)` → `defaultLoadBundle` 插 `<script async src>`（system.ts:16-29、180-190） | 每个包在它自己的图行被 `Loader` import 时物化（`entries.ts:210-231`：`prefetch` 只注册，`import` 才物化） |

"只注册工厂、模块体首次使用才执行"的落点（`system.ts:1-16` 的模块注释 + `298-322` 的 `materialize`）：
bundle 执行时只跑 `window.__ModuleLoader__.load({ id, factory })`；**CSS 注入等一切模块级副作用都在
factory 闭包内**，`factory(require)` 在首次 import/require 时才跑，并 memo 进 `loadCache`。
物化的触发点：`Loader` 的 `internal.import` → `ClientModuleSystem.import`（380-397）→ `arriveGraphRow`（251-278）
→ `materialize`；以及 `immediately` 档的 `prefetch`（399-405，**只注册不物化**）。
壳的 `immediately` 预取在 `web/src/boot.ts:115-122`：

```ts
private async prefetchImmediateTier(): Promise<void> {
  await Promise.all(this.manifest.plugins
    .filter(row => row.immediately)
    .map(row => this.modules.prefetch(row.id).catch(...)))
}
```
（`immediately` 的语义在 wire 上是"stage-one prefetch"：`manifest.ts:64`。）

**pending 呈现**（dsh）：`web/src/boot-client.ts:42-56` 订阅 cordis `internal/status`，把每个 entry 的
fiber 状态经 `onEntryState` 交给 `BootPage.setState`；`BootPage` 用 active 数画进度弧
（`boot-page.ts:98-102`）、失败时把失败条目逐行摊出来（`boot-page.ts:83-96`）；
状态词表见 `loader-status.ts:28-35`（`pending/loading/active/failed/disposed/unloading`）。
boot 审计在最后把非 active 的条目汇总抛出（`boot-client.ts:66-89`），例如
`pending (waiting for service: …)` 与 `import failed: …`。

### 1.4 失败/重试语义（宿主侧与页面侧分开）

- **宿主侧**（组图）：`activate` 时把"声明坏 / bundle 缺失"聚合成一次响亮的抛
  （index.ts:641-645 + `ClientPackageCompositionError` 112-130）；稳态下一个包坏不影响其余
  （`flush` 1051-1077，注释 1058-1061）；**模块图成环**在**整表层面**报错并保留上一份可排序的图（1066-1074）；
  `orderByModuleGraph`（501-533）负责"被请求的动态包先于消费者"。
- **页面侧**（取数）：§2.2.4 的三态；**批脚本执行过就不再重放**（`executedBundleUrls`，system.ts:118-119、228-235）。
- **页面侧**（条目对账）：`sync()` 发现 target 变了就作废在途的 mount（`generation`），
  `reconcile` 逐行 try/catch 收集 failures（entries.ts:192-246），失败留在 `state.failures`
  由"设置 → 插件"展示并 `retry()`（104-107，**对同一 rev 也重试**）。

---

## 2. 机制二：combo 批打包（逐字）

### 2.1 URL 拼法（逐字引用）

`packages/client/modules/src/index.ts:224-251`：

```ts
/** Absolute route prefix serving every plugin resource. */
const PLUGIN_ROUTE = '/plugins'

/** Combo query addressing one ordered plugin-file list. */
function comboSearch(ids: readonly string[], rev: string, sourceMap = false): string {
  const resources = ids.map(id => `${id}/client.js${sourceMap ? '.map' : ''}`).join(',')
  return `??${resources}&rev=${rev}`
}

/** Absolute route URL for one combo resource. */
function comboUrl(ids: readonly string[], rev: string, sourceMap = false): string {
  return `${PLUGIN_ROUTE}/${comboSearch(ids, rev, sourceMap)}`
}

function comboReference(ids: readonly string[], rev: string, sourceMap = false): string {
  return comboUrl(ids, rev, sourceMap).slice(1)
}

/** Absolute route URL for one package-local chunk. */
function chunkUrl(id: string, fileName: string, rev: string, sourceMap = false): string {
  return `${PLUGIN_ROUTE}/${id}/${fileName}${sourceMap ? '.map' : ''}?rev=${rev}`
}
```

**注意（计划 §3 A3 的简写要修正）**：真实形状是
`/plugins/??<id>/client.js,<id>/client.js&rev=<comboRev>`，不是 `/plugins/??a,b,c&rev=`；
每个资源都带 `/client.js` 后缀，`rev` 用 `&`（不是 `,`）与资源列表分隔。
文档相对的引用形态（图里给浏览器的那个）是去掉首斜杠的 `comboReference` ——
`plugins/??<id>/client.js&rev=<rev>`（单资源 URL 也是"一成员的 combo"：`graphRow`，index.ts:479-489）：

```ts
function graphRow(id: string, rev: string, fields: WebBootRowFields): WebBootEntry {
  return { id, url: comboReference([id], rev), rev, ... }
}
```

### 2.2 打包格式与 rev

`comboRevision`（index.ts:392-398）与 `buildComboScript`（400-405）：

```ts
/** Derive one combo revision from the ordered immutable row revisions. */
function comboRevision(resources: readonly ComboResource[]): string {
  return framedHash('combo', resources.flatMap(resource => [resource.id, resource.rev]))
}

/** Concatenate one or more factory registrations without reading or composing source maps. */
function buildComboScript(resources: readonly ComboResource[], sourceMapUrl: string): Buffer {
  let source = ''
  for (const resource of resources) source += `${prepareSource(resource).source};\n`
  return comboScript(source, sourceMapUrl)
}
```

- **格式**：把每个 bundle 的源码（剥掉 `//# sourceMappingURL=`/`//# sourceURL=` 尾注，`prepareSource` 305-313）
  后加 `;\n` **顺序拼接**；末尾再补一句 `//# sourceMappingURL=<combo 的 .map 请求>`（`comboScript` 316-319）。
- **分隔符**：就是换行 + `;`（每个 bundle 的源码自带 `;` 结尾也可，双分号无害）。
- **rev 语义**：`rev` 是 **12 位内容派生值**：单资源是 `artifactRevision(baseline)` = `sha1('plugin-artifact', mtimeMs, ctimeMs, size)[:12]`
  （index.ts:219-222，`framedHash` 213-217）；combo 是 `sha1('combo', [id,rev,…])[:12]`。
  即 **rev 是"文件系统元数据摘要"，不是构建序号**；元数据不变则 rev 不变（`rebuilt()` 还专门早退：
  index.ts:713-721）。宿主与客户端靠同一份 rev：客户端只把它当缓存破坏/换装的 key
  （`atRevision`，system.ts:31-37），服务端靠"预先算好的精确 URL"匹配。
- **响应头**：`cache-control: public, max-age=31536000, immutable`（index.ts:180-181、1139-1145），
  `content-type: text/javascript; charset=utf-8`（780-783）。**地址即内容**：rev 不在自己的表里 → 404。
- **服务端不做"通用 combo 解析"**：`compose()` 把每个批的（URL, 惰性体）预先登记进 map（776-806），
  `bundleResource` 用 `pathname + search` **精确查表**（1128-1149）：

```ts
const response = this.responses.get(resourceUrl)
  ?? this.previousBatchResponses.get(resourceUrl)
  ?? this.chunkResponse(requestUrl)
...
// Anything else under /plugins (including unadvertised combinations and
// /plugins/events when the HMR row is absent) is an unknown resource.
return { status: 404 }
```

  `previousBatchResponses` 只留**一代**（609-610 注释："One prior graph generation covers a request racing
  the HMR recomposition that replaced its URL"），且体是 compose 时**捕获了 Buffer 的惰性闭包**
  （`lazyBody` 383-390 只造一次、共享 settlement）。
- **id 404 时其余怎么办**：宿主侧没有"部分成功"这个概念——**要么整条 URL 在表里（200，全部成员），要么 404**。
  缺文件的成员在**组图时**就已经不在 `entries` 里（宿主把"bundle 缺失"聚合成启动失败，112-130），
  所以"一个成员对不上 rev"不会出现在稳态。抗性全在客户端（§2.2.4）。

### 2.3 一个 id 404 时其余怎么办（客户端三态）

`packages/client/modules/src/client/system.ts:192-249`（**逐字，这段是 §7.2 的定论证据**）：

```ts
  /**
   * Load one graph row so its factory is registered (idempotent per in-flight
   * arrival). A batch script is one classic script that registers every
   * package in sequence, and {@link register} rejects a second registration,
   * so the two failure kinds differ: a transport failure (`error` event, nothing
   * executed) is retried once on the same URL; a script that loaded without
   * registering this row (a parse error registered nothing, or a runtime throw
   * stopped it after registering others) is never re-executed, because a replay
   * would stop again at the first duplicate registration; that holds even when
   * the row that first imports from the batch is one it did register, because
   * every executed batch URL is remembered. Either way the row then falls back
   * to its own one-resource URL, which the Host serves for every package, so one
   * failed batch costs at most three requests per missing row and never fails
   * the rows that were registered.
   */
  private async arrive(row: BootModuleRow): Promise<void> {
    const { id } = row
    if (this.loadCache.has(id) || this.factories.has(id)) return
    const reload = this.reloadTargets.get(id)
    const preferred = reload?.url ?? row.initialUrl
    const fallback = reload === undefined && row.url !== preferred ? row.url : undefined
    const failures: string[] = []
    const attempt = async (url: string): Promise<'registered' | 'transport-failed' | 'not-registered'> => {
      try {
        await this.loadShared(url)
      } catch (error) {
        failures.push(`${url}: ${describeError(error)}`)
        return 'transport-failed'
      }
      if (this.factories.has(id)) return 'registered'
      failures.push(`${url}: loaded without registering "${id}" via __ModuleLoader__.load`)
      return 'not-registered'
    }
    let outcome: Awaited<ReturnType<typeof attempt>> = 'transport-failed'
    if (this.failedBundleUrls.has(preferred)) {
      failures.push(`${preferred}: skipped after an earlier failure of this bundle`)
    } else if (fallback !== undefined && this.executedBundleUrls.has(preferred)) {
      failures.push(`${preferred}: already executed without registering "${id}"`)
      outcome = 'not-registered'
      this.failedBundleUrls.add(preferred)
    } else {
      outcome = await attempt(preferred)
      if (outcome === 'transport-failed') outcome = await attempt(preferred)
      if (outcome !== 'registered' && fallback !== undefined) this.failedBundleUrls.add(preferred)
    }
    if (outcome !== 'registered' && fallback !== undefined) outcome = await attempt(fallback)
    if (outcome !== 'registered') {
      throw new Error(`client-modules: could not load "${id}": ${failures.join('; ')}`)
    }
    if (reload !== undefined && this.reloadTargets.get(id) === reload) this.reloadTargets.delete(id)
  }
```

配套：`loadShared` 让**同 URL 只有一个在途请求**（180-190）；`register` 对**同一 id 二次注册直接抛**
（163-178，错误文案：`duplicate factory registration for "…" (bundle executed twice without invalidate?)`）——
这正是"绝不重放已执行批"的原因。

### 2.4 「最多三次请求」的精确算术（原计划 §7.2 的定论）

`system.ts:207-249` 逐分支数得死：

| 情形 | 请求序列 | 次数 |
| --- | --- | --- |
| 批传输失败（`error` 事件，什么都没执行） | 批 → 批（重试 1 次） → 该行单资源 | **3** |
| 批加载成功但没注册这条 row（解析错/运行期 throw） | 批 → 单资源（批登记进 `failedBundleUrls`，绝不再取） | **2** |
| 同批更早的 row 已经让它执行过、这条仍缺 | 0（跳过批） → 单资源 | **1** |
| 批在更早的行上已记失败 | 0 → 单资源 | **1** |
| 一切正常 | 批（同批所有 row 共享在途/已执行） | 1（整批共 1） |

README 的原文也说同一条（`packages/client/modules/README.zh.md:38`）：
"一个失败的 batch 对每条缺失 row 最多花费三次请求，且不影响它已经注册的 row。
HMR（热模块替换）会让一条发生变化的 row 改用带 revision 的单资源 combo URL。"
**结论：§7.2 可以在本机源码定论为"≤3 次/每条缺行，且不重放已执行的批"。**
附带一条：**dsh 没有"平铺的单文件路由"**——单资源也是一成员的 combo（`graphRow`），
而 dsc 已有平铺单文件路由（§3.1），A3 可以保留它作为回退目标（见 §5.4）。

---

## 3. 机制三：HMR（dsh `packages/client/hmr` 全包）

### 3.1 宿主怎么知道"哪一行变了"：**每个图行一个 stat 轮询**（不是文件监听）

`hmr/src/index.ts:1-8`（模块头）+ `60-124`：

```ts
export interface Config {
  /** Bundle stat-poll interval in milliseconds (default 500, the build-side watcher's polling default). */
  pollIntervalMs?: number
}
export const Config: z<Config> = z.object({ pollIntervalMs: z.number().step(1).min(1).default(500) })
...
const pollWatches = (): void => {
  for (const [id, watch] of watched) {
    let current: WatchedBundleStat
    try { current = bundleStat(watch.path) } catch (error) { watch.dirty = true; ... continue }
    if (!watch.dirty && sameBundleStat(current, watch)) continue
    // Stat-before-publication preserves a detectable older baseline for writes that land during the read.
    publish(id, watch, current)
  }
}
```

- 轮询对象来自**当前图行**：`syncWatches()`（128-141）用 `clientModules.graph().entries` + `artifactBaseline(id)`
  做集合 diff（行删了/路径换了就撤 watch，新行加 watch），并订阅 `onGraphChanged` 以便"启动窗口期到达的插件"
  也被纳入。
- `publish`（75-90）= 调 `clientModules.rebuilt(id)`；它内部再 stat 一次算 rev，**rev 没变就整个早退**
  （index.ts:713-721）；rev 变了才重读字节、重组成图、通知 `onRebuilt`/`onGraphChanged`。
- 首次安装 watch 时会做一次"启动基线 vs 现盘"的比较（92-106）：**启动组图与装 watch 之间落盘的写入不会丢**。
- 事件形状（`hmr/src/events.ts:11-13`）：

```ts
export type PluginsEventFrame =
  | { type: 'graph'; graph: WebBootGraph }
  | { type: 'rebuilt'; id: string; rev: string }
```
  端点常量：`EVENTS_ENDPOINT = '/plugins/events'`、`EVENTS_ROUTE = EVENTS_ENDPOINT.slice(1)`（44-50）；
  帧的宽松解析在 26-41（未知 type → `unknown`，坏 payload → `invalid`，两侧都不炸）。

### 3.2 SSE 通道与"重更"的推送

`hmr/src/index.ts:158-207`：
- `publishGraph()`：任何图变化广播一帧 `{type:'graph', graph}`（161-164）；
- `connect(res)`：写 `content-type: text/event-stream`、`cache-control: no-cache`、`connection: keep-alive`，
  先发一行 `: connected`（防代理把空流当死连接），**紧接着发当前整图**（166-178）；
- `onRebuilt((id, rev))` → 广播 `{type:'rebuilt', id, rev}`（196-199）；
- 非 GET/HEAD 405（187-192），卸载时 `res.destroy()` 清场（200-206）。

### 3.3 壳怎么换（"按 revision 换 combo URL"的真相）

浏览器半侧（`hmr/src/client/index.ts:18-47`）只做转发：`graph` → `entries.sync(graph)`；
`rebuilt` → `entries.reload(id, rev)`；失败 `ctx.logger.error`，不抛。

换装的**实际机制**在 `modules/src/client/entries.ts:116-190`：

```ts
  reload(id: string, rev: string): Promise<void> {
    this.desired = { ...this.desired, modules: this.desired.modules.map(row => row.id === id ? { ...row, rev } : row) }
    return this.enqueue(async () => {
      ...
      if (this.revisions.get(id) === rev) return
      this.publish({ syncing: true, failures: this.snapshot.failures.filter(f => f.id !== id) })
      await this.replace(entry, id, rev, this.generation)
      this.publish({ syncing: false, failures: this.snapshot.failures })
    }, id)
  }

  private async replace(entry: Entry, id: string, rev: string, generation: number): Promise<void> {
    this.index.invalidateForReplacement(id, rev)   // 1) 丢弃工厂与已物化记录 + 设 reloadTargets
    await this.modules.prefetch(id)                // 2) 旧 fiber 还在服务时先把新脚本取回来
    if (!this.current(generation)) return
    await tearDownEntryFiber(entry)                // 3) 摘 runtime、等 inertia、清 entry.fiber
    removeOwnedStyles(id)                          // 4) 剔除该插件自己的样式
    if (!this.current(generation)) return
    await this.modules.import(id, '', {})           // 5) 物化新导出
    if (!this.current(generation)) return
    await entry.refresh()                          // 6) 让 Loader 用新工厂重新激活（apply 重跑）
    await entry.fiber?.await()
    if (entry.fiber === undefined) throw new Error(`client-modules: ${id} import failed (see console)`)
    this.revisions.set(id, rev)
  }
```

**"按 revision 换 combo URL"** 的落点是 `invalidate`（system.ts:469-485）：

```ts
  invalidate(id: string, rev?: string): void {
    const normalized = stripClientSuffix(id)
    if (this.bootstrapIds.has(normalized)) return
    this.importErrors.delete(normalized)
    this.generations.set(normalized, (this.generations.get(normalized) ?? 0) + 1)
    const row = this.graphRows.get(normalized)
    if (row !== undefined) {
      const revision = rev ?? row.rev
      this.reloadTargets.set(normalized, { url: atRevision(row.url, revision), rev: revision })
    } else this.reloadTargets.delete(normalized)
    for (const key of this.factories.keys()) {
      if (key === normalized || key.startsWith(`${normalized}/client.`)) this.factories.delete(key)
    }
    for (const key of this.loadCache.keys()) {
      if (key === normalized || key.startsWith(`${normalized}/client.`)) this.loadCache.delete(key)
    }
  }
```

- `row.url` 是**单资源**引用（`graphRow` 给的 `comboReference([id], rev)`），`atRevision` 把 `rev=` 换成新值
  （system.ts:31-37）；于是**重更只花 1 个请求、绝不重跑任何批**（批只在 `initialUrl` 上，且已执行过的批
  被 `executedBundleUrls` 记住，永不重放）。
- `generations` 守卫在途的分片请求：换代后旧分片到达就丢弃重取（351-378）。
- **bootstrap 批不可被替换**：`invalidateForReplacement` 对 bootstrap id 直接抛
  "replacing bootstrap module … requires a page reload"（system.ts:129-133；`updateManifest` 429-435 同条）。

### 3.4 样式怎么剔除

`entry-lifecycle.ts:19-28`：

```ts
export function removeOwnedStyles(id: string): void {
  if (typeof document === 'undefined') return
  for (const el of document.querySelectorAll('style[data-plugin]')) {
    if (el.getAttribute('data-plugin') === id) el.remove()
  }
}
```

归属是怎么记的：物化前后对"未打标的 `<style>`"取差集并打 `data-plugin=<id>`（system.ts:66-86 的
`untaggedStyles`/`claimStyles` + 298-322 的 `materialize`，失败路径也会 `claimStyles` + `removeOwnedStyles`
再抛，318-321）。样式标签 id 记进 `ClientModuleRecord.styles`（manifest.ts:369-378）。
**注入发生在物化时，所以剔除与重装天然同一节奏**：`replace` 里 "先 teardown fiber、再 removeOwnedStyles、
再 import 新代码"，README 也写明"CSS 在旧 effect 完成清理后注入"（`hmr/README.zh.md:66`）。

### 3.5 共享模块重复注册怎么防

三层：
1. **宇宙表（seed）冻结**：壳把平台单例交进模块表，`require` 命中 seed 就返回同一实例（system.ts:325-337；
   seed 内容见 `web/src/seed.ts:20-39`，9 项含 cordis/store/ui-slots/ui-primitives/ui-dockkit）；
2. **工厂注册同名即抛**（system.ts:163-178，含 `chunks` 的 `owner/file` 键）；批脚本因此**绝不能重放**；
3. **invalidate 只删自己那一族的键**（`id` 与 `id/client.*`，469-485），并推进 `generations` 让在途分片失效重取。

### 3.6 HMR 期间的状态保留口径与"页内同步失败"的可重试面

- 口径（`hmr/README.zh.md:12,36,48,116-118`）：**每次重载都重新执行插件 bundle、用全新状态重新挂载**；
  "被重载插件内的 React 状态会丢失，而会话、工作区与连接状态（数据层 fiber / Session）保留"；
  **失败不回滚**（旧 fiber 卸载后失败就是失败，不恢复旧 bundle）；"依赖被重载插件的插件会随之自动重载"
  （靠 cordis 自身的级联，队列串行化在 `entries.ts:150-160` 的 `enqueue`）。
- 可重试面：`entries.retry()`（104-107）**对同一 rev 也重试**（"重试失败条目对最新图重试，即使其 revision 未变化"）；
  UI 在"设置 → 插件 → 插件列表"里摊当前页面的同步失败（README:74；`ClientEntryState` 形状见 entries.ts:9-16：
  `{ syncing, failures: {id,message}[] }`，是**页面本地失败，不改宿主启用状态**）。
- 无关插件不受影响：reconcile 逐行 try/catch（entries.ts:228-231），失败只进 failures。

### 3.7 与分批/物化的交互（重更一个插件要不要重跑整批）

不需要，也不会：
- 图行 `url` 是单资源引用 → 重更只取 1 个请求（§3.3）；
- 批 URL 只在 **初始 HTML** 里被引用（`script-preload`），启动后没人再请求它；批已执行过的记录
  （`executedBundleUrls`）让"批里某行缺"直接走单资源（§2.2.4）；
- `graph` 帧会带新的 `batches`（因为 compose 重算了），但**客户端不会因为 graph 变化去重跑批**：
  `sync()` 只做条目增删/rev 变更（entries.ts:92-98、192-246），批只被 `BootManifest` 在 `start()` 与
  `reconcile` 的新行 `prefetch` 时用到——新行的 `initialUrl` 指向已执行过的批 URL 时，`executedBundleUrls`
  会把它直接引到单资源（system.ts:228-235）。**批结构是"页面加载级"的**（bootstrap 甚至要求整页刷新才能换，§3.3）。

---

## 4. rev 语义对比（dsh vs dsc）

| | dsh | dsc 现状 |
| --- | --- | --- |
| 内置/构建产物 rev | `sha1('plugin-artifact', mtimeMs, ctimeMs, size)[:12]`（`modules/src/index.ts:219-222`），**不是内容摘要** | `shortHash('artifact', mtimeMs, ctimeMs, size)` 12 位 FNV×4（`src/ui/manifest.ts:109-111`，宿主实际用默认 hash，`ui-bundles.ts:369`） |
| 第三方 rev | 同一条路径（dsh 没有"第三方"这一档，全部是包） | **内容摘要** `sha256(bytes)[:16]`（`ui-bundles.ts:530-535` 的 `contentRev`，注释明写"内置用 mtime 指纹、第三方用内容摘要"） |
| combo rev | `sha1('combo', [id,rev…])[:12]`（index.ts:392-398） | 无 combo |
| 图 rev | `shortHash(JSON.stringify({entries, batches}))`（index.ts:808） | `shortHash('uiboot', JSON.stringify(entries))`（manifest.ts:181） |
| 客户端怎么用 rev | 只当 key：换 URL 的 `rev=` 参数（`atRevision`）、判"同 rev 忽略"（entries.ts:131） | 同（`boot.ts` 的 `url` 直接带 rev；`pluginBundleUrl` manifest.ts:71-73） |
| 服务端怎么对齐 | **预先算好精确 URL 表**，未登记的组合 404（index.ts:776-806、1128-1149）；旧一代保留（609-610） | 单资源：解析 `<id>/<file>` + `rev`，命中当前/上一代才 200（`ui-route.ts:75-101`），旧代字节只在当初服务过时才有（`ui-bundles.ts:431-440`） |

**要点**：两边 rev 都不是内容摘要（内置档），都靠 mtime/ctime/size；dsc 的第三方档**已经**是内容摘要，
所以计划 §3 C2 只剩"内置档要不要改内容摘要"这一个问题（见 §8.2 的建议）。

---

## 5. dsc 现状（宿主侧为准）

### 5.1 路由与伺服：`src/core/ui-route.ts`（110 行，整份读过）

- 路由前缀 `UI_BUNDLE_ROUTE = '/plugins/'`（25）；判定 `isUiBundleRequest`（40-42）。
- 唯一解析函数 `resolveUiBundleRequest(pathname, rev, dir = uiPluginsDir(), method = 'GET')`（52-109）：
  1) 方法闸：非 GET/HEAD → 405 + `allow`（58-60）；
  2) `rest = pathname.slice('/plugins/'.length)`，`slash = rest.lastIndexOf('/')`，**最后一个 `/` 之前全是 id**
     （`@scope/name` 成立），之后是文件名，文件名不许带分隔符（61-74）；
  3) **缺 rev / 空 rev 一律 404**（75-77，注释 27-28 行：不混进一年不可变缓存）；
  4) `lookupUiPluginBundle(id, file, rev, dir, wantBody)`（79）；`known=false` 再查第三方
     `lookupThirdPartyUiBundle`（80-93）；两代都没有 → 404 + 一句人话（92、94、95-101）；
  5) 200 头：`content-type: text/javascript; charset=utf-8` + `content-length` +
     `cache-control: public, max-age=31536000, immutable`（102-108）。
- **combo 请求今天必然 404**：`/plugins/??a/client.js&rev=x` 的 pathname 是 `/plugins/`（带尾斜杠，
  `isUiBundleRequest` 仍是 true），但 `rest === ''` → `slash = -1` → `slash <= 0` → 404"没有这个插件资源"（63-64）。
  → A3 需要**在 52 号函数里显式加一支**（落点见 §5.6）。

### 5.2 产物与代际：`src/core/ui-bundles.ts`（863 行）

- `uiAssetsDir()`/`uiPluginsDir()`（59-66）：`lib/ui/assets`、`lib/ui/plugins`（编译产物 `lib/core/ui-bundles.js`
  上溯一级，打包态跟着 `lib/` 进 extraResources）。
- 产物表缓存 `UiArtifactCache`（310-454）：
  - 钥匙 = `manifest.json` 的 `mtimeMs:size`（`fingerprint()` 328-336；`statSync` 次数计入
    `CACHE_COUNTERS.manifestStats`）；
  - 建表 `rebuild(force)`（339-404）：逐条过 API 门禁（`evaluateUiApiGate`，349-355）、`inside()` 围栏（357-361）、
    逐文件 `statSync` 算 `artifactRev(stat)`（362-372，`CACHE_COUNTERS.fileStats`）；
  - **换代**（375-386，逐字）：

    ```ts
    // 换代：这一代变了或被删掉的，整条挪进上一代表（旧窗口可能还拿着它的地址）。
    // 没变的保持原样——上一代仍然是最早那一代，别把它顶掉。
    const nextPrevious = new Map<string, PreviousGeneration>()
    for (const [key, cached] of this.byKey) {
      const fresh = nextByKey.get(key)
      if (fresh !== undefined && fresh.row.rev === cached.row.rev) { ...继续保留原 previous... continue }
      nextPrevious.set(key, { rev: cached.row.rev, size: cached.size })
    }
    ```
  - 字节缓存只留"当前代 + 上一代"用得着的（388-394）；`table()`（407-410，非 force）与 `refresh()`（413-416，force）。
- `lookup(...)`（423-443）：当前代 → 读盘并缓存；上一代 → **只在当初服务过时才有字节**
  （注释 433："已经打开的页面必然取过一次，所以这条路走得通"）；`body: wantBody ? … : null` 支持 HEAD。
- **构建产物清单**：`readUiPluginManifestReport`（172-243）只认 `id/file/platform/inject/external/api/immediately`
  → **没有 `phase`**（新增点见 §6.2）。`collectUiPluginArtifacts`（477-484）是**单目录**取表；
  `collectUiArtifactsForPlatform`（850-862）是"内置 + 第三方合成"的唯一口子（注释 845-849 明令"谁也不许自己再拼一份"）。
- 第三方：`discoverThirdPartyUiArtifacts`（585-675）读 `plugin.json` 的 `api/platforms`，信任/启停/撞名逐条记 problems；
  `lookupThirdPartyUiBundle`（823-843）与内置同一份 `UiBundleLookup` 形状，**rev = 内容摘要**。
- 诊断计数先例：`uiArtifactCacheCounters()` / `resetUiArtifactCacheCounters()`（289-301）——A3/B 的探针计数器照这个形状做。

### 5.3 伺服：`src/core/ui-server.ts`（425 行）

请求处理顺序（`handleRequest`，264-375）：
1. 信任三道闸（Host / sec-fetch-site / Origin）：`checkUiRequestTrust`（266-271）；
2. `/?token=` 换 Cookie 303（279-309）；Cookie 校验失败 401（310-314）；
3. **`/plugins/*`**：`sendBundleResponse(res, resolveUiBundleRequest(url.pathname, url.searchParams.get('rev'), pluginsDir, method))`
   （318-321）；
4. **`/api/boot`**：GET/HEAD → `sendJson(res, 200, buildBoot())`（322-330，**每次请求都 force 重收**）；
5. **`/boot.js`**：`globalThis.__DSC_BOOT__=<bootJson>`，`cache-control: no-cache`（333-346）；
6. `/api/events`（GET only）与 `/api/invoke`（POST only）（348-364），都转发给 `core/ui-events.ts` 的通道；
7. 静态资产 + CSP：`serveStatic(..., { placeholderHtml, transformHtml: injectBootScriptTag, contentSecurityPolicy: UI_CONTENT_SECURITY_POLICY })`（365-372）。

- **CSP**（187-198，导出给远程复用）：

  ```ts
  export const UI_CONTENT_SECURITY_POLICY = [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", "font-src 'self'", "connect-src 'self'",
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
  ].join('; ')
  ```
- **启动图注入**：`injectBootScriptTag`（204-208）只插一行 `<script src="/boot.js"></script>`；
  `bootJson` 把 `<` 转义成 `\u003c`（252-253）。
- **组图点**（`buildBoot`，236-249）：

  ```ts
  const fresh = collectUiArtifactsForPlatform('web', { force: true, builtinDir: pluginsDir })
  artifacts = fresh
  const rows: (UiPluginRow & { rev: string })[] = fresh.entries.map((entry) => ({ id, rev, ...inject, ...external, ...immediately }))
  return composeUiBootGraph(options.host, rows)
  ```
- 句柄（391-413）：`boot()`（force）、`problems()`、`refresh()`（force）；`refresh` **仓内没有调用方**（只有
  `webserver.ts:138` 用 `problems()`）。
- 组装点为两处：**这里** 与 **`src/plugins/remote.ts:557-570`**（远程壳的 `/api/boot`、`/boot.js` 同形；
  路由复用 `resolveUiBundleRequest`，`remote/routes.ts:360-362`）。第三个消费点是 TUI：
  `src/ui/tui-plugins.ts:71` 直接读字节（in-process），与 web 批无关。

### 5.4 SSE 现状：`src/core/ui-events.ts`（396 行）

- 连接集合、心跳（15s 注释行）、`retry: 3000`、`Last-Event-ID` 补帧、`missedWhileIdle`、慢客户端断开
  （`clients`/`lag`/`draining`/`MAX_WRITE_LAG=3`，见 121-196、269-282、289-337）。
- **事件类型只有三种**：`hello`（握手，握手帧带 `{protocolVersion, methods, host}`）、`frame`（带 `id: <seq>` 的
  快照帧）、`error`（造帧失败，带 `{"error": …}`）（`writeEvent` 99-103；emit 点 227-241、303-336）。
- 通道的对外形状：`UiEventsHandle` = `{ handleEvents, handleInvoke, clients, stop }`（88-97）；
  选项 `UiEventsOptions` 里 `snapshot/invoke/methods/hello/subscribe`（68-85）——**加 HMR 推送要么扩这两处，
  要么另起端点**（建议见 §7.3）。
- 壳侧消费：`ui-shell/src/host-channel.ts` **一条 EventSource** 连 `/api/events`，只监听
  `hello`/`frame`/`error`（128-187）；未知事件名被浏览器直接忽略 → **新增一种事件名对旧壳向前兼容**。
- 通道创建点：`src/plugins/webserver.ts:95-126`（本地）与 `src/plugins/remote.ts:537-556`（远程）。

### 5.5 启动图形状：`src/ui/manifest.ts`（184 行）

```ts
export interface UiPluginRow {
  id: string
  external?: string[]      // 允许 import 的额外模块名（白名单）
  inject?: string[]        // 必须先把工厂注册好的其它插件 id
  immediately?: boolean    // 第一档预取
  platform?: UiPlatform
  api?: string             // @dsc/ui 区间（第三方必需）
}

export interface UiPluginEntry {
  id: string
  url: string              // `plugins/<id>/client.js?rev=abc123`
  rev: string
  inject?: string[]; external?: string[]; immediately?: boolean
}

export interface UiBootGraph {
  rev: string
  entries: UiPluginEntry[]
  host: { name: string; version: string }
}
```
（19-58 行；`pluginBundleUrl` 71-73；`shortHash` 76-92；`artifactRev` 109-111；
`orderUiPlugins` 126-158 拓扑排序 + 成环/重复 id 抛错；`composeUiBootGraph` 169-183。）
**没有 `batches`**（计划 §1 那条差距成立）。整图 rev 的注释（163-167）特意说明"对整条 entry 摘要，
声明类变更也要换 rev"——A2 的 `phase` 属于同类，必须进摘要（§6.3）。

当前 16 个内置插件的清单里：**`inject` 一个都没有、`immediately` 一个都没有**
（`lib/ui/plugins/manifest.json` 只有 `id/file/platform/api`），也没有任何内置插件目录带 `plugin.json`
（`ui-shell/src/plugins/*/plugin.json` 不存在）。→ A1 的 inject 与 A2 的 immediately/phase
目前都是"有类型、有构建支持、无人消费"，探针必须自己造样本（照 `scripts/ui-serve-test.mjs:279-289` 的临时目录树做法）。

### 5.6 开发态 vs 产品态两条路径（B 服务哪条的关键）

| | vite dev（`pnpm -C ui-shell dev`） | 产品/桌面（宿主伺服） |
| --- | --- | --- |
| 壳 app | vite dev server（`ui-shell/vite.config.ts:34-54`，`base: './'`，端口 5373，React refresh） | 宿主 `serveStatic` 伺服 `lib/ui/assets`（ui-server.ts:365-372） |
| `/api`、`/plugins` | **代理**到宿主 `DSC_UI_ORIGIN ?? http://127.0.0.1:17322`（vite.config.ts:31-32、47-54） | 同源，宿主自己伺服 |
| `/boot.js` | **不代理** → `readBootGraph` 回落到 `/api/boot`（`ui-shell/src/boot.ts:86-101`） | `</head>` 前外链脚本，`__DSC_BOOT__` 已就位 |
| 插件 bundle | 由 `node build-plugins.mjs` 产出（**vite dev 不管插件**），落在 `lib/ui/plugins/<id>/client.js` | 同一份产物，随 `lib/` 进 extraResources（`desktop/electron/main/index.ts:64-68`、`desktop/scripts/prepare-runtime.mjs`） |
| 桌面窗口加载哪份 | `ELECTRON_RENDERER_URL` 非空时窗口留给 vite（`main/index.ts:177`） | `adoptUiServer` → `loadURL(origin)`（166-185），`uiProfile()` 决定伺服壳还是旧渲染层（85-104） |

**dsh 的 HMR 也是 dev 态为主**（`hmr/README.zh.md:32`：`pnpm run dev:web` 同时起宿主与重建 watcher；
"仅负责 Web 传输——Electron 的安装和后端重启流程不使用此 SSE 路径"）。dsc 的对应结论：
**HMR 服务"插件 bundle 的取数路径"，与壳 app 走谁伺服无关**——因为插件字节永远来自宿主
（vite dev 只代理 `/plugins`）。所以 HMR 的正确落点是**宿主侧**（探测 `lib/ui/plugins/` 的变化并推帧），
vite 自带的 HMR 只覆盖壳自身代码（`ui-shell/src/**`），两者不重叠、也不冲突。

### 5.7 探针现状（第 3/4 波要长在这两条轨上）

- `scripts/ui-serve-test.mjs`（453 行）：真起 `createUiServer`（临时 `assetsDir`/`pluginsDir`、
  真换票、真 Cookie）驱动全部伺服断言；bundle 代际断言在 330-397（缺 rev 404、旧 rev 给旧字节、重建后
  rev 变、新 rev 给新字节、从没出现的 rev 404、HEAD/405/穿越）；产物表缓存在 384-397
  （用 `uiArtifactCacheCounters()` 数 stat）；清单失败方向在 413-448。
- `scripts/ui-events-test.mjs`（446 行）：帧序号不变量、断线补帧、全量广播、心跳/错误/上限、背压
  —— **SSE 侧的探针轨**：`startServer()`（129-164）起"真服务 + 真通道 + 临时目录"，
  `sseOpener()`（167-185）开真连接收文本并 `readFrames()` 解析（188-200）。
- `scripts/ui-plugin-test.mjs`（952 行）：槽位/清单/发现/真服务的纯 node 断言；末尾还验真实 `lib/ui/` 产物
  （bundle 里 `require("@dsc/ui")` 等，877-882）。第 420 行有一条断言"改 `immediately` 整图 rev 要变"——A2 改 rev 摘要公式时它会跟着动。
- 桌面/浏览器侧：**没有 playwright/puppeteer**（全仓无该依赖），真页面断言靠
  `desktop/shots/*.ps1` + Electron 主进程的 `DSC_DESKTOP_SHOT`/`DSC_DESKTOP_SHOT_EVAL`
  （`desktop/electron/main/index.ts:830-880`：`executeJavaScript(preScript)` 的返回值写进 stderr
  `[selfcheck] 预跑脚本完成：…`），以及 `desktop/shots/pkg-smoke.ps1`（打包件实跑 + eval 断言 DOM）。
  宿主是 `utilityProcess.fork`（`desktop/electron/main/protocol.ts:60-64`，未指定 stdio）→ 宿主 stderr
  与桌面 stderr 合流，**探针可以直接 grep 宿主日志**（计划里"stderr 打出两批物化时刻"的可实现形态）。

---

## 6. A2 落点设计：启动分批（与"懒物化"能对齐到什么程度的实话）

### 6.0 先纠一个概念（施工者最容易做歪的一处）

- dsh 的 `bootstrap` 批 = **模块系统包本身**（§1.2），它 parser-blocking 先跑是为了让
  `window.__ModuleLoader__` 在壳之前存在；dsc 没有"页面内模块系统"这一层（壳就是 vite 打的 ESM app，
  且 dsc 的工厂表 `__DSC_UI_FACTORIES__` 是**被动注册表**，不承担 require 解析），所以**不存在** bootstrap 批。
- dsh 的"模块体首次使用才执行"是**惰性 CJS 模块表**的产物（§1.3）；dsc 的 `loadUiPlugins` 是
  **一次性 apply 循环**（`ui-shell/src/boot.ts:178-189`：对每条 entry `install()`），插件只有 apply 过
  才会往槽里登记，槽渲染才有东西 —— 因此"首次使用才 apply"在 dsc 不成立（也不该成立）。
- **A2 在 dsc 能兑现的收益**（也就是验收口径 §2.5"第一批（骨架）先可见"）：
  1. 批次把**取数与 apply 分两时段**：第一批（early）装完就挂载 React 首帧，第二批（application）
     在第一帧之后才取字节、才 apply；
  2. 批内 entry 的工厂仍然是"脚本一跑就注册"（不变），但批脚本**可以合并成一个请求**（A3）；
  3. `immediately`（预取档）保持与 dsh 同义（stage-one prefetch），与 phase **正交**。

### 6.1 wire 形状（建议）

`src/ui/manifest.ts` 增（对齐 dsh 的字段名与不变量，phase 词表用 dsc 自己的）：

```ts
/**
 * 一个批的调度档位。dsh 的 `'bootstrap'` 在本项目没有对应物（它的 bootstrap 批是页面里的
 * 模块系统本身，壳不是插件）；这里的第一批是**首屏批**：装完就渲染首帧。
 * 词表刻意不复用 'bootstrap'，免得有人以为它承担"先于壳执行"的职责。
 */
export type UiBootPhase = 'early' | 'application'

export interface UiBootBatch {
  phase: UiBootPhase
  /** 批脚本的地址（A3 起 = combo；A2 单独落地时可以缺省，壳按 entries 逐条走单资源 URL）。 */
  url?: string
  /** 批内容的版本锚（与 url 同生共死；缺 url 时也缺它）。 */
  rev?: string
  /** 本批要注册工厂的 entry id，按执行顺序。 */
  entries: string[]
}

export interface UiBootGraph {
  rev: string
  entries: UiPluginEntry[]
  /** 每个 entry 恰好属于一个批；批按执行顺序排列（early 在前）。 */
  batches: UiBootBatch[]
  host: { name: string; version: string }
}
```

不变量照 dsh 抄（manifest.ts:265-304）：phase 只认两个值；每个 entry 恰在一个批里；
批的 entries 非空；批内顺序 = `orderUiPlugins` 之后按 phase 切片的相对顺序。
**若团队坚持与 dsh 逐字对齐 phase 名**，就用 `'bootstrap' | 'application'` 并在类型注释里写明
"本项目里 bootstrap 批不含任何 entry / 只含'首屏批'"——但那是**会给后人挖坑的命名**，不推荐。

### 6.2 `phase` 从哪来：`plugin.json` → 清单 → `UiPluginRow`

1. `ui-shell/build-plugins.mjs` 的 `readMeta`（69-143）增一支，照 `immediately` 那条的写法
   （129-132）：

   ```js
   if (doc.phase !== undefined) {
     if (doc.phase !== 'early' && doc.phase !== 'application') {
       throw new Error(`${dir}/plugin.json 的 phase 只能是 'early' / 'application'`)
     }
     meta.phase = doc.phase
   }
   ```
   注意 `readMeta` 现在**静默忽略未知键**——写错一个 `phse` 会毫无反应。这条校验是把"拼错"变成构建失败的地方。
2. 清单条目多一个 `phase`（`build-plugins.mjs:218` 的 `plugins.push({ id, file, platform, ...meta })` 自动带上）。
3. `src/core/ui-bundles.ts` 的 `readUiPluginManifestReport`（200-241）在 `immediately` 旁边增读 `phase`
   （类型/取值校验，坏值记 problems 并丢弃该字段，方向与 226-231 的 `api` 一致），并加进 `entries.push`（232-240）。
   第三方侧 `discoverThirdPartyUiArtifacts`（610-664）同理读 `plugin.json` 的 `phase`（可缺省；
   建议：**第三方允许声明**，缺省 application）。
4. `UiPluginRow` 增 `phase?: UiBootPhase`（`src/ui/manifest.ts:19-37`）；`UiPluginEntry` **不带** phase
   （phase 是批的属性）。
5. **两个组图点都要带过去**：`src/core/ui-server.ts:241-247` 与 `src/plugins/remote.ts:558-565` 都是手抄字段
   （`...(entry.immediately === true ? { immediately: true } : {})` 那几行）。**建议顺手收敛成一个共享小函数**
   （如 `ui-bundles.ts` 导出 `toUiPluginRows(entries)`），否则以后再加字段还要记得改两处——这是既有漂移点。
6. TUI（`src/ui/tui-plugins.ts:71`）读到 `phase` 也**什么都不用做**（in-process 顺序装载，没有请求数问题），
   但要在 `UiPluginRow` 的注释里写一句"phase 只对 web 载体有效"。

### 6.3 组装点：`composeUiBootGraph`（`src/ui/manifest.ts:169-183`）

改法（行号是现状，施工时按 §7 rebase）：

```ts
const ordered = orderUiPlugins(artifacts)
const entries: UiPluginEntry[] = ordered.map(...)              // 现状 173-180
const batches: UiBootBatch[] = groupByPhase(ordered)           // 新增：按 phase 切片，保持 ordered 内相对顺序
const rev = shortHash('uiboot', JSON.stringify(entries), JSON.stringify(batches))   // 现状 181，必须把 batches 也摘要进去
```

`rev` 的摘要**必须**含 batches：`phase` 改了但 entries 一个字节没变时，图 rev 也要变
（理由与 163-167 行注释对 `immediately` 的说法完全一致）。空 `application` 批不发（entries 非空不变量）。
`application` 缺省：**没写 `phase` 的条目全部进 `application`**（这样零改动的现状 = 单批，
`batches` 长度 1，等价于今天的加载顺序）。

### 6.4 壳侧（概念级；`boot.ts` 在动）

- `readBootGraph()`（boot.ts:86-101）拿到的 `UiBootGraph` 多了 `batches`；**缺 `batches` 的旧宿主**
  按"单 implicit application 批"处理（向前兼容，`ui-shell` 与宿主版本会错位）。
- `loadUiPlugins(graph, …)`（boot.ts:109-206）按 phase 分两段执行：
  1. **early 段**：`immediately === true` 的仍走并发预取（现状 118-129）；然后按 `orderUiPlugins` 的顺序
     `install()` 本批全部条目；
  2. 交还控制权（`main.tsx` 在 early 段结束后就 `createRoot(...).render(...)`；**现状是等全部装完**
     ——`ui-shell/src/main.tsx:99-119` 的 `loaded = await loadUiPlugins(...)` 之后才 render，这是 A2 必须改的那一处）；
  3. **application 段**：`requestIdleCallback`（回落 `setTimeout 0` / 双 `requestAnimationFrame`）后继续装，
     每条结果仍写进同一份 `reports`；`App` 用 reports 的增量重渲染（或用一个 shell 级 store 推一次）。
- 建议给壳加一个**只读的启动账本**（探针的读数面，见 §6.6）：

  ```ts
  // ui-shell/src/boot.ts 导出（或挂 globalThis.__DSC_UI_BOOT_LOG__）
  export interface UiBootLogEntry { phase: UiBootPhase; at: number; entries: string[]; ok: boolean }
  ```
  实现即在每段结束时 push 一条 + `console.info('[ui-shell] 批 … 完成 @…')`，并在诊断区画一行。
- **失败与诊断**：第二批失败不阻塞第一批（每条的 try/catch 与"失败重试一轮"照旧，boot.ts:170-189）；
  诊断区（`ui-shell/src/app.tsx:476-560`，`?diag=1` 常显，`data-*` 属性留给探针）
  增一行"批：early 8/8 @312ms，application 8/8 @1480ms"与逐条 phase 标注。
  phase 坏值的方向：**内置 = 构建失败**（6.2 第 1 条）；**第三方 = 记 problems 不进图**
  （与 `ui-bundles.ts:210-223` 的 platform/字段失败方向一致）。
- 一个必须在文档里写清的限制：**phase 是"页面加载级"的**，HMR 重更一条不会改它的 phase
  （与 dsh 同口径，§3.7）；改 phase 要刷新页面。

### 6.5 `plugin.json` 字段清单（A2 后）

内置插件目录：`package.json`（必带，peer 区间 → 清单 `api`）+ 可选 `plugin.json`
（`inject` / `external` / `immediately` / `platforms` / **`phase`**）。
第三方目录：`plugin.json`（必带 `api`；可选 `platforms` / **`phase`**）+ `ui/client.js`。
契约版本：`@dsc/ui` 的清单字段含义变了 → 按 `docs/plugin-development.md:610-619` 的升级纪律，
新增可选字段是**次版本 +1**（`ui-shell/package.json` 1.1.0 → 1.2.0），并同步
`lib/ui/plugins/manifest.json` 顶层 `apiVersion`（构建自动写，`build-plugins.mjs:228-232`）。

### 6.6 验收探针（"第二批未物化时第一批已可交互"怎么观测）

分两腿，都在既有轨上：

**腿 1（node，快、必跑）** —— 新 `scripts/ui-batches-test.mjs`，照 `ui-serve-test.mjs:279-289` 造临时
`pluginsDir`（16 个假插件，其中 `phase: 'early'` 的 6 个）+ 真 `createUiServer`，断言：
- `/api/boot` 返回 `batches`，每个 entry 恰在一个批、early 批在数组前、`entries` 顺序与 `orderUiPlugins` 一致；
- `phase` 写坏 → 该条不进 `entries` 且 `problems()` 有一句（内置侧：跑一次 `build-plugins.mjs` 的
  `readMeta` 单测路径，或直接断言构建失败——见 C1 的既有做法）；
- 改一个插件的 `phase` 声明（重写 `manifest.json`）→ 图 `rev` 变（照 `ui-plugin-test.mjs:420` 的既有断言形状）；
- `/boot.js` 里的图与 `/api/boot` 逐字节同源（同一 `buildBoot`）。

**腿 2（真页面，桌面探针）** —— 新 `desktop/shots/batches-check.ps1`，用既有机制
（`main/index.ts:830-880`）：
- `DSC_UI_QUERY=diag=1`、`DSC_UI_SHELL=1`、隔离 HOME；
- `DSC_DESKTOP_SHOT_EVAL` 脚本：
  1. `await` 到 `#root` 里有第一批插件画的 DOM（例如 `.composer textarea`，`pkg-smoke.ps1` 已用同款选择器）；
  2. **立刻**读启动账本：`window.__DSC_UI_BOOT_LOG__.filter(e => e.phase === 'application').length === 0`
     （第二批还没被 apply）+ 读诊断区那一行；
  3. 等第二批完成（轮询账本里出现 application 条目，超时 15s 判负）；
  4. 返回 `{ earlyAt, appAt, firstFrameAt, earlyDom: true, appEntries: [...] }`；
- `firstFrameAt` 由壳在 `createRoot(...).render(...)` 之后打点（`main.tsx:113-119` 后一行）；
- **断言**：`earlyAt < firstFrameAt <= appAt`（这就是"第二批未物化时第一批已可交互"的可观测形式）。
- stderr 侧那条"两批物化时刻"：宿主看不到页面执行时刻，**别去宿主上加假日志**——
  页面的 `console.info` 由 EVAL 读、账本由 DOM/global 读（详见 §8.3 对计划原文的修正）。

---

## 7. A3 落点设计：combo 批打包

### 7.1 路由落点（`src/core/ui-route.ts`）

在 `resolveUiBundleRequest`（52-109）里**方法闸之后、单资源解析之前**加一支：

```ts
// combo：/plugins/??<res>,<res>&rev=<comboRev>（资源形如 <id>/client.js；rev 用 & 分隔）
const combo = resolveUiComboRequest(pathname, search, dir, method)   // 新增，见下
if (combo !== undefined) return combo
```

更稳的签名（推荐）：新增导出 `resolveUiComboRequest(pathname: string, search: string, dir, method)`
（或在 `UiBundleResponse` 同侧加一个 `resolveUiResourceRequest(pathname, search, dir, method)` 把两支收在一处），
由 `ui-server.ts:318-321` 与 `remote/routes.ts:360-362` 都改调它（两处同一份口径，正是 `ui-route.ts:3-6`
文件头的既有理由）。**不要**只给 `resolveUiBundleRequest` 加一个 `list` 参数——两个调用点已经在传 `rev`，
再加参数会把"单资源/批"的分支散到调用方。

判定要点：
- combo 的判据是 **`search` 以 `??` 开头**（`pathname === '/plugins/'`），不是 pathname 里的 `??`；
- `method` 闸与单资源同一份（非 GET/HEAD 405 + `allow`）；
- **不做通用解析**（dsh 同款：精确 URL 表，未登记组合 404，`index.ts:1128-1149`）：
  宿主在组图时把"每个批 → (URL, 惰性体)"登记好，路由只按 `<pathname>+<search>` 命中；
  这样避免 `@scope/name/client.js` 这类多段 id 在解析上的歧义，也自动实现了"未通告的组合不给"。

### 7.2 打包格式与 URL/rev

- **URL**：`plugins/??<id>/client.js,<id>/client.js&rev=<comboRev>`（图里 document-relative）；
  路线形式 `/plugins/??…&rev=…`。id 用 `encodeURIComponent` 单段编码后再拼（dsc 的 id 可能含 `@`，
  且第三方 id 是目录名——`ui-bundles.ts:56` 的 `PLUGIN_ID` 允许 `@scope/name`，`@` 与 `/` 在 query 里合法，
  但编码最省心）；`client.js` 字面量照 dsh 保留。
- **comboRev**：`shortHash('uicombo', ...resources.flatMap(r => [r.id, r.rev]))`（`src/ui/manifest.ts:76-92`
  的 `shortHash`，长度与 dsh 一致都是 12）。**任一成员 rev 变则 comboRev 变**；`batches[].rev` 就存它。
- **体**：把批内每个 `<id>/client.js` 的**文件字节**顺序拼接，成员文件本身已经是
  `(globalThis.__DSC_UI_FACTORIES__ ??= {})[id] = function (require, module, exports) {\n…};\n`
  （`ui-shell/build-plugins.mjs:207-211`）。所以：
  - 拼接就是 `parts.join('')`（每段自带 `;` 换行，不需要额外分隔符；纯防御可以插 `\n`）；
  - **作用域安全**：每段自己的代码全在那个 function 内，顶层只有一句赋值表达式，不会互相撞变量；
  - **无 sourcemap 尾注可剥**：插件构建是 `sourcemap: false`（build-plugins.mjs:190）→ 不需要 dsh 的
    `SOURCE_MAP_TRAILER` 处理；
  - 头：`content-type: text/javascript; charset=utf-8` + `content-length` + `cache-control: public, max-age=31536000, immutable`
    （与 `ui-route.ts:102-108` 逐字一致）。
- **旧一代**：与单资源同一纪律（`ui-route.ts:14-17` 的注释就是这条规矩）——批 URL 也要保留**一代**：
  compose 时把每个批的体做成**捕获了 Buffer 的惰性闭包**（dsh `lazyBody`，index.ts:383-390），
  换代时把上一代 map 整份留着（dsh `previousBatchResponses`，609-610、789-804）。
  为什么不能靠"重读盘"：盘上已经是新字节，而单资源的"上一代字节"在 `UiArtifactCache.bytes` 里
  只对**当初以单资源 URL 服务过**的才有（`ui-bundles.ts:431-440`）——批成员没有单资源记录，
  所以批的旧体只能靠保留（内存里几百 KB，可接受）。
- **一个组合失败（成员缺文件/rev 对不上）怎么办**：**宿主侧整条 404**（dsh 口径），
  但要让这几乎不发生——成员文件在**组图时**就已经被判过（`ui-bundles.ts:362-372`：缺文件不进表、
  进 problems），所以"图里有的成员"在组图那一刻必然可读。运行期唯一会 404 的是
  "盘上文件被删/换掉、且录音还没换代"→ 客户端走 §7.3 的回退。

### 7.3 回退策略的精确请求数（客户端，dsh 逐字对齐）

壳侧 `fetchFactory`/批取数（boot.ts:233-263，第 2 波在动）要长出 dsh `arrive()`（`system.ts:207-249`）的三态：

| 情形 | 行为 | 请求数/每条缺行 |
| --- | --- | --- |
| 批脚本 `error`（传输失败） | **同 URL 再取一次**；仍失败 → 该条走单资源 URL | 3（批×2 + 单×1） |
| 批脚本 load 了但没注册这条 id | **绝不重放批**（登记进"批已执行"集合）→ 单资源 | 2 |
| 同批更早的条目已经让批执行过、这条仍缺 | 跳过批 → 单资源 | 1 |
| 批 URL 已在上一次失败里被记 | 跳过批 → 单资源 | 1 |
| 正常 | 批一次注册全批（同批后续条目直接命中工厂表，**0 额外请求**） | 整批 1 |

壳侧计数实现（探针读数面）：`window.__DSC_UI_BOOT_LOG__` 每条记 `{url, phase, at, ms, ids, ok}`，
"物化请求数" = 其中 `/plugins/` 前缀（或 `??` 含 combo）的条目数。**注意 dsc 与 dsh 的两个差别**：
- dsc 的工厂表是**后写覆盖**（`boot.ts:236` 先 `delete table[entry.id]` 再插脚本），不是 dsh 的"二次注册即抛"，
  所以 dsc 里"重放批"不会炸，只会白跑——正因为不会炸，**更要靠"批已执行"集合显式禁止重放**，
  否则 HMR 之后的一次批重拾会把整批旧工厂盖回来（隐蔽 bug）。
- dsc 的行 URL 保持 `plugins/<id>/client.js?rev=<row.rev>`（`src/ui/manifest.ts:71-73`），
  **不要**改成 dsh 的"一成员 combo"。理由：单资源路由、旧一代保留、HEAD/405 语义、既有探针
  （`ui-serve-test.mjs:335-382`）都已围绕它立住；combo 只加在 `batches[].url` 上，HMR 回退正好用它。

### 7.4 与 CSP 的相容性

`script-src 'self'`（`ui-server.ts:187-198`）：combo 响应是同源 `text/javascript` 的 `<script src>`
→ **不受影响**；`??`/`,`/`&` 都是合法 query 字符，浏览器按原样发出。
反向的注意点：**别用 `fetch()` + `eval`/`new Function` 去实现批加载**——`script-src` 没开 `unsafe-eval`，
那是计划 §3 A3 之外的自伤；`<script src>` 是唯一被放行的形态（这条理由在
`ui-shell/src/boot.ts:11-14` 已写死过）。

### 7.5 验收探针（"16 个插件物化请求数 ≤ 3"怎么数）

1. **宿主侧计数（权威、可自动化）**：在 `ui-server` 的 `/plugins/*` 分支加一个只读计数器，
   形状照 `uiArtifactCacheCounters()`（`ui-bundles.ts:289-301`）：
   `{ combo: n, single: n, byId: Record<string, n> }`，经 `UiServerHandle.stats()` 暴露
   （`ui-server.ts:391-413` 的句柄上加一项；**不动** `/api/invoke` 白名单）。node 探针直接读它。
2. **页面侧计数（真页面）**：`window.__DSC_UI_BOOT_LOG__` 里 `/plugins/` 条目数 ≤ 3
   （early 批 1 + application 批 1 + 允许 1 次回退）。桌面探针 `DSC_DESKTOP_SHOT_EVAL` 里读它并返回。
3. **负例**：把某个成员的 `client.js` 在组图后删掉（probe 期间 `rm`）→ 批 404 → 观察
   `BOOT_LOG` 出现"批×1 + 该条单资源×1"且其余条目照常可用（这就是"组合里一个 id 404 → 其余照常、
   缺的单独重取一次"）。要精确复现 dsh 的"传输失败 3 次"路径，得让响应连接中断（node 探针里用一个
   会 destroy socket 的假服务），**桌面探针不必覆盖这一档**。
4. node 探针另加：combo 体 = 成员字节按序拼接（逐字节比对）、`content-length` 对、缺 rev/错 rev 404、
   HEAD 无体、非 GET/HEAD 405 + Allow、`@scope/name` 成员的 combo 能伺服、旧一代 combo 在换代后仍 200。

---

## 8. `UiBootGraph` 之后的 B：开发态热更（HMR）设计

### 8.1 服务哪条路径（**关键设计点**）

- **服务"宿主 → 页面"的插件取数路径**，与壳 app 由谁伺服无关（§5.6 的表）：vite dev 下 `/plugins`
  被代理到宿主，产品态宿主自己伺服；两条路径的插件字节都来自宿主。
- **变更检测放宿主侧**（不是 vite 插件、不是构建脚本触发）：
  - 理由 1（dsh 同款，`hmr/src/index.ts:1-8`）：**轮询而不是文件监听**——网络盘/挂载盘不给 inotify，
    而且"构建把文件写在临时目录再 rename"这类写法的 inotify 语义各平台不同；stat 轮询 500ms 的成本可忽略。
  - 理由 2：dsc 的 dev 循环是 `pnpm -C ui-shell build:plugins`（或手改 `lib/ui/plugins/<id>/client.js`），
    两者都会让 stat 变；构建脚本触发需要宿主与构建进程耦合（多一条 IPC），收益是省 500ms。
  - 结论：**宿主 stat 轮询**（`fs.statSync` + `setInterval`，`unref()`），并把它做成可配
    （`pollIntervalMs`，缺省 500，与 dsh 对齐）+ 可关（打包态缺省关，见 §9.3）。

### 8.2 变更检测与"哪一行变了"

新模块 `src/core/ui-hmr.ts`（**不依赖 cordis**，照 `ui-events.ts:25-26` 的纪律，可被 node 探针单独驱动）：

```ts
export interface UiHmrWatch { id: string; path: string; mtimeMs: number; ctimeMs: number; size: number }
export interface UiHmrOptions {
  /** 现在这一代：产物表 + 组好的图（宿主的一个快照口径，见 §8.3）。 */
  current(): { entries: { id: string; rev: string; file: string }[]; graph: UiBootGraph }
  /** 强制重收产物表（= uiArtifactCache.refresh()），返回新代。 */
  refresh(): { entries: ...; graph: UiBootGraph }
  onChange(patch: { graph: UiBootGraph; rebuilt: { id: string; rev: string }[] }): void
  pollIntervalMs?: number
}
```

轮询逻辑（dsh `pollWatches`/`publish`/`watchRow`，`hmr/src/index.ts:75-124` 的 dsc 版）：
1. 每周期 `statSync` 每个图行的 `lib/ui/plugins/<id>/client.js` + 一次 `manifest.json`；
2. 任一元数据（mtime/ctime/size）变 → `refresh()` 重收产物表 + 重组图；
3. 与上一代比：图 `rev` 变 → 发 `graph` 帧；逐行 `rev` 变（或新增/删除）→ 发 `rebuilt` 帧
   （一条变更同时发 `graph` 与 `rebuilt` 都行；壳以 `graph` 为准做增删、以 `rebuilt` 做换装）；
4. **文件读失败（ENOENT，构建 swap 中间态）不推帧**、下周期再看（dsh:80-84 的 `dirty` 口径）。

### 8.3 宿主侧快照口径（施工顺序上的一个前置）

现在 `buildBoot()` **每次请求都 `force: true` 重收**（`ui-server.ts:236-249`、`401-407`），
`/api/boot` 与 `/boot.js` 各算一次；HMR 需要的是"**一个当前代快照 + 一个变更信号**"。建议：
- `ui-server` 内持 `current: { graph, combos, problems, entries }`，只在①清单指纹变、②显式 `refresh()`、
  ③HMR 轮询判定变了 这三种情况下换代（换代时把旧 combo 表挪进 previous，§7.2）；
- `/api/boot`、`/boot.js`、`/plugins/??…` 都读同一份 `current`（这也顺带把 `/boot.js` 的
  `no-cache` 重算代价去掉）；
- `UiServerHandle` 加 `stats()`（§7.5）与 `snapshot()`（探针读数面）。

### 8.4 SSE 事件形状（复用 `/api/events`）

在 `src/core/ui-events.ts` 的选项里加**可选**的一支（形状照 `hmr/src/events.ts:10-13`）：

```ts
export type UiPluginEvent =
  | { type: 'graph'; graph: unknown }          // 整图（首次连接也发一条，壳据此对齐）
  | { type: 'rebuilt'; id: string; rev: string }

// UiEventsOptions 增：plugins?: { current(): UiPluginEvent[] | UiPluginEvent; subscribe(l: (e: UiPluginEvent) => void): () => void }
```

- 发送：`writeEvent(res, 'plugins', JSON.stringify(frame))`（99-103 的现成函数），
  连接建立时（`handleEvents` 296-336）**紧跟 hello 之后发一条当前 `graph`**（dsh `connect` 同款，166-178）；
- 好处：复用**已有的背压/心跳/上限/补帧机制**（`MAX_WRITE_LAG`、15s 心跳、`maxClients=8`），
  不必再造第二条长连接；新事件名对旧壳**向前兼容**（浏览器忽略未监听的事件名）；
- 注意：`plugins` 帧**不参与** `RemoteFrameHub` 的 seq 语义（它不是快照帧，别塞进 `frame` 事件里
  去搅乱 `applyHostFrame` 的"首帧必须全量/跳号"不变量，`ui-events-test.mjs:211-249` 钉的就是它）；
- 通道只有在 `events !== null` 时才存在（`ui-server.ts:348-364`），所以 HMR 推送=**由 webserver 插件
  无条件建通道**（`webserver.ts:95-126` 已经是无条件建的），纯静态的探针服务（`ui-serve-test.mjs:290`）
  自然没有 HMR。

### 8.5 壳侧换装时序（按第 2 波的装载账本卸载/重装）

新 `ui-shell/src/hmr.ts`（概念级；boot.ts 在动）：

1. `createHostChannel()` 增 `onPlugins(listener)` 与 `getBootGraph()`（`host-channel.ts:86-241` 里
   加一个 `plugins` 事件监听即可，**不要**第二条 EventSource）；
2. `hmr.ts` 拿到 `graph` 帧 → **对账**（这是 dsc 目前缺的一层，`loadUiPlugins` 是一次性循环）：
   - 新 id → `install(entry)`;
   - 消失的 id → `uninstall(id)`（走 boot.ts 的装载账本：现状是 `disposers.set(entry.id, rollback)`
     + `disposeAll()` 逆序跑，`boot.ts:132-176、195-204`；A1/D3/D2 会把账本加厚，**要求账本按 id 可取用**）；
   - `rev` 变的 id → `uninstall(id)` → `fetchFactory(entry)`（**用该行的单资源 URL**，即 `entry.url`）
     → `install`；
3. `rebuilt` 帧 → 同一条 `rev` 变更路径（幂等：同 rev 忽略，dsh `entries.ts:131`）；
4. 失败：留在壳侧一份 `{id, message, at}[]`，**不回滚**、不动宿主启停（dsh 口径，§3.6），
   诊断区新增"页内同步失败"区块 + 每行一个"重试"按钮（重试 = 用最新图再跑一次 reconcile，
   对同 rev 也重试——dsh `retry()`，entries.ts:104-107）;
5. 串行化：所有 reconcile/reload 走一条 promise 队列（dsh `enqueue`，entries.ts:150-160），
   并在队列里检查"这轮是否已被更新的图作废"（dsh `generation`，162-164）。

**样式**：
- 现状 dsc 的插件是纯 JS，xterm 的 CSS 由壳静态 import（`ui-shell/src/main.tsx:36-40`），
  **没有插件自有样式** → 换装默认不会留脏样式。
- 但 CSP 允许 `style-src 'self' 'unsafe-inline'`，插件**可以**自己插 `<style>`。要做 dsh 同款的
  剔除，落点就在 `instantiate()`（boot.ts:278-288）——它是 dsc 的"物化边界"：
  调用前记一遍 `document.querySelectorAll('style:not([data-plugin])')`，调用后把新增的未打标标签
  打 `data-dsc-plugin="<id>"`，id 记进账本；`uninstall(id)` 时删 `style[data-dsc-plugin="<id>"]`
  （逐字照 `system.ts:66-86` 的 `claimStyles` + `entry-lifecycle.ts:23-28` 的 `removeOwnedStyles`）。
- 同时把"插件不得依赖未打标的全局样式"写进 `docs/plugin-development.md` §10。

**共享模块重复注册**：
- dsc 的 `MODULES` 表（boot.ts:58-66）就是 dsh 的 seed → 同一实例，无需处理；
- 工厂表是后写覆盖（boot.ts:236）→ **必须**保证"批只在页面加载时执行一次"，否则重建后的批重放会把
  旧工厂盖回来（§7.3 的差别说明）。加一条断言/日志即可：批取数只在 `readBootGraph` 之后那一段允许。

### 8.6 与 A2/A3 的交互

- A3 之后，rebuild 一条插件使**批的 combo rev 也变**（如果它属于某个批）→ 壳**不**因为 `graph` 帧
  去重取批（§3.7 dsh 同口径）；下一次整页加载才用新批 URL。
- A2 之后，`graph` 帧里带 `batches`，但**phase 变更需要整页刷新**（批结构是页面加载级的）；
  这一条要写进 `docs/plugin-development.md` 与 `plugin-runtime-parity-plan.md` 的 §3 B，
  否则验收时会有人期待"改 phase 当场生效"。
- HMR 不依赖 A3：即便 combo 没落地，`rebuilt` → 单资源 URL 换装也能工作（只是首屏请求数没降）。

### 8.7 验收探针（"改文案 → DOM 变了且宿主 PID 不变"怎么自动断言）

新 `desktop/shots/hmr-check.ps1`（**沿用既有两条轨**：桌面 Electron + 真宿主；无需新依赖）：

1. 隔离 HOME；`DSC_UI_SHELL=1`；`DSC_UI_HMR=1`（或 webserver 配置 `hmr: true`，见 §9.3）；
   `DSC_DESKTOP_SHOT_DELAY` 给足（如 45000）、`DSC_DESKTOP_SHOT_EVAL_LEAD` 相应放大；
2. 选一个**文案稳定出现**的内置插件（例如 `statusbar` 的某个读数标签，或 `settings` 页里的一句），
   先在页面侧记下 `before = 元素 textContent`；
3. 探针脚本在起窗后 N 秒，**直接改写构建产物**（`lib/ui/plugins/<id>/client.js` 里做一次字符串替换：
   `A` → `B`；minify 关闭所以字面量可见，`build-plugins.mjs:190`）——比跑一遍 vite 构建快且确定；
   同时把宿主 PID 记下来（`Get-Process`/spawn 的 `Id`）；
4. 页面 EVAL（一个脚本内完成全部等待）：
   - 先在窗口里放一个存活标记 `window.__HMR_MARK__ = Date.now()`；
   - 轮询到"目标文本变成 B"（超时 20s 判负）；
   - 返回 `{ markAlive: window.__HMR_MARK__ === 记下的值, text: …, syncFailures: 取诊断区读数, log: __DSC_UI_BOOT_LOG__ }`；
5. **断言**：`text === B`（DOM 变了）+ `markAlive === true`（没整页重载）+ 宿主 PID 与改文件前一致
   + 同一进程（宿主 PID 不变即"没重启宿主"）。
6. 负例（一并钉住）：把改完的文件写成**语法错误** → 断言界面**不白屏**、诊断区出现"页内同步失败"
   与一行原因、点重试仍失败但可再试；改回正确字节 → 点重试后恢复（这就是 dsh 的"可直接重试"面）。
7. node 侧（快、必跑）：`scripts/ui-hmr-test.mjs`（照 `ui-events-test.mjs:129-185` 的 `startServer`/`sseOpener`）
   —— 起真服务 + 真通道 + 临时插件目录；改一个 bundle 的字节 → 等一帧 `event: plugins`
   → 断言帧是 `{type:'rebuilt', id, rev}` 且 rev 变、`graph` 帧里该行 rev 同步变、
   旧 combo/单资源地址按"上一代"仍 200（§7.2）。

---

## 9. 风险清单

### 9.1 CSP 与 combo 的相容性
- 结论：**相容**（同源 `<script src>`；`??`/`,`/`&` 合法）。风险不在加载，而在实现者图省事用
  `fetch + new Function`（`script-src 'self'` 无 `unsafe-eval`，必炸）。写进 A3 的验收注释。
- 次要：`connect-src 'self'` 不影响；`style-src` 与 combo 无关。

### 9.2 mtime 指纹 rev 在"未改文件但重构建"下的抖动（**这条会直接毁掉 HMR 的可用性**）
- 现状：`build-plugins.mjs` 每次跑都 **rm outRoot + rename staging**（234-235），
  且 16 个插件**全部重写**（178-221）→ 所有 `client.js` 的 mtime/ctime 全变 →
  `artifactRev`（`ui-manifest.ts:109-111`）全变 → 图 `rev` 变、16 行的 rev 全变 →
  **HMR 会把 16 个插件全部换装**（React 状态全丢、16 次取数），一次"只改一个文件"的重构建。
- 两个修法（建议**都做**，成本都很低）：
  1. **内置 rev 改内容摘要**：与第三方统一（`contentRev`，`ui-bundles.ts:530-535`），
     `artifactRev` 保留给"只用 stat 的调用方"。代价：换代时要读全部 bundle（实测 16 个
     `client.js` 合计 **593 KB**，sha256 约 2-3ms；现在换代路径是 17 次 stat，`ui-bundles.ts:328-336、362-372`）
     ——配合 §8.3 的"快照只在变更时换代"，这个代价摊到每次真实变更上一次，完全可接受。
     收益：`rev` 变成真正的**内容地址**（`ui-route.ts` 文件头一直这么称呼它），
     "上一代″的语义（同内容同 rev）也自洽；C2 也顺带满足。
  2. `build-plugins.mjs` 支持**按 id 增量构建**（`node build-plugins.mjs <id…>`；现有实现从
     `readdirSync` 全量取，`145-159`），并**逐文件比对**：内容没变就不重写、不动 staging 里那份；
     真要原子换，也按"只替换变了的目录"来（不改 mtime/ctime 的文件留着）。
- 若两条都不做：HMR 只能用"mtime 变 + **内容摘要二次确认**"来 gate 推帧（推帧前 sha256 比对，
  同内容不推）——但图 rev 仍会全变，壳一旦重新拉图仍会全换装。所以**至少要做 1 或 2**。

### 9.3 SSE 在打包态（无 dev 工具）下的可用性
- `/api/events` 在打包态**照常存在**（通道由 `webserver.ts:95-126` 无条件建），
  所以 HMR 的传输面在打包态可用——但**打包态没有写者**：`lib/ui/plugins` 是 extraResources 里的只读产物。
- 风险：常驻 500ms stat 轮询白烧（小）+ 用户手改 extraResources 里的文件会触发"运行期换装"
  （权限允许时）——这不该是产品行为。
- 建议：轮询器**缺省关**，由 `webserver` 配置 `hmr: { enabled, pollIntervalMs }` 或环境变量
  `DSC_UI_HMR=1` 打开；`scripts/_ui-shell-serve.mjs`（dev 启动器）与桌面 dev 打开它，
  `desktop dist` 产物里保持关。`DSC_UI_SERVE_*` 那套环境变量是现成先例（`_ui-shell-serve.mjs:47-52`）。

### 9.4 第 2 波并发改动带来的 rebase 点
| 文件 | 会撞上什么 |
| --- | --- |
| `ui-shell/src/boot.ts` | install 循环与账本（132-176、195-204）会变形：A1 的服务释放、D3 的席位释放都要进同一账本 → HMR 要的是 `uninstall(id)` 与"装一个 entry"两个入口，别自己再抄一套账 |
| `ui-shell/src/plugin-api.ts` | `UiComponent`/`UiPluginApi` 在收窄（D1）；`hmr.ts` 只依赖 `UiBootGraph` 与装载入口，**不要**依赖 `UiComponent` |
| `src/ui/slots.ts` | D1/D2 改注册面；A2/B 都不碰它，但探针的槽名读取要跟 `SHELL_SLOTS`（`ui-shell/src/slots.ts:61-71`） |
| `ui-shell/src/main.tsx` | A2 必须改的那一处（render 提前到 early 批之后，99-119）——与 D2/D3 的 Provider 改动同片 |
| `src/core/ui-server.ts` | 若第 2 波顺手改了 `/api/boot` 的组装点或 `UiBootGraph` 的注入，A2 的 batches 摘要要 rebase 到新位置 |
| `scripts/ui-plugin-test.mjs:420` | 已断言"改 `immediately` 整图 rev 变"；A2 把 batches 纳入摘要后，这条断言的行为面会扩到 `phase` |
| `src/plugins/remote.ts:558-565` | 手抄字段的第二个组图点；A2 漏了它 → 手机端没有 batches（不炸，但相位失效）。建议顺手收敛成共享函数 |

---

## 10. 我认为计划里判断错了 / 需要改的地方

1. **§1 表格与 §3 A2 把"分批"写成 dsh 的 `bootstrap/application` 两批**：dsh 的 bootstrap 批是
   **客户端模块系统那一个包**（`index.ts:536-539`），作用是"先于壳执行"（parser-blocking，§1.3）。
   dsc 没有这一层；照抄会得到一个永远为空的批或一个误导性的词。**改成**：字段名与不变量对齐 dsh，
   phase 词表用 `'early' | 'application'`（或明确写"dsc 的 bootstrap 批 = 首屏批"）。
2. **"缺懒物化"这条差**：dsh 的"模块体首次使用才执行"来自惰性 CJS 模块表；dsc 的插件必须
   apply 过才有槽内容，**不存在"首次使用才 apply"**（§6.0）。A2 的收益应改写成
   "**第二批的取数与 apply 推到首帧之后**"，验收也照这个写（§6.6）。
3. **§3 A2 的验收"stderr 打出两批物化时刻"**：宿主看不到页面的执行时刻，而"第二批未物化时
   第一批已可交互"是**页面侧**事实。**改成**：页面侧启动账本（global/诊断区 `data-*`）+ 桌面探针 EVAL 读；
   stderr 只留宿主侧的"批已登记/已下发"日志（宿主 stderr 与桌面 stderr 合流，探针能 grep，
   `protocol.ts:60-64`）。
4. **§3 A3 的 combo URL 简写不准**：真实形状是 `/plugins/??<id>/client.js,<id>/client.js&rev=<comboRev>`
   （`index.ts:227-246`），rev 用 `&`，每项带 `/client.js`。照简写实现会对不上 dsh 的路线形状。
5. **§3 A3 的"组合里一个 id 404 → 其余照常"**：宿主侧 dsh 是**整条 404**（未通告组合一律 404，
   `index.ts:1148`），"其余照常"来自**客户端对每个成员逐一确认是否注册**（`system.ts:220-224`）。
   写成"宿主宽容地返回部分成员"会是另一种协议（还要发明一个清单头），**别做**。
6. **§3 B 的"宿主复用已有 /api/events 推送"** 方向对，但要补两条硬约束：
   `plugins` 推送**不能塞进 `frame` 事件**（会破坏 `ui-events.ts` 的 seq/全量不变量，
   `ui-events-test.mjs:211-249` 钉着它），要新开**事件名**（如 `plugins`）；
   并且宿主需要**一个当前代快照**（现在 `/api/boot` 与 `/boot.js` 每请求 force 重收，
   `ui-server.ts:236-249`），HMR 的"换代"必须建立在同一份快照上。
7. **§3 C2（rev 改内容摘要）不是纯"二选一"的文档问题**：第三方**已经**是内容摘要
   （`ui-bundles.ts:530-535`），剩下的只有内置档；而内置档**要么**改内容摘要、**要么**把
   `build-plugins.mjs` 改成增量写，否则 HMR 会因为"全量重写→全部 rev 变"而把 16 个插件一起换装（§9.2）。
   这条应从 C2 提前到 **B 的前置依赖**里。
8. **§6 风险 "别把闸门拆掉" 继续成立**，另外补一条 A3 专属：combo 体是**同源脚本**，
   但它的成员集合必须来自宿主组图的产物表（`collectUiArtifactsForPlatform` 唯一口子，
   `ui-bundles.ts:845-862`）——**不许**让请求里的 id 列表直接决定读哪些文件（否则就是一条
   任意文件读取的缝：`??../../…/x/client.js`）。精确 URL 表（§7.1）天然把这条缝焊死，
   这是选"查表"而不是"解析"的第二个理由。
9. **§4 次序里 "A2 分批 → A3 combo" 的耦合**：若 A2 的 `batches` 带上 `url?/rev?` 且 A3 填，
   则两波之间 `batches` 的 `url` 缺省——壳要写成"有 url 用 url，没有则逐条取单资源"。
   建议在 A2 就定下这个 optional 语义并写进类型注释，避免 A3 变成 wire 破坏性变更（§6.1）。
10. **§7.2 的不确定项可以删掉**：见 §2.4 的定论（≤3 次/每条缺行，且已执行的批绝不重放）。
    §7.3（HMR 样式在 CSP 下）也可定论：`style-src` 有 `'unsafe-inline'`，`script-src` 管不到样式，
    **不受限**；且 dsc 现状根本没有插件自有样式（§8.5）。

---

## 11. 施工速查（按文件）

| 文件 | 波次 | 动作 |
| --- | --- | --- |
| `src/ui/manifest.ts` | A2/A3 | `UiBootPhase`/`UiBootBatch` 类型；`UiPluginRow.phase`；`composeUiBootGraph` 产 `batches` 且 rev 摘要含 batches；`comboUrl`/`comboRev` 纯函数（浏览器安全） |
| `src/core/ui-bundles.ts` | A2/A3/B | 清单读 `phase`（内置 + 第三方）；建议 `artifactRev` → 内容摘要（§9.2）；导出 `toUiPluginRows`（收敛两个组图点） |
| `src/core/ui-route.ts` | A3 | combo 支（`??…&rev=`）；精确表命中 + 上一代；头与 405/HEAD 照单资源 |
| `src/core/ui-combo.ts`（新） | A3/B | 批体惰性构造、精确 URL 表、上一代保留、被 `ui-server`/`remote` 共用 |
| `src/core/ui-hmr.ts`（新） | B | stat 轮询 + 换代 + `graph/rebuilt` 帧生成（不依赖 cordis，可被 node 探针驱动） |
| `src/core/ui-events.ts` | B | 可选 `plugins` 源 + `event: plugins` 帧 + 连接即发当前图 |
| `src/core/ui-server.ts` | A2/B | 当前代快照（替代每请求 force）；`stats()`；`batches` 进 `/api/boot`、`/boot.js`；combo 路由接上 |
| `src/plugins/webserver.ts` | B | 建 HMR 轮询器 + 把 `plugins` 源接进通道；配置 `hmr` |
| `src/plugins/remote.ts` | A2/B | 组图点带 `phase`（或改用共享函数）；HMR 可选接 |
| `ui-shell/build-plugins.mjs` | A2 | `readMeta` 校验 `phase`；`phase` 进清单条目 |
| `ui-shell/src/boot.ts`（在动） | A2/A3/B | 按 phase 分段安装；批取数 + 三态回退；`uninstall(id)`/`install(entry)` 入口；物化边界记样式；启动账本 |
| `ui-shell/src/main.tsx` | A2 | early 批之后即 `render`；application 批在首帧后继续 |
| `ui-shell/src/host-channel.ts` | B | `plugins` 事件订阅 + `getBootGraph()` |
| `ui-shell/src/hmr.ts`（新） | B | 对账/换装队列/失败清单与重试 |
| `ui-shell/src/app.tsx` | A2/B | 诊断区：批时序行、逐条 phase、页内同步失败与重试（`?diag=1` 读数面） |
| `docs/plugin-development.md` | A2/B | `phase` 字段、phase 是页面加载级、插件样式须打标、HMR 状态口径（状态丢、数据层留、失败不回滚） |
| 探针 | 全部 | `scripts/ui-batches-test.mjs`、`scripts/ui-hmr-test.mjs`（node 轨）；`desktop/shots/batches-check.ps1`、`desktop/shots/hmr-check.ps1`（真页面轨） |
