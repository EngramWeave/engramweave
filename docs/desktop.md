# 本地 Desktop

Desktop 使用同一个独立 Core。React 只展示共享契约的响应，Rust 宿主负责固定进程入口、身份握手、认证转发和原生打开；前端不能读取任意文件、执行命令、指定任意请求地址或取得 token。

## 构建与启动

Windows 本地 NTFS，Node 24.19.0、npm 11.17.0、Rust MSVC 工具链、Windows SDK 和 WebView2。JavaScript 版本由 package-lock.json 锁定，Rust 版本由 Cargo.lock 锁定。本机可执行程序依赖构建时固定的 Node 实际路径和 Core 构建入口；移动仓库或移除该 Node 版本后需重新构建，不是可分发安装包。

```powershell
npm ci
npm run build
$env:ENGRAMWEAVE_CONFIG = 'D:/path/to/config.json'
npm run desktop:dev
```

配置与独立 Core 相同，见 [Core 配置](core.md)。不提供 Vault 编辑器或自动新建配置；未指定环境变量时读取 `%LOCALAPPDATA%/EngramWeave/p1/config.json`。配置、Vault、data_dir 不可用时显示明确错误；首次使用配置后，修改目录或端口需重新启动 Desktop。

```powershell
npm run desktop:build
$env:ENGRAMWEAVE_CONFIG = 'D:/path/to/config.json'
& './apps/desktop/src-tauri/target/debug/engramweave-desktop.exe'
```

构建产物是本机 debug 可执行程序，不生成安装包。开发服务器只绑定 `127.0.0.1:1420` 且禁止自动换端口。单独打开浏览器页面仅可预览布局；真实 Core 操作需要 Tauri 原生宿主。

## 操作与进程归属

点击“启动 Core”创建宿主自有子进程；点击“连接已有 Core”验证运行实例的 API 版本、实例 ID、Vault、data_dir、端口与认证状态。端口占用不会自动连接未知服务或换端口。停止按钮只用于宿主自有句柄，退出 Desktop 也只停止自身 Core；外部 Core 继续运行。

正常停止通过宿主私有 stdin 管道发送固定停止请求；Core 同时接受父管道关闭。超过 8 秒才通过自有子进程句柄强制终止。Rust 不根据残留 PID 发送信号，不删除数据库、Vault、token 或不确定的锁文件。启动、认证或实例校验失败后需显式重连；没有后台任务重提。

左下角“Refresh workspace”显式扫描整个配置范围，登记 Sources 和已有 Knowledge；不只是刷新当前列表。扫描与重建分别提交 `refresh`/`rebuild`，重建入口位于 Settings。只有活动任务期间轮询状态和 Jobs；结束或断线即停止。左下角状态卡中的 Jobs 和主页 Recent Activity 可查看任务记录。空闲时显示上次确认状态，可在 Settings 点击“刷新状态”检查外部进程。扫描后列表更新至新代次，搜索结果若来自旧代次会提示重新搜索。

窗口保留系统原生标题栏和窗口控制，Windows 11 标题栏及边框颜色与应用背景统一；不支持该颜色 API 的系统保留原生颜色。侧栏、标题区和底部状态保持固定，内容区和 Sources 的列表、属性预览独立滚动。较小窗口压缩侧栏间距，必要时仅导航区域滚动；底部刷新和状态卡片开关始终可用。侧栏底部菜单按钮收起或展开 System Status 卡片。

主页展示真实索引统计、Sources 与扫描任务。Review Queue 和 ChangeSets 展示实际文件摘要并可定位到对应页面；Knowledge Maintenance 等规划区域仍仅作视觉展示，示例内容明确标记且操作不可用；知识维护不表示 Core 连接配置或 Vault 登记诊断。知识图谱只作结构示意，不表示真实关联。文档详情在 Sources 属性栏或 Search 中展示，离开这些页面后不保留详情卡片。

Sources 使用列表与属性预览并排的布局。顶部六个 View 为 All Sources、Pending、Processing、Archived、Issues、Discarded；discarded Source 仅在最后一个 View 出现，具体筛选规则见 [Sources](sources.md)。可读取不表示已整合。领域概念和状态沿用英文：Processing 为 Pending、Compiled、Reviewed、Planned、Archived，Lifecycle 为 Active 或 Discarded，未记录阶段显示 Not set，未知生命周期显示 Unknown。扫描 Job 失败不改变这些文件属性。统计针对所有来源，不随组合筛选变化。搜索、Filter Chips 与分页使用 Core 接口。选中资料后，右侧只读展示 Annotation、Properties/元数据、生命周期、标签和原始引用；inline Asset 不重复展示。详情不提供正文或属性编辑，底部显式操作另经清单确认。缺失、不支持、无效资产通过 Health 和诊断表达。详情比较当前字节与登记 revision 提示索引过时，不更新数据库。Search 支持 Knowledge、Sources、全部，默认 Knowledge；Annotation 片段明确标为用户上下文。

文档读取错误显示在对应详情区域，仍保留所选行和路径；Source 列表、搜索、连接与显式操作错误分别显示在各自区域。错误详情默认折叠，不在工作区顶部展开 JSON。没有合适局部位置的错误使用可关闭的悬浮提示，6 秒后消失。切换页面、关闭详情或更改选择时清除相应错误；旧页面或旧选择的异步失败不会重新出现。

“在 Obsidian 中打开”由已验证的 Vault 与文档路径生成编码 URI；“打开原网页”只接受该文档的 HTTP/HTTPS 定位且拒绝嵌入凭证。paper Source 提供 Open in Zotero，只允许当前文档的 `zotero://select/library/items/<key>` 或 `zotero://select/groups/<group-id>/items/<key>`，拒绝额外查询、片段、凭证和其他命令。不能由前端提供 URI。所有打开操作由用户点击触发；需要系统注册相应 URI 和默认浏览器。未注册的隔离 Vault 可能需要先在 Obsidian 中手工打开。类型筛选以 Paper 展示新论文 Source，历史实际类型仍从 Registry facets 展示。

## Compiler 与 Draft

Settings 的 Compiler 区域配置 API／Codex、模型、reasoning effort、超时以及服务支持的输出格式。远程凭据经 Windows DPAPI 保护并绑定 endpoint，界面读取不返回密钥；无需认证的本地回环 API 可以留空。Analyzer 设置支持独立 Review／Relation 模板、模型、执行路径、Profile 与复用偏好，详见 [Analyzer](analyzer.md)。

Sources 详情的 Run Compiler 对 active、pending／compiled、已登记 Source 执行一次正文编译。当前扫描与 Compiler 串行；任务结束后刷新阶段与相关 Draft 列表。每次编译新增 Draft，已有用户编辑保留；可预览各 Draft 或通过原生宿主在 Obsidian 打开，Desktop 不编辑正文。Compiler 失败显示在对应 Source／Job，设置错误留在设置区域，不跨页保留。

正文生成成功不表示分析已经结束。Desktop 可选具体 Draft 启动 Analyze Draft 或独立 Retry Review／Retry Relation；分析正文位于 Obsidian 侧边栏。Sources 多选提供正文 Compile 和完整 Process，Jobs 只展示操作、轮次及尝试历史，支持展开详情、分页和打开相关 Draft。扫描 Vault、完整核对和重建索引均留在当前页面，不自动进入 Jobs；需要查看记录时从 System Status 或 Recent Activity 主动打开。Settings 配置时间／间隔、时区和有限重试；最小反馈 Recompile 保留旧稿、返回 pending，Sources 显示计数并支持 Pending 筛选。具体合同见 [Processing](processing.md)。人工直接入库由 [Obsidian MVP](obsidian-mvp.md) 实现，完整 Planner／ChangeSet 生成、批准执行和恢复见 [Planner](planning.md)。Desktop Jobs 显示 Integration Executor 的涉及路径、进度、归档 Draft 清单和错误，并经固定原生入口打开经 Core 核实的正式笔记；批准与重试在 Obsidian，Git 仍待 D。

## Review 与 Changes 文件页面

侧栏 Review 的数字显示全库 To Review 数量，Changes 的数字显示全库 Ready 数量，不随页面搜索或筛选变化；连接或文件摘要不可用时显示 `—`。进入页面、刷新列表或完成管理操作后重新读取摘要。Review 与 Changes 的搜索框沿用 Sources 的样式，按 Enter 或点击搜索按钮提交。

Review 一行对应一份 `30_Drafts` Markdown，包括保留旧稿、discarded 和无法解析的文件。All Drafts 排除已知 discarded；To Review 对应有效 active Draft 的 active compiled Source；Reviewed / Planned 只计当前人工选择，其他同 Source 的稿件不冒充已审阅稿。Issues 独立显示文件或来源问题。Source stage、Analysis 和 Lifecycle 分开展示，不创建 Draft 处理状态；修改时间来自文件，不表示审阅时间。

页面提供搜索、排序、筛选、20 项分页、只读正文 / Properties、Source Annotation、该 Draft 的 Intent、同源稿件、分析概况及相关方案 / Job 跳转。详细分析建议和正文编辑仍在 Obsidian。对有效当前选择可明确启动 Planner；完整或单项分析复用已有 Analyzer。Draft 精确定位使用独立 path 条件，能定位 discarded 和长路径，Source 跳转根据当前生命周期选择正确 View。独立 Draft 废弃、恢复与永久删除仍属于 D，不展示空管理按钮。

Changes 一行对应一个现存工作区；用 manifest、规划回执及 Executor 接受事实区分 Preparing / Ready / Executing / Issues，已接受但中断的执行也受保护。异常工作区保留独立诊断，不使其余列表失效。搜索可匹配目标路径，筛选支持操作和目标领域；详情列出全部正文 / 目录 / 废弃、新领域、理由、证据和已保存人工取舍。Preview 只读显示已保存 Candidate，可经核实的本方案条目在 Obsidian 阅读模式打开；不会替插件保存未提交编辑。

Ready 支持明确取消和单方案 Replan；批量取消只操作明确选择的 Ready 方案，最多 100 份，逐项反馈。取消清理候选并将有效选择返回 reviewed；重新规划使用当前 Draft / Intent / 知识库，新方案重新批准。若旧方案已取消而新请求失败，结果明确说明，并保留从 Review 再次规划的入口。正在生成的方案可取消对应 Planner。已接受执行只能查询 / 恢复原执行，不能用取消、重规划或清理绕过。成功消费或取消的工作区从文件页消失，历史留在 Jobs。

`GET /v1/review-files` 与 `/v1/change-files` 返回分页摘要及独立 View 统计，不传全部正文；选择后才读取详情。`GET /v1/changeset/overview` 读取 manifest 和当前取舍；已接受方案不返回可改取舍。`GET /v1/draft/file` 只核实安全的现存 Draft 路径，允许在 Obsidian 修复无效 Properties，不开放其他目录。接口沿用认证 / Host / Origin 和固定原生白名单；没有新增 Desktop 批准接口。页面 Refresh 只重新读取文件，不登记或启动模型。

原生检查可运行 `node tests/desktop/resource-pages.mjs` 与 `node tests/desktop/review-cleanup.mjs`。先构建 Core、原生 Desktop 和同级 Obsidian 插件；脚本使用本机现有 Playwright / 应用与任务自有隔离 Vault，保留证据于 `.local/P3/ui/`，只关闭自身进程。提案生成是模拟的，实际 UI、Core 文件操作和原生插件是实跑；不能把这些检查记作模型效果或真人验收。Windows URI 注册与用户实际操作另行确认。

## 验证

```powershell
npm run typecheck
npm test
$env:PATH = "$env:USERPROFILE/.cargo/bin;$env:PATH"
$env:ENGRAMWEAVE_NODE = (Get-Command node).Source
$env:ENGRAMWEAVE_CORE_ENTRY = (Resolve-Path 'packages/core/dist/main.js').Path
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --test desktop-host
```

TypeScript 与 Core 测试使用 Vitest。Rust 宿主安全边界需要直接执行本机 Rust 代码，使用 Cargo 标准测试器，测试仍统一位于 `tests/desktop/`，不创建独立验证应用或框架。真实样本基线只读，进程、扫描和故障验证使用 `.local/test-runs/` 隔离副本。

手工确认：从空库启动、显式扫描、查看 Sources/Annotation/Asset、按三种范围搜索、查看 Job 结束与错误、刷新检测断线、重新连接、原生打开。分别验证退出自有进程和退出连接外部进程的模式。

实现参考：[Tauri 权限](https://v2.tauri.app/security/permissions/)、[原生命令](https://v2.tauri.app/develop/calling-rust/)、[Obsidian URI](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI)。

Sources 支持六个 View、Filter Chips、排序和底部稳定多选工具栏，执行反馈使用 Toast，目标及详细结果使用独立弹窗。前五个 View 支持 Compile／Discard／Discard Drafts，Discarded 支持永久删除／Restore。Annotation 为首个详情标签页，只显示 active Draft；Processing 与 Lifecycle 分别直接显示 processing_status 和 lifecycle_status，独立于 Health。交互及操作范围见 [Sources](sources.md)。

## Semantic Recall

Settings 提供独立 Embedding／可选 Reranker 的 endpoint、模型和凭据、服务测试、首次建立、增量重试和重建。Search 的 Semantic 入口覆盖 Knowledge／Ideas／Research，Keyword 保留现有检索。System Status 的 Semantic 与 Registry Index 分开，错误不进入 Sources Health。首次建立与后续 Refresh 的行为及证据合同见 [语义召回](semantic-recall.md)。检索模型等待使用已验证连接的独立快照，不能阻塞宿主启停或浏览操作。

## Draft Analyzer

Settings 提供 Analysis Profile、两项模板内容、各自模型／路径及 Relation 的三档复用偏好。Sources Inspector 可修改 active pending Source 的预设引用，明确选择一份 Draft 后点击 Analyze Draft。多 Draft 不自动挑选；任务显示 Review／Relation 独立状态与所属错误，取消使用独立连接快照，不阻塞宿主生命周期。分析结果正文留给 Obsidian 侧边栏，不在 Desktop 增加审阅面板。配置、证据和恢复合同见 [Draft Analyzer](analyzer.md)。

Compiler、每个 Profile 的 Review 和 Relation 均在 API 配置中提供独立的 Output token limit 与参数名称选择。留空使用服务默认；Codex 配置不显示 API 预算。摘要／建议长度由模板控制，上限包含多少推理 token 取决于服务。HTTP 400 等请求拒绝在所属任务中显示已识别的原因，不自动更改用户选择。
