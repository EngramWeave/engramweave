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

扫描与重建分别提交 `refresh`/`rebuild`。只有活动任务期间轮询状态和 Jobs；结束或断线即停止。空闲时显示上次确认状态，可点击“刷新状态”检查外部进程。扫描后列表更新至新代次，搜索结果若来自旧代次会提示重新搜索。

Sources 将登记状态与已归档/未归档分列显示；详情只读展示元数据、Annotation、Asset 和原始引用。缺失、不支持、无效资产通过状态和诊断表达。详情比较当前字节与登记 revision 提示索引过时，不更新数据库。Search 支持 Knowledge、Sources、全部，默认 Knowledge；Annotation 片段明确标为用户上下文。

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
