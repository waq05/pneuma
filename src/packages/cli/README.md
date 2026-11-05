# @pneuma/cli

`numa config` 与 `numa plugin` 两个子命令的实现（`bin/dsc.js` 在内核起来之前直接 spawn 它们）。

## 插件命令

```text
numa plugin add <包名|tarball|本地路径> [--profile 名字]
numa plugin remove <包名> [--profile 名字]
numa plugin list [--profile 名字]
numa plugin version-exemptions [--profile 名字]
numa plugin allow-version <包名@版本> --dsh-version <运行时版本> [--accept-risk]
numa plugin revoke-version <包名@版本> --dsh-version <运行时版本>
```

后三条读写 profile 目录里的 `compatibility.json`。版本闸（包的 `engines` 对不上当前运行时）
不满足的包，启动时会被跳过；登记一条豁免是让它重新挂上的唯一入口。

- `version-exemptions`：列出账本——包名、登记的包版本、登记的运行时，以及每条对不对得上
  当前运行时（`DSH_CONTRACT_VERSION`）。老记录只写了包名（手改的），单独标出来。
- `allow-version`：登记「这个包的这一个版本 × 这一个运行时」。**不给 `--accept-risk` 一律拒绝
  写盘**，并打印风险原文：不兼容插件可能崩溃或丢数据，这条授权只对这一个版本组合有效。
  `--dsh-version` 必须等于当前运行时版本，写别的版本会被拒绝。
- `revoke-version`：删掉那一条授权。老记录（只写了包名、没有运行时）在撤销同一包同一版本时
  一并删掉——它本来就不是一次精确授权。

写进去的形状：

```json
{ "exemptions": [{ "package": "@acme/foo", "version": "1.2.3", "dshVersion": "0.2.1" }] }
```

**版本闸读这份文件时只认 `package`**（见 `src/core/plugin-bundle.ts` 的 `readProfile`），所以一条
记录实际放行的是这个包的全部版本；`version` 与 `dshVersion` 是给核对和撤销用的账本，不参与判定。
这条限制写在命令的输出里，别让用户以为它精确到了版本。

## Model Experience

用户在终端敲 `numa plugin add <包>` 时，模型这一轮不会被启动：这条命令在宿主起来之前就结束了。
所以这里的失败文案必须自己说清下一步（没装 pnpm、装不上、包里没有 `pneuma.bundle.patch`），
不能指望界面上再补一句。装完的包在下次启动时进启动图，模型这边看到的是新增的行。

版本闸不过的包也一样：`add` 装得上，但启动时那一行会被跳过，模型这边看到的是「少了一个工具」。
要放行得由用户自己跑 `allow-version ... --accept-risk`——那是知情授权，模型不能代答。

## Known Limitations

- 它是库包，没有装配行，也不出现在插件中心的开关列表里。
- 两个脚本在顶层读 `process.argv` 并 `process.exit`，不能当函数 import（`index.ts` 只导出入口表）。
- 只覆盖 `config`（migrate / show）与 `plugin`（add / remove / list / version-exemptions /
  allow-version / revoke-version）；其余子命令仍归 `bin/dsc.js`。
- 豁免按包名放行，不是按「包 + 版本」放行；精确到版本要改 `core/plugin-bundle.ts` 的读取口径，
  这一轮没做。
