# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-11-19

### Added

- **写任务必须带验收标准**：`agentmd_write` 的 `kind=task` 必须提供 `acceptance`，否则拒绝写入；没有验收标准的任务无法判定完成。
- **完成必须有证据**：`agentmd_update` 的 `done=true` 必须提供 `evidence`（测试/命令结果、产物路径、行数等可核对内容），否则拒绝；“我做了”不算证据。
- **完成自动降权**：`done=true` 且未显式指定权重时，自动把 `weight` 降为 1（结论仍被依赖时显式传 `weight=2`）。
- **注入里的结构化标志**：`⚠ 未定验收`、`⚠ 已完成未降权` 会直接显示在注入摘要里，推动模型处理。
- 文件格式新增条目下的 `验收：` / `证据：` 缩进行；`agent.md` 解析兼容没有这些字段的旧条目。
- 提示词重写：三问测试（10 轮后还影响决定吗？忘了会做错什么？能随时查回来吗？）、该记/不该记清单、权重映射、完成证据等级。

### Changed

- `agentmd_read` 与注入摘要会显示验收标准与证据。
- 冒烟测试从 21 项扩到 30 项，覆盖新约束。

## [0.1.0] - 2026-11-19

### Added

- 项目级 `agent.md` 记忆文件，按会话工作目录定位。
- 四个模型工具：`agentmd_write`、`agentmd_update`、`agentmd_forget`、`agentmd_read`。
- 两个 per-agent 系统提示 section：固定维护规则 + 每次请求重新渲染的记忆摘要。
- 条目带短 id、权重（1–3）与完成标记；注入时按权重排序，低权重条目截断、已完成条目折叠为统计行。
- 注入字符上限（默认 4000，可由 `maxPromptChars` 调整），超出截断并提示用 `agentmd_read` 读全文。
- 手写保护：文件里非条目格式的内容保留在 `## 手写笔记` 段。
- 原子写入（临时文件 + rename）、按 mtime 失效的解析缓存、加载顺序无关的幂等注册。
- 冒烟测试 `tools/smoke.mjs`（21 项断言，无需 DSH 运行环境）。
