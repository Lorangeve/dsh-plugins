# DSH 插件集 · dsh-plugins

为 **DeepSeek Harness（DSH）桌面端**写的 5 个本地插件：把本机的 Everything、GridCraft、
PixPin / AutoHotkey 和 .NET 工具链接进 Harness，另外补了一个技能开关面板。

全部以 Cordis **bundle** 形式挂载（`package.json` 里的 `dsh.bundle.patch`），纯 ESM、
零 npm 依赖、无构建步骤。它们不是 npm 包：每个包都是 `private`，以「本地目录 → profile link」
的方式安装（见[安装](#安装)）。

English: a collection of local DeepSeek Harness plugins (Everything search, .NET dashboard,
GridCraft MCP bridge, PixPin screen + desktop actions, skills panel). See
[docs/compatibility.md](docs/compatibility.md) for the verified DSH version.

---

## 已确认可用的 DSH 版本

下表是**实际跑通**的环境，不是「理论上支持」：

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| DeepSeek Harness 桌面版 | **0.2.2-rc.5** | 安装包 `resources/app.asar/package.json` 的 `version`；nightly 通道 |
| dsh CLI | 0.2.2-rc.5 | `dsh --version` |
| Electron / 内置 Node | 44.7.0 / 24.21.0 | 桌面端宿主 |
| 操作系统 | Windows 10 22H2 x64（10.0.19045） | 5 个插件都在此环境实测 |
| 验证日期 | 2026-11-19 | |

外部软件（只有对应插件需要时才装）：

| 软件 | 实测版本 | 用于 |
| --- | --- | --- |
| Everything | 1.5.0.1409（x64） | `everything` |
| GridCraft | 0.19.1 | `gridcraft` |
| PixPin | 3.6.6.0 | `pixpin-screen` |
| AutoHotkey | 2.0.31（v2） | `pixpin-screen` 的 `desktop_action` |
| .NET SDK | 10.0.403（示例，非固定要求） | `dotnet-dashboard` |

> ⚠️ **只承诺 0.2.2-rc.5。** 两个带界面的插件依赖 DSH 未公开的客户端插件契约
> （`window.__ModuleLoader__`、右侧边栏 / 布局服务、`ctx.connection.admit` 鉴权），
> 跨 rc 或大版本升级可能失效。升级前后的回归清单见 [docs/compatibility.md](docs/compatibility.md)。

---

## 插件一览

| 目录 | 包名 | 版本 | 能力 | 形态 | 平台 |
| --- | --- | --- | --- | --- | --- |
| [`dotnet-dashboard/`](dotnet-dashboard/) | `@local/dotnet-dashboard` | 1.0.0 | 探测 `dotnet` / SDK / 运行时 / NuGet 源 / 工作区项目，给出可直接复制的下一步命令；注册 `dotnet_status` 工具和右侧边栏面板 | Host + Client | 任意平台，面板需 Web UI |
| [`everything/`](everything/) | `@local/dsh-tool-everything` | 0.2.0 | `everything_search` / `everything_help`：毫秒级查询 Everything 1.5 索引，支持原生语法、分页、`count_only` | Host | Windows |
| [`gridcraft/`](gridcraft/) | `@local/gridcraft` | 1.0.0 | 通过 stdio MCP 把 GridCraft 接成 20 个 `mcp__gridcraft__*` 工具，通道不存在时自动拉起受控实例 | 纯配置 bundle（MCP） | Windows |
| [`pixpin-screen/`](pixpin-screen/) | `@local/pixpin-screen` | 1.0.0 | `pixpin_screenshot`：PixPin 截图 / 标注 / 贴图；`desktop_action`：AutoHotkey 编排的鼠标键盘操作 | Host | Windows |
| [`skills-panel/`](skills-panel/) | `@local/skills-panel` | 1.0.0 | 右侧边栏「技能」页：列出当前 profile 可达的技能、预览 `SKILL.md`、一键切换模型与 `/` 菜单可见性 | Host + Client | 任意平台，面板需 Web UI |

### 实测证据

| 插件 | 验证方式 | 结果 |
| --- | --- | --- |
| dotnet-dashboard | 调用 `dotnet_status` | 返回 `dotnet 10.0.403`、SDK 列表、NuGet 源、项目建议 |
| everything | 调用 `everything_help` / `everything_search` | 管道 `\\.\pipe\Everything IPC (1.5a)`，Everything 1.5.0.1409，查询毫秒级返回 |
| gridcraft | `mcp__gridcraft__list_windows` + MCP `initialize` 握手 | 返回窗口 `Book1`；`serverInfo` = gridcraft 0.19.1 |
| pixpin-screen | 工具列表 + 本机标注截图演示 | `pixpin_screenshot` / `desktop_action` 可用 |
| skills-panel | 右侧边栏「技能」页 | 技能列表、预览与开关可用 |

---

## 前置条件

**所有插件共同需要：**

- Windows 10/11 x64 上的 **DSH 桌面版 0.2.2-rc.5**，并已初始化
  `%USERPROFILE%\.dsh\profiles\desktop`（默认 profile）。
- 能在「设置 → 插件」里从本地目录安装 bundle，或手动往 profile 的
  `package.json` / `node_modules` 里 link（见 [docs/install.md](docs/install.md)）。
- 插件目录可被 DSH 宿主进程读取（不要把插件放在需要提权才能访问的位置）。

**按插件：**

| 插件 | 必需 | 可选 / 覆盖方式 |
| --- | --- | --- |
| dotnet-dashboard | 无（没有 .NET SDK 也能显示「未安装」和安装建议） | `dotnet` 在 PATH，或 `DOTNET_ROOT`，或默认安装目录 |
| everything | Windows + 正在运行的 **Everything 1.5**（1.4 不支持，它没有 IPC 命名管道） | `instance` / `pipe`（仅 YAML 配置） |
| gridcraft | Windows + **GridCraft 0.19.1**（默认 `C:\Program Files\ArtCraft\GridCraft\`） | `GRIDCRAFT_APP`、`GRIDCRAFT_CLI`、`GRIDCRAFT_CONTROL_PORT`（默认 7979）、`GRIDCRAFT_NODE`、`GRIDCRAFT_BRIDGE` |
| pixpin-screen | Windows + **PixPin 3.6.x**；区域截图需要可交互的桌面会话 | `PIXPIN_PATH`、`AUTOHOTKEY_PATH`；面板配置 `pixpinPath` / `powershellPath` / `autohotkeyPath` / `captureTimeoutMs` / `regionTimeoutMs` |
| pixpin-screen 的 `desktop_action` | **AutoHotkey v2**（2.0.31 实测） | `AUTOHOTKEY_PATH` 或 `autohotkeyPath` |
| skills-panel | 无 | 技能目录：`<项目>/.dsh/skills`、`<项目>/.agents/skills`、`~/.dsh/skills`、`~/.agents/skills` |

> GridCraft 的 `bridge.mjs` 启动器由 bundle 在加载时解析路径：默认使用当前 DSH 进程的可执行文件
> （桌面版即 Electron，配 `ELECTRON_RUN_AS_NODE=1` 当 Node 用），以及 desktop profile 里
> `node_modules/@local/gridcraft/bridge.mjs`。换了 `DSH_HOME` 或 profile 名时用
> `GRIDCRAFT_BRIDGE` 覆盖，细节见 [gridcraft/README.md](gridcraft/README.md)。

---

## 适用范围

**适用：**

- 单机、单用户的 Windows 桌面场景：把本机的文件索引、表格应用、截图 / 桌面自动化、.NET 工具链
  接进 Agent，让模型**读真实状态**而不是猜。
- 需要中英双语界面（每个插件都带 `locale/{en,zh}.json`）。
- 本地开发、自用、内部分享；插件以本地目录 link 进 profile，随改随生效。

**不适用：**

- **多用户 / 远程 / 容器化部署**。这些插件直接操作本机进程、命名管道、桌面 UI 和临时目录，
  没有租户隔离，也不要装到别人的机器上代跑。
- **headless / CLI / ACP profile**。host 半的工具仍可能可用，但 `dotnet-dashboard` 和
  `skills-panel` 的界面不会出现（没有 `webServer` / Web UI），客户端 bundle 也不会加载。
- **非 Windows**：`pixpin-screen`、`everything`、`gridcraft` 都依赖 Windows 专有接口；
  `dotnet-dashboard` 和 `skills-panel` 的 host 半是跨平台的，但面板同样需要 Web UI。
- **npm 发布**：包名是 `@local/*` 且 `private: true`，它们只作为本地 bundle 使用。
- **无人值守 / 锁屏状态下的截图或桌面操作**：需要已解锁的交互式会话。

---

## 安装

完整的步骤、手动 link 方式、卸载和排错见 [docs/install.md](docs/install.md)。最短路径：

1. 克隆到本机任意位置，例如 `D:\mycoding\plugins`（本仓库的目录结构就是 plugin 根目录）。
2. 打开 DSH 桌面版 →「设置 → 插件」→ 从本地目录安装，依次选择需要的插件目录
   （`dotnet-dashboard`、`everything`、`gridcraft`、`pixpin-screen`、`skills-panel`）。
3. 重启 DSH（或在插件页重载），然后按下面的清单验证。

安装完成后 profile 里的记录长这样（`%USERPROFILE%\.dsh\profiles\desktop\package.json`）：

```json
{
  "dependencies": {
    "@local/gridcraft": "link:D:/mycoding/plugins/gridcraft"
  },
  "dsh": {
    "profile": {
      "bundles": ["@local/gridcraft"]
    }
  }
}
```

### 验证清单

| 检查 | 期望 |
| --- | --- |
| 调用 `dotnet_status` | 返回 `schemaVersion: 1`、`dotnet.found`、`nuget.sources`、`guidance` |
| 调用 `everything_help` | `connected: true`，并给出管道名与 Everything 版本 |
| 调用 `everything_search`（如 `ext:ps1 size:>10kb`） | 毫秒级返回路径、大小、修改时间 |
| 调用 `mcp__gridcraft__list_windows` | 返回一个或多个 GridCraft 窗口 |
| 右侧边栏出现「.NET 仪表盘」「技能」胶囊 | 面板可打开、可刷新 |
| `pixpin_screenshot`（`target: "active-window"`） | 返回截图并附带图片 |

---

## 目录结构

```
dsh-plugins/
├─ README.md                 # 本文件：版本、前置条件、适用范围
├─ LICENSE                   # MIT
├─ docs/
│  ├─ compatibility.md       # 已验证版本、版本敏感点、升级回归清单
│  └─ install.md             # 安装 / 更新 / 卸载 / 排错
├─ scripts/check.mjs         # 仓库自检：manifest、exports、locale
├─ dotnet-dashboard/
├─ everything/
├─ gridcraft/
├─ pixpin-screen/
└─ skills-panel/
```

每个插件目录都是一个独立的 npm 包，约定相同：

```
<plugin>/
├─ package.json        # name/version + dsh.bundle.patch（+ dsh.client 表示带客户端半）
├─ cordis.patch.yml    # 插入插件行，可带 config
├─ index.js            # Host 半（ESM，只用 node: 内置模块）
├─ client.js           # Client 半（仅带界面的插件）
├─ locale/{en,zh}.json # 插件管理里显示的名称与描述
├─ icon.svg
└─ README.md
```

---

## 各插件文档

- [dotnet-dashboard](dotnet-dashboard/README.md)：.NET SDK / NuGet / 项目建议面板与 `dotnet_status`。
- [everything](everything/README.md)：Everything 1.5 IPC 客户端、搜索语法、分页与限制。
- [gridcraft](gridcraft/README.md)：MCP 桥接原理、路径解析、端口与受控窗口行为。
- [pixpin-screen](pixpin-screen/README.md)：截图 / 标注 / 贴图，`desktop_action` 的步骤与限制。
- [skills-panel](skills-panel/README.md)：技能发现、`SKILL.md` 预览与开关的 frontmatter 契约。

---

## 已知限制与注意事项

这些不是待办，是当前实现的事实；用之前先读一遍：

1. **客户端半依赖未公开契约。** `window.__ModuleLoader__.load`、`ctx.client` 的侧边栏 / 布局
   注入、`ctx.connection.admit` 都是 DSH 内部行为，没有稳定性承诺；DSH 升级后最可能坏的就是
   这两个面板。
2. **everything 只读索引**，不修改文件；`content:` 和正则内容搜索会读磁盘，可能很慢；
   单次最多 1000 条，超过用 `offset` 分页；单次查询 60 秒超时；非法正则返回 0 条而不是报错。
3. **gridcraft 的受控窗口不要最小化**（控制命令要等 UI 渲染），已用普通方式打开的 GridCraft
   无法附加，会另起一个受控实例；一个端口只能服务一个受控实例。
4. **pixpin-screen 的 `region` 会等人**（默认 120 秒超时）；标注上限 40 个；截图落在系统临时目录；
   `desktop_action` 最多 50 步，需要已解锁的桌面。
5. **skills-panel 直接改技能文件**：开关会重写该技能 `SKILL.md` 的 frontmatter
   （`disable-model-invocation` / `user-invocable`），没有备份和独立状态，项目技能会出现在
   `git diff` 里；随包技能只读。
6. **dotnet-dashboard 的扫描有边界**：项目扫描深度 4、最多 4000 个目录项，快照缓存 60 秒，
   SDK 探测缓存 5 分钟；很大的仓库可能只看到部分项目。
7. **版本号不统一**：`everything` 是 0.2.0，其余是 1.0.0，按各自实际成熟度保留。
8. **没有自动化测试**：只有一个 manifest / 导出 / locale 的自检脚本（`npm run check`），
   行为验证靠上面的实测清单。

---

## 维护

```bash
npm run check   # 检查每个 bundle 的 manifest、exports、locale
```

- 插件是纯 ESM，没有构建步骤；改完在 DSH 的插件页重载（或重启）即可生效。
- 客户端半（`client.js`）由 DSH 的客户端插件加载器直接加载源码，同样不需要打包。
- 提交前：跑 `npm run check`，并在 0.2.2-rc.5 上过一遍「验证清单」。
- 版本策略：破坏性改动升 minor（`1.x`），仅修 bug 升 patch；DSH 大版本升级后，
  即使插件没改也建议重新跑验证清单并更新 [docs/compatibility.md](docs/compatibility.md)。

## License

[MIT](LICENSE)
