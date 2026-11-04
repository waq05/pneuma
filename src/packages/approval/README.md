# approval（审批）

一句话：approval 包在工具真正执行前替用户把一道关，按固定顺序裁决，需要问用户的时候就弹一张卡等他点。

## Model Experience（模型体验）

- 不注册工具：它挂在守卫链 order 30 上（文件头 22 行、index.ts:1013-1034），请求循环因此不认识「审批」这件事。
- 被拒时模型拿到的原话是「用户拒绝了这次工具调用。」（index.ts:1032，常量 REJECTED_TOOL_TEXT 在 core/session.ts:268），老会话日志按这句话认「被拒」。
- 所有工具结果先过遮红再进上下文：密钥形状的字符串既不落盘，也不进模型上下文（index.ts:1035-1037）。
- 裁决顺序写死在文件头：硬地板 → 路径护栏 → 命令策略 → 已给授权 → 权限模式 → 审阅者 → 人工卡；前面一层说了话，后面不再放宽（index.ts:4-11）。
- 两个投影给界面：`policy` 给当前档位与审阅者，`pendingApproval` 给当前会话最老的那张卡（index.ts:1039-1040）。
- 停用之后，模型侧少掉这道裁决与遮红：工具调用不再有人拦，密钥形状的文本会原样进上下文。

## Known Limitations（已知限制）

- 只问「这一次」：没人能回答卡时直接按拒处理，不白等一次超时（文件头 13-15）。
- 卡默认等 300 秒，超时按拒；可配区间是 10 秒到 1 小时（index.ts:57-69）。
- 永久允许会写进 `~/.dsc/policy.rules` 并立刻重读（index.ts:973-980）——策略规则是它**唯一改的配置**；此外每次裁决都落一条审计（`~/.dsc/audit.jsonl`，index.ts:497/521/561/718/735/980），AI 复核记用量（659），改档位与审阅者按会话写状态（713/733）。
- 判断「要不要问」会参考 sandbox 的判定；sandbox 不在场时它不 defer，因为那等于无人把关地放行（sandbox/index.ts:329-332）。
- 与 dsh 同族能力的差异：待确认，本包只在注释里说审计事件「照搬 DSH 的 approval/asked + approval/decided」（文件头 19-20），没列差异。

## 行与开关

- 行 id `approval`，包名 `@pneuma/approval`，order 60。
- resolution 是 pinned：应用安装目录里的这一份优先（core/plugin-loader.ts:1306-1312）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 五个服务：`llm`（AI 复核要发请求）、`session`、`guards`、`surfaces`、`waiting`（index.ts:303）。
- 权限档位与审阅者按会话存（index.ts:306-327），不是进程全局值；设置里改的是新会话的默认值。
