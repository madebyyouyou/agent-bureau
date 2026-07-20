# Map 08 中文技术审计摘要：插件系统与 Autopilot 参考实现

> 原始证据：[Integration Map 08](./map-08-clideck-plugin-system-plugin-loader-js-a.md)

## 这份审计解决什么问题

说明 CliDeck 插件能扩展哪些服务端和浏览器能力，为什么 Agent Bureau 采用“插件优先、补丁最小化”，以及上游 Autopilot 哪些机制可借鉴、哪些不适合直接复用。

## 一句话结论

插件 API 已覆盖会话观察、输入、转录、菜单和前后端消息，足以承载编排主体；Autopilot 证明了可行性，但其 LLM 路由、临时状态和原始输出转发不满足 Agent Bureau 的确定性协作要求。

## 系统角色与核心概念

服务端插件通过 `init(api)` 注册会话输入/输出、状态、转录、菜单和配置 hook，并可创建、关闭或写入会话。客户端插件是浏览器动态加载的 ES module，通过 `plugin.<id>.<event>` 命名空间双向通信；manifest `clideck-plugin.json` 声明身份、设置和客户端能力。

## 关键执行链路

1. `plugin-loader.js` 发现插件目录和 `clideck-plugin.json`，加载服务端 `index.js`。
2. `buildApi()` 提供 `onStatusChange`、`onTranscriptEntry`、`inputToSession`、`getSessions`、settings、pills 等能力。
3. HTTP 路由提供插件 `client.js` 和 `public/` 静态资源。
4. 浏览器动态导入客户端模块，并用 `plugin.<id>.<event>` 与服务端插件通信。
5. 会话状态、菜单和转录 hook 驱动插件逻辑；插件再写入 PTY 或向前端广播业务状态。
6. Autopilot 在全部 worker idle 时调用 router LLM，选择 `route` 或 `notify_user`，再把来源输出粘贴进目标 PTY。

## 重要设计取舍

插件与 CliDeck 同进程，可直接访问 live `cwd`、状态和转录，避免额外代理与协议复制；代价是插件故障与上游共享进程，且仍受上游内部 API 版本影响。Autopilot 用 LLM 选择下一位 worker，灵活但需要额外供应商 API key，路由结果和成本也更难复现。

## 审计发现的风险或缺口

- **已证实：** Autopilot 的菜单与部分 idle 仍依赖浏览器，路由只粘贴原始输出并延迟 150ms 回车，没有交付确认。
- **已证实：** worker 角色主要在内存，启动时知识库会重建；长输出还会截断。
- **升级风险：** 修改 bundled Autopilot 会被上游版本播种覆盖，自定义实现必须使用独立插件 ID。

## Agent Bureau 最终采用的方案

Agent Bureau 创建独立 `kaifabuqun` 插件：服务端用状态、转录、菜单和会话 API 实现确定性的双阶段轮次、每会话队列、唯一 `pump()` 注入出口、群聊账本和 Git 快照；浏览器端用同源静态资源和插件消息渲染群聊。它没有复用 Autopilot 的 router LLM，而以程序状态机决定发言顺序。只有系统提示拼接、多段转录修复等插件 API 无法覆盖的能力才打上游补丁，且每个补丁都有精确锚点、幂等标记和 vendor 测试。

## 证据索引：关键文件、函数和协议消息

- 上游：`vendor/clideck/plugin-loader.js` 的 `buildApi()`；`plugins/autopilot/index.js`、`client.js`、`clideck-plugin.json`、`prompt.md`
- 插件契约：`onStatusChange`、`onTranscriptEntry`、`onMenuDetected`、`inputToSession`、`getTranscript`、`sendToFrontend`、`onFrontendMessage`
- 落地：`app/plugin/clideck-plugin.json`、`app/plugin/index.js`、`app/plugin/public/app.js`
- 补丁边界：`app/scripts/patch-clideck.js`、`test/patch6-transcript.test.js`、`test/patch7-spawn.test.js`
