# ui-boot（界面引导）

一句话：界面壳的引导——启动图取回、平台种子表、cordis 根、分批装载会话、热更对账与页面入口。

## Model Experience（模型体验）

- 页面刚打开时是空的，引导先把启动图取回来，再交给渲染器的 `start(api)`；模型看到的第一屏延迟由这条链决定。
- 平台种子表 `MODULES` 决定插件能 require 到哪些模块；少一条，插件那句 require 当场抛，界面上就少一块。
- 种子表的键集与顺序必须和 `ui/platform-modules.json` 全等，不等就报 `MODULE_DRIFT`，不靠人眼比对。
- 2026-11-05 起种子表多了 `@deepseek-ai/cordis` / `zod` / `@tanstack/react-virtual` 三项：插件按包名 require 到的是壳里那一份，类型随 `lib/ui/sdk/` 发布。
- 热更（`hmr.ts`）只对账「哪些插件变了」，不重装整页：改一个插件不用把整个会话的界面重来一遍。

## Known Limitations（已知限制）

- 它是**唯一 parser-blocking 的引导**：页面脚本自己就是入口，没有「装不装它」这一步。所以 `pneuma.client` 在这里只是声明（`platform / api / immediately: true`），**没有装配行**——给它一行只会得到一个「关掉就白屏」的假开关。
- 浏览器源码在 `ui/`，由 `ui-shell` 的构建直接编进壳的 app bundle；根入口 `index.ts` 只是包身份，没有 Node 侧可执行逻辑。
- 样式文件仍住在渲染器包（`ui-renderer/ui/styles/`），入口按相对路径引入：插件 bundle 是纯 JS，带不了 CSS，而样式要在渲染器停用、只剩诊断页时也生效。
- `main.tsx` 刻意不从 `ui/index.ts` 转出：它带顶层副作用（`void bootstrap()` 真的挂载应用），谁 import 到它谁就会起一个壳。
- 改一行就要重建整个壳（`pnpm -C ui-shell build`），重建前页面上的还是旧的那一份。

## 谁在用它

- `ui-shell/index.html` 指向 `ui/main.tsx`：整张页面只有这一个入口。
- `ui/main.tsx` 按启动图找到 `renderer` 那一条，物化后调它的 `start(api)`；找不到 / 停用 / 失败时画诊断页。
- 渲染器与界面插件的 `client.js` 都由本包的 `boot.ts` 取回（渲染器先物化，插件按批装进 cordis）。
