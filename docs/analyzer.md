# Draft Analyzer

Draft Analyzer 由 Review Analyzer 和 Relation Analyzer 组成。两项分别配置模型、API／Codex 路径和模板，在同轮 Source／Draft 输入上生成独立的 AI 分析。它们不重新编译、不修改正文或正式知识、不建立正式关系、不推进 processing_status，也不代替 Human Review。

## 配置与使用

Desktop Settings 的 Draft Analyzer 中添加 Analysis Profile，分别选择 Review／Relation 模板、执行路径和模型，并配置 Relation 的上下文／输出复用偏好。Profile ID 是稳定引用；删除或改名不会自动修改 Source 中的选择。可明确指定默认 Profile；没有有效选择时报告配置问题，不根据 Source 类型猜测。

API 使用独立的 OpenAI-compatible endpoint 和每个 Profile／任务的凭据，不自动借用 Compiler 密钥。本机 HTTP 可不设密钥，远端使用 HTTPS 及独立配置的密钥。密钥在 Vault 外按 Windows 当前用户 DPAPI 保护并绑定 endpoint，响应只返回是否配置。设置和凭据不放进 Vault 或 Git。

未开启 structured output 的本机服务选择 `text`（界面 JSON in text），仍须返回严格 JSON。选择的输出格式或模型参数不受服务支持时明确失败，不自动换格式、模型或服务。Codex 使用已有 ChatGPT 登录与绝对 `.exe` 路径，不回退到另行付费 API。

Capture 可以提交可选 `analysis_profile`，Core 仅在 Source Properties 保存这个引用，不运行模型。active、pending Source 可以显式修改选择；其他属性、Annotation、正文和阶段保留。执行使用最终选择及当前配置。分析请求可明确选择本轮 Profile；它不会覆盖 Source 的持久选择。

在 Sources Inspector 选择具体 active Draft，再点击 Analyze Draft。一个 Source 可有多份 Draft，Core 不取第一份或最新一份代替用户选择。请求必须给出 Source／Draft 当前 revision 和 UUID request_id。已有 Run Compiler 仍只生成正文。完整轮次调度、重试和批量重分析分别由后续处理能力承接。

## 用户模板与输入

模板位于 `90_System/Prompts/Review/`、`90_System/Prompts/Relation/`。首次显式读取模板或执行时补建 Knowledge／Academic 示例，不覆盖已有用户内容。Desktop 可编辑模板内容；在 Vault 中添加同目录的 ASCII 字母、数字、下划线或连字符文件名后，可重新载入。模板最多 64000 UTF-8 字节，保存必须提供当前 revision，继承原生文件身份、父目录锁定、原子提交和恢复保护。

模板以有界上下文需求开头，其后是可编辑的分析指令：

```yaml
---
context:
  scope: all
  limit: 10
  required: false
---
Review submitted meaning, conditions and the user's understanding.
```

scope 为 `all`／`knowledge`／`ideas`／`research`，limit 为 1–20；required 为 true 时，缺失、过期或不完整的必需上下文导致该任务失败。false 时允许仅分析已投递材料，并保留实际覆盖说明。locator 不意味着已读取全文；目前不展开 PDF、图片或外部网页。模板不能扩展 Core 权限。

请求接受时冻结当前 Source 投递内容、Annotation、明确 Draft、实际行号、模板版本、Profile 和任务执行配置。`compiled_source_revision` 是编译时 hash，不是历史 Source 全文；分析读取当前实际材料。输入超预算明确失败，不截断投递材料。Source／Draft 共用输入变更或不可读时停止后续分析；结果查询会核对输入、Profile、模板及引用证据是否过期。

## 上下文、复用与执行

Core 使用 C1 三类材料的有界召回组装 API 上下文，两项各一次独立模型调用，没有动态 API 工具 loop。召回候选保留路径、kind、revision、行号和覆盖，不因相似分数成为正式关系。模型输出中的引用必须属于实际提供或读取的材料及行范围；合法的空 findings／suggestions 数组允许没有发现。

Relation 的三档复用：

- `input`：复用本轮 Review 实际消费的材料、证据和额外工具观察；Relation 仍使用自己的指令及所需上下文。
- `output`：有合法本轮 Review 输出时将其作为未认可的 AI 参考。没有则独立执行，不增加缺少参考提示或特殊状态；Review 的失败独立显示。
- `none`：不复用 Review 的额外上下文或输出；共有 Source／Draft 仍绑定同轮输入。

不使用旧轮输出填补缺口，配置变化只影响后续明确请求，不自动运行模型或撤销 Human Review。

Codex 使用现有 runner 和每任务私有 stdio MCP，复用官方 SDK。仅开放 `read_input`、`recall`、`read_evidence`：后者只能读取本轮已选证据，不接受任意文件路径。recall 范围由模板限定，最多 12 次工具调用，并有累计证据预算。Core 实际校验权限；readonly annotation 只是辅助说明。

CLI 忽略用户运行配置和规则，关闭 shell、Code Mode host、无关 MCP／apps／plugins、浏览器和通用执行能力。支持的 CLI 通过 `features.code_mode.direct_only_tool_namespaces` 将分析 MCP 暴露为直接工具；未实际使用必需的输入工具时失败，不能把不可用工具路径伪装成成功。MCP 使用独立短期 capability，不取得 Core 主 token、写服务或其他轮次 Draft。取消／超时终止 runner 并关闭任务通道。失败的 CLI 事件及有界诊断也保存在应用数据目录，写入前脱敏，不作为结果正文或普通 HTTP 错误返回。

## 结果与恢复

两项结果及对应输入、模板、上下文和工具观察分开记录在 `data_dir/analysis-results/<run-id>/record.json` 的 Review／Relation 部分。采用一个原子完整回执，避免结果与 provenance 分离；先保存回执，再提交 SQLite 任务状态。密钥只在本轮内存中使用，不进入回执。

启动只恢复已有回执；未完成的任务标 interrupted，不重新调用模型。数据库损坏后，用户文件仍是权威；保留的合法回执可恢复任务及结果。当前 Draft 的最近结果和失败／interrupted 记录保留，其他成功历史有界清理；不承诺永久保留所有旧分析上下文。

结果正文的产品展示属于 Obsidian 侧边栏。Desktop 只显示明确目标、Review／Relation 状态、所属任务错误和取消操作；当前只读结果接口供侧边栏和内容验收使用，不新增 Desktop 分析正文审阅面板。

## HTTP 合同

沿用 loopback、Host、Origin、token 和共享 Schema 边界：

| 接口 | 行为 |
| --- | --- |
| `GET/POST /v1/analysis/settings` | 读取／保存 Profile、默认选择及 write-only credentials |
| `GET /v1/analysis/templates` | 补建缺失示例，读取可编辑模板及 revision |
| `POST /v1/analysis/template` | 以当前 revision 保存模板 |
| `POST /v1/analysis/selection` | 修改 active pending Source 的 Profile 引用 |
| `POST /v1/analyses` | 明确 Source／Draft 版本、request_id、可选 profile_id；返回 202 和 reused |
| `POST /v1/analysis/cancel` | 显式取消指定活动轮次 |
| `GET /v1/analysis/result?id=...` | 只读结果、输入版本、过期原因及实际上下文记录 |

`/v1/jobs`、`/v1/jobs/:id`、status 支持 `analyze_draft` 及两个子任务状态。schema 4 增加 analyzer_jobs，经过约束校验后事务迁移既有 schema 1／2／3，保留文档、Compiler／scan Jobs、Vault 绑定和索引元数据。未知布局保持拒绝。

同 request_id、同请求重放返回原任务；不同输入重用 ID 拒绝。当前模型并发有界，分析期间不并行 Compiler 或扫描；涉及本轮 Source／Draft 的批次拒绝，无关 Source 的生命周期清理仍可执行。模型等待不锁用户文件，浏览和结果读取保持可用。Source Health、内容阶段与执行失败互不替代。

## 验证方法

运行 `npm run typecheck`、`npm test` 和既有 Rust host tests。测试覆盖模板无覆盖与修复、选择修改、明确 Draft、三档实际上下文、Review 失败后的独立 Relation、证据引用、SDK stdio 工具拒绝、取消／重放、结果恢复、数据库迁移和文件不变。普通测试不调用真实模型。

显式真实验收：构建 Core，设置 `ENGRAMWEAVE_C2_LIVE=1` 与 `ENGRAMWEAVE_C2_CODEX_PATH`，运行 `npx vitest run tests/analysis/real.test.ts`。可用 `ENGRAMWEAVE_C2_ROUTES=api`／`codex`、`ENGRAMWEAVE_C2_MATERIAL=knowledge`／`academic`／`paper` 选择本次验证。使用隔离模拟材料及已注明来源的有限公开论文选段、实际本机生成及 Embedding 服务和已登录 Codex；记录两任务、两路、工具观察、实际输出及文件 hash。测试批注不冒充用户真实判断，有限选段不代替全文或原生 Obsidian 验收。[论文选段来源：Attention Is All You Need §3.5](https://arxiv.org/html/1706.03762v7#S3.SS5)。

能力参考：[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)、[Codex 配置](https://learn.chatgpt.com/docs/config-file/config-reference)、[MCP stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。
