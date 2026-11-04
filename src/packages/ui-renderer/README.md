# ui-renderer（装载器与入口）

一句话：界面壳的装载器与页面入口——启动图取回、分批装载、平台种子表、插件热更对账与页面入口。

## Model Experience（模型体验）

- 页面刚打开时是空的，装载器把插件一批批取回来才有内容：模型看到的第一屏延迟由这里决定。
- 平台种子表 `MODULES` 决定插件能 require 到哪些模块；少一条，插件那句 require 当场抛，界面上就少一块。
- 种子表的键集与顺序必须和 `ui-shell/src/platform-modules.json` 全等，不等就报 `MODULE_DRIFT`，不靠人眼比对。
- 热更（`hmr.ts`）只对账"哪些插件变了"，不重装整页：改一个插件不用把整个会话的界面重来一遍。

## Known Limitations（已知限制）

- 它是壳的一部分：整棵树被编进壳的产物（`lib/ui/` 的 bundle），**没有独立的 `client.js`**，因此不能单独安装、单独停用——`pneuma.library: true` 就是这个意思。
- 它是**唯一 parser-blocking 的引导**：页面脚本自己就是入口，没有「装不装它」这一步。所以 `pneuma.client` 在这里只是声明（`platform / api / immediately: true`，与 dsh 把 bootstrap 放在 modules 同一位），**没有装配行**——给它一行只会得到一个「关掉就白屏」的假开关。
- 改一行就要重建整个壳（`pnpm run build`），重建前页面上的还是旧的那一份；没有只换这一个包的热更路径。
- `main.tsx` 刻意不从 `ui/index.ts` 转出：它带顶层副作用（`void bootstrap()` 真的挂载应用），谁 import 到它谁就会起一个壳。
- `boot.ts` 按**仓库根**的相对路径读 `ui-shell/src/platform-modules.json`（数据文件的单一事实源还留在壳里，没搬进本包），所以本包对仓库布局有一条显式依赖。

## 谁在用它

- `ui-shell/index.html` 指向 `main.tsx`：整张页面只有这一个入口。
- 界面插件的 `client.js` 由 `boot.ts` 取回并分批装进 Cordis。
- `main.tsx` 在首帧前按**启动图**取骨架（`layout` 的产物，即 `@dsc/ui-layout` 的 `./client`），
  拿它的 `App` 挂到 `#root`；骨架被停用或取不到时画一块诊断页（`LayoutUnavailable`），
  不白屏。同一条 bundle 的工厂只执行一次（`boot.ts` 的物化缓存）。
