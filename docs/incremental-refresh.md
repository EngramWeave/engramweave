# 增量 Refresh

Refresh workspace 是明确的登记动作。Core 启动原生监听器收集变化路径，点击 Refresh 后才更新 Registry；Desktop 关闭不影响监听。普通编辑和启动不登记、不调用模型，也不建立首次语义索引。已有语义索引仍在登记成功之后更新变化的编码输入，失败独立报告。

## 读取范围与兜底

- Core 每次启动后的第一次 Refresh 全量核对四个登记根，覆盖停机期间的变化。变化提示只保存在当前进程内，不以持久缓存推断停机期间没有编辑。
- 后续 Refresh 合并重复路径，读取变化的 Markdown；新增、移动或删除目录时只核对对应子树。未触及文件复用已有投影，不枚举其目录或重读正文。监听覆盖 Vault 内附件等路径，以便重查依赖它们的 Record。
- 每次仍检查 Vault 及四个登记根的可用性和安全属性。全局候选数量、已登记路径及反向引用元数据可从 SQLite 查询；这不扫描全库文件。引用依赖只用于定位受影响对象，实际可用性仍通过受限路径检查。
- 监听缓冲区溢出、异常／不可用、不可识别提示或 Vault 身份变化时全量核对。仍存在的属性写入恢复工件也要求全量恢复检查。距上次成功全量核对超过一小时，下一次明确 Refresh 全量核对；没有后台定时扫描。
- Settings 的“完整核对”主动全量枚举、读取并计算 SHA-256，复用字节版本匹配的有效解析；适用于刷新结果疑似未更新时，不需重启 Core。请求为 `POST /v1/scans`，body 为 `{"mode":"refresh","force_full":true}`。普通 Refresh 省略该字段或使用 false，仍按正常增量规则执行；Rebuild 不接受此字段，始终全量并强制重新解析。

监听使用 Core 编译产物 `windows-files.exe watch` 内的 Windows `FileSystemWatcher`，不启动 PowerShell 或动态编译。事件缓冲区 32 KiB，待处理路径上限 10,000；超限不静默丢弃后继续增量。收到 Refresh 请求后先给已排队通知约 30 ms 的交付时间，再取出本轮变化提示；这不是文件系统快照，通知仍可能延迟或遗漏，后续 Refresh 和全量核对负责收敛。

## 发布与保护

本轮投影、代次和成功 Job 在同一 SQLite 事务发布。只将选中变化路径／子树内确认消失或不再属于受支持范围的旧投影标为 missing；未触及文件保持原状。扫描期间的新变化留待下一次 Refresh，扫描失败不确认消费本轮变化提示。整体枚举或曾存在的扫描根不可用时保留上一代，不把全根文件误标为 missing。

同一大小写折叠路径更新保留内部 ID，大小写调整更新路径显示；移动到不同路径沿用 missing＋新路径 ID 合同，不推测身份或修复来源链接。安全路径、隐藏项、reparse／硬链接与读写预算保护沿用既有文件合同。编辑或删除前仍读取当前文件并由原生写入器核对版本／身份，监听及缓存不授权任何写操作。

`indexed_at` 仅在实际成功读取文件并计算 revision 后更新。未触及文件及只重查引用的 Record 保留原时间；`last_scan_at` 和 generation 是本轮投影发布时间／代次，不表示每条文件均被重读。详情接口依然读当前字节并返回 `index_stale`，不推进索引时间。

## Job 诊断

`GET /v1/jobs` 和 `/v1/jobs/{id}` 的 summary 可包含以下可选字段，旧历史记录无需补写：

| 字段 | 含义 |
| --- | --- |
| `scan_strategy` | `incremental` 或 `full` |
| `scan_reason` | 增量时为 null；全量时描述兜底原因 |
| `read_files` | 本轮成功读取的 Markdown 文件数，不含引用状态检查和同一文件的补属性复读 |

全量原因包括 `core_started`、`manual_reconciliation`、`explicit_rebuild`、`periodic_reconciliation`、`vault_identity_changed`、`watcher_overflow`、`watcher_error`、`watcher_unavailable`、`watcher_unknown_event` 和 `property_recovery`。Desktop 扫描、完整核对及重建索引均留在当前页面；用户主动打开 Jobs 时可查看“手动完整核对”和实际读取数。扫描活动时每 250 ms 查询进度，模型任务仍使用原有 1 s 间隔，无活动任务时停止轮询。同一活动模式和核对范围才复用 Job；全量请求与正在进行的普通 Refresh 互斥，返回 JOB_BUSY，避免把用户明确要求的全量检查降为增量。

`source_count/knowledge_count` 表示发布后相应 ready 数量。增量的 `unchanged` 包含继续复用的 ready 投影，不代表本轮都做了字节校验；`added/updated/invalid/unsupported/missing` 描述本轮受影响对象，引用状态变化可能不改变 Record revision。`processed_files` 包括本轮处理的文件投影、引用重查和选中消失路径；进度每 64 项或至少间隔 100 ms 写入，最终值随发布事务保存。

## 验证与参考机制

运行 `npm run typecheck`、`npm test` 验证新增／编辑／目录移动删除、引用可用性、并发变化、失败恢复、重启与全量兜底。性能测试复用 `tests/performance/p2.test.ts`，准备 `.local/p2-f/corpus-manifest.json` 后设置 `ENGRAMWEAVE_F_PERF=1`，输出全量、无变化、单文件和三文件变化的耗时、读取数及原语料字节完整性；不以热缓存基准代替用户真实库或模型耗时。

实现参考 [Syncthing 的 watcher＋全量扫描机制](https://docs.syncthing.net/users/syncing.html#scanning)、[Microsoft 的监听缓冲区说明](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher.internalbuffersize?view=netframework-4.8.1)和 [Obsidian 公开的 Vault／MetadataCache 事件接口](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)，未复制这些项目代码。Obsidian 内部完整索引实现不公开；Core 使用自己的原生监听保证独立运行。未引入 Windows USN Journal，停机期间的变化由首次明确全量核对处理。
