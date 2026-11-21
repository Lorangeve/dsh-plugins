# 桌面通知 (Desktop notifications)

会话完成、需要确认、需要回答或出错时，弹出一条 Windows 系统通知；点击通知会切换回发起通知的那个会话。

## 它做什么

| 触发时机 | 通知标题 | 点击后 |
| --- | --- | --- |
| 一轮任务结束（`agent/status` 从 `running` 变为 `idle`，且持续时间超过阈值） | 会话标题，或「会话已完成」 | 打开该会话 |
| 工具请求审批（`approval/request`） | 会话标题，或「需要你确认」 | 打开该会话 |
| 助手向你提问（`user-questions/request`） | 会话标题，或「需要你回答」 | 打开该会话 |
| 会话报错（`agent/error`） | 会话标题，或「任务出错」 | 打开该会话 |

同一个会话的同类提醒在 8 秒内只弹一次。完成类用普通弹窗，需要处理的通知用 `reminder` 场景（停留到处理为止），都带声音和「打开会话」按钮。

## 全链路都在 .NET 里

没有任何 PowerShell：发送、注册、点击处理都在 `@local/dotnet-host` 的 worker 里。

```
事件 → desktop-notify(JS) → dotnetHost.call('desktop_toast')
                                 ↓
                     DshDotnet.Notify.dll（worker 内）
                     写 AUMID / 快捷方式 / dshnotify: 协议，再 CreateToastNotifier
                                 ↓ 用户点击
                     DshDotnet.Host.exe --open "dshnotify:open?…"
                     → GET /dsh-notify/open → Typert Remote 流切会话 / 浏览器兜底
```

发送单次 ~0.2 ms（一次 stdio 往返），不再有每次 250 ms 的进程启动。

## 点击是怎么回到会话的

1. 通知里带 `dshnotify:open?o=<回调地址>&u=<GUI 地址>&s=<会话>&t=<令牌>`。
2. 点击时 Windows 用协议启动 `DshDotnet.Host.exe --open "<uri>"`。
3. 它用会话 ID 和本次进程的随机令牌回问 Harness：`GET /dsh-notify/open`。
4. 界面开着：Harness 把会话 ID 交给 `desktopNotify/events` 这条 **Typert Remote 流**，页面用自己已有的连接收到后调用 `uiWorkspace.openSession`，所以是**本窗口原地切换**，不新开浏览器；同时窗口被置前。
5. 界面没开：Harness 回 `delivered:false`，它用默认浏览器打开带认证 token 的 GUI 地址 `?session=…`；页面加载后由 `client.js` 打开会话并清掉地址栏参数。

### 界面是怎么收到推送的

Host 侧是一个普通 Cordis 服务：`ctx.provide('desktopNotify', …)`，带 `typertRemote = { namespace: 'desktopNotify' }` 绑定和方法上的 Remote marker，API Gateway 的 source-mode 发现就能把它当 `desktopNotify/events`（stream 模式）调用，不需要生成器产物。客户端用一条手写的调用描述 `ctx.remote.$mount({ package, descriptors })` 挂上同名端点，然后 `for await` 这个流。

这条流跑在页面本来就有的连接上（WebSocket mux），所以不依赖 `dsh://app/` 下的相对 fetch，也不受 SSE 限制。流断了会每 2 秒重开；`GET /dsh-notify/status` 里的 `subscribers` 就是当前在听的界面数（0 表示点击会走浏览器兜底）。

令牌每次 Harness 启动都会换，旧通知里的令牌失效后点击会走浏览器兜底，仍然能到正确的会话。

## 配置

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `notifyOnComplete` | `true` | 任务结束时通知 |
| `notifyOnAttention` | `true` | 审批、提问时通知 |
| `notifyOnError` | `true` | 出错时通知 |
| `minTaskSeconds` | `5` | 短于这个秒数的任务不通知 |
| `selfTestOnStart` | `false` | 激活 1.2 秒后弹一条自检通知 |
| `dotnetPluginsDir` | 空 | 覆盖 `dotnet-plugins/` 目录 |

依赖 `@local/dotnet-host`；它不在或未启用时，本插件只记一条警告，不弹通知。

## 依赖与体积

- `dotnet-plugins/` 是构建产物（不入库），用 `npm run build:dotnet -- --project desktop-notify`
  生成，需要 .NET 10 SDK；里面 24 MB 的 WinRT 投影（`Microsoft.Windows.SDK.NET.dll`）是 .NET 发
  toast 的必需依赖。`npm run doctor` 会检查这一份 payload 和 worker 是否就绪。
- 通知依赖系统「通知和操作」允许应用通知；完全收不到时看 `%TEMP%\DeepSeekHarness\desktop-notify.log`（注册/点击都会记一行）。
- 如果 worker 所在目录被执行策略限制（见 dotnet-host 的 README），注册会失败，日志里会是 `UnauthorizedAccessException`；dotnet-host 默认会把 worker 镜像到 `%LOCALAPPDATA%` 来避开这种限制。
