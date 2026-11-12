# plugin-manager（插件管理）

一句话：plugin-manager 包给模型一个 `plugin_manager` 工具，让它能列插件、热启停、装本地文件、浏览远程源、远程安装，以及按 npm 包名安装与卸载插件包。

## Model Experience（模型体验）

- 注册工具 `plugin_manager`：action 八选一 list / enable / disable / install / browse_remote / install_remote / install_package / remove_package，risk 标 write，因此每次调用都要过审批卡（index.ts:50-66）。
- `list` 回一份清单，每行 `[启用|停用] 名字 (文件) 描述`，读不起来的插件行尾带一个 ⚠ 与原因（index.ts:26-37）。
- `enable` / `disable` 走热挂载：当场生效并写盘持久化，不用重启宿主（index.ts:72-79）。
- `install` 只收 .js，复制到第三方插件目录再热挂载；`install_remote` 只收 https 的 .js 直链（index.ts:80-100、115-143）。
- `install_package` 按 npm 包形态装：spec 支持包名、`name@version`、`file:` 路径与 https tarball。先做形状校验——空白与 shell 元字符一律拒，以 `-` 开头的也拒（那会被 pnpm 当选项，例如 `-g` 或 `--config.registry=…`）；装前把 `package.json` 与 `pnpm-lock.yaml` 存原文，pnpm 非零退出就逐字节还原；成功后重读清单把包名并进 `dsh.profile.bundles`，并报版本与 patch 条数（`core/plugin-npm.ts:109`、`:382`）。
- `remove_package` 跑 `pnpm remove`，同时从 `bundles` 与 `dependencies` 里删掉；失败同样回滚（`core/plugin-npm.ts:453`）。
- 提示词贡献：无，它不注册任何提示段；模型拿到的全部接口就是这一个工具（index.ts:41）。
- 停用之后，模型侧少掉 `plugin_manager`：装、启停插件只能靠人点界面或手改 plugins.json（index.ts:39-42）。

## Known Limitations（已知限制）

- 不注册 `/plugins` 命令：0.6.63 起该命令收归 commands 插件，这里只保留工具。
- 远程源必须 https，`install_remote` 只认 .js 直链，别的扩展名当场拒（index.ts:104、118-120）。
- `install` 的相对路径按 `DSC_HOME` 解析，不按进程 cwd（index.ts:83-85）。
- 文件复制成功但挂载失败时会留在磁盘上，只回一句「可修复后重新启用」（index.ts:91-96、135-138）。
- 远程插件是任意代码：来源只摆在审批卡上说，代码层不做内容审查，装不装由用户点头（文件头 10-11）。
- `install_package` 会跑依赖包的构建脚本，目前只靠 risk=write 的审批卡兜底，没有 dsh 那种单独的 build-approval。
- npm 安装只在 Windows 上验过（本机 `file:` 本地包）；POSIX 分支与真实 registry 的 `name@version`、https tarball 没实机跑过。
- 命令行 `numa plugin add` 与这里的实现是两份逻辑，行为一致但代码没合并。

- 没有设置分区与提示段：插件来源、白名单这类东西不在本包管（index.ts:41）。
- 只本地化了清单里那两行字：`numa plugin list` 与插件中心按 `config.yaml` 的 `language` 显示 `pneuma.title` / `pneuma.description`（`en` 取 `locale/en.json`，其余用清单原文，见 core/plugin-locale.ts）；工具返回值里的中文（清单行格式、提示语）不跟语言走。

## 行与开关

- 行 id `plugin-manager`，包名 `@pneuma/plugin-manager`，order 330。
- resolution 是 overridable（package.json 的 `pneuma.resolution`）。
- 默认开：`cordis.patch.yml` 里没有 `disabled`。
- inject 两个服务：`tools`、`commands`（index.ts:41）；但本包不注册任何命令，命令面只有那个工具。
- `pneuma.title` 2026-11-04 起是「插件管理」（原为包名，插件中心里等于没有标题）。
