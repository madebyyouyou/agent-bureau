# Map 06 中文技术审计摘要：从 PTY 字节流到对话记录

> 原始证据：[Integration Map 06](./map-06-transcript-pipeline-pty-stream-clean-cha.md)

## 这份审计解决什么问题

解释 ANSI 控制符、终端重绘、提示符、工具调用和菜单混在同一输出流时，系统如何提取可供 UI、调度和审计使用的用户/Agent 轮次。

## 一句话结论

干净转录不是简单去 ANSI，而是“输入重建 + 客户端渲染抓屏 + 按引擎解析 + 候选稿定稿”的多阶段启发式管道。

## 系统角色与核心概念

缓冲区是暂存终端近期文本的一块内存区域；ANSI 控制符用于光标移动、颜色和重绘，原始字节不等于最终可见文本。JSONL/NDJSON 是每行一个 JSON 对象的记录格式，CliDeck 用它持久化 `{ts, role, text}` 转录条目。

## 关键执行链路

1. 用户侧：`input` 的按键先由 `trackInput()` 过滤控制序列、处理退格并在回车时确认用户文本，再写入 PTY。
2. Agent 侧：已知 CLI 不直接解析原始 `output`，而是在状态变化后请求 `terminal.capture`。
3. 浏览器从 xterm 缓冲区读取已渲染、无 ANSI 的行，并回传 `terminal.buffer`。
4. `transcript-parser.js` 按 Claude/Codex/Gemini 的提示符锚点重建 turns。
5. `transcript-normalizer.js` 去掉输入框、spinner、hook 提示等 UI chrome；`transcript-candidate.js` 暂存当前候选稿。
6. idle 或菜单触发定稿，`transcript.js` 写入 JSONL，并广播 `transcript.append`；重连则用 `transcript.cache` 或历史回放。

## 重要设计取舍

依赖 xterm 的最终画面可正确处理大量光标重绘，优于直接正则清洗字节流；代价是转录依赖浏览器和固定 TUI 版式。候选稿“最后渲染覆盖前一次”有利于去除重复重绘，却可能丢掉一轮中被工具调用分隔的多段正式回复。

## 审计发现的风险或缺口

- **已证实：** 没有客户端回答 `terminal.capture` 时，已知 Agent preset 的回复不会正常定稿。
- **已证实：** 缓冲区截断、提示符字符出现在正文、引擎 UI 改版都可能导致缺失或误截。
- **已证实：** 上游默认只保留连续 Agent 块的最后一个；一轮“正文—工具—收尾”会漏掉前段正式内容。

## Agent Bureau 最终采用的方案

Agent Bureau 直接消费插件 `onTranscriptEntry()`，把原始工作日志与 `<group_message>`/`<private_message>` 信封中的正式发言分开；群聊事件另写自己的 JSONL 账本，避免把终端转录当业务消息总账。前端隐藏 xterm 履行捕获契约。针对已复现的多段回复丢失，`patch6Candidate()` 在上游提交候选稿前收齐提示之后的多个正文块、排除工具/噪音块；补丁只在精确锚点命中时应用，并有 vendor 回归测试。

## 证据索引：关键文件、函数和协议消息

- 上游：`vendor/clideck/transcript.js`、`transcript-parser.js`、`transcript-normalizer.js`、`transcript-candidate.js`、`ansi-utils.js`
- 协议与存储：`input`、`output`、`terminal.capture`、`terminal.buffer`、`transcript.append`、`transcript.cache`、`transcripts/<sessionId>.jsonl`
- 落地：`app/plugin/index.js` 的 `parseEnvelopes()`、`onTranscriptEntry()`、群聊 `emit()`
- 补丁与验证：`app/scripts/patch-clideck.js` 的 `patch6Candidate()`/`patch6Handlers()`；`test/patch6-transcript.test.js`
