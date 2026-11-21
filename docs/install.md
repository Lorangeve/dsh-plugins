# 安装、更新与排错

本仓库的 7 个插件以 **本地 bundle** 的方式挂进 DSH profile，不走 npm 发布。推荐用桌面版的
插件管理界面安装；界面不可用时再手动 link。

## 0. 准备

```powershell
dsh --version            # 期望 0.2.2-rc.5
$env:USERPROFILE         # profile 根目录：%USERPROFILE%\.dsh\profiles\desktop
```

确认这些目录存在：

```powershell
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
```

## 1. 获取代码

```powershell
git clone https://github.com/Lorangeve/dsh-plugins.git D:\mycoding\plugins
```

目录本身就是「插件根」：`desktop-notify`、`dotnet-dashboard`、`dotnet-host`、`everything`、
`gridcraft`、`pixpin-screen`、`skills-panel` 各自是一个独立包。装哪个就 link 哪个，可以只装
一部分；`desktop-notify` 依赖 `dotnet-host`，两个要一起装。

## 2. 构建 .NET payload（只有 .NET 插件需要）

`dotnet-host` 和 `desktop-notify` 的 C# 产物不入库，先构建一次（需要 **.NET 10 SDK**）：

```powershell
npm run build:dotnet                              # 全部三个工程
npm run build:dotnet -- --project dotnet-host     # 只要 worker + 示例插件
npm run build:dotnet -- --project desktop-notify  # 只要通知插件
```

产物落在 `dotnet-host/bin/`（约 230 KB）和 `desktop-notify/dotnet-plugins/`（约 24 MB，主要是
WinRT 投影），两者都在 `.gitignore` 里。**构建前先停用 `@local/dotnet-host`**（或退出 DSH），
否则 worker 加载着的 DLL 被占用；脚本会给出提示。只跑 JS 插件的话可跳过这一步。

## 3. 安装到 desktop profile（推荐）

1. 打开 DSH 桌面版 →「设置 → 插件」。
2. 选择「从本地目录安装」，依次指向需要的插件目录，例如
   `D:\mycoding\plugins\gridcraft`。
3. 等待依赖同步完成，重启 DSH。
4. 回插件页确认 7 个 bundle 都是启用状态，且没有加载错误。

桌面 profile 由 Electron 应用独占管理，`dsh --profile desktop` 的 CLI 命令（包括
`--dump-config`）会被拒绝，这是预期行为。

## 4. 手动安装（备用）

适合非桌面 profile（如 `web`），或界面装不上时排查用。

### 4a. 其他 profile（CLI）

```powershell
dsh plugin --profile web add "file:D:/mycoding/plugins/everything"
```

该命令把参数原样转发给 profile 目录里的 pnpm。装完后确认
`%USERPROFILE%\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles` 里出现了
`@local/dsh-tool-everything`；如果 DSH 版本没有自动纳入，手动补一行。

### 4b. desktop profile（手动 link）

> 只在前一步的界面方式不可用时使用；操作前备份 profile 目录。

```powershell
$plugins = 'D:\mycoding\plugins'
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Directory -Force "$profile\node_modules\@local" | Out-Null

cmd /c mklink /J "$profile\node_modules\@local\gridcraft" "$plugins\gridcraft"
cmd /c mklink /J "$profile\node_modules\@local\pixpin-screen" "$plugins\pixpin-screen"
```

然后在 `$profile\package.json` 里同时改两处（以 gridcraft 为例）：

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

如果 profile 里有 `pnpm-lock.yaml`，把对应条目改成同样的 `link:` 值，避免下次启动被改回去。
保存后重启 DSH。

## 5. 装外部软件

| 插件 | 要装什么 | 建议 |
| --- | --- | --- |
| everything | Everything 1.5（x64） | 启动后保持运行；默认 `allow_ipc_pipe=1` 即可，不需要 HTTP/ETP 服务 |
| gridcraft | GridCraft 0.19.1 | 装默认路径；确认 `gridcraft-cli.exe` 与 `gridcraft.exe` 同目录 |
| pixpin-screen | PixPin 3.6.x | 装默认路径，或设置 `PIXPIN_PATH` |
| pixpin-screen（桌面操作） | AutoHotkey v2 | 装 v2，不要用 v1；或设置 `AUTOHOTKEY_PATH` |
| dotnet-dashboard | （可选）.NET SDK | 没有也能用；面板会给安装建议 |
| dotnet-host | **.NET 10 SDK**（构建 payload）+ **.NET 10 运行时**（运行 worker） | 缺 SDK 构建不了；缺运行时 `dotnet_host_status` 会报 worker 退出 |
| desktop-notify | 不需要额外软件 | 依赖 dotnet-host；在系统「通知和操作」里允许 DeepSeek Harness 通知 |

## 6. 配置

### 环境变量

桌面版从用户环境变量继承进程环境，**改完要完全退出并重开 DSH**（不是只关窗口）：

| 变量 | 用于 | 默认 |
| --- | --- | --- |
| `PIXPIN_PATH` | PixPin.exe | `%LOCALAPPDATA%\Programs\PixPin\PixPin.exe` 等候选 |
| `AUTOHOTKEY_PATH` | AutoHotkey64.exe | `%LOCALAPPDATA%\Programs\AutoHotkey\v2\AutoHotkey64.exe` 等候选 |
| `GRIDCRAFT_APP` / `GRIDCRAFT_CLI` | GridCraft 可执行文件 | `C:\Program Files\ArtCraft\GridCraft\` |
| `GRIDCRAFT_CONTROL_PORT` | 控制通道端口 | `7979` |
| `GRIDCRAFT_NODE` | 启动 bridge 的 Node | 当前 DSH 进程的可执行文件（Electron 以 `ELECTRON_RUN_AS_NODE=1` 运行） |
| `GRIDCRAFT_BRIDGE` | `bridge.mjs` 绝对路径 | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\@local\gridcraft\bridge.mjs` |

### YAML 配置

大部分插件的可调项写在各自 `cordis.patch.yml` 的 `config` 里（例如 Everything 的
`instance` / `pipe`、PixPin 的 `pixpinPath` / `captureTimeoutMs` / `desktopAction`）。
改完重启 DSH。每个插件 README 的「配置」一节都列了完整字段。

## 7. 验证

按 README 的[验证清单](../README.md#验证清单)逐项确认。最快的几条：

```
npm run doctor
dotnet_status()
dotnet_host_status()
everything_help()
mcp__gridcraft__list_windows()
```

`npm run doctor` 会依次检查 .NET SDK、运行时、三份 payload、worker 握手和 profile 挂载；
全部 ✓ 之后再点一遍 GUI。

## 8. 更新与卸载

**更新**：`git pull` → 重启 DSH。插件是 link 进去的，不需要重新安装。
如果这次拉到 .NET 源码改动，先停用 `@local/dotnet-host` → `npm run build:dotnet` → 重启，
否则 worker 还是旧的 DLL。JS 侧不需要构建。

**卸载**：在「设置 → 插件」里禁用或移除对应 bundle；或删除 profile `node_modules\@local\<name>`
junction，并从 `package.json` 的 `dependencies` / `dsh.profile.bundles` 里去掉那一行。
插件目录本身可以保留，随时再装回来。

## 9. 排错

| 现象 | 先查什么 |
| --- | --- |
| 插件页看不到 bundle / 提示 skipped | `package.json` 的 `dsh.bundle.patch` 路径是否存在；依赖是否真的 link 进了 `node_modules\@local\<name>`；重启 |
| 面板空白 / 401 / 「无法通过浏览器认证」 | 刷新页面；确认 DSH 版本没变；看 Host 日志里 `connection.admit` 是否拒绝 |
| `everything_help` 返回 `connected: false` | Everything 是否在运行、是否 1.5、是否禁用了 IPC 管道；或显式配置 `pipe` |
| `mcp__gridcraft__*` 全部消失 | GridCraft 未启动 / 端口被占 / `GRIDCRAFT_BRIDGE` 指错；插件页里该 bundle 是否报 `failOnStartupError` |
| GridCraft 命令超时 | 受控窗口是否被最小化；是否同时开了两个实例 |
| `pixpin_screenshot` 报找不到 PixPin | `PIXPIN_PATH`；默认安装目录是否被改 |
| `desktop_action` 报找不到 AutoHotkey | 装 v2 并设置 `AUTOHOTKEY_PATH`；v1 不兼容 |
| 截图是黑的 / 区域截图没人响应 | 会话是否锁屏、是否 RDP 断开、是否有 UAC 安全桌面 |
| `dotnet_status` 显示未安装 | `dotnet --version` 是否可用；`DOTNET_ROOT`；装完 SDK 后重启 DSH |
| 「技能」页为空 | 技能目录是否存在：`<项目>/.dsh/skills`、`~/.dsh/skills`、`~/.agents/skills` |
| `dotnet_host_status` 显示 worker 未运行 / 反复重启 | 先跑 `npm run doctor`：payload 是否构建过、.NET 10 运行时是否在；`bin/DshDotnet.Host.exe` 是否还在；杀毒软件是否把 worker 丢进受限令牌（见 dotnet-host README） |
| `npm run build:dotnet` 报文件被占用 | worker 正在跑：插件页停用 `@local/dotnet-host`（或退出 DSH）再构建 |
| 插件日志说 worker / 通知程序集缺失 | 没构建：仓库根目录跑 `npm run build:dotnet`（需要 .NET 10 SDK） |
| 收不到桌面通知 | `npm run doctor` 看 `desktop-notify/dotnet-plugins` 是否齐全；系统通知是否允许；`%TEMP%\DeepSeekHarness\desktop-notify.log`；`GET /dsh-notify/status` 的 `subscribers` |
| 点通知没反应 / 打开了新标签页 | 界面没连上 Typert Remote 流时会走浏览器兜底，属预期；`subscribers: 0` 说明页面那条流没建起来 |

仍然不行时，抓三样东西：`dsh --version`、插件页的加载错误、Host 日志里对应 bundle 的报错。
