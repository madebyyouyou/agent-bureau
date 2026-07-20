# Map 01 中文技术审计摘要：服务启动、路由与信任边界

> 原始证据：[Integration Map 01](./map-01-server-boot-http-routing-static-serving-.md)

## 这份审计解决什么问题

说明 CliDeck 如何从命令行启动为本地控制面，以及 HTTP、WebSocket、插件静态资源和单实例锁如何汇合；同时判断“只在本机使用”何时足以成为安全前提。

## 一句话结论

CliDeck 把真实终端控制集中在一个无独立鉴权的服务中，因此回环地址不是普通默认值，而是当前架构的主要信任边界。

## 系统角色与核心概念

HTTP 负责遥测、hook、Agent 查询/问答和静态文件；WebSocket 是浏览器与服务端保持长连接、可双向推送消息的协议，承载实时控制面。`~/.clideck/server.lock` 记录进程和地址，保证每个用户只运行一个实例。插件路由 `/plugins/<id>/...` 则是同源扩展前后端的正式入口。

## 关键执行链路

1. `bin/clideck.js` 分派子命令；普通启动进入 `server.js`。
2. `runtime.js` 按 `--port`、`CLIDECK_PORT`、`PORT`、4000 的顺序解析端口，未传 `--host` 时绑定 `127.0.0.1`。
3. `single-instance.js` 获取 `server.lock`；发现其他存活实例就返回其 URL 并退出。
4. 服务端初始化会话、转录、遥测和插件，再创建同端口 HTTP/WebSocket 服务。
5. HTTP 依次分派 OTLP、各引擎 hook、`/api/session/ask`、`/api/session/agents`、插件和静态资源；WebSocket upgrade 没有限定路径。
6. 客户端连接后进入 `handlers.js`，共享会话状态、PTY 输出和广播。

## 重要设计取舍

单进程、同端口让插件界面天然同源，部署和状态同步都很简单；代价是控制面、遥测和静态服务共享故障域。Origin 检查能挡住部分跨站浏览器连接，但无 Origin 的本地客户端仍可进入，不能替代认证。单实例锁避免两个服务争用数据，却也意味着重启会影响全部活动会话。

## 审计发现的风险或缺口

- **已证实：** `--host 0.0.0.0` 会把无鉴权的 PTY 输入能力暴露到网络；未知 POST 又被 catch-all 以 `200 {}` 接收，拼错路由可能静默成功。
- **结构性局限：** 任意路径均可升级为 WebSocket，安全边界依赖端口可达性和监听地址，而不是细粒度路由权限。
- **升级风险：** 直接修改 `server.js` 或 `public/` 会被全局包升级覆盖。

## Agent Bureau 最终采用的方案

Agent Bureau 是基于 CliDeck 构建的本地多 Agent 协作界面与调度层。它把自定义界面作为 `kaifabuqun` 插件从同源 `/plugins/kaifabuqun/` 提供，启动器固定使用 `127.0.0.1`，读取 `server.lock` 后还验证端口确实可连接，再决定复用或启动服务。主体不 fork `server.js`；插件 API 覆盖不了的能力才进入可重复执行、锚点漂移即报错的最小补丁集。

## 证据索引：关键文件、函数和协议消息

- 上游：`vendor/clideck/server.js`、`runtime.js`、`single-instance.js`、`paths.js`
- 路由：`POST /v1/logs`、`POST /hook/*`、`POST /api/session/ask`、`GET /api/session/agents`、`GET /plugins/*`
- 落地：`app/scripts/start.ps1`、`app/scripts/patch-clideck.js`、`app/plugin/clideck-plugin.json`
- 安全决定：`README.md`“安装与运行”、`docs/architecture.md`“边界与已知约束”
