# 兼容性与已验证版本

本仓库的 7 个插件都在 **DSH 0.2.2-rc.5 桌面版**上实测通过。DSH 目前是 nightly 通道的
预发布版本，插件又用到不少内部契约，所以这里把「验证过什么」「依赖什么」「升级怎么回归」
分开写清楚。

## 1. 已验证组合

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| DeepSeek Harness 桌面版 | 0.2.2-rc.5 | `resources/app.asar/package.json` |
| dsh CLI | 0.2.2-rc.5 | `dsh --version` |
| Electron | 44.7.0 | `resources/version` |
| 内置 Node | 24.21.0 | Electron 的 `ELECTRON_RUN_AS_NODE` 模式 |
| 操作系统 | Windows 10 22H2 x64（10.0.19045） | `[Environment]::OSVersion` |
| 验证日期 | 2026-11-19 | |

外部软件（对应插件专用，不影响其他插件）：

| 软件 | 版本 | 备注 |
| --- | --- | --- |
| Everything | 1.5.0.1409（x64） | 必须是 1.5.x，1.4 没有 IPC 命名管道 |
| GridCraft | 0.19.1 | 需要能带 `--control` 启动 |
| PixPin | 3.6.6.0 | 默认安装目录或 `PIXPIN_PATH` |
| AutoHotkey | 2.0.31 | 只给 `desktop_action`；v1 语法不兼容 |
| .NET SDK | 10.0.403（示例） | 任意受支持的 SDK 均可，没装也能显示建议 |
| .NET 运行时 | 10.0.14（示例） | `dotnet-host` 的 worker 与 `desktop-notify` 的 toast 需要 |

复现验证：

```powershell
dsh --version
# 0.2.2-rc.5

Get-Content "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar\package.json" |
  Select-String '"version"'
```

（`app.asar` 是归档文件，普通文本工具读不到；上面这条只在需要确认桌面版版本时参考，
日常用「设置 → 关于」或安装包版本即可。）

## 2. 版本敏感点

升级 DSH 前，先看这次改动有没有碰到下面这些面：

### Host 半（7 个插件）

| 依赖 | 用在哪 | 风险 |
| --- | --- | --- |
| `ctx.tools.register`（含 `parameters` / `output.schema` / `render` / `timeoutMs`） | 所有注册工具的插件 | 工具定义契约变化会直接报错 |
| `ctx.effect` 生命周期 | 全部 | 低 |
| `ctx.webServer` + 路由鉴权 `ctx.connection.admit` | dotnet-dashboard、skills-panel、desktop-notify | 中：鉴权方式变了面板会 401，通知点击的回调也会被拒 |
| `ctx.provide` + Typert Remote 端点发现（`typertRemote` / Remote marker） | desktop-notify（`desktopNotify/events` 流） | 中-高：端点发现方式变了，点击通知就退化成开浏览器 |
| `ctx.inject(['dotnetHost'])` 跨插件服务 | desktop-notify | 低-中：服务名或 `registerPluginDir` 变化会让通知插件静默停用 |
| `ctx.attachments` | pixpin-screen | 中：返回图片依赖附件服务 |
| `ctx.skills` 目录发现 | skills-panel | 中：provider 目录结构变化会影响列表 |
| bundle 格式 `dsh.bundle.patch` + loader 的 `!!js` | gridcraft（路径解析）、全部 | 低-中：格式是公开的，但解析器可能收紧 |

### Client 半（dotnet-dashboard、skills-panel、desktop-notify）

| 依赖 | 说明 | 风险 |
| --- | --- | --- |
| `window.__ModuleLoader__.load({ id, factory })` | 客户端插件入口 | **高**：未公开契约 |
| `dsh.client.inject` + `platform: "web"` | 注入 `dsh-client-ui-sidebar-right` / `layout` / `sidebar` / `locale` | **高** |
| 侧边栏胶囊 / 页面注册、主题 token、`ctx.locale` 命名空间 | 面板 UI | 中-高 |
| `ctx.remote.$mount({ package, descriptors })` + `for await` 的流 | desktop-notify 收回调地址 | **高**：手写调用描述，端点形状变了就断 |
| `fetch` 到 Host 路由并用浏览器凭据认证 | 面板取数 | 中 |

> 这三个界面部分是最容易在升级后失效的地方。即使升级后插件仍能加载，也请打开面板确认能取数，
> 并点一次桌面通知确认能切回会话。

## 3. 升级回归清单

DSH 升级后（或换了机器重装后）按顺序过一遍：

1. `dsh --version` 与「设置 → 关于」的版本一致，且 profile 仍是 `desktop`。
2. 「设置 → 插件」里 7 个 bundle 都显示已启用；没有 `skippedBundles` 报错。
3. 调用 `dotnet_status`：返回 `schemaVersion`、`dotnet`、`nuget`、`guidance` 四个键。
4. 调用 `dotnet_host_status`：`running: true`，工具数正常，重启计数不涨。
5. 调用 `everything_help`：`connected: true`；再跑一次 `everything_search`。
6. 调用 `mcp__gridcraft__list_windows`：能列出窗口；`mcp__gridcraft__read_range` 能读到单元格。
7. 打开右侧边栏「.NET 仪表盘」：SDK、NuGet、项目、建议四块有数据，刷新不报错。
8. 打开右侧边栏「技能」：列表非空，能预览 `SKILL.md`，开关能改变 `/` 菜单与模型目录。
9. `pixpin_screenshot` 取一张 `active-window` 截图（会返回图片）。
10. 离开窗口等一轮任务结束：收到系统通知；点击后回到原会话（界面开着时原地切换）。
11. 如果任何一项失败：先看 DSH 日志里该 bundle 的加载错误，再对照上面的「版本敏感点」判断是
    插件问题还是宿主契约变化。

## 4. 未验证 / 已知不兼容

- **DSH < 0.2.2**：未测试。bundle 与客户端插件体系在这个版本段才成形，旧版本不保证能加载。
- **DSH headless / CLI / ACP profile**：host 半可加载，但三个界面部分不会出现；通知点击会退回浏览器。
- **缺 .NET 10 运行时**：`dotnet-host` 的 worker 起不来，`dotnet_host_status` 报 worker 退出，
  `desktop-notify` 只记一条警告、不弹通知。
- **Everything 1.4**：不支持（没有 1.5 的 IPC 管道）；`everything_help` 会显示未连接。
- **AutoHotkey v1**：`desktop_action` 生成的是 v2 语法，用 v1 会启动失败。
- **GridCraft 未带控制通道启动**：插件会另起一个受控实例，不会附加到已有窗口。
- **锁屏 / RDP 断开 / 非交互会话**：截图与桌面操作不可用。

## 5. 回滚

插件目录与 DSH 安装互相独立：保留上一份可用的 DSH 安装包即可整体回滚；插件本身用
`git checkout <tag>` 回到旧版本，再重启 DSH。改动前建议给 profile 目录
（`%USERPROFILE%\.dsh\profiles\desktop`）做一份备份。
