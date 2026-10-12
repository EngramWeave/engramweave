# P3 A：Core／Desktop 施工说明

> 范围：[系统 A 计划](../../engramweave-docs/P3_A_IMPLEMENTATION_PLAN.md)、[详细 TODO](../../engramweave-docs/P3_A_TODO.md)。以下均为待实现方案，不替代当前已交付合同。

## 1. 当前代码锚点与复用

| 责任 | 现有代码 | 实施方向 |
|---|---|---|
| 执行隔离 | `packages/core/src/execution/codex.ts`、`process.ts` | 保留隔离参数、凭据清除和日志脱敏；扩展具体 MCP task capability，不另建通用 Agent 平台。 |
| 只读工具 | `analysis/tools.ts`、`mcp.ts`、`materials.ts` | 复用私有 loopback bridge、TypeBox 参数校验及带版本的证据；Planner 的工具处理单独内聚。 |
| 文件安全 | `files/paths.ts`、`read.ts`、`properties.ts`、`property-native.ts`、`publication.ts` | 复用规范化、文件身份、原生保护和独占创建；候选另有明确根目录，不放宽普通 Markdown 读取。 |
| Human Review | `review/human.ts`、`http/review.ts` | 给 Planner 提供当前 selection／Draft Intent；补 planned 的许可、取消和恢复协作。 |
| 调度／恢复 | `jobs/processing-rounds.ts`、`processing/scheduler.ts`、`processing/retries.ts`、`main.ts` | reviewed 分流到 Planner；复用 retry、busy 和关闭流程，避免循环 busy 造成自身阻塞。 |
| Recall | `recall/index.ts`、`analysis/context.ts` | 复用三类召回和证据新鲜度检查，不另建检索引擎。 |
| API／Job／存储 | `packages/contracts/src/index.ts`、`http/context.ts`、`storage/database.ts` | 最小新增契约和 Job 投影，按现有精确 schema 校验与原子迁移规则升级。 |
| Desktop | `apps/desktop/src/AnalysisSettings.tsx`、`Processing.tsx`、`client.ts` | 复用已有设置和轮次入口；新增 Planner 配置／状态，不修改已有模型 API 配置格式来强迫迁移。 |

新增实现以 `changesets/`、`planning/`、`jobs/planner.ts`、`http/planning.ts` 等当前责任内聚组织；名称可随代码调整，不预建空包或未来 Worker 体系。共用 helper 只从已有两个具体调用点提取。

## 2. 候选合同与持久化

manifest 采用版本号、不可混淆的工作区 ID、本轮 Source／Draft／Intent 输入引用、条目 ID、正式目标、候选映射、理由／证据和实际读取版本。Core 构建规范化 manifest，模型通过工具提出条目，不允许任意覆写控制字段或 ready 标记。

正文使用拟议完整 Markdown 文件；已有笔记要保留用户正文、Properties 与来源，新建／重组来源仍指向真实 Source。目录提议和 `lifecycle_status: discarded` 是正式影响，保留在同一计划，不提前创建正式目录或写 lifecycle。可执行底层条目不等于 Create／Update／Split／Merge 工作流。

正式目标限 `10_Ideas`、`40_Knowledge`、`50_Research`、`60_Projects` 的受支持 Markdown；首要验收落点为 Knowledge／Research。必要目录在这些根内提议，新一级领域影响保留给人工明确批准，不新建任意 Vault 根。Source／Draft／System／Attachments／其他 ChangeSet 不能成为 Planner 正式改写目标。读取 Projects 的明确上下文需求由 task-scoped 文件读取完成，不借此扩大 P2 三类语义索引或把 `70_ChangeSets` 加入 SCAN_ROOTS。

候选创建、修改和客户端保存均有版本前置条件。创建用独占语义；更新复用原生文件身份及写入保护，不直接把仅适用于应用数据的 atomicWrite 当作 Vault 文件安全保证。拒绝路径穿越、大小写别名、符号链接、重解析点、任意硬链接及父目录身份变化。沿用现有文件大小边界，工作区总量及工具次数另外有界；触及边界明确失败，不截断后冒充完整方案。

客户端获取／保存使用 ChangeSet ID 和条目 ID，不信任客户端任意 absolute path。服务端从已校验 manifest 定位候选；保存冲突返回当前版本信息，客户端保留脏缓冲，不静默重试覆盖。请求 ID 的重放保护沿现有模式，通信不确定时同 ID 查结果／重试，不重新构造一份规划。

只有 manifest 和全部候选校验通过才发布 ready；Source 阶段变更另用现有 protected property writer。Core 保存必要发布回执，区分候选已完成、阶段已保存、Job 投影已更新，确保中断恢复不会再次调用 Agent。失败半成品不显示为 ready，Source 留在 reviewed；保留必要诊断与明确取消清理路径，不设计永久候选档案。

## 3. Agent 的具体工具权限

| 工具责任 | 允许的操作 | 约束 |
|---|---|---|
| 输入 | 读取 frozen Source、所选 Draft、该 Draft Intent 和可参考分析 | 不读取 sibling Intent 代替当前输入，不在轮中重新选择 Draft。 |
| Recall | 查询 Knowledge／Ideas／Research | 复用既有索引、scope、coverage 和实际 chunk revision；不因未召回判定不存在关系。 |
| 正式上下文 | 读取受支持笔记、有限目录列表 | 记录实际字节 revision，同文件版本冲突可见；目录浏览分页／限深，不读取 arbitrary filesystem。 |
| Candidate | 创建、读取、替换或局部编辑本轮候选 | 按工作区及候选版本限制；局部编辑核对预期片段，不能模糊替换或覆盖用户外部编辑。 |
| 提案 | 注册正文、目录、废弃及说明，验证当前方案 | 仅写本轮 manifest／candidate，校验失败反馈给 Agent，不创建正式影响。 |

模型最后返回 bounded 结构化结果，引用本轮 ChangeSet；Core 验证真实文件和工具事实，不能只信 `success: true`。可由 Core 在任务成功结束后完成发布，Agent 不获得批准／执行工具。合法而无需检索的具体轮次不强迫无意义工具调用；A-G 的代表性关系重组样本必须有真实检索及候选写入证据。

保持 Compiler、Analyzer、Planner 三类权限独立。executeCodexText 的 MCP 命令、env、tool allowlist、namespace 与事件验证来自具体 task capability；Analysis 继续原白名单，Planner 用自己的白名单。私有 token 绑定本轮且不继承 Core 全权 token；撤销、停止和 finally 都关闭 bridge，日志去掉 capability token。读写候选负载需独立上限，当前 analysis bridge 的 8 KB 请求边界不能直接套到完整候选正文。

工具定义的 readOnlyHint 等只作说明，所有权限在 Core handler 重查；保留 Codex read-only sandbox 和关闭通用工具参数。若必须改参数，须用真实 CLI 验证仍只可通过 MCP 写候选，不以工具声明替代实际隔离。

## 4. Planner 轮次、阶段与恢复

Planner 的输入冻结于轮次启动；用户后续编辑 Draft 不改变本轮正文，也不在轮末单纯因为 Draft body hash 改变而自动废除候选。Source／Draft 的真实身份、lifecycle、归属和当前规划许可仍需保护；写 Source 阶段时不能覆盖其并发编辑。

配置复用现有 Codex 执行设置的字段及模板文件保护，单独保存 Planner 设置和模板，不复用 Compiler 的 endpoint／密钥。首期仅使用 route=codex；如引用 Relation 模板，冻结实际路径、内容及版本，不改写原模板。独立模型、模板及旧 API 兼容均由 focused tests 验证。

现有 HumanReviewActions.permissionValid 仅允许 reviewed，initialize 会撤销不匹配的 selection；必须协调 ready manifest 恢复与 planned 许可校验，不能初始化时先撤销再试图从 Source 属性猜回 Draft。取消计划保留各稿 Intent，旧动作重放不重新授予许可。Source stage alone 永远不能选择 Draft。

沿现有 Job／attempt 记录扩展 Planner，数据库投影可从候选和必要 Core 回执重建；accepted Human Review 回执仍是 selection／Intent 的事实来源。迁移必须覆盖当前 schema 5 及既有可升级版本，不只改变常量导致旧 layout 被拒绝。不要将候选完整副本永久复制到数据库。

ProcessingRounds 中 pending 仍编译／分析，reviewed 转 Planner；planned／archived 不自动处理。单项手动、批处理、定时共用资格检查和现有 retryLimit，每轮读取当前阶段；无配置或无许可时保留阶段并显示原因。启动只恢复明确的发布／状态事实，queued／running 变 interrupted，不自动重新推理或补跑定时。

将 Planner 纳入 main.ts 的服务初始化、busy 回调及 cancel／close；被 round 内部调用时不能因 round 自身 busy 拒绝，外部并发操作仍受保护。Capture 的既有安全新投递不能因新增规划服务被无关禁止。原 MVP publication 及 Source／Draft 生命周期操作保留现有回执和权限，planned 的管理操作补充未批准候选取消，不触碰未来批准执行恢复。

## 5. 验证方法

Core 新测试放 `tests/planning/`、`tests/changesets/`；复用 `tests/helpers/runtime.ts`、human-review／recall helpers 与 codex child stub。既有 `tests/execution`、`tests/review`、`tests/processing` 和 API contracts 只补受影响行为，不复制整套断言。测试 fixtures、fault helpers 保持在 tests/，真实输出和诊断留 `.local/p3/a/`。

focused 验证先构建 contracts／Core，再运行相关 Vitest 文件；改 Desktop 时额外执行 typecheck 和 build。A-G 做一次所需完整回归，真实 Codex 单独验收，正常测试不使用模型账户。

```powershell
npm run build --workspace @engramweave/contracts
npm run build --workspace @engramweave/core
npx vitest run tests/changesets tests/planning tests/execution/codex.test.ts
npx vitest run tests/review tests/processing tests/http/human-review.test.ts
npm run typecheck
npm run build
npm test
```

检查真正的越权拒绝、候选字节保存、崩溃恢复与无正式写入，不只检查工具名称或模型 JSON。备份说明需包含 `70_ChangeSets` 未完成候选和 Core 接受／发布回执；A 未实现的 Executor／Git 不写成现有能力。
