# PixPin 截图与桌面操作（@local/pixpin-screen）

一个 DSH 插件：让助手用 **PixPin** 截图、标注、贴图，并通过 **AutoHotkey v2** 编排真实的鼠标键盘操作。
注册两个工具：`pixpin_screenshot` 和 `desktop_action`。

## 已验证版本

- DSH 桌面版 **0.2.2-rc.5**（Windows 10 22H2 x64）
- PixPin **3.6.6.0**
- AutoHotkey **2.0.31**（仅 `desktop_action` 需要）
- Windows PowerShell 5.1（系统自带即可，不要求 `pwsh`）

## 工具

### `pixpin_screenshot`

| 参数 | 含义 |
| --- | --- |
| `target` | `all-screens`（默认）、`screen-under-mouse`、`active-window`、`last-region`、`region` |
| `annotations` | 标注列表，坐标是图片的百分比（0-100）；最多 40 个 |
| `pin` | 把截图贴在桌面上；默认「有标注就贴」 |
| `grid` | 叠加 10% 坐标网格，便于规划 `desktop_action` 的坐标 |

标注类型：`rect`、`ellipse`、`highlight`（需要 x/y/width/height）、`line`、`arrow`
（x1/y1/x2/y2）、`marker`（x/y + label）、`text`（x/y + text）。都接受 `color`
（颜色名或 `#RRGGBB`）、`stroke_width`、`font_size`。

返回：`source`、`capturedAt`、`annotations` 数量、`grid`、`pinned`、`pinWarning`，
以及 `image`（attachmentId、宽高、字节数）。图片会作为附件进入对话。

`region` 会弹出 PixPin 的选区界面等用户拖拽，超时默认 120 秒；其余目标是即时截图。

### `desktop_action`

按顺序执行一组真实输入动作，默认在执行后截一张图：

| 动作 | 字段 |
| --- | --- |
| `click` | `x`、`y`（虚拟屏幕百分比）、`button`（left/right/middle）、`count`（1/2） |
| `move` | `x`、`y` |
| `drag` | `x1`、`y1`、`x2`、`y2`、`duration_ms`（默认 400） |
| `type` | `text`、`enter`（是否回车） |
| `key` | `keys`：`ctrl+s`、`enter`、`alt+f4`，或原生 AutoHotkey 写法 `^s` |
| `wheel` | `delta`（正数向上）、可选 `x`/`y` |
| `activate` | `title`（窗口标题子串） |
| `wait` | `ms` |

顶层参数：

- `dry_run: true`：只生成并返回 AutoHotkey 脚本，不执行、不截图。
- `preview: true`：不执行，截图并叠加坐标网格 + 每个坐标步骤的编号标记，返回计划图。
- `pin`：把计划图或执行后的截图贴到桌面。
- `capture_after`：执行后是否截图（默认 true）。

返回：`stepCount`、`executed`、`ok`、`log`、`error`、`script`（dry run）、`plan`（preview）、
以及可选的 `image`。最多 50 步；单次调用超时 180 秒。

## 工作方式

- **截图**：插件把一段 PixPin 脚本（`pixpin.directScreenShotAndSaveTo(...)` 等）写到临时文件，
  用 `PixPin.exe -f <script>` 触发；同时启动一个 PowerShell 剪贴板助手轮询 PNG，落盘后读回字节，
  存进 DSH 的附件库。
- **贴图**：脚本调用 `pixpin.pinFromFiles([...])`，图片保留在 `%TEMP%\dsh-pixpin-pins`，
  超过 3 天的会被清理。
- **桌面操作**：把步骤编译成一个 AutoHotkey v2 脚本，用 `AutoHotkey64.exe` 执行并读日志。

## 配置

在 `cordis.patch.yml` 的挂载行里加 `config`（改完重启 DSH）：

```yaml
- insert:
    - id: pixpin-screen
      name: '@local/pixpin-screen'
      config:
        pixpinPath: 'C:\Users\me\AppData\Local\Programs\PixPin\PixPin.exe'
        powershellPath: 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
        autohotkeyPath: 'C:\Users\me\AppData\Local\Programs\AutoHotkey\v2\AutoHotkey64.exe'
        captureTimeoutMs: 30000
        regionTimeoutMs: 120000
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `pixpinPath` | 自动探测 | 环境变量 `PIXPIN_PATH` 优先 |
| `powershellPath` | 系统 PowerShell | 必须是 5.1 兼容的 Windows PowerShell |
| `autohotkeyPath` | 自动探测 v2 | 环境变量 `AUTOHOTKEY_PATH` 优先 |
| `captureTimeoutMs` | 30000 | 即时截图超时 |
| `regionTimeoutMs` | 120000 | 区域截图等待用户的时间 |

目前没有声明的 Config schema，字段不会在插件管理页里校验。

## 前置条件

- Windows 10/11 x64，且是**已解锁的交互式会话**（锁屏、RDP 断开、UAC 安全桌面下截图会失败）。
- PixPin 3.6.x 已安装并能接受脚本调用（插件会以 `-f <script>` 启动它）。
- 只有 `desktop_action` 需要 AutoHotkey **v2**；v1 语法不兼容。
- DSH 的附件服务已挂载（桌面版默认有）；没有附件时工具会直接报错而不是吞掉截图。

## 限制

- `region` 会等用户操作，超时或取消都会返回错误。
- 标注上限 40 个；坐标越界会被夹到 0-100。
- 截图与标注会作为附件进入会话上下文，注意隐私；不要对包含敏感信息的屏幕随手截图。
- `desktop_action` 是**真实输入注入**：会移动鼠标、键入文本、点按钮。除非用户明确要求操作 GUI，
  否则不要调用；先用 `preview` 给用户确认坐标。
- 受 UAC 保护的应用、以管理员身份运行的窗口不接受普通权限的输入注入。
- 输入语言 / 键盘布局会影响 `type` 的结果（AutoHotkey 发送的是按键序列）。
- `active-window` 取当前前台窗口；没有窗口拿到焦点时（例如刚点过任务栏）截到的就是任务栏。

## 文件

```
index.js            Host 半：两个工具、PixPin 脚本生成、PowerShell 助手、AutoHotkey 脚本编译
cordis.patch.yml    插入 id 为 pixpin-screen 的 Loader 行
package.json        清单：dsh.bundle.patch + 本地化/图标导出
locale/{en,zh}.json 插件管理里显示的名称与描述
icon.svg            插件图标
```

## 停用

在「设置 → 插件」里关闭 **PixPin 截图与桌面操作**，两个工具会一并消失；已经贴在桌面上的图片
和临时目录不会自动清理。
