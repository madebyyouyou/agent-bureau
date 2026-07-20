# Map 04 中文技术审计摘要：Agent 间消息投递

> 原始证据：[Integration Map 04](./map-04-clideck-ask-mechanism-agent-to-agent-mes.md)

## 这份审计解决什么问题

解释一个 Agent 如何向另一个正在运行的 CLI 会话投递文本、等待其完成，并从终端输出中提取可返回的回答；同时判断该原语能否直接承担群聊调度。

## 一句话结论

`clideck ask` 是“本机 HTTP 协调 + 模拟终端输入 + 启发式取回回复”的便利桥梁，不是带队列、确认和并发隔离的消息总线。

## 系统角色与核心概念

调用方 PTY 通过环境变量取得自身会话 ID 和服务地址。Bracketed paste 是终端用控制序列标记整段粘贴文本的机制，可降低多行内容被逐键解释的风险；最终仍要发送回车，目标 CLI 才会提交输入。

## 关键执行链路

1. 调用方运行 `clideck ask`，CLI 将 `callerSessionId`、目标和消息 POST 到回环地址 `/api/session/ask`。
2. 服务端验证调用方和目标；目标 `working` 时立即返回 409，不排队。
3. `submitAskInput()` 以 bracketed paste 注入带发送者前缀的文本，并按长度延迟回车，必要时补一次回车。
4. 服务端广播 `session.dispatch`，再监听 `session.status` 和 `output` 等待结束迹象。
5. 目标 idle 后发出 `terminal.capture`；浏览器回传 `terminal.buffer`，转录模块提交 `transcript.append`。
6. 服务端取派发时间后的最后一条 Agent 转录，失败时退化到 200 字预览，并把 HTTP 响应返回调用方。

## 重要设计取舍

该方案无需 Agent API 或进程内 SDK，任何能在 PTY 中运行的 CLI 都可参与；代价是提交、忙闲与回答提取都依赖终端时序。回环限制缩小了网络攻击面，但本机任意进程仍可向会话注入文本。

## 审计发现的风险或缺口

- **已证实：** busy 目标返回 409 且没有队列；并发请求仍可能同时通过初始 idle 检查并交错注入。
- **已证实：** 延迟回车可能误触尚未识别的权限菜单；无浏览器应答捕获时可能超时或只返回截断预览。
- **结构性局限：** 700ms、2.5s 等安静窗口和“最后一条 Agent 转录”都是启发式，慢速多段回复可能不完整。

## Agent Bureau 最终采用的方案

Agent Bureau 保留 `clideck ask` 作为成员间咨询通道，但主群广播不直接依赖它。插件为每个会话维护消息队列，所有投递都先进入 `deliver()`，只有唯一出口 `pump()` 能在目标 idle、无菜单、无在途轮次且上一份稿件已定稿时执行 bracketed paste。状态回调、菜单回调和 watchdog 只有唤醒权，不能绕过队列直接发送，从结构上消除竞态注入。

## 证据索引：关键文件、函数和协议消息

- 上游：`vendor/clideck/session-ask.js` 的 `submitAskInput()`/`waitForAnswer()`、`session-agents.js`、`sessions.js`
- 路由与消息：`POST /api/session/ask`、`GET /api/session/agents`、`session.dispatch`、`terminal.capture`、`terminal.buffer`、`transcript.append`
- 落地：`app/plugin/index.js` 的 `deliver()`、`eligible()`、`pump()`、`inject()`、`onMenuDetected()`、`onStatusChange()`
- 前端捕获：`app/plugin/public/app.js` 的隐藏终端处理
