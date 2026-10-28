# 一个包两半（示例）

同一个 npm 包声明两半：

| 半 | 在哪 | 谁加载 |
| --- | --- | --- |
| 宿主半 | `exports["."]` → `host/index.js` | 宿主 cordis（`mountBundlePlugins`） |
| 界面半 | `exports["./client"]` → `client.bundle.js` | 界面壳（`discoverPackageUiArtifacts`） |

`package.json` 里两处声明把两半接起来：

```jsonc
"exports": { ".": "./host/index.js", "./client": "./client.bundle.js" },
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },   // 宿主里插一行
  "client": { "platform": "pneuma", "api": "^0.7.1" }   // 界面壳收它
}
```

装法（装进 profile 才会有组合包这一层）：

```sh
numa plugin add ./examples/plugin-two-halves --profile demo
```

看到的效果：宿主多一个工具 `two_halves_hi`（返回「两半都在」），状态栏多一段
「两半示例」。写 `platform: "web"` 的是 dsh 自己的界面半，Pneuma 只列不加载。
