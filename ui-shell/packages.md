# ui-shell 的逻辑分包（packages.json）

`packages.json` 是「包名 → 源码落点」的单一事实源（值相对本目录）。`vite.config.ts` 与
`build-plugins.mjs` 直接读它生成 alias；`tsconfig.json` 的 `paths` 读不了 JSON，只能手抄，
`scripts/ui-plugin-test.mjs` 会逐条比对、不一致当场红。

**新增一个包要同时改四处**（JSON 装不下这段注释，所以在这里）：

1. 本目录 `packages.json` 加一条 `"@dsc/ui-xxx": "../src/packages/ui-xxx/ui/index.ts"`；
2. `tsconfig.json` 的 `paths` 抄同一条（写法与上面一致，漂移检查会盯）；
3. 新包的源码目录放 `package.json`（`name` 与包名一致、`types` 指向入口——漂移检查拿它当锚）；
4. 定它在构建期的身份：**要下发给插件**就加进 `src/platform-modules.json`，同时在
   `src/packages/ui-boot/ui/boot.ts` 的 `MODULES` 里挂上实现（两边漂移由 `MODULE_DRIFT` 当场报，
   且被 `scripts/ui-plugin-test.mjs` 的 [5b] 用「键集且顺序全等」钉住）；
   **只给壳自己用**就加进 `build-plugins.mjs` 的 `EXTERNAL`（构建期保留成 require、
   运行期故意不给——插件当值用它时得到「白名单外的模块」那句错）。

八个包已按上面配方登记。`@dsc/ui-*` 那五个的源码搬到了 `src/packages/ui-<包名后半>/ui/`
（每包一个 `ui/index.ts` 作出口，宿主半是同目录的 `index.ts`）；`@dsc/ui` 与 `@dsc/ui-core`
仍在原处，一个字没动：

| 包名 | 落点 | 构建期身份 |
| --- | --- | --- |
| `@dsc/ui` | `src/plugin-api.ts` | 下发给插件（平台种子，本包没有包帧——落点是单文件） |
| `@dsc/ui-core` | `../src/packages/ui-core/index.ts` | **只给壳**（`EXTERNAL` 里「故意不给」的那一格） |
| `@dsc/ui-primitives` / `@dsc/ui-slots` / `@dsc/ui-dockkit` | `../src/packages/ui-*/ui/index.ts` | 下发给插件（E6 起进 `platform-modules.json`） |
| `@dsc/ui-layout` | `../src/packages/ui-layout/ui/index.ts` | **下发给插件**：它既是插件（order 349、`phase: early`，可停用），也是平台种子——`@dsc/ui` 把它的读 hook 转出给插件，插件与骨架必须共用同一份 `RuntimeContext` |
| `@dsc/ui-boot` | `../src/packages/ui-boot/ui/index.ts` | 只给壳（唯一 parser-blocking 的引导，对应的 dsh 位置是 `dsh-client-modules`；库包，没有行） |
| `@dsc/ui-renderer` | `../src/packages/ui-renderer/ui/index.ts` | **下发给插件**：渲染器（order 348、`phase: early`，可停用）——取骨架、建通道、装插件、画首帧；停用后由引导画诊断页 |

旧路径（`src/icons.tsx`、`src/dock-state.ts`、`src/platform/*`、`src/slots.ts`、
`src/boot.ts` …）上的**迁移期转发壳已全部删除**（E4 收尾）：调用点（`plugin-api.ts` /
`src/plugins/**` / 各包）都改成按包名 import。新代码见到的旧路径一律是漏改，别再往回加壳。

**类型产物不用额外登记**：`build-types.mjs`（`tsconfig.types.json`）收集入口、再照
`packages.json` 把声明归位到 `lib/ui/sdk/@dsc/<包名>/`；落点不合约定时 `build-types.mjs`
当场报错（不会静默漏一个包）。

**注意（E7 搬家后还没跟上的一环）**：那一环现在只认老约定。`tsconfig.types.json` 的
`include` 里写死着 `src/ui-*/index.ts`，而 `build-types.mjs` 从落点里截倒数第二段当包名
（`src/ui-slots/index.ts` → `ui-slots`）；换成 `../src/packages/ui-slots/ui/index.ts` 之后它截到
的是 `ui`，于是报「找不到 `@dsc/ui-slots` 的声明产物 ui」。搬家这一批没动那两个文件，
下一批要把 `include` 改成 `../src/packages/*/ui/index.ts`、把截法改成「落点往上找 `src/packages/`
之后的第一段」。
