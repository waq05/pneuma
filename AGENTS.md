# 项目提示词 · Pneuma

## 1 这个仓库是什么

- 一句话：Pneuma（numa）是终端 AI 编程助手——自研 ReAct loop + cordis 插件装配 + ink 界面 + Electron 桌面 + 手机遥控。入口 `bin/dsc.js`；改 `src/core/` 前先读 [development.md](docs/development.md)。
- 三层铁律（[development.md:40](docs/development.md)）：`src/core/` 不出现 ink / electron / react；界面只调 `host-stdio` 白名单（`INVOKABLE_METHODS`）；新功能挂 cordis 扩展点，不改 `session-core/loop.ts`。
- 命令：装 `pnpm install`；改 `src/**` 跑 `pnpm run build`；改桌面跑 `pnpm --dir desktop typecheck`；推门跑 `typecheck / typecheck:spec / check:style / law / ci-coverage / probe-inventory / test`，夜跑跑探针，本地全量 `pnpm run check:all`。
- 版本：根 / `desktop` / `ui-shell` 三处 `package.json` 与 git tag 对齐，外加 `src/packages/*/package.json` 一组包；清单见 `scripts/version-sites.json`，自证跑 `node scripts/version-check.mjs --tag <版本>`。tag 从 `main` 打。

## 2 两种指令，别混

- **嘱咐**（本文件、prompt、skill）模型通常照做，没保证；**强制**（hook、脚本、CI）每次必执行。
- 加粗三遍还不听，说明它属于强制，搬出去。
- 只写读代码读不出来的、会误导的旧模式、已纠正两次的事。架构不用写，它自己会读。

## 3 五道闸

1. **看现场**：`git status --porcelain` / `git branch --show-current` / `git log --oneline -5`；别人的在途改动先读再动。
2. **出方案**：选项、代价、推荐项、不做会怎样，缺一栏算没交。需求不清先问，猜的标「这是猜的」。
3. **等批准**：用户说「动手」之前不写码，也不派实现型子代理。
4. **拆批**：三步以上先列清单，一步一改状态；按「能独立验收」切。
5. **交付**：先自证后交接。没跑写「没跑」，跑挂写 FAIL 条数与原因。

## 4 判据：话要能验

| 你说 | 我要看到 |
| --- | --- |
| 读过代码 | `文件:行号`，贴不出来就是没读 |
| 查过了 | 查不到就写「查不到」 |
| 验过了 | 命令 + 退出码 + 末尾 10 行输出 |
| 改完了 | 只剩该改的文件 |
| 全绿了 | PASS / FAIL 数 + 没做到的地方 |

「全部通过」什么都不是；N PASS / M FAIL 写法不统一，只有退出码算数。

## 5 验证面：不全量

- 内核 `src/core/**`：`pnpm run build` + `node scripts/check-core.mjs`。
- 插件 `src/packages/**`：`pnpm run check:plugin`；新探针 `<话题>-test.mjs` 自动进门禁，P0 用 `<话题>-check.mjs` 登记进 `scripts/check-p0.mjs`。
- 界面 `ui-shell/**`：`pnpm run check:ui`；看画面跑 `desktop/shots/*.mjs` 截图自己看。
- 桌面 `desktop/**`：`pnpm --dir desktop typecheck` + 对应 shots；文档 `docs/**`：`pnpm run docs-check`（第一批只报不拦）。门禁怎么跑、红了怎么修，见 [docs/gates-playbook.md](docs/gates-playbook.md)。
- 自检跑临时 HOME，不碰 `~/.dsc`；证据配不上改动面等于没验证。

## 6 会话与派活

- 一个会话一件事，换任务先清上下文。第一个提示词最值钱：点名文件、症状、什么叫修好。
- 派活写清六样：角色、任务、参考源码、**可写白名单 + 禁改黑名单**（越界即失败）、产出格式、验收命令。
- 并行时 `src/contract/` 冻结；契约一动，界面与内核两边同时编译。
- 收尾写交接：目标、已提交、未提交、跑过 / 没跑过、剩余阶段、待拍板。

## 7 被拦、卡住、危险动作

- 破坏性操作（递归删除、强推、重置、删表）先说影响范围与回滚。
- 被沙箱、权限、网络拦住：贴原始报错，用最窄授权重试一次，不许改测试或绕路。
- 失败两轮就停，三行报上来：试了什么、卡在哪、需要什么。
- 查不到就说查不到。不读、不复述密钥。

## 8 提交

- 前缀 `feat` / `fix` / `docs` / `chore` / `refactor` / `test`；标题写做了什么，正文写为什么。
- 一次只做一件事，按层分批：杂务 → 启动器 → 内核 → 插件装配 → 桌面 → 文档。没让推就不推。

## 9 这份文件怎么改

- 一条一行，能删就删；新增先问读代码能不能得到，能就删。
- 全文 ≤2000 字；超了先搬家到子树文件，再压缩，最后抬上限并说明。
- 规则配门禁，没门禁会变成摆设。流程变了同批改文档。

以上九节。想加第十节，先问自己：这是偏好，还是规则。
