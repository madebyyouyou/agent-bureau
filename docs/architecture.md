# 架构决定（2026-07-07，依据 docs/map-*.md）

## 形态：CliDeck 插件，零改动上游

我们不 fork、不旁挂独立进程。整个产品是一个 CliDeck **插件** `kaifabuqun`，
装在 `~/.clideck/plugins/kaifabuqun/`（开发期用 junction 指向本仓库 `app/plugin/`，
自定义 id 不会被上游升级覆盖）。同一进程、同一端口（默认 4000）。

- **前端**：`public/index.html`（设计定稿 v2 的壳）+ `public/app.js`，由上游静态路由
  `GET /plugins/kaifabuqun/*` 映射到插件的 `public/` 目录 → 与后端同源，浏览器直连 WS 无跨源问题。
  上游原版界面仍在 `/`，调试可用（但别长开：两个客户端都会应答 terminal.capture）。
- **服务端增量**：`index.js` 用插件 API（onStatusChange / onTranscriptEntry /
  onMenuDetected / inputToSession / getTranscript / setAutoApproveMenu /
  sendToFrontend + onFrontendMessage，命名空间 `plugin.kaifabuqun.*`）。

## 关键机制映射

| 产品功能 | 实现 |
|---|---|
| 群=广播进全员上下文 | 插件 fan-out：给每个成员注入（bracketed paste + 150ms 后 `\r`）；**忙则整条排队**（审计确认不可中途预塞），onStatusChange→idle 时逐条投递 |
| 气泡翻译 | 不碰 ANSI。吃 `onTranscriptEntry(id, role, text)`（上游已折叠成干净轮次）；接线时前端连带 `transcript.cache` 冷启动 |
| [收到] 折叠 | 群投递后的 agent 轮次若匹配 `^\[?收到` 且短 → 回执事件，不再二次扩散 |
| 熔断 | 成员群发言扩散计数；老板发言清零；到阈值暂停扩散、通知前端待放行 |
| 私聊 | 定向注入单个工位；同事互问沿用 `clideck ask`（识别注入回声 `[CliDeck ask from` 生成旁听频道） |
| 权限批准卡 | `onMenuDetected(id, choices)` → 前端卡片；应答=发 `input`（'\r' 或 '1'-'9'）；"总是允许"= `setAutoApproveMenu` |
| 快照/按轮撤销 | 每次老板触发注入前 `git add -A && commit`（项目目录需是 git 仓库）；成员轮结束再提交并 diff 出该轮文件清单；撤销这轮=`git revert`，回到此刻=`reset --hard`；完成后自动群播更正声明 |
| 覆盖警告 | 相邻轮次（不同成员）文件集合求交，非空即告警 |
| 上下文表盘 | v1 估算（transcript 体量折算），标注"约"；后续接遥测精化 |
| terminal.capture 契约 | **前端必须应答**：每工位一个隐藏 xterm（引上游 `/xterm.js`），喂 `output`，收到 capture 回 `terminal.buffer{lines,menuVersion}`——菜单检测/部分空闲判定靠它。这也白送"看原始终端" |

## 边界与已知约束

- WS/HTTP 无鉴权 → 只绑 127.0.0.1；手机走 Tailscale 时再评估（上游 --host 0.0.0.0 有明确警告）。
- `config.update` 是顶层浅合并 → 改 projects/commands 必须整数组回写，先读后写。
- 长广播 >64KB 分块贴入。
- 上游自更新提示只在 TTY 触发；启动脚本无妨。
- 每用户单实例锁（`~/.clideck/server.lock`），端口无关——启动脚本先读锁文件复用已跑实例。

## 验收路径

运行 `powershell -ExecutionPolicy Bypass -File .\app\scripts\start.ps1` → 起 clideck（或复用运行中的实例）→ 浏览器开
`http://127.0.0.1:4000/plugins/kaifabuqun/index.html` → 三工位入群 → 试跑。
