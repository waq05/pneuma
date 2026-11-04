# @pneuma/cli

`numa config` 与 `numa plugin` 两个子命令的实现（`bin/dsc.js` 在内核起来之前直接 spawn 它们）。

## Model Experience

用户在终端敲 `numa plugin add <包>` 时，模型这一轮不会被启动：这条命令在宿主起来之前就结束了。
所以这里的失败文案必须自己说清下一步（没装 pnpm、装不上、包里没有 `pneuma.bundle.patch`），
不能指望界面上再补一句。装完的包在下次启动时进启动图，模型这边看到的是新增的行。

## Known Limitations

- 它是库包，没有装配行，也不出现在插件中心的开关列表里。
- 两个脚本在顶层读 `process.argv` 并 `process.exit`，不能当函数 import（`index.ts` 只导出入口表）。
- 只覆盖 `config`（migrate / show）与 `plugin`（add / remove / list）；其余子命令仍归 `bin/dsc.js`。
