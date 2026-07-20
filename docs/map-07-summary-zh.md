# Map 07 中文技术审计摘要：前端启动、状态与发送层

> 原始证据：[Integration Map 07](./map-07-frontend-app-bootstrap-state-send-layer-.md)

## 这份审计解决什么问题

说明前端如何在没有常规 REST 拉取的情况下，从 WebSocket 快照建立完整状态，并处理用户发送、设置修改、项目导航和断线重连。

## 一句话结论

CliDeck 前端是 WebSocket 驱动的本地状态投影；快照负责冷启动、广播负责增量，但离线写入和多客户端并发没有可靠消息语义。

## 系统角色与核心概念

WebSocket 是浏览器与服务端之间的双向长连接，也是 CliDeck 应用数据的主要传输。服务端在连接后主动推送配置、会话和转录；项目不是独立资源，而是 `config.projects` 数组。Last-write-wins 表示多个写入没有版本比较，最后到达者覆盖先前结果。

## 关键执行链路

1. 页面加载后按当前 `location.host` 建立同源 WebSocket。
2. 客户端被动接收 bootstrap 快照，写入共享 state 并渲染导航、会话、设置和插件。
3. 后续 `created`、`session.status`、`transcript.append` 等广播增量更新界面。
4. 用户操作经 `send(msg)` 发出；创建会话使用 `create`，项目/设置主要使用 `config.update`。
5. 服务端持久化并广播新状态，客户端以广播结果为准重新渲染。
6. 断线后客户端定时重连；上游只对白名单命令排队，`input`、`rename`、`resize` 等会直接丢弃。

## 重要设计取舍

服务端主动推送快照省去了多组 REST 接口，也让多个窗口看到相同广播；代价是客户端必须正确合并快照与增量。`config.update` 以顶层浅合并简化后端，但数组仍需按最新值整体回写。白名单离线队列避免重放终端输入，却把“未发送”留给产品层处理。

## 审计发现的风险或缺口

- **已证实：** 断线时非白名单消息静默丢失；没有业务级 outbox、确认或幂等键。
- **已证实：** 配置无版本号，多客户端编辑同一数组会 last-write-wins；重放处理不当还会重复终端内容。
- **结构性局限：** 通知完全在客户端触发，后台服务本身不提供独立通知投递保证。

## Agent Bureau 最终采用的方案

Agent Bureau 自建同源前端，连接后消费 `config`、`sessions`、`sessions.resumable`、`output` 和状态广播，再通过 `plugin.kaifabuqun.*` 获取群聊账本与调度状态。项目变更只回写最新 `projects` 数组，避免覆盖其他顶层配置；终端输入仅在 socket 为 OPEN 时发送，断线每 3 秒重连。该实现保留了安全默认值，但当前也明确继承了一个缺口：没有聊天消息的离线 outbox，断线瞬间发送仍可能丢失。

## 证据索引：关键文件、函数和协议消息

- 上游：`vendor/clideck/public/js/app.js`、`state.js`、`nav.js`、`settings.js`、`creator.js`、`terminals.js`
- 协议：bootstrap 快照、`create`、`config.update`、`session.setProject`、`input`、`session.status`
- 上游发送语义：`state.js` 的 `QUEUEABLE_TYPES`、`send()`、`flushQueuedSends()`
- 落地：`app/plugin/public/app.js` 的 `connect()`、`send()`、`handle()` 和项目注册逻辑
