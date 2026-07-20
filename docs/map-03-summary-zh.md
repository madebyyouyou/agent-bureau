# Map 03 中文技术审计摘要：WebSocket 协议层

> 原始证据：[Integration Map 03](./map-03-handlers-js-websocket-protocol-layer-plu.md)

## 这份审计解决什么问题

说明自定义前端必须实现怎样的消息契约，才能完整接管 CliDeck 的会话、状态、配置、插件和终端捕获，而不只是显示几条聊天气泡。

## 一句话结论

CliDeck 的 WebSocket 是一条以 `type` 区分消息的双向控制总线；浏览器还承担终端画面回传，因此它是协议参与者，不是被动 UI。

## 系统角色与核心概念

WebSocket 是浏览器与服务端之间保持长连接、双方可主动推送消息的通信协议。所有负载都是带 `type` 字段的 JSON；`handlers.js` 用大型 switch 处理客户端命令，服务端广播会话、配置、转录和插件状态给全部连接。

## 关键执行链路

1. 浏览器连接同端口 WebSocket，无需额外握手。
2. 服务端依次推送 `config`、`themes`、`presets`、`sessions`、`sessions.resumable`、`transcript.cache`、`plugins`、`pills` 八类快照。
3. 客户端按 `type` 写入本地状态，再应用 `created`、`closed`、`session.status` 等增量消息。
4. 用户操作以 `create`、`input`、`config.update` 或 `plugin.*` 等消息返回服务端。
5. `handlers.js` 调用会话、配置、转录或插件模块执行，并把结果广播。
6. 服务端发送 `terminal.capture` 时，客户端读取已渲染终端行并回传 `terminal.buffer`；服务端据此检测菜单、确认 idle 和提交转录。

## 重要设计取舍

单连接承载全部控制面，省去 REST 拉取和多套一致性逻辑；代价是协议宽、消息错误缺少统一 request ID，客户端必须自己维护连接时快照与连接后增量。全局广播让多个界面自然同步，但也会让多个客户端同时应答捕获或竞争写配置。

## 审计发现的风险或缺口

- **已证实：** `terminal.capture`/`terminal.buffer` 是隐式但关键的往返；忽略它会同时削弱菜单、状态和转录。
- **已证实：** `config.update` 是顶层浅合并且没有乐观锁，多客户端并发写入会 last-write-wins。
- **结构性局限：** 通用 `error` 没有请求关联 ID；状态还依赖各 CLI 的 hook/遥测质量。

## Agent Bureau 最终采用的方案

Agent Bureau 的自定义界面直接连接同源 WebSocket，同时使用 `plugin.kaifabuqun.*` 作为业务消息命名空间。它为每个非 shell 会话维护隐藏 xterm，持续写入 `output`，收到 `terminal.capture` 后回传可见行和 `menuVersion`；聊天调度、账本和回滚等业务状态则由插件服务端发送，避免向上游 switch 增加新的顶层协议类型。

## 证据索引：关键文件、函数和协议消息

- 协议入口：`vendor/clideck/handlers.js` 的 `onConnection()`、`vendor/clideck/server.js`
- 状态模块：`sessions.js`、`config.js`、`transcript.js`、`plugin-loader.js`
- 关键消息：八类 bootstrap、`session.status`、`transcript.append`、`terminal.capture`、`terminal.buffer`、`plugin.<id>.<event>`
- 落地：`app/plugin/public/app.js` 的 `connect()`、`handle()`、`ensureTerm()`、`termLines()`
