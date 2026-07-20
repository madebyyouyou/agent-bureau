# Map 02 中文技术审计摘要：PTY 会话生命周期与身份

> 原始证据：[Integration Map 02](./map-02-pty-session-lifecycle-sessions-js-claude.md)

## 这份审计解决什么问题

解释一个 CLI Agent 从创建、运行、输入输出到恢复或重启，哪些信息只存在于内存，哪些会持久化，以及产品层应如何维持稳定成员身份。

## 一句话结论

CliDeck 的运行实体是带 PTY、缓冲区和状态的会话；恢复能保留会话 ID 与 Agent 原生上下文，但业务身份仍需由项目和席位名称独立约束。

## 系统角色与核心概念

PTY（伪终端）是程序模拟的终端设备，让 CLI Agent 像在真实命令行中收发输入输出。`sessions.js` 以内存 `Map` 保存活动会话，键为随机会话 ID；缓冲区是暂存近期终端输出的内存区域，默认最多约 2MB。`sessions.json` 只保存可恢复且已取得 resume token 的会话。

## 关键执行链路

1. 客户端发送 `create`，服务端解析命令、`cwd`、名称和 `projectId`。
2. `spawnSession()` 创建 PTY，并注入 `CLIDECK_SESSION_ID`、服务地址、遥测配置和 Agent guide。
3. `input` 经插件变换与转录跟踪后写入 PTY；原始 `output` 同时进入滚动缓冲区并广播。
4. 服务端从输出或遥测中捕获 Agent 原生 session token，并定期把可恢复记录写入 `sessions.json`。
5. `session.resume` 用原 ID 和 resume token 重建进程；`session.restart` 优先恢复上下文，否则以原命令重启。
6. 重连客户端收到活动会话、可恢复会话和缓冲区/历史回放，再通过增量消息继续同步。

## 重要设计取舍

将实时会话集中在内存可直接访问 PTY、`working` 和 live `cwd`，控制简单；代价是服务重启必须依赖不完整的持久化记录恢复。插件 API 的 `getSession()` 能读取实时 `cwd`，但 WebSocket 的 `sessions` 快照不含该字段，说明不同集成面并非等价。滚动缓冲区利于快速重连，却不适合作为完整历史。

## 审计发现的风险或缺口

- **已证实：** resume token 捕获失败时，会话不会进入可恢复列表；`sessions.json` 还以明文保存 token、`cwd` 和预览。
- **结构性局限：** 2MB 缓冲区会截断长会话；会话名称可变，不能单独承担永久身份。
- **竞态窗口：** `createProgrammatic()` 在 spawn 后才标记 `ephemeral`，极快退出的进程可能短暂按可持久化会话处理。

## Agent Bureau 最终采用的方案

Agent Bureau 用 CliDeck `projectId` 表示群、用稳定 `seatName` 表示业务成员，运行时再把它映射到活动 session ID；新开工位与带记忆接回因此是两种明确路径。前端消费 `sessions` 和 `sessions.resumable`，接回时发送 `session.resume`；服务端的 `seatsResuming` 在成员就位和开机静默期内压住新一轮消息，超时后才放行队列。实时工作目录通过插件 `getSessions()`/`getSession()` 获取，不从静态项目配置猜测。

## 证据索引：关键文件、函数和协议消息

- 上游：`vendor/clideck/sessions.js`、`claude-session.js`、`agent-session-guide.js`、`session-agents.js`
- 接口：`create`、`created`、`input`、`output`、`session.resume`、`session.restart`、`sessions.resumable`
- 落地：`app/plugin/index.js` 的 `members()`、`loadGroup()`、`seatsResuming`；`app/plugin/public/app.js` 的 resume 流程
- 启动身份注入：`app/plugin/kfq-spawn.js`、`app/scripts/patch-clideck.js` 的 `patch7Sessions()`
