# 界面对齐 dsh 的插件化计划（桌面端为主）

> 写于 2026-10-10，对应仓库状态：`main` 已含阶段 90–95（末条 `1016bd0`），版本号 0.6.67。
> 参考实现：源码 `D:\deepseek-harness\deepseek-harness`，已安装桌面版 `D:\dsh`（`resources/app.asar`）。
> 本文只写**机制事实与改动落点**，不写宣传语。凡是我没验过的，都在文末「没验过的」里单列。

## 0. 一句话回答

**桌面前端还没有改成插件壳**：窗口加载的仍然是旧渲染层产物——`desktop/electron/main/index.ts:51` 的 `rendererDir()` 就是 `out/renderer`，:61 把它当 `DSC_UI_ASSETS` 交给宿主进程。插件壳今天只能在开发模式（`scripts/_ui-shell-serve.mjs` + 浏览器）里跑。

**方向与地基已经对齐 dsh**，机制形状是同构的：宿主常驻本机回环服务 → 按槽位拼装客户端插件 → bundle 由宿主下发 → 启动图注入页面 → 客户端模块白名单 → 换文件就换地址的 `rev` → 桌面用「一次性令牌换 Cookie」的方式认领那份 web 文档。

**但有五块没对齐**：① 桌面没切（阶段 5 未做）；② 槽位少第四种形态 `chain`（条目自己选举）；③ 界面插件没有版本门禁；④ 第三方界面插件没有发现路径；⑤ 老 UI 那 19,383 行能力（终端、文件预览、设置、技能、会话库管理、轨迹、队友）**一个都没做成插件**。

## 1. 逐条对位

| 机制 | dsh 的做法（证据） | dsc 现状（证据） | 差在哪 |
| --- | --- | --- | --- |
| 桌面怎么起界面 | 自定义特权 scheme `dsh-app://app`：壳自有页面**本地**读，其余按路径**反代**到本机 Host（`apps/desktop/src/main.ts:662-677`）；认证要 `303 + set-cookie`（`apps/desktop/src/web-document.ts:43-50`） | 宿主伺服旧渲染层产物，桌面 `loadURL(desktopPageUrl())`（`desktop/electron/main/index.ts:126,130`）；认证同样认 303/302 + Cookie（阶段 93 修过） | 形状一样（都是「宿主托管的 web 文档」），**但被托管的那份是旧 UI**。dsh 多一层 scheme 特权与本地静态骨架，dsc 没有（不影响对齐，属可选） |
| 插件下发 | `/plugins/<id>/client.js`，多资源合并 `/plugins/??…&rev=`（`packages/client/modules/src/index.ts:225-235`） | `/plugins/<id>/<file>?rev=`，**缺 rev 一律 404**（`src/core/ui-route.ts`、阶段 93 收紧） | 等价；dsc 更严（dsh 没有「缺 rev 拒绝」这条） |
| 产物形态与执行 | CJS 闭包工厂，外裹 `window.__ModuleLoader__.load({id, factory})`；用 `<script async>` 执行（`packages/client/modules/src/client/system.ts:16-29`） | CJS 工厂，外裹 `(globalThis.__DSC_UI_FACTORIES__ ??= {})[id] = function(require,module,exports){…}`；`<script>` 执行（`ui-shell/src/boot.ts:40,241`、`ui-shell/build-plugins.mjs`） | 同构。dsh 的模块系统更全：支持 `require.async` 分片、bootstrap/application 两批激活；dsc 只有「一次性全部物化 + `immediately` 预取」 |
| 模块白名单 | 9 个「平台种子」：react / react-dom / react-dom/client / react/jsx-runtime / cordis / dsh-client-store / ui-slots / ui-primitives / ui-dockkit（`packages/client/web/src/seed.ts:24-39`） | 5 个：react / react-dom / react-dom/client / react/jsx-runtime / `@dsc/ui`（`ui-shell/src/platform-modules.json`，构建期 external 与运行期 require 表**同读它**） | 差在「有没有一套基元库与槽位库给插件复用」。dsc 的 `@dsc/ui` 同时充当二者 |
| 启动图 | `window.__DSH_BOOT__ = {rev, entries[{id,url,rev,inject,immediately,external}], batches[{phase,url,rev,entries}]}`；扫各包 `package.json` 的 `dsh.client` 合成，Host 侧拓扑排序（`packages/client/modules/src/index.ts:758-808`、`client/manifest.ts:52-97`） | `window.__DSC_BOOT__ = {rev, entries[{id,url,rev,inject,external,immediately,platform}]}`（`src/ui/manifest.ts:23-47`）；由壳构建脚本产出固定清单 + 宿主读 `lib/ui/plugins/manifest.json` 算 rev | 字段几乎一致（dsc 多 `platform`，dsh 多 `batches` 分批激活）。**差在来源**：dsc 是构建期固定清单，dsh 是扫已安装的包 |
| 槽位 | 4 形态（single/list/keyed/**chain**）× 3 作用域（root/session-maybe/session）；`children` 声明即占用；priority 升序、同格同 priority 抛错；chain 是「选择器选举」（`packages/client/ui-slots/src/index.ts:100-104,285-296,1203-1312`） | 3 形态（single/list/keyed）；`children`、`injectSlot`、priority 遮蔽、崩溃退位都有（`src/ui/slots.ts:26,67`） | 差 `chain` 与「作用域」两样。**工具调用按工具名选举渲染**（dsh 的 `tool.call.toolview`）正是 chain/keyed 的用武之地，dsc 还没做 |
| 版本门禁 | 用 `peerDependencies` 对 `@deepseek-ai/dsh*` 做 semver 检查，不满足拒绝加载，可按「插件@版本 + 运行时版本」精确豁免（`packages/boot/app-boot/src/plugin-compatibility.ts:61-88`） | **界面插件没有任何版本门禁**；宿主 cordis 插件有整数 `KERNEL_API_VERSION`（`src/core/plugin-registry.ts:218`） | dsc 缺一层（进退两难时建议用整数，与宿主插件口径一致） |
| 信任/安全闸 | 无 CSP、无权限清单、无产物签名；`rev` 是 mtime/ctime/size 的 sha1（`packages/client/modules/src/index.ts:220-221`）；第三方包的构建脚本要用户显式 `allowBuilds` 批准 | 三道信任闸（Host / Sec-Fetch-Site / Origin）、签名 Cookie、界面通道**方法白名单 + 实参校验 + 编译期双向覆盖检查**、凭据与签名密钥进「禁止读取」清单 | **dsc 在这块比 dsh 严得多**。对齐时不要把 dsc 自己的闸门拆掉 |
| 第三方怎么发现 | profile 目录 + pnpm 安装 + `cordis.patch.yml` 开关；内置与第三方**同构**（都是带 `dsh.client` 的 npm 包）（`packages/boot/app-boot/src/profile.ts:1-22`、`plugin-manager/src/patch.ts:14-43`） | 只有 `lib/ui/plugins/manifest.json`（构建期产出，见 `ui-shell/build-plugins.mjs`）；宿主插件那半边有 `~/.dsc/plugins/*.js` + `plugins.json` 启停（`src/core/plugin-loader.ts`） | 差「界面半边怎么被发现」。建议**复用手头这套**（宿主插件目录），别照搬 pnpm/profile |
| 打包 | 前端 dist 与全部 UI 插件包在 asar 内（`apps/desktop/scripts/electron-builder-config.mjs:129-142`），原生二进制 `asarUnpack`，Host runtime 走 `extraResources`（:144-149） | 旧渲染层 `out/**` 进 asar；宿主运行时 `desktop/runtime-staging/dsc-core` 走 `extraResources`（`desktop/electron-builder.yml`），而 `prepare-runtime.mjs:31-33` 把整个 `lib/` 复制进去——**所以 `lib/ui/**` 其实不在 asar 里** | 结论与交接文档里的猜测相反：壳产物跟 `lib/` 一起走 extraResources。但**没在打包态验过**（见文末） |
| 界面能力的插件化程度 | 终端、文件预览、设置页（8 个子页）、技能页、插件管理、会话列表、消息流、工具渲染、命令面板——**全部是 client 插件**（`packages/bundle/web-app/cordis.patch.yml` + `packages/client/*`） | 壳里只有 8 个插件（composer/echo/hello/prompt/runtime/sessions/statusbar/transcript），覆盖「会话列表 + 消息流 + 输入区 + 审批卡 + 状态条」；其余能力都在旧渲染层（`desktop/src/renderer/`，72 个文件 19,383 行） | **这是最大的一块差距**：终端、文件预览、设置/技能/插件页、会话库管理都还没搬 |

## 2. 「对齐」的验收口径

对齐不是「代码长得像」，而是这六条能实测：

1. 桌面窗口加载的是**插件壳**，stderr 有「窗口来自宿主界面服务」，界面上的每一块都来自槽位注册（不是壳硬编码）。
2. 旧渲染层那批能力在壳里都有归属：终端、文件预览与差异、设置/预设、技能、插件启停、会话库管理（改名/置顶/归档/分叉）。
3. 槽位四形态齐（含 `chain`），且「谁负责展示这个工具调用」按选举决定，而不是壳里写死 if。
4. 第三方界面插件能装、能启停、能看见；不兼容的版本**装不上并说明原因**；首次安装有一次明确的信任确认。
5. 打包态（nsis/portable）跑一遍界面：壳产物找得到、插件加载得到、认证握手成功。
6. 老 UI（`desktop/src/renderer/`）有冻结标记，且**改它不再影响界面**这件事有检查守住。

## 3. 分阶段计划

### 阶段 5：桌面切到插件壳

这是最大的一块，拆五个子步，每步一个提交、独立验收。

#### 5.0 先把「切换点」收成一个开关（先决条件）

- 现状：`desktop/electron/main/index.ts:51` 的 `rendererDir()` 同时被两处消费——`hostEnv()` 的 `DSC_UI_ASSETS`（:61）与回落用的 `loadFile`（:678）。切换要动的是前者，**后者必须留着**（它是回退路）。
- 加一个壳产物解析函数（`shellDir()`），路径分开发态与打包态：开发态是仓库的 `lib/ui/assets`；打包态是 `join(process.resourcesPath, 'dsc-core', 'lib', 'ui', 'assets')`（因为 `prepare-runtime.mjs` 把 `lib/` 整个带进了 extraResources）。
- 加开关（默认**关**）：`DSC_UI_SHELL=1` 或 profile 文件（推荐后者，跟 dsh 一样有档可切）。开关关着时行为与今天逐字节一致。
- 验收：开关关 → 桌面与今天一样；开关开 → 宿主伺服壳产物（此时壳还缺能力，允许功能不全，用来提前暴露「路径不对」这类问题）。

#### 5.1 壳的原生桥（被交接文档低估的一步）

问题：旧渲染层的 26 个 IPC 方法（`desktop/src/renderer/bridge.ts`）里，有一类**宿主做不了**——它们要 Electron 主进程：`setWindowChrome`（原生窗口控件区颜色）、`setThemeSource`（原生弹层深浅）、`chooseDirectory`（系统文件选择框）、`openPath`/`openExternal`（用系统程序打开）、`notify`（托盘通知）、`quit`/`restartHost`、`dockBrowser`/`browserNav`/`onBrowserState`（内嵌浏览器是一个原生 `WebContentsView` 覆盖层，`desktop/electron/main/dock.ts:25`）。

做法：给壳加一条**原生桥**——preload 暴露 `window.dscNative`，只放上面这一小组能力，按「逐条白名单 + 实参校验」的规格写（照 `src/core/ui-methods.ts` 的口径）。插件只能通过 `@dsc/ui` 暴露的受限包装使用它（例如 `useHostNative()`），桥里**不出现**任何「执行任意命令 / 读写任意文件」的 op。

验收：
- 桥的每个方法都有实参校验，且「没进白名单的原生能力」有断言守着（编译期或探针）。
- 在浏览器里打开壳时桥缺席，插件**优雅降级**（显示「这条能力在浏览器里没有」而不是抛异常崩掉）。
- 探针：桥的规格与白名单一致性（像 `ui-serve-test` 那样能列出来）。

#### 5.2 终端插件（dock）

事实：终端**不是 Electron 特权**——op 在宿主插件 `src/plugins/desktop-dock.ts:109,127,133`（`term-spawn`/`term-input`/`term-kill`），渲染是 xterm（`@xterm/xterm` 在 `desktop/package.json` 里）。所以能做成普通插件，要解决两件事：

1. **xterm 怎么给插件**：加进 `ui-shell/src/platform-modules.json`（构建期 external 与运行期 require 表同读它），壳的 vendor 里带上 xterm；或让 dock 插件自带 xterm（bundle 变大，但省一层平台耦合）。
2. **`dock` 通道按 op 分档**：今天整条 `dock` 被排除，理由是「op 里有 `term-spawn`」。按 op 拆开：
   - 读类（`fs-list` / `fs-read` / `git-status` / `git-log` / `git-diff`）→ 进放行面；
   - 写类（`git-stage` / `git-unstage` / `git-commit`）→ 单独一档，走审批；
   - `term-*` → 另开一条只在桌面窗口有效、且必须由用户显式动作触发 spawn 的通道。

验收：终端能开、能输入、能关；在浏览器/远程壳里 `term-spawn` 调不通（平台或能力门禁拦住，且报的是人话）；写类 op 的审批与围栏与旧版一致。

#### 5.3 文件预览与差异

把 `file-preview.tsx` / `DiffPane.tsx` / `files-tree-store.ts` / `file-util.ts` / `file-icons.tsx` / `diff-highlight.ts` / `intended-diff.ts` 搬成两个插件：`files`（文件树 + `fs-list`）与 `preview`（文本/图片/PDF/差异）。样式九成已经在 `legacy/views.css` 里（当初整份搬过来时没人用的那些规则，这里开始派上用场）。

验收：点文件能看内容、图片按 `kind:'image'` 渲染、大文件截断行为与旧版一致（`desktop-dock.ts` 里的 512KB/5MB/10MB 边界）、写死色值为零、差异视图行号与符号与旧版一致。

#### 5.4 设置页 / 预设 / 技能 / 插件启停

宿主方法大多已在放行面：`getSettingsSections` / `getSectionValues` / `setSettingValue` / `runSettingAction` / `listPresets` / `usePreset` / `listSkills` / `readSkill` / `setSkillEnabled` / `listPlugins` / `setPluginEnabled`。

注意两处**故意放不进来**的：`installMarketSkill` / `setMarketSources`（供应链写入口，`src/core/ui-methods.ts` 的排除清单有理由），所以「装技能」这一步在壳里要像 `/` 指令那样**明确说清去哪做**，不能假装有按钮。

验收：改外观即时生效并落盘；改模型/档位/预设落盘；技能开关与插件启停真的生效（重启宿主后仍是那个状态）。

#### 5.5 会话库管理 + 正式切换

- 补齐会话行内动作：改名、置顶、归档、分叉（宿主方法 `renameSession` / `setSessionPinned` / `archiveSessions` / `restoreSessions` / `forkSession` / `listArchivedSessions` 都在放行面）。
- 然后才切：`hostEnv()` 的 `DSC_UI_ASSETS` 指向壳产物，默认值随开关走。
- 回落路径保留并实测：拿不到地址 / 认证失败 / 开关关 → `loadFile(out/renderer/index.html)`。
- `bridge.ts` 退役：给 26 个方法逐个标注「壳里由谁承担」（宿主界面通道 / 原生桥 / 不再需要），**全都有归属才删**。

验收：桌面自检三用例改成跑壳并全绿；真实 `~/.dsc` 跑前跑后逐文件哈希一致（零污染）；回落路径实测能回；老 UI 与壳**都在**安装包里（切换期必须两份都带，见阶段 8 的决定）。

### 阶段 6：TUI 走同进程载体

- `src/ui/slots.ts` 刻意 React-free，就是为了这一步；ink 组件接同一份注册表。
- 清单里 `platform: 'tui'` 那条路已经预留（`src/core/ui-bundles.ts` 的 `KNOWN_PLATFORMS = {'web','tui'}`）。
- 验收：TUI 里至少一个槽位由插件贡献，且**同一份插件源码**在 web 与 tui 两种载体下各跑一次。

### 阶段 7：第三方界面插件

- **发现**：现在只有 `lib/ui/plugins/manifest.json`。建议**复用手头这套**——宿主插件目录 `~/.dsc/plugins/` + `plugins.json` 启停（`src/core/plugin-loader.ts`）：插件目录里若有界面半边（`ui/client.js` 或 package.json 里一段声明），就把它加进启动图；启停与宿主半边**共用一份记录**，不另起一套开关。dsh 那边是 pnpm + profile 的重方案，对单人单机不值得。
- **版本门禁**：界面半边加 `UI_API_VERSION`（放 `src/ui/plugin.ts`）+ 清单字段 + 加载器检查：不匹配就**不进启动图**，并在诊断区写清原因（dsh 用 peerDependencies semver，dsc 用整数与宿主插件口径一致更省事）。
- **信任确认**：首次装第三方界面插件问一次，把「它能调哪些宿主方法、能不能用原生桥」摊开给用户看，答过的落盘（像 `plugins.json` 那样），不是每次问。
- **产物复核**：`rev` 现在是 mtime/ctime/size 的短哈希，**只承担换地址、不承担安全**。第三方插件要么改成内容摘要（`artifactRev` 已支持传摘要函数），要么在文档里写明「不校验内容」——两者选一，别含糊。
- 示例插件 + 徽标 + 装/卸的实机走查。
- 验收：造一个第三方插件，从 `~/.dsc/plugins/` 装进去、能启停、apiVersion 不匹配时被拒并说明原因、信任确认走一次。

### 阶段 8：打包验证 + 老 UI 收尾

- **打包态验证**（把「没验过」变成「验过」）：装一份 nsis/portable，确认①壳产物路径解析对（extraResources 那份）、②宿主从 extraResources 读到 `lib/ui/plugins/manifest.json`、③认证握手成功、④窗口来自宿主界面服务（stderr 那一行）。
- **决定一份还是两份 UI**：切换期保留回落意味着安装包里同时有旧渲染层（asar 内 `out/renderer`）与壳（extraResources 里 `lib/ui`）。稳定一轮后要么删回落、要么明确长期双份的代价。
- **冻结**：给 `desktop/src/renderer/` 加冻结横幅（`legacy/PROVENANCE.md` 已经声明「家在新目录」），并加一条检查守住两份样式表不再分叉——**只能等桌面切壳之后加**（切之前改那份仍是合理的）。
- 老 UI 标「经典待弃」（用户口径：稳定之后再标）。
- 手机端 `remote-web/` 也切到同一份壳（它现在没用这套区段）。

## 4. 次序与依赖

```
5.0 开关与路径
5.1 原生桥 ──┬─→ 5.2 终端
             ├─→ 5.3 文件预览
             └─→ 5.4 设置/技能/插件页
5.5 会话库管理 → 正式切换 + bridge 退役        （依赖 5.1–5.4 齐）
6   TUI 同进程载体                              （与 5.x 并行也行）
7   第三方（发现 + apiVersion + 信任确认）        （最好在 5.5 之后：要先有稳定的内置插件做样板）
8   打包验证 + 冻结标记 + 经典待弃               （依赖 5.5）
```

每个子步的提交口径照既有约定：先跑 `npx tsc -p tsconfig.json` + `pnpm -C ui-shell build`，再电池 23/24、三个界面探针、浏览器实机，写开发日志一节，约定式提交。

## 5. 需要拍板的四件事

1. **桌面切换的开关形态**：环境变量 / 仓库内 profile 文件 / 打包 profile。推荐 profile 文件（可留档、可分档、与 dsh 同形）。
2. **终端通道的分档**：读类 op 直接放行 + 写类走审批 + `term-*` 只给桌面窗口（推荐）；或者整条 `dock` 继续排除、终端先不做。
3. **第三方版本门禁**：整数 `UI_API_VERSION`（与 dsc 宿主插件一致，推荐）还是照 dsh 的 peerDependencies semver。
4. **演示插件去留**：`hello` / `echo` / `runtime` 是「数据通道是活的」的证据，也是噪声；发布版留不留。

## 6. 风险与反面教训

- **状态码钉死**（阶段 93 的真事）：桌面曾把换票判断写死 302，服务端改成 303 后**静默回落**到本地文件，而自检三个用例全绿。切换期凡是「认证/回落」这类分支，验收必须看 stderr 与界面实际来源，不看绿不绿。
- **测试读 `lib/`，不是 `src/`**：不先 `npx tsc` 就跑测试等于在测旧代码。
- **`display: contents` 的坑**（阶段 95 的真事）：壳给槽条目包的这一层**只对布局透明、对选择器不透明**，legacy 里所有「按直接子节点写」的规则都会失效。搬新视图前先 grep 那个容器有没有 `>` 规则。
- **对齐 ≠ 照抄**：dsh 没有界面通道的方法白名单、没有实参校验、没有三道信任闸、应用文档也没有 CSP。dsc 这几样是这两轮专门加的，别为了「像 dsh」拆掉。

## 7. 没验过的（别当已知事实）

1. **打包态全流程**：我只从代码读出「`lib/` 随 extraResources 走、壳产物因此不在 asar 里」，没有真正装包跑过（阶段 8 的第一件事）。
2. **utilityProcess 读 asar**：旧渲染层产物在 asar 内（`files: out/**`）且今天由宿主伺服，所以「宿主读 asar」这条路理论上在跑，但同样没在打包态验过。
3. **原生桥在 Electron 里的完整能力面**：`WebContentsView` 覆盖层（内置浏览器）怎么在「宿主 serviced 的页面」里定位与生命周期管理，需要 5.1 期间实测。
4. **dsh 的应用文档是否有 CSP**：调研没找到，但不排除在别处注入；这一条只影响「要不要给壳加 CSP」的判断，不影响上面任何一步。
5. **第三方插件的完整性复核**：dsh 没有运行期校验（`rev` 是 mtime 短哈希）；dsc 现在也没有。阶段 7 要么补内容摘要，要么明确写清不校验。
