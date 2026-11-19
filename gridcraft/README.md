# GridCraft 桥接（@local/gridcraft）

一个 DSH 插件：把本机运行的 **GridCraft** 表格应用接到 Harness 上，让智能体像调用原生工具一样驱动它
（读写单元格、改格式、插图表、截图……）。注册 20 个 `mcp__gridcraft__*` 工具。

## 已验证版本

- DSH 桌面版 **0.2.2-rc.5**（Windows 10 22H2 x64）
- GridCraft **0.19.1**（`gridcraft-cli 0.19.1`）
- 验证方式：MCP `initialize` 握手成功、`list_windows` 返回窗口、`read_range` 读到单元格

## 它是怎么工作的

GridCraft 桌面版可以用 `--control <端口>` 启动一个 JSON-lines 控制通道；`gridcraft-cli mcp --connect <端口>`
把这个通道翻译成 MCP 服务。本插件做三件事：

1. 用 `@deepseek-ai/dsh-mcp-client` 把上面这个 stdio MCP 服务注册成 Harness 的工具；
2. `bridge.mjs` 在交给 MCP 之前先探测 `127.0.0.1:7979`：没有通道时用 `--control 7979` 启动 GridCraft，
   等到通道就绪再原样转发 stdin/stdout（不转码、不丢字节）；
3. 断线后由 mcp-client 自动重连。

工具名形如 `mcp__gridcraft__read_range`、`write_range`、`execute_command`、`screenshot`，共 20 个。

## 路径是怎么解析的

`cordis.patch.yml` 在加载时用 Loader 的 `!!js` 表达式解析两个路径，所以插件放在哪个目录都能跑，
不需要改文件：

| 配置 | 默认值 | 覆盖方式 |
| --- | --- | --- |
| `command`（Node 运行时） | 当前 DSH 进程的可执行文件 | `GRIDCRAFT_NODE` |
| `args[0]`（bridge.mjs） | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\@local\gridcraft\bridge.mjs` | `GRIDCRAFT_BRIDGE` |
| 控制端口 | `7979` | `GRIDCRAFT_CONTROL_PORT`（要同时改 `bridge.mjs` 的探测端口与 CLI 的 `--connect`） |

桌面版的 `process.execPath` 是 Electron 本体，插件通过 `ELECTRON_RUN_AS_NODE=1` 让它以 Node 模式运行
（实测 Node 24.21.0）。如果 DSH_HOME 不在默认位置、或 profile 不叫 `desktop`，设置
`GRIDCRAFT_BRIDGE` 指向实际的 `bridge.mjs`。

## 要求

- Windows + GridCraft 桌面版 0.19.x（默认装在 `C:\Program Files\ArtCraft\GridCraft\`），
  可用 `GRIDCRAFT_APP` / `GRIDCRAFT_CLI` 覆盖 `gridcraft.exe` / `gridcraft-cli.exe` 的位置；
- 端口 7979（或 `GRIDCRAFT_CONTROL_PORT`）默认只监听 `127.0.0.1`，令牌写在
  `%USERPROFILE%\.gridcraft\control-<端口>.token`，`gridcraft-cli` 会自动读取；
- 不需要额外安装 Node：运行 bridge 的是 DSH 自己的运行时。

## 行为与限制

- 通道不存在时会**自动启动**一个带控制通道的 GridCraft 窗口（空白工作簿）。
- 如果 GridCraft 已经以普通方式（不带 `--control`）打开，插件无法附加到那个窗口，会再启动一个受控实例；
  此时建议关掉旧窗口，以免同一文件被两个实例同时保存。
- 受控窗口**不要最小化**：控制命令要等 UI 渲染，最小化会超时。
- 一个端口只服务一个受控实例；换端口要同步改插件配置，否则会连到旧实例。
- `failOnStartupError: true`：GridCraft 起不来时这个 bundle 会加载失败（其他插件不受影响），
  修复后重载插件即可。

## 文件

```
package.json        清单：dsh.bundle.patch + 本地化/图标导出
cordis.patch.yml    插入 @deepseek-ai/dsh-mcp-client 行（gridcraft-mcp），含路径解析
bridge.mjs          确保控制通道存在，再把 stdio 原样移交给 gridcraft-cli mcp
locale/{en,zh}.json 插件管理里显示的名称与描述
icon.svg            插件图标
```

## 停用

在「设置 → 插件」里关闭 **GridCraft 桥接**，或从插件管理中移除；工具与启动行为一并消失
（已打开的 GridCraft 窗口不会被关闭）。
