# Sources 浏览与显式操作

Sources 是所有已登记 Source 的浏览入口。Health 表示文件可用性，Processing 表示 processing_status 内容阶段，Lifecycle 表示 active／discarded；三者分别显示彩色标签。Health 的 available 对应现有 API 登记值 ready，不能解读为已完成处理。

## View 与筛选

| View | 选择规则 | 可添加筛选 |
|---|---|---|
| All Sources | 所有登记项，包括问题项和 discarded | Type、Tags、Captured Time |
| Pending | processing_status = pending | Type、Tags、Captured Time |
| Processing | processing_status = compiled／reviewed／planned | Type、Tags、Captured Time、processing_status |
| Archived | processing_status = archived | Type、Tags、Captured Time |
| Issues | Health = missing／invalid／unsupported | Type、Tags、Captured Time、Issue |
| Discarded | lifecycle_status = discarded | Type、Tags、Captured Time |

View 可以重叠；例如 pending 的文件失踪后仍可同时出现在 Pending 和 Issues。文件不可读时阶段与生命周期仅表示最近可读值，悬停标签可查看说明；数据库丢失后不能从已经失踪的文件恢复未知阶段。Job 失败不计入 Issues。

Processing 标签直接显示 pending／compiled／reviewed／planned／archived，不新增 processing 或 failed 文件阶段，也不从 Job 成败推导另一条展示状态。Lifecycle 直接显示 lifecycle_status 的 active／discarded。执行失败及详细任务记录在 Jobs 或执行入口查看；Processing View 仍按 compiled／reviewed／planned 选择。

搜索留在当前 Sources View 中。`+ Filter` 添加维度和类别，以 Chip 展示；维度之间 AND、同维度多个类别 OR。每个 Chip 可移除，Clear all 清除额外筛选而保留当前 View 和搜索。切换 View 保留通用筛选，移除不适用的 processing_status／Issue 条件。

Type 包含 Web、Manual、Zotero、Desktop 和 Registry 中已有类型。Tags 来自整个 Source Registry，可输入查找或直接使用完整标签。Captured Time 提供 Today／Last 7 days／Last 30 days／Custom range，按本机日历日包含起止日；无采集时间的文件不匹配时间条件。排序支持标题升降序及采集时间新旧顺序，未知采集时间排最后。

左侧 Sources 数字是 Pending View 数量。未知 captured_at 在表格显示 `—`，不重复显示 CAPTURED_AT_UNKNOWN；其他实际问题仍可查看。Inspector 默认打开 Annotation，inline Asset 不再重复展示“Inline available”。

## 多选操作

可选择当前页或跨页明确选择最多 100 份 Source；界面不会默认操作整个查询结果。Compile selected、Discard selected、Restore selected 都由 Core 按单项合同依次处理。每项执行前重读文件和 revision；变动或无资格的项跳过，失败不阻断其余项，结果逐项列出。

Compile 支持 available、active 的 pending／compiled；每次成功新增 Draft，已有 Draft 与用户编辑保留。reviewed／planned／archived 不能通过此入口重编译。修改 Annotation 或模板不自动执行模型。

Discard 先列出确切 Source 和相关 Draft 文件，确认后标记 discarded，不物理删除。未归档 Source 的相关 Draft 同步 discarded；当前可读取的正式 Knowledge provenance 引用默认保留，用户可在确认列表中明确选择。无法安全读取的 Source 不猜测写入；目标发生并发变动会报告。跨文件操作逐项落盘，不声称事务回滚，部分成功文件仍保持可见。

Restore 默认只恢复所选 Source 为 active，原阶段保留；不自动恢复旧 Draft 或正式知识。物理删除不属于这些操作。

Core 保存最近一次批量请求与结果；关闭 Desktop 不会取消独立 Core 中已接受的批次。Core 重启将未完成项标记为中断，不补跑；检查保留现场后明确新建批次。每份 Source 的 Compiler 请求 ID 仍保护重放，避免响应丢失后重复模型调用。

## HTTP 合同

`GET /v1/sources` 增加 view／q／types／tags／stages／issues／time_ranges／sort；多类别使用 JSON 字符串数组，时间类别为带 from／to 的 JSON 字符串数组。返回全局 views 计数、types／tags facets 及过滤后的分页结果。没有 view 的旧请求继续默认查询 ready；Desktop 明确使用 view=all 来浏览所有项。

`POST /v1/source-batches` 接受 UUID id、compile／discard／restore action，以及明确 path／revision／request_id；discard 的 related 列表来自当前 preview，包含必需 Draft 和用户选定正式引用。`GET /v1/source-discard-preview?path=...` 返回当前文件目标与关联项；`GET /v1/source-batches?id=...` 返回最近保留的逐项结果，status 同时提供 source_batch 摘要。所有接口沿用 Core 认证、schema、路径及原生文件保护。
