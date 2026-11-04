# git（git）

一句话：git 包把当前工作区的分支名与改动条数登记成一片快照面，供输入框的分支钮和状态面板读取。

## Model Experience（模型体验）

- 不注册工具：整个文件只有一处 `ctx.surfaces.register('git', …)`，交出去的是 `repo / branch / detached / dirtyFileCount` 四个字段（index.ts:31-32、154-160）。
- 提示词贡献为零：没有 `ctx.prompt` 调用，模型看不到分支，也看不到自己改脏了哪些文件。
- 它自己的读数节奏：有改动 12 秒、干净 30 秒、不是仓库 60 秒；回合收工、换会话、写类 git op 落盘时催一拍（index.ts:35-37、162-169）。
- 没人看就不跑 git：超过 20 秒没人读过这一片，就只留一条 5 秒一次的廉价巡检（index.ts:43-45、120-133）。
- 停用之后，模型侧什么都不少；少掉的是界面上的分支钮与状态面板的 Git 区——它们读不到这片快照。

## Known Limitations（已知限制）

- 只数改动条数，不读每文件增删行数；那条重读数（`stats: true`）留在壳里按自己更松的节奏走（index.ts:12-14）。
- 条数按会话工作目录内统计：仓库根在工作目录之上时，外面的改动不计入（index.ts:102-106）。
- 不是仓库、git 不在、目录没了都折成同一种空读数 `{repo:false, …}`，界面按整块不画处理（index.ts:31-32、108-110）。
- 缓存只记一个工作目录：换会话只有 cwd 真的变了才重拍，同一工作区里的会话共用一个读数（index.ts:62-69、167-169）。
- 只有界面连着时才拍：快照的 `read()` 只在有人连着界面时发生，CLI / TUI 会话里这片读数一直是空的（index.ts:16-21、122-126）。

## 行与开关

- 行 id `git`，包名 `@pneuma/git`，order 320。
- resolution 是 overridable（core/plugin-loader.ts:1394）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 两个服务：`session`、`surfaces`（index.ts:49）；provide 一个 `git`，只有 `snapshot()` 与 `refresh()` 两个方法（index.ts:140-146）。
- 写类 git op 落盘后由 desktop-dock 调 `refresh()` 催拍（index.ts:2-3、162-163）。
