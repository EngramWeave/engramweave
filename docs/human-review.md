# Obsidian Human Review

在原生编辑器审阅 Draft 后，用一个 Review Note 输入明确选择 Create Idea、Recompile 或 Review Complete。三者不立即调用模型；Cancel Review Complete 是独立操作，不消费输入。MVP Publish to Knowledge 继续作为单独的人工入库入口，Planner／ChangeSet 留在 P3。

## 接口与资格

- `POST /v1/human-review`：`request_id`、`action: idea | complete | cancel`、`source_path`／`source_revision`、`draft_path`／`draft_revision`、`note`。输入最多 8000 字符，超限拒绝，不截断。版本仅用于接受时的并发检查，不将 Reviewed Draft 的正文冻结。
- `POST /v1/recompile`：沿用 [Processing 合同](processing.md)，以 `feedback` 接收 Review Note。
- `GET /v1/review-action?id=<UUID>`：返回 `not_found`／`unfinished`／`completed`，已接受时包含原请求，完成时包含结果。查询不重复执行动作。
- `GET /v1/draft-review` 的 `human_review` 返回 `selected_draft` 和当前打开 Draft 自己的 `intent`。未选择／撤销时前者为 null；该 Draft 尚未提交 Intent 时后者为 null，空 Intent 则为空字符串。

这些接口沿用 loopback、Bearer、Host 和无 Origin 的边界。新动作支持一个 active Draft 对应一个 active Source。Idea 可来自未归档的 Source，拒绝全空输入；文件固定新建为 `10_Ideas/<request_id>.md`，原输入作为正文，Properties 保留 Source 和 Draft Wiki Links。它不改 Source 阶段，也不调用 Compiler／Analyzer／Embedding。

Review Complete 要求 Source 为 compiled／reviewed，不要求任何 Analyzer 尝试或分析结果。用户可跳过 AI 分析直接人工确认；已有分析及其失败、过期情况仍作为参考展示。Core 将 Source 改为 reviewed，保存所选身份和该 Draft 本次 Intent。规划前明确确认同 Source 的 B 可以直接切换选择，A 与其 Intent 保留。普通编辑不撤销许可。Cancel 仅针对当前选择，提交空 `note`，reviewed→compiled，不改 Draft。运行中的模型、轮次或文件操作遵守 Core 的互斥保护。

## 持久化、重放和恢复

`data_dir/human-review/` 保存有界的版本化 JSON 动作回执和撤销记录，独立于 SQLite。每份 Draft 的最新已完成 Complete 决定它自己的 Intent；Source 的当前选择由明确 Complete／Cancel／撤销确定，二者不共用内容槽。回执序号只用于恢复确定顺序，不是新的领域概念。备份应用数据时应保留该目录以及既有 Recompile／Publication 记录；只备份 Vault 无法恢复 Intent。

首次文件写入之前保存接受回执。Idea 复用独占新文件发布，阶段更新复用 Core 原生属性保护及恢复日志。只有资产和投影写入确认后才标记完成。相同 ID 和相同输入返回原接受事实；相同 ID 不同输入拒绝。完成的旧请求重放不会改写正文、切回旧选择、倒退归档阶段或重新授予已撤销许可。

未完成动作在启动时恢复确定性写入，不调用模型。文件并发变化或同名目标冲突时保留原输入、文件和回执，阻止竞争写入；先检查冲突并恢复原接受版本，再显式重试原请求。不能以删除回执充当取消。Recompile、Source／当前 Draft 的 Discard 和 MVP 成功入库撤销当前选择，保留每份 Draft 的 Intent；Restore 不自动授予许可。启动会核对存活选择，处理生命周期写入后、撤销回执前的中断。SQLite 重建不丢已接受 Intent，Idea 和 Source 阶段仍来自文件。

## 插件输入与送达不明

未提交 Review Note 按 Draft 保存在插件会话内；刷新、切换文件和关开侧边栏保留，退出／重载不持久保存。动作先保存已打开的 Source／Draft 编辑，再重新读取版本并冻结请求。只有确认成功才清除对应输入；后续输入或另一个 Draft 的输入不会被旧响应清空。Cancel 和 MVP 入库均不消费 Review Note。

已冻结、即将发送的动作写入 Vault 外的系统应用数据目录 `EngramWeave/obsidian-review/<Vault hash>.json`，最多保留 32 个未查明动作。目录使用系统真实路径，兼容 Windows 应用数据重定向。记录只有原 Vault、动作及请求，不含 Token／模型密钥，也不进入插件 `data.json`。结果明确后清理；它不是永久 Review Note 或自动重试队列。

断线或未知送达保留原请求，提供 Check Result／Retry Original；重载后仍可查明，绝不自动重投。重试验证原 Vault 并沿用原 ID。确定的 HTTP 拒绝会查询接受回执；未接受时释放冻结请求，保留输入供修改，已部分接受时保留原恢复入口。

## 验证

Core `tests/review/` 覆盖精确 Idea 输入、独占发布、选择切换、取消、旧回执、Recompile 与启动恢复；`tests/http/human-review.test.ts` 覆盖真实 HTTP Schema、认证和范围。插件测试覆盖会话输入、后续编辑保护、原 Vault 绑定、有界恢复和不自动重投。

原生检查依次执行 Idea、反馈、确认 A、切换 B、取消；核对对应文件与 Intent，编辑已 Reviewed 正文时许可保持。断开或模拟响应丢失后重载插件，用原恢复入口查明，确认没有重复 Idea／Annotation；单独验证 MVP 入库归档。程序化原生检查与实际人工操作应分别报告。
