# Compiler 与 Draft

Compiler 整理明确投递的文本和 Source Annotation，仅生成标题与 Markdown 正文。它不生成 AI Review、关系建议或整合计划。一个未 archived 的 Source 可以保留多份 Draft；正式入库选定一份之后统一 discarded 的流程属于后续 Review／Integration。

## 执行与设置

在 Desktop Settings 连接 Core 后配置 Compiler 的执行路径、模型、reasoning effort 和超时。执行设置保存在 `data_dir/compiler-settings.json`，不扩展 bootstrap 的五字段配置，也不进入 Vault 或 Git。Source 详情的 **Run Compiler** 显式执行一次正文任务，生成的 Draft 列在同一详情区域，可预览或在 Obsidian 打开。Desktop 不提供正文编辑器；Capture、启动和扫描均不调用模型。

API 使用 OpenAI-compatible `/chat/completions`，支持 JSON Schema、JSON object 或 JSON in text；选择服务实际支持的模式，不自动切换模式或执行路径。JSON in text 允许完整包裹结果的单个 JSON 代码块，仍严格验证内部只有 `title`／`body`。模型拒绝、不完整响应、额外字段、空结果、超时或超限都会失败，不推进内容阶段。

API key 经 Windows 当前用户 DPAPI 加密，保存在 Vault/Git 外的 `compiler-api-key.dpapi`，并绑定规范化 endpoint。设置读取只返回 `api_key_configured`，不提供密钥读取接口。换 endpoint 时不沿用其他 endpoint 的凭据；同 endpoint 留空保留原密钥。HTTP 仅允许显式回环地址，远程使用 HTTPS；重定向拒绝。无需认证的本地回环服务可不填 key。Core 可独立读取受保护凭据，不要求 Desktop 一直打开；原生桥只允许声明的请求及写入字段。

例如未以 structured output 模式启动的本地服务，应选择 JSON in text。模型名称、reasoning effort 和上下文预算由实际服务决定；不对不支持的参数静默降级。

Codex 使用用户配置的绝对 `.exe` 路径和该 CLI 已有 ChatGPT 登录，不复制认证文件、不回退到另行付费的 API。适配器使用 `codex exec`，忽略用户运行配置和规则、限制项目文档注入、使用 read-only 沙箱，并关闭 shell、Code Mode host、apps、plugins、浏览器、computer-use、skill search 和多 Agent 能力。Compiler 不需要文件或 Core Tools/MCP 工具。只有完成的结构化正文结果才可发布，工具执行事件会失败；诊断事件不是工具动作。当前支持在 Windows 上具有这些选项的 Codex CLI，验证过 0.160.0；旧 CLI 缺少选项时报告失败。

## 用户模板

Compiler 的提示词位于 Vault 的 `90_System/Prompts/Compiler.md`。首次读取设置或执行时，Core 从随组件提供的 `templates/Compiler.md` 补建默认文件；已有用户文件不会覆盖。直接在 Obsidian 编辑此文件即可个性化整理方式，不需要重新构建程序。空模板、非法 UTF-8 或超过 64000 字节会报配置错误；任务执行使用接受请求时读取的版本。

模板可调整表达、整理重点和语言；输出 title/body 合同、输入范围、文件路径、Properties、权限和发布校验仍由 Core 执行。

## 输入与文件合同

执行要求 Source 已登记 ready，当前文件仍有效、active、处于 pending 或 compiled，且无其他 Compiler 或扫描任务。每次请求提供当前 Source revision 与 UUID `request_id`；Source 修改后需重新读取。当前实现串行执行一次 Compiler 或扫描，模型等待期间不锁住用户文件。执行配置、输入和模板固定在请求接受时，修改设置影响之后接受的任务。compiled 的显式重复执行同样新增 Draft；失败保留 compiled。删除旧 Draft 不隐式回退阶段；新请求仍可执行，而重放旧请求不会重新生成。reviewed／planned 需先按其工作流回到 pending，archived 不执行正文任务。

只处理 inline Markdown 正文及 Annotation。non-inline Record 的正文是说明；PDF、图片、音频、外部 locator 不会自动提取或展开。标题和 locator 提供来源信息，不扩大投递范围；过大输入明确失败，不截断材料。Compiler 输入最多 1,000,000 UTF-8 字节，模型正文最多 1,000,000 字节，标题最多 500 字符。正文中的个人理解自然合入，不复制“我的理解”等归属标签或处理指令；忠实度仍需人工核对。

每个成功任务新增 `30_Drafts/<request-id>.md`，模型标题不决定路径。文件原样保留 Source 的 captured_at、annotation 属性值（缺失仍缺失，空值或 null 仍保留）；并包含 `type: draft`、`title`、`lifecycle_status`、指向 Source 的 `sources` Wiki Links、`compiled_source_revision` 和正文；已存在的 Draft、用户属性与正文均不覆盖。Source 只通过既有原生写入器变更 pending→compiled，原正文、Annotation 和其他属性保留。Capture 回执重放识别原内容的精确 pending 补写；compiled 推进还需关联 Draft 记录匹配输入 revision 的文件证明，返回当前 revision。没有该证明的手工阶段修改或其他用户变动仍冲突；保存和重放均不依赖 SQLite。

Draft 读取只开放 `30_Drafts/**/*.md`，继承有界稳定读取、路径与链接检查；与 Source／Knowledge 的通用 GET、登记和搜索分开。相关 Draft 从文件中的 `sources` 关联查找，不依赖数据库内部 ID。无效 Draft 报诊断，缺失与歧义不猜测修复。Source 改名的自动回链修复、完整 diff／restore、Recompile 的人工动作入口及 Analyzer 尚未实现。

## 发布与恢复

模型结果先落入 `data_dir/compiler-publications/<request-id>.json`，包含固定路径、结果、来源前后 hash 及执行 provenance；之后无覆盖发布新 Draft，记录已发布标记，必要时提交 Source 阶段，再更新完整文本投影和 Job。compiled 重复执行不重写相同的 Source 字节，发布标记区分尚未发布与完成后移动／删除的候选。完成记录提交后移除该临时 manifest。SQLite transaction 不代替跨文件恢复协议。

启动可继续已保存结果的文件发布，不重新调用模型。恢复先处理已验证的 Source 属性写入残留；已发布同一结果不会新增文件，阶段完成后出现的 Draft 用户编辑保持。已完成 Draft 被移动／删除、候选被并发改动或文件身份不明时保留现场并报告冲突，不能复制一份“替代”候选。Source 已改变时终止过期发布，保留已有 Draft，不覆盖新输入。

已持久化的相同请求返回原 Job；同 UUID 对应不同输入拒绝。运行历史清理或数据库丢失后，固定目标仍存在时拒绝再次执行该 request，而不是覆盖或重复生成。缺失／损坏数据库的显式恢复仍保留 Draft 文件、用户编辑和 Source 阶段；已完成的运行历史不保证从文件重建。Codex 的有界临时结果与诊断目录位于应用数据目录，不作为用户知识版本历史，可在停止 Core、无进行中任务后清理。

## HTTP 扩展

所有接口沿用现有 loopback、Host、Origin、token、schema 和安全错误边界。密钥只允许写入设置请求，不出现在响应或普通错误日志。

| 接口 | 合同 |
|---|---|
| `GET /v1/compiler/settings` | 返回当前设置及 endpoint 的密钥配置布尔值 |
| `POST /v1/compiler/settings` | 保存 `settings` 和可选 write-only `api_key` |
| `POST /v1/compilations` | 接受 `path`、`revision`、`request_id`，返回 202、Compiler Job 和 reused |
| `GET /v1/drafts?source_path=...` | 从文件读取该 Source 的 Drafts 及诊断 |
| `GET /v1/draft?path=...` | 稳定读取一份 Draft 的正文、属性、回链与 revision |

`/v1/jobs`、`/v1/jobs/:id` 和 status 的 active Job 支持 `scan_vault`／`compile_source`。Compiler Job 记录 Source revision、路径、模型、prompt version、时间、结果路径及错误；不伪装成扫描 Job。SQLite schema 2 增加独立 `compiler_jobs` 表，严格验证旧 schema 1 后事务迁移，保留文档、历史扫描、Vault 绑定和索引元数据；未知或损坏布局仍拒绝。

## 验证方法

运行 `npm run typecheck`、`npm test` 和既有 Rust Desktop host tests。自动测试覆盖输入/输出、任务资格、并发修改、重复请求、发布中断、完整投影、v1 迁移、损坏数据库恢复、DPAPI 和原生桥；模拟 Codex 子进程不能替代真实 CLI 验收。普通测试不调用付费模型。

真实验收在独立 Vault 用 API 与 Codex 各处理网页和带理解的选段文本，检查条件、正文范围、理解合入、无额外分析与可点击 Source 回链；编辑旧 Draft 后再生成新 Draft，确认已有文件不变。文件恢复采用独立数据库和故障样本，不能在用户 Vault 注入损坏。模型格式通过不等于忠实度通过，仍应阅读结果。

官方能力参考：[Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Codex 非交互执行](https://learn.chatgpt.com/docs/non-interactive-mode)、[Codex 认证](https://learn.chatgpt.com/docs/auth)。
