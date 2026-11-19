# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

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
