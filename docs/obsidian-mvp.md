# Obsidian MVP 与直接入库

MVP 使用现有 Compiler／Draft Analyzer，让用户在 Obsidian 原生编辑 Draft、查看 Source Annotation 与两项分析，再明确确认新建一份 `40_Knowledge` 笔记。完整 Planner／ChangeSet 和自动 Vault Git 仍待后续阶段；系统边界见 [ADR-0015](../../engramweave-docs/docs/adr/0015-mvp-direct-draft-publication.md)。安装与操作见 [插件 README](../../engramweave-obsidian/README.md)。

## Core 接口

- `GET /v1/draft-review?path=30_Drafts/...md`：当前 Draft、Source、active 关联 Draft 的路径／revision、最近 Analyzer Job 与该 Draft 的入库记录。查询不调用模型。
- `POST /v1/draft-publications`：包含 `request_id`、Source／Draft 当前 revision、`analysis_id`、新 `target_path` 和完整 `related_drafts` 路径／revision 列表。只允许 `40_Knowledge` 下的新 Markdown 文件，子目录必须已存在。

入库支持一个 active Draft 对应一个 active、compiled／reviewed Source。需有已经结束的 Analyzer 尝试，失败同样允许人工确认；用户之后编辑 Draft 不会因旧分析过期而被禁止入库，但侧边栏会显示过期。服务器核对当前审批版本和全部 active 关联 Draft，拒绝遗漏、新增、共享多 Source Draft、无效文件或同名目标。最多一次确认 100 份相关 Draft。

Core 以当前 Draft 字节为准，保留正文和用户 Properties，仅将正式副本的 `type` 改为 `knowledge`、保持 active 并添加 `mvp_publication_id`。原 Draft 不移动、不删除。正式文件创建成功后，逐项将相关 Draft 标记 discarded，最后仅更新 Source 的 `processing_status: archived`；Source 正文与 Annotation 保持原样。新 Knowledge 立即发布到可重建登记投影，不会自动计算 Embedding，后续 Refresh Workspace 按已有合同增量更新语义索引。

## 幂等、恢复与冲突

接受审批后，Core 在 Vault 外的 `data_dir/draft-publications/` 原子保存审批输入、目标正文、每个属性写入的前后 hash 与阶段记录。文件创建复用独占发布；属性更新复用 Core 原生助手及属性恢复日志。相同 `request_id` 和相同输入恢复原操作；更换输入复用 ID 会被拒绝。完成后重复请求只返回已有结果。

跨文件应用不是文件系统事务。异常可能留下已创建的 Knowledge 和部分 discarded Draft，Core 保留未完成记录，禁止另一个变更操作插入，并在启动时尝试恢复。已确认创建后被用户编辑的 Knowledge 保留；目标被删除／替换、Source 或 Draft 被并发修改时，不覆盖或重建它们，不伪报归档完成。侧边栏显示未完成原因和重试入口。冲突需先检查保留文件和记录、恢复明确的原审批版本，再重试原审批；直接丢弃恢复记录不是支持的取消方式。

完成记录独立于登记数据库，可在数据库重建后辨认已入库操作。记录不是正式历史，正式笔记由用户现有 Git 工具管理，尚无旧审批记录清理界面。完整轮次和有限模型重试由 [Processing](processing.md) 提供；[Human Review](human-review.md) 提供 Review Note、Idea、Recompile、Draft 专属 Intent 与取消许可。MVP 入库不消费 Review Note，归档撤销当前规划选择并保留各 Draft 的 Intent；计划审批和批量插件审阅仍待后续流程。

## 验证方法

运行 `npm run typecheck`、`npm test`。`tests/review/` 覆盖当前编辑保留、同名目标、并发版本、完整关联 Draft、响应重复及部分应用恢复；`tests/http/review.test.ts` 验证认证、Origin、范围限制、真实响应 Schema 与新 Knowledge 投影。原生 Obsidian 中按插件 README 的检查步骤验证编辑保存、结果显示、分析失败及入库确认；自动／模拟测试不能替代原生编辑验收。
