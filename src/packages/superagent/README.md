# superagent（Super Agent）

一句话：superagent 包把一句自然语言需求派给一个独占工作区的智能体去改代码，改完把结果连同改动摘要退回工单。

## Model Experience

- P0 阶段只装配一个设置分区 `superagent`：模型侧**还没有**新增任何工具、命令或提示词，这一轮不改变模型看到的东西。
- 分区里先放一个「默认仓库路径」文本项（键 `repoPath`，默认空字符串），用来占住「派活时去哪个仓库改」这个位置。
- 等第 2、3 步接上存储层与领域核心，模型才会拿到「建工单 / 看工单 / 收结果」的能力；那之前这里只是一块配置。

## Known Limitations

- 只有骨架：没有数据库、没有调度器、没有工具，模型现在还不能真的把需求派出去。
- P0 只支持手动发布，不接 GitHub：工单由人在界面或命令里手动发出，不监听 issue / PR，也不回写评论。
- 设置分区里填的仓库路径只存在内存里，重开宿主就回到空串（落盘属于第 2 步存储层）。
- 默认关：`cordis.patch.yml` 里写死 `disabled: true`，要试装配得先在插件中心启用这一行。

## 行与开关

- 行 id `superagent`，包名 `@pneuma/superagent`，order 3800。
- resolution 是 overridable（`package.json` 的 `pneuma.resolution`），别的包可以盖掉这一行。
- `exports` 只有三个键：`.`、`./cordis.patch.yml`、`./package.json`；这一轮不声明 `./locale/*.json`，所以目录里也没有 `locale/`。
- 装配面只有一处：`ctx.settings.registerSection`（index.ts:74-75），退订交给 `ctx.effect` 统一收口。
