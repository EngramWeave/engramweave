# Agent Planner 与候选工作区

Integration Planner 使用所选 Reviewed Draft、该稿的 Integration Intent、冻结的 Source，以及可选 Relation 输出和模板，生成一份统一 ChangeSet。新建、修改、拆分、融合和废弃是方案结果，不是独立模式。普通 Draft 编辑不会自动撤销方案或重新运行模型。

## 配置与执行

在 Desktop → Settings 配置 **Integration Planner · Agent**，启用 Planner 并指定本机 Codex 可执行文件，可独立设置模型、推理强度、超时和 Relation 模板。Planner 模板保存在 `90_System/Prompts/Planner.md`；首次明确读取模板时创建默认文件，已有模板不会覆盖。启动 Core 只加载配置及恢复记录，不创建模板、扫描文件或运行模型。已有 P2 API 配置继续保留，Planner 当前只有 Agent 路径。

Desktop 显示 Planner 模板的 Vault 相对路径，正文在 Obsidian 中编辑，每轮读取最新文件。**Save Planner settings** 只保存模型与执行配置，不写回模板。**Processing schedule · 内容处理调度** 是独立设置，统一安排符合资格的 pending／reviewed 轮次；尚不调度 Git 提交或维护任务。

在 Obsidian 对所需 Draft 点击 **Review Complete**，然后 **Generate ChangeSet**；Desktop 可对 reviewed Source 点击 **Run Integration Planner**。手动或定时 pending 轮次先登记，再把 pending 分给 Compiler／Analyzer，把 reviewed 分给 Planner；planned、archived、discarded 不重新规划。没有分析结果也可规划，过期或不可读 Relation 只作参考，不阻断规划。

本轮固定所选 Draft 的当前正文、专属 Intent、Source、模板和模型。Source 发布阶段使用版本检查，后来的 Draft 编辑不使本轮失效。只有完整候选发布 ready 后才将 Source 写为 planned。临时推理失败使用本轮有限重试；失败保存到 Job，保留 Source 阶段，下一轮重新检查资格与当前输入。

## 工具与影响范围

Codex 使用 read-only 隔离运行，每项任务具有私有 MCP capability。Compiler 只消费投递材料；Analyzer 保留只读工具；Planner 只操作本轮工作区。关闭或取消任务会撤销其 capability，不提供正式写入、批准、执行、shell 或物理删除工具。

| 工具 | 合同 |
| --- | --- |
| `read_input` | 本轮冻结的 Source、所选 Draft 和 Intent |
| `recall` | Knowledge、Ideas、Research 的有界召回，携带覆盖情况和实际文件版本 |
| `read_note` | 正式 Markdown 全文及 Properties；替换或废弃现有笔记前必须实际读取 |
| `list_folders` | 分页浏览指定正式目录，不复制整个 Vault |
| `read_candidate` | 本轮已提议文件及当前候选版本 |
| `write_file` / `edit_file` | 创建完整候选／按版本替换唯一片段，不改正式文件 |
| `propose_structure` | 目录或 discarded 提议，不创建正式目录、不删除文件 |
| `validate_changeset` | 只读检查当前方案的完整性并返回条目及诊断，不发布或批准 |

工具预算为每轮 64 次调用、累计 16 MiB 返回内容；候选正文受 Markdown 单文件上限保护。证据必须来自本轮实际提供的文件版本和行范围；重复读取发现新版本会报冲突。调用记录保存路径、版本、行范围和内容摘要，不保存 capability token。

正式目标限 `10_Ideas`、`40_Knowledge`、`50_Research`、`60_Projects`。Core 校验 UUID、规范相对路径、候选映射、重复／大小写冲突、非空正文和可登记的 `sources` Properties。写入新目录必须包含相应目录提议；新的一级领域标记 `requires_domain_approval`，等待完整审查与批准，不提前创建。结构提议只是候选影响，尚未执行。

## 存储与编辑

工作区为 `70_ChangeSets/<id>/manifest.json` 和 `candidates/<formal-relative-path>.md`，只保留涉及文件，没有 Base 目录或自动三方合并。manifest 的 preparing／ready 是工作区进度，与 Source 阶段和 Job 状态分开。候选不进入 Source Registry、普通全文／语义召回或 Draft 枚举。

Obsidian 打开 **Open ChangeSet candidates**，或从 Draft／Desktop 结果打开方案。中央保留只读左栏与可编辑 Candidate，文件选择、操作、状态和整合说明在右侧 EngramWeave 栏。**Save Candidate／Ctrl+S** 只保存候选；**Refresh Current** 先刷新本地原生编辑器，再读取 Current，保留右栏正文与撤销历史。

**Open original Draft** 在新标签打开该方案关联的原 Draft，供用户在原生编辑器中自行对照；打开的是文件当前内容。原文件已移动或删除时提示，不创建替代文件。中央继续对照 Current 与 Candidate，不提供额外审查快照、自动保真评估或改动比例；同稿贡献多文件时由用户结合各候选检查。

**Preview Candidate** 先安全保存，成功后在新标签用 Obsidian 原生阅读视图打开对应候选 Markdown，并保留侧栏。保存失败、冲突或保存期间继续输入时保留编辑，不打开过期预览。预览和候选编辑均不应用正式内容；原 Draft 文件保留。

保存按 Candidate 版本校验，断线或冲突保留编辑并显示错误。切换／关闭视图把未保存编辑暂存到 Vault 外 OS 应用数据 `EngramWeave/obsidian-candidates/`，重开恢复；此记录不包含凭据，不替代 Vault 备份。**Reload Candidate** 明确确认丢弃未保存编辑后读取磁盘版本，读取失败不先清除编辑。

**Cancel ChangeSet** 明确清理未批准方案及本地候选编辑，在所选 Draft 有效时返回 reviewed，保留 Draft／Intent。**Cancel Review Complete** 则撤销选择，清理方案并返回 compiled。正常启动发现已完成方案缺失时返回 reviewed；不会重跑模型。如果候选 ready 与 Source 阶段之间的发布中断，按回执恢复确定性发布；冲突时保留材料，可重试原请求或明确取消方案。

Discard Source 撤销其审阅选择并清理未批准方案。**Restore Source** 只恢复该 Source 为 `active/pending`，不恢复旧 Draft、正式内容、审阅选择或 ChangeSet；各 Draft 的 Intent 仍保留。下一轮手动或已启用的定时处理可重新编译，恢复本身不启动模型。见 [Source 操作](sources.md)。

## 人工取舍与执行

右侧列出全部正文、目录和 discarded 提案、AI 理由及证据、Source 归档与关联 Draft 清理清单。非正文条目只读查看；AI 理由在人工编辑后仅供参考。逐项选择纳入或拒绝，也可全部纳入／拒绝，取舍按 manifest 版本单独持久保存。新领域目录另需明确授权。没有正文写入的有效集合不能归档 Source；全部拒绝请取消方案。

Core 只校验纳入的内容，拒绝的坏正文不阻断其他内容。纳入文件缺少必要的目录提案、或明确链接到被拒绝且尚不存在的新提议文件时阻止批准；既有未解析链接不会因此被统一禁止。四个固定正式根目录属于 Vault 基础目录，可按实际需要创建，不算新领域。

点击 **审查批准清单** 会先保存本方案全部脏候选，包括切换文件后留在缓存中的编辑。保存期间新增编辑会被保留并要求重新检查。确认 **Approve & Apply** 后立即执行，不调用模型，也不再加一次审批。固定的是此次人工批准的候选字节和最后显示的 Current 版本；规划时读到的旧版本仅作证据。例如规划读取 v1，用户把本地 v2 的新增内容合入候选 v3，可以批准 v2→v3；目标之后变为 v4 则报冲突，不能静默覆盖。

Executor 在正式写入前持久保存接受回执，整体预检后使用 Windows 文件身份、版本和父目录保护逐项应用。新建先写入接受回执持有的临时文件再原子发布，中断暂存按其精确身份恢复，不暴露半份正式正文。新建不覆盖同名文件，更新检查批准的 Current 版本，目录及 discarded 标记也属于同一批准集合。多文件没有跨文件事务承诺；已应用项记录进度，恢复不会重新覆盖其后的人类编辑。未完成时保留方案、批准内容和错误；原请求 ID 可查询／明确重试。已接受操作不能用取消、重规划或 Restore 绕过。无关的新 Capture 仍可保存。

只有正式写入、相关 Draft 标记及 Source 归档都成功后才消费方案：Source 仅改为 archived，正文和 Annotation 保留；相关 Draft 仅标记 discarded，保留正文及 Intent，撤销当前选择。清理 `70_ChangeSets/<id>` 和不再需要的完整执行负载，保留有界结果与错误摘要。必要的恢复事实保存在 Core 应用数据，数据库丢失不会把消费误判为候选损坏。完成请求重放只返回原结果，不重复写入，也不把后来恢复为 pending 的 Source 再次归档。

**打回重新规划** 明确取消未批准方案，再读取当前 Draft、Intent 和知识库启动新一轮 Planner；新方案重新审查和批准。普通 Draft 编辑不触发这些操作。快捷 Publish 保留人工新建体验，共用 Executor 和归档恢复，同时保留其原有的分析尝试前置条件。Vault 自动 Git 提交仍属 D，当前正式版本由用户现有 Git 工具管理。

## 本地接口

| 接口 | 用途 |
| --- | --- |
| `GET/POST /v1/planner/settings` | 独立 Agent 配置 |
| `GET/POST /v1/planner/template` | 模板读取／按版本保存 |
| `POST /v1/plans` | request_id、Source 及可选版本；202 返回 Planner Job |
| `POST /v1/plans/cancel` | 取消运行中 Planner Job |
| `GET /v1/changesets` | 可选 source_path，列出 ready 方案 |
| `GET /v1/changeset?id=...` | manifest 与版本 |
| `GET /v1/changeset/candidate?id=...&item_id=...` | Current、Candidate 及各自版本 |
| `POST /v1/changeset/candidate` | 受保护候选保存 |
| `POST /v1/changeset/cancel` | 人工明确取消工作区 |
| `GET /v1/changeset/review?id=...` | 人工取舍、当前目标版本、Source／关联 Draft 清单 |
| `POST /v1/changeset/review` | 按 manifest 与取舍版本保存决定 |
| `POST /v1/changeset/approve` | 以 request_id 接受固定内容并立即确定性执行 |
| `GET /v1/integration?id=...` | 原批准 ID 的结果；未接受返回 job=null |
| `GET /v1/integration/file?id=...&path=...` | 核实该批准涉及的当前正式文件；供 Desktop 原生打开 |

沿用本机 bearer、Host 和无浏览器 Origin 规则；Desktop 走固定原生白名单，打开方案前核实 ready 状态及 Vault 身份。Job 结果表示一次任务的执行历史，不保证方案后来未被取消。

## 备份、排除与验证

备份 Vault 中未消费的 `70_ChangeSets`，并一起保存 Core `data_dir/planner-jobs/`、`changeset-reviews/`、`integration-executions/`、`draft-publications/`、`planner-settings.json` 和 Human Review 回执。schema 7 的 Planner／Executor Job 投影可由外部回执重建，SQLite 不独占候选、选择或消费事实。未完成写入不能通过删除回执绕过。

批准送达不明的原请求另保存在 Vault 外 `EngramWeave/obsidian-candidates/`，重开可查询与重试，不能自动换 ID。明确拒绝且查明未被接受后，可以回到审查重新确认。备份不能只保留候选或只保留数据库。

建议 Vault `.gitignore` 排除 `/70_ChangeSets/`；Core 不替用户修改已有 Git 配置。Obsidian 的搜索 Excluded files 和 Sync 的排除需另行设置 `70_ChangeSets`；Git 排除不会自动隐藏 Obsidian 搜索或阻止 Sync。

运行 `npm run typecheck`、`npm test` 和原生 Desktop host tests，插件运行 `npm run build`、`npm test`。重点验证候选冲突／链接保护、任务白名单、输入选择、发布中断、数据库投影恢复及 reviewed 轮次分流。原生 Obsidian 另检查中文输入、Ctrl+S、长文滚动、刷新后的撤销、未保存关闭重开和断线；真实 Agent 验证应在隔离 Vault 使用网页与 Zotero 选段，核对实际工具记录、内容范围和正式文件字节。临时证据放 `.local/p3/a/`。


来源保护的元数据检查覆盖 Ideas、Knowledge、Research、Projects，包括尚未登记的本地正式文件；不因此扩大 Projects 的普通登记或语义召回范围。Source 操作可列出这些回链，默认跳过仍被 active 正式内容引用的 Source；明确勾选关联文件仅标记 discarded，确认覆盖删除也不删除正式文件。独立正式文件回收站、受管理 Asset／Derived 清理及 Git 仍属于 D。

按 Source 查询待审方案、取消后回退和重新规划，仅根据该 Source 的有效规划回执读取工作区；无关损坏或无归属工作区留作独立诊断，不阻塞另一份有效 Source。该 Source 自己的 manifest / 输入与回执冲突仍明确拒绝，不跳过有效流程的完整性检查。Desktop 的当前文件页与只读候选预览见 [Desktop](desktop.md)。
