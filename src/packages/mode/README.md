# mode（协作模式）

一句话：mode 包维护当前会话的协作档位（执行 / 计划 / 探索 / 免打扰），换档时改一段环境说明，并用守卫链上的闸门把越界调用当场拒掉。

## Model Experience（模型体验）

- 不注册工具；注册守卫 `mode`，order 10，排在审批（30）之前：按这次调用所属会话的档位判 pass / defer / deny，deny 的理由原样回给模型（index.ts:93-119）。
- 提示词贡献：`registerEnvFacts('mode', …)` 把当前档位的条款写进每轮请求末尾的环境快照，不进系统提示词——换档时系统提示前缀不变，服务端缓存照旧命中（index.ts:86-90）。
- 四档条款长度：执行 3 行、计划 18 行、探索 5 行、免打扰 7 行；计划档那 18 行写清了计划该写哪几节、用 `exit_plan_mode` 交（packages/session-core/modes.ts:149-184）。
- 五个命令：`/mode <执行|计划|探索|免打扰>` 与 `/plan`、`/explore`、`/quiet`、`/build`；带话进来时切完档顺手把那句话发出去（index.ts:131-167）。
- 换档写进会话的 `mode` 状态条目，恢复历史会话时档位跟着回来（index.ts:50-52、123-126）。
- 停用之后，模型侧少掉：每轮末尾那段档位条款与那道闸门，写与命令不再被档位拦，全交给权限模式和审批卡（index.ts:36、90）。

## Known Limitations（已知限制）

- 闸门只管「要不要问」，问出来怎么裁是权限模式（approval 插件）的事，两根旋钮互不引用（文件头 9-11）。
- 执行档一律 defer，不拦任何调用；被拦只发生在其余三档（packages/session-core/modes.ts:187）。
- 只读命令的判定借审批的策略引擎，判成 allow 才算只读：计划档与免打扰档都跑不了被判危险或需要确认的命令（packages/session-core/modes.ts:96-100）。
- 档位按会话存，没有进程级变量：后台会话按它自己的档位判，你把界面切到执行也不会放行它的写（index.ts:39-48）。
- 计划档只开一个写口子——工作区内 `.dsc/plans/` 下的 .md；写别处、以及工作区外的写，当场拒（packages/session-core/modes.ts:88-94、103-119）。

## 行与开关

- 行 id `mode`，包名 `@pneuma/mode`，order 130。
- resolution 是 pinned（package.json 的 `pneuma.resolution`），profile 里的同名版本换不掉它。
- 默认开：`cordis.patch.yml` 里没有 `disabled`。
- inject 六个服务：`session`、`commands`、`approval`、`guards`、`prompt`、`surfaces`，并 provide `mode`（index.ts:36-37）。
- 没有设置分区：档位从界面上的模式选择器与命令切，写进会话状态，不落进程级配置（index.ts:34-37、77-83）。
