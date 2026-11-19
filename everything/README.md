# Everything file search

Everything 1.5 文件搜索工具：把本机 Everything 索引接入 DeepSeek Harness。注册 `everything_search`
（毫秒级搜索，使用 Everything 自己的完整查询语法）与 `everything_help`（语法速查 + 当前连接状态）。

## 已验证版本

- DSH 桌面版 **0.2.2-rc.5**（Windows 10 22H2 x64）。
- Everything **1.5.0.1409（x64）**；管道 `\\.\pipe\Everything IPC (1.5a)`。
- 升级前后的回归清单见 [docs/compatibility.md](../docs/compatibility.md)。

## 能力

Everything 为已索引的 NTFS 卷和文件夹索引维护全部文件名数据库。插件直接通过 Everything 的 IPC 命名管道
（`\\.\pipe\Everything IPC [(<实例名>)]`）查询该数据库：一次小的二进制往返，不启动子进程、不遍历目录、
不读取文件元数据。常见查询在数毫秒到数十毫秒内完成，包含 Host 进程内的解析时间。

## 工具

### `everything_search`

| 参数 | 含义 |
|---|---|
| `query` | Everything 搜索语法；留空匹配全部索引项。 |
| `limit` | 每次返回结果数，1–1000，默认 30。 |
| `offset` | 跳过的结果数，用于分页，默认 0。 |
| `sort` | `name`、`path`、`size`、`extension`、`date_modified`、`date_created`。 |
| `descending` | 排序方向，仅在给出 `sort` 时生效。 |
| `match_path` | 把整个查询用于匹配完整路径而不是文件名。 |
| `regex` | 把整个查询当作一个 PCRE 正则，关闭其余语法。 |
| `count_only` | 只返回匹配数量，不返回路径。 |

每条结果给出完整路径、文件名、字节大小、修改时间以及是否为文件夹；回复同时带总数，因此
`count_only` 可以在不传输路径的情况下回答“有多少个”。

### `everything_help`

返回语法速查（运算符、通配符、修饰符、函数、示例）以及可连通的管道与 Everything 版本，
这样写复杂查询时不必靠猜。

## 查询语法速览

- 空格为 AND，`|` 为 OR，`!` 为 NOT，`<>` 分组，`"..."` 为字面文本。
- `*`、`?` 为通配符，匹配整个文件名；`**` 可跨越反斜杠。
- 任意位置的反斜杠匹配完整路径：`\downloads`、`!\appdata`；结尾反斜杠表示必须是文件夹：
  `C:\windows\media\`。
- 常用过滤：`ext:ps1;js`、`size:>10mb`、`dm:thisweek`、`dc:`、`da:`、`attrib:rash`、`path:`、
  `folder:`、`file:`、`parent:C:\src`、`child:*.mp3`、`empty:`、`dupe:size;name`、`content:todo`。
- 修饰符：`case:`、`whole-words:`、`whole:`、`prefix:`、`suffix:`、`regex:`、`ignore-punctuation:`。
- 宏：`audio:`、`video:`、`doc:`、`image:`、`exe:`、`zip:`。

示例：

```
ext:ps1 size:>10kb !\node_modules\
dm:thisweek ext:log C:\Users\
folder: parent:C:\src
dupe:size;name
*.docx content:invoice \downloads
```

## 运行要求

- Windows，且已安装并运行 Everything 1.5（alpha 或 beta）。1.5 提供 IPC 命名管道；1.4 只有旧的
  窗口消息协议，不支持。
- 管道需能被 DeepSeek Harness 的 Host 进程访问。Everything 默认的 `allow_ipc_pipe=1` 即可，
  无需 HTTP Server、ETP Server 或 `es.exe`。

## 配置（仅 YAML）

在 `cordis.patch.yml` 的挂载行里可选的 `config`：

| 字段 | 含义 |
|---|---|
| `instance` | Everything 实例名，例如 `1.5a`；优先使用它。 |
| `pipe` | 显式管道路径，例如 `\\.\pipe\Everything IPC (1.5a)`；给出后只连该管道，不再回退。 |

两者都不给时，插件枚举可用的 `Everything IPC` 管道并连接第一个能应答的。

```yaml
- id: tool-everything
  name: '@local/dsh-tool-everything'
  config:
    instance: '1.5a'
```

当前未声明 Config schema，因此上面两个字段只在此处记录，插件管理页面不会校验它们。

## 限制

- `content:` 以及针对文件内容的正则搜索会读取磁盘上的文件；Everything 自己也说明它们可能很慢。
  请与 `ext:`、路径或日期条件组合，并保持结果有界。
- 单次调用最多返回 1000 条路径；更多请用 `offset` 分页，或改用 `count_only` 只要数量。
- 插件只读索引，不会修改、移动或删除任何文件。
- 单次查询超过 60 秒会以超时错误返回，不会阻塞 Agent。
- 非法正则不会报错，Everything 会返回 0 条匹配。

## 安装

该包是 bundle（`dsh.bundle.patch` 插入一条 Host 行）。在 DeepSeek Harness 中从本地目录安装即可；
无依赖、无构建步骤，插件是纯 ESM，只使用 `node:net` 与 `node:fs`。

## 实现说明

| 文件 | 作用 |
|---|---|
| `index.js` | 工具定义、描述、渲染、配置归一化。 |
| `ipc.js` | Everything 1.5 IPC 客户端：管道发现、请求分帧、VLQ 与 `SIZE_T` 解码、断线重连。 |

### 线路协议

Everything 1.5 在 `\\.\pipe\Everything IPC [Session <session-id>] [(<instance>)]` 上提供查询；
1.5a alpha 使用 `1.5a` 实例，因此管道名为 `\\.\pipe\Everything IPC (1.5a)`。

- 请求：`{ u32 code, u32 size }` 后接 `size` 字节负载。
- 响应：`{ u32 code, u32 size, bytes data }` 组成的链；`100` 表示“还有后续数据”，`200` 结束，
  其它值为错误码。
- 搜索负载：`u32 flags`、`VLQ 查询长度`、UTF-8 查询、`u64 offset`、`u64 count`、
  `VLQ 排序数` + `(u32 propertyId, u32 flags)[]`、`VLQ 属性数` + `(u32 propertyId, u32 flags)[]`。
- 结果负载：`u32 validFlags`、`SIZE_T 文件夹数`、`SIZE_T 文件数`、可选总大小、`SIZE_T 视口起点`、
  `SIZE_T 视口条数`、排序数组、属性请求描述 `(u32 id, u32 flags, u8 valueType)`，随后每条结果以
  `u8 itemFlags` 开头，按请求顺序给出各属性值。
- 当 `0x4000`（`64BIT`）标志置位时 `SIZE_T` 为 8 字节，否则 4 字节。使用的属性 id：名称 `0`、
  路径 `1`、大小 `2`、修改时间 `5`、完整路径 `240`。

每次查询固定请求 `name`、`full path`、`size`、`date modified` 四个属性；所有调用共用一个串行化连接，
管道断开后下次调用会自动重连。

## 验证

```powershell
node -e "import('file:///C:/path/to/everything-plugin/index.js').then(m => console.log(Object.keys(m)))"
```

随后调用 `everything_help`（报告管道与版本）与 `everything_search`（例如 `ext:ps1 size:>10kb`）。
