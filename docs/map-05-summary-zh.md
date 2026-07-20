# Map 05 中文技术审计摘要：working/idle 状态检测

> 原始证据：[Integration Map 05](./map-05-working-idle-detection-otlp-telemetry-re.md)

## 这份审计解决什么问题

说明 Claude、Codex、Gemini 等 CLI 没有统一生命周期协议时，CliDeck 如何归一化“正在工作、已空闲、等待菜单”的信号，以及调度层能信任到什么程度。

## 一句话结论

统一的 `session.status` 是多种 hook、OTLP 事件、状态机和终端画面推断后的产品接口；它可用于调度，但必须配合菜单门禁、静默期和超时兜底。

## 系统角色与核心概念

OTLP 是 OpenTelemetry 的遥测传输协议，这里把 CLI 生命周期事件发给本地服务。Claude/Gemini 主要由确定性 hook 驱动状态；Codex 组合 prompt、response、tool call 和 stop 信号，用一套带时间窗口的状态机判断 idle。权限菜单不是一等事件，需要浏览器回传终端画面辅助识别。

## 关键执行链路

1. 会话 spawn 时注入服务地址、`CLIDECK_SESSION_ID` 和每种 CLI 的 telemetry/hook 配置。
2. Claude/Gemini hook，或 Codex hook 与 OTLP 事件，到达本地 HTTP 接收端。
3. `telemetry-receiver.js` 和各路由按引擎规则更新内部活动状态。
4. 服务端广播统一的 `session.status {working, source}`，`sessions.js` 同步修改会话状态并通知插件。
5. 工具前置事件或完成事件触发 `terminal.capture`；客户端回传 `terminal.buffer` 后识别 `session.menu`。
6. 菜单回答经 PTY `input` 清除菜单并恢复 working；调度层再决定是否放行后续消息。

## 重要设计取舍

复用各 CLI 已有 hook/遥测比解析 spinner 更稳定，也能向插件提供统一状态；代价是安装配置和引擎版本差异会进入可靠性边界。Codex 混合状态机能覆盖工具调用阶段，但增加了 5 秒、300ms 等时序条件。菜单抓屏支持跨引擎，却对 TUI 文本格式和浏览器在线状态敏感。

## 审计发现的风险或缺口

- **已证实：** Codex idle 状态机是 best-effort；新事件会取消 settle，工具阶段缺失或乱序会造成迟到/漏报。
- **已证实：** 菜单依赖终端底部文本和客户端回传，CLI UI 改版或无浏览器都会退化。
- **已证实：** 当前没有统一、精确的 token/context 占用数据；Gemini 的会话匹配也可能在并发启动时误附着。

## Agent Bureau 最终采用的方案

Agent Bureau 只消费插件 API 归一化后的 `onStatusChange(id, working, source)`，不另造一套引擎判断器。`source === 'menu'` 被视为挂起而非收工；菜单集合、在途轮次和待定稿缓冲共同阻止 `pump()` 投递。收工后再等待 7 秒静默期收齐转录，并由定时检查处理状态缺失和超时。前端实现隐藏 xterm 完成捕获契约；上下文表盘明确只是按转录长度估算，不宣称精确 token。

## 证据索引：关键文件、函数和协议消息

- 上游：`vendor/clideck/telemetry-receiver.js`、`activity.js`、`bin/*-hook.js`、`codex-hooks.js`、`codex-config.js`
- 协议：`POST /v1/logs`、`POST /hook/*`、`session.status`、`session.menu`、`terminal.capture`、`terminal.buffer`
- 落地：`app/plugin/index.js` 的 `onStatusChange()`、`armFinalize()`、`eligible()`；`app/plugin/public/app.js` 的状态与菜单处理
- 产品边界：`docs/technical-audit-summary.md` 的状态与上下文风险条目
