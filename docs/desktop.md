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

主页展示真实索引统计、Sources 与扫描任务。Review、ChangeSets、Knowledge Maintenance 等规划区域仅作视觉展示，示例内容明确标记且操作不可用；知识维护不表示 Core 连接配置或 Vault 登记诊断。知识图谱只作结构示意，不表示真实关联。文档详情在 Sources 属性栏或 Search 中展示，离开这些页面后不保留详情卡片。

Sources 使用列表与属性预览并排的布局。顶部六个 View 为 All Sources、Pending、Processing、Archived、Issues、Discarded；discarded Source 仅在最后一个 View 出现，具体筛选规则见 [Sources](sources.md)。可读取不表示已整合。领域概念和状态沿用英文：Processing 为 Pending、Compiled、Reviewed、Planned、Archived，Lifecycle 为 Active 或 Discarded，未记录阶段显示 Not set，未知生命周期显示 Unknown。扫描 Job 失败不改变这些文件属性。统计针对所有来源，不随组合筛选变化。搜索、Filter Chips 与分页使用 Core 接口。选中资料后，右侧只读展示 Annotation、Properties/元数据、生命周期、标签和原始引用；inline Asset 不重复展示。详情不提供正文或属性编辑，底部显式操作另经清单确认。缺失、不支持、无效资产通过 Health 和诊断表达。详情比较当前字节与登记 revision 提示索引过时，不更新数据库。Search 支持 Knowledge、Sources、全部，默认 Knowledge；Annotation 片段明确标为用户上下文。

文档读取错误显示在对应详情区域，仍保留所选行和路径；Source 列表、搜索、连接与显式操作错误分别显示在各自区域。错误详情默认折叠，不在工作区顶部展开 JSON。没有合适局部位置的错误使用可关闭的悬浮提示，6 秒后消失。切换页面、关闭详情或更改选择时清除相应错误；旧页面或旧选择的异步失败不会重新出现。

“在 Obsidian 中打开”由已验证的 Vault 与文档路径生成编码 URI；“打开原网页”只接受该文档的 HTTP/HTTPS 定位且拒绝嵌入凭证。paper Source 提供 Open in Zotero，只允许当前文档的 `zotero://select/library/items/<key>` 或 `zotero://select/groups/<group-id>/items/<key>`，拒绝额外查询、片段、凭证和其他命令。不能由前端提供 URI。所有打开操作由用户点击触发；需要系统注册相应 URI 和默认浏览器。未注册的隔离 Vault 可能需要先在 Obsidian 中手工打开。类型筛选以 Paper 展示新论文 Source，历史实际类型仍从 Registry facets 展示。

## Compiler 与 Draft

Settings 的 Compiler 区域配置 API／Codex、模型、reasoning effort、超时以及服务支持的输出格式。远程凭据经 Windows DPAPI 保护并绑定 endpoint，界面读取不返回密钥；无需认证的本地回环 API 可以留空。Analyzer 设置支持独立 Review／Relation 模板、模型、执行路径、Profile 与复用偏好，详见 [Analyzer](analyzer.md)。

Sources 详情的 Run Compiler 对 active、pending／compiled、已登记 Source 执行一次正文编译。当前扫描与 Compiler 串行；任务结束后刷新阶段与相关 Draft 列表。每次编译新增 Draft，已有用户编辑保留；可预览各 Draft 或通过原生宿主在 Obsidian 打开，Desktop 不编辑正文。Compiler 失败显示在对应 Source／Job，设置错误留在设置区域，不跨页保留。

正文生成成功不表示分析已经结束。Desktop 可选具体 Draft 启动 Analyze Draft 或独立 Retry Review／Retry Relation；分析正文位于 Obsidian 侧边栏。Sources 多选提供正文 Compile 和完整 Process，Jobs 提供 Process Pending、轮次／尝试历史、取消与明确 Draft 多选重分析。Settings 配置时间／间隔、时区和有限重试；最小反馈 Recompile 保留旧稿、返回 pending，Sources 显示计数并支持 Pending 筛选。具体合同见 [Processing](processing.md)。人工直接入库由 [Obsidian MVP](obsidian-mvp.md) 实现，完整 Planner／ChangeSet 整合仍待后续阶段。

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
