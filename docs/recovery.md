# 备份与 P2 恢复

Vault 文件是正文、Properties、Source Annotation 和独立 Draft 的权威。Core 的接受回执也是用户资产：每份 Draft 的 Integration Intent 与当前 Reviewed Draft 选择不写入 Vault，不能只靠 Markdown 或 SQLite 备份恢复。

## 备份范围

停止 Core，等待文件操作结束，再一起备份对应 Vault 和 `data_dir`。保留它们的配对关系及配置中的 Vault 路径；不能把另一库的回执复制过来使用。

| 内容 | 恢复意义 |
| --- | --- |
| Vault 的 Sources、Drafts、Ideas、Knowledge、Research 与 `90_System` 模板 | 全部用户正文、属性、Annotation、原始引用与独立旧稿 |
| `data_dir/human-review/` | 已接受的人工输入、每份 Draft 的 Intent、选择、取消及撤销顺序 |
| `data_dir/recompile-actions/` | 接受的反馈、写入前后版本、幂等身份及 Recompile 计数 |
| `data_dir/draft-publications/`、`compiler-publications/`、`source-batch.json`（存在时） | 已接受发布／清理和跨文件中断恢复，不能在进行中删除 |
| `data_dir/analysis-results/` | 分析尝试、结果、输入版本与实际来源；不改写正文 |
| bootstrap 配置及 `data_dir` 中的任务、语义、分析、调度设置和凭据文件 | 原运行配置及明确选择的模型／模板；模板正文另在 Vault |
| `core.sqlite` 及其 journal／WAL／SHM | 登记及有界历史投影，允许显式重建，不是用户正文权威 |
| `semantic.sqlite` 及其家族 | 可重建的向量／BM25 缓存；缺失时需要明确建索引 |

完整复制停止后的 `data_dir` 最不易漏掉回执。运行锁、实例描述不是可移植的用户资产；不要用备份中的活动实例描述替代当前运行事实。Windows DPAPI 凭据绑定当前用户环境；此流程不承诺跨用户／机器解密，迁移后应重新录入凭据。Core token 是本机访问凭据，应按应用数据权限保护，不能发布到 Git。

Obsidian 未提交的 Review Note 只在插件会话中保留。已发送但送达不明的原请求另保存在 Vault 外的系统应用数据目录 `EngramWeave/obsidian-review/`；它用于查明／明确重试，不是长期 Intent 备份，也不会自动重投。

## 主数据库缺失或损坏

1. 保留现场，停止对应 Core；不要删除 Vault、回执或损坏数据库家族。
2. 缺库普通启动只建立空登记库，不自动扫描。可显式 Refresh／Rebuild；需要隔离坏库时运行：

   ```powershell
   npm run core -- --recover --config D:/path/to/config.json
   ```

3. 检查输出的 `backup_dir`、`isolated_files` 和扫描 Job。离线命令只隔离配置应用数据目录中的 `core.sqlite` 家族，保留独立备份，并完成文件登记重建。
4. 用同一配置正常启动 Core。启动加载 Analyzer、Human Review、Recompile 与 MVP Publication 的外部记录，恢复确定性已接受写入和必要投影。离线扫描完成不代表这些工作流服务已经加载；以启动后的接口为准。
5. 在 Sources 核对 processing／lifecycle／Annotation；在 Obsidian 打开旧 Draft，核对自身 Intent、当前选择和已撤销选择。可用原请求 ID 的 Check Result 查明接受状态。

恢复不调用 Compiler、Analyzer 或 Embedding，也不重放旧轮次／计划。Human Review 完成回执重放不重新授予取消、Discard、Recompile 或入库已撤销的许可。旧 Draft 和用户编辑保留；恢复不提供任意编辑撤销、跨 Draft diff 或独立 rollback 界面。Idea 和正式 MVP 副本不能重复生成，反馈不能重复追加。

未完成写入与当前文件不符、目标出现同名文件、文件链接或身份不安全时保留文件和回执并报告冲突。检查批准前后版本，恢复能够确认的接受版本后再明确重试原请求；不要删除回执来绕过冲突。文件确实丢失的正文仍需 Vault 文件备份，数据库无法凭空重建。旧 Job 流水与内部 ID 不保证完整还原。

## 语义缓存

`semantic.sqlite` 独立于主库。缓存缺失或损坏时，登记和关键词检索仍可用；启动不会自动计算向量。缺库状态为 `not_built`；损坏缓存保留副本后重新创建空缓存。不兼容或不安全缓存保持诊断，明确 Rebuild 才隔离经检查的普通缓存家族。之后用 Build／Rebuild 建索引，并核对覆盖范围；未变化内容可复用仍有效的编码缓存。

## 可复现验证

构建 Core 后运行 `npx vitest run tests/storage/p2-recovery.test.ts tests/review/human-recovery.test.ts tests/review/recompile.test.ts tests/review/publication.test.ts`。它们分别覆盖实际离线 CLI／独立进程恢复，以及原生属性失败、完成回执丢失、并发冲突、旧请求和文件保留。测试只使用隔离 Vault，不在活动库注入损坏。真实模型及原生插件流程仍需单独核对，自动故障注入不等同于人工验收。
