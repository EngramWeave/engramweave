# Processing 轮次、调度与反馈

Core 独立完成本地登记 → Compiler → Review Analyzer → Relation Analyzer。Desktop 和 Obsidian 提交请求并观察结果，关闭插件或附着的 Desktop 不截断后续步骤。轮次不会调用 Planner、ChangeSet、正式入库或 Vault Git；人类批准仍另行执行。

## 执行与资格

Desktop 的 System Status → Jobs 提供 **Process Pending**、轮次历史和指定 Draft 的 **Retry Review／Retry Relation** 多选。Sources 的 **Compile selected／Run Compiler** 仅编译正文，**Process selected／Run complete round** 执行完整轮次。Obsidian 的 **Run Knowledge Compiler** 提交同一个 Core 入口。

Pending 轮次先登记新 Capture，无需事先 Refresh。内部登记不更新 Embedding、不建立首次语义索引；公开 Refresh 和 Analyzer 查询维持已有语义召回合同。自动／Process Pending 只编译 active、有效、支持 inline 正文的 pending Source。明确选定的 Source 允许 pending／compiled，成功时追加 Draft。reviewed 的规划以及 planned／archived 的正式推进不在此执行。

候选固定，逐项开始前重读版本、阶段和生命周期。排队期间的修改、删除或 Discard 逐项报告并继续其他材料。用户文件不会被锁住等待模型。Core 沿用一个模型槽，Source 串行执行，并拒绝竞争的变更操作。相同 UUID request_id 和相同请求返回同一轮；不同输入复用 ID 拒绝。正文成功后 Source 为 compiled，分析失败不修改该阶段或 Health。

## 调度与有限重试

Settings → **Processing schedule** 可设 daily 时刻或 interval 分钟，默认禁用。时区初始取本机当前时区并保存；daily 的不存在夏令时时刻跳过当天，重复时刻只执行一次。配置存于 Vault 外 `data_dir/processing-settings.json`，保存不调用模型。

有界心跳只安排未来触发。Core 正常运行但忙时最多合并等待一轮，空闲后执行；停止、睡眠、时钟跳变或重启错过的计划不补跑。状态显示 next_due、waiting 和原因。启用计划后 Desktop 空闲时每 15 秒检查状态，有活动任务时约每秒更新。owned Desktop 退出停止自有 Core，attached 退出保留独立 Core；没有 Windows 服务或开机自启。

每步默认额外重试 2 次，可配置 0–5，首次调用另计。仅明确暂时的连接故障、请求超时、HTTP 429／500／502／503／504 可以自动重试。退避从 1 秒开始，最多 30 秒，有界尊重 Retry-After，取消可终止等待。认证、配置、非法／拒绝／截断输出、版本冲突、文件保护、持久化或未知结果不重复。Codex 普通退出码／诊断文字不构成可靠临时故障分类。

重试使用同一已冻结输入、模板、模型和配置，重新检查 Source／Draft 及必需复用证据。重试只包围推理，已保存结果和文件发布走确定性恢复。Jobs 展示每次尝试的起止、错误与下次时刻。Review 用尽失败后 Relation 独立执行，没有特殊缺参考状态。

## 独立分析与反馈

Retry Review／Retry Relation 允许先前成功或失败的具体 active Draft 及其 active、未 archived Source，沿用 C2 的只读分析边界；不会改变 planned 等阶段或推进规划。只运行所选任务，不运行另一项或 Compiler。Relation 仅按设置使用同输入／Profile／模板且证据仍有效的 Review；没有则独立执行。`draft-review.analyses` 分别返回最近实际执行的 Review／Relation Job，侧边栏显示各自 ID、Draft 版本和过期情况，不将另一项旧结果标成新轮结果。

**Request Recompile** 要求 active Draft 及 active 的 pending／compiled／reviewed Source。反馈追加到原 Annotation，Source 仅回到 pending，不立即执行模型；旧 Draft、正文和编辑全部保留。后续明确或已启用的计划可以另产新稿。每个成功的新请求计数一次；重放、再次 Run Compiler、自动模型重试和 Draft 数量不计入 Recompile count。Sources 显示计数，Pending 可筛 First compile／Recompile requested。该指标不写入 YAML。

`data_dir/recompile-actions/` 的幂等回执保存反馈和受保护写入前后版本。重启仅恢复确定性写入并重建计数；当前内容与批准前后版本冲突时保留文件／回执，阻止竞争变更。恢复明确版本后重试原请求。已完成请求不重写后来编辑的文件。完整 Review Note 动作见 [Human Review](human-review.md)；旧稿保护由独立 Draft 保留提供，不要求跨稿 diff 或独立 rollback 界面。

## 数据、接口与验收

schema 5 原子迁移已验证的旧布局，保持登记、Job 和文件。保留最近 100 个终止轮次及有界额外 Job 历史，并保护所保留轮次的依赖和每个 Draft 各项的最近尝试／成功结果。用户 Draft 不因历史清理删除。启动先恢复已有正文、分析与已批准发布，再标记未完成轮次／尝试 interrupted，不续跑旧模型或队列。数据库重建不会重编译 intact compiled Source。

| 接口 | 行为 |
| --- | --- |
| `GET/POST /v1/processing/settings` | 调度和有限重试配置 |
| `GET /v1/processing/state` | schedule、active、latest |
| `POST /v1/processing-rounds` | request_id、pending／selected／analyze，202 回执 |
| `GET /v1/processing-rounds` | limit／offset 历史分页 |
| `GET /v1/processing-round?id=...` | 输入、步骤、子 Job 和错误 |
| `POST /v1/processing/cancel` | 取消轮次及当前模型 |
| `POST /v1/recompile` | 明确 Source／Draft 当前版本和 feedback |

selected 明确 Source；analyze 明确 Source／Draft 路径及版本、可选 Profile 和单项 task，不猜最新 Draft。沿用 Host、拒绝 Origin、bearer 和共享 Schema；原生白名单不接受任意 URL／命令。

运行 `npm run typecheck`、`npm test`、Cargo host tests 及插件 Vitest。模拟测试覆盖故障、互斥、重放和恢复；fake timers 覆盖时区、忙时合并、时钟跳变和睡眠。真实验收先构建 Core，设置 `ENGRAMWEAVE_D_LIVE=1`、`ENGRAMWEAVE_D_CODEX_PATH`，运行 `npx vitest run tests/processing/real.test.ts`。`ENGRAMWEAVE_D_ROUTES=api`／`codex` 限定路径，`ENGRAMWEAVE_D_SCHEDULE=1` 增加一分钟真实调度。使用隔离 Vault、明确语义建索引和交付构建入口，不以模拟测试代替真实模型／原生 Obsidian。原生检查编辑、单项重试、Recompile、失败后人工入库及附着客户端关闭后续执行；临时证据在 `.local/`。

时区计算使用 [Luxon](https://moment.github.io/luxon/api-docs/index.html)；参数不构成新的内容状态轴。
