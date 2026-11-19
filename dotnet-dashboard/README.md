# .NET 仪表盘（@local/dotnet-dashboard）

一个 DSH 插件：在右侧边栏展示本机 .NET 与 NuGet 状态，并针对当前工作区的 .NET 项目给出可执行的下一步建议。

## 已验证版本

- DSH 桌面版 **0.2.2-rc.5**（Windows 10 22H2 x64）。
- `dotnet_status` 实测返回 .NET SDK 10.0.403 的工具链快照（SDK 版本只是示例，不是要求）。
- 升级前后的回归清单见 [docs/compatibility.md](../docs/compatibility.md)。

## 在哪里看到它

- 打开右侧边栏（对话页右上角的展开按钮，或默认的「指南」页），点击 **.NET 仪表盘** 胶囊即可打开面板。
- 面板按会话的工作目录取数：切换会话后刷新即可看到对应项目。

## 面板内容

| 区块 | 内容 |
|---|---|
| SDK 与运行时 | `dotnet` 是否存在、CLI 版本、可执行文件位置、已安装 SDK、运行时数量与明细 |
| NuGet 源 | 生效的包源（名称 / 地址 / 是否启用 / 来源配置文件）、全局包缓存数量、凭据配置是否存在 |
| 项目概览 | 主项目、目标框架、包引用与项目引用数量、解决方案数量、测试项目数量 |
| 指导建议 | 按「错误 → 警告 → 提示 → 正常」排序的建议，每条都带有可直接复制的命令 |

建议覆盖：SDK 缺失、`global.json` 锁定版本未安装、NuGet 源缺失或缺少 nuget.org、被禁用的源、
项目缺失、目标框架过旧、未启用可空引用、未还原或依赖过期、没有测试项目、没有集中版本管理、
警告不阻断构建、缺少 `.editorconfig`、依赖审计与常用命令。

## 给模型的工具

插件注册了 `dotnet_status` 工具，返回与面板相同的一份快照（SDK、运行时、NuGet 源、项目与建议 id），
让模型在建议 build / restore / 包管理之前先读真实工具链，而不是猜版本。

## 实现要点

- `index.js`（Host 半）：`dotnet --version / --list-sdks / --list-runtimes` 探测工具链；
  解析 NuGet 配置链（用户级 + 仓库级 `NuGet.Config`）；扫描工作区里的 `*.csproj|fsproj|vbproj|sln|slnx`；
  读取项目文件得出目标框架、包引用、`Directory.Packages.props`、`global.json` 等事实。
  结果按目录缓存 60 秒，SDK 探测缓存 5 分钟。
- `GET /dotnet/status?sessionId=…&refresh=1`：只读路由，用浏览器凭据（`ctx.connection.admit`）校验后返回 JSON。
- `client.js`（Client 半）：注册右侧边栏的标签页类型 `dotnet` 与指南胶囊，用主题 token 渲染面板；
  命令支持点击复制。所有可见文案来自 `ctx.locale` 的 `dotnetDashboard` 命名空间（中 / 英）。

## 文件

```
index.js           Host 半：探测、缓存、工具、HTTP 路由
client.js          Client 半：侧边栏标签页与面板
cordis.patch.yml   插入 id 为 dotnet-dashboard 的 Loader 行
locale/{en,zh}.json 插件清单里显示的名称与描述
icon.svg           插件图标
```

## 停用

在「设置 → 插件」里关闭 **.NET 仪表盘**，或在插件管理中移除该 bundle；移除后标签页、工具与路由一并消失。
