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

Sources 使用列表与属性预览并排的布局。顶部统计和筛选表示真实登记状态：All、Ready、Invalid、Missing、Unsupported；可读取不表示已整合。领域概念和状态沿用英文：Processing 为 Pending、Compiled、Reviewed、Planned、Archived，Lifecycle 为 Active 或 Discarded，未记录阶段显示 Not set，未知生命周期显示 Unknown。扫描 Job 失败不改变这些文件属性。统计针对所有来源，不随类型筛选变化。类型筛选与分页使用 Core 接口，列表搜索框进入范围为 Sources 的全文搜索。选中资料后，右侧只读展示 Properties/元数据、生命周期、标签、Annotation、Asset 和原始引用；不提供标签编辑、状态修改或正文编辑。缺失、不支持、无效资产通过状态和诊断表达。详情比较当前字节与登记 revision 提示索引过时，不更新数据库。Search 支持 Knowledge、Sources、全部，默认 Knowledge；Annotation 片段明确标为用户上下文。

文档读取错误显示在对应详情区域，仍保留所选行和路径；Source 列表、搜索、连接与显式操作错误分别显示在各自区域。错误详情默认折叠，不在工作区顶部展开 JSON。没有合适局部位置的错误使用可关闭的悬浮提示，6 秒后消失。切换页面、关闭详情或更改选择时清除相应错误；旧页面或旧选择的异步失败不会重新出现。

“在 Obsidian 中打开”由已验证的 Vault 与文档路径生成编码 URI；“打开原网页”只接受该文档的 HTTP/HTTPS 定位且拒绝嵌入凭证。不能由前端提供 URI。Zotero 等定位仅显示。所有打开操作由用户点击触发；需要系统注册 Obsidian URI 和默认浏览器。未注册的隔离 Vault 可能需要先在 Obsidian 中手工打开。

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
