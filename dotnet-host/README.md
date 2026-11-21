# .NET 插件接入 (dotnet-host)

用一个**常驻** .NET worker 进程承载 .NET 插件：worker 里 `[DshTool]` 标注的方法自动变成 DSH 工具。热调用是一次 stdio 往返，不用每次调用都启动进程。

## 为什么是进程外常驻

| 方案 | 单次调用成本 | 风险 |
| --- | --- | --- |
| 每次起一个 exe | ~120–250 ms（进程启动） | 无 |
| **常驻 worker（本插件）** | **实测 p50 0.14 ms / p99 0.85 ms** | 插件崩溃只死 worker，自动重启 |
| 进程内 CLR（native addon） | ~20 µs | .NET 崩溃 = 整个 DSH 崩，ABI/asar 打包复杂 |

省下的那 0.1 ms 对“跑一段 .NET 逻辑”没有意义，所以选进程外。

## 结构

```
index.js                     JS 桥：拉起 worker、注册工具、转发事件、心跳与崩溃重启、dotnetHost 服务
bin/DshDotnet.Host.exe       worker：读 stdin 帧、AssemblyLoadContext 加载插件、反射调用
bin/plugins/*.dll            .NET 插件（可被其它插件目录追加）
src/                         三份源码：Abstractions / Host / Example.Plugin
bench/bench.mjs              冷启动、热调用、取消与进度基准
```

### worker 默认从 `%LOCALAPPDATA%` 启动

默认不在 `bin/` 原地启动，而是把这几个文件镜像到
`%LOCALAPPDATA%\DeepSeekHarness\dotnet-host\` 再启动：

```
DshDotnet.Host.exe / .dll / .deps.json / .runtimeconfig.json / DshDotnet.Abstractions.dll
```

原因是在某些端点安全策略下，**从非系统盘上的开发目录启动的进程会被套受限令牌**（实测同一份 exe：放 `D:\` 下写 `HKCU`/`%TEMP%` 全部 `拒绝访问`，复制到 `%LOCALAPPDATA%` 就一切正常）。受限令牌会让 toast 注册和 WinRT 调用静默失败，而且和 exe 签名无关。镜像只复制这 5 个文件（约 180 KB），插件程序集仍在原目录只读加载。

想改位置用 `workerDirectory`；显式设置 `hostPath` 会关闭镜像、直接用该路径。

协议是**一行一个 JSON**（NDJSON，protocol 2）：

```
worker → host  {"type":"hello","protocol":2,...}
host → worker  {"type":"init","pluginsDirs":["...","..."]}
worker → host  {"type":"ready","tools":[...]}
host → worker  {"type":"call","id":12,"tool":"name","args":{...}}
host → worker  {"type":"cancel","id":12}
worker → host  {"type":"result","id":12,"ok":true,"value":...}
worker → host  {"type":"progress","id":12,"message":"step 3/15","percent":20}
host → worker  {"type":"event","name":"agent/status","data":{...}}
worker → host  {"type":"log","level":"info","message":"..."}
host → worker  {"type":"ping"}  →  {"type":"pong"}
host → worker  {"type":"shutdown"}
```

- 调用在**读循环之外**执行，所以调用进行中也能收到 `cancel`。
- 心跳每 20 s 一次；45 s 没有 `pong` 就重启。
- 插件里 `Console.WriteLine` 会被吞掉（stdout 只走帧），日志用返回值、`DshCall.Progress` 或 `IDshEvents`。

## 写一个 .NET 插件

```csharp
using DshDotnet;

public sealed class MyPlugin : IDshPlugin          // 可选再实现 IDshEvents 收 Harness 事件
{
    public string Name => "my-plugin";

    [DshTool("disk_free", "返回 C 盘剩余空间（GB）")]
    public object Free() => new { freeGb = DriveInfo.GetDrives()[0].AvailableFreeSpace / 1e9 };

    [DshTool("slow_scan", "扫描目录并报告进度；可被取消")]
    public async Task<object> SlowScan(string path, CancellationToken cancel)
    {
        for (var i = 1; i <= 10; i++)
        {
            cancel.ThrowIfCancellationRequested();
            await Task.Delay(200, cancel);
            DshCall.Progress($"scanning {i}/10", i * 10);
        }
        return new { done = true, path };
    }
}
```

- 参数支持 `string/bool/整型/浮点/DateTime/Guid/枚举/数组`，Schema 自动生成；`CancellationToken` 参数不会出现在 Schema 里，由桥注入。
- 返回任意可序列化对象；桥包成 `{ ok: true, value: ... }` 并渲染成缩进 JSON。
- `[DshTool(..., Hidden = true)]`：可被 `dotnetHost.call()` 调用，但**不出现在模型工具列表**里——给别的插件做基础设施时用。

编译后丢进 `bin/plugins/`，重载插件即可，**不用重启 DSH**。

## 给别的插件用：`dotnetHost` 服务

```js
ctx.inject(['dotnetHost'], (scoped) => {
  const release = scoped.dotnetHost.registerPluginDir('D:/my/plugin/dotnet-plugins')
  // 之后即可 scoped.dotnetHost.call('my_hidden_tool', { ... })
  return () => release()
})
```

- `registerPluginDir(dir)`：追加插件目录，worker 会自动重启并加载；返回的 disposer 撤销该目录。
- `call(tool, args, signal)`：直接调用（含隐藏工具），`signal` 取消会转成 `cancel` 帧。
- `status()`：`{ running, pid, runtime, tools, pluginsDirs }`。

worker 是**进程级单例**：插件重载时新实例会先回收旧 worker，不会留下孤儿进程。

## 内置状态与诊断工具

- `dotnet_host_status`：pid、运行时、工具数、调用/失败/重启计数、最后错误、插件目录。
- `dotnet_env_probe`：报告 worker 进程的用户、组数、受限 SID 数，并实测能否写 `%TEMP%`、`HKCU\Software`、`HKCU\Software\Classes`、开始菜单——遇到「工具能跑但写不了东西」时先看它。

## 构建

payload 不入库（`bin/` 在 `.gitignore` 里），克隆后先构建一次：

```powershell
npm run build:dotnet -- --project dotnet-host --project example-plugin
```

底层就是两次 `dotnet publish`（在仓库根目录执行）：

```powershell
dotnet publish src/DshDotnet.Host  -c Release -o bin
dotnet publish src/Example.Plugin  -c Release -o bin/plugins
```

需要 **.NET 10 SDK**；框架依赖发布（约 230 KB + 运行时），运行 worker 只要 .NET 10 运行时。
要免依赖就加 `--self-contained -p:PublishSingleFile=true`（约 60–70 MB）。**构建前先停掉 worker**
（或在插件页停用 `@local/dotnet-host`），否则 DLL 被占用；`npm run doctor` 会报告 worker 是否
在跑、payload 是否比源码旧。

## 基准

```powershell
ELECTRON_RUN_AS_NODE=1 "$env:DSH_NODE_EXECUTABLE" bench/bench.mjs 200
```

本机结果（.NET 10.0.14，6 核）：

```
cold start (spawn -> ready): 185 ms
tools: hello_dotnet, dotnet_sysinfo, dotnet_read_registry, dotnet_slow_work
warm calls: 150
  p50 0.14 ms   p95 0.25 ms   p99 0.85 ms   mean 0.19 ms
cancel test: progress="step 1/15" (7%) -> {"ok":false,"error":"cancelled"}
```

## 配置

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不拉起 worker |
| `hostPath` | `bin/DshDotnet.Host.exe` | 覆盖 worker 源路径；设置后不再镜像 |
| `workerDirectory` | `%LOCALAPPDATA%\DeepSeekHarness\dotnet-host` | 镜像目标目录 |
| `pluginsDir` | `bin/plugins` | 覆盖插件目录（其它目录由服务追加） |
| `requestTimeoutMs` | `30000` | 单次调用超时；超时会发 `cancel` 帧 |
| `forwardEvents` | `agent/status`、`agent/error` | 转发给 worker 的事件名（仅 emit 类） |

## 已知边界

- 事件转发**只做 emit 类**；waterfall（审批、`tools/pre-execute`）暂时不暴露，避免把顺序语义做错。
- 不传 Scoped 上下文（`Agent`/`Session`），只传 `sessionId` 这类扁平数据。
- 同步方法无法被中断（只有返回 `Task` 或接收 `CancellationToken` 的方法能响应取消）。
- 企业安全软件若拦截未签名 exe，worker 会被套受限令牌：读文件/注册表正常，写受保护位置或调 WinRT 会失败（桌面通知因此才有 PowerShell 兜底）。
