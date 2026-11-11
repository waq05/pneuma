# @pneuma/doctor — 体检

> `/doctor` 一条命令跑九项检查，出人读版或 `--json`。

## 为什么要有这个包

对标 codex 时最实用的一条是 `codex doctor`：用户说「用不了」时，不必来回问十句，
让他在终端跑一条命令，把结果贴过来就能定位大半。

本仓此前的对应物是散着的：`/plugins` 看插件、`/sandbox` 看沙箱、设置页看模型。
它们各自都对，但**没人把「这台机器现在到底怎么了」合成一句话**。这个包就干这件事。

## 九项检查

| # | id | 查什么 | 谁来提供 |
| --- | --- | --- | --- |
| 1 | `install` | 版本、Node、应用根、基础包清单在不在 | 本包 |
| 2 | `config` | `config.yaml` 能不能读、几个端点、默认模型 | `ctx.settings.modelConfig()` |
| 3 | `auth` | 各端点**有没有**密钥（一个字符都不打印） | 同上 |
| 4 | `plugins` | 插件总数、启用数、停用的是哪些 | `listPluginInfos()` |
| 5 | `session` | `~/.dsc/sessions` 可写、有没有残留 `.lock`、最近几份 | 本包 |
| 6 | `disk` | `sessions` / `logs` / `spill` / `storages` / `memory` 各占多少 | 本包 |
| 7 | `sandbox` | 当前档位、强制等级、网络放行 | `ctx.get('sandbox')` |
| 8 | `reachability` | 对默认端点 GET `/models`，3 秒超时 | 本包 |
| 9 | `terminal` | 探到的 shell 列表（强制重探，绕开 7 天缓存） | `detectShells(true)` |

结论四档：`ok` / `warn` / `fail` / `skip`。`skip` 与 `ok` 分开，是因为「没查」和「查了没问题」
是两件事——沙箱插件没开时不能假装它绿。

## 用法

```
/doctor                        人读版
/doctor --json                 机器可读版（家目录抹成 ~，可直接贴出去）
/doctor --bundle               写诊断包：~/.dsc/exports/dsc-diag-<时间>.json.gz
/doctor --bundle --with-session  连最近一份会话的对话摘要一起带
```

诊断包里是：体检结论、最近 300 行日志、最近 5 份会话的**路径**。
**默认不含**模型密钥、请求/响应正文、工具输出正文、会话内容——这一条写在包的 `excluded`
字段里，收到包的人一眼能看见没收什么。

加 `--with-session` 会附上最近一份会话的最后 200 条事件（用户与模型的话、工具名），
每条正文截到 400 字并过一遍脱敏；此时 `excluded` 里会**去掉**「会话的完整内容」那一项，
因为包里确实带了它的摘要——说明与实际不符比不说明更糟。

人读版长这样：

```
Pneuma Doctor 0.9.1 · win32 x64 · node v24.19.0

✓ 安装      0.9.1 · node v24.19.0
! 连通性    服务端 503
             修复：过一会儿再试；持续如此可能是端点侧故障
...

1 项警告
```

## 插件化落点：`ctx.health.register`

```ts
ctx.health.register({
  id: 'browser/chromium',
  title: 'Chromium',
  order: 100,
  async run() {
    return { status: 'ok', summary: '能起来' }
  },
})
```

- `id` 全局唯一，重复登记当场抛错——撞名比少查一项更难查；
- `order` 小的先跑，内置九项占 10–90，插件从 100 起；
- 单项 `run()` 抛错只算该项 `fail`，不拖垮整轮（体检在最需要它的时候不能自己先倒）。

## Model Experience（模型体验）

- **模型碰不到这个包**：它不注册工具、不往提示词里加东西。`/doctor` 是人用的命令，
  输出也不会进会话上下文。
- 检查结果里只有路径、数量、状态，**没有任何密钥原文**；`--json` 还会把家目录换成 `~`。
- 唯一一次外发请求是 `reachability` 对端点 GET `/models`，**不带密钥**；401/403 也算可达。

## Known Limitations（已知限制）

- **会话只验「在不在」，不验「读不读得开」**：解析 JSONL 要处理截断、老版本格式与迁移，
  归到后续批次。现在报的是「最近 5 份文件」，不是「这 5 份都能重放」。
- **不做自动修复**：只给「修复」建议，不动用户的文件。`codex doctor` 也是这个口径。
- **连通性只看默认端点**：有多个端点时其余不测，避免一次体检发一堆请求。
- **terminal 会真的起子进程**：`detectShells(true)` 绕开缓存，在很慢的机器上这一项可能要几秒。
- **没有图形界面**：第一批只做命令，桌面端设置页入口留到后续。

## 验证

```powershell
node --test --test-isolation=none src/packages/doctor/tests/doctor.test.mjs
```

真机冒烟：起内核后跑 `ctx.health.run()`，确认九项都有结论、`--json` 可解析。
